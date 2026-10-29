import { $, put, reconcile } from './dom.js';
import {finite,formatNumber as num,formatMoney as money,formatDate as date,list,payload,normalizeConversation,normalizeCost,normalizeTokens,filterConversations,budgetDeliveryLabel,uniqueDiagnostics,formatOverviewMoney as overviewMoney} from './account-model.js';
const reasonLabels={account_identity_unknown:'账号身份未知',pool_identity_unknown:'计费池身份未知',period_unknown:'官方周期未知',sample_too_small:'官方额度已用比例过小，采样不足',other_device_usage_possible:'可能存在其他设备消耗',source_coverage_incomplete:'数据来源覆盖不完整',account_attribution_incomplete:'账号归属不完整',pricing_incomplete:'价格缺失或费用未完整计价',weekly_window_unavailable:'未发现明确的官方周额度窗口',weekly_pool_ambiguous:'存在多个周额度池，请明确选择',quota_outside_current_period:'额度数据不在当前官方周期',model_mix_and_rate_weights_may_change:'模型组合与额度权重可能变化',api_equivalent_extrapolation:'按 API 等价费用外推容量',account_identity_mismatch:'账号不一致',pool_identity_mismatch:'计费池不一致',quota_stale:'官方额度数据已过期',usage_stale:'本地费用数据已过期',usage_period_mismatch:'费用与官方周期不一致'};
Object.assign(reasonLabels,{other_device_usage_unreconciled:'其他设备消耗尚未核对',account_coverage_incomplete:'账号归属覆盖不完整',pool_coverage_incomplete:'计费池归属覆盖不完整',period_coverage_incomplete:'官方周期内费用记录不完整',observation_stale:'额度或费用数据已过期',ledger_period_mismatch:'费用与官方周期不一致',ledger_quota_not_synchronized:'费用与额度采集时间未对齐',cycle_cost_unknown:'本周期累计费用未知',cost_basis_unverified:'API 等价计价依据未确认',pricing_completeness_unverified:'费用完整计价尚未确认',quota_unavailable:'官方额度暂不可读',observation_time_unknown:'采集时间未知',positive_quota_without_recorded_cost:'官方已记录消耗，但本地未发现对应费用','account-attribution-unknown':'部分记录的账号归属未知','time-attribution-incomplete':'部分记录无法精确归入时间区间','legacy-lineage-unresolved':'部分旧记录的继承历史归属待确认','records-pending':'部分记录尚未落盘完整','scan-deferred':'本次扫描达到上限，将在后续读取继续','native-total-gap':'部分请求明细缺失','parent-transcript-missing':'已知主对话缺少本地记录','conflicting-session-metadata':'对话归属记录有冲突','missing-local-transcript':'本地对话记录缺失','nonlocal-or-missing-transcript':'非本地或缺少记录的对话','index-discovery-incomplete':'会话索引发现未完成','thread-index-unavailable':'会话索引暂不可读'});
Object.assign(reasonLabels,{local_history_account_pool_assumption:'按当前账号与额度池归属假设关联本地历史',local_history_external_coverage_unknown:'其他设备和已删除记录未纳入',observed_cycle_subtotal:'周期费用为已观测小计，记录仍有缺失',observed_priced_subtotal:'费用仅含可计价记录',multiple_accounts_in_cycle:'本周期记录含多个账号，无法直接合并估算',multiple_pools_in_cycle:'本周期记录含多个额度池，无法直接合并估算',mixed_billing_modes_in_cycle:'本周期混用了订阅与 API Key 记录',used_percent_zero:'官方已用比例为 0%，暂不能外推容量',used_percent_unknown:'官方已用比例暂不可读',provider_timeout:'官方额度读取超时，可刷新重试',provider_read_failed:'官方额度读取失败，可刷新重试',codex_login_required:'请先在 Codex 中登录账号',codex_cli_not_installed:'未找到可读取官方额度的 Codex 程序',chatgpt_quota_not_supported_for_auth_mode:'当前登录方式不提供订阅周额度',quota_usage_corrected:'本周期官方用量已修正，等待重新核对估算',quota_reset_or_cycle_corrected:'官方额度周期已提前重置，等待重新核对估算'});
const warnings=value=>uniqueDiagnostics(value).map(x=>{const key=typeof x==='string'?x:x.message||x.code||'数据限制';return reasonLabels[key]||key;}).join('\n');
function rowCells(count){const row=document.createElement('tr');for(let i=0;i<count;i++)row.append(document.createElement('td'));return row;}
function setOptions(id,values,label){
  const select=$(id),selected=select.value;
  reconcile(select,[{id:'',name:label},...values.map(value=>({id:value,name:value}))],()=>document.createElement('option'),(el,item)=>{el.value=item.id;el.textContent=item.name;});
  select.value=values.includes(selected)?selected:'';
}
function sourceRows(id,rows){
  const normalized=list(rows).map((row,i)=>({...row,id:String(row.id??row.model??row.project??row.label??row.name??row.day??row.date??i),label:row.label??row.model??row.project??row.name??row.day??row.date??row.id??'未知',...normalizeCost(row)}));
  const max=Math.max(...normalized.map(row=>row.amount??0),0);
  reconcile($(id),normalized.length?normalized:[{id:'empty',label:'暂无可用数据',amount:null}],()=>{const el=document.createElement('div');el.className='source-row';el.innerHTML='<span></span><span class="mono"></span><div class="source-meter"><i></i></div>';return el;},(el,row)=>{el.children[0].textContent=row.label;el.children[1].textContent=row.amount===null?'—':(row.complete?'':'≥ ')+money(row.amount);el.children[2].hidden=row.amount===null;el.children[2].firstChild.style.width=(max?Math.max(0,row.amount)/max*100:0)+'%';});
}
export function createAccountPanel({callTool,getThread,onSelectThread}) {
  let account=null,quota=null,estimate=null,budget=null,overview=null,rows=[],selected=null,busy=false,budgetBusy=false,active='turn',lastRead=0,lastBudgetRead=0,editing=false,draftThread=null;
  let range={},quotaFresh=false,queuedAccountRefresh=false;
  const usableEstimate=()=>quotaFresh&&['available','estimated'].includes(estimate?.status)&&finite(estimate?.capacityUsd)!==null;
  async function readAllConversations(request){
    const first=await tool('get_account_usage',{...request,limit:500,offset:0},'accountUsage');
    let combined=list(first.conversations),offset=first.nextOffset??(first.threadCount>combined.length?combined.length:null);
    const seen=new Set([0]);
    while(offset!==null){
      if(seen.has(offset)){first.paginationIncomplete=true;break;}seen.add(offset);
      const page=await tool('get_account_usage',{...request,limit:500,offset},'accountUsage');
      const chunk=list(page.conversations);combined.push(...chunk);
      offset=page.nextOffset??(page.threadCount>combined.length&&chunk.length?combined.length:null);
      if(!chunk.length&&combined.length<page.threadCount){first.paginationIncomplete=true;break;}
    }
    return {...first,conversations:[...new Map(combined.map((row,i)=>[row.threadId??row.id??i,row])).values()]};
  }
  const tool=async(name,args,key)=>payload(await callTool({name,arguments:args}),key);
  const identity=()=>({thread_id:getThread()?.threadId,account_id:getThread()?.accountId??null});
  const filters=()=>({search:$('accountSearch').value,model:$('accountModel').value,project:$('accountProject').value,status:$('accountFilter').value,sort:$('accountSort').value});
  function renderRows(){
    const filtered=filterConversations(rows,filters());
    put('accountRowCount',filtered.length===(account?.threadCount??rows.length)?filtered.length+' 个对话':filtered.length+' / '+(account?.threadCount??rows.length)+' 个对话');
    $('accountEmpty').hidden=filtered.length>0;
    put('accountEmpty',rows.length?'没有符合筛选条件的记录':'查询范围内尚无可读本地记录');
    reconcile($('accountRows'),filtered,()=>{const tr=rowCells(4);tr.tabIndex=0;tr.setAttribute('role','button');tr.children[0].innerHTML='<span class="row-title"></span><span class="row-meta"></span>';tr.children[1].innerHTML='<span></span><span class="row-meta"></span>';tr.onclick=()=>selectRow(tr.dataset.id);tr.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();selectRow(tr.dataset.id);}};return tr;},(tr,row)=>{
      tr.setAttribute('aria-selected',String(row.id===selected));tr.setAttribute('aria-label','查看'+row.title+'的用量明细');
      tr.children[0].children[0].textContent=row.title;
      tr.children[0].children[1].textContent=[row.project||'项目未知',row.archived?'已归档':null,row.parentThreadId?'子代理':null].filter(Boolean).join(' · ');
      tr.children[1].children[0].textContent=row.model||'模型未知';tr.children[1].children[1].textContent=date(row.updatedAt);
      tr.children[2].textContent=(row.tokens.partial?'≥ ':'')+num(row.tokens.total);tr.children[2].className='mono numeric';
      tr.children[3].textContent=row.amount===null?'未计价':(row.complete?'':'≥ ')+money(row.amount);tr.children[3].className='mono numeric';
    });
    if(selected)renderInspector();
  }
  function selectRow(id){selected=id;renderRows();}
  function renderInspector(){
    const row=rows.find(row=>row.id===selected);$('accountInspector').hidden=!row;if(!row)return;
    put('inspectorTitle',row.title);put('inspectorMeta',[row.project,row.model,date(row.updatedAt)].filter(Boolean).join(' · '));
    const metrics=[['未缓存输入',row.tokens.input],['缓存读取',row.tokens.cacheRead],['缓存写入',row.tokens.cacheWrite],['输出',row.tokens.output],['推理（已含输出）',row.tokens.reasoning]];
    reconcile($('inspectorTokens'),metrics.map(([label,value])=>({id:label,label,value})),()=>{const el=document.createElement('div');el.innerHTML='<span class="eyebrow"></span><strong class="mono"></strong>';return el;},(el,item)=>{el.firstChild.textContent=item.label;el.lastChild.textContent=num(item.value);});
    put('inspectorStatus',row.amount===null?'费用未计价':(row.complete?'':'≥ ')+money(row.amount));
    $('openAccountThread').disabled=!row.threadId&&!row.id;
    const models=list(row.modelBreakdown??row.modelsBreakdown);$('inspectorModels').hidden=!models.length;if(models.length)sourceRows('inspectorModels',models);
  }
  function renderAccount(){
    if(!account)return;
    rows=list(account.conversations).map(normalizeConversation);
    const coverage=account.coverage??{};
    renderUpdatedAt();
    const summary=account.summary??account.total??account,summaryCost=normalizeCost(summary),summaryTokens=normalizeTokens(summary);
    put('accountCost',summaryCost.amount===null?'未计价':(summaryCost.complete?'':'≥ ')+overviewMoney(summaryCost.amount));
    put('accountTokens',(summaryTokens.partial&&summaryTokens.total!==null?'≥ ':'')+num(summaryTokens.total));
    setOptions('accountModel',[...new Set(rows.flatMap(row=>row.modelNames?.length?row.modelNames:[row.model]).filter(Boolean))].sort(),'全部模型');
    setOptions('accountProject',[...new Set(rows.map(row=>row.project).filter(Boolean))].sort(),'全部项目');
    const applied=account.range??account.period??range;
    put('accountRangeStatus',(applied.startAt||applied.endAt?'查询范围：'+(applied.startAt?date(applied.startAt):'最早记录')+' → '+(applied.endAt?date(applied.endAt)+'（不含）':'最新记录'):'')+(account.rangeStatus==='unsupported'?'当前来源不支持精确日期筛选。':coverage.timeFilterExact===false?'时间归属不完整，日期范围可能缺少记录。':''));
    renderRows();
    const sources=account.sources??account.breakdown??{};
    sourceRows('modelSources',sources.models??account.byModel);
    const parts=account.summary?.costParts??account.total?.costParts;
    const categories=parts?Object.entries(parts).map(([key,value])=>({id:key,label:{input:'未缓存输入',cached_input:'缓存读取',cache_write:'缓存写入',output:'输出（含推理）'}[key]||key,amountUsd:value,costComplete:account.summary?.costComplete??account.total?.costComplete})):null;
    sourceRows('tokenSources',sources.tokens??sources.categories??account.byCategory??categories);
    sourceRows('agentSources',list(sources.agents??account.byAgent).map(row=>({...row,label:row.label??({main:'主对话',subagent:'明确归属子代理'}[row.id]??row.name)})));
    sourceRows('projectSummary',account.projects??account.byProject);
    const days=list(account.daily??account.byDay).map(day=>({...day,day:day.day??day.date??day.id}));sourceRows('daySummary',days);
    const chart=days.slice(-30).map((day,i)=>({...day,id:String(day.day??day.date??i),...normalizeCost(day)}));
    const max=Math.max(...chart.map(day=>day.amount??0),0);
    reconcile($('dayChart'),chart,()=>{const el=document.createElement('div');el.className='day-column';el.innerHTML='<i></i><span></span>';return el;},(el,day)=>{el.title=(day.day??day.date??'日期未知')+' · '+(day.amount===null?'未计价':money(day.amount));el.firstChild.style.height=(day.amount===null?0:Math.max(2,max?day.amount/max*85:2))+'px';el.lastChild.textContent=String(day.day??day.date??'').slice(5)||'未知';});
  }
  function renderRecentCosts(){
    const costs=quota?.costs;
    const today=costs?.today,current=costs?.currentWindow,month=costs?.last30Days;
    function renderCost(metric,row){
      const amount=finite(row?.apiEquivalentUsd);
      const tokenValue=row?.tokens??row?.knownTokens?.totalTokens;
      const tokens=finite(tokenValue);
      const partial=row?.costComplete===false||row?.scanComplete===false;
      put(metric+'Cost',(amount!==null&&partial?'≥ ':'')+overviewMoney(amount));put(metric+'Tokens',tokens===null?'':(partial?'≥ ':'')+num(tokens)+' Tokens');
    }
    renderCost('today',today);renderCost('window',current);renderCost('month',month);
  }

  function renderQuota(){
    if(!quota)return;
    const weekly=quota.weekly??{},period=weekly.period??{};
    estimate=quota.estimate??null;
    const used=finite(weekly.usedPercent),remaining=finite(weekly.remainingPercent??(used===null?null:100-used));
    const periodEnd=period.endAt;
    put('weeklyUsed',used===null?'—':used.toFixed(1)+'%');put('weeklyRemaining',remaining===null?'':remaining.toFixed(1)+'% 剩余');
    put('weeklyReset',periodEnd?'重置于 '+date(periodEnd):'');
    const capacity=finite(estimate?.capacityUsd);
    put('weeklyCapacity',overviewMoney(capacity));
    $('quotaMeter').hidden=used===null;$('quotaFill').style.width=Math.min(100,Math.max(0,used??0))+'%';
    if(used!==null){$('quotaMeter').setAttribute('aria-valuenow',used);$('quotaMeter').setAttribute('aria-valuemin','0');$('quotaMeter').setAttribute('aria-valuemax','100');}else $('quotaMeter').removeAttribute('aria-valuenow');
    const costSource=quota.costs;
    const diagnostics=uniqueDiagnostics(quota.warnings,quota.qualityReasons,estimate?.warnings,estimate?.reasons,estimate?.qualityReasons,costSource?.warnings,costSource?.qualityReasons,costSource?.currentWindow?.qualityReasons);
    const blockers=diagnostics.filter(item=>typeof item==='object'&&item.severity==='blocker');
    put('quotaWarnings',capacity===null&&blockers.length?warnings(blockers.slice(0,1)):'');
    const pools=list(quota.pools);$('quotaPoolDetails').hidden=!pools.length;
    reconcile($('quotaPools'),pools.flatMap((pool,i)=>list(pool.windows).length?pool.windows.map((window,j)=>({...window,id:String(pool.poolId??pool.id??i)+'-'+j,name:pool.name??pool.poolId??pool.id})): [{...pool,id:String(pool.id??pool.limitId??i)}]),()=>{const el=document.createElement('p');return el;},(el,pool)=>{el.textContent=(pool.name??pool.id??'额度池')+(pool.windowDurationMins?' · '+(pool.windowDurationMins===10080?'周窗口':pool.windowDurationMins+' 分钟窗口'):'')+' · '+(finite(pool.usedPercent)===null?'比例未知':pool.usedPercent+'% 已用')+' · '+(pool.resetsAt?date(pool.resetsAt)+' 重置':'周期未知');});
    renderRecentCosts();renderBudgetPreview();renderUpdatedAt();
  }
  function renderUpdatedAt(){
    const observed=quota?.costs?.updatedAt??account?.observedAt;
    put('accountStatus',observed?'更新于 '+date(observed):'');
  }
  function hydrate(snapshot){
    if(!snapshot){
      account=null;quota=null;estimate=null;quotaFresh=false;lastRead=0;rows=[];selected=null;
      ['todayCost','windowCost','monthCost','weeklyUsed','weeklyCapacity','accountCost','accountTokens'].forEach(id=>put(id,'—'));
      ['todayTokens','windowTokens','monthTokens','weeklyRemaining','weeklyReset','accountStatus','quotaWarnings'].forEach(id=>put(id,''));
      $('quotaMeter').hidden=true;$('quotaPoolDetails').hidden=true;$('accountInspector').hidden=true;
      ['quotaPools','modelSources','tokenSources','agentSources','projectSummary','daySummary','dayChart'].forEach(id=>$(id).replaceChildren());
      setOptions('accountModel',[],'全部模型');setOptions('accountProject',[],'全部项目');renderRows();return;
    }
    if(snapshot.accountUsage&&!Object.keys(range).length){account=snapshot.accountUsage;renderAccount();}
    if(snapshot.quota){quota=snapshot.quota;quotaFresh=false;renderQuota();}
    if(account&&quota&&account.nextOffset==null)lastRead=snapshot.savedAt??0;
  }
  async function refreshAccount(force=false){
    if(busy){if(force)queuedAccountRefresh=true;return;}if(!force&&Date.now()-lastRead<15000)return;
    busy=true;$('accountRefresh').disabled=true;$('accountRefresh').setAttribute('aria-busy','true');
    const reads=await Promise.allSettled([
      readAllConversations({...range}).then(value=>{account=value;renderAccount();}),
      tool('get_account_quota',{},'quota').then(value=>{quota=value;quotaFresh=value.status==='available';renderQuota();})
    ]);
    if(reads[1].status==='rejected'){quotaFresh=false;renderBudgetPreview();}
    put('accountNotice',reads.some(result=>result.status==='rejected')?'更新失败'+(account||quota?' · 显示上次结果':'，请重试'):'');
    lastRead=Date.now();busy=false;$('accountRefresh').disabled=false;$('accountRefresh').setAttribute('aria-busy','false');if(queuedAccountRefresh){queuedAccountRefresh=false;void refreshAccount(true);}
  }
  function renderBudgetPreview(){
    const mode=$('budgetMode').value,value=finite($('budgetValue').value),capacity=finite(estimate?.capacityUsd);
    put('budgetValueLabel',mode==='percentage'?'整周估算容量（%）':'金额（美元）');
    $('budgetValue').max=mode==='percentage'?'100':'';
    if(mode==='percentage')put('budgetPreview',usableEstimate()?'当前估算 '+money(capacity)+' × '+(value??'—')+'% = '+money(value===null?null:capacity*value/100)+'（金额固定）':'暂无有效估算，请使用金额预算。');
    else put('budgetPreview','');
    $('budgetSave').disabled=budgetBusy||!identity().thread_id||mode==='percentage'&&!usableEstimate();
  }
  function renderBudget(){
    const target=getThread(),threadId=target?.threadId;
    put('budgetThread',threadId?(target.title||'当前对话'):'当前聊天标识未知，账号统计仍可使用');
    $('budgetEnabled').disabled=!threadId||budgetBusy;
    if(editing&&draftThread!==threadId){editing=false;$('budgetForm').hidden=true;put('budgetNotice','对话已切换，未保存调整已取消。');}
    if(!editing)$('budgetEnabled').checked=budget?.enabled===true;
    put('budgetState',budget?.enabled?'已启用':'已关闭');
    $('budgetSummary').hidden=!budget?.enabled;
    put('budgetDelivery',budget?.enabled?budgetDeliveryLabel(budget):'');
    if(budget?.enabled){
      const remaining=finite(budget.remainingUsd),knownRemaining=finite(budget.remainingKnownUsd),overspent=finite(knownRemaining<0?-knownRemaining:null);
      put('budgetAmount',money(budget.amountUsd));put('budgetSpent',money(budget.spentUsd));
      put('budgetRemainingLabel',overspent>0||remaining<0?'超支':'剩余预算');put('budgetRemaining',money(overspent>0?overspent:remaining<0?-remaining:remaining));
      put('budgetBasis',budget.startAt?'生效于 '+date(budget.startAt):'');
      put('budgetSave','保存调整');
    }else put('budgetSave','保存并启用');
    renderBudgetPreview();
  }
  function renderOverview(){
    if(!overview)return;
    const budgets=list(overview.budgets);
    put('budgetAllocated',money(overview.allocatedUsd));put('budgetCount',num(overview.enabledCount));
    put('budgetOverviewStatus',overview.status==='unavailable'?'预算读取失败':'');
    $('budgetEmpty').hidden=budgets.length>0;$('budgetOverviewContent').hidden=!budgets.length;
    reconcile($('budgetRows'),budgets.map((row,i)=>({...row,id:String(row.rootThreadId??row.threadId??i)})),()=>rowCells(4),(tr,row)=>{tr.children[0].textContent=row.title||row.threadId||row.id;tr.children[1].textContent=money(row.amountUsd)+' / '+money(row.spentUsd);const left=finite(row.remainingUsd);tr.children[2].textContent=left===null?'—':left<0?'超支 '+money(-left):money(left);tr.children[3].textContent=budgetDeliveryLabel(row);});
  }
  async function refreshBudget(force=false){
    if(budgetBusy||!force&&Date.now()-lastBudgetRead<15000)return;
    const id=identity();budgetBusy=true;renderBudget();$('budgetRefresh').disabled=true;
    const reads=await Promise.allSettled([id.thread_id?tool('get_conversation_budget',{thread_id:id.thread_id,...(id.account_id?{account_id:id.account_id}:{})},'budget'):Promise.resolve(null),tool('get_budget_overview',{},'budgetOverview')]);
    // Ignore a late response after switching to a different conversation.
    if(getThread()?.threadId===id.thread_id){if(reads[0].status==='fulfilled'){budget=reads[0].value;}else put('budgetNotice','预算状态暂不可读，未进行启用或送达操作。');}
    if(reads[1].status==='fulfilled'){overview=reads[1].value;renderOverview();}else put('budgetOverviewStatus','预算总览暂不可用');
    const switched=getThread()?.threadId!==id.thread_id;lastBudgetRead=switched?0:Date.now();budgetBusy=false;$('budgetRefresh').disabled=false;renderBudget();if(switched&&active==='budget')void refreshBudget(true);
  }
  async function saveBudget(enabled){
    const id=identity();if(!id.thread_id)return;
    const mode=$('budgetMode').value,value=finite($('budgetValue').value);
    if(enabled&&(value===null||value<=0||mode==='percentage'&&value>100)){put('budgetNotice','请输入有效的正数'+(mode==='percentage'?'，比例不能大于 100%。':'。'));return;}
    if(enabled&&mode==='percentage'&&!usableEstimate()){put('budgetNotice','没有可用整周估算，无法保存比例预算。');return;}
    budgetBusy=true;renderBudget();$('budgetSave').disabled=true;put('budgetNotice','正在保存…');
    try {
      const args={thread_id:id.thread_id,...(id.account_id?{account_id:id.account_id}:{}),enabled};
      if(enabled)Object.assign(args,{mode,...(mode==='percentage'?{percent:value}:{amount_usd:value})});
      const saved=await tool('set_conversation_budget',args,'budget');
      if(getThread()?.threadId===id.thread_id){budget=saved;editing=false;$('budgetForm').hidden=true;put('budgetNotice',enabled?'已保存':'已关闭');}
      lastBudgetRead=0;
    }catch{put('budgetNotice','保存未成功，请检查账号归属、宿主支持和当前估算。');}
    finally{budgetBusy=false;renderBudget();}
    await refreshBudget(true);
  }
  ['accountSearch','accountModel','accountProject','accountFilter','accountSort'].forEach(id=>$(id).addEventListener(id==='accountSearch'?'input':'change',renderRows));
  $('accountRefresh').onclick=()=>refreshAccount(true);
  $('applyAccountRange').onclick=()=>{
    const start=$('accountStart').value,end=$('accountEnd').value;
    if(start&&end&&start>=end){put('accountNotice','结束日期必须晚于起始日期；结束边界不计入查询。');return;}
    range={...(start?{startAt:new Date(start+'T00:00:00').toISOString()}:{}),...(end?{endAt:new Date(end+'T00:00:00').toISOString()}:{})};void refreshAccount(true);
  };
  $('clearAccountRange').onclick=()=>{range={};$('accountStart').value='';$('accountEnd').value='';void refreshAccount(true);};
  $('closeInspector').onclick=()=>{selected=null;$('accountInspector').hidden=true;renderRows();};
  $('openAccountThread').onclick=()=>{const row=rows.find(row=>row.id===selected);if(row)onSelectThread(row.id,row);};
  $('accountExport').onclick=async()=>{
    $('accountExport').disabled=true;put('accountNotice','');
    try{
      const result=await tool('export_account_usage',{...range,format:$('exportFormat').value,filters:filters()},'export');
      if(result.status==='unavailable'||result.status==='unsupported')throw new Error('导出不可用');
      if(typeof result.content!=='string')throw new Error('缺少可下载内容');
      const blob=new Blob([result.content],{type:result.mimeType||'text/plain;charset=utf-8'}),url=URL.createObjectURL(blob);
      const link=document.createElement('a');link.href=url;link.download=(result.filename||'gauge-usage.'+$('exportFormat').value).split(/[\\/]/).at(-1);link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);put('accountNotice','已导出');
    }catch{put('accountNotice','导出暂不可用，当前宿主可能限制文件下载。');}finally{$('accountExport').disabled=false;}
  };
  $('budgetEnabled').onchange=()=>{
    if($('budgetEnabled').checked){editing=true;draftThread=getThread()?.threadId;$('budgetForm').hidden=false;if(budget?.enabled){$('budgetMode').value=budget.mode||'amount';$('budgetValue').value=budget.mode==='percentage'?(budget.percent??''):(budget.amountUsd??'');}renderBudgetPreview();}
    else if(budget?.enabled)void saveBudget(false);else {editing=false;$('budgetForm').hidden=true;renderBudget();}
  };
  $('budgetEdit').onclick=()=>{editing=true;draftThread=getThread()?.threadId;$('budgetForm').hidden=false;$('budgetMode').value=budget?.mode||'amount';$('budgetValue').value=budget?.mode==='percentage'?(budget.percent??''):(budget?.amountUsd??'');renderBudgetPreview();};
  $('budgetForm').onsubmit=event=>{event.preventDefault();void saveBudget(true);};
  $('budgetCancel').onclick=()=>{editing=false;$('budgetForm').hidden=true;renderBudget();};
  $('budgetMode').onchange=renderBudgetPreview;$('budgetValue').oninput=renderBudgetPreview;
  $('budgetRefresh').onclick=()=>refreshBudget(true);
  if(window.tokenlensSnapshot)hydrate(window.tokenlensSnapshot);
  return {
    start(){void refreshAccount();},
    activate(next){active=next;if(next==='account')void refreshAccount();if(next==='budget'){void refreshAccount(!quotaFresh);void refreshBudget();}},
    tick(){if(active==='account')void refreshAccount();if(active==='budget')void refreshBudget();},
    threadChanged(){budget=null;lastBudgetRead=0;renderBudget();if(active==='budget')void refreshBudget(true);},
    refresh(){if(active==='account')return refreshAccount(true);if(active==='budget')return refreshBudget(true);},
    receive(result){if(result?._meta&&Object.hasOwn(result._meta,'panelSnapshot'))hydrate(result._meta.panelSnapshot);if(result?._meta?.accountUsage){account=result._meta.accountUsage;renderAccount();}if(result?._meta?.quota){quota=result._meta.quota;quotaFresh=quota.status==='available';renderQuota();}if(result?._meta?.budget){budget=result._meta.budget;renderBudget();}if(result?._meta?.budgetOverview){overview=result._meta.budgetOverview;renderOverview();}}
  };
}
