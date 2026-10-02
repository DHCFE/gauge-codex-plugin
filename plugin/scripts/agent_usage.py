"""Local descendant accounting, independently implemented from CodexBar's approach.

Only telemetry and lineage are cached. Native response ownership wins over legacy
cumulative counters. Explicit history ordinals win over inferred boundaries.
"""
from __future__ import annotations
import copy
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import time
from contextlib import closing
from decimal import Decimal
import cost_meter as m

REVISION = 1
MAX_FILES = 20000
MAX_DESCENDANTS = 512
SCAN_SECONDS = 3.0


def lineage(p):
    source = p.get('source')
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
    p = row.get('payload', {})
    if row.get('type') != 'session_meta' or not m.label(p.get('id')):
        raise ValueError('Missing session identity')
    boundary = p.get('subagent_history_start_ordinal')
    if boundary is not None and (type(boundary) is not int or boundary < 0):
        raise ValueError('Invalid history boundary')
    base = p.get('history_base') or {}
    return {'id': p['id'], 'parent': lineage(p), 'boundary': boundary,
            'fork': m.label(p.get('forked_from_id')), 'provider': m.label(p.get('model_provider')),
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
                if row and json.loads(row[0]) == signature:
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


def fresh(meta):
    return {'revision': REVISION, 'meta': meta, 'cursor': None, 'line': 0,
            'turn': None, 'model': None, 'effort': None, 'root': meta['root_turn'],
            'prev': None, 'inherited': None, 'started': False, 'marker': False,
            'embedded': False, 'turn_roots': {}, 'turn_status': {},
            'native': {}, 'legacy': [], 'native_totals': {}, 'warnings': [], 'pending': False}


def note(s, message):
    if message not in s['warnings']:
        s['warnings'].append(message)


def seg(s, raw, known=True, model=None):
    return {'usage': m.usage(raw), 'model': m.label(model) or s['model'],
            'provider': s['meta']['provider'], 'request_known': known,
            'cache_write_known': 'cache_write_input_tokens' in raw}


def ingest(s, row):
    p = row.get('payload', {})
    if not isinstance(p, dict):
        return
    kind, sid = row.get('type'), s['meta']['id']
    boundary = s['meta']['boundary']
    ordinal = row.get('ordinal')
    if boundary is not None:
        owned = type(ordinal) is int and ordinal >= boundary
        if ordinal is None and s['line']:
            note(s, 'History ordinal missing; child ownership cannot be verified.')
    else:
        owned = True
    if kind == 'session_meta':
        if s['line'] and p.get('id') != sid:
            s['embedded'] = True
            s['marker'] = False
        return
    if not owned:
        if kind == 'event_msg' and p.get('type') == 'token_count':
            raw = (p.get('info') or {}).get('total_token_usage')
            if raw:
                s['inherited'] = m.usage(raw)
        return
    if kind == 'turn_context':
        s['turn'] = m.label(p.get('turn_id'))
        s['model'] = m.label(p.get('model'))
        s['effort'] = m.label(p.get('effort'))
        # Do not carry a root turn from a previous activation of the same agent.
        s['root'] = m.label(p.get('root_turn_id')) or s['meta']['root_turn']
        s['marker'] = False
    elif kind == 'inter_agent_communication_metadata':
        if p.get('trigger_turn') is True:
            s['marker'] = True
        s['root'] = m.label(p.get('root_turn_id')) or s['root']
    elif kind == 'event_msg' and p.get('type') in ('task_started', 'task_complete', 'turn_aborted'):
        tid = m.label(p.get('turn_id')) or s['turn']
        if p['type'] == 'task_started':
            s['turn'], s['model'] = tid, None
            s['root'] = m.label(p.get('root_turn_id')) or s['meta']['root_turn']
        if tid:
            s['turn_status'][tid] = {'task_started': 'running', 'task_complete': 'completed',
                                     'turn_aborted': 'interrupted'}[p['type']]
    elif kind == 'token_usage_record':
        if p.get('thread_id') != sid:
            return  # A copied parent's request is never a child's expense.
        tid, rid = m.label(p.get('turn_id')), m.label(p.get('response_id'))
        if not tid or not rid:
            note(s, 'Native child request identity missing.')
            return
        root = m.label(p.get('root_turn_id')) or s['root']
        entry = {'turn': tid, 'root': root, 'request': rid, 'segment': seg(s, p.get('usage'), model=p.get('model'))}
        previous = s['native'].get(rid)
        if previous and previous != entry:
            note(s, 'Conflicting native child request; first record retained.')
        elif not previous:
            s['native'][rid] = entry
        roots = s['turn_roots'].setdefault(tid, [])
        if root and root not in roots:
            roots.append(root)
        if p.get('turn_token_usage'):
            s['native_totals'][tid] = m.usage(p['turn_token_usage'])
        # Legacy mirrors after native records must not reintroduce inherited counters.
        if p.get('thread_token_usage'):
            s['prev'] = m.usage(p['thread_token_usage'])
    elif kind == 'event_msg' and p.get('type') == 'token_count':
        info = p.get('info') or {}
        if not info.get('total_token_usage'):
            return
        total = m.usage(info['total_token_usage'])
        last_raw = info.get('last_token_usage')
        last = m.usage(last_raw) if last_raw else None
        if not s['turn']:
            note(s, 'Legacy child usage has no turn identity.')
            return
        if not s['started']:
            inherited = s['inherited']
            if inherited and (total == inherited or (last == total and total['total_tokens'] >= inherited['total_tokens'])):
                s['inherited'] = total
                return
            # Explicit boundary, or a local delivery marker plus component-wise
            # total-last proof, establishes the child's first owned increment.
            proof = boundary is not None or s['marker']
            if not proof:
                s['inherited'] = total
                note(s, 'Legacy child ownership is unresolved; inherited counters were not charged.')
                return
            if last is None:
                note(s, 'First owned child request lacks last_token_usage; baseline unresolved.')
                return
            try:
                s['prev'] = m.subtract(total, last)
            except m.MeterError:
                note(s, 'First child cumulative baseline is invalid.')
                return
            s['started'] = True
        prev = s['prev'] or m.zero()
        s['prev'] = total
        if total == prev:
            return  # A fresh timestamp alone is not new consumption.
        try:
            delta = m.subtract(total, prev)
        except m.MeterError:
            note(s, 'Child counters reset; only the last request could be recovered.')
            delta = last
        if not delta or not delta['total_tokens']:
            return
        raw = dict(delta)
        if not last_raw or 'cache_write_input_tokens' not in last_raw:
            raw.pop('cache_write_input_tokens', None)
        entry = {'turn': s['turn'], 'root': s['root'], 'segment': seg(s, raw, delta == last)}
        # Stable across active/archive copies, and safe when ordinals restart.
        evidence = [sid, s['turn'], row.get('timestamp'), ordinal, total, delta]
        entry['request'] = 'legacy:' + hashlib.sha256(json.dumps(evidence, sort_keys=True).encode()).hexdigest()
        s['legacy'].append(entry)


def scan(path, meta, db):
    cached = db.execute('SELECT state FROM scans WHERE path=?', (str(path),)).fetchone()
    s = json.loads(cached[0]) if cached else fresh(meta)
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NONBLOCK', 0) | getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(fd, 'rb') as f:
        st = os.fstat(f.fileno())
        if not stat.S_ISREG(st.st_mode):
            raise ValueError('Not a regular transcript')
        identity = [st.st_dev, st.st_ino]
        c = s.get('cursor')
        if (s.get('revision') != REVISION or s.get('meta') != meta or not c or c['identity'] != identity
                or st.st_size < c['offset'] or m.tail_hash(f, c['offset']) != c['anchor']
                or (st.st_size == c['offset'] and st.st_mtime_ns != c['mtime'])):
            s = fresh(meta)
        offset = s['cursor']['offset'] if s['cursor'] else 0
        f.seek(offset)
        start, deadline = offset, time.monotonic() + SCAN_SECONDS
        s['pending'] = False
        while f.tell() - start < m.MAX_SCAN and time.monotonic() < deadline:
            offset = f.tell()
            line = f.readline(m.MAX_LINE + 1)
            if not line:
                break
            if len(line) > m.MAX_LINE:
                note(s, 'Oversized child record; coverage incomplete.')
                s['pending'] = True
                f.seek(offset)
                break
            if not line.endswith(b'\n'):
                s['pending'] = True
                f.seek(offset)
                break
            try:
                ingest(s, json.loads(line))
            except (ValueError, TypeError, AttributeError):
                note(s, 'Invalid child telemetry record; coverage incomplete.')
            s['line'] += 1
        else:
            s['pending'] = True
        offset = f.tell()
        s['cursor'] = {'identity': identity, 'offset': offset, 'anchor': m.tail_hash(f, offset), 'mtime': st.st_mtime_ns}
    db.execute('INSERT OR REPLACE INTO scans VALUES (?,?)', (str(path), json.dumps(s)))
    return s


def summarize(entries, prices, pending=False, warnings=()):
    t = m.turn(m.fresh(), 'aggregate')
    t['fallback'] = [e['segment'] for e in entries]
    t['seen_usage'] = bool(entries)
    t['warnings'] = list(warnings)
    t['status'] = 'running' if pending else 'observed'
    result = m.summarize_turn(t, prices)
    result['source'] = 'descendant-owned-requests'
    return result


def merge(items):
    present = [x for x in items if x and x.get('usage') is not None]
    if not present:
        return None
    u, amounts, cost, priced = m.zero(), m.zero_costs(), Decimal(0), 0
    complete, split = True, True
    for item in present:
        u = m.add(u, item['usage'])
        cost += Decimal(item['known_usd'])
        priced += item['priced_tokens']
        complete &= item['cost_complete']
        split &= item['cost_breakdown']['input']['tokens'] is not None
        for key, part in item['cost_breakdown'].items():
            amounts[key] += Decimal(part['known_usd'])
    return {'usage': u, 'usd': m.money(cost) if complete else None, 'known_usd': m.money(cost),
            'priced_tokens': priced, 'cost_complete': complete,
            'cost_breakdown': m.cost_breakdown(u, amounts, complete, split),
            'source': 'main-and-descendant-requests', 'status': 'observed',
            'models': sorted({model for x in present for model in x.get('models', [])}),
            'warnings': list(dict.fromkeys(w for x in present for w in x.get('warnings', []))),
            'cache_write_complete': all(x.get('cache_write_complete', True) for x in present)}


def invalidate(item):
    if item:
        item['usd'], item['cost_complete'] = None, False
        for part in (item.get('cost_breakdown') or {}).values():
            part['usd'] = None


def aggregate(report, event, data, prices, home):
    sid, tid = report['session_id'], report['turn_id']
    path = Path(event['transcript_path']).resolve()
    roots = [home/'sessions', home/'archived_sessions']
    if not any(path.is_relative_to(root.resolve()) for root in roots):
        return report  # Explicit standalone fixtures do not inspect ambient chats.
    with closing(sqlite3.connect(data/'agents.sqlite3', timeout=1.0)) as db, db:
        db.execute('CREATE TABLE IF NOT EXISTS headers(path TEXT PRIMARY KEY, signature TEXT, metadata TEXT)')
        db.execute('CREATE TABLE IF NOT EXISTS scans(path TEXT PRIMARY KEY, state TEXT)')
        files, discovered = inventory(home, db)
        parents = {}
        conflicting = set()
        for meta in files.values():
            child, parent = meta['id'], meta['parent']
            if child in parents and parents[child] != parent:
                conflicting.add(child)
            parents[child] = parent
        descendants, frontier = set(), {sid}
        for _ in range(32):
            new = {child for child, parent in parents.items() if parent in frontier and child != sid} - descendants
            if not new:
                break
            descendants |= new
            frontier = new
            if len(descendants) > MAX_DESCENDANTS:
                discovered = False
                descendants = set(sorted(descendants)[:MAX_DESCENDANTS])
                break
        else:
            discovered = False
        notes, states, entries, native_turns = [], [], {}, set()
        if not discovered:
            notes.append('Descendant discovery is incomplete; totals are partial.')
        deadline = time.monotonic() + SCAN_SECONDS
        selected_files = [(p, meta) for p, meta in files.items() if meta['id'] in descendants]
        # Old cached files are cheap; rotating order prevents starving a long history.
        selected_files.sort(key=lambda x: (db.execute('SELECT 1 FROM scans WHERE path=?', (x[0],)).fetchone() is not None, x[0]))
        for p, meta in selected_files:
            if time.monotonic() > deadline:
                notes.append('Descendant scan budget reached; totals are partial.')
                break
            if meta['id'] in conflicting:
                notes.append('Conflicting child lineage; ambiguous thread excluded.')
                continue
            try:
                s = scan(p, meta, db)
            except (OSError, ValueError):
                notes.append('A related child transcript could not be read.')
                continue
            states.append(s)
            notes.extend(s['warnings'])
            if s['pending']:
                notes.append('Child records are still arriving; scan coverage is partial.')
            for entry in s['native'].values():
                native_turns.add((meta['id'], entry['turn']))
        # Native records take precedence over legacy mirrors across all copies.
        for s in states:
            child = s['meta']['id']
            candidates = list(s['native'].values()) + [e for e in s['legacy'] if (child, e['turn']) not in native_turns]
            for entry in candidates:
                key = (child, entry['request'])
                if key in entries and entries[key] != entry:
                    notes.append('Conflicting duplicate child request; totals need review.')
                else:
                    entries[key] = entry
        native_observed = {}
        for (child, _), entry in entries.items():
            if (child, entry['turn']) in native_turns:
                key = (child, entry['turn'])
                native_observed[key] = m.add(native_observed.get(key, m.zero()), entry['segment']['usage'])
        for s in states:
            for turn, total in s['native_totals'].items():
                observed = native_observed.get((s['meta']['id'], turn), m.zero())
                if any(observed[k] < total[k] for k in m.FIELDS):
                    notes.append('Child native totals exceed observed requests; coverage is partial.')
        all_entries = list(entries.values())
        current = [e for e in all_entries if e['root'] == tid]
        unattributed = [e for e in all_entries if not e['root']]
        active = {s['meta']['id'] for s in states if any(v == 'running' for v in s['turn_status'].values())}
        pending_children = descendants - {s['meta']['id'] for s in states if s['native'] or s['legacy']}
        if pending_children:
            notes.append('Some descendants have no owned usage records yet.')
        child_turn, child_thread = summarize(current, prices, bool(active)), summarize(all_entries, prices, bool(active))
        out = copy.deepcopy(report)
        out['main'] = {'turn': copy.deepcopy(report['turn']), 'thread': copy.deepcopy(report['thread'])}
        out['subagents'] = {'thread_count': len(descendants), 'current_thread_count': len({k[0] for k,e in entries.items() if e['root'] == tid}),
                           'active_thread_count': len(active), 'pending_thread_count': len(pending_children),
                           'turn': child_turn, 'thread': child_thread,
                           'unattributed_tokens': sum(e['segment']['usage']['total_tokens'] for e in unattributed),
                           'discovery_complete': discovered, 'warnings': list(dict.fromkeys(notes))}
        if all_entries:
            out['thread'] = merge([report['thread'], child_thread])
        if current:
            out['turn'] = merge([report['turn'], child_turn])
        if unattributed:
            notes.append('Some child requests lack root_turn_id; included only in conversation total, not guessed into this turn.')
            invalidate(out['turn'])
        if notes:
            invalidate(out['turn'])
            invalidate(out['thread'])
        out['warnings'] = list(dict.fromkeys(out['warnings'] + notes))
        out['scope'] = 'Current thread and verified descendants; only child requests with matching root_turn_id enter this turn. Before-reply snapshot.'
        # UI histories need the same ownership rules as the selected turn.
        roots = {e['root'] for e in all_entries if e['root']}
        out['per_turn_children'] = {root: summarize([e for e in all_entries if e['root'] == root], prices)
                                    for root in roots}
        return out
