"""Local descendant accounting, independently implemented from CodexBar's approach.

Only telemetry and lineage are cached. Native response ownership wins over legacy
cumulative counters. Explicit history ordinals win over inferred boundaries.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import sqlite3
import stat
import time
from contextlib import closing
import cost_meter as m

HEADER_REVISION = 2
MAX_FILES = 20000
MAX_DESCENDANTS = 512
SCAN_SECONDS = 3.0


def lineage(p):
    source = p.get('source') or p.get('thread_source')
    sub = source.get('subagent') if isinstance(source, dict) else None
    spawn = sub.get('thread_spawn') if isinstance(sub, dict) else None
    parent = m.label(spawn.get('parent_thread_id')) if isinstance(spawn, dict) else None
    # A fork alone is not an agent relationship.
    if sub is not None:
        parent = parent or m.label(p.get('parent_thread_id'))
    return parent


def header(path):
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NONBLOCK', 0) | getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(fd, 'rb') as f:
        if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):
            raise ValueError('Not a regular transcript')
        line = f.readline(m.MAX_LINE + 1)
    if len(line) > m.MAX_LINE or not line.endswith(b'\n'):
        raise ValueError('Incomplete session metadata')
    row = json.loads(line)
    if not isinstance(row, dict) or not isinstance(row.get('payload'), dict):
        raise ValueError('Invalid session metadata')
    p = row.get('payload', {})
    if row.get('type') != 'session_meta' or not m.label(p.get('id')):
        raise ValueError('Missing session identity')
    boundary = p.get('subagent_history_start_ordinal', p.get('history_start_ordinal'))
    if boundary is not None and (type(boundary) is not int or boundary < 0):
        raise ValueError('Invalid history boundary')
    base = p.get('history_base') or {}
    return {'revision': HEADER_REVISION, 'id': p['id'], 'parent': lineage(p), 'boundary': boundary,
            'fork': m.label(p.get('forked_from_id')), 'provider': m.label(p.get('model_provider')),
            'execution_session': m.label(p.get('session_id')),
            'root_turn': m.label(p.get('root_turn_id')),
            'history_base': m.label(base.get('thread_id')) if isinstance(base, dict) else None}


def inventory(home, db):
    """Read only first-record metadata of unrelated chats, never their bodies."""
    files, complete = {}, True
    deadline = time.monotonic() + SCAN_SECONDS
    for base in (home/'sessions', home/'archived_sessions'):
        for path in base.rglob('*.jsonl'):
            if len(files) >= MAX_FILES or time.monotonic() > deadline:
                complete = False
                break
            if path.is_symlink():
                continue
            try:
                st = path.stat()
                signature = [st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns]
                row = db.execute('SELECT signature, metadata FROM headers WHERE path=?', (str(path),)).fetchone()
                if row and json.loads(row[0]) == signature and json.loads(row[1]).get('revision') == HEADER_REVISION:
                    meta = json.loads(row[1])
                else:
                    meta = header(path)
                    db.execute('INSERT OR REPLACE INTO headers VALUES (?,?,?)',
                               (str(path), json.dumps(signature), json.dumps(meta)))
                files[str(path)] = meta
            except (OSError, ValueError, TypeError):
                # An unreadable header might belong to an undiscovered descendant.
                complete = False
        if not complete and time.monotonic() > deadline:
            break
    return files, complete


def summarize(entries, prices, pending=False, warnings=()):
    t = m.turn(m.fresh(), 'aggregate')
    t['fallback'] = [e['segment'] for e in entries]
    t['seen_usage'] = bool(entries)
    t['warnings'] = list(warnings)
    t['status'] = 'running' if pending else 'observed'
    result = m.summarize_turn(t, prices)
    result['source'] = 'local-owned-requests'
    return result


def invalidate(item):
    if item:
        item['usd'], item['cost_complete'] = None, False
        for part in (item.get('cost_breakdown') or {}).values():
            part['usd'] = None



def collect(sid, path, home, data, force_rescan=False):
    """Bounded, conversation-scoped reads using the account/budget ledger parser.

    Unrelated conversations contribute first-record lineage metadata only. Raw
    message text is never persisted. Native ownership and deduplication have a
    single implementation across all three views.
    """
    # account_usage imports lineage above; defer this import until initialization
    # is complete rather than maintaining a second child-request parser.
    import account_usage as ledger
    path = Path(path).resolve() if path is not None else None
    with closing(sqlite3.connect(data/'agents.sqlite3', timeout=10.0)) as db, db:
        ledger.schema(db)
        db.execute('CREATE TABLE IF NOT EXISTS headers(path TEXT PRIMARY KEY, signature TEXT, metadata TEXT)')
        db.execute('BEGIN IMMEDIATE')
        files, discovered = inventory(home, db)
        if path is not None:
            selected = header(path)
            if selected['id'] != sid:
                raise ValueError('Selected transcript identity does not match the conversation.')
            files[str(path)] = selected
        else:
            roots = [p for p, meta in files.items() if meta['id'] == sid]
            if roots:
                path = Path(sorted(roots, key=lambda p: ('archived_sessions' in Path(p).parts, p))[0])
        parents, parent_sets, metadata, conflicting = {}, {}, {}, set()
        for meta in files.values():
            child = meta['id']
            if child in metadata and metadata[child] != meta:
                conflicting.add(child)
            metadata[child] = meta
            parents[child] = meta['parent']
            parent_sets.setdefault(child, set()).add(meta['parent'])
        issues = [] if discovered else ['discovery-incomplete']
        if path is None:
            issues.append('session-metadata-missing')
        descendants, frontier = set(), {sid}
        if sid in conflicting:
            issues.append('conflicting-session-metadata')
        for _ in range(32):
            new = {child for child, links in parent_sets.items() if links & frontier and child != sid} - descendants
            if new & conflicting:
                issues.append('conflicting-session-metadata')
            new -= conflicting
            if not new:
                break
            descendants |= new
            frontier = new
            if len(descendants) > MAX_DESCENDANTS:
                issues.append('descendant-limit')
                descendants = set(sorted(descendants)[:MAX_DESCENDANTS])
                break
        else:
            issues.append('descendant-depth-limit')
        # A cycle involving the selected root cannot establish safe ownership.
        seen, ancestor = {sid}, sid
        while parents.get(ancestor):
            ancestor = parents[ancestor]
            if ancestor in seen:
                issues.append('lineage-cycle')
                descendants.clear()
                break
            seen.add(ancestor)
        chosen = {sid} | descendants
        candidates = [(p, meta) for p, meta in files.items() if meta['id'] in chosen]
        cached = {p: (json.loads(sig), json.loads(raw), refreshed)
                  for p, sig, raw, refreshed in db.execute('SELECT * FROM account_files')}
        candidates.sort(key=lambda item: (cached.get(item[0], (None, None, 0))[2], item[0]))
        valid_paths, states, used = [], {}, 0
        deadline = time.monotonic() + SCAN_SECONDS
        for p, meta in candidates:
            try:
                st = Path(p).stat()
                signature = [st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns]
                old = cached.get(p)
                unchanged = (old and old[0] == signature and old[1].get('revision') == ledger.REVISION)
                if unchanged and not force_rescan and not old[1]['pending'] and not old[1]['limited']:
                    state = old[1]
                elif used >= ledger.MAX_SCAN_BYTES or time.monotonic() >= deadline:
                    issues.append('scan-deferred')
                    if not unchanged:
                        continue  # Never display stale rows after replacement.
                    state = old[1]
                else:
                    state, amount = ledger.scan_file(Path(p), db, min(ledger.MAX_FILE_BYTES, ledger.MAX_SCAN_BYTES-used), deadline, force=force_rescan)
                    used += amount
                valid_paths.append(p)
                states[p] = state
            except (OSError, ValueError):
                issues.append('transcript-unreadable')
        records, threads, quality = ledger.canonical(db, valid_paths, include_inherited=False)
        # The complete first-record inventory already verifies these ancestors;
        # they need not be body-scanned to establish this selected subtree.
        quality = [code for code in quality if code != 'parent-transcript-missing']
        issues.extend(quality)
        for child, thread in threads.items():
            seen, root = {child}, child
            while parents.get(root):
                root = parents[root]
                if root in seen:
                    root = None
                    break
                seen.add(root)
            thread['conversationId'] = root
        for rec in records:
            rec['conversationId'] = threads.get(rec['threadId'], {}).get('conversationId')
        index_stats, index_issues = ledger.merge_index(home, threads, sid)
        issues.extend(index_issues)
        for child, thread in threads.items():
            if child != sid and thread.get('parentThreadId') and thread.get('sourceFiles') == 0:
                descendants.add(child)
                issues.extend(thread['issues'])
        own = [r for r in records if r['ownership'] == 'owned' and r['threadId'] in chosen]
        root_states = [(p, state) for p, state in states.items() if (state.get('meta') or {}).get('id') == sid]
        root_states.sort(key=lambda item: item[0] != str(path))
        order, statuses = [], {}
        for _, state in root_states:
            for turn in state['turnOrder']:
                if turn not in order:
                    order.append(turn)
            for turn, status in state['turnStatuses'].items():
                statuses.setdefault(turn, status)
        current = root_states[0][1]['turn'] if root_states else None
        active = {state['meta']['id'] for state in states.values()
                  if state.get('meta') and state['meta']['id'] in descendants
                  and any(status == 'running' for status in state['turnStatuses'].values())}
        observed_children = {r['threadId'] for r in own if r['threadId'] in descendants}
        pending_children = descendants - observed_children
        if pending_children:
            issues.append('descendant-usage-pending')
        for turn in {r['turnId'] for r in own if r['threadId'] == sid and r['turnId']}:
            if turn not in order:
                order.append(turn)
        issues = sorted(set(issues))
        pending_files = sum(s['pending'] for s in states.values())
        limited_files = sum(s['limited'] for s in states.values())
        scan_pending = bool(not discovered or any(code in issues for code in
                    ('scan-deferred', 'scan-incomplete', 'records-pending', 'descendant-usage-pending')))
        return {'records': records, 'threads': threads, 'turns': order, 'statuses': statuses, 'current': current,
                'descendants': descendants, 'active': active, 'pending_children': pending_children,
                'issues': issues, 'complete': not any(code != 'embedded-history' for code in issues),
                'index_stats': index_stats,
                'scan_pending': scan_pending, 'bytes_read': used,
                'scan': {'scanCaughtUp': not scan_pending, 'filesCatchupPending': limited_files,
                         'filesWithPendingTail': pending_files, 'bytesRemaining': sum(
                             max(0, Path(p).stat().st_size-s['cursor']['offset']) for p, s in states.items()),
                         'discoveryComplete': discovered, 'filesDiscovered': len(candidates),
                         'filesScanned': len(valid_paths), 'filesUnchanged': 0,
                         'filesDeferred': len(candidates)-len(valid_paths), 'bytesRead': used, 'issues': []}}


def request_entry(rec):
    return {'segment': {'usage': rec['usage'], 'model': rec['model'], 'provider': rec['provider'],
                        'request_known': rec['requestKnown'], 'cache_write_known': rec['cacheWriteKnown']}}
