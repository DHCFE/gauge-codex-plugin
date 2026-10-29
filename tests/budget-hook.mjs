import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createBudgetService } from '../src/budget-service.mjs';
import { handleBudgetHook, runBudgetHook } from '../src/budget-hook.mjs';

const directory = await mkdtemp(join(tmpdir(), 'tokenlens-budget-hook-'));
let time = '2026-10-01T10:00:00Z', spent = 0, pending = false, calls = 0;
const scope = { accountId: 'account-a', threadId: 'root', verified: true };
const service = createBudgetService({ dataDir: directory, now: () => new Date(time),
  resolveLineage: async ({ threadId }) => threadId === 'child' ? { verified: true, relationship: 'subagent', rootThreadId: 'root' } : null,
  readUsage: async r => { calls++; return { ...r, rootThreadId: r.threadId, knownUsd: spent, costComplete: true,
    unknownCostCount: 0, scopeVerified: true, pending, observedAt: r.endAt }; } });
const dependencies = { service, resolveScope: async ({ agentId }) => agentId
  ? { ...scope, threadId: 'child', relationship: 'subagent' } : scope };
const event = (hook_event_name, extra = {}) => ({ session_id: 'root', hook_event_name, ...extra });
try {
  for (const hook of ['SessionStart','UserPromptSubmit','PreToolUse','SubagentStart']) {
    assert.equal((await handleBudgetHook(event(hook, { agent_id: 'child' }), dependencies)).output, '');
  }
  assert.equal(calls, 0);
  assert.equal((await runBudgetHook({ input: event('SessionStart') })).output, '');
  await service.setBudget({ ...scope, enabled: true, amountUsd: 10 });
  for (const source of ['startup','resume','compact']) {
    const result = await handleBudgetHook(event('SessionStart', { source }), dependencies);
    const output = JSON.parse(result.output);
    assert.match(output.hookSpecificOutput.additionalContext, /软预算/);
    assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.equal(result.delivery.hostVerified, false);
    assert.deepEqual(Object.keys(output), ['hookSpecificOutput']);
  }
  const input = event('UserPromptSubmit', { turn_id: 'turn-1', prompt: 'SECRET CHAT BODY NEVER STORE' });
  assert.ok((await handleBudgetHook(input, dependencies)).output);
  assert.equal((await handleBudgetHook(input, dependencies)).output, '');
  assert.equal((await handleBudgetHook(event('PreToolUse'), dependencies)).output, '');
  spent = 9;
  assert.equal((await handleBudgetHook(event('PreToolUse'), dependencies)).output, ''); // cooldown
  time = '2026-10-01T10:02:00Z';
  assert.match(JSON.parse((await handleBudgetHook(event('PreToolUse'), dependencies)).output).hookSpecificOutput.additionalContext, /余额较低/);
  assert.equal((await handleBudgetHook(event('PreToolUse'), dependencies)).output, '');
  // A final reply's recorded expense does not cause another model turn. Next user gets updated spend.
  spent = 12; pending = true;
  assert.equal((await handleBudgetHook(event('Stop'), dependencies)).output, '');
  const next = await handleBudgetHook(event('UserPromptSubmit', { turn_id: 'turn-2' }), dependencies);
  assert.match(JSON.parse(next.output).hookSpecificOutput.additionalContext, /\$12\.00/);
  assert.match(JSON.parse(next.output).hookSpecificOutput.additionalContext, /已记录费用超过预算/);
  assert.match(JSON.parse(next.output).hookSpecificOutput.additionalContext, /在途/);
  const child = await handleBudgetHook(event('SubagentStart', { agent_id: 'child', turn_id: 'turn-2' }), dependencies);
  assert.ok(child.output);
  const wrong = { service, resolveScope: async () => scope };
  assert.equal((await handleBudgetHook(event('SubagentStart', { agent_id: 'child' }), wrong)).output, '');
  assert.equal((await handleBudgetHook(event('SessionStart'), { service, resolveScope: async () => ({ ...scope, verified: false }) })).output, '');
  const store = await readFile(join(directory, 'budgets-v1.json'), 'utf8');
  assert.ok(!store.includes('SECRET CHAT BODY'));
  assert.ok(!next.output.includes('account-a'));
  await service.disableBudget(scope);
  const before = calls;
  for (const hook of ['SessionStart','UserPromptSubmit','SubagentStart','PreToolUse']) {
    assert.equal((await handleBudgetHook(event(hook, { agent_id: 'child' }), dependencies)).output, '');
  }
  assert.equal(calls, before);
  await service.setBudget({ ...scope, enabled: true, amountUsd: 20 });
  const working = join(directory, 'working-adapter.mjs');
  await writeFile(working, `
    import {createBudgetService} from ${JSON.stringify(new URL('../src/budget-service.mjs', import.meta.url).href)};
    export function createHookDependencies() {
      const service = createBudgetService({dataDir:${JSON.stringify(directory)}, now:()=>new Date('2026-10-01T10:04:00Z'),
        readUsage:async r=>({...r,rootThreadId:r.threadId,scopeVerified:true,knownUsd:3,costComplete:true,unknownCostCount:0,pending:false,observedAt:r.endAt})});
      return {service,resolveScope:async()=>({accountId:'account-a',threadId:'root',verified:true})};
    }
  `);
  // The actual command entry is successful silent output if unconfigured or broken.
  const env = { ...process.env }; delete env.TOKENLENS_BUDGET_ADAPTER;
  let cli = spawnSync(process.execPath, ['src/budget-hook.mjs'], { cwd: new URL('..', import.meta.url), env,
    input: JSON.stringify(input), encoding: 'utf8' });
  assert.equal(cli.status, 0); assert.equal(cli.stdout, ''); assert.equal(cli.stderr, '');
  cli = spawnSync(process.execPath, ['src/budget-hook.mjs'], { cwd: new URL('..', import.meta.url), env: { ...env, TOKENLENS_BUDGET_ADAPTER: working }, input: JSON.stringify(event('SessionStart')), encoding: 'utf8' });
  assert.equal(cli.status, 0); assert.equal(cli.stderr, '');
  const emitted = JSON.parse(cli.stdout);
  assert.match(emitted.hookSpecificOutput.additionalContext, /\$20\.00/);
  assert.match(emitted.hookSpecificOutput.additionalContext, /\$3\.00/);
  assert.equal(emitted.hookSpecificOutput.hookEventName, 'SessionStart');
  const broken = join(directory, 'adapter.mjs');
  await writeFile(broken, 'export function createHookDependencies() { throw new Error("private-secret"); }');
  cli = spawnSync(process.execPath, ['src/budget-hook.mjs'], { cwd: new URL('..', import.meta.url), env: { ...env, TOKENLENS_BUDGET_ADAPTER: broken }, input: JSON.stringify(input), encoding: 'utf8' });
  assert.equal(cli.status, 0); assert.equal(cli.stdout, ''); assert.equal(cli.stderr, '');
  let writes = '';
  assert.equal((await runBudgetHook({ input, adapterPath: broken, write: value => { writes += value; } })).reason, 'adapter-unavailable');
  assert.equal(writes, '');
  console.log('budget hook: silent disabled/unconfigured/error; new turns, resume, compact, child, cooldown, late cost and stdout protocol passed; native host remains unverified');
} finally { await rm(directory, { recursive: true, force: true }); }
