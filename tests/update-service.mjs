import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {compareVersions,createUpdateService} from '../src/update-service.mjs';
const manifest = {product:'Gauge',platform:'darwin-arm64',version:'0.5.6',asset:'Gauge-mac-arm64.zip',sha256:'a'.repeat(64)};
function options(t,extra={}) {
  const dataDir=mkdtempSync(join(tmpdir(),'gauge-update-'));
  t.after(()=>rmSync(dataDir,{recursive:true,force:true}));
  return {repository:'DHCFE/gauge-codex-plugin',currentVersion:'0.5.5',dataDir,...extra};
}
test('stable versions compare numerically and reject malformed versions',()=>{
  assert.equal(compareVersions('0.10.0','0.9.9'),1);
  assert.equal(compareVersions('0.5.5','0.5.5'),0);
  assert.equal(compareVersions('1.0.0','2.0.0'),-1);
  for(const version of ['v0.5.5','0.5.6-beta','../x','0.5','9999999.0.0'])assert.throws(()=>compareVersions(version,'0.5.5'));
});
test('coalesces calls, persists bounded public metadata and caches across processes',async t=>{
  let calls=0,clock=1_000_000;
  const opts=options(t,{now:()=>clock,fetchImpl:async(url,request)=>{
    calls++;assert.equal(url,'https://github.com/DHCFE/gauge-codex-plugin/releases/latest/download/version.json');
    assert.deepEqual(request.headers,{Accept:'application/json'});
    await new Promise(resolve=>setTimeout(resolve,10));
    return Response.json({...manifest,installUrl:'https://untrusted.example',private:'discard'});
  }});
  const service=createUpdateService(opts);
  const statuses=await Promise.all([service.check(),service.check(),service.check()]);
  assert.equal(calls,1);
  assert.ok(statuses.every(s=>s.status==='available'));
  assert.equal(statuses[0].installUrl,'https://raw.githubusercontent.com/DHCFE/gauge-codex-plugin/main/INSTALL.md');
  assert.ok(!readFileSync(join(opts.dataDir,'release-status.json'),'utf8').includes('discard'));
  await createUpdateService(opts).check();assert.equal(calls,1);
  clock+=6*60*60_000+1;
  await service.check();assert.equal(calls,2);
  assert.equal((await createUpdateService({...opts,currentVersion:'0.5.6'}).check()).status,'current');
  const upgraded=createUpdateService({...opts,currentVersion:'0.5.7',fetchImpl:async()=>{calls++;return Response.json({...manifest,version:'0.5.7'});}});
  assert.equal((await upgraded.check()).latestVersion,'0.5.7','an installed version newer than the cached feed refreshes immediately');
  assert.equal(calls,3);
});
test('failed refresh keeps last valid status and backs off',async t=>{
  let clock=1_000_000,calls=0;
  const opts=options(t,{now:()=>clock,fetchImpl:async()=>{calls++;if(calls===1)return Response.json(manifest);throw Error('Offline');}});
  const service=createUpdateService(opts);
  await service.check();clock+=6*60*60_000+1;
  assert.equal((await service.check()).stale,true);
  await service.check();assert.equal(calls,2);
  clock+=15*60_000+1;await service.check();assert.equal(calls,3);
});
test('rejects wrong products, platforms, invalid digests and oversized manifests',async t=>{
  for(const body of [{...manifest,product:'Other'},{...manifest,platform:'windows'},{...manifest,sha256:'no'},{...manifest,version:'0.5.6-beta'},'x'.repeat(8193)]) {
    const service=createUpdateService(options(t,{fetchImpl:async()=>typeof body==='string'?new Response(body):Response.json(body)}));
    assert.equal((await service.check()).status,'unavailable');
  }
});
test('timeout and invalid repository fail quietly without account reads',async t=>{
  const service=createUpdateService(options(t,{timeoutMs:10,fetchImpl:(_url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('Aborted'))))}));
  assert.equal((await service.check()).status,'unavailable');
  const unconfigured=createUpdateService(options(t,{repository:'../wrong',fetchImpl:()=>{throw Error('must not call');}}));
  assert.equal((await unconfigured.check()).status,'unconfigured');
});
test('manual check bypasses fresh cache and failure backoff; install uses freshly verified version',async t=>{
  let calls=0,offline=false;
  const service=createUpdateService(options(t,{fetchImpl:async()=>{calls++;if(offline)throw Error('Offline');return Response.json({...manifest,version:calls===1?'0.5.6':'0.5.7'});}}));
  assert.equal((await service.check()).latestVersion,'0.5.6');
  assert.equal((await service.check({force:true})).latestVersion,'0.5.7');
  assert.equal((await service.release('0.5.7')).version,'0.5.7');
  await assert.rejects(service.release('0.5.6'),/版本信息/);
  offline=true;
  await assert.rejects(service.release('0.5.7'),/版本信息/);
  const before=calls;await service.check({force:true});assert.equal(calls,before+1);
});
