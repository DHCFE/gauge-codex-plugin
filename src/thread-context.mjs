// Request-scoped metadata used by the bundled Codex app-tools server.
// Never infer a conversation from process state, recent activity, or saved defaults.
export function resolveThread(explicitId, metadata = {}) {
  if (explicitId !== undefined) return { id: explicitId, source: 'explicit' };
  for (const key of ['openai/threadId','openai/thread_id','codexThreadId','codex_thread_id','threadId','thread_id']) {
    if (typeof metadata[key] === 'string' && metadata[key].trim()) return { id: metadata[key], source: key };
  }
  let turn = metadata['x-codex-turn-metadata'];
  if (typeof turn === 'string') { try { turn = JSON.parse(turn); } catch { turn = null; } }
  if (typeof turn?.thread_id === 'string' && turn.thread_id.trim()) return { id: turn.thread_id, source: 'x-codex-turn-metadata' };
  if (typeof metadata.thread?.id === 'string' && metadata.thread.id.trim()) return { id: metadata.thread.id, source: 'thread.id' };
  return null;
}
