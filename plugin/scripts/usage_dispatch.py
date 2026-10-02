"""Bundled local telemetry entrypoint. Accept counts-only JSON, never chat text."""
import json
import os
import sys
import live_usage
import account_usage


def dispatch(request):
    operation = request.get('operation', 'thread')
    if operation == 'thread':
        return live_usage.snapshot(request.get('thread_id'))
    if operation == 'account':
        query = dict(request.get('request', {}))
        query.setdefault('pricesFile', str(live_usage.ROOT / 'data/prices.json'))
        return account_usage.snapshot(query)
    raise ValueError('Unsupported telemetry operation')


if __name__ == '__main__':
    os.umask(0o077)
    try:
        print(json.dumps(dispatch(json.loads(sys.stdin.read() or '{}')), ensure_ascii=False))
    except Exception as exc:
        # Never forward arbitrary process/auth diagnostics into the model or panel.
        print(json.dumps({'error': str(exc) if isinstance(exc, ValueError) else type(exc).__name__}, ensure_ascii=False))
        sys.exit(1)
