import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { readTelemetry } from './usage-engine.mjs';
import { createIntegration, appResult, requestThread, needsThreadResult, pluginDataDir } from './integration-adapter.mjs';
import { createPanelSnapshot } from './panel-snapshot.mjs';
import { readQuotaSnapshot, estimateWeeklyCapacity } from './quota-service.mjs';
import { createUpdateService } from './update-service.mjs';
import { createReleaseInstaller } from './release-installer.mjs';

const APP_URI = 'ui://tokenlens/live-v3-0.5.10.html';
const icon = readFileSync(new URL('./assets/icon.svg', import.meta.url), 'utf8');
const panelSnapshot = createPanelSnapshot({ dataDir: pluginDataDir(), version: 3 });
const updateConfig = JSON.parse(readFileSync(new URL('./data/release.json', import.meta.url), 'utf8'));
const updates = createUpdateService({ ...updateConfig, currentVersion:'0.5.10', dataDir:pluginDataDir() });
const installer = createReleaseInstaller({...updateConfig,currentVersion:'0.5.10',updates});
const integration = createIntegration({readAccount:request=>readTelemetry('account',request),readThread:thread_id=>readTelemetry('thread',{thread_id}),
  readQuota:()=>readQuotaSnapshot(),estimateCapacity:estimateWeeklyCapacity,quotaIdentity:panelSnapshot.token});
const id = z.string().min(1).max(200);
const date = z.union([z.string().min(1).max(64),z.number().finite()]);
const threadSchema = {thread_id:id.optional()};
const accountSchema = {account_id:id.optional(),thread_id:id.optional(),accountId:id.optional(),threadId:id.optional(),startAt:date.optional(),endAt:date.optional(),
  search:z.string().max(500).optional(),model:z.string().max(200).optional(),project:z.string().max(2000).optional(),
  sort:z.string().max(50).optional(),archived:z.boolean().optional(),includeDescendants:z.boolean().optional(),
  limit:z.number().int().min(1).max(1000).optional(),offset:z.number().int().min(0).optional()};
async function scopedResult(args, extra) {
  const selected = requestThread(args,extra);
  if (!selected) return needsThreadResult();
  const usage = await integration.readThread(selected.id);
  return {content:[{type:'text',text:'Gauge 已连接本地用量。金额以 API 等价费用显示。'}],
    structuredContent:{live:true,threadId:usage.threadId,title:usage.title},_meta:{usage,contextSource:selected.source}};
}
function openPanel(args, extra) {
  const selected = requestThread(args,extra);
  return {content:[{type:'text',text:'Gauge 已打开。用量记录出现后自动更新，账号明细可直接查看。'}],
    structuredContent:{panelReady:true,threadId:selected?.id ?? null},
    _meta:{ui:{resourceUri:APP_URI},threadContext:{threadId:selected?.id ?? null,source:selected?.source ?? null},panelSnapshot:panelSnapshot.read()}};
}
function createMcpServer() {
  const server = new McpServer({name:'tokenlens',title:'Gauge',version:'0.5.10',icons:[{src:`data:image/svg+xml,${encodeURIComponent(icon)}`,mimeType:'image/svg+xml',sizes:['any']}]});
  registerAppResource(server,'tokenlens-ui',APP_URI,{},async()=>({contents:[{uri:APP_URI,mimeType:RESOURCE_MIME_TYPE,
    text:readFileSync(new URL('./assets/tokenlens.html',import.meta.url),'utf8').replace('<script>',()=>'<script>window.tokenlensSnapshot='+JSON.stringify(panelSnapshot.read()).replaceAll('<','\\u003c')+';'),
    _meta:{ui:{prefersBorder:false,csp:{connectDomains:[],resourceDomains:[]}},'openai/widgetDescription':'Gauge 本地轮次与账号统计面板。预算默认关闭；无需复述界面。'}}]}));
  const readOnly = {readOnlyHint:true,destructiveHint:false,openWorldHint:false,idempotentHint:true};
  const appOnly = {ui:{visibility:['app']}};
  const tool = (name,title,description,inputSchema,callback,options={}) => registerAppTool(server,name,{title,description,inputSchema,
    annotations:options.write ? {readOnlyHint:false,destructiveHint:false,openWorldHint:false,idempotentHint:false} : readOnly,
    _meta:options.meta || appOnly},callback);
  tool('open_tokenlens','Gauge','Open Gauge, including before usage records exist. Current conversation comes from request metadata; explicit thread_id selects a conversation. API-equivalent costs use recorded request tiers.',threadSchema,
    openPanel,{meta:{ui:{resourceUri:APP_URI,visibility:['model','app']},'openai/ui':{entrypoints:[{type:'global'},{type:'thread'}]},'openai/toolInvocation/invoking':'打开 Gauge','openai/toolInvocation/invoked':'Gauge 已打开'}});
  tool('get_usage','刷新真实用量','Read current or explicitly selected thread and verified descendants; no model invocation.',threadSchema,scopedResult);
  tool('get_account_usage','账号明细','Read discoverable local conversations and deduplicated account analytics; current thread is not required.',accountSchema,
    async args=>{
      const token=panelSnapshot.token(),startedAt=Date.now(),value=await integration.account(args);
      if(token!==panelSnapshot.token())throw new Error('账号已切换，请刷新。');
      if (!Object.keys(args).some(key=>!['limit','offset'].includes(key)) && (!args.limit || args.limit>=500)) await panelSnapshot.save('accountUsage',value,token,startedAt,args.offset||0);
      return appResult('accountUsage',value);
    });
  tool('get_account_quota','官方额度与周容量','Read official account quota via a local adapter and estimate from same-account current official weekly cycle only.',{accountId:id.optional(),limitId:id.optional()},
    async args=>{
      const token=panelSnapshot.token(),startedAt=Date.now(),value=await integration.quota(args);
      if(token!==panelSnapshot.token())throw new Error('账号已切换，请刷新。');
      if (!Object.keys(args).length) await panelSnapshot.save('quota',value,token,startedAt);
      return appResult('quota',value,'已读取额度状态；周容量是 API 等价估算，不是官方美元余额。');
    });
  const budgetScope = {...threadSchema,accountId:id.optional(),account_id:id.optional()};
  tool('get_conversation_budget','读取对话预算','Read optional soft budget for an explicit conversation identity. Disabled by default; reading does not send context.',budgetScope,(args,extra)=>integration.getBudget(args,extra));
  tool('set_conversation_budget','设置或关闭对话预算','Save a user-selected conversation budget. enabled:true explicitly enables. enabled:false disables future reminders. Percentage fixes amount using current weekly estimate. Saving is not model delivery.',
    {...budgetScope,enabled:z.boolean(),mode:z.enum(['amount','percentage']).optional(),amountUsd:z.number().finite().positive().optional(),amount_usd:z.number().finite().positive().optional(),percent:z.number().finite().positive().max(100).optional(),resetEpoch:z.boolean().optional()},
    (args,extra)=>integration.setBudget(args,extra),{write:true});
  tool('get_budget_context','读取已开启的预算上下文','Read the saved optional budget summary for the explicitly identified conversation. Disabled budgets return no context. Does not wake another turn, stop requests, or change model settings.',budgetScope,
    (args,extra)=>integration.budgetContext(args,extra),{meta:{ui:{visibility:['model','app']}}});
  tool('get_budget_overview','多对话预算总览','Read allocated plans and recorded spending; plans are not deducted from official remaining quota.',{accountId:id.optional(),account_id:id.optional()},
    async args=>appResult('budgetOverview',await integration.overview(args)));
  tool('export_account_usage','导出账号统计','Export local counts and cost analytics without chat bodies or credentials.',{...accountSchema,format:z.enum(['json','csv']).default('json'),filters:z.object({search:z.string().optional(),model:z.string().optional(),project:z.string().optional(),status:z.string().optional(),sort:z.string().optional()}).optional()},
    async args=>{const filters=args.filters || {}; const query={...args,...filters,export:args.format};delete query.filters;
      if(query.status==='archived')query.archived=true;if(query.status==='agents')query.subagent=true;if(query.status==='partial')query.unpricedOnly=true;if(query.status==='unknown')query.unknownAccountOnly=true;delete query.status;
      const value=await integration.account(query);const out=value.export;return appResult('export',{status:value.coverage.status,format:out.format,mimeType:out.mediaType,filename:'gauge-usage.'+out.format,content:typeof out.data==='string'?out.data:JSON.stringify(out.data,null,2),coverage:value.coverage});});
  registerAppTool(server,'get_update_status',{title:'检查 Gauge 新版',description:'Read public release metadata and installation progress. force:true bypasses the six-hour cache. No account or conversation data is sent.',inputSchema:{force:z.boolean().optional()},
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:true,idempotentHint:true},_meta:appOnly},
    async args=>({content:[],structuredContent:{updateStatus:{...await updates.check(args),installation:installer.status()}}}));
  registerAppTool(server,'install_update',{title:'安装 Gauge 新版',description:'Install the explicitly selected official Gauge release after a user clicks Update. Verify the archive checksum; preserve local usage and budgets. Never close the client.',inputSchema:{version:z.string().regex(/^\d{1,6}\.\d{1,6}\.\d{1,6}$/)},
    annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:true,idempotentHint:true},_meta:appOnly},
    args=>({content:[],structuredContent:{installation:installer.start(args.version)}}));
  return server;
}

if (process.argv.includes('--http')) {
  const port = Number(process.env.PORT || 49429);
  createServer(async (req,res)=>{
    if (req.url === '/health') {res.writeHead(200,{'Content-Type':'application/json'});res.end('{"ok":true,"live":true}');return;}
    if (req.url !== '/mcp') {res.writeHead(404);res.end('Not found');return;}
    if (req.method !== 'POST') {res.writeHead(405,{Allow:'POST'});res.end();return;}
    const server=createMcpServer(), transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    res.on('close',()=>{void transport.close();void server.close();});
    await server.connect(transport);await transport.handleRequest(req,res);
  }).listen(port,'127.0.0.1',()=>console.error(`Gauge MCP: http://127.0.0.1:${port}/mcp`));
} else {
  await createMcpServer().connect(new StdioServerTransport());
}
