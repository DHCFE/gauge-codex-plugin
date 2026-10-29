import csv
import io
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import subprocess
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'plugin/scripts'))
import account_usage as a
import cost_meter as m

T0 = '2026-09-30T23:00:00Z'
T1 = '2026-10-01T00:00:00Z'
T2 = '2026-10-01T01:00:00Z'


def u(i=1000, c=400, o=100):
    return dict(zip(m.FIELDS, [i, c, 0, o, 40, i + o]))


def row(kind, timestamp=T1, **p):
    return {'timestamp': timestamp, 'type': kind, 'payload': p}


def meta(sid='main', **p):
    return row('session_meta', id=sid, model_provider='openai', **p)


def context(tid='t1', **p):
    return row('turn_context', turn_id=tid, model=p.pop('model', 'gpt-6.1-sol'), **p)


def native(sid='main', rid='r1', tid='t1', val=None, timestamp=T1, cumulative=None, **p):
    v = val or u()
    return row('token_usage_record', timestamp, thread_id=sid, turn_id=tid, response_id=rid,
               usage=v, turn_token_usage=cumulative or v, thread_token_usage=cumulative or v, **p)


def legacy(total=None, last=None, timestamp=T1):
    return row('event_msg', timestamp, type='token_count', info={'total_token_usage': total or u(), 'last_token_usage': last or u()})


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.data = self.home / 'data'
        self.folder = self.home / 'sessions/2026/10/01'
        self.folder.mkdir(parents=True)
        self.path = self.folder / 'main.jsonl'

    def write(self, path, *records, mode='a'):
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open(mode) as f:
            for r in records:
                f.write(json.dumps(r) + '\n')

    def get(self, **request):
        return a.snapshot(request, self.home, self.data)

    def basic(self, **p):
        self.write(self.path, meta(account_id='acct-a', billing_pool_id='codex', **p), context(), native())

    def test_native_duplicate_legacy_precedence_incremental_and_cache(self):
        self.basic()
        self.write(self.path, native(), legacy())
        out = self.get()
        self.assertEqual(out['total']['totalTokens'], 1100)
        self.assertEqual(out['recordCount'], 1)
        self.assertAlmostEqual(float(out['total']['amount']), .00224)
        self.assertEqual(out['total']['reasoning'], 40)
        self.assertEqual(out['total']['costParts']['output'], '0.001')
        self.assertTrue(out['coverage']['localScanComplete'])
        self.assertFalse(out['coverage']['accountLedgerComplete'])
        self.assertEqual(self.get()['coverage']['bytesRead'], 0)
        self.write(self.path, context('t2'), native(rid='r2', tid='t2'))
        newer = self.get()
        self.assertEqual(newer['total']['totalTokens'], 2200)
        self.assertLess(newer['coverage']['bytesRead'], self.path.stat().st_size)

    def test_archived_copies_and_migration_count_once(self):
        self.basic()
        archived = self.home / 'archived_sessions/copy.jsonl'
        archived.parent.mkdir()
        archived.write_bytes(self.path.read_bytes())
        r = self.get()
        self.assertEqual(r['total']['totalTokens'], 1100)
        self.assertEqual(r['threads'][0]['sourceFiles'], 2)
        self.assertEqual(r['records'][0]['sourceCopies'], 2)
        self.path.unlink()
        migrated = self.get()
        self.assertEqual(migrated['total']['totalTokens'], 1100)
        self.assertTrue(migrated['threads'][0]['archived'])

    def test_rewrite_replaces_stale_rows_same_size(self):
        self.basic()
        before = self.get()
        content = self.path.read_text().replace('"r1"', '"r9"')
        self.path.write_text(content)
        after = self.get()
        self.assertEqual(before['total'], after['total'])
        self.assertNotEqual(before['records'][0]['id'], after['records'][0]['id'])
        self.write(self.path, meta(account_id='acct-a'), context(), native(val=u(2000, 400, 200)), mode='w')
        r = self.get()
        self.assertEqual(r['total']['totalTokens'], 2200)
        self.assertEqual(r['recordCount'], 1)

    def test_delayed_partial_line_never_cached_as_complete(self):
        self.write(self.path, meta(), context())
        encoded = json.dumps(native())
        with self.path.open('a') as f:
            f.write(encoded[:55])
        pending = self.get()
        self.assertEqual(pending['recordCount'], 0)
        self.assertFalse(pending['coverage']['localScanComplete'])
        with self.path.open('a') as f:
            f.write(encoded[55:] + '\n')
        self.assertEqual(self.get()['recordCount'], 1)

    def test_period_exact_boundaries_and_local_day(self):
        self.write(self.path, meta(account_id='acct-a'), context(), native(rid='before', timestamp=T0),
                   native(rid='at-start', timestamp=T1), native(rid='at-end', timestamp=T2))
        out = self.get(startAt=T1, endAt=T2, accountId='acct-a', timezone='Asia/Shanghai')
        self.assertEqual(out['recordCount'], 1)
        self.assertEqual(out['records'][0]['responseId'], 'at-start')
        self.assertEqual(out['byDay'][0]['id'], '2026-10-01')
        self.assertTrue(out['coverage']['timeFilterExact'])
        self.assertEqual(self.get(startAt=a.stamp(T1), endAt=a.stamp(T2))['recordCount'], 1)
        with self.assertRaisesRegex(ValueError, 'timezone'):
            self.get(startAt='2026-10-01T00:00:00')

    def test_account_unknown_not_assigned_from_current_login(self):
        self.write(self.path, meta(), context(), native())
        # This sentinel must never be inspected by the ledger.
        (self.home / 'auth.json').write_text('{"account_id":"acct-a","secret":"do-not-read"}')
        result = self.get(accountId='acct-a')
        self.assertEqual(result['recordCount'], 0)
        self.assertIsNone(result['total']['amount'])
        self.assertEqual(result['unattributed']['account']['totalTokens'], 1100)
        self.assertFalse(result['coverage']['accountAttributionComplete'])
        self.assertIsNone(self.get()['records'][0]['accountId'])

    def test_account_pool_filters_do_not_mix(self):
        self.basic()
        other = self.folder / 'other.jsonl'
        self.write(other, meta('other', account_id='acct-b', billing_pool_id='api-key'), context(), native('other'))
        out = self.get(accountId='acct-a', billingPoolId='codex')
        self.assertEqual(out['total']['totalTokens'], 1100)
        self.assertEqual(self.get()['total']['totalTokens'], 2200)

    def test_child_parent_not_double_counted_and_fork_independent(self):
        self.basic(cwd='/projects/a')
        self.write(self.folder / 'child.jsonl', meta('child', account_id='acct-a', source={'subagent': {'thread_spawn': {'parent_thread_id': 'main'}}}),
                   context('child-t', root_turn_id='t1'), native(), native('child', rid='child-r', tid='child-t', root_turn_id='t1'))
        self.write(self.folder / 'fork.jsonl', meta('fork', forked_from_id='main', account_id='acct-a'), context('fork-t'), native(), native('fork', rid='fork-r', tid='fork-t'))
        out = self.get()
        self.assertEqual(out['total']['totalTokens'], 3300)
        self.assertEqual(out['recordCount'], 3)
        main = self.get(conversationId='main')
        self.assertEqual(main['total']['totalTokens'], 2200)
        self.assertEqual(main['byConversation'][0]['totalTokens'], 2200)
        self.assertEqual(next(g for g in out['byAgent'] if g['id'] == 'subagent')['totalTokens'], 1100)
        self.assertEqual(self.get(threadId='main')['total']['totalTokens'], 1100)

    def test_legacy_child_unresolved_is_quarantined(self):
        self.write(self.path, meta('child', source={'subagent': {'thread_spawn': {'parent_thread_id': 'main'}}}), context(), legacy())
        out = self.get(includeUnresolved=True)
        self.assertEqual(out['recordCount'], 0)
        self.assertEqual(out['unattributed']['ownership']['totalTokens'], 1100)
        self.assertEqual(len(out['unresolvedRecords']), 1)
        self.assertIsNone(out['unresolvedRecords'][0]['amount'])
        self.assertIn('legacy-lineage-unresolved', out['coverage']['issues'])
        self.assertEqual(len(out['threads']), 1)

    def test_legacy_ordinal_boundary_filters_inherited_usage(self):
        first = meta('child', subagent_history_start_ordinal=5, source={'subagent': {'thread_spawn': {'parent_thread_id': 'main'}}})
        first['ordinal'] = 0
        inherited = legacy()
        inherited['ordinal'] = 2
        ctx = context()
        ctx['ordinal'] = 5
        owned = legacy(m.add(u(), u()))
        owned['ordinal'] = 6
        self.write(self.path, first, inherited, ctx, owned)
        out = self.get()
        self.assertEqual(out['recordCount'], 1)
        self.assertEqual(out['total']['totalTokens'], 1100)
        self.assertTrue(out['total']['costComplete'])

    def test_legacy_equal_totals_no_new_request_and_gap_unpriced(self):
        self.write(self.path, meta(account_id='a'), context(), legacy(), legacy(timestamp=T2))
        r = self.get()
        self.assertEqual(r['recordCount'], 1)
        self.write(self.path, legacy(m.add(u(), m.add(u(), u())), timestamp=T2))
        gap = self.get()
        self.assertEqual(gap['total']['totalTokens'], 3300)
        self.assertIsNone(gap['total']['amount'])
        self.assertEqual(gap['total']['unpricedTokens'], 2200)
        bounded = self.get(startAt=T1, endAt='2026-10-02T00:00:00Z')
        self.assertEqual(bounded['recordCount'], 1)
        self.assertFalse(bounded['coverage']['timeFilterExact'])
        self.assertEqual(bounded['unattributed']['time']['totalTokens'], 2200)

    def test_missing_timestamp_not_guessed_into_period(self):
        self.write(self.path, meta(account_id='a'), context(), native(timestamp=None))
        r = self.get(startAt=T1, endAt=T2)
        self.assertEqual(r['recordCount'], 0)
        self.assertFalse(r['coverage']['timeFilterExact'])
        self.assertEqual(r['unattributed']['time']['requestCount'], 1)

    def test_unknown_models_cache_write_unknown_and_non_openai(self):
        self.write(self.path, meta(account_id='a'), context(model='never-priced'), native())
        result = self.get()
        self.assertIsNone(result['total']['amount'])
        self.assertEqual(result['total']['unpricedTokens'], 1100)
        self.assertIn('Unknown model', result['records'][0]['costReason'])
        self.write(self.path, meta(account_id='a'), context(), native(), mode='w')
        rec = native(rid='no-write')
        rec['payload']['usage'].pop('cache_write_input_tokens')
        self.write(self.path, rec)
        result = self.get()
        self.assertIsNone(result['total']['cacheWrite'])
        self.assertIsNone(result['total']['input'])
        self.assertGreater(float(result['total']['knownUsd']), 0)
        self.assertIsNone(result['total']['amount'])

    def test_conflicting_duplicate_never_presented_as_complete(self):
        self.basic()
        copy = self.home / 'archived_sessions/copy.jsonl'
        self.write(copy, meta(account_id='acct-a', billing_pool_id='codex'), context(), native(val=u(2000, 400, 200)))
        out = self.get(includeUnresolved=True)
        self.assertEqual(out['recordCount'], 0)
        self.assertEqual(out['coverage']['conflictingRequests'], 1)
        self.assertFalse(out['coverage']['usageComplete'])
        self.assertEqual(len(out['unresolvedRecords']), 1)

    def test_native_gap_does_not_invent_a_priced_request(self):
        self.write(self.path, meta(account_id='a'), context(), native(cumulative=m.add(u(), u())))
        out = self.get()
        self.assertEqual(out['recordCount'], 1)
        self.assertEqual(out['total']['totalTokens'], 1100)
        self.assertIn('native-total-gap', out['coverage']['issues'])
        self.assertFalse(out['coverage']['usageComplete'])

    def test_project_day_model_search_sort_pagination_and_export(self):
        self.basic(cwd='/projects/a')
        self.write(self.folder / 'other.jsonl', meta('other', account_id='acct-a', cwd='/projects/b'), context(), native('other', val=u(2000, 400, 200), timestamp=T2))
        out = self.get(limit=1, recordLimit=1, sort='amount', exportFormat='json')
        self.assertEqual(out['threadCount'], 2)
        self.assertEqual(out['threads'][0]['threadId'], 'other')
        self.assertEqual(len(out['export']['data']['records']), 2)
        self.assertEqual(len(out['byProject']), 2)
        self.assertEqual(out['byModel'][0]['requestCount'], 2)
        self.assertEqual(self.get(search='/projects/a')['threadCount'], 1)
        self.assertEqual(self.get(project='/projects/b')['recordCount'], 1)
        exported = self.get(exportFormat='csv')['export']['data']
        self.assertEqual(len(list(csv.DictReader(io.StringIO(exported)))), 2)

    def test_no_chat_content_in_cache_or_export(self):
        sentinel = 'private-content-sentinel'
        self.basic()
        self.write(self.path, row('response_item', content=sentinel), row('event_msg', type='user_message', message=sentinel))
        out = self.get(exportFormat='json')
        self.assertNotIn(sentinel, json.dumps(out))
        with sqlite3.connect(self.data / 'account-ledger.sqlite3') as db:
            self.assertNotIn(sentinel, '\n'.join(db.iterdump()))

    def test_oversize_chat_streaming_resume(self):
        self.write(self.path, meta(), context())
        self.write(self.path, row('response_item', content='x' * (m.MAX_LINE + 10)), native())
        out = self.get()
        self.assertEqual(out['recordCount'], 1)
        self.assertNotIn('oversized-telemetry-record', out['coverage']['issues'])

    def test_scan_budget_resumes_without_starving_other_files(self):
        self.basic()
        self.write(self.folder / 'other.jsonl', meta('other'), context(), native('other'))
        with patch.object(a, 'MAX_FILE_BYTES', 600), patch.object(a, 'MAX_SCAN_BYTES', 600):
            last = None
            for _ in range(12):
                last = self.get()
                if last['coverage']['localScanComplete']:
                    break
            self.assertEqual(last['recordCount'], 2)
            self.assertTrue(last['coverage']['localScanComplete'])

    def test_reset_interleave_does_not_charge_repeat_high_watermark(self):
        high, low = u(2000, 400, 200), u()
        self.write(self.path, meta(account_id='a'), context(), legacy(high, high),
                   legacy(low, low, timestamp=T2), legacy(high, high, timestamp=T2))
        result = self.get(includeUnresolved=True)
        self.assertEqual(result['total']['totalTokens'], 2200)
        self.assertEqual(result['recordCount'], 1)
        self.assertIn('cumulative-counter-reset', result['coverage']['issues'])
        self.assertEqual(result['unattributed']['ownership']['requestCount'], 1)
        self.assertEqual(result['unresolvedRecords'][0]['source'], 'cumulative-reset')

    def test_index_exposes_missing_remote_and_explicit_names_without_titles(self):
        self.basic()
        with sqlite3.connect(self.home / 'state_5.sqlite') as db:
            db.execute('CREATE TABLE threads(id TEXT, name TEXT, title TEXT, rollout_path TEXT, cwd TEXT, archived INTEGER)')
            db.executemany('INSERT INTO threads VALUES (?,?,?,?,?,?)', [
                ('main', 'Named project', 'secret derived from chat', str(self.path), '/projects/a', 0),
                ('missing', None, 'private title', str(self.folder / 'missing.jsonl'), '/projects/b', 1),
                ('remote', None, 'private title', None, None, 0)])
        result = self.get()
        self.assertEqual(result['threadCount'], 3)
        self.assertEqual(result['coverage']['missingLocalThreads'], 1)
        self.assertEqual(result['coverage']['nonLocalOrMissingThreads'], 1)
        self.assertFalse(result['coverage']['usageComplete'])
        self.assertEqual(next(t for t in result['threads'] if t['threadId'] == 'remote')['usageStatus'], 'non-local-or-missing')
        self.assertEqual(self.get(search='Named project')['threadCount'], 1)
        self.assertNotIn('private title', json.dumps(result))
        with sqlite3.connect(self.data / 'account-ledger.sqlite3') as db:
            cache = '\n'.join(db.iterdump())
        self.assertNotIn('secret derived', cache)
        self.assertNotIn('Named project', cache)

    def test_late_native_model_not_taken_from_other_turn(self):
        self.write(self.path, meta(), context('other-turn'), native())
        result = self.get()
        self.assertIsNone(result['records'][0]['model'])
        self.assertIsNone(result['total']['amount'])

    def test_request_explicit_account_does_not_overwrite_prior_history(self):
        self.write(self.path, meta(), context(), native(account_id='a'),
                   context('next', account_id='b'), native(tid='next', rid='next'))
        self.assertEqual(self.get(accountId='a')['recordCount'], 1)
        self.assertEqual(self.get(accountId='b')['recordCount'], 1)

    def test_csv_formula_labels_are_neutralized(self):
        self.basic(cwd='=HYPERLINK("bad")')
        result = self.get(exportFormat='csv')
        row = next(csv.DictReader(io.StringIO(result['export']['data'])))
        self.assertTrue(row['project'].startswith("'="))

    def test_non_openai_and_missing_reasoning_are_unknown(self):
        rec = native()
        rec['payload']['usage'].pop('reasoning_output_tokens')
        self.write(self.path, meta(), context(), rec)
        result = self.get()
        self.assertIsNone(result['total']['reasoning'])
        self.write(self.path, meta(), context(model_provider='other-provider'), native(), mode='w')
        result = self.get()
        self.assertIsNone(result['total']['amount'])
        self.assertIn('Non-OpenAI', result['records'][0]['costReason'])

    def test_cli_no_current_thread_required_and_isolated_environment(self):
        self.basic()
        run = subprocess.run([sys.executable, str(Path(a.__file__))], input=json.dumps({'exportFormat': 'json'}),
                             text=True, capture_output=True, env={**os.environ, 'CODEX_HOME': str(self.home), 'TOKENLENS_DATA': str(self.data)})
        self.assertEqual(run.returncode, 0, run.stderr)
        result = json.loads(run.stdout)
        self.assertEqual(result['recordCount'], 1)
        self.assertFalse(result['coverage']['sourceComplete'])
        self.assertTrue(result['coverage']['otherDevicesPossible'])

    def test_bounded_unresolved_and_export_preserve_ownership_uncertainty(self):
        self.write(self.path, meta('fork', forked_from_id='main'), context(), legacy())
        result = self.get(startAt=T1, endAt=T2, includeUnresolved=True, exportFormat='json')
        self.assertEqual(result['recordCount'], 0)
        self.assertEqual(result['coverage']['ownershipUnresolvedRequests'], 1)
        self.assertEqual(len(result['export']['data']['unresolvedRecords']), 1)

    def test_conflicting_metadata_does_not_prove_budget_lineage(self):
        self.basic()
        other = self.home / 'archived_sessions/other.jsonl'
        self.write(other, meta(account_id='acct-a', billing_pool_id='codex', source={'subagent': {'thread_spawn': {'parent_thread_id': 'parent'}}}), context(), native())
        result = self.get()
        self.assertFalse(result['coverage']['usageComplete'])
        self.assertIn('conflicting-session-metadata', result['threads'][0]['issues'])
        self.assertIsNone(result['threads'][0]['parentThreadId'])

    def test_archive_complementary_native_copies_use_shared_reconstruction(self):
        v = m.add(u(), u())
        self.write(self.path, meta(), context(), native(rid='second', cumulative=v))
        archive = self.home / 'archived_sessions/partial.jsonl'
        self.write(archive, meta(), context(), native(rid='first'))
        result = self.get()
        self.assertEqual(result['recordCount'], 2)
        self.assertEqual(result['total']['totalTokens'], 2200)
        self.assertNotIn('native-total-gap', result['coverage']['issues'])

    def test_large_partial_chat_tail_is_pending_and_can_resume(self):
        self.write(self.path, meta(), context())
        with self.path.open('a') as f:
            f.write('{"type": "response_item", "payload": {"content": "' + 'x' * (m.MAX_LINE + 5))
        result = self.get()
        self.assertFalse(result['coverage']['localScanComplete'])
        self.assertIn('records-pending', result['coverage']['issues'])
        with self.path.open('a') as f:
            f.write('"}}\n')
        self.write(self.path, native())
        self.assertEqual(self.get()['recordCount'], 1)

    def test_native_orphan_copy_is_preserved_without_charging(self):
        self.write(self.path, meta('fork', forked_from_id='parent'), context(), native('parent'))
        result = self.get(includeUnresolved=True)
        self.assertEqual(result['recordCount'], 0)
        self.assertEqual(result['unattributed']['ownership']['requestCount'], 1)
        self.assertIn('native-origin-transcript-missing', result['coverage']['issues'])
        self.assertEqual(result['unresolvedRecords'][0]['threadId'], 'parent')
        self.write(self.folder / 'parent.jsonl', meta('parent'), context(), native('parent'))
        result = self.get(includeUnresolved=True)
        self.assertEqual(result['recordCount'], 1)
        self.assertEqual(result['unresolvedRecords'], [])

    def test_request_drilldown_can_page_and_filter_turns(self):
        self.basic()
        self.write(self.path, context('t2'), native(tid='t2', rid='r2', timestamp=T2))
        first = self.get(recordLimit=1)
        second = self.get(recordLimit=1, recordOffset=first['nextRecordOffset'])
        self.assertNotEqual(first['records'][0]['id'], second['records'][0]['id'])
        self.assertIsNone(second['nextRecordOffset'])
        self.assertEqual(self.get(turnId='t1')['recordCount'], 1)
        self.assertEqual(self.get(responseId='r2')['records'][0]['turnId'], 't2')

    def test_creator_account_id_is_recorded_evidence_not_login_inference(self):
        self.write(self.path, meta(creator_account_id='recorded-owner'), context(), native())
        r = self.get(accountId='recorded-owner')
        self.assertEqual(r['recordCount'], 1)
        self.assertEqual(r['records'][0]['accountId'], 'recorded-owner')
        self.assertEqual(r['threads'][0]['accountEvidence'], 'creator-account-telemetry')

    def test_missing_account_and_pool_can_be_observed_under_explicit_assumption(self):
        self.write(self.path, meta(), context(), native())
        self.assertEqual(self.get(accountId='a', billingPoolId='pool')['recordCount'], 0)
        assumed = self.get(accountId='a', billingPoolId='pool', identityPolicy='include-unattributed')
        self.assertEqual(assumed['recordCount'], 1)
        self.assertEqual(assumed['coverage']['assumedIdentityRequests'], 1)
        self.assertIsNone(assumed['records'][0]['accountId'])
        self.assertIsNone(assumed['records'][0]['billingPoolId'])
        self.assertEqual(assumed['accountStatus'], 'recorded-plus-unattributed')
        self.write(self.folder / 'other.jsonl', meta('other', account_id='different'), context(), native('other'))
        self.assertEqual(self.get(accountId='a', identityPolicy='include-unattributed')['recordCount'], 1)

    def test_known_subtotal_survives_unpriced_rows_and_measured_zero(self):
        self.basic()
        self.write(self.path, context('next', model='unpriced'), native(rid='r2', tid='next'))
        r = self.get()
        self.assertIsNone(r['total']['amount'])
        self.assertEqual(r['total']['amountStatus'], 'known-subtotal')
        self.assertEqual(r['total']['observedUsd'], '0.00224')
        self.assertEqual(r['total']['pricedRequests'], 1)
        unknown = self.get(model='unpriced')
        self.assertIsNone(unknown['total']['observedUsd'])
        self.assertEqual(unknown['total']['amountStatus'], 'unpriced')

    def test_late_native_uses_model_of_its_explicit_turn(self):
        self.write(self.path, meta(), context('t1'), context('t2', model='gpt-6-astra'), native())
        r = self.get()
        self.assertEqual(r['records'][0]['model'], 'gpt-6.1-sol')
        self.assertTrue(r['total']['costComplete'])

    def test_old_cache_backfills_creator_id_without_replaying_message_bodies(self):
        self.write(self.path, meta(creator_account_id='recorded-owner'), context(), native())
        self.get()
        with sqlite3.connect(self.data / 'account-ledger.sqlite3') as db:
            path, raw = db.execute('SELECT path,state FROM account_files').fetchone()
            old = json.loads(raw);old['meta']['accountId'] = None;old.pop('identityProbeRevision', None)
            db.execute('UPDATE account_files SET state=?', (json.dumps(old),))
            raw = db.execute('SELECT record FROM account_records').fetchone()[0]
            old_rec = json.loads(raw);old_rec['accountId'] = None
            db.execute('UPDATE account_records SET record=?', (json.dumps(old_rec),))
        repaired = self.get(accountId='recorded-owner')
        self.assertEqual(repaired['recordCount'], 1)
        self.assertEqual(repaired['coverage']['bytesRead'], 0)

    def test_cycle_scans_recent_files_before_old_history(self):
        older = self.folder / 'aaa-old.jsonl'
        self.write(older, meta('old'), context(), native('old', timestamp=T0))
        os.utime(older, (1, 1))
        self.write(self.path, meta(), context(), native())
        with patch.object(a, 'MAX_SCAN_BYTES', 1):
            result = self.get(startAt=T1, endAt=T2)
        with sqlite3.connect(self.data / 'account-ledger.sqlite3') as db:
            sid = json.loads(db.execute('SELECT state FROM account_files').fetchone()[0])['meta']['id']
        self.assertEqual(sid, 'main')


    def test_model_reroute_updates_request_pricing(self):
        self.write(self.path, meta(), context(), row('event_msg', type='model_rerouted', to_model='gpt-6-astra'), native())
        self.assertEqual(self.get()['records'][0]['model'], 'gpt-6-astra')

    def test_scan_progress_separates_catchup_from_historical_parse_quality(self):
        self.basic()
        with self.path.open('a') as f:
            f.write('{invalid-telemetry}\n')
        r = self.get()
        self.assertTrue(r['coverage']['scanCaughtUp'])
        self.assertFalse(r['coverage']['localScanComplete'])
        self.assertEqual(r['coverage']['filesCatchupPending'], 0)
        self.assertEqual(r['coverage']['bytesRemaining'], 0)
        self.assertEqual(r['total']['observedUsd'], '0.00224')

    def test_legacy_creator_account_backfill_is_only_probed_once(self):
        self.write(self.path, meta(), context(), native())
        self.get()
        with sqlite3.connect(self.data / 'account-ledger.sqlite3') as db:
            raw = db.execute('SELECT state FROM account_files').fetchone()[0]
            old = json.loads(raw);old.pop('identityProbeRevision', None)
            db.execute('UPDATE account_files SET state=?', (json.dumps(old),))
        self.get()
        with patch.object(Path, 'open', side_effect=AssertionError('No unchanged header reread')):
            # Snapshot pricing intentionally opens the table through read_text;
            # restrict this check to refresh, which owns the transcript reads.
            with sqlite3.connect(self.data / 'account-ledger.sqlite3') as db:
                result = a.refresh(self.home.resolve(), db, {})
        self.assertEqual(result['filesUnchanged'], 1)

    def test_strict_input_rejects_strings_and_empty_nonobjects(self):
        for request in ([], '', {'archived': 'false'}, {'subagent': 0}, {'limit': -1}, {'sort': 'unsafe'}):
            with self.subTest(request=request), self.assertRaises(ValueError):
                a.snapshot(request, self.home, self.data)

    def test_empty_and_malformed_records_distinguish_unknown(self):
        empty = self.get()
        self.assertIsNone(empty['total']['amount'])
        self.assertEqual(empty['coverage']['status'], 'unavailable')
        self.write(self.path, meta(), context())
        with self.path.open('a') as f:
            f.write('{bad-json}\n')
        result = self.get()
        self.assertFalse(result['coverage']['localScanComplete'])
        self.assertIn('invalid-telemetry-record', result['coverage']['issues'])


if __name__ == '__main__':
    unittest.main()
