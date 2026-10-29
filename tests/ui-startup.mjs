// Real bundled UI and MCP bridge, with isolated Codex records and a test host.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const home=mkdtempSync(join(tmpdir(),'tokenlens-startup-')),folder=join(home,'sessions/2026/10/01');mkdirSync(folder,{recursive:true});
const data=join(home,'private');
const version=JSON.parse(readFileSync('package.json')).version;
mkdirSync(data,{recursive:true});
const nextVersion=version.split('.').map((n,i)=>i===2?Number(n)+1:n).join('.');
writeFileSync(join(data,'release-status.json'),JSON.stringify({repository:'DHCFE/gauge-codex-plugin',checkedAt:Date.now(),manifest:{product:'Gauge',platform:'darwin-arm64',version:nextVersion,asset:'Gauge-mac-arm64.zip',sha256:'a'.repeat(64)}}));
function record(id,input=1000,model='gpt-6.1-sol'){
  const usage={input_tokens:input,cached_input_tokens:0,cache_write_input_tokens:0,output_tokens:10,reasoning_output_tokens:0,total_tokens:input+10};
  const rows=[{type:'session_meta',payload:{id,model_provider:'openai'}},{type:'event_msg',payload:{type:'task_started',turn_id:'turn'}},{type:'turn_context',payload:{turn_id:'turn',model}},{type:'token_usage_record',payload:{thread_id:id,turn_id:'turn',response_id:id+'-response',usage,turn_token_usage:usage,thread_token_usage:usage}}];
  writeFileSync(join(folder,'rollout-test-'+id+'.jsonl'),rows.map(row=>JSON.stringify({timestamp:new Date().toISOString(),...row})).join('\n')+'\n');
}
record('older-chat');
const client=new Client({name:'tokenlens-startup-test',version:'1'});let browser,server;
const calls=[];
try {
  await client.connect(new StdioClientTransport({command:process.execPath,args:['./server.mjs'],cwd:resolve('plugin'),env:{...process.env,CODEX_HOME:home,TOKENLENS_DATA:data,TOKENLENS_PYTHON:'python3'}}));
  const tools=await client.listTools(),uri=tools.tools.find(tool=>tool.name==='open_tokenlens')._meta.ui.resourceUri;
  const html=(await client.readResource({uri})).contents[0].text;
  const host=`<!doctype html><body style="margin:0"><iframe id="widget" src="/widget" style="border:0;width:100%;height:1100px"></iframe><script>
    window.hostThread=null;window.messages=[];window.hostErrors=[];
    const frame=document.querySelector('iframe');
    const notify=(method,params)=>frame.contentWindow.postMessage({jsonrpc:'2.0',method,params},location.origin);
    async function tool(request){const response=await fetch('/tool',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...request,hostThread:window.hostThread})});return response.json();}
    window.openPanel=async threadId=>{window.hostThread=threadId;notify('ui/notifications/tool-input',{arguments:{}});const result=await tool({name:'open_tokenlens',arguments:{}});notify('ui/notifications/tool-result',result);};
    addEventListener('message',async event=>{
      if(event.source!==frame.contentWindow)return;const request=event.data;if(request?.jsonrpc!=='2.0')return;
      if(request.method==='ui/notifications/initialized'){await window.openPanel(null);return;}
      if(request.id===undefined)return;
      try{let result={};if(request.method==='ui/initialize')result={protocolVersion:request.params.protocolVersion,hostInfo:{name:'isolated-test-host',version:'1'},hostCapabilities:{serverTools:{},message:{text:{}}},hostContext:{theme:'light',displayMode:'inline',locale:'zh-CN',timeZone:'Asia/Shanghai'}};
        else if(request.method==='tools/call'){const delay=window.delayNextUsage&&request.params.name==='get_usage';if(delay)window.delayNextUsage=false;result=await tool(request.params);if(delay)await new Promise(resolve=>setTimeout(resolve,500));}
        else if(request.method==='ui/message')window.messages.push(request.params);
        frame.contentWindow.postMessage({jsonrpc:'2.0',id:request.id,result},location.origin);
      }catch(error){window.hostErrors.push(String(error));frame.contentWindow.postMessage({jsonrpc:'2.0',id:request.id,error:{code:-32603,message:'Test host failed'}},location.origin);}
    });
  </script>`;
  server=createServer(async(req,res)=>{
    if(req.url==='/widget'){res.writeHead(200,{'content-type':'text/html'});res.end(html);return;}
    if(req.url==='/tool'&&req.method==='POST'){
      let body='';for await(const part of req)body+=part;
      const {hostThread,...request}=JSON.parse(body);calls.push(request.name);
      const result=request.name==='install_update'?{structuredContent:{installation:{status:'installed',version:nextVersion,restartRequired:true}}}:await client.callTool({...request,...(hostThread?{_meta:{'openai/threadId':hostThread}}:{})});
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));return;
    }
    res.writeHead(200,{'content-type':'text/html'});res.end(host);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const {chromium}=await import(pathToFileURL(process.env.TOKENLENS_PLAYWRIGHT_MODULE).href);
  browser=await chromium.launch({headless:true,args:['--disable-gpu'],executablePath:process.env.TOKENLENS_TEST_BROWSER});
  const page=await browser.newPage({viewport:{width:1000,height:900}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:'+server.address().port);
  const frame=page.frameLocator('#widget');
  await frame.locator('#connection').filter({hasText:'等待记录'}).waitFor();
  assert.equal(await frame.locator('#amount').textContent(),'—');
  assert.equal(await frame.locator('#explain').isDisabled(),true);
  await frame.locator('#accountTab').click();
  await frame.locator('#accountRows tr').first().waitFor();
  assert.equal(await frame.locator('#accountRows tr').count(),1,'global new-chat entry can read existing account data');
  await frame.locator('#conversationTab').click();
  await page.evaluate(()=>window.openPanel('fresh-chat'));
  await frame.locator('#tokens').filter({hasText:'等待用量记录'}).waitFor();
  assert.equal(await frame.locator('#turnList .turn').count(),0);
  await page.evaluate(()=>window.openPanel('older-chat'));
  await frame.locator('#tokens').filter({hasText:'1,010 tokens'}).waitFor({timeout:10000});
  await page.evaluate(()=>window.delayNextUsage=true);await frame.locator('#refresh').click();
  await page.evaluate(()=>window.openPanel('fresh-chat'));
  await frame.locator('#tokens').filter({hasText:'等待用量记录'}).waitFor();
  await page.waitForTimeout(700);
  assert.equal(await frame.locator('#turnList .turn').count(),0,'late previous-chat response cannot repopulate a new chat');
  assert.equal(await frame.locator('#amount').textContent(),'—');
  record('fresh-chat',200);
  await frame.locator('#tokens').filter({hasText:'210 tokens'}).waitFor({timeout:10000});
  assert.equal(await frame.locator('#turnList .turn').count(),1,'first persisted request appears on normal polling');
  await page.evaluate(()=>window.openPanel(null));
  await frame.locator('#tokens').filter({hasText:'等待用量记录'}).waitFor();
  assert.equal(await frame.locator('#turnList .turn').count(),0);
  await page.evaluate(()=>window.hostThread='fresh-chat');
  await frame.locator('#tokens').filter({hasText:'210 tokens'}).waitFor({timeout:10000});
  assert.equal(await frame.locator('#turnList .turn').count(),1,'a thread identity supplied after the first message binds without reopening');
  assert.deepEqual(await page.evaluate(()=>window.messages),[]);
  assert.deepEqual(await page.evaluate(()=>window.hostErrors),[]);
  assert.deepEqual(errors,[]);
  assert.equal(await frame.locator('#releaseVersion').textContent(),version);
  await frame.locator('#updateAvailable').waitFor();
  assert.equal(calls.filter(name=>name==='get_update_status').length,1,'version checks do not repeat with usage polling');
  await page.setViewportSize({width:390,height:900});
  assert.equal(await frame.locator('header').evaluate(header=>header.scrollWidth<=header.clientWidth),true,'version and update button fit a narrow panel');
  await frame.locator('#updateAvailable').click();
  await frame.locator('#updateAvailable').filter({hasText:'已安装'}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.messages),[],'updating installs directly without asking an agent');
  assert.equal(calls.filter(name=>name==='install_update').length,1);
  assert.equal(await frame.locator('#updateAvailable').isDisabled(),true);
  const childUsage={input_tokens:1000,cached_input_tokens:0,cache_write_input_tokens:0,output_tokens:10,reasoning_output_tokens:0,total_tokens:1010};
  const childPath=join(folder,'rollout-test-child.jsonl');
  const childRows=[{type:'session_meta',payload:{id:'child',model_provider:'openai',source:{subagent:{thread_spawn:{parent_thread_id:'older-chat'}}}}},
    {type:'turn_context',payload:{turn_id:'child-t',root_turn_id:'turn',model:'gpt-6.1-sol'}},
    {type:'response_item',payload:{content:'x'.repeat(4*1024*1024+100)}},
    {type:'token_usage_record',payload:{thread_id:'child',turn_id:'child-t',root_turn_id:'turn',response_id:'child-response',usage:childUsage,turn_token_usage:childUsage,thread_token_usage:childUsage}}];
  writeFileSync(childPath,childRows.map(JSON.stringify).join('\n')+'\n');
  await page.evaluate(()=>window.openPanel('older-chat'));
  await frame.locator('#tokens').filter({hasText:'2,020 tokens'}).waitFor({timeout:10000});
  assert.match(await frame.locator('#agentStatus').textContent(),/含 1 个子代理/);
  assert.equal(await frame.locator('#warningDetails').isHidden(),true);
  record('unknown-chat',1000,'gpt-unpriced');
  await page.evaluate(()=>window.openPanel('unknown-chat'));
  await frame.locator('#amount').filter({hasText:'未计价'}).waitFor();
  assert.equal(await frame.locator('#breakdown .money').first().textContent(),'未计价');
  assert.match(await frame.locator('#warnings').textContent(),/缺少模型价格：gpt-unpriced/);
  record('terra-chat',1000,'gpt-6.1-terra');
  await page.evaluate(()=>window.openPanel('terra-chat'));
  await frame.locator('#model').filter({hasText:'gpt-6.1-terra'}).waitFor();
  assert.equal(await frame.locator('#amount').textContent(),'$0.0010');
  assert.ok(!calls.includes('set_conversation_budget')&&!calls.includes('get_budget_context'));
  assert.equal(existsSync(join(data,'budgets-v1.json')),false);
  console.log('PASS: real bundled UI startup, account data, polling and chat isolation; oversized child record contributes to displayed turn; update notice fits 390px and installs directly only after click; budgets remain untouched');
} finally {
  if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));
  await client.close();rmSync(home,{recursive:true,force:true});
}
