// src/integration-hook.mjs
import { readFile as readFile2 } from "node:fs/promises";
import { join as join4 } from "node:path";

// src/budget-hook.mjs
var EVENTS = /* @__PURE__ */ new Set(["SessionStart", "UserPromptSubmit", "SubagentStart", "PreToolUse"]);
async function handleBudgetHook(input, { service, resolveScope } = {}) {
  const event = input?.hook_event_name;
  if (!EVENTS.has(event) || !service || !resolveScope || typeof input.session_id !== "string") return { output: "", reason: "unsupported-or-unconfigured" };
  const scope = await resolveScope({
    sessionId: input.session_id,
    agentId: event === "SubagentStart" && typeof input.agent_id === "string" ? input.agent_id : void 0,
    event
  });
  if (!scope?.accountId || !scope?.threadId || scope.verified !== true) return { output: "", reason: "scope-unverified" };
  if (event === "SubagentStart" && (scope.relationship !== "subagent" || scope.threadId === input.session_id)) return { output: "", reason: "agent-lineage-unverified" };
  const result = await service.getContext({
    accountId: scope.accountId,
    threadId: scope.threadId,
    event,
    turnId: typeof input.turn_id === "string" ? input.turn_id : void 0
  });
  if (!result.shouldDeliver || !result.context) return { output: "", reason: result.reason };
  const delivery = await service.recordDelivery({
    accountId: scope.accountId,
    threadId: scope.threadId,
    epoch: result.budget.epoch,
    revision: result.budget.revision,
    deliveryId: result.deliveryId,
    turnKey: result.turnKey,
    budgetStatus: result.budget.status,
    channel: "hook",
    hostVerified: false
  });
  if (!delivery.recorded) return { output: "", reason: delivery.reason };
  return {
    output: JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: result.context } }),
    reason: "emitted-unverified",
    delivery
  };
}
if (false) {
  try {
    let raw = "";
    for await (const chunk of process.stdin) {
      raw += chunk;
      if (Buffer.byteLength(raw) > 262144) throw new Error("Hook input too large");
    }
    await runBudgetHook({ input: JSON.parse(raw || "{}"), adapterPath: process.env.TOKENLENS_BUDGET_ADAPTER });
  } catch {
  }
}

// src/integration-adapter.mjs
import { homedir } from "node:os";
import { join as join3 } from "node:path";

// src/thread-context.mjs
function resolveThread(explicitId, metadata = {}) {
  if (explicitId !== void 0) return { id: explicitId, source: "explicit" };
  for (const key of ["openai/threadId", "openai/thread_id", "codexThreadId", "codex_thread_id", "threadId", "thread_id"]) {
    if (typeof metadata[key] === "string" && metadata[key].trim()) return { id: metadata[key], source: key };
  }
  let turn = metadata["x-codex-turn-metadata"];
  if (typeof turn === "string") {
    try {
      turn = JSON.parse(turn);
    } catch {
      turn = null;
    }
  }
  if (typeof turn?.thread_id === "string" && turn.thread_id.trim()) return { id: turn.thread_id, source: "x-codex-turn-metadata" };
  if (typeof metadata.thread?.id === "string" && metadata.thread.id.trim()) return { id: metadata.thread.id, source: "thread.id" };
  return null;
}

// src/quota-provider.mjs
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
var CODEX_QUOTA_ARGS = Object.freeze(["-s", "read-only", "-a", "never", "app-server"]);
var CODEX_CANDIDATES = Object.freeze([
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
  "/usr/local/bin/codex",
  "/opt/homebrew/bin/codex"
]);
async function readCodexAppServer({
  executable,
  spawnProcess = spawn,
  timeoutMs = 2e4,
  clock = Date.now
} = {}) {
  const child = spawnProcess(executable, [...CODEX_QUOTA_ARGS], {
    cwd: tmpdir(),
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true
  });
  let id = 0, buffer = "", totalBytes = 0, ended = false;
  const deadline = Date.now() + timeoutMs;
  const pending2 = /* @__PURE__ */ new Map();
  const fail = (code) => {
    ended = true;
    for (const waiter of pending2.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(Object.assign(new Error(code), { code }));
    }
    pending2.clear();
  };
  child.on("error", () => fail("provider_launch_failed"));
  child.on("close", () => fail("provider_closed"));
  child.stdin.on("error", () => fail("provider_closed"));
  child.stdout.on("data", (chunk) => {
    totalBytes += Buffer.byteLength(chunk);
    if (totalBytes > 1024 * 1024) {
      fail("provider_output_limit");
      child.kill("SIGKILL");
      return;
    }
    buffer += chunk.toString();
    for (; ; ) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        fail("invalid_provider_payload");
        return;
      }
      if (message?.method) {
        if (message.id !== void 0 && message.method === "account/chatgptAuthTokens/refresh") fail("external_auth_host_required");
        continue;
      }
      const waiter = pending2.get(message?.id);
      if (!waiter) continue;
      pending2.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(Object.assign(new Error("provider_rpc_failed"), { code: "provider_rpc_failed" }));
      else waiter.resolve(message.result);
    }
  });
  function call(method, params) {
    if (ended) return Promise.reject(Object.assign(new Error("provider_closed"), { code: "provider_closed" }));
    const requestId = ++id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending2.delete(requestId);
        reject(Object.assign(new Error("provider_timeout"), { code: "provider_timeout" }));
      }, Math.max(1, deadline - Date.now()));
      pending2.set(requestId, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id: requestId, method, ...params === void 0 ? {} : { params } }) + "\n");
    });
  }
  try {
    await call("initialize", { clientInfo: { name: "tokenlens-quota", version: "0.5.7" }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    const auth = await call("account/read", { refreshToken: false });
    if (!auth?.account || auth.account.type !== "chatgpt") return {
      status: "unavailable",
      source: "codex-app-server",
      reason: auth?.account ? "chatgpt_quota_not_supported_for_auth_mode" : "codex_login_required"
    };
    const limits = await call("account/rateLimits/read");
    const email = typeof auth.account.email === "string" ? auth.account.email.trim().toLowerCase() : null;
    return {
      source: "codex-app-server",
      updatedAt: new Date(clock()).toISOString(),
      account: {
        accountId: auth.account.accountId ?? null,
        type: auth.account.type,
        planType: auth.account.planType ?? null,
        accountRef: email ? createHash("sha256").update("tokenlens-current-login:" + email).digest("hex") : null
      },
      rateLimits: limits?.rateLimits ?? null,
      rateLimitsByLimitId: limits?.rateLimitsByLimitId ?? null
    };
  } finally {
    fail("provider_closed");
    child.stdin.end();
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 1e3);
        child.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}
function createCodexQuotaProvider({
  executable,
  candidates = CODEX_CANDIDATES,
  path = process.env.PATH ?? "",
  canExecute = (candidate) => access(candidate, constants.X_OK),
  rpc = readCodexAppServer,
  timeoutMs = 2e4,
  cacheMs = 6e4,
  clock = Date.now
} = {}) {
  let cached = null, inFlight = null;
  return async function provider() {
    if (cached && clock() - cached.at >= 0 && clock() - cached.at < cacheMs) return cached.value;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      let selected = executable;
      if (!selected) {
        for (const candidate of [...candidates, ...path.split(delimiter).filter(Boolean).map((dir) => join(dir, "codex"))]) {
          try {
            await canExecute(candidate);
            selected = candidate;
            break;
          } catch {
          }
        }
      }
      if (!selected) return { status: "unsupported", source: "codex-app-server", reason: "codex_cli_not_installed" };
      try {
        const value = await rpc({ executable: selected, timeoutMs, clock });
        if (value && typeof value === "object" && (value.rateLimits || value.rateLimitsByLimitId)) cached = { at: clock(), value };
        else if (!value?.status) return { status: "unavailable", source: "codex-app-server", reason: "invalid_provider_payload" };
        return value;
      } catch (error) {
        const safeCodes = ["provider_timeout", "provider_closed", "provider_rpc_failed", "provider_output_limit", "invalid_provider_payload", "provider_launch_failed", "external_auth_host_required"];
        return { status: "unavailable", source: "codex-app-server", reason: safeCodes.includes(error?.code) ? error.code : "provider_read_failed" };
      }
    })();
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  };
}
var codexQuotaProvider = createCodexQuotaProvider();

// src/quota-service.mjs
var finite = (value) => typeof value === "number" && Number.isFinite(value);
var identifier = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
function timestamp(value) {
  if (typeof value === "string" && /(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    const number = Date.parse(value);
    return Number.isFinite(number) ? number : null;
  }
  return finite(value) && Math.abs(value) <= 864e13 ? value : null;
}
var reason = (code, severity = "blocker") => ({ code, severity });
function selectWeeklyWindow(quota, poolId) {
  const windows = (quota?.pools ?? []).flatMap((pool) => pool.windows ?? []).filter((window) => window.isWeekly && (!poolId || window.poolId === poolId));
  if (windows.length !== 1) return {
    weekly: null,
    reason: windows.length > 1 ? "weekly_pool_ambiguous" : "weekly_window_unavailable"
  };
  return { weekly: windows[0], reason: null };
}
function ledgerRequestForQuota(quota, { poolId } = {}) {
  const { weekly, reason: selectionReason } = selectWeeklyWindow(quota, poolId);
  if (!weekly || !weekly.period.startAt || !weekly.period.endAt) {
    return { status: "unavailable", request: null, reason: selectionReason ?? "period_unknown" };
  }
  const accountId = quota?.account?.accountId;
  return {
    status: "available",
    reason: null,
    scope: accountId ? "recorded-account" : "local-observed",
    qualityReasons: accountId ? [] : [reason("local_history_account_pool_assumption", "warning")],
    request: {
      ...accountId ? { accountId, ...weekly.poolId ? { billingPoolId: weekly.poolId } : {} } : {},
      startAt: weekly.period.startAt,
      endAt: weekly.period.endAt
    }
  };
}
function accountUsageFromLedger(snapshot, { request } = {}) {
  const coverage = snapshot?.coverage ?? {}, total = snapshot?.total ?? {};
  const parseAmount = (value) => typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : finite(value) ? value : null;
  const fullAmount = parseAmount(total.amount);
  const knownAmount = parseAmount(total.knownUsd);
  const amount = fullAmount ?? (total.pricedRequests > 0 ? parseAmount(total.observedUsd) ?? knownAmount : null);
  const partialFilter = ["model", "project", "threadId", "conversationId", "provider", "search", "archived", "subagent"].some((key) => request?.[key] !== void 0 && request?.[key] !== null && request?.[key] !== "") || request?.unpricedOnly === true;
  const exactRequest = request && (!request.accountId || request.accountId === snapshot?.accountId) && timestamp(request.startAt) !== null && timestamp(request.startAt) === timestamp(snapshot?.period?.startAt) && timestamp(request.endAt) === timestamp(snapshot?.period?.endAt) && !partialFilter;
  const ids = (rows) => [...new Set((rows ?? []).map((row) => identifier(row.id)).filter(Boolean))];
  const accountIds = ids(snapshot?.byAccount), poolIds = ids(snapshot?.byBillingPool);
  const billingModes = ids(snapshot?.byBillingMode);
  const sampleModes = (snapshot?.records ?? []).map((row) => identifier(row.billingMode)).filter(Boolean);
  const hasApiKeyMode = [...billingModes, ...sampleModes].some((mode) => /^(?:api|apikey|api-key|api_key)$/i.test(mode));
  return {
    accountId: snapshot?.accountId ?? (accountIds.length === 1 ? accountIds[0] : null),
    poolId: exactRequest ? request.billingPoolId ?? (poolIds.length === 1 ? poolIds[0] : null) : null,
    accountIds,
    poolIds,
    conflicts: { accounts: accountIds.length > 1, pools: poolIds.length > 1, billingModes: hasApiKeyMode || billingModes.length > 1 },
    source: snapshot?.source ?? "local-request-ledger",
    scope: request?.accountId ? "recorded-account-local" : "local-observed",
    precision: "exact-record-timestamps",
    costComplete: fullAmount !== null && total.costComplete === true,
    knownSubtotal: fullAmount === null && amount !== null,
    tokens: total.totalTokens ?? total.knownTokens?.totalTokens ?? null,
    tokenBreakdown: {
      input: total.input ?? null,
      cacheRead: total.cacheRead ?? null,
      cacheWrite: total.cacheWrite ?? null,
      output: total.output ?? null,
      reasoning: total.reasoning ?? null,
      total: total.totalTokens ?? null
    },
    byModel: snapshot?.byModel ?? [],
    deduplication: {
      source: "local-request-ledger",
      policy: "Only A-owned request deltas; inherited fork/subagent history and duplicate copies excluded.",
      conflicts: coverage.conflictingRequests ?? 0,
      unresolved: coverage.ownershipUnresolvedRequests ?? 0
    },
    startAt: snapshot?.period?.startAt ?? null,
    endAt: snapshot?.period?.endAt ?? null,
    updatedAt: snapshot?.observedAt ?? null,
    apiEquivalentUsd: finite(amount) ? amount : null,
    costBasis: snapshot?.pricing?.kind === "API equivalent" && snapshot?.pricing?.currency === "USD" ? "api-equivalent" : null,
    unknownPriceCount: total.unpricedRequests ?? null,
    coverage: {
      periodComplete: exactRequest && coverage.timeFilterExact === true && coverage.usageComplete === true && coverage.localScanComplete === true,
      accountComplete: coverage.accountAttributionComplete === true,
      poolComplete: exactRequest && coverage.unknownPoolRequests === 0,
      pricingComplete: total.costComplete === true,
      sourceComplete: false,
      otherDevicesPossible: true
    }
  };
}

// src/budget-service.mjs
import { mkdir, readFile, writeFile, rename, unlink, open, stat } from "node:fs/promises";
import { join as join2 } from "node:path";
import { createHash as createHash2, randomUUID } from "node:crypto";
var SCALE = 1e6;
var hash = (value) => createHash2("sha256").update(value).digest("hex");
var keyFor = (accountId, threadId) => hash(JSON.stringify([accountId, threadId]));
var micros = (value) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.round(value * SCALE))) throw new Error("Invalid API equivalent amount");
  return Math.round(value * SCALE);
};
var iso = (value) => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid timestamp");
  return date.toISOString();
};
var identity = (value) => {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) throw new Error("Explicit accountId and threadId are required");
  return value;
};
var money = (value) => `$${value.toFixed(2)}`;
var EVENTS2 = /* @__PURE__ */ new Set(["SessionStart", "UserPromptSubmit", "SubagentStart", "PreToolUse", "manual"]);
function freezeEstimate(estimate, accountId, timestamp2) {
  const basis = estimate?.basis || {};
  if (!estimate || (estimate.accountId ?? basis.accountId) !== accountId || !["available", "estimated"].includes(estimate.status) || estimate.qualityReasons?.some((reason2) => reason2.severity === "blocker")) throw new Error("A usable same-account weekly estimate is required");
  const capacity = micros(estimate.capacityUsd ?? estimate.estimatedCapacityUsd);
  const period = estimate.period ?? basis.period;
  const observed = estimate.observedAt ?? estimate.updatedAt;
  if (!capacity || !period?.startAt || !period?.endAt || !observed) throw new Error("Weekly estimate period and observation are required");
  const startAt = iso(period.startAt), endAt = iso(period.endAt);
  if (startAt >= endAt) throw new Error("Invalid estimate period");
  const observedAt = iso(observed);
  if (observedAt < startAt || observedAt >= endAt || observedAt > timestamp2 || timestamp2 >= endAt) throw new Error("Weekly estimate is outside the current official period");
  const usedFraction = estimate.usedFraction ?? (typeof basis.usedPercent === "number" ? basis.usedPercent / 100 : null);
  if (typeof usedFraction !== "number" || !Number.isFinite(usedFraction) || usedFraction <= 0 || usedFraction > 1) throw new Error("Weekly estimate used fraction is required");
  const knownPeriodUsd = micros(estimate.knownPeriodUsd ?? basis.cycleApiEquivalentUsd) / SCALE;
  if (!knownPeriodUsd || Math.abs(knownPeriodUsd / usedFraction - capacity / SCALE) > Math.max(501e-5, capacity / SCALE * 1e-6)) throw new Error("Weekly estimate must use cycle cumulative cost divided by used fraction");
  return {
    accountId,
    status: "available",
    capacityUsd: capacity / SCALE,
    period: { startAt, endAt },
    observedAt,
    usedFraction,
    knownPeriodUsd,
    poolId: typeof (estimate.poolId ?? basis.poolId) === "string" ? identity(estimate.poolId ?? basis.poolId) : null,
    formula: "cycleApiEquivalentUsd / (usedPercent / 100)",
    reliability: ["high", "limited", "low"].includes(estimate.reliability) ? estimate.reliability : "limited",
    source: "same-account-official-weekly-cycle"
  };
}
function normalizeUsage(raw, scope, startAt, endAt) {
  const base = {
    knownUsd: null,
    costComplete: false,
    unknownCostCount: null,
    pending: null,
    observedAt: null,
    status: "unavailable",
    reason: "ledger-unavailable"
  };
  if (!raw || raw.accountId !== scope.accountId || raw.rootThreadId !== scope.rootThreadId || raw.scopeVerified !== true) return { ...base, reason: "ledger-scope-unverified" };
  try {
    if (startAt > endAt || iso(raw.startAt) !== startAt || iso(raw.endAt) !== endAt) return { ...base, reason: "ledger-period-mismatch" };
    const knownUsd = micros(raw.knownUsd) / SCALE;
    const observedAt = iso(raw.observedAt);
    if (observedAt < startAt) return { ...base, reason: "ledger-observation-before-epoch" };
    const unknownCostCount = Number.isSafeInteger(raw.unknownCostCount) && raw.unknownCostCount >= 0 ? raw.unknownCostCount : null;
    const pending2 = typeof raw.pending === "boolean" ? raw.pending : null;
    const costComplete = raw.costComplete === true && unknownCostCount === 0;
    return {
      knownUsd,
      costComplete,
      unknownCostCount,
      pending: pending2,
      observedAt,
      status: costComplete ? "observed" : "partial",
      reason: costComplete ? null : "unpriced-or-incomplete-ledger"
    };
  } catch {
    return { ...base, reason: "invalid-ledger-observation" };
  }
}
function summarize(record, usage, requestedThreadId) {
  const amountUsd = record.amountMicros / SCALE;
  const spent = usage.knownUsd;
  const remainingKnownUsd = spent === null ? null : (record.amountMicros - micros(spent)) / SCALE;
  const remainingUsd = usage.costComplete ? remainingKnownUsd : null;
  const over = remainingKnownUsd !== null && remainingKnownUsd < 0;
  const near = remainingKnownUsd !== null && remainingKnownUsd <= amountUsd * 0.15;
  const status = over ? "overspent" : !usage.costComplete ? "unknown" : near ? "low" : "active";
  return {
    enabled: true,
    status,
    accountId: record.accountId,
    threadId: requestedThreadId,
    rootThreadId: record.threadId,
    sharedWithRoot: requestedThreadId !== record.threadId,
    epoch: record.epoch,
    revision: record.revision,
    mode: record.mode,
    percent: record.percent,
    amountUsd,
    spentKnownUsd: spent,
    remainingUsd,
    remainingKnownUsd,
    remainingIsUpperBound: !usage.costComplete && remainingKnownUsd !== null,
    effectiveAt: record.effectiveAt,
    updatedAt: record.updatedAt,
    estimate: record.estimate,
    observation: usage,
    delivery: record.delivery || { status: "not-delivered", hostVerified: false },
    softOnly: true,
    canContinue: true
  };
}
function formatBudgetContext(budget) {
  if (!budget?.enabled) return "";
  const spent = budget.spentKnownUsd === null ? "\u672A\u77E5" : money(budget.spentKnownUsd);
  const remaining = budget.remainingUsd === null ? "\u672A\u77E5\uFF08\u5B58\u5728\u7F3A\u5931\u6216\u672A\u8BA1\u4EF7\u8D39\u7528\uFF09" : money(budget.remainingUsd);
  const pending2 = budget.observation.pending !== false ? "\uFF1B\u5728\u9014\u8D39\u7528\u5C1A\u672A\u5B8C\u5168\u5165\u8D26" : "";
  const notice = budget.status === "overspent" ? "\u5DF2\u8BB0\u5F55\u8D39\u7528\u8D85\u8FC7\u9884\u7B97\uFF1B\u4F9D\u636E\u5DF2\u8BB0\u5F55\u5DE5\u4F5C\u7B80\u77ED\u8BF4\u660E\u539F\u56E0\u53CA\u6536\u5C3E\u8303\u56F4\u3002" : budget.status === "low" ? "\u4F59\u989D\u8F83\u4F4E\uFF1B\u9884\u8BA1\u4E0D\u8DB3\u65F6\u63D0\u524D\u8BF4\u660E\u53EF\u5B8C\u6210\u8303\u56F4\u548C\u5EFA\u8BAE\u3002" : "\u9884\u8BA1\u9884\u7B97\u4E0D\u8DB3\u65F6\u63D0\u524D\u8BF4\u660E\u53EF\u5B8C\u6210\u8303\u56F4\u548C\u5EFA\u8BAE\u3002";
  return `Gauge \u53EF\u9009\u8F6F\u9884\u7B97\uFF1A\u672C\u5BF9\u8BDD\u53CA\u660E\u786E\u5F52\u5C5E\u5B50\u4EE3\u7406\u5171\u4EAB\u56FA\u5B9A ${money(budget.amountUsd)} API \u7B49\u4EF7\u9884\u7B97\uFF0C\u81EA ${budget.effectiveAt} \u751F\u6548\u3002\u5DF2\u8BB0\u5F55 ${spent}\uFF0C\u5269\u4F59 ${remaining}${pending2}\uFF08\u89C2\u6D4B\uFF1A${budget.observation.observedAt || "\u672A\u77E5"}\uFF09\u3002${notice}\u6309\u9884\u7B97\u5B89\u6392\u8303\u56F4\u4E0E\u6295\u5165\uFF0C\u4FDD\u7559\u5FC5\u8981\u9A8C\u8BC1\u548C\u6536\u5C3E\uFF1B\u4E0D\u5F3A\u5236\u505C\u6B62\u3001\u4E0D\u963B\u6B62\u5DE5\u5177\u3001\u4E0D\u81EA\u52A8\u6539\u53D8\u6A21\u578B\u6216\u601D\u8003\u5F3A\u5EA6\u3001\u4E0D\u81EA\u884C\u52A0\u9884\u7B97\u3002\u6700\u7EC8\u56DE\u590D\u540E\u7684\u5165\u8D26\u5DEE\u989D\u5728\u4E0B\u4E00\u6B21\u4EA4\u4E92\u8865\u8BF4\u660E\uFF0C\u4E0D\u4E3A\u89E3\u91CA\u8D39\u7528\u81EA\u52A8\u5F00\u542F\u65B0\u8F6E\u6B21\u3002`;
}
function createBudgetService({ dataDir, readUsage, resolveLineage, now = () => /* @__PURE__ */ new Date(), minReminderMs = 6e4 } = {}) {
  if (!dataDir) throw new Error("A private plugin dataDir is required");
  const file = join2(dataDir, "budgets-v1.json");
  const lock = join2(dataDir, "budgets-v1.lock");
  let queue = Promise.resolve();
  const clock = () => iso(now());
  async function acquireLock() {
    for (let attempt = 0; attempt < 5; attempt++) {
      let handle;
      try {
        handle = await open(lock, "wx", 384);
        await handle.writeFile(JSON.stringify({ pid: process.pid }));
        return handle;
      } catch (e) {
        if (handle) {
          await handle.close();
          await unlink(lock).catch(() => {
          });
          throw e;
        }
        if (e.code !== "EEXIST") throw e;
        try {
          const original = await stat(lock);
          let owner;
          try {
            owner = JSON.parse(await readFile(lock, "utf8"));
          } catch {
            owner = null;
          }
          let dead = false;
          if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
            try {
              process.kill(owner.pid, 0);
            } catch (error) {
              dead = error.code === "ESRCH";
            }
          } else dead = Date.now() - original.mtimeMs > 12e4;
          const current = await stat(lock);
          if (dead && current.ino === original.ino && current.dev === original.dev) await unlink(lock);
        } catch {
        }
        if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 30));
      }
    }
    throw new Error("Budget store busy; retry");
  }
  async function load() {
    try {
      const data = JSON.parse(await readFile(file, "utf8"));
      if (data.schema !== 1 || !data.budgets || typeof data.budgets !== "object" || Array.isArray(data.budgets)) throw new Error("Invalid budget store");
      for (const [key, record] of Object.entries(data.budgets)) {
        if (!record || typeof record.enabled !== "boolean" || !Number.isSafeInteger(record.amountMicros) || record.amountMicros <= 0 || !Number.isSafeInteger(record.revision) || record.revision < 1 || !["amount", "percentage"].includes(record.mode) || key !== keyFor(identity(record.accountId), identity(record.threadId)) || !identity(record.epoch) || iso(record.effectiveAt) !== record.effectiveAt || iso(record.updatedAt) !== record.updatedAt) throw new Error("Invalid budget record");
      }
      return data;
    } catch (e) {
      if (e.code === "ENOENT") return { schema: 1, budgets: {} };
      throw e;
    }
  }
  async function mutate(fn) {
    const task = queue.then(async () => {
      await mkdir(dataDir, { recursive: true, mode: 448 });
      const handle = await acquireLock();
      let temp;
      try {
        const data = await load();
        const result = await fn(data);
        temp = `${file}.${randomUUID()}.tmp`;
        await writeFile(temp, JSON.stringify(data), { mode: 384, flag: "wx" });
        await rename(temp, file);
        return result;
      } finally {
        if (temp) await unlink(temp).catch(() => {
        });
        await handle.close();
        await unlink(lock);
      }
    });
    queue = task.catch(() => {
    });
    return task;
  }
  async function scopeFor(request) {
    const accountId = identity(request.accountId), threadId = identity(request.threadId);
    let rootThreadId = threadId;
    if (resolveLineage) {
      const relation = await resolveLineage({ accountId, threadId });
      if (relation?.verified === true && relation.relationship === "subagent") rootThreadId = identity(relation.rootThreadId);
    }
    return { accountId, threadId, rootThreadId, key: keyFor(accountId, rootThreadId) };
  }
  const disabled = (scope, record) => ({
    enabled: false,
    status: "disabled",
    accountId: scope.accountId,
    threadId: scope.threadId,
    rootThreadId: scope.rootThreadId,
    disabledAt: record?.disabledAt || null,
    context: "",
    delivery: { status: "disabled", hostVerified: false },
    historicalContextCannotBeRetracted: !!record,
    softOnly: true
  });
  async function observe(scope, record) {
    const endAt = clock();
    let raw;
    try {
      if (readUsage) raw = await readUsage({
        accountId: scope.accountId,
        threadId: scope.rootThreadId,
        startAt: record.effectiveAt,
        endAt,
        includeDescendants: true
      });
    } catch {
    }
    return normalizeUsage(raw, scope, record.effectiveAt, endAt);
  }
  async function getBudget(request) {
    const scope = await scopeFor(request);
    const record = (await load()).budgets[scope.key];
    if (!record?.enabled) return disabled(scope, record);
    const usage = await observe(scope, record);
    return summarize(record, usage, scope.threadId);
  }
  async function setBudget(request) {
    if (request.enabled === false) return disableBudget(request);
    if (request.enabled !== true) throw new Error("Explicit enabled:true is required");
    const scope = await scopeFor(request);
    const mode = request.mode || "amount";
    let amountMicros, estimate = null, percent = null;
    if (mode === "amount") amountMicros = micros(request.amountUsd);
    else if (mode === "percentage") {
      if (typeof request.percent !== "number" || !Number.isFinite(request.percent) || request.percent <= 0 || request.percent > 100) throw new Error("Percent must be greater than 0 and at most 100");
      percent = request.percent;
      estimate = freezeEstimate(request.estimate, scope.accountId, clock());
      amountMicros = micros(estimate.capacityUsd * percent / 100);
    } else throw new Error("Invalid budget mode");
    if (!amountMicros) throw new Error("Budget must be positive");
    await mutate((data) => {
      const previous = data.budgets[scope.key];
      const timestamp2 = clock();
      const retain = previous?.enabled === true && request.resetEpoch !== true;
      data.budgets[scope.key] = {
        accountId: scope.accountId,
        threadId: scope.rootThreadId,
        enabled: true,
        amountMicros,
        mode,
        percent,
        estimate,
        epoch: retain ? previous.epoch : randomUUID(),
        effectiveAt: retain ? previous.effectiveAt : timestamp2,
        updatedAt: timestamp2,
        revision: (previous?.revision || 0) + 1,
        delivery: { status: "pending-model-interaction", hostVerified: false },
        emissions: {}
      };
    });
    return getBudget(request);
  }
  async function disableBudget(request) {
    const scope = await scopeFor(request);
    await mutate((data) => {
      const record = data.budgets[scope.key];
      if (record?.enabled) {
        record.enabled = false;
        record.disabledAt = clock();
        record.revision += 1;
        record.emissions = {};
      }
    });
    return getBudget(request);
  }
  async function getOverview({ accountId }) {
    identity(accountId);
    const records = Object.values((await load()).budgets).filter((row) => row.accountId === accountId && row.enabled);
    const budgets = await Promise.all(records.map((row) => getBudget({ accountId, threadId: row.threadId })));
    return {
      accountId,
      budgets,
      count: budgets.length,
      allocatedPlanUsd: records.reduce((total, row) => total + row.amountMicros, 0) / SCALE,
      observedSpentKnownUsd: budgets.length && budgets.every((row) => row.spentKnownUsd === null) ? null : budgets.reduce((sum, row) => sum + (row.spentKnownUsd || 0), 0),
      unknownBudgetCount: budgets.filter((row) => !row.observation?.costComplete).length,
      spendingComplete: budgets.every((row) => row.observation?.costComplete),
      planOnly: true,
      subtractFromOfficialRemaining: false,
      observedAt: clock()
    };
  }
  async function getContext(request) {
    const budget = await getBudget(request);
    const event = request.event || "manual";
    if (!budget.enabled || !EVENTS2.has(event)) return { context: "", enabled: budget.enabled, shouldDeliver: false, reason: budget.enabled ? "unsupported-event" : "disabled", budget };
    const scope = await scopeFor(request);
    const record = (await load()).budgets[scope.key];
    if (!record?.enabled || record.epoch !== budget.epoch || record.revision !== budget.revision) return { context: "", shouldDeliver: false, reason: "changed-during-observation" };
    const previous = record.emissions?.[hash(scope.threadId)];
    const turnKey = typeof request.turnId === "string" && request.turnId ? hash(request.turnId) : null;
    const forced = event === "manual" || event === "SessionStart" || event === "SubagentStart";
    const unchanged = previous?.revision === record.revision;
    let reason2 = "new-interaction";
    if (!forced && unchanged) {
      if (event === "UserPromptSubmit" && turnKey && previous.turnKey === turnKey) reason2 = "duplicate-turn";
      else if (event === "PreToolUse" && (!["low", "overspent"].includes(budget.status) || previous.status === budget.status)) reason2 = "no-material-budget-change";
      else if (event === "PreToolUse" && Date.parse(clock()) - Date.parse(previous.at) < minReminderMs) reason2 = "reminder-cooldown";
      else if (event === "UserPromptSubmit" && !turnKey && Date.parse(clock()) - Date.parse(previous.at) < minReminderMs) reason2 = "missing-turn-cooldown";
    }
    const shouldDeliver = reason2 === "new-interaction";
    const deliveryId = hash(JSON.stringify([scope.key, scope.threadId, budget.epoch, budget.revision, event, turnKey, clock()]));
    return { context: shouldDeliver ? formatBudgetContext(budget) : "", enabled: true, shouldDeliver, reason: reason2, deliveryId, event, turnKey, budget };
  }
  async function recordDelivery(request) {
    const scope = await scopeFor(request);
    if (!request.deliveryId || !request.epoch || !Number.isSafeInteger(request.revision)) throw new Error("Delivery identity required");
    return mutate((data) => {
      const record = data.budgets[scope.key];
      if (!record?.enabled || record.epoch !== request.epoch || record.revision !== request.revision) return { recorded: false, reason: "disabled-or-changed" };
      const hostVerified = request.hostVerified === true && typeof request.hostReceipt === "string" && !!request.hostReceipt.trim();
      record.delivery = {
        status: hostVerified ? "host-confirmed" : "emitted-unverified",
        hostVerified,
        at: clock(),
        deliveryId: identity(request.deliveryId),
        channel: request.channel === "hook" ? "hook" : "tool"
      };
      record.emissions ||= {};
      record.emissions[hash(scope.threadId)] = {
        at: clock(),
        revision: record.revision,
        status: ["active", "low", "overspent", "unknown"].includes(request.budgetStatus) ? request.budgetStatus : "unknown",
        turnKey: typeof request.turnKey === "string" ? request.turnKey : null
      };
      const keys = Object.keys(record.emissions);
      for (const key of keys.slice(0, Math.max(0, keys.length - 512))) delete record.emissions[key];
      return { recorded: true, ...record.delivery };
    });
  }
  return { getBudget, setBudget, disableBudget, getOverview, getContext, recordDelivery };
}

// src/integration-adapter.mjs
function pluginDataDir(env = process.env) {
  return env.TOKENLENS_DATA || env.PLUGIN_DATA || env.CLAUDE_PLUGIN_DATA || join3(env.CODEX_HOME || join3(homedir(), ".codex"), "plugins/data/tokenlens-local/tokenlens-prototype");
}
function requestThread(args, extra) {
  const thread = resolveThread(args.thread_id ?? args.threadId, extra?._meta);
  if (thread && !/^[A-Za-z0-9_.:-]{1,200}$/.test(thread.id)) throw new Error("\u5BF9\u8BDD\u6807\u8BC6\u683C\u5F0F\u65E0\u6548\u3002");
  return thread;
}
var appResult = (key, value, text = "\u5DF2\u8BFB\u53D6\u672C\u5730\u7EDF\u8BA1\u3002") => ({
  content: [{ type: "text", text }],
  structuredContent: { [key]: value },
  _meta: { [key]: value }
});
var needsThreadResult = () => ({
  content: [{ type: "text", text: "\u5BA2\u6237\u7AEF\u672A\u63D0\u4F9B\u5F53\u524D\u5BF9\u8BDD\u6807\u8BC6\uFF0C\u8BF7\u660E\u786E\u63D0\u4F9B thread_id\u3002" }],
  structuredContent: { live: false, needsThread: true },
  _meta: { needsThread: true }
});
var normalizeRequest = (args) => {
  const value = { ...args };
  for (const [snake, camel] of [["account_id", "accountId"], ["thread_id", "threadId"], ["start_at", "startAt"], ["end_at", "endAt"], ["limit_id", "limitId"], ["amount_usd", "amountUsd"]]) {
    if (value[snake] !== void 0) {
      value[camel] = value[snake];
      delete value[snake];
    }
  }
  return value;
};
function createIntegration({ readAccount, readThread, readQuota, estimateCapacity, normalizeCycleUsage = accountUsageFromLedger, dataDir = pluginDataDir(), now = () => /* @__PURE__ */ new Date(), quotaIdentity = () => null }) {
  let quotaPromise, quotaExpires = 0, quotaIdentityKey;
  async function quotaSnapshot() {
    const identity2 = quotaIdentity();
    if (!quotaPromise || identity2 !== quotaIdentityKey || Date.now() >= quotaExpires) {
      quotaIdentityKey = identity2;
      quotaExpires = Date.now() + 6e4;
      quotaPromise = Promise.resolve().then(() => readQuota());
    }
    return quotaPromise;
  }
  async function account(args = {}) {
    const request = normalizeRequest(args);
    const sortMap = { recent: "lastActivity", cost: "amount", title: "threadId" };
    if (request.sort) request.sort = sortMap[request.sort] || request.sort;
    if (request.limitId) {
      request.billingPoolId = request.limitId;
      delete request.limitId;
    }
    if (request.poolId) {
      request.billingPoolId = request.poolId;
      delete request.poolId;
    }
    if (request.export) {
      request.exportFormat = request.export;
      delete request.export;
    }
    request.timezone ||= "Asia/Shanghai";
    const raw = await readAccount(request);
    const total = raw.total || {};
    const cost = (row) => ({
      amountUsd: row.amount == null ? (row.pricedRequests ?? row.requestCount - row.unpricedRequests) > 0 ? Number(row.observedUsd ?? row.knownUsd) : null : Number(row.amount),
      knownUsd: Number(row.knownUsd),
      costComplete: row.costComplete === true,
      tokens: row.requestCount === 0 && row.costComplete !== true ? { input: null, cacheRead: null, cacheWrite: null, output: null, reasoning: null, total: null } : { input: row.input, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite, output: row.output, reasoning: row.reasoning, total: row.totalTokens },
      knownTokens: row.knownTokens,
      costParts: row.costParts
    });
    const group = (rows) => (rows || []).map((row) => ({ ...row, ...cost(row), name: row.id || "\u672A\u77E5", day: row.id }));
    const categories = [["input", "\u672A\u7F13\u5B58\u8F93\u5165"], ["cached_input", "\u7F13\u5B58\u8BFB\u53D6"], ["cache_write", "\u7F13\u5B58\u5199\u5165"], ["output", "\u8F93\u51FA\uFF08\u542B\u63A8\u7406\uFF09"]].map(([id, name]) => ({ id, name, amountUsd: total.requestCount > total.unpricedRequests ? Number(total.costParts?.[id] || 0) : null, costComplete: total.costComplete === true }));
    const conversations = (raw.threads || []).map((row) => ({
      ...row,
      ...cost(row.total),
      updatedAt: row.lastActivity,
      rootThreadId: row.conversationId,
      relationship: row.parentThreadId ? "subagent" : row.forkedFromId ? "fork" : "main"
    }));
    return {
      ...raw,
      ...cost(total),
      status: raw.coverage?.status,
      range: raw.period,
      warnings: raw.coverage?.issues || [],
      conversations,
      summary: { ...total, ...cost(total) },
      byModel: group(raw.byModel),
      byProject: group(raw.byProject),
      byDay: group(raw.byDay),
      byAgent: group(raw.byAgent),
      breakdown: { models: group(raw.byModel), projects: group(raw.byProject), daily: group(raw.byDay), agents: group(raw.byAgent), tokens: categories },
      nextOffset: (request.offset || 0) + conversations.length < raw.threadCount ? (request.offset || 0) + conversations.length : null
    };
  }
  async function budgetScope(args, extra) {
    const selected = requestThread(args, extra);
    if (!selected) return null;
    const request = normalizeRequest(args);
    const inventory = await account({ threadId: selected.id });
    const row = inventory.conversations?.find((row2) => (row2.threadId || row2.id) === selected.id);
    if (!row) throw new Error("\u6CA1\u6709\u627E\u5230\u6240\u9009\u5BF9\u8BDD\u7684\u672C\u5730\u8EAB\u4EFD\u8BB0\u5F55\u3002");
    if (row.issues?.some((issue) => /conflicting-session|lineage-cycle/.test(issue))) throw new Error("\u5BF9\u8BDD\u8EAB\u4EFD\u6216\u5F52\u5C5E\u5B58\u5728\u51B2\u7A81\uFF0C\u65E0\u6CD5\u7ED1\u5B9A\u9884\u7B97\u3002");
    let owner = row;
    if (row.parentThreadId && row.rootThreadId && row.rootThreadId !== row.threadId) {
      const rootInventory = await account({ threadId: row.rootThreadId });
      const root = rootInventory.conversations.find((item) => item.threadId === row.rootThreadId);
      if (root && !root.issues?.some((issue) => /conflict|lineage/.test(issue))) owner = root;
    }
    const accountId = owner.accountId;
    if (request.accountId && accountId && request.accountId !== accountId) throw new Error("\u8BF7\u6C42\u8D26\u53F7\u4E0E\u5BF9\u8BDD\u8BB0\u5F55\u4E2D\u7684\u5F52\u5C5E\u4E0D\u7B26\u3002");
    if (!accountId) return { threadId: selected.id, accountId: "local-unattributed", accountIdentityStatus: "unknown", localOnly: true };
    return { threadId: selected.id, accountId };
  }
  async function resolveLineage({ accountId, threadId }) {
    const inventory = await account({ threadId });
    const row = inventory.conversations?.find((row2) => (row2.threadId || row2.id) === threadId);
    if (!row?.issues?.some((issue) => /conflict|lineage/.test(issue)) && row?.parentThreadId && row.rootThreadId && row.relationship === "subagent") {
      const root = (await account({ threadId: row.rootThreadId })).conversations.find((item) => item.threadId === row.rootThreadId);
      if (!root || (root.accountId || "local-unattributed") !== accountId || root.issues?.some((issue) => /conflict|lineage/.test(issue))) return null;
      return { rootThreadId: row.rootThreadId, relationship: "subagent", verified: true };
    }
    return null;
  }
  async function readBudgetUsage(request) {
    if (request.startAt === request.endAt) return { accountId: request.accountId, rootThreadId: request.threadId, startAt: request.startAt, endAt: request.endAt, scopeVerified: true, knownUsd: 0, costComplete: true, unknownCostCount: 0, pending: true, observedAt: request.endAt };
    const { threadId, ...query } = request;
    delete query.accountId;
    const ledger = await account({ ...query, conversationId: threadId, includeDescendants: true });
    const c = ledger.coverage || {}, t = ledger.total || {};
    const verified = c.localScanComplete === true && c.conflictingRequests === 0;
    const complete = c.usageComplete === true && c.timeFilterExact === true && c.ownershipUnresolvedRequests === 0;
    return {
      accountId: request.accountId,
      rootThreadId: request.threadId,
      startAt: request.startAt,
      endAt: request.endAt,
      scopeVerified: verified,
      knownUsd: Number(t.knownUsd),
      costComplete: complete && (t.costComplete === true || t.requestCount === 0),
      unknownCostCount: t.unpricedRequests,
      pending: !c.localScanComplete,
      observedAt: new Date(ledger.observedAt).toISOString()
    };
  }
  const budgets = createBudgetService({ dataDir, readUsage: readBudgetUsage, resolveLineage, now });
  function observedSummary(ledger, period) {
    if (!ledger) return { status: "unavailable", apiEquivalentUsd: null, costUsd: null, costUSD: null, tokens: null, period, source: "codex-local-ledger" };
    const t = ledger.total || {}, c = ledger.coverage || {};
    const known = Number(t.knownUsd);
    const hasKnown = t.requestCount > t.unpricedRequests && Number.isFinite(known);
    const amount = hasKnown ? known : t.requestCount === 0 && c.localScanComplete && c.usageComplete && c.timeFilterExact ? 0 : null;
    const costComplete = t.costComplete === true && c.localScanComplete === true && c.usageComplete === true && c.timeFilterExact === true;
    return {
      status: amount === null ? "unavailable" : costComplete ? "observed" : "partial",
      apiEquivalentUsd: amount,
      costUsd: amount,
      costUSD: amount,
      tokens: t.requestCount ? t.totalTokens ?? t.knownTokens?.totalTokens ?? null : amount === 0 ? 0 : null,
      totalTokens: t.requestCount ? t.totalTokens ?? t.knownTokens?.totalTokens ?? null : amount === 0 ? 0 : null,
      knownTokens: t.knownTokens,
      period: ledger.period || period,
      updatedAt: ledger.observedAt,
      source: "codex-local-ledger",
      sourceLabel: "Gauge \xB7 Codex \u672C\u5730\u8BB0\u5F55",
      scope: "discoverable-local-telemetry",
      precision: c.timeFilterExact ? "exact-observed-records" : "partial-time-attribution",
      costComplete,
      pricingComplete: t.costComplete === true,
      scanComplete: c.localScanComplete === true,
      unpricedRequests: t.unpricedRequests,
      coverageComplete: false,
      accountIdentityStatus: ledger.accountStatus,
      qualityReasons: c.issues || []
    };
  }
  async function quota(args = {}) {
    const at = now();
    const day = at.toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
    const todayStart = Date.parse(day + "T00:00:00+08:00");
    const endAt = at.toISOString(), todayRequest = { startAt: new Date(todayStart).toISOString(), endAt }, historyRequest = { startAt: new Date(todayStart - 29 * 864e5).toISOString(), endAt };
    const recent = Promise.allSettled([account(todayRequest), account(historyRequest)]);
    const snapshot = await quotaSnapshot();
    const official = selectWeeklyWindow(snapshot, args.limitId || args.poolId).weekly;
    const accountId = snapshot.account?.accountId || snapshot.accountId || null;
    const poolId = args.limitId || args.poolId || official?.poolId;
    const cycleQuery = ledgerRequestForQuota(snapshot, { poolId });
    let cycleUsage = null;
    if (cycleQuery.request) cycleUsage = await account(cycleQuery.request);
    const estimateInput = cycleUsage && normalizeCycleUsage(cycleUsage, { request: cycleQuery.request });
    const requestedAccount = normalizeRequest(args).accountId;
    const scopedQuota = requestedAccount && requestedAccount !== accountId ? { ...snapshot, qualityReasons: [...snapshot.qualityReasons || [], { code: "account_identity_mismatch", severity: "blocker" }] } : snapshot;
    const rawEstimate = estimateCapacity({ accountUsage: estimateInput, quota: scopedQuota, poolId });
    const currentWindow = observedSummary(cycleUsage, official?.period || null);
    const observations = await recent;
    const today = observedSummary(observations[0].status === "fulfilled" ? observations[0].value : null, todayRequest), last30Days = observedSummary(observations[1].status === "fulfilled" ? observations[1].value : null, historyRequest);
    const costSummary = {
      source: "codex-local-ledger",
      sourceLabel: "Gauge \xB7 Codex \u672C\u5730\u8BB0\u5F55",
      scope: "discoverable-local-telemetry",
      bucketTimeZone: "Asia/Shanghai",
      updatedAt: endAt,
      today,
      last30Days,
      currentWindow,
      currentCycle: currentWindow,
      cycle: currentWindow,
      history: { last30Days }
    };
    const observedCycleUsd = rawEstimate.observedCycleUsd ?? estimateInput?.apiEquivalentUsd ?? currentWindow.apiEquivalentUsd;
    const estimate = {
      ...rawEstimate,
      accountId,
      capacityUsd: rawEstimate.estimatedCapacityUsd,
      period: official?.period,
      usedFraction: official?.usedPercent == null ? null : official.usedPercent / 100,
      observedAt: rawEstimate.updatedAt,
      knownPeriodUsd: observedCycleUsd,
      periodCostUsd: observedCycleUsd,
      observedCycleUsd,
      cycleTokens: currentWindow.tokens,
      costComplete: currentWindow.costComplete,
      source: "codex-local-ledger",
      sourceLabel: "Gauge \u672C\u5730\u8BB0\u5F55",
      reliability: rawEstimate.reliability || "limited",
      warnings: (rawEstimate.qualityReasons || []).map((reason2) => reason2.code)
    };
    return {
      ...snapshot,
      weekly: official,
      accountId,
      estimate,
      cycleUsage,
      costSummary,
      costs: costSummary,
      observedAt: snapshot.updatedAt,
      warnings: (snapshot.qualityReasons || []).map((reason2) => reason2.code)
    };
  }
  const budgetView = (value) => ({
    ...value,
    accountId: value.accountId === "local-unattributed" ? null : value.accountId,
    accountIdentityStatus: value.accountId === "local-unattributed" ? "unknown" : "recorded",
    localOnly: true,
    spentUsd: value.spentKnownUsd,
    usage: value.observation,
    startAt: value.effectiveAt,
    costComplete: value.observation?.costComplete,
    warnings: value.accountId === "local-unattributed" ? ["\u8D26\u53F7\u5F52\u5C5E\u672A\u77E5\uFF1B\u91D1\u989D\u9884\u7B97\u4EC5\u7ED1\u5B9A\u672C\u5730\u5BF9\u8BDD\uFF0C\u4E0D\u80FD\u7528\u4E8E\u540C\u8D26\u53F7\u5468\u4F30\u7B97\u3002"] : []
  });
  async function getBudget(args, extra) {
    const scope = await budgetScope(args, extra);
    if (!scope) return needsThreadResult();
    return appResult("budget", budgetView(await budgets.getBudget(scope)));
  }
  async function setBudget(args, extra) {
    if (args.enabled === false) {
      const selected = requestThread(args, extra);
      if (!selected) return needsThreadResult();
      const { readFile: readFile3 } = await import("node:fs/promises");
      let store;
      try {
        store = JSON.parse(await readFile3(join3(dataDir, "budgets-v1.json"), "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const saved = Object.values(store?.budgets || {}).filter((row) => row.threadId === selected.id);
      if (saved.length) {
        let result;
        for (const record of saved) result = await budgets.disableBudget({ accountId: record.accountId, threadId: record.threadId });
        return appResult("budget", budgetView(result), "\u9884\u7B97\u5DF2\u5173\u95ED\uFF0C\u505C\u6B62\u540E\u7EED\u63D0\u793A\uFF1B\u5386\u53F2\u63D0\u793A\u4E0D\u80FD\u64A4\u56DE\u3002");
      }
    }
    const scope = await budgetScope(args, extra);
    if (!scope) return needsThreadResult();
    const request = { ...normalizeRequest(args), ...scope };
    if (request.enabled === true && request.mode === "percentage") request.estimate = (await quota(args)).estimate;
    return appResult("budget", budgetView(await budgets.setBudget(request)), "\u9884\u7B97\u8BBE\u7F6E\u5DF2\u4FDD\u5B58\uFF1B\u6A21\u578B\u9001\u8FBE\u72B6\u6001\u9700\u5355\u72EC\u6838\u9A8C\u3002");
  }
  async function budgetContext(args, extra) {
    const scope = await budgetScope(args, extra);
    if (!scope) return needsThreadResult();
    const context = await budgets.getContext({ ...scope, event: "manual" });
    if (!context.shouldDeliver) return { content: [], structuredContent: { enabled: context.enabled, context: "", reason: context.reason } };
    const delivery = await budgets.recordDelivery({
      ...scope,
      deliveryId: context.deliveryId,
      epoch: context.budget.epoch,
      revision: context.budget.revision,
      channel: "tool",
      budgetStatus: context.budget.status,
      turnKey: context.turnKey,
      hostVerified: false
    });
    if (!delivery.recorded) return { content: [], structuredContent: { enabled: false, context: "", reason: delivery.reason } };
    return { content: [{ type: "text", text: context.context }], structuredContent: { enabled: true, context: context.context, delivery }, _meta: { budget: context.budget } };
  }
  async function overview(args = {}) {
    const accountId = normalizeRequest(args).accountId;
    if (!accountId) {
      const { readFile: readFile3 } = await import("node:fs/promises");
      let store;
      try {
        store = JSON.parse(await readFile3(join3(dataDir, "budgets-v1.json"), "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const ids = [...new Set(Object.values(store?.budgets || {}).filter((row) => row.enabled).map((row) => row.accountId))];
      const results = await Promise.all(ids.map((id) => budgets.getOverview({ accountId: id })));
      const items = results.flatMap((result2) => result2.budgets.map(budgetView));
      return {
        status: "local",
        accountId: null,
        budgets: items,
        enabledCount: items.length,
        allocatedUsd: results.reduce((sum, result2) => sum + result2.allocatedPlanUsd, 0),
        planOnly: true,
        subtractFromOfficialRemaining: false,
        observedAt: now().toISOString(),
        warnings: ["\u672C\u5730\u591A\u8D26\u53F7\u4E0E\u5F52\u5C5E\u672A\u77E5\u7684\u5BF9\u8BDD\u9884\u7B97\u8BA1\u5212\uFF1B\u975E\u5B98\u65B9\u4F59\u989D\u3002"]
      };
    }
    const result = await budgets.getOverview({ accountId });
    return { ...result, status: "local", allocatedUsd: result.allocatedPlanUsd, enabledCount: result.count, budgets: result.budgets.map(budgetView) };
  }
  return { account, quota, getBudget, setBudget, budgetContext, overview, budgetScope, budgets, readThread };
}

// src/usage-engine.mjs
import { spawn as spawn2 } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
var script = new URL("./scripts/usage_dispatch.py", import.meta.url);
var engine = new URL(`./runtime/${process.platform}-${process.arch}/usage-engine/tokenlens-usage`, import.meta.url);
var pending = /* @__PURE__ */ new Map();
var telemetryQueue = Promise.resolve();
async function readTelemetry(operation, request = {}) {
  const body = operation === "thread" ? { operation, thread_id: request.thread_id } : { operation, request };
  const key = JSON.stringify(body);
  if (pending.has(key)) return pending.get(key);
  const execute = () => new Promise((resolve, reject) => {
    const bundled = existsSync(engine) && !process.env.TOKENLENS_PYTHON;
    const child = spawn2(bundled ? fileURLToPath(engine) : process.env.TOKENLENS_PYTHON || "python3", bundled ? [] : [fileURLToPath(script)], {
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, TOKENLENS_ROOT: fileURLToPath(new URL(".", import.meta.url)) }
    });
    let output = "", settled = false;
    const fail = (message) => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error(message));
      }
    };
    const timer = setTimeout(() => fail("\u8BFB\u53D6\u672C\u5730\u7528\u91CF\u8D85\u65F6\uFF0C\u8BF7\u91CD\u8BD5\u3002"), 45e3);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.length > 32 * 1024 * 1024) fail("\u672C\u5730\u7528\u91CF\u7ED3\u679C\u8FC7\u5927\uFF0C\u8BF7\u7F29\u5C0F\u67E5\u8BE2\u8303\u56F4\u3002");
    });
    child.on("error", () => {
      clearTimeout(timer);
      fail("\u672C\u5730\u8BA1\u6570\u5F15\u64CE\u672A\u80FD\u542F\u52A8\uFF0C\u8BF7\u68C0\u67E5\u5B8C\u6574\u8FD0\u884C\u5305\u3002");
    });
    child.stdin.on("error", () => {
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      try {
        const usage = JSON.parse(output);
        if (code || usage.error) throw new Error(usage.error || "\u672C\u5730\u7528\u91CF\u8BFB\u53D6\u5931\u8D25\u3002");
        settled = true;
        resolve(usage);
      } catch (error) {
        fail(error instanceof SyntaxError ? "\u672C\u5730\u8BA1\u6570\u5F15\u64CE\u6CA1\u6709\u8FD4\u56DE\u6709\u6548 JSON\u3002" : error.message);
      }
    });
    child.stdin.end(JSON.stringify(body));
  });
  const running = telemetryQueue.then(execute, execute).finally(() => pending.delete(key));
  telemetryQueue = running.catch(() => {
  });
  pending.set(key, running);
  return running;
}

// src/integration-hook.mjs
try {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 262144) throw new Error("Hook input too large");
  }
  const input = JSON.parse(raw || "{}");
  const dataDir = pluginDataDir();
  const store = JSON.parse(await readFile2(join4(dataDir, "budgets-v1.json"), "utf8"));
  if (Object.values(store.budgets || {}).some((row) => row.enabled === true)) {
    const integration = createIntegration({
      dataDir,
      readAccount: (request) => readTelemetry("account", request),
      readThread: (thread_id) => readTelemetry("thread", { thread_id }),
      readQuota: async () => ({ status: "unavailable" }),
      estimateCapacity: () => ({ status: "unavailable" })
    });
    const resolveScope = async ({ sessionId, agentId, event }) => {
      const selected = event === "SubagentStart" ? agentId : sessionId;
      if (!selected) return null;
      const scope = await integration.budgetScope({ thread_id: selected });
      if (!scope?.accountId) return null;
      const inventory = await integration.account({ threadId: selected });
      const row = inventory.conversations.find((row2) => row2.threadId === selected);
      if (!row || row.sourceFiles < 1 || row.issues?.some((issue) => /conflict|lineage/.test(issue))) return null;
      if (event === "SubagentStart" && (row.parentThreadId !== sessionId || row.relationship !== "subagent")) return null;
      return { ...scope, verified: true, relationship: row.relationship };
    };
    const result = await handleBudgetHook(input, { service: integration.budgets, resolveScope });
    if (result.output) process.stdout.write(result.output + "\n");
  }
} catch {
}
