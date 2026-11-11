"""Read Claude Code JSONL locally and emit usage aggregates without message text."""
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path
import json
import os
import re
import sys

# USD per million tokens, using Anthropic's first-party API rate card.
# The columns are uncached input, output, cache read, and Fast multiplier.
# https://platform.claude.com/docs/en/about-claude/pricing
RATES = {
    'claude-fable-5-2': (8, 40, .20, 2),
    'claude-fable-5-1': (10, 50, .25, None),
    'claude-fable-5': (10, 50, 1, None),
    'claude-mythos-5-2': (8, 40, .20, 2),
    'claude-mythos-5-1': (10, 50, .25, None),
    'claude-mythos-5': (10, 50, 1, None),
    'claude-opus-5-5': (4, 20, .20, 2),
    'claude-opus-5': (5, 25, .50, 2),
    'claude-opus-4-8': (5, 25, .50, 2),
    'claude-opus-4-7': (5, 25, .50, None),
    'claude-opus-4-6': (5, 25, .50, 6),
    'claude-opus-4-5': (5, 25, .50, None),
    'claude-opus-4-1': (15, 75, 1.50, None),
    'claude-opus-4': (15, 75, 1.50, None),
    'claude-sonnet-5-5': (2, 10, .10, None),
    'claude-sonnet-5': (2, 10, .20, None),
    'claude-sonnet-4-6': (3, 15, .30, None),
    'claude-sonnet-4-5': (3, 15, .30, None),
    'claude-sonnet-4': (3, 15, .30, None),
    'claude-haiku-5-5': (.10, .50, .01, None),
    'claude-haiku-4-5': (1, 5, .10, None),
}
UUID = re.compile(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}')
AGENT = re.compile(r'[A-Za-z0-9_-]{1,80}')


def integer(value):
    return value if type(value) is int and value >= 0 else 0


def records(path):
    try:
        with path.open('rb') as source:
            for line in source:
                try:
                    value = json.loads(line)
                except (ValueError, UnicodeError):
                    continue
                if isinstance(value, dict):
                    yield value
    except FileNotFoundError:
        return


def object_value(value):
    return value if isinstance(value, dict) else {}


def is_prompt(row, message):
    if (row.get('type') != 'user' or row.get('isMeta') or row.get('isSidechain')
            or row.get('isCompactSummary') or row.get('isVisibleInTranscriptOnly')
            or row.get('sourceToolAssistantUUID') or 'toolUseResult' in row):
        return False
    content = message.get('content')
    if isinstance(content, str):
        return bool(content.strip()) and not content.lstrip().startswith(
            ('<local-command-', '<command-name>', '<task-notification>'))
    return isinstance(content, list) and any(
        object_value(block).get('type') in ('text', 'image', 'document') for block in content
    ) and not any(object_value(block).get('type') == 'tool_result' for block in content)


def timestamp(value):
    if not isinstance(value, str):
        return 0
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return parsed.timestamp() if parsed.tzinfo else 0
    except (ValueError, OverflowError):
        return 0


def response(row, turn):
    message = object_value(row.get('message'))
    model = message.get('model')
    usage = message.get('usage')
    response_id = message.get('id') or row.get('requestId')
    if (row.get('type') != 'assistant' or not isinstance(response_id, str)
            or not isinstance(model, str) or not model.startswith('claude-')
            or not isinstance(usage, dict) or not any(
                key in usage for key in ('input_tokens', 'output_tokens',
                                         'cache_creation_input_tokens', 'cache_read_input_tokens'))):
        return None
    return response_id, (turn, model, usage, timestamp(row.get('timestamp')))


def merge_response(target, item):
    if item is None:
        return
    key, (turn, model, usage, at) = item
    previous = target.get(key)
    if previous is not None:
        previous_turn, previous_model, previous_usage, previous_at = previous
        if previous_model != model:
            return
        turn = previous_turn or turn
        at = min(at, previous_at) if at and previous_at else at or previous_at
        # Claude duplicates one response across content blocks, and resume can
        # copy it into another transcript. Preserve fields the later copy omits.
        usage = {**previous_usage, **{k: v for k, v in usage.items() if v is not None}}
    target[key] = turn, model, usage, at


def price(model, usage):
    canonical = re.sub(r'-\d{8}$', '', model)
    rates = RATES.get(canonical)
    speed = usage.get('speed')
    if speed is None and rates and rates[3] is None:
        speed = 'standard'

    tokens = [
        integer(usage.get('input_tokens')),
        integer(usage.get('cache_read_input_tokens')),
        integer(usage.get('cache_creation_input_tokens')),
        integer(usage.get('output_tokens')),
    ]
    if rates is None or speed not in ('standard', 'fast'):
        return speed or 'unknown', tokens, [None if count else 0 for count in tokens]
    incoming, outgoing, cache_read, fast = rates
    if speed == 'fast' and fast is None:
        return speed, tokens, [None if count else 0 for count in tokens]
    fresh, hit, written, output = tokens
    if canonical == 'claude-haiku-5-5' and fresh + hit + written > 100_000:
        incoming, outgoing, cache_read = .50, 2.50, .05
    # The first-party geographic premium stacks with Fast and cache pricing.
    factor = (1.1 if usage.get('inference_geo') == 'us' else 1) * (fast if speed == 'fast' else 1)
    cache = object_value(usage.get('cache_creation'))
    short = integer(cache.get('ephemeral_5m_input_tokens'))
    hour = integer(cache.get('ephemeral_1h_input_tokens'))
    # Without the split, both TTLs are possible. Keep the reported token count
    # and price the known portion only.
    cache_write = incoming * (1.25 * short + 2 * hour) if short + hour == written else None
    amounts = [fresh * incoming, hit * cache_read, cache_write, output * outgoing]
    return speed, tokens, [round(value * factor * 1000) if value is not None else None for value in amounts]


def total():
    # All money is stored in integer nanodollars to keep aggregation exact.
    return {'requests': 0, 'unpriced': 0, 'tokens': [0] * 4,
            'cost': [0] * 4, 'missing': [0] * 4}


def add(target, tokens, costs):
    target['requests'] += 1
    target['unpriced'] += int(None in costs)
    for index, (count, cost) in enumerate(zip(tokens, costs)):
        target['tokens'][index] += count
        target['cost'][index] += cost or 0
        if cost is None:
            target['missing'][index] += count


def priced_summary(responses, turns):
    combined = total()
    by_model = defaultdict(total)
    by_turn_model = defaultdict(lambda: defaultdict(total))
    by_turn = {turn: total() for turn in turns}
    for turn, model, usage, _ in responses.values():
        speed, tokens, costs = price(model, usage)
        add(combined, tokens, costs)
        add(by_model[(model, speed)], tokens, costs)
        if turn in by_turn:
            add(by_turn[turn], tokens, costs)
            add(by_turn_model[turn][(model, speed)], tokens, costs)
    def ranked(group):
        return [{'model': model, 'speed': speed, **item}
                for (model, speed), item in sorted(group.items(),
                    key=lambda entry: (-sum(entry[1]['cost']), entry[0]))]
    return {
        'total': combined,
        'models': ranked(by_model),
        'unassigned': combined['requests'] - sum(item['requests'] for item in by_turn.values()),
        'turns': [
            {'id': turn, 'number': index, 'models': ranked(by_turn_model[turn]), **by_turn[turn]}
            for index, turn in enumerate(turns, 1)
        ],
    }


def tool_links(row, turn, agent_turns, tool_turns):
    message = object_value(row.get('message'))
    blocks = message.get('content')
    if not isinstance(blocks, list):
        blocks = []
    for value in blocks:
        block = object_value(value)
        if block.get('type') in ('tool_use', 'tool_result'):
            key = block.get('id') if block.get('type') == 'tool_use' else block.get('tool_use_id')
            if isinstance(key, str):
                turn = tool_turns.setdefault(key, turn) if turn else tool_turns.get(key)
    details = object_value(row.get('toolUseResult'))
    progress = object_value(row.get('data'))
    agent = details.get('agentId') or progress.get('agentId')
    parent = row.get('parentToolUseID') or progress.get('parentToolUseID')
    if isinstance(agent, str):
        assigned = tool_turns.get(parent) if isinstance(parent, str) else None
        if assigned or turn:
            agent_turns.setdefault(agent, assigned or turn)


def read_session(path, responses, metadata=None):
    turns = {}
    active = None
    agent_turns = {}
    tool_turns = {}
    rows_to_turns = {}
    for row in records(path):
        if metadata is not None:
            title = row.get('customTitle') or row.get('aiTitle')
            if isinstance(title, str) and title.strip():
                metadata['title'] = title.strip()[:120]
            cwd = row.get('relocatedCwd') or row.get('cwd')
            if isinstance(cwd, str) and cwd.startswith('/'):
                metadata['project'] = Path(cwd).name
        message = object_value(row.get('message'))
        if is_prompt(row, message):
            prompt = row.get('promptId') or row.get('uuid')
            if isinstance(prompt, str):
                turns.setdefault(prompt, None)
                active = prompt
        uid = row.get('uuid')
        if isinstance(uid, str) and active:
            rows_to_turns[uid] = active
        source = row.get('sourceToolAssistantUUID')
        linked = rows_to_turns.get(source, active) if isinstance(source, str) else active
        if not row.get('isSidechain'):
            tool_links(row, linked, agent_turns, tool_turns)
            merge_response(responses, response(row, active))
        else:
            agent = row.get('agentId')
            merge_response(responses, response(row, agent_turns.get(agent) if isinstance(agent, str) else None))

    sidecars = path.parent / path.stem / 'subagents'
    if not sidecars.is_symlink():
        for agent_path in sidecars.glob('agent-*.jsonl'):
            agent = agent_path.stem[6:]
            if agent_path.is_symlink() or not AGENT.fullmatch(agent):
                continue
            for row in records(agent_path):
                parent = row.get('parentToolUseID')
                turn = agent_turns.get(agent)
                if not turn and isinstance(parent, str):
                    turn = tool_turns.get(parent)
                merge_response(responses, response(row, turn))
    return turns


def local_transcripts(root):
    for folder in root.glob('*'):
        if folder.is_dir() and not folder.is_symlink():
            yield from (path for path in folder.glob('*.jsonl')
                        if UUID.fullmatch(path.stem) and not path.is_symlink())


def current_transcript(root, session_id, hint):
    if not UUID.fullmatch(session_id):
        return None
    if hint:
        path = Path(hint).resolve()
        if path.name == session_id + '.jsonl' and path.parent.parent == root and path.is_file():
            return path
    return next((path for path in local_transcripts(root) if path.stem == session_id), None)


def period_totals(responses, ranges, include_days=False):
    buckets = {key: total() for key in ranges}
    days = defaultdict(total)
    for _, model, usage, at in responses.values():
        if not at:
            continue
        _, tokens, amounts = price(model, usage)
        for key, (start, end) in ranges.items():
            if start <= at < end:
                add(buckets[key], tokens, amounts)
        if include_days and ranges['month'][0] <= at < ranges['month'][1]:
            add(days[datetime.fromtimestamp(at).date().isoformat()], tokens, amounts)
    return buckets, [{'day': day, **item} for day, item in sorted(days.items())]


def account_report(root, week_start, week_end):
    now = datetime.now()
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    tomorrow = today + timedelta(days=1)
    ranges = {
        'today': (today.timestamp(), tomorrow.timestamp()),
        'week': (week_start, week_end),
        'month': ((today - timedelta(days=29)).timestamp(), tomorrow.timestamp()),
    }
    responses = {}
    conversations = []
    project_ids = defaultdict(set)
    for path in local_transcripts(root):
        metadata = {'title': '', 'project': ''}
        session = {}
        turns = read_session(path, session, metadata)
        if not session:
            continue
        if not metadata['title']:
            metadata['title'] = '对话 ' + path.stem[:8]
        if not metadata['project']:
            metadata['project'] = '未知项目'
        for item in session.items():
            merge_response(responses, item)
        project_ids[metadata['project']].update(session)
        activity = max((entry[3] for entry in session.values()), default=0)
        windows, _ = period_totals(session, ranges)
        summary = priced_summary(session, {})
        by_model = defaultdict(dict)
        for key, entry in session.items():
            by_model[entry[1]][key] = entry
        model_windows = {
            model: period_totals(entries, ranges)[0] for model, entries in by_model.items()
        }
        conversations.append({
            'id': path.stem, **metadata, 'updated': activity, 'turns': len(turns),
            'total': summary['total'], 'models': summary['models'], 'windows': windows, 'modelWindows': model_windows,
        })
    periods, days = period_totals(responses, ranges, include_days=True)
    combined = priced_summary(responses, {})
    # The same response may be copied into a fork. Each request contributes
    # once to the account and to a single project, in its earliest session.
    project_totals = defaultdict(total)
    assigned = set()
    ordered = sorted(conversations, key=lambda row: row['updated'])
    for row in ordered:
        project = row['project']
        if project in assigned:
            continue
        assigned.add(project)
        for response_id in project_ids[project]:
            if response_id not in responses:
                continue
            _, model, usage, _ = responses.pop(response_id)
            _, tokens, amounts = price(model, usage)
            add(project_totals[project], tokens, amounts)
    return {
        'weekEnd': int(week_end * 1000),
        'total': combined['total'], 'models': combined['models'],
        'periods': periods, 'days': days,
        'sessions': sorted(conversations, key=lambda row: row['updated'], reverse=True),
        'projects': [
            {'project': project, **item}
            for project, item in sorted(project_totals.items(), key=lambda entry: -sum(entry[1]['cost']))
        ],
    }


def report(scope, session_id='', hint='', week_start='0', week_end='0'):
    root = (Path(os.environ.get('CLAUDE_CONFIG_DIR') or Path.home() / '.claude') / 'projects').resolve()
    responses = {}
    if scope == 'account':
        start = float(week_start) / 1000
        end = float(week_end) / 1000
        return account_report(root, start, end)
    path = current_transcript(root, session_id, hint)
    turns = read_session(path, responses) if path else {}
    return {'path': str(path) if path else '', **priced_summary(responses, turns)}


if __name__ == '__main__':
    print(json.dumps(report(*sys.argv[1:]), ensure_ascii=False, separators=(',', ':')))
