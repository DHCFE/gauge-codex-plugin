// Glue only: collectors retain their own provenance and reliability semantics.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveThread } from './thread-context.mjs';
import { selectWeeklyWindow, ledgerRequestForQuota, accountUsageFromLedger } from './quota-service.mjs';
import { createBudgetService } from './budget-service.mjs';

export function pluginDataDir(env = process.env) {
  return env.TOKENLENS_DATA || env.PLUGIN_DATA || env.CLAUDE_PLUGIN_DATA || join(env.CODEX_HOME || join(homedir(), '.codex'), 'plugins/data/tokenlens-local/tokenlens-prototype');
}
export function requestThread(args, extra) {
  const thread = resolveThread(args.thread_id ?? args.threadId, extra?._meta);
  if (thread && !/^[A-Za-z0-9_.:-]{1,200}$/.test(thread.id)) throw new Error('对话标识格式无效。');
  return thread;
}
export const appResult = (key, value, text = '已读取本地统计。') => ({
  content: [{type:'text', text}], structuredContent: {[key]:value}, _meta: {[key]:value}
});
export const needsThreadResult = () => ({
  content: [{type:'text',text:'客户端未提供当前对话标识，请明确提供 thread_id。'}],
  structuredContent: {live:false,needsThread:true}, _meta: {needsThread:true}
});
const normalizeRequest = args => {
  const value = {...args};
  for (const [snake, camel] of [['account_id','accountId'],['thread_id','threadId'],['start_at','startAt'],['end_at','endAt'],['limit_id','limitId'],['amount_usd','amountUsd']]) {
    if (value[snake] !== undefined) { value[camel] = value[snake]; delete value[snake]; }
  }
  return value;
};

export function createIntegration({ readAccount, readThread, readQuota, estimateCapacity, normalizeCycleUsage = accountUsageFromLedger, dataDir = pluginDataDir(), now = () => new Date(), quotaIdentity = () => null }) {
  let quotaPromise, quotaExpires = 0, quotaIdentityKey;
  async function quotaSnapshot() {
    const identity = quotaIdentity();
    if (!quotaPromise || identity !== quotaIdentityKey || Date.now() >= quotaExpires) {
      quotaIdentityKey = identity;
      quotaExpires = Date.now() + 60_000;
      quotaPromise = Promise.resolve().then(() => readQuota());
    }
    return quotaPromise;
  }
  async function account(args = {}) {
    const request = normalizeRequest(args);
    const sortMap = {recent:'lastActivity',cost:'amount',title:'threadId'};
    if (request.sort) request.sort = sortMap[request.sort] || request.sort;
    if (request.limitId) { request.billingPoolId = request.limitId; delete request.limitId; }
    if (request.poolId) { request.billingPoolId = request.poolId; delete request.poolId; }
    if (request.export) { request.exportFormat = request.export; delete request.export; }
    request.timezone ||= 'Asia/Shanghai';
    const raw = await readAccount(request);
    const total = raw.total || {};
    const cost = row => ({amountUsd:row.amount == null ? (row.pricedRequests ?? row.requestCount-row.unpricedRequests)>0 ? Number(row.observedUsd ?? row.knownUsd) : null : Number(row.amount),knownUsd:Number(row.knownUsd),costComplete:row.costComplete === true,
      tokens:row.requestCount===0 && row.costComplete!==true ? {input:null,cacheRead:null,cacheWrite:null,output:null,reasoning:null,total:null} : {input:row.input,cacheRead:row.cacheRead,cacheWrite:row.cacheWrite,output:row.output,reasoning:row.reasoning,total:row.totalTokens},knownTokens:row.knownTokens,costParts:row.costParts});
    const group = rows => (rows || []).map(row=>({...row,...cost(row),name:row.id || '未知',day:row.id}));
    const categories = [['input','未缓存输入'],['cached_input','缓存读取'],['cache_write','缓存写入'],['output','输出（含推理）']].map(([id,name])=>({id,name,amountUsd:total.requestCount > total.unpricedRequests ? Number(total.costParts?.[id] || 0) : null,costComplete:total.costComplete === true}));
    const conversations = (raw.threads || []).map(row=>({...row,...cost(row.total),updatedAt:row.lastActivity,
      rootThreadId:row.conversationId,relationship:row.parentThreadId ? 'subagent' : row.forkedFromId ? 'fork' : 'main'}));
    return {...raw,...cost(total),status:raw.coverage?.status,range:raw.period,warnings:raw.coverage?.issues || [],conversations,summary:{...total,...cost(total)},
      byModel:group(raw.byModel),byProject:group(raw.byProject),byDay:group(raw.byDay),byAgent:group(raw.byAgent),
      breakdown:{models:group(raw.byModel),projects:group(raw.byProject),daily:group(raw.byDay),agents:group(raw.byAgent),tokens:categories},
      nextOffset: (request.offset || 0)+conversations.length < raw.threadCount ? (request.offset || 0)+conversations.length : null};
  }
  // Budget namespaces follow verified roots; historical account attribution remains in the ledger.
  async function budgetScope(args, extra) {
    const selected = requestThread(args, extra);
    if (!selected) return null;
    const request = normalizeRequest(args);
    const inventory = await account({threadId:selected.id});
    const row = inventory.conversations?.find(row => (row.threadId || row.id) === selected.id);
    if (!row) throw new Error('没有找到所选对话的本地身份记录。');
    if (row.issues?.some(issue=>/conflicting-session|lineage-cycle/.test(issue))) throw new Error('对话身份或归属存在冲突，无法绑定预算。');
    let owner = row;
    if (row.parentThreadId && row.rootThreadId && row.rootThreadId !== row.threadId) {
      const rootInventory = await account({threadId:row.rootThreadId});
      const root = rootInventory.conversations.find(item=>item.threadId === row.rootThreadId);
      if (root && !root.issues?.some(issue=>/conflict|lineage/.test(issue))) owner = root;
    }
    const accountId = owner.accountId;
    if (request.accountId && accountId && request.accountId !== accountId) throw new Error('请求账号与对话记录中的归属不符。');
    if (!accountId) return {threadId:selected.id,accountId:'local-unattributed',accountIdentityStatus:'unknown',localOnly:true};
    return {threadId:selected.id,accountId};
  }
  async function resolveLineage({accountId, threadId}) {
    const inventory = await account({threadId});
    const row = inventory.conversations?.find(row => (row.threadId || row.id) === threadId);
    if (!row?.issues?.some(issue=>/conflict|lineage/.test(issue)) && row?.parentThreadId && row.rootThreadId && row.relationship === 'subagent') {
      const root = (await account({threadId:row.rootThreadId})).conversations.find(item=>item.threadId===row.rootThreadId);
      if (!root || (root.accountId || 'local-unattributed') !== accountId || root.issues?.some(issue=>/conflict|lineage/.test(issue))) return null;
      return {rootThreadId:row.rootThreadId,relationship:'subagent',verified:true};
    }
    return null;
  }
  async function readBudgetUsage(request) {
    if (request.startAt === request.endAt) return {accountId:request.accountId,rootThreadId:request.threadId,startAt:request.startAt,endAt:request.endAt,scopeVerified:true,knownUsd:0,costComplete:true,unknownCostCount:0,pending:true,observedAt:request.endAt};
    const {threadId,...query} = request;
    delete query.accountId; // A conversation soft budget includes all verified descendants, regardless of billing attribution.
    const ledger = await account({...query,conversationId:threadId,includeDescendants:true});
    const c = ledger.coverage || {}, t = ledger.total || {};
    const verified = c.localScanComplete === true && c.conflictingRequests === 0;
    const complete = c.usageComplete === true && c.timeFilterExact === true && c.ownershipUnresolvedRequests === 0;
    return {accountId:request.accountId,rootThreadId:request.threadId,startAt:request.startAt,endAt:request.endAt,
      scopeVerified:verified,knownUsd:t.requestCount > 0 && t.pricedRequests === 0 ? null : Number(t.knownUsd),costComplete:complete && (t.costComplete === true || t.requestCount === 0),
      unknownCostCount:t.unpricedRequests,pending:!c.localScanComplete,observedAt:new Date(ledger.observedAt).toISOString()};
  }
  const budgets = createBudgetService({dataDir,readUsage:readBudgetUsage,resolveLineage,now});
  function observedSummary(ledger, period) {
    if (!ledger) return {status:'unavailable',apiEquivalentUsd:null,costUsd:null,costUSD:null,tokens:null,period,source:'codex-local-ledger'};
    const t=ledger.total || {}, c=ledger.coverage || {};
    const known=Number(t.knownUsd);
    const hasKnown=t.requestCount>t.unpricedRequests && Number.isFinite(known);
    const amount=hasKnown ? known : t.requestCount===0 && c.localScanComplete && c.usageComplete && c.timeFilterExact ? 0 : null;
    const costComplete=t.costComplete === true && c.localScanComplete === true && c.usageComplete === true && c.timeFilterExact === true;
    return {status:amount===null?'unavailable':costComplete?'observed':'partial',apiEquivalentUsd:amount,costUsd:amount,costUSD:amount,
      tokens:t.requestCount ? t.totalTokens ?? t.knownTokens?.totalTokens ?? null : amount===0 ? 0 : null,
      totalTokens:t.requestCount ? t.totalTokens ?? t.knownTokens?.totalTokens ?? null : amount===0 ? 0 : null,knownTokens:t.knownTokens,
      period:ledger.period || period,updatedAt:ledger.observedAt,source:'codex-local-ledger',sourceLabel:'Gauge · Codex 本地记录',
      scope:'discoverable-local-telemetry',precision:c.timeFilterExact?'exact-observed-records':'partial-time-attribution',
      costComplete,pricingComplete:t.costComplete === true,scanComplete:c.localScanComplete === true,unpricedRequests:t.unpricedRequests,
      estimatedTierRequests:t.estimatedTierRequests,byServiceTier:ledger.byServiceTier,
      coverageComplete:false,accountIdentityStatus:ledger.accountStatus,qualityReasons:c.issues || []};
  }
  async function quota(args = {}) {
    const at=now();
    const day=at.toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'});
    const todayStart=Date.parse(day+'T00:00:00+08:00');
    const endAt=at.toISOString(),todayRequest={startAt:new Date(todayStart).toISOString(),endAt},
      historyRequest={startAt:new Date(todayStart-29*86400000).toISOString(),endAt};
    const recent=Promise.allSettled([account(todayRequest),account(historyRequest)]);
    const snapshot = await quotaSnapshot();
    const official = selectWeeklyWindow(snapshot,args.limitId || args.poolId).weekly;
    const accountId = snapshot.account?.accountId || snapshot.accountId || null;
    const poolId = args.limitId || args.poolId || official?.poolId;
    const cycleQuery = ledgerRequestForQuota(snapshot,{poolId});
    let cycleUsage=null;
    if (cycleQuery.request) cycleUsage=await account(cycleQuery.request);
    const estimateInput=cycleUsage && normalizeCycleUsage(cycleUsage,{request:cycleQuery.request});
    const requestedAccount = normalizeRequest(args).accountId;
    const scopedQuota = requestedAccount && requestedAccount !== accountId ? {...snapshot,qualityReasons:[...(snapshot.qualityReasons || []),{code:'account_identity_mismatch',severity:'blocker'}]} : snapshot;
    const rawEstimate=estimateCapacity({accountUsage:estimateInput,quota:scopedQuota,poolId});
    const currentWindow=observedSummary(cycleUsage,official?.period || null);
    const observations=await recent;
    const today=observedSummary(observations[0].status==='fulfilled'?observations[0].value:null,todayRequest),
      last30Days=observedSummary(observations[1].status==='fulfilled'?observations[1].value:null,historyRequest);
    const costSummary={source:'codex-local-ledger',sourceLabel:'Gauge · Codex 本地记录',scope:'discoverable-local-telemetry',
      bucketTimeZone:'Asia/Shanghai',updatedAt:endAt,today,last30Days,currentWindow,currentCycle:currentWindow,cycle:currentWindow,history:{last30Days}};
    const observedCycleUsd=rawEstimate.observedCycleUsd ?? estimateInput?.apiEquivalentUsd ?? currentWindow.apiEquivalentUsd;
    const estimate={...rawEstimate,accountId,capacityUsd:rawEstimate.estimatedCapacityUsd,period:official?.period,
      usedFraction:official?.usedPercent == null ? null : official.usedPercent/100,observedAt:rawEstimate.updatedAt,
      knownPeriodUsd:observedCycleUsd,periodCostUsd:observedCycleUsd,observedCycleUsd,
      cycleTokens:currentWindow.tokens,costComplete:currentWindow.costComplete,source:'codex-local-ledger',sourceLabel:'Gauge 本地记录',
      reliability:rawEstimate.reliability || 'limited',warnings:(rawEstimate.qualityReasons || []).map(reason=>reason.code)};
    return {...snapshot,weekly:official,accountId,estimate,cycleUsage,costSummary,costs:costSummary,
      observedAt:snapshot.updatedAt,warnings:(snapshot.qualityReasons || []).map(reason=>reason.code)};
  }
  const budgetView = value => ({...value,accountId:value.accountId === 'local-unattributed' ? null : value.accountId,
    accountIdentityStatus:value.accountId === 'local-unattributed' ? 'unknown' : 'recorded',localOnly:true,
    spentUsd:value.spentKnownUsd,usage:value.observation,startAt:value.effectiveAt,costComplete:value.observation?.costComplete,
    warnings:value.accountId === 'local-unattributed' ? ['账号归属未知；金额预算仅绑定本地对话，不能用于同账号周估算。'] : []});
  async function getBudget(args, extra) {
    const scope = await budgetScope(args, extra);
    if (!scope) return needsThreadResult();
    return appResult('budget',budgetView(await budgets.getBudget(scope)));
  }
  async function setBudget(args, extra) {
    // Closing an existing root budget must remain possible if its logs disappear.
    if (args.enabled === false) {
      const selected = requestThread(args,extra);
      if (!selected) return needsThreadResult();
      const {readFile} = await import('node:fs/promises');
      let store;try {store=JSON.parse(await readFile(join(dataDir,'budgets-v1.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
      const saved = Object.values(store?.budgets || {}).filter(row=>row.threadId===selected.id);
      if (saved.length) {
        let result;
        for (const record of saved) result = await budgets.disableBudget({accountId:record.accountId,threadId:record.threadId});
        return appResult('budget',budgetView(result),'预算已关闭，停止后续提示；历史提示不能撤回。');
      }
    }
    const scope = await budgetScope(args, extra);
    if (!scope) return needsThreadResult();
    const request = {...normalizeRequest(args),...scope};
    if (request.enabled === true && request.mode === 'percentage') request.estimate = (await quota(args)).estimate;
    return appResult('budget',budgetView(await budgets.setBudget(request)),'预算设置已保存；模型送达状态需单独核验。');
  }
  async function budgetContext(args, extra) {
    const scope = await budgetScope(args, extra);
    if (!scope) return needsThreadResult();
    const context = await budgets.getContext({...scope,event:'manual'});
    if (!context.shouldDeliver) return {content:[],structuredContent:{enabled:context.enabled,context:'',reason:context.reason}};
    const delivery = await budgets.recordDelivery({...scope,deliveryId:context.deliveryId,epoch:context.budget.epoch,revision:context.budget.revision,
      channel:'tool',budgetStatus:context.budget.status,turnKey:context.turnKey,hostVerified:false});
    if (!delivery.recorded) return {content:[],structuredContent:{enabled:false,context:'',reason:delivery.reason}};
    return {content:[{type:'text',text:context.context}],structuredContent:{enabled:true,context:context.context,delivery},_meta:{budget:context.budget}};
  }
  async function overview(args = {}) {
    const accountId = normalizeRequest(args).accountId;
    if (!accountId) {
      const {readFile} = await import('node:fs/promises');
      let store; try {store = JSON.parse(await readFile(join(dataDir,'budgets-v1.json'),'utf8'));} catch(error) {if(error.code !== 'ENOENT') throw error;}
      const ids = [...new Set(Object.values(store?.budgets || {}).filter(row=>row.enabled).map(row=>row.accountId))];
      const results = await Promise.all(ids.map(id=>budgets.getOverview({accountId:id})));
      const items = results.flatMap(result=>result.budgets.map(budgetView));
      return {status:'local',accountId:null,budgets:items,enabledCount:items.length,allocatedUsd:results.reduce((sum,result)=>sum+result.allocatedPlanUsd,0),
        planOnly:true,subtractFromOfficialRemaining:false,observedAt:now().toISOString(),warnings:['本地多账号与归属未知的对话预算计划；非官方余额。']};
    }
    const result = await budgets.getOverview({accountId});
    return {...result,status:'local',allocatedUsd:result.allocatedPlanUsd,enabledCount:result.count,budgets:result.budgets.map(budgetView)};
  }
  return {account,quota,getBudget,setBudget,budgetContext,overview,budgetScope,budgets,readThread};
}
