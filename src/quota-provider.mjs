import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';

export const CODEX_QUOTA_ARGS = Object.freeze(['-s', 'read-only', '-a', 'never', 'app-server']);
export const CODEX_CANDIDATES = Object.freeze([
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
  '/usr/local/bin/codex', '/opt/homebrew/bin/codex',
]);

// Independent stdio client for documented official account RPCs. Codex owns
// existing authentication. No auth-file access, login, resets or model turns.
export async function readCodexAppServer({ executable, spawnProcess = spawn,
  timeoutMs = 20000, clock = Date.now } = {}) {
  const child = spawnProcess(executable, [...CODEX_QUOTA_ARGS], {
    cwd: tmpdir(), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
  });
  let id = 0, buffer = '', totalBytes = 0, ended = false;
  const deadline = Date.now() + timeoutMs;
  const pending = new Map();
  const fail = code => {
    ended = true;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer); waiter.reject(Object.assign(new Error(code), { code }));
    }
    pending.clear();
  };
  child.on('error', () => fail('provider_launch_failed'));
  child.on('close', () => fail('provider_closed'));
  child.stdin.on('error', () => fail('provider_closed'));
  child.stdout.on('data', chunk => {
    totalBytes += Buffer.byteLength(chunk);
    if (totalBytes > 1024 * 1024) { fail('provider_output_limit'); child.kill('SIGKILL'); return; }
    buffer += chunk.toString();
    for (;;) {
      const index = buffer.indexOf('\n'); if (index < 0) break;
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      let message;
      try { message = JSON.parse(line); } catch { fail('invalid_provider_payload'); return; }
      if (message?.method) {
        if (message.id !== undefined && message.method === 'account/chatgptAuthTokens/refresh') fail('external_auth_host_required');
        continue;
      }
      const waiter = pending.get(message?.id);
      if (!waiter) continue;
      pending.delete(message.id); clearTimeout(waiter.timer);
      if (message.error) waiter.reject(Object.assign(new Error('provider_rpc_failed'), { code: 'provider_rpc_failed' }));
      else waiter.resolve(message.result);
    }
  });
  function call(method, params) {
    if (ended) return Promise.reject(Object.assign(new Error('provider_closed'), { code: 'provider_closed' }));
    const requestId = ++id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId); reject(Object.assign(new Error('provider_timeout'), { code: 'provider_timeout' }));
      }, Math.max(1, deadline - Date.now()));
      pending.set(requestId, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id: requestId, method, ...(params === undefined ? {} : { params }) }) + '\n');
    });
  }
  try {
    await call('initialize', { clientInfo: { name: 'tokenlens-quota', version: '0.5.8' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const auth = await call('account/read', { refreshToken: false });
    if (!auth?.account || auth.account.type !== 'chatgpt') return {
      status: 'unavailable', source: 'codex-app-server', reason: auth?.account ? 'chatgpt_quota_not_supported_for_auth_mode' : 'codex_login_required',
    };
    const limits = await call('account/rateLimits/read');
    // This continuity hash detects email switches, never claims workspace identity.
    const email = typeof auth.account.email === 'string' ? auth.account.email.trim().toLowerCase() : null;
    return { source: 'codex-app-server', updatedAt: new Date(clock()).toISOString(),
      account: { accountId: auth.account.accountId ?? null, type: auth.account.type, planType: auth.account.planType ?? null,
        accountRef: email ? createHash('sha256').update('tokenlens-current-login:' + email).digest('hex') : null },
      rateLimits: limits?.rateLimits ?? null, rateLimitsByLimitId: limits?.rateLimitsByLimitId ?? null };
  } finally {
    fail('provider_closed'); child.stdin.end();
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1000);
        child.once('close', () => { clearTimeout(timer); resolve(); });
      });
    }
  }
}

export function createCodexQuotaProvider({ executable, candidates = CODEX_CANDIDATES,
  path = process.env.PATH ?? '', canExecute = candidate => access(candidate, constants.X_OK),
  rpc = readCodexAppServer, timeoutMs = 20000, cacheMs = 60000, clock = Date.now } = {}) {
  let cached = null, inFlight = null;
  return async function provider() {
    if (cached && clock() - cached.at >= 0 && clock() - cached.at < cacheMs) return cached.value;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      let selected = executable;
      if (!selected) {
        for (const candidate of [...candidates, ...path.split(delimiter).filter(Boolean).map(dir => join(dir, 'codex'))]) {
          try { await canExecute(candidate); selected = candidate; break; } catch { /* next installed Codex location */ }
        }
      }
      if (!selected) return { status: 'unsupported', source: 'codex-app-server', reason: 'codex_cli_not_installed' };
      try {
        const value = await rpc({ executable: selected, timeoutMs, clock });
        if (value && typeof value === 'object' && (value.rateLimits || value.rateLimitsByLimitId)) cached = { at: clock(), value };
        else if (!value?.status) return { status: 'unavailable', source: 'codex-app-server', reason: 'invalid_provider_payload' };
        return value;
      } catch (error) {
        const safeCodes = ['provider_timeout', 'provider_closed', 'provider_rpc_failed', 'provider_output_limit', 'invalid_provider_payload', 'provider_launch_failed', 'external_auth_host_required'];
        return { status: 'unavailable', source: 'codex-app-server', reason: safeCodes.includes(error?.code) ? error.code : 'provider_read_failed' };
      }
    })();
    try { return await inFlight; } finally { inFlight = null; }
  };
}
export const codexQuotaProvider = createCodexQuotaProvider();
