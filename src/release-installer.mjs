import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareVersions } from './update-service.mjs';

const execute = promisify(execFile);
const fail = message => { throw new Error(message); };
export function createReleaseInstaller({ repository, currentVersion, updates, fetchImpl = fetch,
  run = (file,args,options={}) => execute(file,args,{env,timeout:180_000,maxBuffer:4*1024*1024,...options}),
  platform = process.platform, arch = process.arch, env = process.env } = {}) {
  let pending, state = {status:'idle'};
  async function install(version) {
    if (pending) return pending;
    if (platform !== 'darwin' || arch !== 'arm64') fail('一键更新目前支持 Apple Silicon Mac。');
    if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repository)) fail('更新来源无效。');
    if (compareVersions(version,currentVersion) <= 0) fail('请选择比当前版本更新的发行版。');
    pending = perform(version).finally(()=>{ pending = null; });
    return pending;
  }
  async function perform(version) {
    const candidates = [env.TOKENLENS_CODEX,
      ...['/Applications',join(env.HOME || '', 'Applications')].flatMap(root=>['Codex','ChatGPT'].map(app=>join(root,app+'.app/Contents/Resources/codex-cli/bin/codex')))];
    const cli = candidates.find(path=>path && existsSync(path));
    if (!cli) fail('未找到客户端内置安装程序，请更新 Codex 客户端后重试。');
    const list = async()=>JSON.parse((await run(cli,['plugin','marketplace','list','--json'])).stdout).marketplaces;
    const source = (await list()).find(row=>row.name==='tokenlens-local');
    if (!source?.root) fail('未找到现有 Gauge 来源，请通过安装说明修复。');
    const catalog = JSON.parse(readFileSync(join(source.root,'.agents/plugins/marketplace.json'),'utf8'));
    if (catalog.name !== 'tokenlens-local' || catalog.plugins?.length !== 1 || catalog.plugins[0].name !== 'tokenlens-prototype') fail('现有来源包含其他插件，无法自动更新。');
    const manifest = await updates.release(version);
    if (manifest.version !== version || manifest.product !== 'Gauge' || manifest.platform !== 'darwin-arm64'
      || manifest.asset !== 'Gauge-mac-arm64.zip' || !/^[a-f0-9]{64}$/.test(manifest.sha256)) fail('发行信息无效。');
    if (source.marketplaceSource?.sourceType === 'git') {
      const origin = (await run('/usr/bin/git',['-C',source.root,'remote','get-url','origin'])).stdout.trim().replace(/\.git$/,'');
      if (![ `https://github.com/${repository}`, `git@github.com:${repository}` ].includes(origin)) fail('Git 来源与官方 Gauge 仓库不符。');
      await run(cli,['plugin','marketplace','upgrade','tokenlens-local']);
      const refreshed = (await list()).find(row=>row.name==='tokenlens-local');
      const actual = JSON.parse(readFileSync(join(refreshed.root,'plugin/.codex-plugin/plugin.json'),'utf8'));
      if (actual.version !== version) fail('Git 来源可能固定在旧版本，请调整来源版本后重试。');
      await run(cli,['plugin','add','tokenlens-prototype@tokenlens-local']);
    } else if (source.marketplaceSource?.sourceType === 'local') {
      const temp = await mkdtemp(join(tmpdir(),'gauge-update-'));
      try {
        const archive = join(temp,'Gauge.zip');
        const controller = new AbortController(), timer = setTimeout(()=>controller.abort(),180_000);
        const digest = createHash('sha256');
        try {
          const response = await fetchImpl(`https://github.com/${repository}/releases/download/v${version}/${manifest.asset}`,{signal:controller.signal});
          if (!response.ok || !response.body) fail('新版下载失败，请重试。');
          const file = await open(archive,'wx',0o600);
          try {
            let size = 0;
            for await (const bytes of response.body) {
              size += bytes.byteLength;
              if (size > 200*1024*1024) { controller.abort(); fail('安装包超出大小限制。'); }
              digest.update(bytes);
              await file.writeFile(bytes);
            }
          } finally { await file.close(); }
        } finally { clearTimeout(timer); }
        if (digest.digest('hex') !== manifest.sha256) fail('下载校验失败，当前安装未改动，请重试。');
        const name = `Gauge-${version}-mac-arm64`;
        const entries = (await run('/usr/bin/unzip',['-Z1',archive])).stdout.trim().split('\n');
        if (!entries.length || entries.some(path=>!path.startsWith(name+'/') || path.includes('\\') || path.split('/').some(part=>part==='..' || part==='.'))) fail('安装包路径无效。');
        await run('/usr/bin/unzip',['-q',archive,'-d',join(temp,'unpacked')]);
        const payload = join(temp,'unpacked',name);
        const identity = JSON.parse(readFileSync(join(payload,'plugin/.codex-plugin/plugin.json'),'utf8'));
        if (identity.name !== 'tokenlens-prototype' || identity.interface?.displayName !== 'Gauge' || identity.version !== version) fail('安装包身份不匹配。');
        // The existing installer validates every payload file, locks installation,
        // and restores the previous local release if registration fails.
        await run('/bin/bash',[join(payload,'Update.command')],{env:{...env,TOKENLENS_CODEX:cli,TOKENLENS_NO_PAUSE:'1'}});
      } finally { await rm(temp,{recursive:true,force:true}); }
    } else fail('此安装来源暂不支持一键更新，请使用更新说明。');
    const installed = JSON.parse((await run(cli,['plugin','list','--marketplace','tokenlens-local','--json'])).stdout).installed;
    if (!installed?.some(row=>row.name==='tokenlens-prototype' && row.version===version && row.enabled===true)) fail('安装状态尚未确认，请重试或重新打开客户端检查。');
    return {status:'installed',version,restartRequired:true};
  }
  return {install, status:()=>({...state}), start(version) {
    if (state.status==='installing' || state.status==='installed' && state.version===version) return {...state};
    state = {status:'installing',version};
    void install(version).then(result=>{state=result;},()=>{state={status:'failed',version,message:'更新未完成，请检查网络和安装来源后重试。现有本地版本在安装失败时会恢复。'};});
    return {...state};
  }};
}
