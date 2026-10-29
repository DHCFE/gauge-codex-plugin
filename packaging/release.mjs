import { copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, lstatSync, realpathSync, readlinkSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Build on Apple Silicon Mac.');
await import('../build.mjs');
const version = JSON.parse(readFileSync('package.json')).version;
const manifest = JSON.parse(readFileSync('plugin/.codex-plugin/plugin.json'));
if (manifest.version !== version) throw new Error('Manifest version mismatch.');
const runtime = JSON.parse(readFileSync('plugin/runtime/darwin-arm64/runtime.json'));
for (const file of readdirSync('plugin/scripts').filter(name=>name.endsWith('.py')).map(name=>'plugin/scripts/'+name)) {
  const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (runtime.sources?.[file] !== digest) throw new Error(`Stale frozen engine: ${file}; run npm run runtime:mac.`);
}
const name = `Gauge-${version}-mac-arm64`;
const dist = join(root, 'dist');
const stage = join(dist, name);
mkdirSync(dist, {recursive:true});
rmSync(stage, {recursive:true, force:true});
mkdirSync(stage);
const files = ['plugin/.codex-plugin/plugin.json', 'plugin/.mcp.json', 'plugin/server.mjs', 'plugin/budget-hook.mjs', 'plugin/hooks/hooks.json',
  'plugin/assets/icon.svg', 'plugin/assets/tokenlens.html', 'plugin/data/prices.json', 'plugin/data/release.json',
  ...readdirSync('plugin/scripts').filter(name=>name.endsWith('.py')).map(name=>'plugin/scripts/'+name),
  'plugin/bin/launch.sh', '.agents/plugins/marketplace.json',
  'README.md', 'RELEASE-ACCEPTANCE.md', 'DISTRIBUTION.md', 'THIRD-PARTY-NOTICES.md', 'packaging/manage.sh'];
for (const file of files) {
  const target = join(stage, file);
  mkdirSync(resolve(target, '..'), {recursive:true});
  copyFileSync(join(root, file), target);
}
// Ship the same first-time user guide as the public repository.
copyFileSync(join(root,'packaging/PUBLIC-README.md'),join(stage,'README.md'));
for (const file of ['INSTALL.md','UPDATE.md']) copyFileSync(join(root,'packaging',file),join(stage,file));
for (const file of ['INSTALL.md','UPDATE.md','MAINTENANCE.md']) {
  copyFileSync(join(root,'packaging',file),join(stage,'packaging',file));
}
mkdirSync(join(stage,'docs/images'),{recursive:true});
for (const file of ['round-usage.png','conversation-budget.png','budget-setup.png']) {
  copyFileSync(join(root,'docs/images',file),join(stage,'docs/images',file));
}
if (!lstatSync('plugin/runtime/darwin-arm64/node.gz').isFile()) throw new Error('Run npm run runtime:mac first.');
cpSync('plugin/runtime/darwin-arm64', join(stage, 'plugin/runtime/darwin-arm64'), {recursive:true, dereference:false, verbatimSymlinks:true});
for (const command of ['Install', 'Update', 'Uninstall']) {
  copyFileSync(`packaging/${command}.command`, join(stage, `${command}.command`));
  chmodSync(join(stage, `${command}.command`), 0o755);
}
chmodSync(join(stage, 'plugin/bin/launch.sh'), 0o755);
chmodSync(join(stage, 'packaging/manage.sh'), 0o755);

// esbuild bundles dependencies. Preserve their license notices in the package.
let notices = 'Gauge bundled JavaScript dependency notices\n\n';
function collectPackages(dir) {
  for (const entry of readdirSync(dir, {withFileTypes:true})) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.name.startsWith('@')) { collectPackages(path); continue; }
    const pkg = JSON.parse(readFileSync(join(path, 'package.json')));
    if (pkg.name === 'esbuild' || pkg.name.startsWith('@esbuild/')) continue;
    notices += `${pkg.name} ${pkg.version} (${pkg.license || 'see license'})\n`;
    for (const file of readdirSync(path).filter(f=>/^(license|copying|notice)(\.|$)/i.test(f))) {
      if (lstatSync(join(path,file)).isFile()) notices += readFileSync(join(path,file),'utf8')+'\n';
    }
    notices += '\n';
  }
}
collectPackages('node_modules');
writeFileSync(join(stage, 'THIRD-PARTY-NOTICES.txt'), notices);

const checks = [];
const links = [];
function audit(dir) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir,name), rel = relative(stage,path), stat = lstatSync(path);
    if (stat.isDirectory()) { audit(path); continue; }
    if (stat.isSymbolicLink()) {
      if (!realpathSync(path).startsWith(stage+'/')) throw new Error(`External symlink: ${rel}`);
      links.push(`${rel}\t${readlinkSync(path)}`);
      continue;
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`Unexpected file: ${rel}`);
    if (/(?:__pycache__|\.DS_Store|\.jsonl$|\.sqlite|\.pyc$|\.env$|backup|screenshot)/i.test(rel)) throw new Error(`Private/unexpected content: ${rel}`);
    if (stat.size > 100 * 1024 * 1024) throw new Error(`Too large for GitHub repo: ${rel}`);
    checks.push(`${createHash('sha256').update(readFileSync(path)).digest('hex')}  ${rel}`);
  }
}
audit(stage);
writeFileSync(join(stage, 'PAYLOAD-LINKS.tsv'), links.join('\n')+'\n');
checks.push(`${createHash('sha256').update(readFileSync(join(stage,'PAYLOAD-LINKS.tsv'))).digest('hex')}  PAYLOAD-LINKS.tsv`);
writeFileSync(join(stage, 'PAYLOAD.sha256'), checks.join('\n')+'\n');
const archive = join(dist, `${name}.zip`);
rmSync(archive, {force:true});
execFileSync('/usr/bin/zip', ['-q', '-r', '-y', '-X', archive, name], {cwd:dist});
const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
writeFileSync(archive+'.sha256', digest+'  '+name+'.zip\n');
console.log(`Built ${name}.zip (${checks.length} allowlisted files). SHA-256: ${digest}`);
