// UI boundary: unknown is null; never derive weekly capacity from historical totals.
export const finite = value => value !== null && value !== undefined && value !== '' && typeof value !== 'boolean' && Number.isFinite(Number(value)) ? Number(value) : null;
export const formatNumber = value => finite(value) === null ? '—' : Number(value).toLocaleString('en-US');
export const formatMoney = value => finite(value) === null ? '—' : '$' + Number(value).toLocaleString('en-US', {minimumFractionDigits: 4, maximumFractionDigits: 4});
export const formatDate = value => {
  if (!value) return '时间未知';
  const date = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', {hour12:false});
};
export const list = value => Array.isArray(value) ? value : [];
export function payload(result, key) {
  if (result?._meta?.needsThread || result?.structuredContent?.needsThread) throw new Error('缺少明确对话标识');
  if (result?.isError) throw new Error(result.content?.find(x => x.type === 'text')?.text || '工具暂不可用');
  const body = result?.structuredContent;
  if (body) return body[key] ?? body;
  if (result?._meta?.[key]) return result._meta[key];
  const text = result?.content?.find(x => x.type === 'text')?.text;
  if (text) { try { const parsed=JSON.parse(text); return parsed[key] ?? parsed; } catch {} }
  throw new Error('暂未获得可读取的数据');
}
export function normalizeCost(value) {
  const total=value?.total && typeof value.total==='object'?value.total:value;
  const cost=value?.cost ?? total?.cost ?? total?.pricing ?? {};
  const complete=value?.costComplete===true || total?.costComplete===true || cost.complete===true;
  // Adapter totals and known subtotals remain observable even when identity/coverage is incomplete.
  const amount=finite(value?.amountUsd ?? value?.apiEquivalentUsd ?? total?.amountUsd ?? total?.apiEquivalentUsd ?? total?.amount ?? total?.observedUsd ?? total?.knownUsd ?? value?.knownUsd ?? cost.amountUsd ?? cost.totalUsd ?? cost.knownUsd);
  const unobserved=!complete && (value?.usageStatus==='unavailable' || total?.requestCount===0 || total?.requestCount>0 && total?.unpricedRequests>=total?.requestCount);
  return {amount:unobserved && !(amount>0)?null:amount,complete,status:value?.pricingStatus??total?.pricingStatus??cost.status??'unknown'};
}
export function normalizeTokens(value) {
  const total=value?.total && typeof value.total==='object'?value.total:value;
  const tokens=value?.tokens ?? total?.tokens ?? total ?? {};
  const known=value?.knownTokens ?? total?.knownTokens ?? {};
  const empty=(value?.usageStatus==='unavailable'||total?.requestCount===0)&&total?.costComplete!==true;
  let partial=false;
  function token(names) {
    for(const name of names){const measured=finite(tokens[name]);if(measured!==null&&(!empty||measured>0))return measured;}
    for(const name of names){const measured=finite(known[name]);if(measured!==null&&measured>0){partial=true;return measured;}}
    return null;
  }
  const result={input:token(['uncachedInput','inputUncached','input']),cacheRead:token(['cacheRead','cached']),cacheWrite:token(['cacheWrite']),output:token(['output']),reasoning:token(['reasoning']),total:token(['total','totalTokens'])};
  return {...result,partial};
}
export function uniqueDiagnostics(...groups) {
  const entries=groups.flatMap(list);
  return [...new Map(entries.map(entry=>{const code=typeof entry==='string'?entry:entry?.code??entry?.message;return [code,entry];}).filter(([code])=>code)).values()];
}
export const formatOverviewMoney=value=>finite(value)===null?'—':'$'+Number(value).toLocaleString('en-US',{minimumFractionDigits:Math.abs(Number(value))>=1?2:4,maximumFractionDigits:Math.abs(Number(value))>=1?2:4});
export function normalizeConversation(row, index=0) {
  const cost=normalizeCost(row);
  return {
    ...row, id: String(row.threadId ?? row.id ?? 'unidentified-'+index),
    title: row.title || row.displayTitle || row.threadId || row.id || '未命名对话',
    accountId: row.accountId ?? null, project: row.project ?? row.cwd ?? null,
    model: row.model ?? list(row.models).join(' / ') ?? null, modelNames: row.model?[row.model]:list(row.models),
    updatedAt: row.updatedAt ?? row.lastAt ?? row.lastEventAt ?? row.lastActivity ?? row.timestamp ?? null,
    archived: row.archived === true, parentThreadId: row.parentThreadId ?? null,
    ...cost, tokens: normalizeTokens(row)
  };
}
export function filterConversations(rows, {search='',model='',project='',status='',sort='recent'}={}) {
  const needle=search.trim().toLocaleLowerCase();
  const filtered=rows.filter(row => {
    const searchable=[row.title,row.id,row.project,row.model,row.accountId].filter(Boolean).join(' ').toLocaleLowerCase();
    return (!needle||searchable.includes(needle))&&(!model||row.model===model||list(row.modelNames).includes(model))&&(!project||row.project===project)&&
      (!status || status==='archived'&&row.archived || status==='agents'&&row.parentThreadId || status==='unknown'&&!row.accountId || status==='partial'&&!row.complete);
  });
  const time=row=>{const n=typeof row.updatedAt==='number'?row.updatedAt:Date.parse(row.updatedAt);return Number.isFinite(n)?n:0;};
  return filtered.sort((a,b)=> {
    if(sort==='title')return a.title.localeCompare(b.title,'zh-CN');
    if(sort==='cost')return (b.amount??-Infinity)-(a.amount??-Infinity)||a.id.localeCompare(b.id);
    if(sort==='tokens')return (b.tokens.total??-Infinity)-(a.tokens.total??-Infinity)||a.id.localeCompare(b.id);
    return time(b)-time(a)||a.id.localeCompare(b.id);
  });
}
export function budgetDeliveryLabel(budget) {
  if (!budget?.enabled) return '已关闭 · 不发送后续预算提示';
  const delivery=budget.delivery ?? {};
  const state=delivery.status ?? budget.deliveryStatus;
  if (state==='host-confirmed'&&delivery.hostVerified===true || (state==='delivered'||state==='acknowledged')&&delivery.hostVerified===true) return '已送达 · 提示不保证模型完全遵守';
  if (state==='emitted-unverified') return '摘要已输出 · 宿主未确认模型收到';
  if (state==='unsupported'||state==='unavailable') return '已保存 · 当前宿主尚无可用送达通道';
  if (state==='failed') return '已保存 · 送达失败，等待下次模型交互';
  return '已保存 · 等待下次模型交互送达';
}
export function costLabel(value) {
  const cost=normalizeCost(value);
  return cost.amount===null ? '未计价' : (cost.complete?'':'≥ ')+formatMoney(cost.amount);
}
