// Exercise the updater against the real release ZIP and CLI in an isolated profile.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createReleaseInstaller} from '../src/release-installer.mjs';
const version=JSON.parse(readFileSync('package.json')).version;
const cli=process.env.TOKENLENS_TEST_CODEX||'/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
const temp=mkdtempSync(join(tmpdir(),'gauge-real-update-'));
const home=join(temp,'User with spaces');mkdirSync(home);
const env={HOME:home,CODEX_HOME:join(home,'.codex'),TOKENLENS_CODEX:cli,TOKENLENS_NO_PAUSE:'1',PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8'};
try {
  // Install the previously published package first; never touch the real profile.
  const previous=process.env.TOKENLENS_PREVIOUS_ZIP||resolve('dist/Gauge-0.5.7-mac-arm64.zip');
  execFileSync('/usr/bin/unzip',['-q',previous,'-d',join(temp,'previous')]);
  execFileSync('/bin/bash',[join(temp,'previous/Gauge-0.5.7-mac-arm64/Install.command')],{env,stdio:'pipe'});
  const data=join(env.CODEX_HOME,'plugins/data/tokenlens-local/tokenlens-prototype');mkdirSync(data,{recursive:true});
  const budget=join(data,'budgets-v1.json'),ledger=join(data,'preservation-test.json');
  writeFileSync(budget,'{"sentinel":"existing budget"}');writeFileSync(ledger,'{"sentinel":"existing usage"}');
  const bytes=readFileSync(resolve(`dist/Gauge-${version}-mac-arm64.zip`));
  const manifest={product:'Gauge',version,platform:'darwin-arm64',asset:'Gauge-mac-arm64.zip',sha256:createHash('sha256').update(bytes).digest('hex')};
  const installer=createReleaseInstaller({repository:'DHCFE/gauge-codex-plugin',currentVersion:'0.5.7',env,updates:{release:async()=>manifest},fetchImpl:async()=>new Response(bytes)});
  assert.deepEqual(await installer.install(version),{status:'installed',version,restartRequired:true});
  assert.equal(readFileSync(budget,'utf8'),'{"sentinel":"existing budget"}');
  assert.equal(readFileSync(ledger,'utf8'),'{"sentinel":"existing usage"}');
  const installed=JSON.parse(execFileSync(cli,['plugin','list','--marketplace','tokenlens-local','--json'],{env,encoding:'utf8'})).installed;
  assert.equal(installed.length,1);assert.equal(installed[0].version,version);assert.equal(installed[0].enabled,true);
  console.log('PASS: actual 0.5.7 → '+version+' updater, release checksum, native CLI, single enabled plugin and unchanged budget/usage data in isolated profile');
} finally {rmSync(temp,{recursive:true,force:true});}
