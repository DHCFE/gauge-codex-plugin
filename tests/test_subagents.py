"""Behavioral regressions for the shared sidebar/budget request ledger."""
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'plugin/scripts'))
import account_usage as ledger
import agent_usage as agents
import cost_meter as meter
import live_usage as live


def usage(n=1000):
    return dict(input_tokens=n, cached_input_tokens=400, cache_write_input_tokens=0,
                output_tokens=100, reasoning_output_tokens=40, total_tokens=n+100)


def row(kind, **payload):
    return {'timestamp':'2026-10-01T10:00:00Z', 'type':kind, 'payload':payload}


def request(sid, rid, turn, root=None, n=1000, cumulative=None):
    u=usage(n)
    return row('token_usage_record', thread_id=sid, response_id=rid, turn_id=turn,
               root_turn_id=root, usage=u, turn_token_usage=cumulative or u,
               thread_token_usage=cumulative or u)


class SubagentTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.home=Path(self.temp.name);self.folder=self.home/'sessions/2026/10/01'
        self.folder.mkdir(parents=True);self.data=self.home/'data'
        self.main=self.folder/'rollout-test-main.jsonl'
        self.write(self.main, row('session_meta',id='main',model_provider='openai'),
                   row('event_msg',type='task_started',turn_id='one'),
                   row('turn_context',turn_id='one',model='gpt-6.1-sol'),
                   request('main','main-r','one'))

    def write(self, path, *rows):
        path.parent.mkdir(parents=True,exist_ok=True)
        with path.open('a') as f:
            for item in rows:f.write(json.dumps(item)+'\n')

    def child(self, name='child', parent='main', root='one', extra=None):
        path=self.folder/('rollout-test-'+name+'.jsonl')
        self.write(path,row('session_meta',id=name,model_provider='openai',
                            source={'subagent':{'thread_spawn':{'parent_thread_id':parent}}},**(extra or {})),
                   row('event_msg',type='task_started',turn_id=name+'-t',root_turn_id=root),
                   row('turn_context',turn_id=name+'-t',model='gpt-6.1-sol',root_turn_id=root))
        return path

    def get(self):return live.snapshot('main',self.home,self.data)

    def test_large_tool_and_image_records_do_not_hide_child_usage(self):
        child=self.child()
        self.write(child,row('response_item',content='PRIVATE_BODY'+('x'*(meter.MAX_LINE+20))),
                   request('child','child-r','child-t','one'))
        result=self.get()
        self.assertEqual(result['total']['totalTokens'],2200)
        self.assertTrue(result['total']['costComplete']);self.assertFalse(result['scanPending'])
        self.assertEqual(result['turns'][0]['totalTokens'],2200)
        self.assertEqual(self.get()['total'],result['total'])
        with sqlite3.connect(self.data/'agents.sqlite3') as db:
            cached=str(db.execute('SELECT state FROM account_files').fetchall())
            cached+=str(db.execute('SELECT record FROM account_records').fetchall())
        self.assertNotIn('PRIVATE_BODY',cached)

    def test_multi_pass_giant_record_advances_then_reconciles_with_budget(self):
        child=self.child()
        self.write(child,row('response_item',content='x'*20000),request('child','child-r','child-t','one'))
        offsets=[]
        with patch.object(meter,'MAX_LINE',1024),patch.object(ledger,'MAX_FILE_BYTES',2048):
            for _ in range(20):
                result=self.get()
                with sqlite3.connect(self.data/'agents.sqlite3') as db:
                    state=json.loads(db.execute('SELECT state FROM account_files WHERE path=?',(str(child.resolve()),)).fetchone()[0])
                    offsets.append(state['cursor']['offset'])
                if not result['scanPending']:break
            self.assertGreater(len(offsets),2)
            self.assertTrue(all(a<b for a,b in zip(offsets,offsets[1:])),offsets)
            self.assertEqual(result['total']['totalTokens'],2200)
            self.assertTrue(all(t['costComplete'] for t in result['turns']))
            for _ in range(20):
                budget=ledger.snapshot({'conversationId':'main'},self.home,self.home/'budget-data')
                if budget['coverage']['scanCaughtUp']:break
            self.assertEqual(budget['total']['totalTokens'],result['total']['totalTokens'])
            self.assertAlmostEqual(float(budget['total']['amount']),result['total']['amount'])

    def test_partial_giant_record_resumes_after_append(self):
        child=self.child()
        encoded=json.dumps(row('response_item',content='x'*6000))
        with child.open('a') as f:f.write(encoded[:4000])
        with patch.object(meter,'MAX_LINE',1024):
            first=self.get();self.assertTrue(first['scanPending'])
            self.assertFalse(first['total']['costComplete'])
            with child.open('a') as f:f.write(encoded[4000:]+'\n')
            self.write(child,request('child','child-r','child-t','one'))
            last=self.get()
            self.assertFalse(last['scanPending']);self.assertEqual(last['total']['totalTokens'],2200)
            self.assertTrue(last['total']['costComplete'])

    def test_nested_children_count_once_and_fork_does_not_join(self):
        child=self.child();grand=self.child('grand','child')
        self.write(child,request('main','main-r','one'),request('child','child-r','child-t','one'))
        self.write(grand,request('child','child-r','child-t','one'),request('grand','grand-r','grand-t','one'))
        fork=self.folder/'rollout-test-fork.jsonl'
        self.write(fork,row('session_meta',id='fork',model_provider='openai',forked_from_id='main'),
                   row('turn_context',turn_id='fork-t',model='gpt-6.1-sol'),request('fork','fork-r','fork-t'))
        archive=self.home/'archived_sessions/child-copy.jsonl';archive.parent.mkdir()
        archive.write_bytes(child.read_bytes())
        result=self.get()
        self.assertEqual(result['total']['totalTokens'],3300)
        self.assertEqual(result['turns'][0]['totalTokens'],3300)
        self.assertEqual(result['subagents']['thread_count'],2)
        self.assertTrue(result['total']['costComplete'])

    def test_reused_child_and_late_request_keep_original_root_and_model(self):
        child=self.child()
        self.write(child,request('child','first','child-t','one'),
                   row('event_msg',type='task_started',turn_id='child-new',root_turn_id='two'),
                   row('turn_context',turn_id='child-new',model='unknown-model',root_turn_id='two'),
                   request('child','late','child-t',cumulative=meter.add(usage(),usage())),
                   request('child','next','child-new','two'))
        self.write(self.main,row('event_msg',type='task_complete',turn_id='one'),
                   row('event_msg',type='task_started',turn_id='two'),
                   row('turn_context',turn_id='two',model='gpt-6.1-sol'),request('main','second','two'))
        result=self.get();one,two=result['turns']
        self.assertEqual(one['totalTokens'],3300);self.assertTrue(one['costComplete'])
        self.assertEqual(two['totalTokens'],2200);self.assertFalse(two['costComplete'])
        self.assertEqual(one['status'],'completed')

    def test_missing_or_foreign_root_goes_only_to_conversation_total(self):
        for root in (None,'nonexistent-turn'):
            with self.subTest(root=root):
                child=self.child(name='child'+str(root),root=root)
                name='child'+str(root)
                self.write(child,request(name,name+'-r',name+'-t',root))
        result=self.get()
        self.assertEqual(result['total']['totalTokens'],3300)
        self.assertTrue(result['total']['costComplete'])
        self.assertEqual(result['turns'][0]['totalTokens'],1100)
        self.assertFalse(result['turns'][0]['costComplete'])
        self.assertEqual(result['subagents']['unattributed_tokens'],2200)

    def test_conflicting_child_metadata_excludes_its_entire_subtree(self):
        child=self.child();grand=self.child('grand','child')
        self.write(child,request('child','child-r','child-t','one'))
        self.write(grand,request('grand','grand-r','grand-t','one'))
        other=self.home/'archived_sessions/child-conflict.jsonl'
        self.write(other,row('session_meta',id='child',model_provider='openai',
                             source={'subagent':{'thread_spawn':{'parent_thread_id':'unrelated'}}}))
        result=self.get()
        self.assertEqual(result['total']['totalTokens'],1100)
        self.assertFalse(result['total']['costComplete'])
        self.assertIn('conflicting-session-metadata',result['warnings'])

    def test_conflicting_native_root_and_counters_are_quarantined(self):
        child=self.child()
        self.write(child,request('child','child-r','child-t','one'),
                   request('child','child-r','child-t','other',n=2000))
        result=self.get()
        self.assertEqual(result['total']['totalTokens'],1100)
        self.assertFalse(result['total']['costComplete'])
        self.assertIn('conflicting-request-record',result['warnings'])

    def test_native_records_supersede_invalid_and_reset_legacy_mirrors(self):
        child=self.child()
        malformed=row('event_msg',type='token_count',info={'total_token_usage':{'input_tokens':-1}})
        legacy=row('event_msg',type='token_count',info={'total_token_usage':usage(),'last_token_usage':usage()})
        self.write(child,malformed,legacy,request('child','child-r','child-t','one'),malformed,legacy)
        result=self.get()
        self.assertEqual(result['total']['totalTokens'],2200)
        self.assertEqual(result['warnings'],[])
        self.assertTrue(result['total']['costComplete'])
        budget=ledger.snapshot({'conversationId':'main'},self.home,self.home/'budget-data')
        self.assertTrue(budget['coverage']['usageComplete'])
        self.assertEqual(budget['total']['totalTokens'],2200)

    def test_late_context_fills_its_own_request_model_and_root(self):
        child=self.child(root=None)
        self.write(child,row('event_msg',type='task_started',turn_id='late-context'),
                   request('child','child-r','late-context'),
                   row('turn_context',turn_id='late-context',root_turn_id='one',model='gpt-6.1-sol'))
        result=self.get()
        self.assertEqual(result['turns'][0]['totalTokens'],2200)
        self.assertTrue(result['total']['costComplete'])

    def test_unresolved_legacy_child_is_never_guessed_as_owned(self):
        child=self.child()
        self.write(child,row('event_msg',type='token_count',info={'total_token_usage':usage(),'last_token_usage':usage()}))
        result=self.get()
        self.assertEqual(result['total']['totalTokens'],1100)
        self.assertFalse(result['total']['costComplete'])
        self.assertIn('legacy-lineage-unresolved',result['warnings'])

    def test_alternative_thread_source_metadata_is_recognized(self):
        child=self.folder/'rollout-test-child.jsonl'
        self.write(child,row('session_meta',id='child',model_provider='openai',
                            thread_source={'subagent':{'thread_spawn':{'parent_thread_id':'main'}}}),
                   row('turn_context',turn_id='child-t',root_turn_id='one',model='gpt-6.1-sol'),
                   request('child','child-r','child-t','one'))
        self.assertEqual(self.get()['turns'][0]['totalTokens'],2200)


    def test_budget_scope_is_not_poisoned_by_unrelated_broken_logs(self):
        child=self.child();self.write(child,request('child','child-r','child-t','one'))
        unrelated=self.folder/'unrelated.jsonl'
        self.write(unrelated,row('session_meta',id='unrelated',model_provider='openai'))
        with unrelated.open('a') as f:f.write('{broken telemetry}\n')
        with sqlite3.connect(self.home/'state_5.sqlite') as db:
            db.execute('CREATE TABLE threads (id TEXT, rollout_path TEXT, source TEXT)')
            db.execute('INSERT INTO threads VALUES (?,?,?)',('missing-unrelated',str(self.folder/'missing.jsonl'),'cli'))
        global_view=ledger.snapshot({},self.home,self.home/'global-data')
        self.assertFalse(global_view['coverage']['usageComplete'])
        scoped=ledger.snapshot({'conversationId':'main'},self.home,self.data)
        self.assertTrue(scoped['coverage']['usageComplete'])
        self.assertEqual(scoped['total']['totalTokens'],2200)
        self.assertTrue(self.get()['total']['costComplete'])

    def test_known_missing_child_marks_both_sidebar_and_budget_incomplete(self):
        source=json.dumps({'subagent':{'thread_spawn':{'parent_thread_id':'main'}}})
        with sqlite3.connect(self.home/'state_5.sqlite') as db:
            db.execute('CREATE TABLE threads (id TEXT, rollout_path TEXT, source TEXT)')
            db.execute('INSERT INTO threads VALUES (?,?,?)',('missing-child',str(self.folder/'missing.jsonl'),source))
        result=self.get()
        self.assertFalse(result['total']['costComplete'])
        self.assertEqual(result['subagents']['pending_thread_count'],1)
        self.assertEqual(result['subagents']['thread_count'],1)
        self.assertTrue(result['scanPending'])
        budget=ledger.snapshot({'conversationId':'main'},self.home,self.data)
        self.assertFalse(budget['coverage']['usageComplete'])
        self.assertEqual(budget['coverage']['missingLocalThreads'],1)

    def test_legacy_cache_upgrade_rebuilds_without_reusing_wrong_totals(self):
        child=self.child();self.write(child,request('child','child-r','child-t','one'))
        self.get()
        with sqlite3.connect(self.data/'agents.sqlite3') as db:
            raw=db.execute('SELECT state FROM account_files WHERE path=?',(str(child.resolve()),)).fetchone()[0]
            state=json.loads(raw);state['revision']=3
            db.execute('UPDATE account_files SET state=? WHERE path=?',(json.dumps(state),str(child.resolve())))
            db.execute('UPDATE account_records SET record=json_set(record,\'$.usage.total_tokens\',999999) WHERE path=?',(str(child.resolve()),))
        result=self.get();self.assertEqual(result['total']['totalTokens'],2200)
        self.assertTrue(result['total']['costComplete'])

    def test_explicit_history_boundary_excludes_same_id_inherited_native_requests(self):
        child=self.child(extra={'subagent_history_start_ordinal':5})
        inherited=request('child','inherited','child-t','one');inherited['ordinal']=3
        context=row('turn_context',turn_id='child-t',root_turn_id='one',model='gpt-6.1-sol');context['ordinal']=5
        owned=request('child','owned','child-t','one');owned['ordinal']=6
        # Replace the helper's pre-boundary contexts with correctly ordinalled history.
        child.unlink()
        meta=row('session_meta',id='child',model_provider='openai',subagent_history_start_ordinal=5,
                 source={'subagent':{'thread_spawn':{'parent_thread_id':'main'}}});meta['ordinal']=0
        self.write(child,meta,inherited,context,owned)
        result=self.get();self.assertEqual(result['total']['totalTokens'],2200)
        self.assertTrue(result['total']['costComplete'])


    def test_execution_identity_is_separate_from_child_thread_identity(self):
        child=self.child(extra={'session_id':'execution-child'})
        valid=request('child','valid','child-t','one');valid['payload']['session_id']='execution-child'
        self.write(child,valid)
        good=self.get();self.assertEqual(good['total']['totalTokens'],2200)
        self.assertTrue(good['total']['costComplete'])
        copied=request('child','copied','child-t','one');copied['payload']['session_id']='execution-parent'
        self.write(child,copied)
        result=self.get();self.assertEqual(result['total']['totalTokens'],2200)
        self.assertFalse(result['total']['costComplete'])
        budget=ledger.snapshot({'conversationId':'main'},self.home,self.data)
        self.assertFalse(budget['coverage']['usageComplete'])
        self.assertIn('native-session-identity-mismatch',budget['coverage']['issues'])


if __name__=='__main__':unittest.main()
