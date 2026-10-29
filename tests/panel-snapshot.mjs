import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPanelSnapshot } from '../src/panel-snapshot.mjs';
import { createIntegration } from '../src/integration-adapter.mjs';

test('shared snapshots merge pages and independent writers; stale/failed reads do not overwrite', async () => {
  const root=mkdtempSync(join(tmpdir(),'tokenlens-snapshot-')),dataDir=join(root,'data');
  let clock=Date.parse('2026-10-02T08:00:00+08:00');
  const options={dataDir,codexHome:root,now:()=>clock};
  const first=createPanelSnapshot(options),second=createPanelSnapshot(options),token=first.token();
  const quota={status:'available',weekly:{usedPercent:42,period:{endAt:'2026-10-05T14:13:25Z'}},estimate:{capacityUsd:100},cycleUsage:{threads:['omit duplicate ledger']},costs:{updatedAt:new Date(clock).toISOString(),today:{apiEquivalentUsd:1},last30Days:{apiEquivalentUsd:3},currentWindow:{apiEquivalentUsd:2}}};
  try {
    assert.equal(first.read(),null);
    await Promise.all([first.save('accountUsage',{conversations:[{threadId:'one'}],nextOffset:1,threadCount:2},token,clock),second.save('quota',quota,token,clock)]);
    assert.equal(second.read().quota.weekly.usedPercent,42);
    assert.equal(second.read().accountUsage.conversations[0].threadId,'one');
    await second.save('accountUsage',{conversations:[{threadId:'two'}],nextOffset:null,threadCount:2},token,clock+1,1);
    assert.deepEqual(first.read().accountUsage.conversations.map(row=>row.threadId),['one','two']);
    await first.save('accountUsage',{conversations:[{threadId:'late'}]},token,clock-1);
    assert.equal(first.read().accountUsage.conversations.length,2);
    await first.save('quota',{status:'unavailable'},token,clock+1);
    assert.equal(second.read().quota.weekly.usedPercent,42);
    assert.equal(second.read().quota.cycleUsage,undefined);
    const file=join(dataDir,'panel-snapshot-v1.json');assert.equal(statSync(file).mode&0o777,0o600);
    clock+=86400000;
    assert.equal(second.read().quota.costs.today,null,'previous day is not Today');
    assert.equal(second.read().quota.costs.last30Days,null,'rolling period not relabelled');
    clock=Date.parse('2026-10-06T08:00:00+08:00');
    assert.equal(second.read().quota.weekly,null,'expired weekly percentage cleared');
    assert.equal(second.read().quota.estimate,null,'expired capacity cleared');
    clock+=7*86400000;assert.equal(second.read(),null);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('in-memory official quota cache invalidates when login identity changes', async () => {
  const root=mkdtempSync(join(tmpdir(),'tokenlens-quota-identity-'));
  let identity='a',reads=0;
  const integration=createIntegration({dataDir:root,quotaIdentity:()=>identity,
    readQuota:async()=>{reads++;return {status:'unavailable',account:{accountId:identity},qualityReasons:[],pools:[]};},
    readAccount:async()=>({total:{requestCount:0,unpricedRequests:0,knownUsd:0,costParts:{}},threads:[],coverage:{}}),
    estimateCapacity:()=>({})});
  try {
    assert.equal((await integration.quota()).accountId,'a');
    await integration.quota();assert.equal(reads,1);
    identity='b';assert.equal((await integration.quota()).accountId,'b');assert.equal(reads,2);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('identity changes, corrupt files and unwritable caches fail safely', async () => {
  const root=mkdtempSync(join(tmpdir(),'tokenlens-snapshot-auth-')),dataDir=join(root,'data');
  const auth=join(root,'auth.json');
  const login=id=>writeFileSync(auth,JSON.stringify({auth_mode:'chatgpt',tokens:{account_id:id,access_token:'secret-'+id}}));
  try {
    login('account-a');const store=createPanelSnapshot({dataDir,codexHome:root}),token=store.token();
    await store.save('accountUsage',{conversations:[]},token);
    assert(!readFileSync(join(dataDir,'panel-snapshot-v1.json'),'utf8').includes('secret-account'));
    login('account-b');assert.equal(store.read(),null);
    await store.save('quota',{status:'available'},token);assert.equal(store.read(),null,'late old-account writer rejected');
    writeFileSync(join(dataDir,'panel-snapshot-v1.json'),'{broken');assert.equal(store.read(),null);
    const blocked=join(root,'file');writeFileSync(blocked,'not a directory');
    await createPanelSnapshot({dataDir:blocked,codexHome:root}).save('accountUsage',{conversations:[]},store.token());
    writeFileSync(auth,'{broken');assert.equal(store.token(),null);
  } finally {rmSync(root,{recursive:true,force:true});}
});
