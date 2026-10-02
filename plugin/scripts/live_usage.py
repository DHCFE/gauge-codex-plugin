"""Read local Codex telemetry. No hooks, prompts, network, or message extraction."""
import json
import os
from pathlib import Path
import sqlite3
import sys
import time
from contextlib import closing
import cost_meter as meter
import agent_usage as agents

ROOT = Path(os.environ.get('TOKENLENS_ROOT', Path(__file__).resolve().parents[1]))

def view(item, key, title, status=None):
    item = item or {}
    u = item.get('usage')
    parts = item.get('cost_breakdown') or {}
    known = lambda k: float(parts.get(k, {}).get('known_usd', 0))
    return {'id': key, 'title': title, 'input': u['input_tokens']-u['cached_input_tokens']-u['cache_write_input_tokens'] if u else 0,
            'cached': u['cached_input_tokens']+u['cache_write_input_tokens'] if u else 0,
            'cacheRead': u['cached_input_tokens'] if u else 0, 'cacheWrite': u['cache_write_input_tokens'] if u else 0,
            'output': u['output_tokens'] if u else 0, 'reasoning': u['reasoning_output_tokens'] if u else 0,
            'totalTokens': u['total_tokens'] if u else 0, 'pending': u is None,
            'usd': [known('input'), known('cached_input')+known('cache_write'), known('output')],
            'amount': float(item['usd']) if item.get('usd') is not None else None,
            'costComplete': item.get('cost_complete',False),
            'model': ' / '.join(item.get('models',[])) or '未记录模型',
            'status': status or item.get('status','observed'), 'source': item.get('source'),
            'warnings': item.get('warnings',[])}

def query_thread(home, sid):
    for path in sorted(home.glob('state_*.sqlite'),key=lambda p:int(p.stem.split('_')[-1]),reverse=True):
        try:
            with closing(sqlite3.connect(path.as_uri()+'?mode=ro',uri=True,timeout=0.5)) as db:
                row=db.execute('SELECT rollout_path, COALESCE(name, substr(title,1,100)) FROM threads WHERE id=?',(sid,)).fetchone()
            if row:return Path(row[0]),row[1] or sid[:12]
        except sqlite3.Error:continue
    paths=list((home/'sessions').glob(f'*/*/*/rollout-*-{sid}.jsonl'))+list((home/'archived_sessions').glob(f'rollout-*-{sid}.jsonl'))
    if not paths:return None,sid[:12]
    if len(paths)>1:raise ValueError('所选对话有多个本地记录，无法确定唯一来源。')
    return paths[0],sid[:12]

def waiting(sid,title):
    total=view(None,'total','对话累计')
    for key in ('input','cached','cacheRead','cacheWrite','output','reasoning','totalTokens'):
        total[key]=None
    return {'live':True,'usageStatus':'waiting','threadId':sid,'title':title,'turns':[],
            'total':total,'observedAt':int(time.time()*1000),'warnings':[]}

def snapshot(sid=None,home=None,data_dir=None):
    home=Path(home or os.environ.get('CODEX_HOME',Path.home()/'.codex')).resolve()
    data_dir=Path(data_dir or os.environ.get('TOKENLENS_DATA',home/'plugins/data/tokenlens-local/tokenlens-prototype'))
    if not sid:raise ValueError('请先指定要统计的对话；不会自动选择其他正在运行的聊天。')
    sid=meter.valid_id(sid)
    path,title=query_thread(home,sid)
    if path is None:return waiting(sid,title)
    path=path.resolve()
    if not any(path.is_relative_to((home/folder).resolve()) for folder in ('sessions','archived_sessions')):
        raise ValueError('记录路径不在 Codex 本地会话目录。')
    try:path.stat()
    except FileNotFoundError:return waiting(sid,title)
    data_dir.mkdir(parents=True,exist_ok=True,mode=0o700)
    prices=meter.Prices(ROOT/'data/prices.json')
    with closing(sqlite3.connect(data_dir/'panel.sqlite3',timeout=2)) as db,db:
        db.execute('CREATE TABLE IF NOT EXISTS states (id TEXT PRIMARY KEY,state TEXT NOT NULL)')
        row=db.execute('SELECT state FROM states WHERE id=?',(sid,)).fetchone()
        state=json.loads(row[0]) if row else meter.fresh()
        if state.get('panel_revision') != 3:state=meter.fresh()
        state=meter.scan(path,state,sid,budget_seconds=1.5)
        state['panel_revision']=3
        db.execute('INSERT OR REPLACE INTO states VALUES (?,?)',(sid,json.dumps(state,separators=(',',':'))))
    tid=state['current_turn'] or next(reversed(state['turns']),None)
    if not tid:
        return waiting(sid,title)
    report=meter.build_report(state,sid,tid,prices)
    try:
        report=agents.aggregate(report,{'transcript_path':str(path)},data_dir,prices,home)
    except (OSError,ValueError,sqlite3.Error) as exc:
        report['warnings'].append('子代理统计暂不可用：'+type(exc).__name__)
        report['subagents']={'discovery_complete':False,'thread_count':0}
    turns=[]
    for index,(key,t) in enumerate(state['turns'].items(),1):
        item=meter.summarize_turn(t,prices)
        child=report.get('per_turn_children',{}).get(key)
        if child and child.get('usage'):item=agents.merge([item,child])
        if key==tid and report.get('turn'):item=report['turn']
        turns.append(view(item,key,'第 '+str(index)+' 轮',t['status']))
    total=view(report['thread'],'total','对话累计')
    total['model']=' / '.join(sorted({model for t in state['turns'].values() for model in t['models']}))
    sub=report.get('subagents',{})
    return {'live':True,'threadId':sid,'title':title,'turns':turns,'total':total,'currentTurnId':tid,
            'observedAt':int(time.time()*1000),'pricing':report['pricing'],
            'subagents':{k:sub.get(k,0) for k in ('thread_count','current_thread_count','active_thread_count','unattributed_tokens')},
            'scanPending':bool(state.get('pending_tail') or state.get('scan_limited')),
            'warnings':report['warnings'],'source':'Codex local token_usage_record; cumulative delta fallback'}

if __name__=='__main__':
    os.umask(0o077)
    try:
        request=json.loads(sys.stdin.read() or '{}')
        print(json.dumps(snapshot(request.get('thread_id')),ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({'error':str(exc) if isinstance(exc,(ValueError,meter.MeterError)) else type(exc).__name__},ensure_ascii=False))
        sys.exit(1)
