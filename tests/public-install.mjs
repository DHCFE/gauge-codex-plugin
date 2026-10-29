// Anonymous public download and the complete agent installer in an empty profile.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const version=JSON.parse(readFileSync('package.json')).version;
const base=mkdtempSync(join(tmpdir(),'gauge-public-'));
const home=join(base,'New user with spaces');mkdirSync(home);
const cli='/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
const env={HOME:home,CODEX_HOME:join(home,'.codex'),PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8',TOKENLENS_CODEX:cli,
  ...(process.env.HTTPS_PROXY?{HTTPS_PROXY:process.env.HTTPS_PROXY,HTTP_PROXY:process.env.HTTP_PROXY}:{} )};
const run=(cmd,args,options={})=>execFileSync(cmd,args,{env,encoding:'utf8',timeout:300_000,...options});
let client;
try {
  const script=join(base,'install.sh');
  run('/usr/bin/curl',['--fail','--silent','--show-error','--location','--proto','=https','--proto-redir','=https','--max-time','30','--output',script,'https://raw.githubusercontent.com/DHCFE/gauge-codex-plugin/main/install.sh']);
  assert.equal(readFileSync(script,'utf8'),readFileSync('packaging/install.sh','utf8'),'public script matches reviewed installer');
  console.log('Downloaded anonymous public installer; starting clean-profile installation.');
  const installEnv={...env};delete installEnv.HTTPS_PROXY;delete installEnv.HTTP_PROXY;
  const output=run('/bin/bash',[script],{env:installEnv});
  assert.match(output,/已安装\/更新/);
  const list=JSON.parse(run(cli,['plugin','list','--marketplace','tokenlens-local','--json']));
  assert.equal(list.installed.length,1);assert.equal(list.installed[0].version,version);assert.equal(list.installed[0].enabled,true);
  const installed=join(env.CODEX_HOME,`plugins/cache/tokenlens-local/tokenlens-prototype/${version}`);
  const digest=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
  assert.equal(digest(join(installed,'server.mjs')),digest('plugin/server.mjs'));
  client=new Client({name:'gauge-public-install-test',version:'1'});
  await client.connect(new StdioClientTransport({command:'/bin/sh',args:['./bin/launch.sh'],cwd:installed,env:installEnv}));
  const panel=await client.callTool({name:'open_tokenlens',arguments:{}});
  assert.equal(panel.structuredContent.panelReady,true);
  const status=(await client.callTool({name:'get_update_status',arguments:{}})).structuredContent.updateStatus;
  assert.equal(status.status,'current');assert.equal(status.latestVersion,version);
  const report={version,anonymousDownload:'passed',freshAgentInstall:'passed',enabled:true,bundledMcpPanel:'passed',publicVersionCheck:status.status,macosProxyWithoutEnvironmentOverride:'passed'};
  writeFileSync(resolve('output/public-install-verification.json'),JSON.stringify(report,null,2)+'\n');
  console.log('PASS: '+JSON.stringify(report));
} finally {if(client)await client.close();rmSync(base,{recursive:true,force:true});}
