"""Isolated Team roster fixtures and real CLI branch restoration checks."""
TEAM_ID = '7c8094cd-3476-4bfa-8f53-055d87972896'

def team_config(config, name='测试队伍'):
    if config.get('formatVersion') == 3:
        return config
    result = dict(config)
    main = result.pop('main')
    secondary = result.pop('secondary')
    result.update(formatVersion=3, lastUsedTeamId=TEAM_ID,
                  teams=[dict(id=TEAM_ID, name=name, main=main, secondary=secondary)])
    return result


def check_branch_restoration(Session, seed, seed_conversation, calls, checks, ROOT, CLI):
    import json, subprocess, tempfile, time
    from pathlib import Path

    # Native clone and fork use the branch origin rather than the latest global selection.
    with tempfile.TemporaryDirectory(prefix='cothink-team-branches-') as folder:
        home=Path(folder);seed(home);seed_conversation(home);s=Session(home,('-c',))
        try:
            s.command('/team','选择 team');s.pick(0,'选择 team（下一条生效）');s.pick(1,'从下一条任务生效')
            s.command('/clone','Cloned to new session');s.command('/team','Team · B');s.send('\x1b');time.sleep(.1);s.pump()
            s.command('/fork','Fork from Message');s.pick(0,'Forked to new session')
            # There is one original user message, so forking before it must recover A.
            s.command('/team','Team · A');s.send('\x1b');time.sleep(.1);s.pump()
            s.send('\x15/one branch-origin\r')
            s.wait(lambda:any(json.loads(p.read_text())['status']=='completed' for p in (home/'tasks').glob('*.json')))
            task=next(json.loads(p.read_text()) for p in (home/'tasks').glob('*.json'))
            assert task['team']['id']==TEAM_ID and calls[-1]['model']=='main'
            before_calls=len(calls)
            s.command('/team','选择 team');s.pick(0,'选择 team（下一条生效）');s.pick(1,'从下一条任务生效')
            s.command('/tree','Session Tree');s.send('branch-origin');s.pick(0,'Summarize branch?');s.pick(0,'Navigated to selected point')
            s.command('/team','Team · A');s.send('\x1b');time.sleep(.1);s.pump()
            assert len(calls)==before_calls, 'tree navigation without summary generated a request'
        finally:s.stop()
        checks.append('native clone keeps current team; fork and tree restore their ancestry without generation')

    # GUI thinking records can precede the unified-flow marker in an old CLI session.
    with tempfile.TemporaryDirectory(prefix='cothink-team-thinking-') as folder:
        home=Path(folder);seed(home)
        catalog=json.loads((home/'pi/models.json').read_text())
        for model in catalog['providers']['fixture']['models']:model['reasoning']=True
        (home/'pi/models.json').write_text(json.dumps(catalog))
        config=json.loads((home/'config.json').read_text())
        config['teams'][0]['main']['thinkingLevel']='high';config['teams'][0]['secondary'][0]['thinkingLevel']='medium'
        (home/'config.json').write_text(json.dumps(config));path=seed_conversation(home)
        module=(CLI.parent.parent/'node_modules/@earendil-works/pi-coding-agent/dist/index.js').as_uri()
        script='import {SessionManager} from '+json.dumps(module)+';const sm=SessionManager.open(process.argv[1]);sm.appendCustomEntry("cothink-thinking",JSON.parse(process.argv[2]));'
        def save_thinking(value):
            result=subprocess.run(['node','--input-type=module','-e',script,str(path),json.dumps(value)],cwd=ROOT,text=True,capture_output=True)
            assert result.returncode==0,result.stderr
        save_thinking(dict(level='low'))
        def ask_scoped(s,text,expected):
            before=len(calls);s.send('\x15'+text+'\r')
            s.wait(lambda:len(calls)>=before+3)
            s.wait(lambda:any(json.loads(p.read_text()).get('input')==text and json.loads(p.read_text())['status']=='completed' for p in (home/'tasks').glob('*.json')))
            actual=[call.get('reasoning_effort') for call in calls[before:]]
            assert actual==expected,(text,actual,expected)
        s=Session(home,('-c',))
        try:ask_scoped(s,'legacy-scope-anchor',['low','medium','low'])
        finally:s.stop()
        save_thinking(dict(level='low',scope='all'))
        s=Session(home,('-c',))
        try:
            ask_scoped(s,'all-scope-request',['low','low','low'])
            before=len(calls)
            s.command('/tree','Session Tree');s.send('legacy-scope-anchor');s.pick(0,'Summarize branch?');s.pick(0,'Navigated to selected point')
            assert len(calls)==before,'scope restoration does not generate'
            ask_scoped(s,'restored-legacy-scope',['low','medium','low'])
        finally:s.stop()
        checks.append('CLI create and native tree preserve legacy main/all thinking scopes and actual per-role requests')
