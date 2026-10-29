// Explicit, conversation-scoped soft budgets. No timers, requests or global rules.
import { mkdir, readFile, writeFile, rename, unlink, open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const SCALE = 1_000_000;
const hash = value => createHash('sha256').update(value).digest('hex');
const keyFor = (accountId, threadId) => hash(JSON.stringify([accountId, threadId]));
const clone = value => structuredClone(value);
const micros = value => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.round(value * SCALE))) throw new Error('Invalid API equivalent amount');
  return Math.round(value * SCALE);
};
const iso = value => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid timestamp');
  return date.toISOString();
};
const identity = value => {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Explicit accountId and threadId are required');
  return value;
};
const money = value => `$${value.toFixed(2)}`;
const EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'SubagentStart', 'PreToolUse', 'manual']);

function freezeEstimate(estimate, accountId, timestamp) {
  // Accept B's real result directly as well as E's normalized wrapper.
  const basis = estimate?.basis || {};
  if (!estimate || (estimate.accountId ?? basis.accountId) !== accountId || !['available','estimated'].includes(estimate.status)
    || estimate.qualityReasons?.some(reason => reason.severity === 'blocker')) throw new Error('A usable same-account weekly estimate is required');
  const capacity = micros(estimate.capacityUsd ?? estimate.estimatedCapacityUsd);
  const period = estimate.period ?? basis.period;
  const observed = estimate.observedAt ?? estimate.updatedAt;
  if (!capacity || !period?.startAt || !period?.endAt || !observed) throw new Error('Weekly estimate period and observation are required');
  const startAt = iso(period.startAt), endAt = iso(period.endAt);
  if (startAt >= endAt) throw new Error('Invalid estimate period');
  const observedAt = iso(observed);
  if (observedAt < startAt || observedAt >= endAt || observedAt > timestamp || timestamp >= endAt) throw new Error('Weekly estimate is outside the current official period');
  const usedFraction = estimate.usedFraction ?? (typeof basis.usedPercent === 'number' ? basis.usedPercent / 100 : null);
  if (typeof usedFraction !== 'number' || !Number.isFinite(usedFraction) || usedFraction <= 0 || usedFraction > 1) throw new Error('Weekly estimate used fraction is required');
  const knownPeriodUsd = micros(estimate.knownPeriodUsd ?? basis.cycleApiEquivalentUsd) / SCALE;
  // B rounds its displayed capacity to cents; tolerate that precision, not a different formula.
  if (!knownPeriodUsd || Math.abs(knownPeriodUsd / usedFraction - capacity / SCALE) > Math.max(0.00501, capacity / SCALE * 0.000001)) throw new Error('Weekly estimate must use cycle cumulative cost divided by used fraction');
  // Whitelist: never persist upstream raw credentials, account email, or chat text.
  return { accountId, status: 'available', capacityUsd: capacity / SCALE,
    period: { startAt, endAt }, observedAt,
    usedFraction, knownPeriodUsd,
    poolId: typeof (estimate.poolId ?? basis.poolId) === 'string' ? identity(estimate.poolId ?? basis.poolId) : null,
    formula: 'cycleApiEquivalentUsd / (usedPercent / 100)',
    reliability: ['high','limited','low'].includes(estimate.reliability) ? estimate.reliability : 'limited',
    source: 'same-account-official-weekly-cycle' };
}

function normalizeUsage(raw, scope, startAt, endAt) {
  const base = { knownUsd: null, costComplete: false, unknownCostCount: null, pending: null,
    observedAt: null, status: 'unavailable', reason: 'ledger-unavailable' };
  if (!raw || raw.accountId !== scope.accountId || raw.rootThreadId !== scope.rootThreadId || raw.scopeVerified !== true) return { ...base, reason: 'ledger-scope-unverified' };
  try {
    if (startAt > endAt || iso(raw.startAt) !== startAt || iso(raw.endAt) !== endAt) return { ...base, reason: 'ledger-period-mismatch' };
    const knownUsd = micros(raw.knownUsd) / SCALE;
    const observedAt = iso(raw.observedAt);
    // A scans asynchronously: observedAt may be after the requested exclusive end.
    if (observedAt < startAt) return { ...base, reason: 'ledger-observation-before-epoch' };
    const unknownCostCount = Number.isSafeInteger(raw.unknownCostCount) && raw.unknownCostCount >= 0 ? raw.unknownCostCount : null;
    const pending = typeof raw.pending === 'boolean' ? raw.pending : null;
    const costComplete = raw.costComplete === true && unknownCostCount === 0;
    return { knownUsd, costComplete, unknownCostCount, pending, observedAt,
      status: costComplete ? 'observed' : 'partial', reason: costComplete ? null : 'unpriced-or-incomplete-ledger' };
  } catch { return { ...base, reason: 'invalid-ledger-observation' }; }
}

function summarize(record, usage, requestedThreadId) {
  const amountUsd = record.amountMicros / SCALE;
  const spent = usage.knownUsd;
  const remainingKnownUsd = spent === null ? null : (record.amountMicros - micros(spent)) / SCALE;
  const remainingUsd = usage.costComplete ? remainingKnownUsd : null;
  const over = remainingKnownUsd !== null && remainingKnownUsd < 0;
  const near = remainingKnownUsd !== null && remainingKnownUsd <= amountUsd * 0.15;
  const status = over ? 'overspent' : !usage.costComplete ? 'unknown' : near ? 'low' : 'active';
  return { enabled: true, status, accountId: record.accountId, threadId: requestedThreadId,
    rootThreadId: record.threadId, sharedWithRoot: requestedThreadId !== record.threadId,
    epoch: record.epoch, revision: record.revision, mode: record.mode, percent: record.percent,
    amountUsd, spentKnownUsd: spent, remainingUsd, remainingKnownUsd,
    remainingIsUpperBound: !usage.costComplete && remainingKnownUsd !== null,
    effectiveAt: record.effectiveAt, updatedAt: record.updatedAt,
    estimate: record.estimate, observation: usage,
    delivery: record.delivery || { status: 'not-delivered', hostVerified: false },
    softOnly: true, canContinue: true };
}

export function formatBudgetContext(budget) {
  if (!budget?.enabled) return '';
  const spent = budget.spentKnownUsd === null ? '未知' : money(budget.spentKnownUsd);
  const remaining = budget.remainingUsd === null ? '未知（存在缺失或未计价费用）' : money(budget.remainingUsd);
  const pending = budget.observation.pending !== false ? '；在途费用尚未完全入账' : '';
  const notice = budget.status === 'overspent' ? '已记录费用超过预算；依据已记录工作简短说明原因及收尾范围。' : budget.status === 'low' ? '余额较低；预计不足时提前说明可完成范围和建议。' : '预计预算不足时提前说明可完成范围和建议。';
  return `Gauge 可选软预算：本对话及明确归属子代理共享固定 ${money(budget.amountUsd)} API 等价预算，自 ${budget.effectiveAt} 生效。已记录 ${spent}，剩余 ${remaining}${pending}（观测：${budget.observation.observedAt || '未知'}）。${notice}按预算安排范围与投入，保留必要验证和收尾；不强制停止、不阻止工具、不自动改变模型或思考强度、不自行加预算。最终回复后的入账差额在下一次交互补说明，不为解释费用自动开启新轮次。`;
}

/** readUsage receives [effectiveAt, now), including verified descendants and deduplication.
 * resolveLineage must be trusted telemetry; never infer a root from cwd or a fork.
 */
export function createBudgetService({ dataDir, readUsage, resolveLineage, now = () => new Date(), minReminderMs = 60_000 } = {}) {
  if (!dataDir) throw new Error('A private plugin dataDir is required');
  const file = join(dataDir, 'budgets-v1.json');
  const lock = join(dataDir, 'budgets-v1.lock');
  let queue = Promise.resolve();
  const clock = () => iso(now());
  async function acquireLock() {
    for (let attempt = 0; attempt < 5; attempt++) {
      let handle;
      try {
        handle = await open(lock, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid }));
        return handle;
      } catch (e) {
        if (handle) { await handle.close(); await unlink(lock).catch(() => {}); throw e; }
        if (e.code !== 'EEXIST') throw e;
        // Recover only a positively dead owner (or an old incomplete creation).
        // Inode checks avoid removing a replacement lock while inspecting its owner.
        try {
          const original = await stat(lock);
          let owner;
          try { owner = JSON.parse(await readFile(lock, 'utf8')); } catch { owner = null; }
          let dead = false;
          if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
            try { process.kill(owner.pid, 0); } catch (error) { dead = error.code === 'ESRCH'; }
          } else dead = Date.now() - original.mtimeMs > 120_000;
          const current = await stat(lock);
          if (dead && current.ino === original.ino && current.dev === original.dev) await unlink(lock);
        } catch { /* A contender may have released its own lock. */ }
        if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 30));
      }
    }
    throw new Error('Budget store busy; retry');
  }
  async function load() {
    try {
      const data = JSON.parse(await readFile(file, 'utf8'));
      if (data.schema !== 1 || !data.budgets || typeof data.budgets !== 'object' || Array.isArray(data.budgets)) throw new Error('Invalid budget store');
      for (const [key, record] of Object.entries(data.budgets)) {
        if (!record || typeof record.enabled !== 'boolean' || !Number.isSafeInteger(record.amountMicros)
          || record.amountMicros <= 0 || !Number.isSafeInteger(record.revision) || record.revision < 1
          || !['amount','percentage'].includes(record.mode)
          || key !== keyFor(identity(record.accountId), identity(record.threadId))
          || !identity(record.epoch) || iso(record.effectiveAt) !== record.effectiveAt
          || iso(record.updatedAt) !== record.updatedAt) throw new Error('Invalid budget record');
      }
      return data;
    } catch (e) { if (e.code === 'ENOENT') return { schema: 1, budgets: {} }; throw e; }
  }
  async function mutate(fn) {
    const task = queue.then(async () => {
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      // A separate process (hook) may race a panel save. Never overwrite a lost update.
      const handle = await acquireLock();
      let temp;
      try {
        const data = await load();
        const result = await fn(data);
        temp = `${file}.${randomUUID()}.tmp`;
        await writeFile(temp, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
        await rename(temp, file);
        return result;
      } finally {
        if (temp) await unlink(temp).catch(() => {});
        await handle.close();
        await unlink(lock);
      }
    });
    queue = task.catch(() => {});
    return task;
  }
  async function scopeFor(request) {
    const accountId = identity(request.accountId), threadId = identity(request.threadId);
    let rootThreadId = threadId;
    if (resolveLineage) {
      const relation = await resolveLineage({ accountId, threadId });
      if (relation?.verified === true && relation.relationship === 'subagent') rootThreadId = identity(relation.rootThreadId);
    }
    return { accountId, threadId, rootThreadId, key: keyFor(accountId, rootThreadId) };
  }
  const disabled = (scope, record) => ({ enabled: false, status: 'disabled', accountId: scope.accountId,
    threadId: scope.threadId, rootThreadId: scope.rootThreadId, disabledAt: record?.disabledAt || null,
    context: '', delivery: { status: 'disabled', hostVerified: false },
    historicalContextCannotBeRetracted: !!record, softOnly: true });
  async function observe(scope, record) {
    const endAt = clock();
    let raw;
    try {
      if (readUsage) raw = await readUsage({ accountId: scope.accountId, threadId: scope.rootThreadId,
        startAt: record.effectiveAt, endAt, includeDescendants: true });
    } catch { /* Unknown is never a zero charge. */ }
    return normalizeUsage(raw, scope, record.effectiveAt, endAt);
  }
  async function getBudget(request) {
    const scope = await scopeFor(request);
    const record = (await load()).budgets[scope.key];
    if (!record?.enabled) return disabled(scope, record); // No ledger IO in disabled path.
    const usage = await observe(scope, record);
    return summarize(record, usage, scope.threadId);
  }
  async function setBudget(request) {
    if (request.enabled === false) return disableBudget(request);
    if (request.enabled !== true) throw new Error('Explicit enabled:true is required');
    const scope = await scopeFor(request);
    const mode = request.mode || 'amount';
    let amountMicros, estimate = null, percent = null;
    if (mode === 'amount') amountMicros = micros(request.amountUsd);
    else if (mode === 'percentage') {
      if (typeof request.percent !== 'number' || !Number.isFinite(request.percent) || request.percent <= 0 || request.percent > 100) throw new Error('Percent must be greater than 0 and at most 100');
      percent = request.percent;
      estimate = freezeEstimate(request.estimate, scope.accountId, clock());
      amountMicros = micros(estimate.capacityUsd * percent / 100);
    } else throw new Error('Invalid budget mode');
    if (!amountMicros) throw new Error('Budget must be positive');
    await mutate(data => {
      const previous = data.budgets[scope.key];
      const timestamp = clock();
      const retain = previous?.enabled === true && request.resetEpoch !== true;
      data.budgets[scope.key] = { accountId: scope.accountId, threadId: scope.rootThreadId, enabled: true,
        amountMicros, mode, percent, estimate, epoch: retain ? previous.epoch : randomUUID(),
        effectiveAt: retain ? previous.effectiveAt : timestamp, updatedAt: timestamp,
        revision: (previous?.revision || 0) + 1,
        delivery: { status: 'pending-model-interaction', hostVerified: false }, emissions: {} };
    });
    return getBudget(request);
  }
  async function disableBudget(request) {
    const scope = await scopeFor(request);
    await mutate(data => {
      const record = data.budgets[scope.key];
      if (record?.enabled) { record.enabled = false; record.disabledAt = clock(); record.revision += 1; record.emissions = {}; }
    });
    return getBudget(request);
  }
  async function getOverview({ accountId }) {
    identity(accountId);
    const records = Object.values((await load()).budgets).filter(row => row.accountId === accountId && row.enabled);
    const budgets = await Promise.all(records.map(row => getBudget({ accountId, threadId: row.threadId })));
    return { accountId, budgets, count: budgets.length,
      allocatedPlanUsd: records.reduce((total, row) => total + row.amountMicros, 0) / SCALE,
      observedSpentKnownUsd: budgets.length && budgets.every(row => row.spentKnownUsd === null)
        ? null : budgets.reduce((sum, row) => sum + (row.spentKnownUsd || 0), 0),
      unknownBudgetCount: budgets.filter(row => !row.observation?.costComplete).length,
      spendingComplete: budgets.every(row => row.observation?.costComplete),
      planOnly: true, subtractFromOfficialRemaining: false, observedAt: clock() };
  }
  async function getContext(request) {
    const budget = await getBudget(request);
    const event = request.event || 'manual';
    if (!budget.enabled || !EVENTS.has(event)) return { context: '', enabled: budget.enabled, shouldDeliver: false, reason: budget.enabled ? 'unsupported-event' : 'disabled', budget };
    const scope = await scopeFor(request);
    const record = (await load()).budgets[scope.key];
    if (!record?.enabled || record.epoch !== budget.epoch || record.revision !== budget.revision) return { context: '', shouldDeliver: false, reason: 'changed-during-observation' };
    const previous = record.emissions?.[hash(scope.threadId)];
    const turnKey = typeof request.turnId === 'string' && request.turnId ? hash(request.turnId) : null;
    const forced = event === 'manual' || event === 'SessionStart' || event === 'SubagentStart';
    const unchanged = previous?.revision === record.revision;
    let reason = 'new-interaction';
    if (!forced && unchanged) {
      if (event === 'UserPromptSubmit' && turnKey && previous.turnKey === turnKey) reason = 'duplicate-turn';
      else if (event === 'PreToolUse' && (!['low','overspent'].includes(budget.status) || previous.status === budget.status)) reason = 'no-material-budget-change';
      else if (event === 'PreToolUse' && Date.parse(clock()) - Date.parse(previous.at) < minReminderMs) reason = 'reminder-cooldown';
      else if (event === 'UserPromptSubmit' && !turnKey && Date.parse(clock()) - Date.parse(previous.at) < minReminderMs) reason = 'missing-turn-cooldown';
    }
    const shouldDeliver = reason === 'new-interaction';
    const deliveryId = hash(JSON.stringify([scope.key, scope.threadId, budget.epoch, budget.revision, event, turnKey, clock()]));
    return { context: shouldDeliver ? formatBudgetContext(budget) : '', enabled: true, shouldDeliver, reason, deliveryId, event, turnKey, budget };
  }
  async function recordDelivery(request) {
    const scope = await scopeFor(request);
    if (!request.deliveryId || !request.epoch || !Number.isSafeInteger(request.revision)) throw new Error('Delivery identity required');
    return mutate(data => {
      const record = data.budgets[scope.key];
      if (!record?.enabled || record.epoch !== request.epoch || record.revision !== request.revision) return { recorded: false, reason: 'disabled-or-changed' };
      // Actual host acknowledgement is separate from summary generation or stdout emission.
      const hostVerified = request.hostVerified === true && typeof request.hostReceipt === 'string' && !!request.hostReceipt.trim();
      record.delivery = { status: hostVerified ? 'host-confirmed' : 'emitted-unverified', hostVerified,
        at: clock(), deliveryId: identity(request.deliveryId), channel: request.channel === 'hook' ? 'hook' : 'tool' };
      record.emissions ||= {};
      record.emissions[hash(scope.threadId)] = { at: clock(), revision: record.revision,
        status: ['active','low','overspent','unknown'].includes(request.budgetStatus) ? request.budgetStatus : 'unknown',
        turnKey: typeof request.turnKey === 'string' ? request.turnKey : null };
      // Bounded metadata, no prompt or transcript content.
      const keys = Object.keys(record.emissions);
      for (const key of keys.slice(0, Math.max(0, keys.length - 512))) delete record.emissions[key];
      return { recorded: true, ...record.delivery };
    });
  }
  return { getBudget, setBudget, disableBudget, getOverview, getContext, recordDelivery };
}
