import {cpSync,copyFileSync,mkdirSync,rmSync,readFileSync,writeFileSync,readdirSync,lstatSync,realpathSync,chmodSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root=resolve(import.meta.dirname,'..');
const version=JSON.parse(readFileSync(join(root,'package.json'))).version;
const source=join(root,'dist',`Gauge-${version}-mac-arm64`);
const output=join(root,'.build/public-repository');
if(lstatSync(join(output,'.git'),{throwIfNoEntry:false})) {
  if(execFileSync('git',['status','--porcelain'],{cwd:output,encoding:'utf8'}).trim())throw Error('Public checkout has local changes; preserve them before preparing another release.');
} else {rmSync(output,{recursive:true,force:true});mkdirSync(output,{recursive:true});}
// Copy only reviewed release payload. Never publish the development workspace.
for(const file of ['plugin','.agents','packaging/manage.sh','Install.command','Update.command','Uninstall.command','THIRD-PARTY-NOTICES.md','THIRD-PARTY-NOTICES.txt']) {
  rmSync(join(output,file),{recursive:true,force:true});
  mkdirSync(resolve(output,file,'..'),{recursive:true});
  cpSync(join(source,file),join(output,file),{recursive:true,dereference:false,verbatimSymlinks:true});
}
for(const [src,dest] of [['packaging/PUBLIC-README.md','README.md'],['packaging/INSTALL.md','INSTALL.md'],['packaging/UPDATE.md','UPDATE.md'],['packaging/install.sh','install.sh']])copyFileSync(join(root,src),join(output,dest));
chmodSync(join(output,'install.sh'),0o755);
mkdirSync(join(output,'docs/images'),{recursive:true});
for(const file of ['round-usage.png','conversation-budget.png','budget-setup.png']) {
  copyFileSync(join(root,'docs/images',file),join(output,'docs/images',file));
}
// Publish maintainable sources and synthetic tests alongside the installable plugin.
for (const folder of ['src','web','packaging','tests','claude-mod']) {
  rmSync(join(output,folder),{recursive:true,force:true});
  cpSync(join(root,folder),join(output,folder),{recursive:true,filter:path=>!path.includes('__pycache__')&&!path.endsWith('.pyc')&&!/verify-|integration-actual/.test(path)});
}
chmodSync(join(output,'packaging/manage.sh'),0o755);
for(const file of ['package.json','package-lock.json','build.mjs','test.mjs','CHANGELOG.md','RELEASE-ACCEPTANCE.md','DISTRIBUTION.md'])copyFileSync(join(root,file),join(output,file));
mkdirSync(join(output,'.github/workflows'),{recursive:true});
copyFileSync(join(root,'packaging/ci.yml'),join(output,'.github/workflows/ci.yml'));
writeFileSync(join(output,'.gitignore'),'node_modules/\n.build/\ndist/\noutput/\n__pycache__/\n*.pyc\n.DS_Store\n');
function audit(dir) {
  for(const name of readdirSync(dir)) {
    if(dir===output&&name==='.git')continue;
    const path=join(dir,name),stat=lstatSync(path);
    if(stat.isDirectory()){audit(path);continue;}
    if(stat.isSymbolicLink()){if(!realpathSync(path).startsWith(output+'/'))throw Error('External link: '+path);continue;}
    if(!stat.isFile()||stat.size>100*1024*1024||/(?:\.env$|\.jsonl$|\.sqlite|__pycache__|\.pyc$|backup|screenshot)/i.test(path))throw Error('Unexpected public file: '+path);
    if(!path.includes('/runtime/')&&!/\.(?:gz|png)$/.test(path)) {
      const body=readFileSync(path,'utf8');
      if(/\/Users\/[A-Za-z0-9_-]+\/|gh[opusr]_[A-Za-z0-9]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/.test(body))throw Error('Private content: '+path);
    }
  }
}
audit(output);
const assets=join(root,'dist/public-assets');mkdirSync(assets,{recursive:true});
const zip=join(root,'dist',`Gauge-${version}-mac-arm64.zip`);
const sha256=createHash('sha256').update(readFileSync(zip)).digest('hex');
copyFileSync(zip,join(assets,'Gauge-mac-arm64.zip'));
writeFileSync(join(assets,'Gauge-mac-arm64.zip.sha256'),sha256+'  Gauge-mac-arm64.zip\n');
writeFileSync(join(assets,'version.json'),JSON.stringify({product:'Gauge',version,platform:'darwin-arm64',asset:'Gauge-mac-arm64.zip',sha256},null,2)+'\n');
copyFileSync(join(output,'install.sh'),join(assets,'install.sh'));
copyFileSync(join(output,'INSTALL.md'),join(assets,'INSTALL.md'));
copyFileSync(join(output,'UPDATE.md'),join(assets,'UPDATE.md'));
// Keep the Claude marketplace separate from the Codex install payload.
const claudeArchive=join(assets,'Gauge-Claude-Code-Mod.zip');
rmSync(claudeArchive,{force:true});
execFileSync('/usr/bin/zip',['-q','-r','-X',claudeArchive,'claude-mod'],{cwd:output});
console.log('Prepared reviewed public repository and release assets for Gauge '+version);
