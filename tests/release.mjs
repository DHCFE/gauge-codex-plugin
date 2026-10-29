import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, readdirSync, rmSync, chmodSync, cpSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const version = JSON.parse(readFileSync('package.json')).version;
const archive = resolve(`dist/Gauge-${version}-mac-arm64.zip`);
const base = mkdtempSync(join(tmpdir(),'tokenlens-clean-'));
const home = join(base,'New user with spaces');
const codexHome = join(home,'.codex');
const cli = process.env.TOKENLENS_TEST_CODEX || '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
const env = {HOME:home,CODEX_HOME:codexHome,PATH:'/usr/bin:/bin',TOKENLENS_NO_PAUSE:'1',LANG:'en_US.UTF-8',TOKENLENS_CODEX:cli};
const run = (command,args,opts={}) => execFileSync(command,args,{env,encoding:'utf8',timeout:60000,...opts});
mkdirSync(home,{recursive:true});
const unpack=join(base,'unpacked');mkdirSync(unpack);
const stage=join(unpack,`Gauge-${version}-mac-arm64`);
const installed=join(codexHome,`plugins/cache/tokenlens-local/tokenlens-prototype/${version}`);
const target=join(home,'Library/Application Support/Gauge/marketplace');
const list=()=>JSON.parse(run(cli,['plugin','list','--marketplace','tokenlens-local','--json']));
const sourceRoot=()=>JSON.parse(run(cli,['plugin','marketplace','list','--json'])).marketplaces.find(row=>row.name==='tokenlens-local')?.root;
let client;
try {
  // Exercise the actual ZIP, not only the build staging directory.
  run('/usr/bin/unzip',['-q',archive,'-d',unpack]);
  run('/usr/bin/shasum',['-a','256','-c','PAYLOAD.sha256'],{cwd:stage});
  const installOutput=run('/bin/bash',[join(stage,'Install.command')]);
  assert.match(installOutput,/已安装\/更新/);
  assert.equal(list().installed.length,1);
  assert.equal(list().installed[0].version,version);
  assert.ok(existsSync(installed));
  const config=JSON.parse(readFileSync(join(installed,'.mcp.json'))).mcpServers.tokenlens;
  assert.equal(config.command,'/bin/sh');
  assert.deepEqual(config.args,['./bin/launch.sh']);
  assert.equal(config.cwd,'.');
  assert.equal(config.env,undefined);
  assert.ok(!JSON.stringify(config).includes('/Users/'));
  const launch=readFileSync(join(installed,'bin/launch.sh'),'utf8');
  assert.ok(!launch.includes('xattr') && !launch.includes('curl'));
  const sessionDir=join(codexHome,'sessions/2026/10/01');mkdirSync(sessionDir,{recursive:true});
  for (const [id,input] of [['chat-a',1000],['chat-b',5000]]) {
    const usage={input_tokens:input,cached_input_tokens:400,cache_write_input_tokens:0,output_tokens:100,reasoning_output_tokens:40,total_tokens:input+100};
    const rows=[{type:'session_meta',payload:{id,model_provider:'openai'}},
      {type:'event_msg',payload:{type:'task_started',turn_id:'turn'}},
      {type:'turn_context',payload:{turn_id:'turn',model:'gpt-6.1-sol'}},
      {type:'token_usage_record',payload:{thread_id:id,turn_id:'turn',response_id:'response-'+id,usage,turn_token_usage:usage,thread_token_usage:usage}}];
    writeFileSync(join(sessionDir,`rollout-test-${id}.jsonl`),rows.map(JSON.stringify).join('\n')+'\n');
  }
  async function verifyInstalled() {
    client = new Client({name:'tokenlens-clean-install',version:'1'});
    await client.connect(new StdioClientTransport({command:config.command,args:config.args,cwd:installed,env}));
    const catalog=await client.listTools();
    assert.deepEqual(catalog.tools[1]._meta.ui.visibility,['app']);
    assert.deepEqual(catalog.tools[0]._meta['openai/ui'].entrypoints,[{type:'global'},{type:'thread'}]);
    const a=await client.callTool({name:'open_tokenlens',arguments:{},_meta:{'openai/threadId':'chat-a'}});
    assert.equal(a.structuredContent.panelReady,true);
    assert.equal(a.structuredContent.threadId,'chat-a');
    const firstUsage=await client.callTool({name:'get_usage',arguments:{thread_id:'chat-a'}});
    assert.equal(firstUsage._meta.usage.threadId,'chat-a');assert.equal(firstUsage._meta.usage.total.totalTokens,1100);
    assert.deepEqual([firstUsage._meta.usage.total.input,firstUsage._meta.usage.total.cached,firstUsage._meta.usage.total.output],[600,400,100]);
    const global=await client.callTool({name:'open_tokenlens',arguments:{}});
    assert.equal(global.isError,undefined);assert.equal(global.structuredContent.panelReady,true);
    const newborn=await client.callTool({name:'open_tokenlens',arguments:{},_meta:{'openai/threadId':'new-chat'}});
    assert.equal(newborn.isError,undefined);assert.equal(newborn.structuredContent.panelReady,true);
    const pending=await client.callTool({name:'get_usage',arguments:{thread_id:'new-chat'}});
    assert.equal(pending.isError,undefined);assert.equal(pending._meta.usage.usageStatus,'waiting');
    assert.equal(pending._meta.usage.total.totalTokens,null);
    const b=await client.callTool({name:'get_usage',arguments:{},_meta:{'x-codex-turn-metadata':'{"thread_id":"chat-b"}'}});
    assert.equal(b._meta.usage.threadId,'chat-b');assert.equal(b._meta.usage.total.totalTokens,5100);
    const empty=await client.callTool({name:'get_usage',arguments:{}});
    assert.equal(empty._meta.needsThread,true);assert.equal(empty._meta.usage,undefined);
    const selected=await client.callTool({name:'get_usage',arguments:{thread_id:'chat-a'},_meta:{'openai/threadId':'chat-b'}});
    assert.equal(selected._meta.usage.threadId,'chat-a');
    const account=await client.callTool({name:'get_account_usage',arguments:{}});
    assert.ok(account.structuredContent,JSON.stringify(account));
    assert.equal(account.structuredContent.accountUsage.threadCount,2,'frozen account scanner is included');
    // Exercise the packaged frozen parser against the production failure, with
    // no system Python/Node: a huge child message followed by its own request.
    const childPath=join(sessionDir,'rollout-test-child.jsonl');
    const childUsage={input_tokens:1000,cached_input_tokens:400,cache_write_input_tokens:0,output_tokens:100,reasoning_output_tokens:40,total_tokens:1100};
    const childRows=[{type:'session_meta',payload:{id:'child',session_id:'execution-child',model_provider:'openai',source:{subagent:{thread_spawn:{parent_thread_id:'chat-a'}}}}},
      {type:'turn_context',payload:{turn_id:'child-turn',root_turn_id:'turn',model:'gpt-6.1-sol'}},
      {type:'response_item',payload:{content:'x'.repeat(4*1024*1024+100)}},
      {type:'token_usage_record',payload:{thread_id:'child',session_id:'execution-child',turn_id:'child-turn',root_turn_id:'turn',response_id:'child-response',usage:childUsage,turn_token_usage:childUsage,thread_token_usage:childUsage}}];
    writeFileSync(childPath,childRows.map(JSON.stringify).join('\n')+'\n');
    const withChild=(await client.callTool({name:'get_usage',arguments:{thread_id:'chat-a'}}))._meta.usage;
    assert.equal(withChild.total.totalTokens,2200,'frozen parser must read usage after an oversized child record');
    assert.equal(withChild.turns[0].totalTokens,2200);
    assert.equal(withChild.total.costComplete,true);assert.equal(withChild.scanPending,false);
    rmSync(childPath);
    assert.deepEqual((await client.callTool({name:'get_budget_context',arguments:{thread_id:'chat-a'}})).content,[]);
    const enabled=await client.callTool({name:'set_conversation_budget',arguments:{thread_id:'chat-a',enabled:true,amount_usd:1}});
    assert.equal(enabled.structuredContent.budget.enabled,true);
    const emitted=run('/bin/sh',['./bin/launch.sh','--budget-hook'],{cwd:installed,input:JSON.stringify({hook_event_name:'SessionStart',session_id:'chat-a',source:'resume'})});
    assert.ok(JSON.parse(emitted).hookSpecificOutput.additionalContext.includes('软预算'));
    const delivered=await client.callTool({name:'get_conversation_budget',arguments:{thread_id:'chat-a'}});
    assert.equal(delivered.structuredContent.budget.delivery.hostVerified,false);
    assert.equal(delivered.structuredContent.budget.delivery.status,'emitted-unverified');
    await client.callTool({name:'set_conversation_budget',arguments:{thread_id:'chat-a',enabled:false}});
    assert.equal(run('/bin/sh',['./bin/launch.sh','--budget-hook'],{cwd:installed,input:JSON.stringify({hook_event_name:'SessionStart',session_id:'chat-a'})}), '');
    const hooks=JSON.parse(readFileSync(join(installed,'hooks/hooks.json'))).hooks;
    assert.ok(hooks.SessionStart && hooks.UserPromptSubmit && hooks.SubagentStart);
    assert.ok(!hooks.Stop && !hooks.SubagentStop);
    const resource=await client.readResource({uri:catalog.tools[0]._meta.ui.resourceUri});
    assert.equal(resource.contents[0].mimeType,'text/html;profile=mcp-app');
    assert.deepEqual(resource.contents[0]._meta.ui.csp,{connectDomains:[],resourceDomains:[]});
    await client.close();client=null;
  }
  await verifyInstalled();
  const runtimeDir=join(codexHome,'plugins/data/tokenlens-local/tokenlens-prototype/runtime');
  const node=join(runtimeDir,readdirSync(runtimeDir).find(n=>n.startsWith('node-')));
  assert.ok(existsSync(node));
  writeFileSync(node,'damaged cache');
  await verifyInstalled(); // Repairs from bundled bytes, with no network or system Node.
  const expected=readFileSync(join(installed,'runtime/darwin-arm64/node.sha256'),'utf8').trim();
  assert.equal(run('/usr/bin/shasum',['-a','256',node]).split(' ')[0],expected);
  console.log('PASS: ZIP install with desktop native CLI, isolated HOME, system-only PATH, bundled Node/Python, context isolation and cache repair');

  // Reproduce the actual developer-to-download installation path. A failed
  // source switch must restore the previous source, payload and installed copy.
  const previousSource=join(base,'Previous TokenLens local source');mkdirSync(previousSource);
  cpSync(join(stage,'plugin'),join(previousSource,'plugin'),{recursive:true});
  mkdirSync(join(previousSource,'.agents/plugins'),{recursive:true});
  const previousCatalog=join(previousSource,'.agents/plugins/marketplace.json');
  cpSync(join(stage,'.agents/plugins/marketplace.json'),previousCatalog);
  const previousManifest=join(previousSource,'plugin/.codex-plugin/plugin.json');
  const previous=JSON.parse(readFileSync(previousManifest));previous.version='0.2.1';writeFileSync(previousManifest,JSON.stringify(previous));
  run(cli,['plugin','marketplace','remove','tokenlens-local']);
  run(cli,['plugin','marketplace','add',previousSource]);
  run(cli,['plugin','add','tokenlens-prototype@tokenlens-local']);
  const sourceFailCli=join(base,'fail-source-registration');
  const shellQuote=value=>"'"+value.replaceAll("'","'\\''")+"'";
  writeFileSync(sourceFailCli,'#!/bin/sh\nif [ "$1" = plugin ] && [ "${2:-}" = marketplace ] && [ "${3:-}" = add ] && [ "${4:-}" = '+shellQuote(target)+' ]; then exit 99; fi\nexec '+shellQuote(cli)+' "$@"\n');chmodSync(sourceFailCli,0o755);
  let migrationRefused=false;
  try {run('/bin/bash',[join(stage,'Install.command')],{env:{...env,TOKENLENS_CODEX:sourceFailCli},stdio:'pipe'});} catch {migrationRefused=true;}
  assert.ok(migrationRefused);
  assert.equal(sourceRoot(),realpathSync(previousSource));
  assert.equal(list().installed[0].version,'0.2.1');
  assert.equal(readFileSync(join(target,'plugin/assets/tokenlens.html'),'utf8'),readFileSync(join(stage,'plugin/assets/tokenlens.html'),'utf8'));
  assert.ok(!existsSync(join(home,'Library/Application Support/Gauge/.previous')));
  assert.ok(!existsSync(join(home,'Library/Application Support/Gauge/.install-lock')));
  console.log('PASS: failed local source migration restores original marketplace, installed version and payload');

  // A same-named catalog that includes another plugin must not be replaced.
  const catalogBefore=readFileSync(previousCatalog,'utf8'),shared=JSON.parse(catalogBefore);
  const other=join(previousSource,'other/.codex-plugin');mkdirSync(other,{recursive:true});
  writeFileSync(join(other,'plugin.json'),JSON.stringify({name:'unrelated',version:'1.0.0',description:'Unrelated fixture plugin'}));
  shared.plugins.push({...shared.plugins[0],name:'unrelated',source:{source:'local',path:'./other'}});
  writeFileSync(previousCatalog,JSON.stringify(shared));
  let sharedRefused=false;
  try {run('/bin/bash',[join(stage,'Install.command')],{stdio:'pipe'});} catch {sharedRefused=true;}
  assert.ok(sharedRefused);
  assert.equal(sourceRoot(),realpathSync(previousSource));
  assert.equal(list().installed[0].version,'0.2.1');
  assert.ok(!existsSync(join(home,'Library/Application Support/Gauge/.install-lock')));
  writeFileSync(previousCatalog,catalogBefore);

  run('/bin/bash',[join(stage,'Install.command')]);
  assert.equal(sourceRoot(),realpathSync(target));
  assert.equal(list().installed.length,1);
  assert.equal(list().installed[0].version,version);
  assert.ok(existsSync(previousManifest),'source migration must not delete the original folder');
  assert.ok(existsSync(sessionDir));
  console.log('PASS: local source migration installs one Gauge plugin, preserves sessions and rejects shared catalogs');

  // Upgrade from an older installed version, then refresh the same version.
  const oldManifest=join(target,'plugin/.codex-plugin/plugin.json');
  const old=JSON.parse(readFileSync(oldManifest));old.version='0.2.1';writeFileSync(oldManifest,JSON.stringify(old));
  run(cli,['plugin','add','tokenlens-prototype@tokenlens-local']);
  assert.equal(list().installed[0].version,'0.2.1');
  run('/bin/bash',[join(stage,'Update.command')]);
  assert.equal(list().installed[0].version,version);
  writeFileSync(join(installed,'assets/tokenlens.html'),'stale installed UI');
  run('/bin/bash',[join(stage,'Install.command')]);
  assert.equal(readFileSync(join(installed,'assets/tokenlens.html'),'utf8'),readFileSync(join(stage,'plugin/assets/tokenlens.html'),'utf8'));
  assert.equal(list().installed.length,1);
  console.log('PASS: update from 0.2.1 and reinstall same version refresh the installed copy without duplicate plugins');

  // Corruption must fail before replacing the existing installed files.
  const payload=join(stage,'plugin/assets/tokenlens.html'), original=readFileSync(payload);
  writeFileSync(payload,'damaged downloaded UI');
  let refused=false;
  try {run('/bin/bash',[join(stage,'Update.command')],{stdio:'pipe'});} catch {refused=true;}
  finally {writeFileSync(payload,original);}
  assert.ok(refused);
  assert.equal(list().installed[0].version,version);
  assert.equal(readFileSync(join(installed,'assets/tokenlens.html'),'utf8'),original.toString());
  assert.ok(!existsSync(join(home,'Library/Application Support/Gauge/.install-lock')));
  console.log('PASS: damaged download rejected before replacement; installation lock cleared');

  // A registration failure after replacement restores the previous payload.
  const failedCli=join(base,'unavailable-codex');
  writeFileSync(failedCli,'#!/bin/sh\ncase "$*" in *--help*) exit 0;; *) exit 99;; esac\n');chmodSync(failedCli,0o755);
  const retained=join(target,'plugin/assets/icon.svg');
  const originalIcon=readFileSync(retained);writeFileSync(retained,'previous payload marker');
  let rolledBack=false;
  try {run('/bin/bash',[join(stage,'Update.command')],{env:{...env,TOKENLENS_CODEX:failedCli},stdio:'pipe'});} catch {rolledBack=true;}
  assert.ok(rolledBack);
  assert.equal(readFileSync(retained,'utf8'),'previous payload marker');
  assert.ok(!existsSync(join(home,'Library/Application Support/Gauge/.previous')));
  assert.ok(!existsSync(join(home,'Library/Application Support/Gauge/.install-lock')));
  writeFileSync(retained,originalIcon);
  console.log('PASS: failed registration restores the previous payload and clears temporary state');

  // No bundled library may still require Homebrew or the build machine's folders.
  function auditMach(dir) {
    for(const name of readdirSync(dir,{withFileTypes:true})) {
      const path=join(dir,name.name);
      if(name.isDirectory()) {auditMach(path);continue;}
      if(!name.isFile())continue;
      const kind=run('/usr/bin/file',['-b',path]);
      if(kind.includes('Mach-O')) {
        const dependencies=run('/usr/bin/otool',['-L',path]).split('\n').slice(1).join('\n');
        assert.ok(!/\/opt\/homebrew|\/usr\/local|\/Users\//.test(dependencies),dependencies);
      }
    }
  }
  auditMach(join(installed,'runtime'));
  run('/usr/bin/codesign',['--verify',join(installed,'runtime/darwin-arm64/usage-engine/tokenlens-usage')]);
  run('/bin/bash',[join(stage,'Uninstall.command')]);
  run('/bin/bash',[join(stage,'Uninstall.command')]);
  assert.equal(list().installed.length,0);
  assert.ok(!existsSync(target));
  assert.ok(existsSync(sessionDir));
  assert.ok(existsSync(join(codexHome,'plugins/data/tokenlens-local/tokenlens-prototype/agents.sqlite3')),'uninstall retains the shared conversation ledger');
  console.log('PASS: portable library paths and uninstall preserve session records and statistics');
} finally {
  if(client)await client.close();
  rmSync(base,{recursive:true,force:true});
}
