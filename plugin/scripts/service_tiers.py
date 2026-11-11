"""Speed evidence retained from Codex turn diagnostics, without storing log bodies."""
import hashlib
import json
import re
import sqlite3
from bisect import bisect_left
from collections import defaultdict
from contextlib import closing


ALIASES = {'default': 'standard', 'standard': 'standard', 'priority': 'fast',
           'fast': 'fast', 'ultrafast': 'ultrafast', 'flex': 'flex', 'batch': 'batch'}
TURN = re.compile(r'\bturn_id="?([A-Za-z0-9_.:-]{1,200})(?=["\s}])')
MODEL = re.compile(r'\bmodel="?([A-Za-z0-9_.:-]{1,200})(?=["\s}])')
NEARBY_MS = 2 * 60 * 60 * 1000


def normalize(value):
    return ALIASES.get(value) if isinstance(value, str) else None


def request_tier(payload):
    for key in ('actual_service_tier', 'response_service_tier', 'service_tier'):
        tier = normalize(payload.get(key))
        if tier:
            return tier
    return None


def merge(evidence):
    values = {v for v in evidence if v is not None}
    if not values:
        return None
    return values.pop() if len(values) == 1 else 'conflict'


def feedback(thread, body):
    if not thread or not isinstance(body, str) or len(body) > 262144:
        return None
    span, sep, raw = body.partition('tags_json=')
    if not sep:
        return None
    turns, models = set(TURN.findall(span)), set(MODEL.findall(span))
    if len(turns) != 1 or len(models) != 1:
        return None
    try:
        tags, _ = json.JSONDecoder().raw_decode(raw.lstrip())
        tags = json.loads(tags) if isinstance(tags, str) else tags
    except (ValueError, RecursionError):
        return None
    model = next(iter(models))
    if not isinstance(tags, dict) or tags.get('model', model) != model:
        return None
    tier = normalize(tags.get('service_tier'))
    return (thread, next(iter(turns)), model, tier) if tier else None


def diagnostics(home, data):
    namespace = hashlib.sha256(str(home.resolve()).encode()).hexdigest()
    try:
        with closing(sqlite3.connect(data / 'service-tiers.sqlite3', timeout=2)) as cache, cache:
            cache.execute('CREATE TABLE IF NOT EXISTS tiers(profile, thread, turn, model, tier, PRIMARY KEY(profile,thread,turn,model,tier))')
            cache.execute('CREATE TABLE IF NOT EXISTS cursors(profile, source, rowid, PRIMARY KEY(profile,source))')
            for path in sorted(home.glob('logs_*.sqlite')):
                try:
                    st = path.stat()
                    source = f'{path.name}:{st.st_dev}:{st.st_ino}'
                    saved = cache.execute('SELECT rowid FROM cursors WHERE profile=? AND source=?', (namespace, source)).fetchone()
                    with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=.3)) as log:
                        high = log.execute('SELECT max(id) FROM logs').fetchone()[0] or 0
                        last = saved[0] if saved and saved[0] <= high else 0
                        rows = log.execute("SELECT thread_id, feedback_log_body FROM logs WHERE id>? AND id<=? AND target='feedback_tags' AND instr(feedback_log_body,'service_tier')>0", (last, high))
                        found = {entry for thread, body in rows if (entry := feedback(thread, body))}
                    cache.executemany('INSERT OR IGNORE INTO tiers VALUES (?,?,?,?,?)', ((namespace, *row) for row in found))
                    cache.execute('INSERT OR REPLACE INTO cursors VALUES (?,?,?)', (namespace, source, high))
                except (OSError, sqlite3.Error):
                    continue
            return {(thread, turn, model): tier if count == 1 else 'conflict'
                    for thread, turn, model, tier, count in cache.execute(
                        'SELECT thread,turn,model,min(tier),count(*) FROM tiers WHERE profile=? GROUP BY thread,turn,model', (namespace,))}
    except sqlite3.Error:
        return {}


def apply(records, home, data):
    settings = diagnostics(home, data)
    anchors = defaultdict(list)
    def key(rec):
        return rec['threadId'], rec['model'], rec.get('accountId')

    for rec in records:
        tier = rec.get('recordedServiceTier')
        source = 'request-telemetry' if tier else None
        if not tier:
            tier = settings.get((rec['threadId'], rec['turnId'], rec['model']))
            source = 'turn-diagnostics' if tier else None
        rec['serviceTier'] = normalize(tier)
        rec['serviceTierSource'] = 'conflict' if tier == 'conflict' else source
        at = rec.get('timestamp')
        if rec['serviceTier'] and at is not None and rec['ownership'] == 'owned' and not rec.get('conflict'):
            anchors[key(rec)].append((at, rec['serviceTier']))
    for sequence in anchors.values():
        sequence.sort()
    for rec in records:
        if rec['serviceTier']:
            continue
        at = rec.get('timestamp')
        sequence = anchors.get(key(rec), ())
        if at is not None and sequence:
            i = bisect_left(sequence, (at, ''))
            candidates = sequence[max(0, i - 1):i + 1]
            near_at, near_tier = min(candidates, key=lambda item: abs(at - item[0]))
            if abs(at - near_at) <= NEARBY_MS:
                rec['serviceTier'] = near_tier
                rec['serviceTierSource'] = 'nearby-turn-estimate'
                continue
        rec['serviceTier'] = 'standard'
        rec['serviceTierSource'] = 'standard-estimate'
