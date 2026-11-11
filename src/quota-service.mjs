import { codexQuotaProvider } from './quota-provider.mjs';

export const WEEK_MINUTES = 10080;
export const DEFAULT_MIN_USED_PERCENT = 5;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const priorQuotas = new WeakMap();
const identifier = value => typeof value === 'string' && value.trim() ? value.trim() : null;
function timestamp(value) {
  if (typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    const number = Date.parse(value); return Number.isFinite(number) ? number : null;
  }
  // Official RPC resetsAt uses seconds; public ledger date numbers use milliseconds.
  return finite(value) && Math.abs(value) <= 8640000000000000 ? value : null;
}
const iso = value => finite(value) && Math.abs(value) <= 8640000000000000 ? new Date(value).toISOString() : null;
const reason = (code, severity = 'blocker') => ({ code, severity });
function windowFrom(raw, { poolId, slot, accountId }) {
  const duration = raw?.windowDurationMins ?? raw?.windowMinutes;
  const end = finite(raw?.resetsAt) ? raw.resetsAt * 1000 : timestamp(raw?.resetsAt);
  const start = finite(duration) && duration > 0 && end !== null ? end - duration * 60000 : null;
  const startAt = iso(start), endAt = iso(end);
  const used = finite(raw?.usedPercent) && raw.usedPercent >= 0 && raw.usedPercent <= 100 ? raw.usedPercent : null;
  return { poolId, slot, usedPercent: used, remainingPercent: used === null ? null : 100 - used,
    windowDurationMins: finite(duration) && duration > 0 ? duration : null,
    resetsAt: iso(end), isWeekly: duration === WEEK_MINUTES,
    period: { startAt, endAt, basis: 'official-reset-minus-window-duration',
      identity: accountId && poolId && startAt && endAt ? JSON.stringify([accountId, poolId, start, end]) : null } };
}
function identity(raw) {
  const accountId = identifier(raw?.accountId ?? raw?.id);
  return { accountId, accountRef: identifier(raw?.accountRef), identityStatus: accountId ? 'explicit' : raw?.accountRef ? 'current-login-assumption' : 'unknown',
    // Email cannot distinguish same-email workspaces and is deliberately omitted.
    planType: identifier(raw?.planType), authMode: identifier(raw?.authMode ?? raw?.type) };
}

export function selectWeeklyWindow(quota, poolId) {
  const windows = (quota?.pools ?? []).flatMap(pool => pool.windows ?? [])
    .filter(window => window.isWeekly && (!poolId || window.poolId === poolId));
  if (windows.length !== 1) return { weekly: null,
    reason: windows.length > 1 ? 'weekly_pool_ambiguous' : 'weekly_window_unavailable' };
  return { weekly: windows[0], reason: null };
}

// Accept raw official app-server results assembled with collection/account metadata.
// No primary/secondary position is assigned a cadence without a duration.
export function normalizeQuotaSnapshot(payload, { now = Date.now(), poolId, previousQuota } = {}) {
  const nowMs = timestamp(now);
  const base = { status: 'unavailable', source: null, updatedAt: null, collectedAt: iso(nowMs),
    account: identity(null), pools: [], weekly: null, qualityReasons: [] };
  if (!payload || ['unsupported', 'unavailable'].includes(payload.status)) {
    return { ...base, status: payload?.status ?? 'unavailable', source: payload?.source ?? null,
      qualityReasons: [reason(payload?.reason ?? 'provider_data_unavailable')] };
  }
  let raw = payload.result ?? payload;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...base, qualityReasons: [reason('invalid_provider_payload')] };
  {
    base.source = identifier(raw.source) ?? 'app-server';
    base.account = identity(raw.account);
    base.updatedAt = iso(timestamp(raw.updatedAt));
    // An explicitly empty map must not fall back to the legacy view.
    const buckets = raw.rateLimitsByLimitId && typeof raw.rateLimitsByLimitId === 'object' && !Array.isArray(raw.rateLimitsByLimitId)
      ? Object.entries(raw.rateLimitsByLimitId)
      : raw.rateLimits ? [[identifier(raw.rateLimits.limitId), raw.rateLimits]] : [];
    base.pools = buckets.filter(([, bucket]) => bucket && typeof bucket === 'object').map(([key, bucket]) => {
      const id = identifier(bucket.limitId) ?? identifier(key);
      if (raw.rateLimitsByLimitId && identifier(bucket.limitId) && identifier(key) !== identifier(bucket.limitId))
        base.qualityReasons.push(reason('pool_identity_conflict'));
      return { poolId: id, name: identifier(bucket.limitName), planType: identifier(bucket.planType),
        poolIdentityStatus: id ? 'explicit' : 'unknown',
        windows: ['primary', 'secondary', 'tertiary'].filter(slot => bucket[slot])
          .map(slot => windowFrom(bucket[slot], { poolId: id, slot, accountId: base.account.accountId })) };
    });
  }
  if (base.pools.some(pool => pool.windows.length)) base.status = 'available';
  if (!base.account.accountId) base.qualityReasons.push(reason('local_history_account_pool_assumption', 'warning'));
  const selected = selectWeeklyWindow(base, poolId);
  base.weekly = selected.weekly;
  if (selected.reason) base.qualityReasons.push(reason(selected.reason));
  if (base.weekly) {
    if (!base.weekly.poolId) base.qualityReasons.push(reason('local_history_account_pool_assumption', 'warning'));
    if (base.weekly.usedPercent === null) base.qualityReasons.push(reason('used_percent_unknown'));
    if (!base.weekly.period.startAt) base.qualityReasons.push(reason('period_unknown'));
    const end = timestamp(base.weekly.period.endAt);
    if (end !== null && nowMs !== null && (end <= nowMs || timestamp(base.weekly.period.startAt) > nowMs))
      base.qualityReasons.push(reason('quota_outside_current_period'));
    const previous = previousQuota?.weekly;
    // Compare only the same explicitly identified account and official pool.
    if (previous && (base.account.accountId ?? base.account.accountRef) &&
        (base.account.accountId ?? base.account.accountRef) === (previousQuota.account?.accountId ?? previousQuota.account?.accountRef) &&
        base.weekly.poolId && base.weekly.poolId === previous.poolId) {
      const samePeriod = base.weekly.period.endAt === previous.period?.endAt;
      if (samePeriod && finite(base.weekly.usedPercent) && finite(previous.usedPercent) && base.weekly.usedPercent < previous.usedPercent)
        base.qualityReasons.push(reason('quota_usage_corrected'));
      if (!samePeriod && nowMs < timestamp(previous.period?.endAt))
        base.qualityReasons.push(reason('quota_reset_or_cycle_corrected'));
      if (samePeriod) {
        for (const item of previousQuota.qualityReasons ?? [])
          if (['quota_usage_corrected', 'quota_reset_or_cycle_corrected'].includes(item.code))
            base.qualityReasons.push(reason(item.code));
      }
    }
  }
  base.qualityReasons = [...new Map(base.qualityReasons.map(item => [item.code, item])).values()];
  return base;
}

export async function readQuotaSnapshot({ provider = codexQuotaProvider, timeoutMs = 25000, ...options } = {}) {
  let timer;
  try {
    const payload = await Promise.race([
      Promise.resolve().then(() => provider()),
      new Promise(resolve => { timer = setTimeout(() => resolve({ status: 'unavailable', reason: 'provider_timeout' }), timeoutMs); }),
    ]);
    const previousQuota = options.previousQuota ?? priorQuotas.get(provider);
    const quota = normalizeQuotaSnapshot(payload, { ...options, previousQuota });
    if (quota.status === 'available') priorQuotas.set(provider, quota);
    return quota;
  } catch {
    return normalizeQuotaSnapshot({ status: 'unavailable', reason: 'provider_read_failed' }, options);
  } finally { clearTimeout(timer); }
}

export function estimateWeeklyCapacity({ accountUsage, quota, poolId, now = Date.now(),
  minUsedPercent = DEFAULT_MIN_USED_PERCENT, maxAgeMs = 300000, maxSyncSkewMs = 120000 } = {}) {
  const result = { status: 'unavailable', estimatedCapacityUsd: null, estimatedRemainingUsd: null,
    isEstimate: true, currency: 'USD', costBasis: 'api-equivalent', officialDollarBalance: false,
    updatedAt: quota?.updatedAt ?? null, qualityReasons: [], basis: null,
    observedPeriodUsd: finite(accountUsage?.apiEquivalentUsd) && accountUsage.apiEquivalentUsd >= 0 ? accountUsage.apiEquivalentUsd : null,
    observedCycleUsd: null, cycleApiEquivalentUsd: null, reliability: 'unavailable',
    scope: accountUsage?.scope ?? 'local-observed', accountLedgerComplete: false };
  const add = (code, severity = 'blocker') => result.qualityReasons.push(reason(code, severity));
  if (!finite(minUsedPercent) || minUsedPercent < 1 || minUsedPercent > 100 ||
      !finite(maxAgeMs) || maxAgeMs <= 0 || !finite(maxSyncSkewMs) || maxSyncSkewMs < 0) {
    add('invalid_estimation_options'); return result;
  }
  const selection = selectWeeklyWindow(quota, poolId);
  const weekly = selection.weekly;
  if (quota?.status !== 'available') add('quota_unavailable');
  if (!weekly) { add(selection.reason); return result; }
  const start = timestamp(weekly.period?.startAt), end = timestamp(weekly.period?.endAt);
  const periodAligned = start !== null && end !== null && timestamp(accountUsage?.startAt) === start && timestamp(accountUsage?.endAt) === end;
  if (periodAligned && accountUsage?.costBasis === 'api-equivalent')
    result.observedCycleUsd = result.cycleApiEquivalentUsd = result.observedPeriodUsd;
  result.basis = { accountId: quota?.account?.accountId ?? null, poolId: weekly.poolId,
    period: weekly.period, quotaUpdatedAt: quota?.updatedAt ?? null,
    usageUpdatedAt: accountUsage?.updatedAt ?? null, cycleApiEquivalentUsd: result.observedCycleUsd,
    usedPercent: weekly.usedPercent, formula: 'cycleApiEquivalentUsd / (usedPercent / 100)', minUsedPercent,
    scope: result.scope, precision: accountUsage?.precision ?? 'exact-record-timestamps',
    assumptions: ['Observed local history is treated as usage of the currently selected subscription bucket.',
      'Unobserved devices, deleted records and API-key usage may change the inferred capacity.'],
    deduplication: accountUsage?.deduplication ?? null };
  // Pool selection at this stage resolves an earlier ambiguous presentation selection.
  for (const item of quota?.qualityReasons ?? []) if (
      !(poolId && ['weekly_pool_ambiguous', 'weekly_window_unavailable'].includes(item.code)))
    add(item.code, item.severity ?? 'blocker');
  if (quota?.account?.accountId && accountUsage?.accountId && accountUsage.accountId !== quota.account.accountId) add('account_identity_mismatch');
  if (weekly.poolId && accountUsage?.poolId && accountUsage.poolId !== weekly.poolId) add('pool_identity_mismatch');
  if (!quota?.account?.accountId || !accountUsage?.accountId || !weekly.poolId || !accountUsage?.poolId)
    add('local_history_account_pool_assumption', 'warning');
  if (accountUsage?.conflicts?.accounts || (accountUsage?.accountIds?.length ?? 0) > 1) add('multiple_accounts_in_cycle');
  if (accountUsage?.conflicts?.pools || (accountUsage?.poolIds?.length ?? 0) > 1) add('multiple_pools_in_cycle');
  if (accountUsage?.conflicts?.billingModes) add('mixed_billing_modes_in_cycle');
  if (start === null || end === null) add('period_unknown');
  else if (!periodAligned) add('ledger_period_mismatch');
  const nowMs = timestamp(now), quotaAt = timestamp(quota?.updatedAt), usageAt = timestamp(accountUsage?.updatedAt);
  if (nowMs === null || quotaAt === null || usageAt === null) add('observation_time_unknown');
  else {
    if (nowMs < start || nowMs >= end) add('quota_outside_current_period');
    if (quotaAt < start || quotaAt >= end || usageAt < start || usageAt >= end) add('observation_outside_period');
    if (quotaAt > nowMs || usageAt > nowMs) add('observation_in_future');
    if (nowMs - quotaAt > maxAgeMs || nowMs - usageAt > maxAgeMs) add('observation_stale', 'warning');
    if (Math.abs(quotaAt - usageAt) > maxSyncSkewMs) add('ledger_quota_not_synchronized', 'warning');
  }
  if (!finite(weekly.usedPercent) || weekly.usedPercent < 0 || weekly.usedPercent > 100) add('used_percent_unknown');
  else if (weekly.usedPercent === 0) add('used_percent_zero');
  else if (weekly.usedPercent < minUsedPercent) add('sample_too_small', 'warning');
  if (accountUsage?.estimatedTierRequests > 0) add('service_tier_estimated', 'warning');
  if (accountUsage?.costBasis !== 'api-equivalent') add('cost_basis_unverified');
  if (!finite(accountUsage?.apiEquivalentUsd) || accountUsage.apiEquivalentUsd < 0) add('cycle_cost_unknown');
  else if (accountUsage.apiEquivalentUsd === 0 && weekly.usedPercent > 0) add('positive_quota_without_recorded_cost');
  const coverage = accountUsage?.coverage ?? {};
  if (coverage.periodComplete !== true) add('observed_cycle_subtotal', 'warning');
  if (coverage.accountComplete !== true || coverage.poolComplete !== true) add('local_history_account_pool_assumption', 'warning');
  if (coverage.sourceComplete !== true || coverage.otherDevicesPossible !== false) add('local_history_external_coverage_unknown', 'warning');
  if (coverage.pricingComplete !== true || accountUsage?.unknownPriceCount !== 0) add('observed_priced_subtotal', 'warning');
  result.qualityReasons = [...new Map(result.qualityReasons.map(item => [item.code, item])).values()];
  if (result.qualityReasons.some(item => item.severity === 'blocker')) return result;
  const capacity = accountUsage.apiEquivalentUsd / (weekly.usedPercent / 100);
  if (!Number.isFinite(capacity)) { add('estimate_overflow'); return result; }
  result.status = 'estimated';
  result.reliability = result.qualityReasons.length ? 'limited' : 'qualified';
  result.isLowerBound = !(accountUsage.estimatedTierRequests > 0) && (coverage.periodComplete !== true || coverage.pricingComplete !== true);
  // Dollar cents are display precision only; this is an extrapolation, never an official balance.
  result.estimatedCapacityUsd = Math.round(capacity * 100) / 100;
  result.estimatedRemainingUsd = Math.round(capacity * (1 - weekly.usedPercent / 100) * 100) / 100;
  add('api_equivalent_extrapolation', 'warning');
  add('model_mix_and_rate_weights_may_change', 'warning');
  return result;
}

// Produce only the exact cycle query; callers may still run ordinary account queries
// when this returns unavailable. Never replace absent identity with current login/email.
export function ledgerRequestForQuota(quota, { poolId } = {}) {
  const { weekly, reason: selectionReason } = selectWeeklyWindow(quota, poolId);
  if (!weekly || !weekly.period.startAt || !weekly.period.endAt) {
    return { status: 'unavailable', request: null, reason: selectionReason ?? 'period_unknown' };
  }
  const accountId = quota?.account?.accountId;
  // A known current bucket cannot be used to filter out records whose historical
  // bucket/account were never recorded. In the common email-only RPC case query
  // the whole local cycle and retain the attribution assumption explicitly.
  return { status: 'available', reason: null, scope: accountId ? 'recorded-account' : 'local-observed',
    qualityReasons: accountId ? [] : [reason('local_history_account_pool_assumption', 'warning')],
    request: { ...(accountId ? { accountId, ...(weekly.poolId ? { billingPoolId: weekly.poolId } : {}) } : {}),
      startAt: weekly.period.startAt, endAt: weekly.period.endAt } };
}

// Adapter for A's raw local telemetry. Scope limitations become labelled
// estimation assumptions, not a reason to hide useful observed cycle amounts.
export function accountUsageFromLedger(snapshot, { request } = {}) {
  const coverage = snapshot?.coverage ?? {}, total = snapshot?.total ?? {};
  const parseAmount = value => typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : finite(value) ? value : null;
  const fullAmount = parseAmount(total.amount);
  const knownAmount = parseAmount(total.knownUsd);
  // Preserve a useful priced subtotal when some cycle records lack prices. It
  // remains explicitly partial; never promote it to a complete account bill.
  const amount = fullAmount ?? (total.pricedRequests > 0 ? parseAmount(total.observedUsd) ?? knownAmount : null);
  const partialFilter = ['model', 'project', 'threadId', 'conversationId', 'provider', 'search', 'archived', 'subagent']
    .some(key => request?.[key] !== undefined && request?.[key] !== null && request?.[key] !== '') || request?.unpricedOnly === true;
  const exactRequest = request && (!request.accountId || request.accountId === snapshot?.accountId) &&
    timestamp(request.startAt) !== null && timestamp(request.startAt) === timestamp(snapshot?.period?.startAt) &&
    timestamp(request.endAt) === timestamp(snapshot?.period?.endAt) && !partialFilter;
  const ids = rows => [...new Set((rows ?? []).map(row => identifier(row.id)).filter(Boolean))];
  const accountIds = ids(snapshot?.byAccount), poolIds = ids(snapshot?.byBillingPool);
  const billingModes = ids(snapshot?.byBillingMode);
  const sampleModes = (snapshot?.records ?? []).map(row => identifier(row.billingMode)).filter(Boolean);
  const hasApiKeyMode = [...billingModes, ...sampleModes].some(mode => /^(?:api|apikey|api-key|api_key)$/i.test(mode));
  return { accountId: snapshot?.accountId ?? (accountIds.length === 1 ? accountIds[0] : null),
    poolId: exactRequest ? request.billingPoolId ?? (poolIds.length === 1 ? poolIds[0] : null) : null,
    accountIds, poolIds, conflicts: { accounts: accountIds.length > 1, pools: poolIds.length > 1, billingModes: hasApiKeyMode || billingModes.length > 1 },
    source: snapshot?.source ?? 'local-request-ledger', scope: request?.accountId ? 'recorded-account-local' : 'local-observed',
    precision: 'exact-record-timestamps', costComplete: fullAmount !== null && total.costComplete === true,
    knownSubtotal: fullAmount === null && amount !== null,
    tokens: total.totalTokens ?? total.knownTokens?.totalTokens ?? null, tokenBreakdown: {
      input: total.input ?? null, cacheRead: total.cacheRead ?? null, cacheWrite: total.cacheWrite ?? null,
      output: total.output ?? null, reasoning: total.reasoning ?? null, total: total.totalTokens ?? null },
    byModel: snapshot?.byModel ?? [],
    deduplication: { source: 'local-request-ledger', policy: 'Only A-owned request deltas; inherited fork/subagent history and duplicate copies excluded.',
      conflicts: coverage.conflictingRequests ?? 0, unresolved: coverage.ownershipUnresolvedRequests ?? 0 },
    startAt: snapshot?.period?.startAt ?? null, endAt: snapshot?.period?.endAt ?? null,
    updatedAt: snapshot?.observedAt ?? null, apiEquivalentUsd: finite(amount) ? amount : null,
    costBasis: snapshot?.pricing?.kind === 'API equivalent' && snapshot?.pricing?.currency === 'USD' ? 'api-equivalent' : null,
    unknownPriceCount: total.unpricedRequests ?? null,
    estimatedTierRequests: total.estimatedTierRequests ?? null,
    coverage: {
      periodComplete: exactRequest && coverage.timeFilterExact === true && coverage.usageComplete === true && coverage.localScanComplete === true,
      accountComplete: coverage.accountAttributionComplete === true,
      poolComplete: exactRequest && coverage.unknownPoolRequests === 0,
      pricingComplete: total.costComplete === true,
      sourceComplete: false, otherDevicesPossible: true,
    } };
}
