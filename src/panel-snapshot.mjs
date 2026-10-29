import { readFileSync, statSync, mkdirSync, openSync, closeSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest('hex');
const day = value => new Date(value).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });

// The snapshot is shared by panel instances and MCP processes, never by conversations.
export function createPanelSnapshot({ dataDir, codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'), now = Date.now }) {
  const file = join(dataDir, 'panel-snapshot-v1.json'), lock = file + '.lock';
  function identity() {
    try {
      const raw = readFileSync(join(codexHome, 'auth.json'), 'utf8'), auth = JSON.parse(raw);
      return digest(JSON.stringify([resolve(codexHome), auth.auth_mode, auth.tokens?.account_id || digest(raw)]));
    } catch (error) { return error.code === 'ENOENT' ? digest(resolve(codexHome) + ':logged-out') : null; }
  }
  function load() {
    try {
      if (statSync(file).size > 16 * 1024 * 1024) return null;
      const snapshot = JSON.parse(readFileSync(file, 'utf8'));
      if (!identity() || snapshot.identity !== identity() || snapshot.schema !== 1 || !Number.isFinite(snapshot.savedAt) || now() - snapshot.savedAt > 7 * 86400000 || snapshot.savedAt > now()) return null;
      return snapshot;
    } catch { return null; }
  }
  return {
    token: identity,
    read() {
      const snapshot = load();
      if (!snapshot) return null;
      const result = { savedAt: snapshot.savedAt, accountUsage: snapshot.accountUsage, quota: snapshot.quota };
      if (result.quota) {
        const q = result.quota, end = Date.parse(q.weekly?.period?.endAt);
        if (!Number.isFinite(end) || end <= now()) {
          q.weekly = null;
          q.estimate = null;
          q.pools = [];
          if (q.costs) q.costs.currentWindow = null;
        }
        if (q.costs && day(q.costs.updatedAt) !== day(now())) {
          q.costs.today = null;
          q.costs.last30Days = null;
        }
      }
      return result;
    },
    async save(key, value, token, startedAt = now(), offset = 0) {
      if (!['accountUsage', 'quota'].includes(key) || !token || token !== identity()) return;
      // A failed official read must not replace the last valid quota/cost snapshot.
      if (key === 'quota' && value?.status !== 'available') return;
      let fd, temporary;
      try {
        mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        for (let attempt = 0; attempt < 20; attempt++) {
          try { fd = openSync(lock, 'wx', 0o600); break; }
          catch (error) {
            if (error.code !== 'EEXIST') throw error;
            // Recover only abandoned locks, not another active writer.
            if (now() - statSync(lock).mtimeMs > 60000) { try { unlinkSync(lock); } catch {} }
            await new Promise(resolve => setTimeout(resolve, 20));
          }
        }
        if (fd === undefined || token !== identity()) return;
        const snapshot = load() || { schema: 1, identity: token, revisions: {} };
        if ((snapshot.revisions?.[key] || 0) > startedAt) return;
        const stored = { ...value };
        if (key === 'quota') delete stored.cycleUsage;
        if (key === 'accountUsage') {
          if (offset) {
            const previous = snapshot.accountUsage;
            if (previous?.nextOffset !== offset || previous.conversations?.length !== offset) return;
            stored.conversations = [...previous.conversations, ...stored.conversations];
          }
          delete stored.threads;
          delete stored.breakdown;
        }
        snapshot[key] = stored;
        snapshot.revisions = { ...snapshot.revisions, [key]: startedAt };
        snapshot.savedAt = now();
        temporary = file + '.' + randomUUID();
        writeFileSync(temporary, JSON.stringify(snapshot), { mode: 0o600 });
        renameSync(temporary, file);
      } catch { /* Cache failure must never fail a live read. */ }
      finally {
        if (temporary) { try { unlinkSync(temporary); } catch {} }
        if (fd !== undefined) { closeSync(fd); try { unlinkSync(lock); } catch {} }
      }
    }
  };
}
