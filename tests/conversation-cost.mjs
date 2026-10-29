import {test} from 'node:test';
import assert from 'node:assert/strict';
import {conversationAmount,costState,pricingReason} from '../web/conversation-cost.js';
const money=n=>'$'+n.toFixed(4);
test('unknown cost is distinct from confirmed zero and partial subtotal',()=>{
  assert.equal(conversationAmount({costComplete:false,usd:[0,0,0],totalTokens:5320698},money),'未计价');
  assert.equal(conversationAmount({costComplete:true,amount:0,usd:[0,0,0]},money),'$0.0000');
  assert.equal(conversationAmount({costComplete:false,usd:[0,.2,0]},money),'≥ $0.2000');
  assert.equal(costState({pending:true,usd:[0,0,0]}),'pending');
  assert.equal(pricingReason('Unknown model: gpt-new'),'缺少模型价格：gpt-new');
});
