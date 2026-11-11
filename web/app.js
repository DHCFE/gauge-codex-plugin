import { App } from '@modelcontextprotocol/ext-apps';
import { $, reconcile } from './dom.js';
import { createRoundPicker } from './round-picker.js';
import { createAccountPanel } from './account-panel.js';
import { costState, conversationAmount, pricingReason, serviceTierLabel } from './conversation-cost.js';
const app = new App({ name: 'Gauge', version: '0.5.10' }, {}, { autoResize: true });
const num = value => value===null||value===undefined ? '—' : Number(value).toLocaleString('en-US');
const money = value => value===null||value===undefined ? '—' : '$' + Number(value).toFixed(4);
const sum = values => values.reduce((a,b) => a+b, 0);
let explicitThread, boundThread, data, selectedId, scope = 'turn', connected = false, full = false, followLatest = true, loading = false, timer, contextRevision = 0;
let updateStatus, updateChecking = false, updateCheckedAt = -Infinity, updateRequested = false, updateTimer;
const amountText = t => conversationAmount(t,money);
const usageReasons = {
  'discovery-incomplete':'子代理记录尚未全部发现，当前显示已读部分。',
  'scan-deferred':'仍有对话记录等待读取，面板会继续补齐。',
  'scan-incomplete':'较大的日志正在分段读取，面板会继续补齐。',
  'records-pending':'部分记录仍在写入，面板会在写入完成后更新。',
  'descendant-usage-pending':'部分子代理尚无可读取的独立用量记录。',
  'missing-local':'已发现子代理，但其本地日志暂不可读。',
  'non-local-or-missing':'部分子代理的日志尚未同步到这台 Mac。',
  'embedded-history':'已识别继承的对话历史，费用按请求归属去重。',
  'legacy-lineage-unresolved':'部分旧记录无法确认属于子代理的独立用量，未猜测计入。',
  'native-total-gap':'用量汇总显示仍有请求记录缺失，当前显示已读部分。',
  'conflicting-request-record':'同一请求出现冲突记录，已排除不确定的费用。',
  'conflicting-session-metadata':'子代理归属记录存在冲突，已排除不确定的分支。',
  'native-session-identity-mismatch':'部分请求的执行身份与日志不符，已排除不确定的费用。',
  'cumulative-counter-reset':'部分旧用量计数发生重置，完整费用尚不能确认。',
  'invalid-telemetry-record':'部分用量记录格式无效，当前显示可确认的部分。',
  'native-request-identity-missing':'部分请求缺少身份标识，无法确认完整费用。',
  'history-ordinal-missing':'部分旧日志缺少历史边界序号，归属尚不能确认。',
  'invalid-history-boundary':'部分日志的继承历史边界无效，归属尚不能确认。',
  'session-metadata-missing':'对话身份记录暂不可读，当前显示已知部分。',
  'transcript-unreadable':'部分日志暂不可读，当前显示已知部分。',
  'thread-index-unavailable':'对话索引暂不可读，无法确认是否存在缺失子代理。',
  'request-boundaries-missing':'部分旧记录缺少独立请求边界，无法完整计价。',
  'file-replaced-during-scan':'日志在读取期间发生替换，等待下一次读取确认。',
  'file-disappeared-during-scan':'日志在读取期间移动或移除，等待下一次读取确认。',
  'index-discovery-incomplete':'对话索引尚未全部读取，当前显示已知部分。',
  'conflicting-request-time':'同一请求的时间记录不一致，无法精确归入预算区间。',
  'oversized-telemetry-record':'部分用量记录超出读取上限，无法确认完整费用。',
  'lineage-cycle':'子代理关系出现循环，无法确认完整费用。',
  'descendant-limit':'子代理数量超出本次读取上限，当前显示部分用量。',
  'descendant-depth-limit':'子代理层级超出本次读取上限，当前显示部分用量。'
};
const roundPicker = createRoundPicker({trigger:$('roundSelect'),list:$('roundOptions'),onSelect:selectTurn});
const statusText = t => t?.status === 'completed' ? '已完成' : t?.status === 'interrupted' ? '已中断' : '记录中';
function notice(text) { $('globalNotice').textContent = text; }
function showInstallation(state) {
  if (!state || state.status==='idle') return false;
  const button=$('updateAvailable');button.hidden=false;
  if (state.status==='installing') {
    updateRequested=true;button.disabled=true;button.textContent='更新中…';
    notice('正在下载、校验并安装 Gauge，统计和预算数据会保留。');
    clearTimeout(updateTimer);updateTimer=setTimeout(()=>void checkUpdate(false,true),1500);
  } else if (state.status==='installed') {
    updateRequested=true;button.disabled=true;button.textContent='已安装';
    notice('Gauge '+state.version+' 已安装。请保存当前工作后完全退出并重新打开客户端，以加载新版。');
  } else if (state.status==='failed') {
    updateRequested=false;button.disabled=false;button.textContent='重试更新';
    notice(state.message||'更新失败，请重试。');
  }
  return true;
}
async function checkUpdate(force=false,poll=false) {
  if (!connected || updateChecking || !force&&!poll&&Date.now()-updateCheckedAt<6*60*60_000) return;
  updateChecking=true;$('checkUpdate').disabled=true;
  try {
    const result=await app.callServerTool({name:'get_update_status',arguments:force?{force:true}:{}});
    const status=result?.structuredContent?.updateStatus;
    if(result?.isError||!status)throw Error('检查失败');
    updateStatus=status;
    updateCheckedAt=status.status==='unavailable'?Date.now()-6*60*60_000+15*60_000:Date.now();
    if(showInstallation(status.installation))return;
    $('updateAvailable').hidden=status.status!=='available';
    $('updateAvailable').title='安装 Gauge '+status.latestVersion;
    $('updateAvailable').setAttribute('aria-label','一键更新 Gauge 至 '+status.latestVersion);
    if(force)notice(status.status==='available'?'发现 Gauge '+status.latestVersion+'，点击「一键更新」安装。':status.status==='current'&&!status.stale?'当前已是最新版 Gauge '+status.currentVersion+'。':'暂时无法检查更新，请稍后重试。');
  } catch {
    updateCheckedAt=Date.now()-6*60*60_000+15*60_000;
    if(force)notice('检查更新失败，请检查网络后重试。');
    if(poll){clearTimeout(updateTimer);updateTimer=setTimeout(()=>void checkUpdate(false,true),5000);}
  } finally {updateChecking=false;$('checkUpdate').disabled=false;}
}
$('checkUpdate').onclick=()=>void checkUpdate(true);
$('updateAvailable').onclick=async()=>{
  if(!connected||updateRequested||updateStatus?.status!=='available')return;
  updateRequested=true;$('updateAvailable').disabled=true;
  try {
    const result=await app.callServerTool({name:'install_update',arguments:{version:updateStatus.latestVersion}});
    if(result?.isError||!result?.structuredContent?.installation)throw Error('安装失败');
    showInstallation(result.structuredContent.installation);
  } catch {
    updateRequested=false;$('updateAvailable').disabled=false;notice('未能启动更新，请重试。');
  }
};
function showWaiting(title='新对话', message='') {
  $('title').textContent=title;$('amount').classList.remove('unpriced');$('amount').textContent='—';$('tokens').textContent='等待用量记录';$('model').textContent='';$('count').textContent='';
  ['turnList','breakdown','costBar','chart','historyRows','agentStatus'].forEach(id=>$(id).replaceChildren());
  ['overviewCost','overviewTokens','overviewCount'].forEach(id=>$(id).textContent='—');
  ['prevTurn','nextTurn','latestTurn','roundSelect','explain'].forEach(id=>$(id).disabled=true);
  roundPicker.clear();$('warningDetails').hidden=true;$('connection').textContent='等待记录';notice(message);
}
const accountPanel = createAccountPanel({
  callTool: request => app.callServerTool(request),
  getThread: () => data || ((explicitThread || boundThread) ? {threadId:explicitThread || boundThread} : null),
  onSelectThread: (id) => { contextRevision++;explicitThread=id; data=null; selectedId=null; showWaiting('正在读取所选对话');followLatest=true; accountPanel.threadChanged(); setTab('turn'); void refresh(); }
});
function current() {
  if (!data) return null;
  if (scope === 'total') return data.total;
  return data.turns.find(t=>t.id===selectedId) || data.turns.at(-1);
}
function selectTurn(id) {
  if(!data?.turns.some(t=>t.id===id))return;
  selectedId=id; followLatest=false; setTab('turn',false);
  $('meterView').scrollIntoView({block:'start',behavior:'instant'});
}
function renderTurnNavigation(t) {
  const index=data.turns.findIndex(x=>x.id===t?.id);
  roundPicker.update(data.turns,t?.id,data.currentTurnId,scope==='total');
  $('prevTurn').disabled=index<=0||scope==='total';
  $('nextTurn').disabled=index<0||index>=data.turns.length-1||scope==='total';
  $('latestTurn').disabled=followLatest&&scope==='turn';
}

function renderOverview() {
  const t=data.total;
  $('overviewCost').textContent=amountText(t);
  $('overviewTokens').textContent=num(t.totalTokens);
  $('overviewCount').textContent=data.turns.length+' 轮';
  const recent=data.turns.slice(-12), max=Math.max(...recent.map(t=>t.totalTokens),1);
  reconcile($('chart'),recent,()=>{const c=document.createElement('button');c.className='column';c.innerHTML='<i></i><small></small>';c.onclick=()=>selectTurn(c.dataset.id);return c;},(c,t)=>{c.title=t.title+' · '+num(t.totalTokens)+' tokens · '+amountText(t);c.firstChild.style.height=Math.max(3,t.totalTokens/max*115)+'px';c.lastChild.textContent=String(data.turns.findIndex(turn=>turn.id===t.id)+1);c.setAttribute('aria-label','查看'+t.title);});
  reconcile($('historyRows'),[...data.turns].reverse(),()=>{
    const tr=document.createElement('tr');tr.tabIndex=0;tr.setAttribute('role','button');
    tr.innerHTML='<td><span class="history-label"></span><span class="history-status"></span></td><td class="mono"></td><td class="mono"></td>';
    tr.onclick=()=>selectTurn(tr.dataset.id);
    tr.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();selectTurn(tr.dataset.id);}};
    return tr;
  },(tr,turn)=>{
    tr.setAttribute('aria-label','查看'+turn.title+'的输入、缓存和输出');
    tr.querySelector('.history-label').textContent=turn.title;
    tr.querySelector('.history-status').textContent=statusText(turn);
    tr.children[1].textContent=num(turn.totalTokens);tr.children[2].textContent=amountText(turn);
  });
}
function render() {
  if (!data) return;
  if (data.usageStatus==='waiting' || !data.turns.length) {showWaiting(data.title);return;}
  const t=current();
  $('title').textContent=data.title;
  $('count').textContent=data.turns.length+' 轮';
  $('connection').textContent='更新于 '+new Date(data.observedAt).toLocaleTimeString('zh-CN',{hour12:false})+'';
  const warnings=[...new Set([...(data.warnings||[]),...(t?.warnings||[])])];
  $('warnings').textContent=warnings.map(reason=>usageReasons[reason]||pricingReason(reason)).join('\n');
  $('warningDetails').hidden=!warnings.length;
  const agents=data.subagents?.thread_count||0;
  $('agentStatus').textContent=(agents?'含 '+agents+' 个子代理'+(data.subagents.unattributed_tokens?' · '+num(data.subagents.unattributed_tokens)+' tokens 仅归入对话累计':''):'')+(data.scanPending?' · 用量仍在读取，当前显示已读部分':'');
  renderOverview();
  if (!t) { $('amount').textContent='—'; notice('尚无用量记录，面板会自动更新。'); return; }
  renderTurnNavigation(t);
  const state=costState(t), total=sum(t.usd), hit=(t.cacheRead||0)/((t.input||0)+(t.cached||0)||1)*100;
  $('scope').textContent=(scope==='total'?'对话累计':followLatest?'本轮':t.title)+' · API 等价'+(state==='unpriced'?' · 未计价':state==='partial'?' · 已计价部分':'');
  $('amount').classList.toggle('unpriced',state==='unpriced');
  $('amount').innerHTML=t.pending?'—':state==='unpriced'?'未计价':'<small>'+(t.costComplete?'$':'≥ $')+'</small>'+Number(t.costComplete?t.amount:total).toFixed(4);
  $('tokens').textContent=num(t.totalTokens)+' tokens'+(scope==='total'?'':' · '+statusText(t));
  $('model').textContent=[t.model,t.serviceTiers?.map(serviceTierLabel).join(' / ')].filter(Boolean).join(' · ');
  $('costBar').innerHTML=t.usd.map(v=>'<i style="flex:'+v/(total||1)+'"></i>').join('');
  $('breakdown').innerHTML=['未缓存输入','缓存'+(hit?' · '+hit.toFixed(1)+'% 命中':''),'输出'].map((label,i)=>'<div class="part"><i class="dot" style="background:'+['var(--input)','var(--cache)','var(--output)'][i]+'"></i><div><p>'+label+'</p><small class="mono">'+num([t.input,t.cached,t.output][i])+' tokens'+(i===1&&t.cacheWrite?' · 写入 '+num(t.cacheWrite):i===2&&t.reasoning?' · 含推理 '+num(t.reasoning):'')+'</small></div><span class="money mono">'+(state==='unpriced'?'未计价':(t.costComplete?'':'≥ ')+money(t.usd[i]))+'</span></div>').join('');
  reconcile($('turnList'),[...data.turns].reverse(),()=>{
    const b=document.createElement('button');b.className='turn';
    b.innerHTML='<span class="label"></span><span class="num"></span><span class="cost mono"></span>';
    b.onclick=()=>selectTurn(b.dataset.id);return b;
  },(b,turn)=>{
    b.setAttribute('aria-pressed',String(scope==='turn'&&turn.id===t.id));
    b.querySelector('.label').textContent=turn.title;
    b.querySelector('.num').textContent=statusText(turn);
    b.querySelector('.cost').textContent=amountText(turn);
  });
}
function receive(result) {
  accountPanel.receive(result);
  if (result?.structuredContent?.panelReady) {
    contextRevision++;boundThread=result._meta?.threadContext?.threadId ?? result.structuredContent.threadId ?? undefined;
    data=null;selectedId=null;followLatest=true;accountPanel.threadChanged();showWaiting();
    if(connected)void refresh();
    return;
  }
  if (result?._meta?.needsThread) {
    data=null; selectedId=null; accountPanel.threadChanged();
    showWaiting();
    return;
  }
  const next=result?._meta?.usage;
  if(!next?.live || !Array.isArray(next.turns))return;
  const threadChanged=!data||next.threadId!==data.threadId;
  if(threadChanged)followLatest=true;
  data=next;
  if(threadChanged)accountPanel.threadChanged();$('explain').disabled=!data.turns.length;if(followLatest)selectedId=data.currentTurnId;
  render();
}
function setTab(next,reset=true) {
  roundPicker.close();scope=next;const conversation=['turn','total','overview'].includes(next);$('conversationNav').hidden=!conversation;$('threadHeading').hidden=!conversation;
  $('conversationTab').setAttribute('aria-selected',String(conversation));$('conversationTab').tabIndex=conversation?0:-1;
  if(next==='turn'&&reset){followLatest=true;selectedId=data?.currentTurnId;}
  ['turn','total','overview','account','budget'].forEach(s=>{const tab=$(s+'Tab');tab.setAttribute('aria-selected',String(s===next));tab.tabIndex=s===next?0:-1;});
  $('meterView').setAttribute('aria-labelledby',next==='total'?'totalTab':'turnTab');
  $('meterView').hidden=!['turn','total'].includes(next);$('overviewView').hidden=next!=='overview';
  $('accountView').hidden=next!=='account';$('budgetView').hidden=next!=='budget';
  if(connected)accountPanel.activate(next);render();
}
async function refresh() {
  clearTimeout(timer);
  if(!connected||loading)return;
  if(document.hidden){timer=setTimeout(refresh,5000);return;}
  if(scope==='account'||scope==='budget'){accountPanel.tick();timer=setTimeout(refresh,5000);return;}
  loading=true;$('refresh').disabled=true;accountPanel.tick();
  const revision=contextRevision,threadId=explicitThread || boundThread;
  try { const result=await app.callServerTool({name:'get_usage',arguments:threadId?{thread_id:threadId}:{}});if(revision===contextRevision){receive(result);if(data?.turns.length)notice('');} }
  catch { notice('暂未读到新记录，将自动重试。'); }
  finally { loading=false;$('refresh').disabled=false;timer=setTimeout(refresh,2000); }
}
app.ontoolinput=({arguments: args})=>{contextRevision++;explicitThread=args?.thread_id;boundThread=undefined;data=null;selectedId=null;followLatest=true;accountPanel.threadChanged();showWaiting();};
app.ontoolresult=receive;
app.onhostcontextchanged=context=>{full=context.displayMode==='fullscreen';};
app.onerror=()=>notice('客户端连接暂不可用，请关闭后重新打开面板。');
function bindTabs(tabs){tabs.forEach((s,index)=>{const tab=$(s+'Tab');tab.onclick=()=>setTab(s==='conversation'?'turn':s);tab.tabIndex=index===0?0:-1;tab.onkeydown=event=>{let next;if(event.key==='ArrowRight')next=(index+1)%tabs.length;else if(event.key==='ArrowLeft')next=(index+tabs.length-1)%tabs.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=tabs.length-1;else return;event.preventDefault();setTab(tabs[next]==='conversation'?'turn':tabs[next]);$(tabs[next]+'Tab').focus();};});}
bindTabs(['conversation','account','budget']);bindTabs(['turn','total','overview']);
$('refresh').onclick=()=>{void accountPanel.refresh();void refresh();};
$('prevTurn').onclick=()=>{const i=data?.turns.findIndex(t=>t.id===selectedId);if(i>0)selectTurn(data.turns[i-1].id);};
$('nextTurn').onclick=()=>{const i=data?.turns.findIndex(t=>t.id===selectedId);if(i>=0&&i<data.turns.length-1)selectTurn(data.turns[i+1].id);};
$('latestTurn').onclick=()=>setTab('turn');
$('explain').onclick=async()=>{
  const t=current();if(!connected||!t)return;
  try { await app.sendMessage({role:'user',content:[{type:'text',text:'请简短解释 Gauge 所选对话「'+data.title+'」'+t.title+'的实际已记录用量：'+JSON.stringify({input:t.input,cacheRead:t.cacheRead,cacheWrite:t.cacheWrite,output:t.output,reasoningIncluded:t.reasoning,usdParts:t.usd,costComplete:t.costComplete,model:t.model,serviceTiers:t.serviceTiers,observedAt:data.observedAt})+'。金额以 API 等价费用显示。'}]});notice('已发送到当前聊天。'); }
  catch { notice('当前入口暂不支持发消息，统计仍正常更新。'); }
};
$('expand').onclick=async()=>{if(!connected)return;try{const r=await app.requestDisplayMode({mode:full?'inline':'fullscreen'});full=r.mode==='fullscreen';}catch{notice('当前入口不支持切换显示模式。');}};
window.addEventListener('pagehide',()=>clearTimeout(timer));
document.addEventListener('visibilitychange',()=>{if(!document.hidden){void refresh();void checkUpdate();}});
if(window.parent===window){$('connection').textContent='请从客户端 Gauge 插件入口打开';$('explain').disabled=true;$('refresh').disabled=true;$('expand').disabled=true;['accountRefresh','accountExport','budgetRefresh','budgetEnabled','applyAccountRange'].forEach(id=>$(id).disabled=true);}
else app.connect().then(()=>{connected=true;accountPanel.start();accountPanel.activate(scope);void refresh();void checkUpdate();}).catch(()=>{$('connection').textContent='客户端连接失败，请重新打开插件';});
