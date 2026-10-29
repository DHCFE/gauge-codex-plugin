// Optional command-hook entry. Packaging supplies the trusted adapter; no global setup.
import { pathToFileURL } from 'node:url';

const EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'SubagentStart', 'PreToolUse']);

/** resolveScope derives account/lineage from trusted local telemetry, not prompt text.
 * SubagentStart has the PARENT session_id; target agent_id needs explicit verification.
 */
export async function handleBudgetHook(input, { service, resolveScope } = {}) {
  const event = input?.hook_event_name;
  if (!EVENTS.has(event) || !service || !resolveScope || typeof input.session_id !== 'string') return { output: '', reason: 'unsupported-or-unconfigured' };
  const scope = await resolveScope({ sessionId: input.session_id,
    agentId: event === 'SubagentStart' && typeof input.agent_id === 'string' ? input.agent_id : undefined,
    event });
  if (!scope?.accountId || !scope?.threadId || scope.verified !== true) return { output: '', reason: 'scope-unverified' };
  if (event === 'SubagentStart' && (scope.relationship !== 'subagent' || scope.threadId === input.session_id)) return { output: '', reason: 'agent-lineage-unverified' };
  const result = await service.getContext({ accountId: scope.accountId, threadId: scope.threadId,
    event, turnId: typeof input.turn_id === 'string' ? input.turn_id : undefined });
  if (!result.shouldDeliver || !result.context) return { output: '', reason: result.reason };
  const delivery = await service.recordDelivery({ accountId: scope.accountId, threadId: scope.threadId,
    epoch: result.budget.epoch, revision: result.budget.revision, deliveryId: result.deliveryId,
    turnKey: result.turnKey, budgetStatus: result.budget.status, channel: 'hook', hostVerified: false });
  if (!delivery.recorded) return { output: '', reason: delivery.reason };
  return { output: JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: result.context } }),
    reason: 'emitted-unverified', delivery };
}

export async function runBudgetHook({ input, adapterPath, write = text => process.stdout.write(text) } = {}) {
  // No adapter means no IO besides stdin and absolutely no model context.
  if (!adapterPath) return { output: '', reason: 'unconfigured' };
  try {
    const adapter = await import(pathToFileURL(adapterPath).href);
    const dependencies = await adapter.createHookDependencies();
    const result = await handleBudgetHook(input, dependencies);
    if (result.output) write(result.output + '\n');
    return result;
  } catch {
    // Hooks must never block tool calls or start continuation loops on failure.
    // The panel can expose integration/ledger unavailability on its own next read.
    return { output: '', reason: 'adapter-unavailable' };
  }
}

if (process.env.TOKENLENS_HOOK_LIBRARY !== '1' && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let raw = '';
    for await (const chunk of process.stdin) {
      raw += chunk;
      if (Buffer.byteLength(raw) > 262_144) throw new Error('Hook input too large');
    }
    await runBudgetHook({ input: JSON.parse(raw || '{}'), adapterPath: process.env.TOKENLENS_BUDGET_ADAPTER });
  } catch { /* Successful silence: no stderr, exit 2, Stop feedback or prompts. */ }
}
