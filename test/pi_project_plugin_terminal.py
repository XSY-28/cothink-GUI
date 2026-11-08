"""Actual clean PROJECT PTY startup, with an installed host-import marker. No model calls."""
import errno, fcntl, json, os, pty, select, shutil, signal, struct, subprocess, tempfile, termios, time, sys
from pathlib import Path
from helpers.team_fixture import team_config

ROOT=Path(__file__).resolve().parents[1]
CLI=Path(os.environ.get('COTHINK_TEST_CLI',str(ROOT/'bin/cothink.js')))
unknown=os.environ.get('COTHINK_TEST_LEGACY_UNKNOWN')=='1'
with tempfile.TemporaryDirectory(prefix='cothink-project-clean-') as folder:
    home=Path(folder); (home/'pi').mkdir(); repo=home/'repo'; repo.mkdir(); (repo/'a.txt').write_text('original')
    def git(*args):
        return subprocess.run(['git','-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','-c','user.name=fixture','-c','user.email=fixture@invalid',*args],cwd=repo,capture_output=True,check=True)
    git('init','-b','main');git('status','--porcelain');git('add','--','a.txt');git('commit','-m','temporary test source')
    marker=home/'host-imported';extension=home/'extension.mjs'
    extension.write_text(("import {spawn} from 'node:child_process';spawn('/usr/bin/true',[],{detached:true,stdio:'ignore'}).unref();" if unknown else '')+"import fs from 'node:fs';fs.writeFileSync("+json.dumps(str(marker))+",'UNSAFE_HOST_IMPORT');export default ()=>{};")
    config={'formatVersion':2,'main':{'provider':'fixture','modelId':'main'},'secondary':[{'provider':'fixture','modelId':'review'}],'piResources':{'extensions':[str(extension)]}}
    (home/'config.json').write_text(json.dumps(team_config(config)))
    (home/'pi/models.json').write_text(json.dumps({'providers':{'fixture':{'api':'openai-completions','baseUrl':'http://127.0.0.1:9/v1','apiKey':'fixture-only','models':[{'id':name,'name':name,'reasoning':False,'input':['text'],'cost':{'input':0,'output':0,'cacheRead':0,'cacheWrite':0},'contextWindow':32000,'maxTokens':4096} for name in ['main','review']]}}}))
    master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',30,110,0,0))
    env={**os.environ,'COTHINK_HOME':str(home),'PI_OFFLINE':'1','COTHINK_NO_UPDATE_CHECK':'1','TERM':'xterm-256color'}
    launch=[shutil.which('node'),str(CLI)]+([] if unknown else ['--project'])
    if os.environ.get('COTHINK_TEST_CONTROLLING_TTY')=='1':launch=['/usr/bin/script','-q','/dev/null',*launch]
    child=subprocess.Popen(launch,cwd=repo,stdin=slave,stdout=slave,stderr=slave,env=env,start_new_session=True)
    transcript=bytearray();deadline=time.monotonic()+18
    try:
        while ('COTHINK · 讨论' if unknown else 'PROJECT · 项目').encode() not in transcript:
            if time.monotonic()>deadline or child.poll() is not None: raise AssertionError(transcript.decode(errors='replace')[-4000:])
            if select.select([master],[],[],.05)[0]:
                try:transcript.extend(os.read(master,65536))
                except OSError as error:
                    if error.errno!=errno.EIO:raise
        if unknown:
            assert marker.exists()
            os.write(master,b'/project\r')
            while '迁移已阻塞'.encode() not in transcript:
                if time.monotonic()>deadline or child.poll() is not None:raise AssertionError(transcript.decode(errors='replace')[-4000:])
                if select.select([master],[],[],.05)[0]:transcript.extend(os.read(master,65536))
            records=[json.loads(p.read_text()) for p in (home/'pi/handoffs').glob('*.json')]
            assert len(records)==1 and records[0]['status']=='blocked'
            assert not any(e.get('data',{}).get('projectMode') for e in records[0]['entries'])
            assert not list((home/'requests').glob('*.json'))
            print('PASS detached native child permanently blocks migration; original mode/draft retained, zero requests')
        else:
            assert not marker.exists(), 'clean project startup imported native extension on host'
        assert not list((home/'requests').glob('*.json')), 'startup must not generate'
        if not unknown:print('PASS clean PROJECT PTY startup; no host extension import or model request')
    finally:
        if child.poll() is None:os.killpg(child.pid,signal.SIGTERM)
        try:child.wait(timeout=5)
        except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait()
        os.close(master);os.close(slave)

    if unknown:
        master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',30,110,0,0))
        again=subprocess.Popen([shutil.which('node'),str(CLI),'--project'],cwd=repo,stdin=slave,stdout=slave,stderr=slave,env=env,start_new_session=True)
        output=bytearray();limit=time.monotonic()+10
        try:
            while again.poll() is None:
                assert time.monotonic()<limit,'blocked predecessor recovery did not finish'
                if select.select([master],[],[],.05)[0]:
                    try:output.extend(os.read(master,65536))
                    except OSError as error:
                        if error.errno!=errno.EIO:raise
            assert again.returncode!=0
            assert '不能借新进程清除未知状态'.encode() in output,output.decode(errors='replace')
            print('PASS blocked predecessor also blocks a fresh --project process')
        finally:
            if again.poll() is None:os.killpg(again.pid,signal.SIGKILL);again.wait()
            os.close(master);os.close(slave)

if not unknown and sys.platform=='darwin':
    subprocess.run([sys.executable,__file__],env={**os.environ,'COTHINK_TEST_LEGACY_UNKNOWN':'1','COTHINK_TEST_CONTROLLING_TTY':'1'},check=True)
