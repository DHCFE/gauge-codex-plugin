from decimal import Decimal
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'plugin/scripts'))
import usage_dispatch
import service_tiers


class RequestTierTests(unittest.TestCase):
    def test_same_turn_prices_each_request_and_keeps_missing_tiers_in_the_total(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            data = home / 'gauge'
            folder = home / 'sessions/2026/11/11'
            folder.mkdir(parents=True)
            values = dict(input_tokens=100000, cached_input_tokens=0, cache_write_input_tokens=0,
                          output_tokens=0, reasoning_output_tokens=0, total_tokens=100000)
            rows = [('session_meta', dict(id='chat', model_provider='openai')),
                    ('turn_context', dict(turn_id='turn', model='gpt-6.1-sol'))]
            def request(id, turn='turn', **extra):
                rows.append(('token_usage_record', dict(thread_id='chat', turn_id=turn, response_id=id, usage=values, **extra)))
            request('standard', service_tier='default')
            request('fast', actual_service_tier='priority', service_tier='default')
            request('ultra', service_tier='ultrafast')
            request('historical', turn='historical', model='gpt-6.1-sol')
            request('unknown', turn='unknown', model='gpt-6.1-sol')
            (folder / 'rollout-test-chat.jsonl').write_text(''.join(json.dumps({'type': kind, 'payload': payload})+'\n' for kind, payload in rows))
            def body(turn, tier, model='gpt-6.1-sol'):
                return f'op.dispatch.turn_input{{turn_id={turn} model={model}}}: tags_json=' + json.dumps(json.dumps({'service_tier': tier}))
            with patch.dict(os.environ, {'CODEX_HOME': str(home), 'TOKENLENS_DATA': str(data)}):
                account = lambda: usage_dispatch.dispatch({'operation': 'account'})
                before = account()
                self.assertEqual(before['total']['estimatedTierRequests'], 2)
                self.assertEqual(Decimal(before['total']['knownUsd']), Decimal('2.2'))
                with sqlite3.connect(home / 'logs_2.sqlite') as log:
                    log.execute('CREATE TABLE logs(id INTEGER PRIMARY KEY, thread_id, target, feedback_log_body)')
                    log.executemany('INSERT INTO logs(thread_id,target,feedback_log_body) VALUES (?,?,?)', [
                        ('chat', 'feedback_tags', body('historical','priority')),
                        ('chat', 'feedback_tags', body('unknown','priority','gpt-6-astra')),
                        ('chat', 'feedback_tags', body('turn','ultrafast'))])
                after = account()
                records = {row['responseId']: row for row in after['records']}
                self.assertEqual(after['total']['totalTokens'], 500000)
                self.assertEqual(after['total']['estimatedTierRequests'], 1)
                self.assertTrue(after['total']['costComplete'])
                self.assertEqual(Decimal(after['total']['knownUsd']), Decimal('2.4'))
                self.assertEqual(records['historical']['serviceTierSource'], 'turn-diagnostics')
                self.assertEqual(records['fast']['serviceTier'], 'fast')
                self.assertEqual(records['unknown']['serviceTierSource'], 'standard-estimate')
                self.assertEqual(Decimal(records['unknown']['amount']), Decimal('0.2'))
                thread = usage_dispatch.dispatch({'operation': 'thread', 'thread_id': 'chat'})
                self.assertEqual(thread['turns'][0]['amount'], 1.8)
                self.assertEqual(thread['total']['pricedTokens'], 500000)
                with sqlite3.connect(home / 'logs_2.sqlite') as log:
                    log.execute('INSERT INTO logs(thread_id,target,feedback_log_body) VALUES (?,?,?)', ('chat','feedback_tags',body('historical','default')))
                self.assertEqual(account()['total']['estimatedTierRequests'], 2)
                (home / 'logs_2.sqlite').unlink()
                self.assertEqual(account()['total']['estimatedTierRequests'], 2, 'conflicting evidence survives diagnostic rotation')

    def test_recovers_a_gap_from_nearby_evidence_without_crossing_conversations(self):
        def request(turn, stamp, tier=None, thread='chat', account='account', model='gpt-6.1-sol'):
            return dict(threadId=thread, turnId=turn, model=model, accountId=account,
                        recordedServiceTier=tier, timestamp=stamp, ownership='owned')

        rows = [request('gap', 1000), request('fast', 2000), request('standard', 5000, 'standard'),
                request('old', 9000000), request('outside', 1000, thread='other'),
                request('different-account', 1000, account='other'),
                request('different-model', 1000, model='gpt-6-astra')]
        with patch.object(service_tiers, 'diagnostics', return_value={('chat', 'fast', 'gpt-6.1-sol'): 'fast'}):
            service_tiers.apply(rows, None, None)
        self.assertEqual([r['serviceTier'] for r in rows], ['fast', 'fast', 'standard', 'standard', 'standard', 'standard', 'standard'])
        self.assertEqual(rows[0]['serviceTierSource'], 'nearby-turn-estimate')
        self.assertEqual(rows[1]['serviceTierSource'], 'turn-diagnostics')
        self.assertEqual(rows[2]['serviceTierSource'], 'request-telemetry')
