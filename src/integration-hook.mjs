// Plugin-local lifecycle command. Silent unless this exact conversation opted in.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { handleBudgetHook } from './budget-hook.mjs';
import { createIntegration, pluginDataDir } from './integration-adapter.mjs';
import { readTelemetry } from './usage-engine.mjs';

try {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 262144) throw new Error('Hook input too large');
  }
  const input = JSON.parse(raw || '{}');
  const dataDir = pluginDataDir();
  const store = JSON.parse(await readFile(join(dataDir,'budgets-v1.json'),'utf8'));
  if (Object.values(store.budgets || {}).some(row=>row.enabled === true)) {
    const integration = createIntegration({dataDir,readAccount:request=>readTelemetry('account',request),
      readThread:thread_id=>readTelemetry('thread',{thread_id}),readQuota:async()=>({status:'unavailable'}),estimateCapacity:()=>({status:'unavailable'})});
    const resolveScope = async ({sessionId,agentId,event}) => {
      const selected = event === 'SubagentStart' ? agentId : sessionId;
      if (!selected) return null;
      const scope = await integration.budgetScope({thread_id:selected});
      if (!scope?.accountId) return null;
      const inventory = await integration.account({threadId:selected});
      const row = inventory.conversations.find(row=>row.threadId===selected);
      if (!row || row.sourceFiles < 1 || row.issues?.some(issue=>/conflict|lineage/.test(issue))) return null;
      if (event === 'SubagentStart' && (row.parentThreadId !== sessionId || row.relationship !== 'subagent')) return null;
      return {...scope,verified:true,relationship:row.relationship};
    };
    const result = await handleBudgetHook(input,{service:integration.budgets,resolveScope});
    if (result.output) process.stdout.write(result.output+'\n');
  }
} catch { /* Never block, print diagnostics, or trigger another model turn. */ }
