import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const script = new URL('./scripts/usage_dispatch.py', import.meta.url);
const engine = new URL(`./runtime/${process.platform}-${process.arch}/usage-engine/tokenlens-usage`, import.meta.url);
const pending = new Map();
let telemetryQueue = Promise.resolve();
export async function readTelemetry(operation, request = {}) {
  const body = operation === 'thread' ? {operation, thread_id: request.thread_id} : {operation, request};
  const key = JSON.stringify(body);
  if (pending.has(key)) return pending.get(key);
  const execute = () => new Promise((resolve, reject) => {
    const bundled = existsSync(engine) && !process.env.TOKENLENS_PYTHON;
    const child = spawn(bundled ? fileURLToPath(engine) : process.env.TOKENLENS_PYTHON || 'python3', bundled ? [] : [fileURLToPath(script)], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: {...process.env, TOKENLENS_ROOT: fileURLToPath(new URL('.', import.meta.url))}
    });
    let output = '', settled = false;
    const fail = message => { if (!settled) { settled = true; child.kill(); reject(new Error(message)); } };
    const timer = setTimeout(() => fail('读取本地用量超时，请重试。'), 45000);
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > 32 * 1024 * 1024) fail('本地用量结果过大，请缩小查询范围。');
    });
    child.on('error', () => { clearTimeout(timer); fail('本地计数引擎未能启动，请检查完整运行包。'); });
    child.stdin.on('error', () => {});
    child.on('close', code => {
      clearTimeout(timer);
      if (settled) return;
      try {
        const usage = JSON.parse(output);
        if (code || usage.error) throw new Error(usage.error || '本地用量读取失败。');
        settled = true;
        resolve(usage);
      } catch (error) { fail(error instanceof SyntaxError ? '本地计数引擎没有返回有效 JSON。' : error.message); }
    });
    child.stdin.end(JSON.stringify(body));
  });
  // Conversation and budget reads now share a ledger. Serialize writers while
  // identical in-flight reads still reuse the same promise above.
  const running = telemetryQueue.then(execute,execute).finally(() => pending.delete(key));
  telemetryQueue = running.catch(() => {});
  pending.set(key, running);
  return running;
}
