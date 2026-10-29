export const costState = turn => {
  if (!turn || turn.pending) return 'pending';
  if (turn.costComplete) return 'complete';
  return (turn.usd || []).some(value=>Number(value)>0) ? 'partial' : 'unpriced';
};
export const conversationAmount = (turn, money) => {
  const state = costState(turn);
  return state==='pending' ? '等待记录' : state==='unpriced' ? '未计价' : state==='complete' ? money(turn.amount) : '≥ '+money(turn.usd.reduce((a,b)=>a+b,0));
};
export const pricingReason = reason => reason.startsWith('Unknown model: ') ? '缺少模型价格：'+reason.slice(15) : reason;
