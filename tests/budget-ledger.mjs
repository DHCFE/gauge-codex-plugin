// Exercise the C/A boundary using isolated real JSONL scanning, no user transcripts.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createBudgetService } from '../src/budget-service.mjs';

const directory = await mkdtemp(join(tmpdir(), 'tokenlens-budget-ledger-'));
const home = join(directory, 'codex'), data = join(directory, 'telemetry'), budgetData = join(directory, 'budgets');
const active = join(home, 'sessions/2026/09/01'), archive = join(home, 'archived_sessions');
const row = (type, payload, timestamp = '2026-09-01T10:00:00Z') => ({ type, timestamp, payload });
const meta = (id, extra = {}) => row('session_meta', { id, model_provider: 'openai', account_id: 'account-a', billing_pool_id: 'codex', ...extra });
const context = id => row('turn_context', { turn_id: id, model: 'gpt-6.1-sol' });
const usage = { input_tokens: 1000, cached_input_tokens: 400, cache_write_input_tokens: 0,
  output_tokens: 100, reasoning_output_tokens: 40, total_tokens: 1100 };
const native = (threadId, rid, tid, at) => row('token_usage_record', { thread_id: threadId, response_id: rid, turn_id: tid,
  model: 'gpt-6.1-sol', usage, turn_token_usage: usage }, at);
const main = [meta('main'), context('old'), native('main', 'old', 'old', '2026-09-01T09:59:59Z'),
  context('new'), native('main', 'new', 'new', '2026-09-01T10:00:00Z')];
const save = (path, records) => writeFile(path, records.map(record => JSON.stringify(record)).join('\n') + '\n');
let time = '2026-09-01T10:00:00Z';
try {
  await mkdir(active, { recursive: true }); await mkdir(archive, { recursive: true });
  await save(join(active, 'main.jsonl'), main);
  await save(join(archive, 'main-copy.jsonl'), main);
  await save(join(active, 'child.jsonl'), [meta('child', { source: { subagent: { thread_spawn: { parent_thread_id: 'main' } } } }),
    context('child-turn'), main[2], native('child', 'child-r', 'child-turn', '2026-09-01T10:01:00Z')]);
  await save(join(active, 'fork.jsonl'), [meta('fork', { forked_from_id: 'main' }), context('fork-turn'),
    native('main', 'new', 'new', '2026-09-01T10:00:00Z'), native('fork', 'fork-r', 'fork-turn', '2026-09-01T10:01:00Z')]);
  const readUsage = async request => {
    const query = { accountId: request.accountId, conversationId: request.threadId, startAt: request.startAt, endAt: request.endAt };
    const command = spawnSync('python3', ['-c', `import sys,json;sys.path.insert(0,'plugin/scripts');import account_usage;print(json.dumps(account_usage.snapshot(json.loads(sys.stdin.read()),sys.argv[1],sys.argv[2])))`, home, data],
      { cwd: new URL('..', import.meta.url), input: JSON.stringify(query), encoding: 'utf8' });
    assert.equal(command.status, 0, command.stderr);
    const ledger = JSON.parse(command.stdout), coverage = ledger.coverage, total = ledger.total;
    assert.equal(coverage.timeFilterExact, true);
    assert.equal(coverage.localScanComplete, true);
    return { ...request, rootThreadId: request.threadId, scopeVerified: coverage.accountAttributionComplete && coverage.ownershipUnresolvedRequests === 0,
      knownUsd: Number(total.knownUsd), costComplete: coverage.usageComplete && (total.costComplete || total.requestCount === 0),
      unknownCostCount: total.unpricedRequests, pending: false, observedAt: request.endAt };
  };
  const service = createBudgetService({ dataDir: budgetData, now: () => new Date(time), readUsage,
    resolveLineage: async ({ threadId }) => threadId === 'child' ? { verified: true, relationship: 'subagent', rootThreadId: 'main' } : null });
  const scope = { accountId: 'account-a', threadId: 'main' };
  await service.setBudget({ ...scope, enabled: true, amountUsd: 1 });
  time = '2026-09-01T10:02:00Z';
  const budget = await service.getBudget(scope);
  assert.equal(budget.observation.costComplete, true);
  assert.equal(budget.spentKnownUsd, 0.00448); // 2 requests; reasoning included in output.
  assert.equal(budget.remainingUsd, 0.99552);
  assert.equal((await service.getBudget({ ...scope, threadId: 'child' })).spentKnownUsd, 0.00448);
  assert.equal((await service.getBudget({ ...scope, threadId: 'fork' })).enabled, false);
  console.log('budget/actual ledger: exact epoch boundary, old usage excluded, archive duplicates and copied parent records deduplicated, child costs shared, fork excluded');
} finally { await rm(directory, { recursive: true, force: true }); }
