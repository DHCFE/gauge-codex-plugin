import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReleaseInstaller} from '../src/release-installer.mjs';
function fixture(t,extra={}) {
  const temp=mkdtempSync(join(tmpdir(),'gauge-installer-test-'));t.after(()=>rmSync(temp,{recursive:true,force:true}));
  const source=join(temp,'market'),payload=join(temp,'Gauge-0.5.9-mac-arm64');
  mkdirSync(join(source,'.agents/plugins'),{recursive:true});
  writeFileSync(join(source,'.agents/plugins/marketplace.json'),JSON.stringify({name:'tokenlens-local',plugins:[{name:'tokenlens-prototype'}]}));
  mkdirSync(join(payload,'plugin/.codex-plugin'),{recursive:true});
  writeFileSync(join(payload,'plugin/.codex-plugin/plugin.json'),JSON.stringify({name:'tokenlens-prototype',version:'0.5.9',interface:{displayName:'Gauge'}}));
  writeFileSync(join(payload,'Update.command'),'#!/bin/bash\nexit 0\n');
  const zip=join(temp,'payload.zip');execFileSync('/usr/bin/zip',['-qr',zip,'Gauge-0.5.9-mac-arm64'],{cwd:temp});
  const bytes=readFileSync(zip),calls=[];
  const manifest={product:'Gauge',version:'0.5.9',platform:'darwin-arm64',asset:'Gauge-mac-arm64.zip',sha256:createHash('sha256').update(bytes).digest('hex')};
  const installer=createReleaseInstaller({repository:'DHCFE/gauge-codex-plugin',currentVersion:'0.5.8',platform:'darwin',arch:'arm64',env:{HOME:temp,TOKENLENS_CODEX:'/bin/true'},
    updates:{release:async()=>manifest},fetchImpl:async url=>{calls.push(['download',url]);return new Response(bytes);},
    run:async(file,args,opts)=>{calls.push([file,...args]);
      if(args[0]==='plugin'&&args[1]==='marketplace')return {stdout:JSON.stringify({marketplaces:[{name:'tokenlens-local',root:source,marketplaceSource:{sourceType:'local'}}]})};
      if(args[0]==='plugin'&&args[1]==='list')return {stdout:JSON.stringify({installed:[{name:'tokenlens-prototype',version:'0.5.9',enabled:true}]})};
      if(file==='/bin/bash')return {stdout:'installed'};
      if(file==='/usr/bin/unzip'&&args[0]==='-Z1'&&extra.archiveEntries)return {stdout:extra.archiveEntries};
      return {stdout:execFileSync(file,args,{...opts,encoding:'utf8'})};},...extra});
  return {installer,calls,manifest};
}
test('downloads immutable release, verifies and installs only after an explicit request',async t=>{
  const {installer,calls}=fixture(t);assert.equal(calls.length,0);
  assert.equal(installer.start('0.5.9').status,'installing');
  assert.equal(installer.start('0.5.9').status,'installing');
  await installer.install('0.5.9');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(installer.status().status,'installed');
  assert.equal(installer.status().restartRequired,true);
  assert.equal(calls.filter(call=>call[0]==='/bin/bash').length,1);
  assert.equal(calls.find(call=>call[0]==='download')[1],'https://github.com/DHCFE/gauge-codex-plugin/releases/download/v0.5.9/Gauge-mac-arm64.zip');
});
test('checksum failure leaves current installation untouched and is retryable',async t=>{
  const f=fixture(t);f.manifest.sha256='0'.repeat(64);
  await assert.rejects(f.installer.install('0.5.9'),/校验失败/);
  assert.ok(!f.calls.some(call=>call[0]==='/bin/bash'));
  await assert.rejects(f.installer.install('0.5.8'),/更新的发行版/);
});
test('unavailable and changed feed refuses installation before download',async t=>{
  const f=fixture(t,{updates:{release:async()=>{throw Error('版本信息已变化');}}});
  await assert.rejects(f.installer.install('0.5.9'),/版本信息/);
  assert.ok(!f.calls.some(call=>call[0]==='download'));
});
test('invalid archive paths cannot reach extraction or installer',async t=>{
  for(const entry of ['Gauge-0.5.9-mac-arm64/../../outside','another-root/file','Gauge-0.5.9-mac-arm64/dir/../file']) {
    const f=fixture(t,{archiveEntries:entry});
    await assert.rejects(f.installer.install('0.5.9'),/路径无效/);
    assert.ok(!f.calls.some(call=>call[0]==='/bin/bash'||call[1]==='-q'));
  }
});
