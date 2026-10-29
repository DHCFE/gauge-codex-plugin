import { readFileSync, writeFileSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export function compareVersions(a, b) {
  const parse = value => /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value) ? value.split('.').map(Number) : null;
  const left = parse(a), right = parse(b);
  if (!left || !right) throw new Error('Invalid release version');
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return Math.sign(left[i] - right[i]);
  return 0;
}

export function createUpdateService({ repository, currentVersion, dataDir, fetchImpl = fetch, now = Date.now, timeoutMs = 10000 } = {}) {
  compareVersions(currentVersion, currentVersion);
  const configured = typeof repository === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repository);
  const origin = configured ? `https://github.com/${repository}` : null;
  const endpoint = origin && `${origin}/releases/latest/download/version.json`;
  const cachePath = join(dataDir, 'release-status.json');
  let pending, memory, lastFailureAt = -Infinity;
  function validate(value) {
    if (!value || value.product !== 'Gauge' || value.platform !== 'darwin-arm64' || value.asset !== 'Gauge-mac-arm64.zip'
      || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error('Invalid release manifest');
    compareVersions(value.version, currentVersion);
    return {product:'Gauge', platform:'darwin-arm64', version:value.version, asset:value.asset, sha256:value.sha256};
  }
  function readCache() {
    try {
      if (statSync(cachePath).size > 8192) return null;
      const saved = JSON.parse(readFileSync(cachePath, 'utf8'));
      if (saved.repository !== repository || !Number.isFinite(saved.checkedAt) || saved.checkedAt > now() + 60_000) return null;
      return { manifest:validate(saved.manifest), checkedAt:saved.checkedAt };
    } catch { return null; }
  }
  function saveCache(value) {
    const temp = `${cachePath}.${process.pid}.${now()}.tmp`;
    try {
      mkdirSync(dataDir, {recursive:true, mode:0o700});
      writeFileSync(temp, JSON.stringify({repository, ...value}), {mode:0o600});
      renameSync(temp, cachePath);
    } catch { try { unlinkSync(temp); } catch {} }
  }
  function view(value, stale = false) {
    const version = value.manifest.version;
    return {status:compareVersions(version,currentVersion)>0 ? 'available' : 'current', currentVersion, latestVersion:version,
      checkedAt:new Date(value.checkedAt).toISOString(), stale, releaseUrl:`${origin}/releases/tag/v${version}`,
      installUrl:`https://raw.githubusercontent.com/${repository}/main/INSTALL.md`};
  }
  async function check({ force = false } = {}) {
    if (!configured) return {status:'unconfigured', currentVersion};
    const cached = memory || readCache();
    if (!force && cached && compareVersions(cached.manifest.version,currentVersion) >= 0 && now() - cached.checkedAt < 6 * 60 * 60_000) return view(cached);
    if (!force && now() - lastFailureAt < 15 * 60_000) return cached ? view(cached,true) : {status:'unavailable',currentVersion};
    if (pending) return pending;
    pending = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(endpoint,{signal:controller.signal,headers:{Accept:'application/json'}});
        if (!response.ok) throw new Error('Release unavailable');
        let size = 0, text = '';
        const decoder = new TextDecoder();
        for await (const bytes of response.body) {
          size += bytes.byteLength;
          if (size > 8192) { controller.abort(); throw new Error('Manifest too large'); }
          text += decoder.decode(bytes, {stream:true});
        }
        text += decoder.decode();
        memory = {manifest:validate(JSON.parse(text)), checkedAt:now()};
        saveCache(memory);
        return view(memory);
      } catch {
        lastFailureAt = now();
        return cached ? view(cached,true) : {status:'unavailable',currentVersion};
      } finally { clearTimeout(timer); pending = null; }
    })();
    return pending;
  }
  return {check, async release(version) {
    const status = await check({force:true});
    if (status.status !== 'available' || status.stale || status.latestVersion !== version) throw new Error('版本信息已变化或暂不可用，请重新检查更新。');
    return {...memory.manifest};
  }};
}
