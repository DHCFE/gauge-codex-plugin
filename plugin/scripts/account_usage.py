#!/usr/bin/env python3
"""Local request ledger. Persist allowlisted telemetry only; never read credentials.

Existing TokenLens pricing and lineage adapters are reused. Native requests win
across active/archive copies. Unverified legacy ownership is quarantined. The
API is snapshot(request, home=None, data_dir=None); the CLI takes stdin JSON.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import os
from pathlib import Path
import sqlite3
import stat
import re
import sys
import time
from contextlib import closing
from datetime import datetime, timezone
from decimal import Decimal
from zoneinfo import ZoneInfo

import cost_meter as m
from agent_usage import lineage

REVISION = 3
ENVELOPE_TYPE = re.compile(rb'^\s*\{\s*(?:"(?:timestamp|ordinal)"\s*:\s*(?:"[^"]*"|\d+)\s*,\s*)*"type"\s*:\s*"([^"]+)"')
NON_TELEMETRY = {b'response_item', b'compacted', b'world_state'}
MAX_FILES = 20000
MAX_SCAN_BYTES = 64 * 1024 * 1024
MAX_FILE_BYTES = 16 * 1024 * 1024
SCAN_SECONDS = 3.0


def stamp(value):
    """UTC milliseconds. Naive dates and ambiguous seconds are not accepted."""
    if value is None:
        return None
    if type(value) in (int, float):
        if not math.isfinite(value) or not 0 <= value <= 253402300799999:
            raise ValueError('Invalid Unix milliseconds')
        return int(value)
    if not isinstance(value, str):
        raise ValueError('Expected ISO8601 with timezone or Unix milliseconds')
    dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if dt.tzinfo is None:
        raise ValueError('Timestamp must include a timezone')
    return int(dt.timestamp() * 1000)


def safe_stamp(value):
    try:
        return stamp(value)
    except (ValueError, TypeError, OverflowError):
        return None


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def note(state, code):
    if code not in state['issues']:
        state['issues'].append(code)


def identity(p):
    # These fields are telemetry claims, not evidence inferred from auth.json.
    account = p.get('account') if isinstance(p.get('account'), dict) else {}
    return (m.label(p.get('account_id')) or m.label(p.get('chatgpt_account_id'))
            or m.label(p.get('creator_account_id')) or m.label(account.get('id')))


def fresh():
    return {'revision': REVISION, 'identityProbeRevision': 1, 'modelIndexRevision': 1, 'meta': None, 'turn': None, 'model': None,
            'provider': None, 'rootTurn': None, 'prev': None, 'inherited': None,
            'accountId': None, 'billingPoolId': None, 'billingMode': None,
            'ownedStarted': False, 'marker': False, 'embedded': False,
            'seenTotals': [], 'watermark': None, 'interleaved': False,
            'turnModels': {}, 'nativeTotals': {}, 'latestTotal': None, 'issues': [], 'line': 0,
            'cursor': None, 'pending': False, 'limited': False, 'oversize': None}


def record(state, row, raw, key, source, known=True, ownership='owned', **extra):
    p, meta = row['payload'], state['meta']
    values = m.usage(raw)
    rec = {'id': key, 'threadId': meta['id'], 'turnId': m.label(p.get('turn_id')) or state['turn'],
           'responseId': m.label(p.get('response_id')), 'rootTurnId': m.label(p.get('root_turn_id')) or state['rootTurn'],
           'timestamp': safe_stamp(row.get('timestamp') or p.get('timestamp')),
           'source': source, 'ownership': ownership, 'usage': values,
           'model': m.label(p.get('model')) or state.get('turnModels', {}).get(m.label(p.get('turn_id')) or state['turn']) or state['model'], 'provider': m.label(p.get('model_provider')) or state['provider'],
           'accountId': identity(p) or state['accountId'] or meta['accountId'],
           'accountEvidence': 'request-telemetry' if identity(p) else state.get('accountEvidence') or meta.get('accountEvidence', 'account-telemetry' if meta['accountId'] else 'not-recorded'), 'billingPoolId': m.label(p.get('billing_pool_id')) or m.label(p.get('rate_limit_id')) or state['billingPoolId'] or meta['billingPoolId'],
           'billingMode': m.label(p.get('billing_mode')) or state['billingMode'] or meta['billingMode'],
           'requestKnown': known, 'cacheWriteKnown': 'cache_write_input_tokens' in raw,
           'reasoningKnown': 'reasoning_output_tokens' in raw, 'timeRangeKnown': known,
           **extra}
    if source == 'native-request' and rec['turnId'] != state['turn'] and not m.label(p.get('model')):
        rec['model'] = state.get('turnModels', {}).get(rec['turnId'])
    return rec


def ingest(state, row):
    if not isinstance(row, dict) or not isinstance(row.get('payload'), dict):
        return []
    kind, p = row.get('type'), row['payload']
    if kind == 'session_meta':
        if state['meta'] is None:
            sid = m.label(p.get('id'))
            if not sid:
                raise ValueError('Missing session identity')
            boundary = p.get('subagent_history_start_ordinal', p.get('history_start_ordinal'))
            if boundary is not None and (type(boundary) is not int or boundary < 0):
                note(state, 'invalid-history-boundary')
                boundary = None
            base = p.get('history_base') or {}
            state['meta'] = {'id': sid, 'parentThreadId': lineage(p) or lineage(dict(p, source=p.get('thread_source'))), 'forkedFromId': m.label(p.get('forked_from_id')),
                             'historyBaseId': m.label(base.get('thread_id')) if isinstance(base, dict) else None,
                             'boundary': boundary, 'accountId': identity(p), 'accountEvidence': 'creator-account-telemetry' if p.get('creator_account_id') else 'account-telemetry' if identity(p) else 'not-recorded',
                             'billingPoolId': m.label(p.get('billing_pool_id')) or m.label(p.get('rate_limit_id')),
                             'billingMode': m.label(p.get('billing_mode')),
                             'project': p.get('cwd') if isinstance(p.get('cwd'), str) and len(p['cwd']) < 4096 else None,
                             'createdAt': safe_stamp(row.get('timestamp') or p.get('timestamp'))}
            state['provider'] = m.label(p.get('model_provider'))
            state['rootTurn'] = m.label(p.get('root_turn_id'))
        elif p.get('id') != state['meta']['id']:
            state['embedded'] = True
            note(state, 'embedded-history')
        return []
    if not state['meta']:
        note(state, 'telemetry-before-metadata')
        return []
    meta = state['meta']
    boundary, ordinal = meta['boundary'], row.get('ordinal')
    inherited = boundary is not None and (type(ordinal) is not int or ordinal < boundary)
    if inherited:
        if ordinal is None:
            note(state, 'history-ordinal-missing')
        if kind == 'event_msg' and p.get('type') == 'token_count':
            raw = (p.get('info') or {}).get('total_token_usage')
            if raw:
                state['inherited'] = m.usage(raw)
        return []
    if kind == 'turn_context':
        state['turn'] = m.label(p.get('turn_id')) or state['turn']
        state['model'] = m.label(p.get('model'))
        if state['turn'] and state['model']:
            state.setdefault('turnModels', {})[state['turn']] = state['model']
        state['provider'] = m.label(p.get('model_provider')) or state['provider']
        state['rootTurn'] = m.label(p.get('root_turn_id'))
        state['accountId'] = identity(p) or meta['accountId']
        state['accountEvidence'] = 'context-telemetry' if identity(p) else meta.get('accountEvidence', 'account-telemetry' if meta['accountId'] else 'not-recorded')
        state['billingPoolId'] = m.label(p.get('billing_pool_id')) or m.label(p.get('rate_limit_id')) or meta['billingPoolId']
        state['billingMode'] = m.label(p.get('billing_mode')) or meta['billingMode']
    elif kind == 'inter_agent_communication_metadata':
        state['marker'] = p.get('trigger_turn') is True
        state['rootTurn'] = m.label(p.get('root_turn_id')) or state['rootTurn']
    elif kind == 'event_msg' and p.get('type') == 'task_started':
        state['turn'], state['model'] = m.label(p.get('turn_id')), None
        state['rootTurn'] = m.label(p.get('root_turn_id'))
    elif kind == 'event_msg' and p.get('type') == 'model_rerouted':
        state['model'] = m.label(p.get('to_model'))
        if state['turn'] and state['model']:
            state.setdefault('turnModels', {})[state['turn']] = state['model']
    elif kind == 'token_usage_record':
        if p.get('thread_id') != meta['id']:
            # Preserve an orphaned copied request for inspection; a matching
            # native owner later suppresses it. Never charge copied history.
            owner, rid = m.label(p.get('thread_id')), m.label(p.get('response_id'))
            if not owner or not rid:
                note(state, 'native-request-identity-missing')
                return []
            return [record(state, row, p.get('usage'), 'inherited:' + digest([owner, rid]),
                           'native-inherited', True, 'unresolved', threadId=owner,
                           observedInThreadId=meta['id'], model=m.label(p.get('model')),
                           accountId=identity(p), billingPoolId=m.label(p.get('billing_pool_id')) or m.label(p.get('rate_limit_id')))]
        rid, tid = m.label(p.get('response_id')), m.label(p.get('turn_id'))
        if not rid or not tid:
            note(state, 'native-request-identity-missing')
            return []
        if p.get('turn_token_usage'):
            state['nativeTotals'][tid] = m.usage(p['turn_token_usage'])
        if p.get('thread_token_usage'):
            state['prev'] = m.usage(p['thread_token_usage'])
            state['watermark'] = state['prev']
            state['latestTotal'] = state['prev']
        return [record(state, row, p.get('usage'), 'native:' + digest([meta['id'], rid]), 'native-request')]
    elif kind == 'event_msg' and p.get('type') == 'token_count':
        info = p.get('info') or {}
        if not isinstance(info, dict) or not info.get('total_token_usage'):
            return []
        total = m.usage(info['total_token_usage'])
        last_raw = info.get('last_token_usage')
        last = m.usage(last_raw) if last_raw else None
        prev = state['prev']
        state['latestTotal'] = total
        related = meta['parentThreadId'] or meta['forkedFromId'] or meta['historyBaseId'] or state['embedded']
        ownership = 'owned'
        if related and not state['ownedStarted']:
            # A local delivery marker or explicit ordinal is the only supported
            # legacy suffix proof. First totals alone do not establish ownership.
            proof = boundary is not None or state['marker']
            if proof and last is not None:
                if state['inherited'] == total:
                    state['prev'] = total
                    return []
                prev = m.subtract(total, last)
                state['ownedStarted'] = True
                state['embedded'] = False
            else:
                ownership = 'unresolved'
                note(state, 'legacy-lineage-unresolved')
        state['prev'] = total
        if prev == total or digest(total) in state['seenTotals']:
            return []
        state['seenTotals'] = (state['seenTotals'] + [digest(total)])[-64:]
        watermark = state['watermark'] or prev or m.zero()
        state['watermark'] = {k: max(watermark[k], total[k]) for k in m.FIELDS}
        if any(total[k] < watermark[k] for k in m.FIELDS):
            state['interleaved'] = True
            note(state, 'cumulative-counter-reset')
        try:
            # After a regression, lower lineages cannot consume the same high
            # watermark gap again. Exact re-emissions are suppressed above.
            delta = m.subtract(total, watermark if state['interleaved'] else prev or m.zero())
        except m.MeterError:
            note(state, 'cumulative-counter-reset')
            # Do not charge last_token_usage alone below the watermark. There
            # is no request identity to prove that it is a new expense.
            if last is not None:
                return [record(state, row, last_raw, 'reset:' + digest([meta['id'], total, last]),
                               'cumulative-reset', False, 'unresolved')]
            return []
        if not delta or not delta['total_tokens']:
            return []
        known = delta == last and ownership == 'owned'
        if not known and ownership == 'owned':
            note(state, 'request-boundaries-missing')
        raw = dict(delta)
        if not isinstance(last_raw, dict) or 'cache_write_input_tokens' not in last_raw:
            raw.pop('cache_write_input_tokens', None)
        if not isinstance(last_raw, dict) or 'reasoning_output_tokens' not in last_raw:
            raw.pop('reasoning_output_tokens', None)
        # Timestamp/ordinal changes on duplicate mirrors cannot create a new key.
        key = 'legacy:' + digest([meta['id'], state['turn'], total, delta])
        return [record(state, row, raw, key, 'cumulative-delta', known, ownership)]
    return []


def schema(db):
    db.execute('CREATE TABLE IF NOT EXISTS account_files(path TEXT PRIMARY KEY, signature TEXT, state TEXT, refreshed REAL)')
    db.execute('CREATE TABLE IF NOT EXISTS account_records(path TEXT, id TEXT, record TEXT, PRIMARY KEY(path,id))')
    db.execute('CREATE INDEX IF NOT EXISTS account_records_id ON account_records(id)')


def scan_file(path, db, allowance, deadline, force=False):
    cached = db.execute('SELECT state FROM account_files WHERE path=?', (str(path),)).fetchone()
    state = json.loads(cached[0]) if cached else fresh()
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NONBLOCK', 0) | getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(fd, 'rb') as f:
        st = os.fstat(f.fileno())
        if not stat.S_ISREG(st.st_mode):
            raise ValueError('Not a regular transcript')
        sig = [st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns]
        c = state.get('cursor')
        reset = (force or state.get('revision') != REVISION or not c or c['identity'] != sig[:2]
                 or st.st_size < c['offset'] or m.tail_hash(f, c['offset']) != c['anchor']
                 or (st.st_size == c['offset'] and st.st_mtime_ns != c['mtime']))
        if reset:
            state = fresh()
            db.execute('DELETE FROM account_records WHERE path=?', (str(path),))
        offset = state['cursor']['offset'] if state['cursor'] else 0
        f.seek(offset)
        start = offset
        state['pending'], state['limited'] = False, False
        while f.tell() - start < allowance and time.monotonic() < deadline:
            line_start = f.tell()
            line = f.readline(m.MAX_LINE + 1)
            if not line:
                break
            # Streaming skip for huge messages: never persist their text; resume
            # mid-record using a flag instead of restarting the same large line.
            if state['oversize'] is not None:
                if line.endswith(b'\n'):
                    if state['oversize']:
                        note(state, 'oversized-telemetry-record')
                    state['oversize'] = None
                    state['line'] += 1
                continue
            if not line.endswith(b'\n'):
                if f.tell() == st.st_size and len(line) <= m.MAX_LINE:
                    f.seek(line_start)
                    state['pending'] = True
                    break
                # An allowance split is not evidence of an oversized record.
                if len(line) < m.MAX_LINE + 1:
                    f.seek(line_start)
                    state['limited'] = True
                    break
                allowed = any(('"type": "' + x + '"').encode() in line[:512] or ('"type":"' + x + '"').encode() in line[:512]
                              for x in ('response_item', 'compacted', 'world_state'))
                state['oversize'] = not allowed
                continue
            try:
                # Message/image/tool bodies cannot contribute usage. Skip them
                # before decoding to avoid parsing GBs of unrelated chat text.
                match = ENVELOPE_TYPE.match(line[:512])
                if match and match.group(1) in NON_TELEMETRY:
                    state['line'] += 1
                    continue
                rows = ingest(state, json.loads(line))
                for rec in rows:
                    old = db.execute('SELECT record FROM account_records WHERE path=? AND id=?', (str(path), rec['id'])).fetchone()
                    if old:
                        if json.loads(old[0]) != rec:
                            # Late duplicates sometimes acquire a new timestamp.
                            prior = json.loads(old[0])
                            if any(prior.get(k) != rec.get(k) for k in ('usage', 'model', 'accountId', 'billingPoolId')):
                                note(state, 'conflicting-request-record')
                        continue
                    db.execute('INSERT INTO account_records VALUES (?,?,?)', (str(path), rec['id'], json.dumps(rec)))
            except (ValueError, TypeError, AttributeError):
                note(state, 'invalid-telemetry-record')
            state['line'] += 1
        if state['oversize'] is not None:
            state['pending'] = True
        if f.tell() < st.st_size and not state['pending']:
            state['limited'] = True
        offset = f.tell()
        state['cursor'] = {'identity': sig[:2], 'offset': offset, 'anchor': m.tail_hash(f, offset), 'mtime': st.st_mtime_ns}
        if os.fstat(f.fileno()).st_size != st.st_size:
            state['pending'] = True
        try:
            end = path.stat()
            if (end.st_dev, end.st_ino) != (st.st_dev, st.st_ino):
                state['pending'] = True
                note(state, 'file-replaced-during-scan')
        except OSError:
            state['pending'] = True
            note(state, 'file-disappeared-during-scan')
    db.execute('INSERT OR REPLACE INTO account_files VALUES (?,?,?,?)', (str(path), json.dumps(sig), json.dumps(state), time.time()))
    return state, offset - start


def refresh(home, db, request):
    deadline, paths, issues = time.monotonic() + SCAN_SECONDS, [], []
    discovery_complete = True
    for root in (home / 'sessions', home / 'archived_sessions'):
        if not root.exists():
            continue
        try:
            for path in root.rglob('*.jsonl'):
                if len(paths) >= MAX_FILES or time.monotonic() >= deadline:
                    discovery_complete = False
                    break
                if not path.is_symlink() and not any(p.is_symlink() for p in path.parents if p != home):
                    paths.append(path)
        except OSError:
            discovery_complete = False
    if discovery_complete:
        current = {str(p) for p in paths}
        for (old,) in db.execute('SELECT path FROM account_files').fetchall():
            if old not in current:
                db.execute('DELETE FROM account_files WHERE path=?', (old,))
                db.execute('DELETE FROM account_records WHERE path=?', (old,))
    cached = {p: (json.loads(sig), json.loads(s), age) for p, sig, s, age in db.execute('SELECT * FROM account_files')}
    # Recent files enter a cycle query first; oldest attempts within each
    # priority tier rotate large files so one growing chat cannot starve peers.
    range_start = stamp(request.get('startAt'))
    def scan_priority(path):
        old = cached.get(str(path))
        try:
            modified = path.stat().st_mtime_ns
        except OSError:
            modified = 0
        relevant = range_start is None or modified // 1_000_000 >= range_start
        return (not relevant, old[2] if old else 0, -modified, str(path))
    paths.sort(key=scan_priority)
    used, scanned, unchanged, deferred = 0, 0, 0, 0
    for path in paths:
        try:
            st = path.stat()
            sig = [st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns]
            old = cached.get(str(path))
            if old and old[1].get('meta') and not old[1]['meta'].get('accountId') and not old[1].get('identityProbeRevision'):
                with path.open('rb') as head:
                    header_row = json.loads(head.readline(m.MAX_LINE + 1))
                payload = header_row.get('payload', {})
                explicit = identity(payload)
                if header_row.get('type') == 'session_meta' and payload.get('id') == old[1]['meta']['id'] and explicit:
                    old[1]['meta']['accountId'] = explicit
                    old[1]['meta']['accountEvidence'] = 'creator-account-telemetry' if payload.get('creator_account_id') else 'account-telemetry'
                    db.execute('UPDATE account_files SET state=? WHERE path=?', (json.dumps(old[1]), str(path)))
                    db.execute("UPDATE account_records SET record=json_set(record,'$.accountId',?,'$.accountEvidence',?) WHERE path=? AND json_extract(record,'$.accountId') IS NULL AND json_extract(record,'$.source') != 'native-inherited'", (explicit, old[1]['meta']['accountEvidence'], str(path)))
                old[1]['identityProbeRevision'] = 1
                db.execute('UPDATE account_files SET state=? WHERE path=?', (json.dumps(old[1]), str(path)))
            repair_model = bool(old and not old[1].get('modelIndexRevision') and db.execute("SELECT 1 FROM account_records WHERE path=? AND json_extract(record,'$.source')='native-request' AND json_extract(record,'$.model') IS NULL LIMIT 1", (str(path),)).fetchone())
            if old and not repair_model and old[1].get('revision') == REVISION and old[0] == sig and not old[1]['pending'] and not old[1]['limited'] and not request.get('forceRescan'):
                unchanged += 1
                continue
            if used >= MAX_SCAN_BYTES or time.monotonic() >= deadline:
                deferred += 1
                continue
            db.execute('SAVEPOINT account_scan')
            try:
                _, amount = scan_file(path, db, min(MAX_FILE_BYTES, MAX_SCAN_BYTES - used), deadline, bool(request.get('forceRescan') or repair_model))
            except Exception:
                db.execute('ROLLBACK TO account_scan')
                db.execute('RELEASE account_scan')
                raise
            db.execute('RELEASE account_scan')
            used += amount
            scanned += 1
        except (OSError, ValueError, sqlite3.Error):
            issues.append('transcript-unreadable')
    if not discovery_complete:
        issues.append('discovery-incomplete')
    if deferred:
        issues.append('scan-deferred')
    file_states = [(json.loads(signature), json.loads(raw)) for signature, raw in db.execute('SELECT signature,state FROM account_files')]
    remaining = sum(max(0, sig[2] - (state.get('cursor') or {}).get('offset', 0)) for sig, state in file_states)
    catchup = sum(state.get('limited', False) for _, state in file_states)
    pending_tails = sum(state.get('pending', False) for _, state in file_states)
    return {'scanCaughtUp': discovery_complete and not deferred and not catchup and not pending_tails,
            'filesCatchupPending': catchup, 'filesWithPendingTail': pending_tails, 'bytesRemaining': remaining,
            'discoveryComplete': discovery_complete, 'filesDiscovered': len(paths), 'filesScanned': scanned,
            'filesUnchanged': unchanged, 'filesDeferred': deferred, 'bytesRead': used, 'issues': sorted(set(issues))}


def canonical(db):
    states = [(p, json.loads(s)) for p, s in db.execute('SELECT path,state FROM account_files ORDER BY path')]
    threads, issues, candidates = {}, [], {}
    for path, state in states:
        meta = state.get('meta')
        if not meta:
            issues.append('session-metadata-missing')
            continue
        sid = meta['id']
        if sid in threads:
            for field in ('parentThreadId', 'forkedFromId', 'accountId', 'billingPoolId', 'project'):
                if threads[sid][field] != meta[field]:
                    issues.append('conflicting-session-metadata')
                    threads[sid][field] = None
                    threads[sid]['metadataConflict'] = True
                    threads[sid]['issues'].append('conflicting-session-metadata')
        else:
            threads[sid] = dict(meta, archived=True, sourceFiles=0, metadataConflict=False, issues=[])
        threads[sid]['sourceFiles'] += 1
        threads[sid]['archived'] &= 'archived_sessions' in Path(path).parts
        threads[sid]['issues'] = sorted(set(threads[sid]['issues'] + state['issues']))
        issues.extend(state['issues'])
        if state['pending']:
            issues.append('records-pending')
        if state['limited']:
            issues.append('scan-incomplete')
    for path, raw in db.execute('SELECT path,record FROM account_records ORDER BY path,id'):
        rec = json.loads(raw)
        candidates.setdefault(rec['id'], []).append(rec)
    records = []
    conflicts = 0
    for copies in candidates.values():
        rec = copies[0]
        rec['sourceCopies'] = len(copies)
        if any(any(c.get(k) != rec.get(k) for k in ('usage', 'model', 'provider', 'accountId', 'billingPoolId', 'ownership', 'timeRangeKnown')) for c in copies[1:]):
            rec['conflict'] = True
            rec['accountId'] = None
            rec['billingPoolId'] = None
            rec['ownership'] = 'unresolved'
            conflicts += 1
        else:
            rec['conflict'] = False
        # A timestamp conflict has its own uncertainty; choosing one would corrupt
        # an official cycle total even if the tokens match perfectly.
        times = {c['timestamp'] for c in copies if c['timestamp'] is not None}
        if len(times) > 1:
            rec['timestamp'], rec['timeRangeKnown'] = None, False
            issues.append('conflicting-request-time')
        if threads.get(rec['threadId'], {}).get('metadataConflict'):
            rec['accountId'], rec['billingPoolId'] = None, None
        records.append(rec)
    native_turns = {(r['threadId'], r['turnId']) for r in records if r['source'] == 'native-request'}
    native_ids = {(r['threadId'], r['responseId']) for r in records if r['source'] == 'native-request'}
    records = [r for r in records if r['source'] != 'native-inherited' or (r['threadId'], r['responseId']) not in native_ids]
    records = [r for r in records if r['source'] == 'native-request' or r['source'] == 'native-inherited' or (r['threadId'], r['turnId']) not in native_turns]
    if any(r['source'] == 'native-inherited' for r in records):
        issues.append('native-origin-transcript-missing')
    if conflicts:
        issues.append('conflicting-request-record')
    # Verify native reconstruction, using all copies together rather than each
    # partial archive separately. Never fabricate a request for an uncovered gap.
    sums = {}
    for r in records:
        if r['source'] == 'native-request' and r['ownership'] == 'owned':
            k = (r['threadId'], r['turnId'])
            sums[k] = m.add(sums.get(k, m.zero()), r['usage'])
    for _, state in states:
        meta = state.get('meta')
        if not meta:
            continue
        for tid, total in state['nativeTotals'].items():
            if any(sums.get((meta['id'], tid), m.zero())[k] < total[k] for k in m.FIELDS):
                issues.append('native-total-gap')
    for sid, thread in threads.items():
        seen, root = {sid}, sid
        while threads.get(root, {}).get('parentThreadId'):
            parent = threads[root]['parentThreadId']
            if parent in seen:
                root = None
                issues.append('lineage-cycle')
                break
            if parent not in threads:
                root = parent
                issues.append('parent-transcript-missing')
                break
            seen.add(parent)
            root = parent
        thread['conversationId'] = root
    for r in records:
        t = threads.get(r['threadId'], {})
        r['accountEvidence'] = r.get('accountEvidence') or t.get('accountEvidence', 'account-telemetry' if r.get('accountId') else 'not-recorded')
        r['conversationId'] = t.get('conversationId')
        r['parentThreadId'] = t.get('parentThreadId')
        r['isSubagent'] = bool(t.get('parentThreadId'))
        r['project'] = t.get('project')
        r['archived'] = t.get('archived', False)
    return records, threads, sorted(set(issues))


def indexed_threads(home):
    """Discover missing/non-local chats from the host index without message text.

    Read only explicitly named threads and telemetry columns. Derived title
    text and credentials are not queried or cached. Index labels stay in RAM.
    """
    result, issues = {}, []
    paths = sorted(home.glob('state_*.sqlite'), key=lambda p: int(p.stem.split('_')[-1]) if p.stem.split('_')[-1].isdigit() else -1, reverse=True)
    for path in paths:
        if path.is_symlink():
            continue
        try:
            with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=.5)) as db:
                columns = {r[1] for r in db.execute('PRAGMA table_info(threads)')}
                if 'id' not in columns:
                    continue
                fields = [k for k in ('id', 'name', 'rollout_path', 'cwd', 'archived', 'source') if k in columns]
                for values in db.execute('SELECT ' + ','.join(fields) + ' FROM threads LIMIT 20001'):
                    r = dict(zip(fields, values))
                    sid = m.label(r['id'])
                    if not sid or sid in result:
                        continue
                    if len(result) >= MAX_FILES:
                        issues.append('index-discovery-incomplete')
                        break
                    result[sid] = r
        except sqlite3.Error:
            issues.append('thread-index-unavailable')
    return result, issues


def merge_index(home, threads):
    indexed, issues = indexed_threads(home)
    missing, nonlocal_count = 0, 0
    for sid, row in indexed.items():
        name = row.get('name')
        name = name[:100] if isinstance(name, str) and name else sid
        if sid in threads:
            threads[sid]['title'] = name
            continue
        raw_path = row.get('rollout_path')
        path = Path(raw_path).expanduser().resolve() if isinstance(raw_path, str) and raw_path else None
        local_path = path is not None and any(path.is_relative_to(home / folder) for folder in ('sessions', 'archived_sessions'))
        status = 'missing-local' if local_path else 'non-local-or-missing'
        missing += bool(local_path)
        nonlocal_count += not local_path
        threads[sid] = {'id': sid, 'title': name, 'conversationId': sid, 'parentThreadId': None, 'forkedFromId': None,
                        'historyBaseId': None, 'boundary': None, 'accountId': None, 'billingPoolId': None, 'billingMode': None,
                        'project': row.get('cwd'), 'createdAt': None, 'archived': bool(row.get('archived')),
                        'sourceFiles': 0, 'metadataConflict': False, 'issues': [status], 'usageStatus': status}
    return {'indexedThreadCount': len(indexed), 'missingLocalThreads': missing, 'nonLocalOrMissingThreads': nonlocal_count}, issues


def price_record(rec, prices):
    seg = {'usage': rec['usage'], 'model': rec['model'], 'provider': rec['provider'],
           'request_known': rec['requestKnown'], 'cache_write_known': rec['cacheWriteKnown']}
    parts, reason = prices.cost_parts(seg)
    if rec['conflict']:
        parts, reason = None, 'Conflicting request telemetry'
    if rec['ownership'] != 'owned':
        parts, reason = None, 'Request ownership is unresolved'
    rec['costComplete'] = parts is not None
    rec['amount'] = m.money(sum(parts.values(), Decimal(0))) if parts is not None else None
    rec['knownUsd'] = rec['amount'] if rec['amount'] is not None else '0'
    rec['costReason'] = reason
    rec['costParts'] = {k: m.money(v) for k, v in parts.items()} if parts is not None else None
    u = rec['usage']
    rec['tokens'] = {'input': u['input_tokens'] - u['cached_input_tokens'] - u['cache_write_input_tokens'] if rec['cacheWriteKnown'] else None,
                     'cacheRead': u['cached_input_tokens'], 'cacheWrite': u['cache_write_input_tokens'] if rec['cacheWriteKnown'] else None,
                     'output': u['output_tokens'], 'reasoning': u['reasoning_output_tokens'] if rec['reasoningKnown'] else None,
                     'totalTokens': u['total_tokens']}
    return rec


def summary(rows):
    tokens = {'input': 0, 'cacheRead': 0, 'cacheWrite': 0, 'output': 0, 'reasoning': 0, 'totalTokens': 0}
    known_tokens = dict(tokens)
    amounts = m.zero_costs()
    known, unpriced = Decimal(0), 0
    for r in rows:
        for key, val in r['tokens'].items():
            if val is None:
                tokens[key] = None
            else:
                known_tokens[key] += val
                if tokens[key] is not None:
                    tokens[key] += val
        if not r['costComplete']:
            unpriced += 1
        known += Decimal(r['knownUsd'])
        for key, val in (r['costParts'] or {}).items():
            amounts[key] += Decimal(val)
    complete = bool(rows) and not unpriced
    priced_count = len(rows) - unpriced
    amount_status = 'complete' if complete else 'known-subtotal' if priced_count else 'unpriced' if rows else 'unavailable'
    return {**tokens, 'knownTokens': known_tokens, 'requestCount': len(rows),
            'amount': m.money(known) if complete else None, 'knownUsd': m.money(known),
            'costComplete': complete, 'unpricedRequests': unpriced, 'pricedRequests': priced_count,
            'observedUsd': m.money(known) if priced_count else None, 'amountStatus': amount_status,
            'unpricedTokens': sum(r['tokens']['totalTokens'] for r in rows if not r['costComplete']),
            'costParts': {k: m.money(v) for k, v in amounts.items()}}


def groups(rows, field):
    grouped = {}
    for r in rows:
        grouped.setdefault(r.get(field), []).append(r)
    return [{'id': key, **summary(items)} for key, items in sorted(grouped.items(), key=lambda p: str(p[0]))]


def validate_request(request):
    if not isinstance(request, dict):
        raise ValueError('Request must be an object')
    for flag in ('archived', 'subagent', 'unpricedOnly', 'forceRescan', 'includeUnresolved'):
        if request.get(flag) is not None and type(request[flag]) is not bool:
            raise ValueError(flag + ' must be boolean')
    for field in ('project', 'search'):
        if request.get(field) is not None and (not isinstance(request[field], str) or len(request[field]) > 4096):
            raise ValueError('Invalid ' + field)
    if request.get('identityPolicy', 'strict') not in ('strict', 'include-unattributed'):
        raise ValueError('Unsupported identityPolicy')
    start, end = stamp(request.get('startAt')), stamp(request.get('endAt'))
    if start is not None and end is not None and start >= end:
        raise ValueError('startAt must precede endAt')
    for name in ('accountId', 'threadId', 'conversationId', 'model', 'billingPoolId', 'provider', 'turnId', 'responseId'):
        if request.get(name) is not None:
            m.valid_id(request[name])
    zone = ZoneInfo(request.get('timezone', 'UTC'))
    sort = request.get('sort', 'lastActivity')
    if sort not in ('lastActivity', 'amount', 'tokens', 'createdAt', 'threadId'):
        raise ValueError('Unsupported sort')
    direction = request.get('direction', 'desc')
    if direction not in ('asc', 'desc'):
        raise ValueError('Unsupported direction')
    for name, default, maximum in (('limit', 100, 1000), ('offset', 0, 10**9), ('recordLimit', 100, 10000), ('recordOffset', 0, 10**9)):
        val = request.get(name, default)
        if type(val) is not int or val < 0 or val > maximum:
            raise ValueError('Invalid ' + name)
    if request.get('exportFormat') not in (None, 'json', 'csv'):
        raise ValueError('Unsupported export format')
    return start, end, zone


def snapshot(request=None, home=None, data_dir=None):
    request = {} if request is None else request
    start, end, zone = validate_request(request)
    home = Path(home or os.environ.get('CODEX_HOME', Path.home() / '.codex')).expanduser().resolve()
    data_dir = Path(data_dir or os.environ.get('TOKENLENS_DATA', home / 'plugins/data/tokenlens-local/tokenlens-prototype')).expanduser().resolve()
    data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    prices = m.Prices(request.get('pricesFile'), tier=request.get('tier', 'standard'))
    with closing(sqlite3.connect(data_dir / 'account-ledger.sqlite3', timeout=2)) as db, db:
        schema(db)
        db.execute('BEGIN IMMEDIATE')
        scan = refresh(home, db, request)
        records, threads, issues = canonical(db)
    index_stats, index_issues = merge_index(home, threads)
    issues.extend(index_issues)
    records = [price_record(r, prices) for r in records]
    bounded = start is not None or end is not None
    uncertain_time = [r for r in records if r['ownership'] == 'owned' and (r['timestamp'] is None or not r['timeRangeKnown'])]
    in_time = lambda r: not bounded or (r['timeRangeKnown'] and r['timestamp'] is not None and (start is None or r['timestamp'] >= start) and (end is None or r['timestamp'] < end))
    timed = [r for r in records if in_time(r)]
    unresolved = [r for r in records if r['ownership'] != 'owned' and (in_time(r) or r['timestamp'] is None or not r['timeRangeKnown'])]
    owned = [r for r in timed if r['ownership'] == 'owned']
    unknown_accounts = [r for r in owned if r['accountId'] is None]
    unknown_pools = [r for r in owned if r['billingPoolId'] is None]
    include_unknown_identity = request.get('identityPolicy') == 'include-unattributed'
    def matching(r):
        for key in ('accountId', 'billingPoolId', 'threadId', 'conversationId', 'model', 'provider', 'turnId', 'responseId'):
            if request.get(key) is None or r.get(key) == request[key]:
                continue
            if include_unknown_identity and key in ('accountId', 'billingPoolId') and r.get(key) is None:
                continue
            return False
        return True
    selected = [r for r in owned if matching(r)]
    if request.get('project') is not None:
        selected = [r for r in selected if r['project'] == request['project']]
    if request.get('archived') is not None:
        selected = [r for r in selected if r['archived'] is bool(request['archived'])]
    if request.get('subagent') is not None:
        selected = [r for r in selected if r['isSubagent'] is bool(request['subagent'])]
    if request.get('unpricedOnly'):
        selected = [r for r in selected if not r['costComplete']]
    search = str(request.get('search', '')).casefold()
    if search:
        selected = [r for r in selected if search in (' '.join(str(r.get(k) or '') for k in ('threadId', 'conversationId', 'model', 'project', 'accountId')) + ' ' + threads.get(r['threadId'], {}).get('title', '')).casefold()]
    if request.get('unknownAccountOnly'):
        selected = [r for r in selected if r['accountId'] is None]
    all_rows = summary(selected)
    by_thread = {}
    for r in selected:
        by_thread.setdefault(r['threadId'], []).append(r)
    # Keep discovered empty/unresolved threads visible when no request filters
    # would imply a match; empty totals carry null amount, never a fabricated 0.
    rows = []
    for sid, meta in threads.items():
        entries = by_thread.get(sid, [])
        if not entries:
            if request.get('unknownAccountOnly') and meta['accountId'] is not None:
                continue
            if bounded or any(request.get(k) is not None for k in ('model', 'provider', 'billingPoolId', 'project', 'turnId', 'responseId')) or request.get('unpricedOnly'):
                continue
            if request.get('threadId') is not None and sid != request['threadId']:
                continue
            if request.get('conversationId') is not None and meta['conversationId'] != request['conversationId']:
                continue
            if request.get('accountId') is not None and meta['accountId'] != request['accountId']:
                continue
            if request.get('archived') is not None and meta['archived'] is not bool(request['archived']):
                continue
            if request.get('subagent') is not None and bool(meta['parentThreadId']) is not bool(request['subagent']):
                continue
            if search and search not in ' '.join(str(meta.get(k) or '') for k in ('id', 'project', 'accountId', 'title')).casefold():
                continue
        stamps = [r['timestamp'] for r in entries if r['timestamp'] is not None]
        rows.append({'threadId': sid, 'title': meta.get('title') or sid, 'conversationId': meta['conversationId'], 'parentThreadId': meta['parentThreadId'],
                     'forkedFromId': meta['forkedFromId'], 'accountId': meta['accountId'], 'accountStatus': 'recorded' if meta['accountId'] else 'unknown',
                     'project': meta['project'], 'archived': meta['archived'], 'sourceFiles': meta['sourceFiles'], 'accountEvidence': meta.get('accountEvidence', 'account-telemetry' if meta['accountId'] else 'not-recorded'),
                     'createdAt': meta['createdAt'], 'lastActivity': max(stamps) if stamps else None,
                     'models': sorted({r['model'] for r in entries if r['model']}), 'issues': meta['issues'],
                     'usageStatus': 'observed' if entries else meta.get('usageStatus', 'unavailable'), 'total': summary(entries)})
    sort = request.get('sort', 'lastActivity')
    def sort_key(r):
        value = r['total']['knownUsd'] if sort == 'amount' else r['total']['totalTokens'] if sort == 'tokens' else r.get(sort)
        if sort == 'amount':
            value = Decimal(value)
        return (value is not None, value or ('' if sort == 'threadId' else 0), r['threadId'])
    rows.sort(key=sort_key, reverse=request.get('direction', 'desc') == 'desc')
    day_rows = []
    for r in selected:
        copy = dict(r)
        copy['day'] = datetime.fromtimestamp(r['timestamp'] / 1000, zone).date().isoformat() if r['timestamp'] is not None and r['timeRangeKnown'] else None
        day_rows.append(copy)
    for r in selected:
        r['agentSource'] = 'subagent' if r['isSubagent'] else 'main'
    issues = sorted(set(issues + scan.pop('issues')))
    if unknown_accounts:
        issues.append('account-attribution-unknown')
    if bounded and uncertain_time:
        issues.append('time-attribution-incomplete')
    scan_complete = scan['discoveryComplete'] and not any(x in issues for x in ('transcript-unreadable', 'scan-deferred', 'records-pending', 'scan-incomplete', 'session-metadata-missing', 'invalid-telemetry-record', 'oversized-telemetry-record', 'index-discovery-incomplete', 'thread-index-unavailable', 'file-replaced-during-scan', 'file-disappeared-during-scan'))
    usage_complete = scan_complete and not index_stats['missingLocalThreads'] and not any(x in issues for x in ('native-total-gap', 'cumulative-counter-reset', 'legacy-lineage-unresolved', 'conflicting-request-record', 'conflicting-session-metadata', 'request-boundaries-missing', 'history-ordinal-missing', 'invalid-history-boundary', 'native-origin-transcript-missing'))
    coverage = {**scan, **index_stats, 'scope': 'discoverable-local-telemetry', 'accountLedgerComplete': False,
                'localScanComplete': scan_complete, 'usageComplete': usage_complete,
                'timeFilterExact': not bounded or not uncertain_time, 'accountAttributionComplete': not unknown_accounts,
                'costComplete': all_rows['costComplete'], 'unknownAccountRequests': len(unknown_accounts),
                'unknownPoolRequests': len(unknown_pools), 'timeUnattributedRequests': len(uncertain_time),
                'recordedAccountCount': len({r['accountId'] for r in selected if r['accountId']}),
                'creatorAttributedRequests': sum(r.get('accountEvidence') == 'creator-account-telemetry' for r in selected),
                'recordedPoolCount': len({r['billingPoolId'] for r in selected if r['billingPoolId']}),
                'recordedBillingModeCount': len({r['billingMode'] for r in selected if r['billingMode']}),
                'mixedRecordedAccounts': len({r['accountId'] for r in selected if r['accountId']}) > 1,
                'mixedRecordedPools': len({r['billingPoolId'] for r in selected if r['billingPoolId']}) > 1,
                'assumedIdentityRequests': sum((r['accountId'] is None and request.get('accountId') is not None or r['billingPoolId'] is None and request.get('billingPoolId') is not None) for r in selected),
                'conflictingRequests': sum(r['conflict'] for r in records),
                'ownershipUnresolvedRequests': len(unresolved), 'otherDevicesPossible': True, 'sourceComplete': False,
                'issues': sorted(set(issues)), 'limitations': ['Other devices, remote-only and deleted transcripts are not observable.',
                'Account and billing pool require explicit per-session/request telemetry; current login is not historical evidence.',
                'Legacy cumulative gaps are excluded from bounded queries because their request time is not known.',
                'Prices are the selected API-equivalent table, not historical invoices or an official dollar balance.']}
    coverage['status'] = 'local-complete' if scan_complete and usage_complete and coverage['timeFilterExact'] and coverage['accountAttributionComplete'] and all_rows['costComplete'] else 'partial' if records else 'unavailable'
    out = {'schemaVersion': 1, 'source': 'local-request-ledger', 'observedAt': int(time.time() * 1000),
           'accountId': request.get('accountId'), 'accountStatus': 'recorded-plus-unattributed' if include_unknown_identity and request.get('accountId') else 'recorded-filter' if request.get('accountId') else 'mixed-or-unknown',
           'period': {'startAt': start, 'endAt': end, 'bounds': '[startAt,endAt)', 'timezone': str(zone)},
           'pricing': {'kind': 'API equivalent', 'currency': 'USD', 'tier': prices.tier, 'verifiedAt': prices.data['verified_at']},
           'total': all_rows, 'coverage': coverage,
           'scope': {'kind':'observed-local', 'identityPolicy':request.get('identityPolicy', 'strict'), 'completeAccountLedger':False,
                     'label':'本地已观测 API 等价费用', 'amountStatus':all_rows['amountStatus']},
           'unattributed': {'account': summary(unknown_accounts), 'time': summary(uncertain_time),
                            'ownership': summary(unresolved)},
           'byModel': groups(selected, 'model'), 'byProject': groups(selected, 'project'),
           'byDay': groups(day_rows, 'day'), 'byAgent': groups(selected, 'agentSource'),
           'byAccount': groups(selected, 'accountId'), 'byBillingPool': groups(selected, 'billingPoolId'), 'byBillingMode': groups(selected, 'billingMode'),
           'byConversation': groups(selected, 'conversationId'),
           'threads': rows[request.get('offset', 0):request.get('offset', 0) + request.get('limit', 100)],
           'threadCount': len(rows), 'recordCount': len(selected),
           'records': sorted(selected, key=lambda r: (r['timestamp'] is not None, r['timestamp'] or 0, r['id']), reverse=True)[request.get('recordOffset', 0):request.get('recordOffset', 0) + request.get('recordLimit', 100)],
           'nextRecordOffset': request.get('recordOffset', 0) + request.get('recordLimit', 100) if request.get('recordOffset', 0) + request.get('recordLimit', 100) < len(selected) else None}
    if request.get('includeUnresolved'):
        out['unresolvedRecords'] = unresolved[:request.get('recordLimit', 100)]
    if request.get('exportFormat'):
        # Export the entire matching set, not only the UI page. No chat content.
        if request['exportFormat'] == 'json':
            out['export'] = {'format': 'json', 'mediaType': 'application/json', 'data': {'schemaVersion': 1, 'period': out['period'], 'coverage': coverage, 'pricing': out['pricing'], 'records': selected,
                'unresolvedRecords': unresolved if request.get('includeUnresolved') else [],
                'timeUnattributedRecords': uncertain_time if request.get('includeUnresolved') else []}}
        else:
            stream = io.StringIO(newline='')
            fields = ('id', 'threadId', 'conversationId', 'turnId', 'timestamp', 'accountId', 'billingPoolId', 'model', 'project', 'isSubagent', 'ownership', 'amount', 'costReason', 'input', 'cacheRead', 'cacheWrite', 'output', 'reasoning', 'totalTokens')
            writer = csv.DictWriter(stream, fieldnames=fields)
            writer.writeheader()
            for r in selected:
                flat = {k: r.get(k) for k in fields}
                flat.update(r['tokens'])
                # Neutralize spreadsheet formulas in user-controlled labels.
                flat = {k: "'" + v if isinstance(v, str) and v.startswith(('=', '+', '-', '@', '\t', '\r')) else v for k, v in flat.items()}
                writer.writerow(flat)
            out['export'] = {'format': 'csv', 'mediaType': 'text/csv', 'data': stream.getvalue(), 'coverage': coverage}
    return out


if __name__ == '__main__':
    os.umask(0o077)
    try:
        request = json.loads(sys.stdin.read() or '{}')
        print(json.dumps(snapshot(request), ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({'error': str(exc) if isinstance(exc, (ValueError, m.MeterError)) else type(exc).__name__}, ensure_ascii=False))
        sys.exit(1)
