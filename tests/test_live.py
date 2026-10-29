import json
import pathlib
import sys
import tempfile
import unittest
import sqlite3
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'plugin/scripts'))
import live_usage as live
import cost_meter as m

def u(i=1000,c=400,o=100):
    return dict(zip(m.FIELDS,[i,c,0,o,40,i+o]))
def row(kind,**payload):return {'type':kind,'payload':payload}
def native(sid='main',tid='turn',rid='response',values=None,root=None):
    v=values or u()
    return row('token_usage_record',thread_id=sid,turn_id=tid,response_id=rid,root_turn_id=root,
               usage=v,turn_token_usage=v,thread_token_usage=v)

class LiveTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.home=pathlib.Path(self.tmp.name);self.data=self.home/'panel-data'
        self.folder=self.home/'sessions/2026/10/01';self.folder.mkdir(parents=True)
        self.path=self.folder/'rollout-test-main.jsonl'
        self.write(self.path,row('session_meta',id='main',model_provider='openai'),
                   row('event_msg',type='task_started',turn_id='turn'),
                   row('turn_context',turn_id='turn',model='gpt-6.1-sol',effort='medium'))
    def write(self,path,*rows):
        with path.open('a') as f:
            for r in rows:f.write(json.dumps(r)+'\n')
    def get(self):return live.snapshot('main',self.home,self.data)
    def test_actual_prices_partition_reasoning_and_duplicates(self):
        self.write(self.path,native(),native(),row('event_msg',type='token_count',info={'total_token_usage':u(),'last_token_usage':u()}))
        r=self.get();t=r['turns'][-1]
        self.assertEqual((t['input'],t['cached'],t['output'],t['reasoning']),(600,400,100,40))
        self.assertEqual(t['totalTokens'],1100)
        self.assertAlmostEqual(t['amount'],0.00224)
        self.assertEqual(r['total']['totalTokens'],1100)
        self.assertEqual(self.get()['total'],r['total'])
    def test_partial_record_becomes_complete_without_previous_turn_reuse(self):
        self.write(self.path,native(),row('event_msg',type='task_complete',turn_id='turn'),row('event_msg',type='task_started',turn_id='next'),row('turn_context',turn_id='next',model='gpt-6.1-sol'))
        v=u(1200,600,120);n=native(tid='next',rid='new',values=v);n['payload']['thread_token_usage']=m.add(u(),v)
        serialized=json.dumps(n)
        with self.path.open('a') as f:f.write(serialized[:50])
        r=self.get();self.assertTrue(r['turns'][-1]['pending']);self.assertTrue(r['scanPending'])
        with self.path.open('a') as f:f.write(serialized[50:]+'\n')
        r=self.get();self.assertFalse(r['turns'][-1]['pending']);self.assertEqual(r['total']['totalTokens'],2420)
    def test_child_own_records_only_and_root_attribution(self):
        self.write(self.path,native())
        child=self.folder/'rollout-test-child.jsonl'
        self.write(child,row('session_meta',id='child',model_provider='openai',source={'subagent':{'thread_spawn':{'parent_thread_id':'main'}}}),
                   native(),row('turn_context',turn_id='child-turn',root_turn_id='turn',model='gpt-6.1-sol'),
                   native(sid='child',tid='child-turn',rid='child-response',root='turn'))
        r=self.get();self.assertEqual(r['subagents']['thread_count'],1)
        self.assertEqual(r['total']['totalTokens'],2200);self.assertEqual(r['turns'][-1]['totalTokens'],2200)
    def test_unknown_model_not_fabricated_and_cross_thread_rejected(self):
        self.write(self.path,row('turn_context',turn_id='turn',model='unknown-model'),native(),native(sid='other',rid='foreign'))
        r=self.get();self.assertFalse(r['total']['costComplete']);self.assertIsNone(r['total']['amount'])
        self.assertEqual(r['total']['totalTokens'],1100)
    def test_large_compaction_record_is_not_lost_usage(self):
        with self.path.open('a') as f:
            f.write(json.dumps({'timestamp':'2026-10-01T00:00:00Z','ordinal':4,'type':'compacted','payload':{'text':'x'*(m.MAX_LINE+10)}})+'\n')
        self.write(self.path,native());r=self.get()
        self.assertTrue(r['total']['costComplete']);self.assertEqual(r['warnings'],[])
    def test_no_implicit_latest_chat(self):
        self.data.mkdir(parents=True,exist_ok=True)
        (self.data/'config.json').write_text(json.dumps({'selected_thread':'main'}))
        with self.assertRaisesRegex(ValueError,'指定'):live.snapshot(None,self.home,self.data)
    def test_new_chat_waits_without_reusing_other_chat_or_creating_cache(self):
        self.write(self.path,native())
        r=live.snapshot('new-chat',self.home,self.data)
        self.assertEqual(r['threadId'],'new-chat')
        self.assertEqual(r['usageStatus'],'waiting')
        self.assertEqual(r['turns'],[])
        self.assertIsNone(r['total']['totalTokens'])
        self.assertIsNone(r['total']['amount'])
        self.assertFalse(self.data.exists())
    def test_new_chat_first_record_becomes_live_on_next_read(self):
        self.assertEqual(live.snapshot('new-chat',self.home,self.data)['usageStatus'],'waiting')
        p=self.folder/'rollout-test-new-chat.jsonl'
        self.write(p,row('session_meta',id='new-chat',model_provider='openai'),
                   row('turn_context',turn_id='turn',model='gpt-6.1-sol'),native(sid='new-chat'))
        r=live.snapshot('new-chat',self.home,self.data)
        self.assertEqual(r['total']['totalTokens'],1100)
        self.assertEqual(len(r['turns']),1)
    def test_indexed_chat_waits_for_rollout_but_rejects_outside_path(self):
        with sqlite3.connect(self.home/'state_5.sqlite') as db:
            db.execute('CREATE TABLE threads (id TEXT, rollout_path TEXT, name TEXT, title TEXT)')
            db.execute('INSERT INTO threads VALUES (?,?,?,?)',('new-chat',str(self.folder/'rollout-test-new-chat.jsonl'),'新对话','unused'))
            db.execute('INSERT INTO threads VALUES (?,?,?,?)',('outside',str(self.home/'outside.jsonl'),'outside','unused'))
        self.assertEqual(live.snapshot('new-chat',self.home,self.data)['usageStatus'],'waiting')
        with self.assertRaisesRegex(ValueError,'路径'):live.snapshot('outside',self.home,self.data)
    def test_ambiguous_rollouts_are_not_hidden_as_waiting(self):
        self.write(self.folder/'rollout-copy-main.jsonl',row('session_meta',id='main'))
        with self.assertRaisesRegex(ValueError,'多个'):self.get()

if __name__=='__main__':unittest.main()
