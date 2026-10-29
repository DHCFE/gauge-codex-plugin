import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBudgetService, formatBudgetContext } from '../src/budget-service.mjs';

const directory = await mkdtemp(join(tmpdir(), 'tokenlens-budget-test-'));
let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`ok ${name}`); };
let time = '2026-10-01T10:00:00Z', calls = [], rows = [], responseOverride;
const now = () => new Date(time);
const lineage = async ({ threadId }) => threadId === 'child' ? { verified: true, relationship: 'subagent', rootThreadId: 'root' }
  : threadId === 'fork' ? { verified: true, relationship: 'fork', rootThreadId: 'root' } : null;
const readUsage = async request => {
  calls.push(request);
  const selected = rows.filter(row => row.accountId === request.accountId && ['root','child'].includes(row.threadId)
    && new Date(row.at) >= new Date(request.startAt) && new Date(row.at) < new Date(request.endAt));
  return responseOverride || { accountId: request.accountId, rootThreadId: request.threadId,
    startAt: request.startAt, endAt: request.endAt, scopeVerified: true,
    knownUsd: selected.reduce((sum, row) => sum + (row.usd || 0), 0),
    costComplete: selected.every(row => row.usd !== null), unknownCostCount: selected.filter(row => row.usd === null).length,
    pending: false, observedAt: request.endAt };
};
const service = createBudgetService({ dataDir: directory, readUsage, resolveLineage: lineage, now });
const scope = { accountId: 'account-a', threadId: 'root' };
const estimate = { accountId: 'account-a', status: 'available', capacityUsd: 400,
  period: { startAt: '2026-09-28T17:21:00Z', endAt: '2026-10-05T17:21:00Z' },
  observedAt: '2026-10-01T09:59:00Z', usedFraction: 0.25, knownPeriodUsd: 100,
  reliability: 'limited', rawToken: 'credential-do-not-persist', unrelatedChat: 'do-not-persist' };
const emit = async result => service.recordDelivery({ ...scope, epoch: result.budget.epoch,
  revision: result.budget.revision, deliveryId: result.deliveryId, turnKey: result.turnKey,
  budgetStatus: result.budget.status, channel: 'hook' });

try {
  await check('default disabled is zero-context, zero-ledger and zero-store writes', async () => {
    assert.equal((await service.getBudget(scope)).enabled, false);
    assert.equal((await service.getContext({ ...scope, event: 'UserPromptSubmit' })).context, '');
    assert.equal(formatBudgetContext(null), '');
    assert.equal(calls.length, 0);
    await assert.rejects(stat(join(directory, 'budgets-v1.json')), { code: 'ENOENT' });
    await assert.rejects(service.setBudget({ ...scope, amountUsd: 10 }), /enabled:true/);
    await assert.rejects(service.getBudget({ threadId: 'root' }), /Explicit/);
  });
  let initial;
  await check('explicit amount starts an epoch; only new recorded expenses are charged', async () => {
    rows = [{ accountId: 'account-a', threadId: 'root', at: '2026-10-01T09:00:00Z', usd: 90 }];
    initial = await service.setBudget({ ...scope, enabled: true, mode: 'amount', amountUsd: 10 });
    assert.equal(initial.remainingUsd, 10);
    assert.equal(initial.effectiveAt, '2026-10-01T10:00:00.000Z');
    assert.equal(initial.delivery.status, 'pending-model-interaction');
    time = '2026-10-01T10:02:00Z';
    rows.push({ accountId: 'account-a', threadId: 'root', at: '2026-10-01T10:00:00Z', usd: 2 },
      { accountId: 'account-a', threadId: 'child', at: '2026-10-01T10:01:00Z', usd: 1 },
      { accountId: 'account-a', threadId: 'root', at: '2026-10-01T10:02:00Z', usd: 20 });
    assert.equal((await service.getBudget(scope)).remainingUsd, 7);
    assert.equal(calls.at(-1).includeDescendants, true);
  });
  await check('verified child shares budget; fork, unrelated chat and different account do not inherit', async () => {
    const child = await service.getBudget({ ...scope, threadId: 'child' });
    assert.equal(child.epoch, initial.epoch);
    assert.equal(child.remainingUsd, 7);
    assert.equal(child.sharedWithRoot, true);
    for (const isolated of [{ ...scope, threadId: 'other' }, { ...scope, threadId: 'fork' }, { ...scope, accountId: 'account-b' }]) {
      assert.equal((await service.getContext(isolated)).context, '');
    }
  });
  await check('adjustment retains epoch and start; does not erase recorded spend', async () => {
    const adjusted = await service.setBudget({ ...scope, enabled: true, amountUsd: 20 });
    assert.equal(adjusted.epoch, initial.epoch);
    assert.equal(adjusted.effectiveAt, initial.effectiveAt);
    assert.equal(adjusted.remainingUsd, 17);
    await service.setBudget({ ...scope, enabled: true, amountUsd: 10 });
  });
  await check('percentage saves a whitelisted estimate and freezes dollars across week reset', async () => {
    const percent = await service.setBudget({ ...scope, enabled: true, mode: 'percentage', percent: 10, estimate });
    assert.equal(percent.amountUsd, 40);
    await assert.rejects(service.setBudget({ ...scope, enabled: true, mode: 'percentage', percent: 10,
      estimate: { ...estimate, capacityUsd: 500 } }), /cycle cumulative/);
    await assert.rejects(service.setBudget({ ...scope, enabled: true, mode: 'percentage', percent: 10,
      estimate: { ...estimate, usedFraction: undefined } }), /fraction/);
    const nativeB = { status: 'estimated', estimatedCapacityUsd: 400, updatedAt: estimate.observedAt,
      basis: { accountId: scope.accountId, poolId: 'codex', period: estimate.period, cycleApiEquivalentUsd: 100, usedPercent: 25 },
      qualityReasons: [{ code: 'api_equivalent_extrapolation', severity: 'warning' }] };
    const fromB = await service.setBudget({ ...scope, enabled: true, mode: 'percentage', percent: 10, estimate: nativeB });
    assert.equal(fromB.amountUsd, 40);
    assert.equal(fromB.estimate.poolId, 'codex');
    estimate.capacityUsd = 900;
    time = '2026-10-08T10:00:00Z';
    const later = await service.getBudget(scope);
    assert.equal(later.amountUsd, 40);
    assert.equal(later.epoch, initial.epoch);
    assert.equal(later.estimate.capacityUsd, 400);
    await assert.rejects(service.setBudget({ ...scope, enabled: true, mode: 'percentage', percent: 10, estimate }), /current official period/);
    const persisted = await readFile(join(directory, 'budgets-v1.json'), 'utf8');
    assert.ok(!persisted.includes('credential-do-not-persist'));
    assert.ok(!persisted.includes('do-not-persist'));
    await assert.rejects(service.setBudget({ ...scope, enabled: true, mode: 'percentage', percent: 10,
      estimate: { ...estimate, accountId: 'account-b' } }), /same-account/);
    await assert.rejects(service.setBudget({ ...scope, enabled: true, mode: 'percentage', percent: 10,
      estimate: { ...estimate, status: 'unavailable' } }), /same-account/);
    await assert.rejects(service.setBudget({ ...scope, enabled: true, mode: 'amount', amountUsd: -1 }), /amount/);
  });
  await check('unknown and unpriced costs remain unknown; known overspend still reports overspent', async () => {
    rows.push({ accountId: 'account-a', threadId: 'child', at: '2026-10-03T10:00:00Z', usd: null });
    let value = await service.getBudget(scope);
    assert.equal(value.remainingUsd, null);
    assert.equal(value.status, 'unknown');
    assert.equal(value.remainingIsUpperBound, true);
    assert.equal(value.observation.unknownCostCount, 1);
    assert.match(formatBudgetContext(value), /未知/);
    await service.setBudget({ ...scope, enabled: true, amountUsd: 1 });
    value = await service.getBudget(scope);
    assert.equal(value.status, 'overspent');
    assert.equal(value.remainingUsd, null);
    assert.ok(value.remainingKnownUsd < 0);
    rows = rows.filter(row => row.usd !== null);
  });
  await check('scope mismatch and ledger failure never become zero charges', async () => {
    responseOverride = { accountId: 'account-b' };
    const value = await service.getBudget(scope);
    assert.equal(value.spentKnownUsd, null);
    assert.equal(value.remainingUsd, null);
    const unknownOverview = await service.getOverview({ accountId: scope.accountId });
    assert.equal(unknownOverview.observedSpentKnownUsd, null);
    assert.equal(unknownOverview.unknownBudgetCount, 1);
    responseOverride = null;
    const broken = createBudgetService({ dataDir: directory, now, readUsage: async () => { throw new Error('offline'); } });
    assert.equal((await broken.getBudget(scope)).remainingUsd, null);
    const asynchronousLedger = createBudgetService({ dataDir: directory, now,
      readUsage: async r => ({ ...r, rootThreadId: r.threadId, scopeVerified: true,
        knownUsd: 3, costComplete: true, unknownCostCount: 0, pending: true,
        observedAt: new Date(new Date(r.endAt).getTime() + 1500).toISOString() }) });
    const observed = await asynchronousLedger.getBudget(scope);
    assert.equal(observed.spentKnownUsd, 3);
    assert.equal(observed.observation.pending, true);
  });
  await check('context generation is not delivery; turn summaries deduplicate and compaction restores', async () => {
    const context = await service.getContext({ ...scope, event: 'UserPromptSubmit', turnId: 'turn-1' });
    assert.equal(context.shouldDeliver, true);
    assert.equal((await service.getBudget(scope)).delivery.hostVerified, false);
    const sent = await emit(context);
    assert.equal(sent.status, 'emitted-unverified');
    assert.equal(sent.hostVerified, false);
    assert.equal((await service.getContext({ ...scope, event: 'UserPromptSubmit', turnId: 'turn-1' })).context, '');
    assert.ok((await service.getContext({ ...scope, event: 'UserPromptSubmit', turnId: 'turn-2' })).context);
    assert.ok((await service.getContext({ ...scope, event: 'SessionStart', source: 'compact' })).context);
    assert.equal((await service.getContext({ ...scope, event: 'Stop' })).context, '');
  });
  await check('overview allocations are plans and never reduce official remaining capacity', async () => {
    const overview = await service.getOverview({ accountId: scope.accountId });
    assert.equal(overview.count, 1);
    assert.equal(overview.allocatedPlanUsd, 1);
    assert.equal(overview.planOnly, true);
    assert.equal(overview.subtractFromOfficialRemaining, false);
    assert.equal((await service.getOverview({ accountId: 'account-b' })).count, 0);
  });
  await check('disable silences root and child; late in-flight context cannot be recorded', async () => {
    const pending = await service.getContext(scope);
    await service.disableBudget(scope);
    const before = calls.length;
    for (const threadId of ['root','child']) assert.equal((await service.getContext({ ...scope, threadId })).context, '');
    assert.equal(calls.length, before);
    assert.equal((await emit(pending)).recorded, false);
    assert.equal((await service.getBudget(scope)).historicalContextCannotBeRetracted, true);
    assert.equal((await service.getOverview({ accountId: scope.accountId })).allocatedPlanUsd, 0);
  });
  await check('reenable creates a new epoch; explicit reset is the only active budget reset', async () => {
    const reenabled = await service.setBudget({ ...scope, enabled: true, amountUsd: 15 });
    assert.notEqual(reenabled.epoch, initial.epoch);
    assert.equal(reenabled.remainingUsd, 15);
    const reset = await service.setBudget({ ...scope, enabled: true, amountUsd: 5, resetEpoch: true });
    assert.notEqual(reset.epoch, reenabled.epoch);
  });
  await check('delivery persists after process restart; private store has no prompt/body content', async () => {
    const recreated = createBudgetService({ dataDir: directory, readUsage, resolveLineage: lineage, now });
    const value = await recreated.getBudget(scope);
    assert.equal(value.enabled, true);
    assert.ok((await recreated.getContext({ ...scope, event: 'SessionStart' })).context);
    assert.equal((await stat(join(directory, 'budgets-v1.json'))).mode & 0o777, 0o600);
  });
  await check('concurrent saves serialize without losing other conversations; malformed stores fail closed', async () => {
    await Promise.all(['alpha','beta'].map(threadId => service.setBudget({ ...scope, threadId, enabled: true, amountUsd: 2 })));
    assert.equal((await service.getOverview({ accountId: scope.accountId })).count, 3);
    const otherProcess = createBudgetService({ dataDir: directory, now, readUsage });
    await Promise.all([service.setBudget({ ...scope, threadId: 'gamma', enabled: true, amountUsd: 1 }),
      otherProcess.setBudget({ ...scope, threadId: 'delta', enabled: true, amountUsd: 1 })]);
    assert.equal((await service.getOverview({ accountId: scope.accountId })).count, 5);
    await writeFile(join(directory, 'budgets-v1.lock'), JSON.stringify({pid:2147483647}));
    await service.setBudget({ ...scope, threadId: 'recovered', enabled: true, amountUsd: 1 });
    assert.equal((await service.getBudget({ ...scope, threadId: 'recovered' })).enabled, true);
    const bad = join(directory, 'bad');
    await import('node:fs/promises').then(fs => fs.mkdir(bad));
    await writeFile(join(bad, 'budgets-v1.json'), '{broken');
    await assert.rejects(createBudgetService({ dataDir: bad }).getBudget(scope));
    await writeFile(join(bad, 'budgets-v1.json'), JSON.stringify({schema:1,budgets:{unexpected:{enabled:true,amountMicros:null}}}));
    await assert.rejects(createBudgetService({ dataDir: bad }).getBudget(scope), /Invalid budget/);
  });
  console.log(`${passed} budget service scenarios passed`);
} finally { await rm(directory, { recursive: true, force: true }); }
