import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQuotaSnapshot, readQuotaSnapshot, estimateWeeklyCapacity, ledgerRequestForQuota, accountUsageFromLedger, WEEK_MINUTES } from '../src/quota-service.mjs';
import { createCodexQuotaProvider, readCodexAppServer, CODEX_QUOTA_ARGS } from '../src/quota-provider.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

const now = Date.parse('2026-10-01T04:00:00Z');
const end = Date.parse('2026-10-05T12:34:00Z');
const raw = () => ({ source: 'synthetic-official-rpc', account: { accountId: 'account-1', type: 'chatgpt' },
  updatedAt: new Date(now).toISOString(), rateLimits: { limitId: 'legacy', primary: { usedPercent: 99, windowDurationMins: WEEK_MINUTES, resetsAt: end / 1000 } },
  rateLimitsByLimitId: { codex: { limitId: 'codex', primary: { usedPercent: 25, windowDurationMins: WEEK_MINUTES, resetsAt: end / 1000 },
    secondary: { usedPercent: 90, windowDurationMins: 300, resetsAt: (now + 300000) / 1000 } } } });
const quota = () => normalizeQuotaSnapshot(raw(), { now });
const ledger = q => ({ accountId: 'account-1', poolId: 'codex', ...q.weekly.period,
  updatedAt: new Date(now).toISOString(), apiEquivalentUsd: 100, costBasis: 'api-equivalent', unknownPriceCount: 0,
  coverage: { periodComplete: true, accountComplete: true, sourceComplete: true, pricingComplete: true,
    poolComplete: true, otherDevicesPossible: false } });
const estimate = (q = quota(), usage = ledger(q), options = {}) => estimateWeeklyCapacity({ quota: q, accountUsage: usage, now, ...options });
const codes = result => result.qualityReasons.map(item => item.code);

test('whole official cycle $100 / 25% = $400, reset-derived period never assumes Monday', () => {
  const q = quota(), result = estimate(q);
  assert.equal(q.weekly.slot, 'primary');
  assert.equal(q.weekly.period.startAt, '2026-09-28T12:34:00.000Z');
  assert.equal(q.pools.length, 1);
  assert.equal(q.pools[0].poolId, 'codex');
  assert.equal(result.status, 'estimated');
  assert.equal(result.estimatedCapacityUsd, 400);
  assert.equal(result.estimatedRemainingUsd, 300);
  assert.equal(result.officialDollarBalance, false);
  assert.equal(result.basis.cycleApiEquivalentUsd, 100);
});

test('secondary window without week duration does not qualify', () => {
  const data = raw(); data.rateLimitsByLimitId.codex.primary.windowDurationMins = 60;
  const q = normalizeQuotaSnapshot(data, { now });
  assert.equal(q.weekly, null);
  assert.ok(codes(q).includes('weekly_window_unavailable'));
});

test('multiple weekly pools require selection and preserve each pool', () => {
  const data = raw(); data.rateLimitsByLimitId.spark = { primary: { usedPercent: 10, windowDurationMins: WEEK_MINUTES, resetsAt: end / 1000 } };
  const ambiguous = normalizeQuotaSnapshot(data, { now });
  assert.equal(ambiguous.pools.length, 2);
  assert.equal(ambiguous.weekly, null);
  assert.ok(codes(ambiguous).includes('weekly_pool_ambiguous'));
  const selected = normalizeQuotaSnapshot(data, { now, poolId: 'spark' });
  assert.equal(selected.weekly.poolId, 'spark');
  assert.equal(selected.weekly.usedPercent, 10);
});

test('explicit empty multi-pool map never falls back to stale legacy bucket', () => {
  const data = raw(); data.rateLimitsByLimitId = {};
  assert.equal(normalizeQuotaSnapshot(data, { now }).weekly, null);
});

test('missing reset, used percent and account stay unknown, including known zero', () => {
  const data = raw(); delete data.account.accountId;
  data.rateLimitsByLimitId.codex.primary.usedPercent = null;
  delete data.rateLimitsByLimitId.codex.primary.resetsAt;
  const q = normalizeQuotaSnapshot(data, { now });
  assert.equal(q.weekly.usedPercent, null);
  assert.equal(q.weekly.remainingPercent, null);
  assert.equal(q.weekly.period.startAt, null);
  assert.equal(q.account.accountId, null);
  data.rateLimitsByLimitId.codex.primary.usedPercent = 0;
  assert.equal(normalizeQuotaSnapshot(data, { now }).weekly.remainingPercent, 100);
});

test('real Codex app-server schema: email-only identity and primary weekly bucket still permit scoped local estimate', () => {
  const data = raw(); data.source = 'codex-app-server'; data.account = { type: 'chatgpt', planType: 'pro' };
  data.rateLimitsByLimitId.codex.primary.usedPercent = 35;
  const q = normalizeQuotaSnapshot(data, { now }), query = ledgerRequestForQuota(q);
  assert.equal(q.weekly.poolId, 'codex'); assert.equal(q.account.accountId, null);
  assert.deepEqual(query.request, { startAt: q.weekly.period.startAt, endAt: q.weekly.period.endAt });
  const usage = { ...ledger(q), accountId: null, poolId: null, apiEquivalentUsd: 596.07,
    scope: 'local-observed', coverage: { periodComplete: true, pricingComplete: true, sourceComplete: false, otherDevicesPossible: true } };
  const result = estimate(q, usage);
  assert.equal(result.status, 'estimated'); assert.equal(result.reliability, 'limited');
  assert.equal(result.estimatedCapacityUsd, 1703.06);
  assert.equal(result.observedCycleUsd, 596.07);
  assert.equal(result.accountLedgerComplete, false);
  assert.equal(result.qualityReasons.filter(x => x.code === 'local_history_account_pool_assumption').length, 1);
});

test('API equivalent cycle contract rejects all-history or short interval increments', () => {
  const q = quota(), usage = ledger(q);
  usage.startAt = new Date(now - 3600000).toISOString();
  usage.endAt = new Date(now).toISOString();
  const result = estimate(q, usage);
  assert.equal(result.estimatedCapacityUsd, null);
  assert.ok(codes(result).includes('ledger_period_mismatch'));
});

test('absent costs and explicit identity/pool conflicts block; low positive fraction is labelled', () => {
  const changes = [
    ['accountId', 'account-other', 'account_identity_mismatch'],
    ['poolId', 'spark', 'pool_identity_mismatch'],
    ['apiEquivalentUsd', null, 'cycle_cost_unknown'],
    ['costBasis', 'subscription-charge', 'cost_basis_unverified'],
  ];
  for (const [key, value, code] of changes) {
    const q = quota(), usage = ledger(q); usage[key] = value;
    const result = estimate(q, usage);
    assert.equal(result.estimatedCapacityUsd, null, code); assert.ok(codes(result).includes(code), code);
  }
  for (const fraction of [0.1, 4.9]) {
    const data = raw(); data.rateLimitsByLimitId.codex.primary.usedPercent = fraction;
    const q = normalizeQuotaSnapshot(data, { now });
    assert.ok(codes(estimate(q)).includes('sample_too_small'));
    assert.equal(estimate(q).status, 'estimated');
  }
});

test('coverage and unpriced uncertainty produce labelled estimates instead of hiding observed values', () => {
  for (const patch of [{ otherDevicesPossible: true }, { sourceComplete: false }, { poolComplete: false },
    { accountComplete: false }, { pricingComplete: false }, { periodComplete: false }]) {
    const q = quota(), usage = ledger(q); Object.assign(usage.coverage, patch);
    const result = estimate(q, usage);
    assert.equal(result.status, 'estimated'); assert.equal(result.observedCycleUsd, 100);
    assert.ok(result.qualityReasons.some(item => item.severity === 'warning'));
  }
});

test('stale and unsynchronized samples retain qualified values; actual cycle mismatch blocks', () => {
  const q = quota(), usage = ledger(q);
  usage.updatedAt = new Date(now - 180000).toISOString();
  assert.ok(codes(estimate(q, usage)).includes('ledger_quota_not_synchronized'));
  usage.updatedAt = new Date(now - 600000).toISOString();
  assert.ok(codes(estimate(q, usage)).includes('observation_stale'));
  assert.ok(codes(estimate(q, ledger(q), { now: end })).includes('quota_outside_current_period'));
});

test('quota correction and early reset are rejected; normal reset starts independent cycle', () => {
  const previousQuota = quota(), data = raw();
  data.rateLimitsByLimitId.codex.primary.usedPercent = 20;
  assert.ok(codes(normalizeQuotaSnapshot(data, { now, previousQuota })).includes('quota_usage_corrected'));
  data.rateLimitsByLimitId.codex.primary.resetsAt += 3600;
  assert.ok(codes(normalizeQuotaSnapshot(data, { now, previousQuota })).includes('quota_reset_or_cycle_corrected'));
  data.rateLimitsByLimitId.codex.primary.resetsAt = (end + WEEK_MINUTES * 60000) / 1000;
  const q = normalizeQuotaSnapshot(data, { now: end + 1, previousQuota });
  assert.ok(!codes(q).includes('quota_reset_or_cycle_corrected'));
  assert.notEqual(q.weekly.period.identity, previousQuota.weekly.period.identity);
});

test('provider exceptions and timeouts do not leak raw stderr or credentials', async () => {
  let result = await readQuotaSnapshot({ provider: async () => { throw new Error('secret-auth-token'); }, now });
  assert.equal(result.status, 'unavailable'); assert.ok(!JSON.stringify(result).includes('secret'));
  result = await readQuotaSnapshot({ provider: () => new Promise(() => {}), now, timeoutMs: 5 });
  assert.ok(codes(result).includes('provider_timeout'));
});

test('standard Codex discovery and concurrent refreshes coalesce', async () => {
  let calls = 0, clock = now;
  const lookedUp = [];
  const provider = createCodexQuotaProvider({ candidates: ['/no-codex'], path: '/fixture/bin', clock: () => clock,
    canExecute: async path => { lookedUp.push(path); if (path !== '/fixture/bin/codex') throw new Error('missing'); },
    rpc: async options => {
      calls++; assert.equal(options.executable, '/fixture/bin/codex');
      await new Promise(resolve => setTimeout(resolve, 5)); return raw();
    } });
  await Promise.all([provider(), provider(), provider()]); assert.equal(calls, 1);
  await provider(); assert.equal(calls, 1);
  clock += 60001; await provider(); assert.equal(calls, 2);
  assert.deepEqual(lookedUp.slice(0, 2), ['/no-codex', '/fixture/bin/codex']);
});

test('missing Codex reports unsupported and RPC failure never leaks raw account/error content', async () => {
  const missing = createCodexQuotaProvider({ candidates: ['/missing'], path: '', canExecute: async () => { throw new Error(); } });
  assert.equal((await missing()).status, 'unsupported');
  const failure = createCodexQuotaProvider({ executable: '/fixture', rpc: async () => { throw new Error('secret'); } });
  assert.ok(!JSON.stringify(await failure()).includes('secret'));
});

test('A adapter requests exact cycle and never treats local subtotal as full account coverage', () => {
  const q = quota(), { request } = ledgerRequestForQuota(q);
  assert.deepEqual(request, { accountId: 'account-1', billingPoolId: 'codex', startAt: q.weekly.period.startAt, endAt: q.weekly.period.endAt });
  const snapshot = { accountId: 'account-1', observedAt: now, period: { startAt: Date.parse(request.startAt), endAt: Date.parse(request.endAt) },
    pricing: { kind: 'API equivalent', currency: 'USD' }, total: { amount: '100.00', knownUsd: '999.00', costComplete: true, unpricedRequests: 0 },
    coverage: { timeFilterExact: true, usageComplete: true, localScanComplete: true, accountAttributionComplete: true, unknownPoolRequests: 0 } };
  let adapted = accountUsageFromLedger(snapshot, { request });
  assert.equal(adapted.apiEquivalentUsd, 100);
  assert.equal(adapted.coverage.periodComplete, true);
  assert.equal(adapted.coverage.sourceComplete, false);
  assert.equal(adapted.coverage.otherDevicesPossible, true);
  assert.equal(estimate(q, adapted).estimatedCapacityUsd, 400);
  snapshot.total.amount = null;
  adapted = accountUsageFromLedger(snapshot, { request });
  assert.equal(adapted.apiEquivalentUsd, null, 'never fallback to knownUsd subtotal');
  snapshot.total.amount = '';
  assert.equal(accountUsageFromLedger(snapshot, { request }).apiEquivalentUsd, null);
  for (const filter of [{ model: 'gpt-test' }, { archived: false }, { subagent: false }, { threadId: 'thread-one' }]) {
    assert.equal(accountUsageFromLedger(snapshot, { request: { ...request, ...filter } }).coverage.periodComplete, false);
  }
  assert.ok(ledgerRequestForQuota({ ...q, account: { accountId: null } }).request);
});

test('reader retains correction evidence during same cycle, independent of UI refresh', async () => {
  let used = 25;
  const provider = async () => { const data = raw(); data.rateLimitsByLimitId.codex.primary.usedPercent = used; return data; };
  await readQuotaSnapshot({ provider, now });
  used = 20;
  const correction = await readQuotaSnapshot({ provider, now });
  assert.ok(codes(correction).includes('quota_usage_corrected'));
  const repeat = await readQuotaSnapshot({ provider, now });
  assert.ok(codes(repeat).includes('quota_usage_corrected'));
});

test('invalid dates and estimator options fail closed rather than returning invented dollars', () => {
  const data = raw(); data.rateLimitsByLimitId.codex.primary.resetsAt = 1e300;
  const q = normalizeQuotaSnapshot(data, { now });
  assert.equal(q.weekly.period.endAt, null);
  assert.equal(q.weekly.period.startAt, null);
  assert.equal(q.weekly.period.identity, null);
  assert.ok(codes(estimate(quota(), ledger(quota()), { minUsedPercent: NaN })).includes('invalid_estimation_options'));
  assert.ok(codes(estimate(quota(), ledger(quota()), { maxAgeMs: Infinity })).includes('invalid_estimation_options'));
});

test('conflicting official map key and declared pool identity block estimates', () => {
  const data = raw(); data.rateLimitsByLimitId.codex.limitId = 'spark';
  const q = normalizeQuotaSnapshot(data, { now });
  assert.ok(codes(q).includes('pool_identity_conflict'));
  const usage = ledger(q); usage.poolId = 'spark';
  assert.equal(estimate(q, usage).estimatedCapacityUsd, null);
});

function rpcChild(respond) {
  const child = new EventEmitter(); child.exitCode = null; child.stdout = new PassThrough();
  child.stdin = new Writable({ write(chunk, _encoding, callback) {
    const message = JSON.parse(chunk.toString());
    queueMicrotask(() => {
      const result = respond(message);
      if (result !== undefined) child.stdout.write(typeof result === 'string' ? result : JSON.stringify({ id: message.id, result }) + '\n');
    });
    callback();
  } });
  child.kill = () => { child.exitCode = 0; queueMicrotask(() => child.emit('close', 0)); return true; };
  return child;
}

test('official app-server performs only initialization and two account reads, redacts identity and reaps process', async () => {
  const methods = [];
  const child = rpcChild(message => {
    methods.push(message.method);
    if (message.method === 'initialize') return { userAgent: 'fixture' };
    if (message.method === 'account/read') {
      assert.deepEqual(message.params, { refreshToken: false });
      return { account: { type: 'chatgpt', email: 'private@example.test', planType: 'pro' } };
    }
    if (message.method === 'account/rateLimits/read') return raw();
  });
  const result = await readCodexAppServer({ executable: '/fixture/codex', clock: () => now,
    spawnProcess: (path, args, options) => {
      assert.equal(path, '/fixture/codex'); assert.deepEqual(args, [...CODEX_QUOTA_ARGS]);
      assert.deepEqual(options.stdio, ['pipe', 'pipe', 'ignore']); return child;
    } });
  assert.deepEqual(methods, ['initialize', 'initialized', 'account/read', 'account/rateLimits/read']);
  assert.equal(result.account.accountId, null); assert.equal(result.account.accountRef.length, 64);
  assert.ok(!JSON.stringify(result).includes('private@example'));
  assert.equal(child.exitCode, 0); assert.equal(result.source, 'codex-app-server');
});

test('absent login and API-key-only auth return concrete unsupported quota reason without starting login', async () => {
  for (const account of [null, { type: 'apiKey' }]) {
    const methods = [], child = rpcChild(message => {
      methods.push(message.method);
      if (message.method === 'initialize') return {};
      if (message.method === 'account/read') return { account };
    });
    const value = await readCodexAppServer({ executable: '/fixture', spawnProcess: () => child });
    assert.equal(value.status, 'unavailable'); assert.equal(methods.includes('account/rateLimits/read'), false);
    assert.equal(value.reason, account ? 'chatgpt_quota_not_supported_for_auth_mode' : 'codex_login_required');
  }
});

test('malformed wire data and hung RPC have bounded cleanup and safe errors', async () => {
  const malformed = rpcChild(message => message.id ? 'not-json\n' : undefined);
  await assert.rejects(readCodexAppServer({ executable: '/fixture', spawnProcess: () => malformed }), { code: 'invalid_provider_payload' });
  assert.equal(malformed.exitCode, 0);
  const hung = rpcChild(() => undefined);
  await assert.rejects(readCodexAppServer({ executable: '/fixture', spawnProcess: () => hung, timeoutMs: 5 }), { code: 'provider_timeout' });
  assert.equal(hung.exitCode, 0);
});

test('server credential-refresh request cannot be mistaken for an account response', async () => {
  const child = rpcChild(message => message.id ? JSON.stringify({ id: message.id, method: 'account/chatgptAuthTokens/refresh', params: {} }) + '\n' : undefined);
  await assert.rejects(readCodexAppServer({ executable: '/fixture', spawnProcess: () => child }), { code: 'external_auth_host_required' });
  assert.equal(child.exitCode, 0);
});

test('API-equivalent cycle cost stays visible when zero percentage prevents capacity calculation', () => {
  const data = raw(); data.rateLimitsByLimitId.codex.primary.usedPercent = 0;
  const q = normalizeQuotaSnapshot(data, { now }), result = estimate(q);
  assert.equal(result.status, 'unavailable'); assert.equal(result.observedCycleUsd, 100);
  assert.equal(result.estimatedCapacityUsd, null); assert.ok(codes(result).includes('used_percent_zero'));
  assert.equal(estimate(quota(), { ...ledger(quota()), apiEquivalentUsd: 0 }).estimatedCapacityUsd, null);
});

test('partial priced cycle retains known subtotal, exact range, token fields and conflict evidence', () => {
  const q = quota(), request = ledgerRequestForQuota(q).request;
  const snapshot = { accountId: request.accountId, source: 'local-request-ledger', observedAt: now,
    period: request, pricing: { kind: 'API equivalent', currency: 'USD' },
    total: { amount: null, knownUsd: '50', observedUsd: '50', requestCount: 3, pricedRequests: 2, unpricedRequests: 1, costComplete: false,
      input: 900, cacheRead: 500, output: 100, reasoning: 20, totalTokens: 1000 },
    coverage: { timeFilterExact: true, localScanComplete: true, usageComplete: true },
    byAccount: [{ id: 'account-1' }], byBillingPool: [{ id: 'codex' }] };
  let input = accountUsageFromLedger(snapshot, { request });
  assert.equal(input.apiEquivalentUsd, 50); assert.equal(input.knownSubtotal, true); assert.equal(input.tokens, 1000);
  assert.equal(input.tokenBreakdown.reasoning, 20); assert.equal(estimate(q, input).estimatedCapacityUsd, 200);
  assert.equal(estimate(q, input).isLowerBound, true);
  snapshot.byAccount.push({ id: 'account-2' }); input = accountUsageFromLedger(snapshot, { request });
  assert.ok(codes(estimate(q, input)).includes('multiple_accounts_in_cycle'));
  snapshot.byAccount.pop(); snapshot.byBillingPool.push({ id: 'spark' });
  assert.ok(codes(estimate(q, accountUsageFromLedger(snapshot, { request }))).includes('multiple_pools_in_cycle'));
  snapshot.byBillingPool.pop(); snapshot.byBillingMode = [{ id: 'apiKey' }];
  assert.ok(codes(estimate(q, accountUsageFromLedger(snapshot, { request }))).includes('mixed_billing_modes_in_cycle'));
  snapshot.total.pricedRequests = 0;
  assert.equal(accountUsageFromLedger(snapshot, { request }).apiEquivalentUsd, null);
});
