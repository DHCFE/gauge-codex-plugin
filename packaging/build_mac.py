"""Maintainer-only build. End users do not need Python, Node, pip or npm."""
import ast
import gzip
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / '.build'
DEST = ROOT / 'plugin/runtime/darwin-arm64'
lock = json.loads((ROOT / 'packaging/runtime-lock.json').read_text())

def run(*args):
    subprocess.run(args, cwd=ROOT, check=True)

if platform.system() != 'Darwin' or platform.machine() != 'arm64':
    sys.exit('Build on an Apple Silicon Mac. Cross-compilation is not supported.')
if sys.version_info[:2] != (3, 11):
    sys.exit('Maintainer build requires Python 3.11; it is included in the end-user bundle.')

DEST.mkdir(parents=True, exist_ok=True)
downloads = WORK / 'downloads'
downloads.mkdir(parents=True, exist_ok=True)
node = lock['node']
archive = downloads / node['archive']
if not archive.exists():
    urllib.request.urlretrieve(f"https://nodejs.org/dist/v{node['version']}/{node['archive']}", archive)
if hashlib.sha256(archive.read_bytes()).hexdigest() != node['sha256']:
    sys.exit('Official Node archive SHA-256 mismatch; delete it and retry.')
with tarfile.open(archive) as tar:
    prefix = f"node-v{node['version']}-darwin-arm64/"
    for name, target in [('bin/node', DEST / 'node'), ('LICENSE', DEST / 'NODE-LICENSE.txt')]:
        with tar.extractfile(prefix + name) as source, target.open('wb') as output:
            shutil.copyfileobj(source, output)
node_bytes = (DEST / 'node').read_bytes()
(DEST / 'node.sha256').write_text(hashlib.sha256(node_bytes).hexdigest() + '\n')
# GitHub rejects individual files above 100 MiB. Expand once in private plugin data.
with (DEST / 'node.gz').open('wb') as out:
    with gzip.GzipFile(filename='', mode='wb', fileobj=out, mtime=0) as compressed:
        compressed.write(node_bytes)
(DEST / 'node').unlink()

venv = WORK / 'venv'
if not venv.exists():
    run(sys.executable, '-m', 'venv', str(venv))
python = str(venv / 'bin/python')
run(python, '-m', 'pip', 'install', '-r', str(ROOT / 'packaging/build-requirements.txt'))
run(python, '-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir',
    '--target-architecture', 'arm64', '--name', 'tokenlens-usage',
    '--paths', 'plugin/scripts', '--distpath', str(WORK / 'frozen'),
    '--workpath', str(WORK / 'freeze-work'), '--specpath', str(WORK),
    'plugin/scripts/usage_dispatch.py')
engine = DEST / 'usage-engine'
if engine.exists():
    shutil.rmtree(engine)
# Codex's plugin cache copier skips symlinks. Materialize them before distribution.
shutil.copytree(WORK / 'frozen/tokenlens-usage', engine, symlinks=False)

# Copy runtime licensing, not the maintainer environment or personal files.
licenses = DEST / 'licenses'
licenses.mkdir(exist_ok=True)
for source in Path(sys.base_prefix).rglob('LICENSE*'):
    if source.is_file() and 'site-packages' not in str(source):
        shutil.copyfile(source, licenses / ('PYTHON-' + source.name))
pyinstaller = subprocess.check_output([python, '-c', 'import PyInstaller; print(PyInstaller.__path__[0])'], text=True).strip()
for source in Path(pyinstaller).parent.glob('pyinstaller-*.dist-info/licenses/*'):
    if source.is_file():
        shutil.copyfile(source, licenses / ('PYINSTALLER-' + source.name))

# Runtime dependency origins from the packager, rather than machine-specific paths.
toc = ast.literal_eval((WORK / 'freeze-work/tokenlens-usage/Analysis-00.toc').read_text())
def binaries(value):
    if isinstance(value, (list, tuple)):
        if len(value) == 3 and value[-1] in ('BINARY', 'EXTENSION') and isinstance(value[1], str):
            yield Path(value[1]).resolve()
        else:
            for child in value:
                yield from binaries(child)
for binary in binaries(toc):
    for parent in binary.parents:
        if (parent / '.brew').is_dir():
            for pattern in ('LICENSE*', 'COPYING*', 'COPYRIGHT*'):
                for source in parent.glob(pattern):
                    if source.is_file():
                        shutil.copyfile(source, licenses / (parent.parent.name + '-' + source.name))
            break

metadata = {'platform': 'darwin-arm64', 'node': node,
            'python': platform.python_version(), 'pyinstaller': lock['pyinstaller'],
            'builtOnMacOS': platform.mac_ver()[0], 'signing': 'ad-hoc; not notarized',
            'sources': {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
                        for name in sorted(str(p.relative_to(ROOT)) for p in (ROOT / 'plugin/scripts').glob('*.py'))}}
(DEST / 'runtime.json').write_text(json.dumps(metadata, indent=2) + '\n')
run('/usr/bin/codesign', '--verify', str(engine / 'tokenlens-usage'))
print('Mac runtime ready. No system Node/Python is needed at runtime.')
