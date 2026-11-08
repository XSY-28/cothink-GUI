"""Real PROJECT terminal plan/confirmation, original native helper and public acceptance; localhost only."""
import errno,fcntl,json,os,pty,select,shutil,signal,struct,subprocess,tempfile,termios,threading,time,re,sys
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from helpers.team_fixture import team_config

ROOT=Path(__file__).resolve().parents[1];CLI=Path(os.environ.get('COTHINK_TEST_CLI',str(ROOT/'bin/cothink.js')))
runtime=os.environ.get('COTHINK_TEST_PLUGIN_RUNTIME');native=os.environ.get('COTHINK_TEST_NATIVE_HOME')
assert runtime and native,'Prepare the Linux runtime and original pi-subagents fixture; set COTHINK_TEST_PLUGIN_RUNTIME and COTHINK_TEST_NATIVE_HOME'
legacy=os.environ.get('COTHINK_TEST_LEGACY_HANDOFF')=='1'
calls=[];counts={'history':0,'plan':0,'root':0,'helper':0};errors=[];helper_id=None;dialog_source=None
check={'command':'node','args':['-e',"if(require('fs').readFileSync('a.txt','utf8')!=='TERMINAL_NATIVE')process.exit(1)"]}
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  global helper_id
  body=json.loads(self.rfile.read(int(self.headers['Content-Length'])));calls.append(body);action=None;text=''
  try:
   system=str(next((m.get('content','') for m in body['messages'] if m['role']=='system'),''))
   last=next((m.get('content','') for m in reversed(body['messages']) if m['role']=='tool'),'')
   if legacy and any(m.get('role')=='user' and 'LEGACY_HISTORY' in str(m.get('content')) for m in body['messages']) and 'Draft a CoThink project plan.' not in json.dumps(body['messages']):
    counts['history']+=1;text='LEGACY_HISTORY_REPLY'
   elif 'Draft a CoThink project plan.' in json.dumps(body['messages']):
    counts['plan']+=1;text=json.dumps({'scope':['a.txt'],'plugins':([dialog_source] if legacy else ['pi-subagents',dialog_source]),'deliverables':['a.txt'],'checks':[check],'budget':{'maxCalls':14}})
   elif 'You are helper ' in system:
    counts['helper']+=1
    if counts['helper']==1:action=('write',{'path':'a.txt','content':'TERMINAL_NATIVE'})
    else:text='Native terminal helper wrote the approved file.'
   else:
    counts['root']+=1;n=counts['root']
    if n==1:action=('next_change',{'reason':'Use original native helper for the approved file','scope':['a.txt'],'readScope':['a.txt']})
    elif n==2:action=('project_plugin_'+('0' if legacy else '1')+'_dialog',{})
    elif legacy and n==3:assert re.search(r'CHOSEN.*ENTERED.*true',last),last;action=('read',{'path':'a.txt'})
    elif legacy and n==4:action=('write',{'path':'a.txt','content':'TERMINAL_NATIVE'})
    elif legacy and n==5:action=('prepare_change',{})
    elif legacy and n in [6,7]:action=('accept_change',{})
    elif legacy:assert json.loads(last).get('status')=='accepted',last;text='TERMINAL_NATIVE_DELIVERED'
    elif n==3:
     assert re.search(r'CHOSEN.*ENTERED.*true',last),last;action=('project_plugin_0_subagent',{'agent':'native-terminal','model':'fixture/main','task':'Write a.txt=TERMINAL_NATIVE','async':False,'artifacts':False})
    elif n==4:
     found=re.search(r'"helperId":"([a-f0-9-]+)"',last);assert found,last;helper_id=found.group(1);action=('cothink_helper_result',{'helperId':helper_id,'decision':'inspect'})
    elif n==5:action=('cothink_helper_result',{'helperId':helper_id,'decision':'adopt','reason':'Reviewed original and new file bytes from the stopped original helper'})
    elif n==6:action=('prepare_change',{})
    elif n in [7,8]:action=('accept_change',{})
    else:assert json.loads(last)['status']=='accepted',last;text='TERMINAL_NATIVE_DELIVERED'
  except Exception as error:errors.append(str(error));text='Fixture failure; preserve result.'
  try:
   self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
   delta={'role':'assistant','tool_calls':[{'index':0,'id':'terminal-'+str(len(calls)),'type':'function','function':{'name':action[0],'arguments':json.dumps(action[1])}}]} if action else {'role':'assistant','content':text}
   for value,finish in [(delta,None),({},'tool_calls' if action else 'stop')]:self.wfile.write(('data: '+json.dumps({'id':'fixture','choices':[{'index':0,'delta':value,'finish_reason':finish}],'usage':{'prompt_tokens':12,'completion_tokens':5,'total_tokens':17}})+'\n\n').encode());self.wfile.flush()
   self.wfile.write(b'data: [DONE]\n\n');self.wfile.flush()
  except (BrokenPipeError,ConnectionResetError):pass

server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
try:
 with tempfile.TemporaryDirectory(prefix='cothink-project-native-pty-') as folder:
  home=Path(folder);(home/'pi').mkdir();repo=home/'repo';repo.mkdir();(repo/'a.txt').write_text('original')
  def git(*args):return subprocess.run(['git','-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','-c','user.name=fixture','-c','user.email=fixture@invalid',*args],cwd=repo,capture_output=True,check=True)
  git('init','-b','main');git('status','--porcelain');git('add','--','a.txt');git('commit','-m','temporary test input')
  if not legacy:shutil.copytree(Path(native)/'npm',home/'pi/npm');shutil.copy2(Path(native)/'settings.json',home/'pi/settings.json')
  (home/'pi/agents').mkdir();(home/'pi/agents/native-terminal.md').write_text('---\nname: native-terminal\ndescription: Original native terminal fixture\nmodel: fixture/main\ntools: read, write, edit, ls, bash\ninheritProjectContext: false\ninheritGlobalContext: false\ninheritSkills: false\n---\nPerform the approved file task.\n')
  execution=json.loads((ROOT/'packages/agent-sync/execution-manifest.json').read_text())['execution']
  config={'formatVersion':2,'main':{'provider':'fixture','modelId':'main'},'secondary':[{'provider':'fixture','modelId':'review'}],'work':{'execution':execution,'projectPluginRuntime':runtime}}
  if legacy:
   timer=home/'legacy-timer.mjs';marker=home/'legacy-timer.json'
   timer.write_text("import fs from 'node:fs';let tick=0;setInterval(()=>fs.writeFileSync("+json.dumps(str(marker))+",JSON.stringify({pid:process.pid,tick:++tick})),25).unref();export default ()=>{};")
   config['piResources']={'extensions':[str(timer)]}
  (home/'config.json').write_text(json.dumps(team_config(config)));(home/'pi/models.json').write_text(json.dumps({'providers':{'fixture':{'api':'openai-completions','baseUrl':f'http://127.0.0.1:{server.server_port}/v1','apiKey':'fixture-only','models':[{'id':m,'name':m,'reasoning':False,'input':['text'],'cost':{'input':1,'output':1,'cacheRead':0,'cacheWrite':0},'contextWindow':32000,'maxTokens':4096} for m in ['main','review']]}}}))
  dialog=home/'dialog';dialog.mkdir();(dialog/'package.json').write_text(json.dumps({'name':'project-dialog','version':'1.0.0','type':'module','pi':{'extensions':['extension.mjs']}}))
  (dialog/'extension.mjs').write_text("export default pi=>pi.registerTool({name:'dialog',label:'dialog',description:'Local options',parameters:{type:'object',properties:{}},execute:async(id,args,signal,update,ctx)=>{const selected=await ctx.ui.select('PROJECT_SELECT',['CHOSEN']);const input=await ctx.ui.input('PROJECT_INPUT');const confirmed=await ctx.ui.confirm('PROJECT_CONFIRM','Use the selected local options?');await ctx.ui.notify('PROJECT_NOTIFY','info');return {content:[{type:'text',text:JSON.stringify({selected,input,confirmed})}]};}});")
  installed=subprocess.run([shutil.which('node'),str(CLI),'install',str(dialog),'--json'],cwd=repo,env={**os.environ,'COTHINK_HOME':str(home),'PI_OFFLINE':'1'},capture_output=True,text=True,check=True)
  dialog_source=next(p['source'] for p in json.loads(installed.stdout)['packages'] if p['name']=='project-dialog')
  if legacy:
   history=subprocess.run([shutil.which('node'),str(CLI),'ask','--one','--json','LEGACY_HISTORY'],cwd=repo,env={**os.environ,'COTHINK_HOME':str(home),'PI_OFFLINE':'1'},capture_output=True,text=True,check=True)
   assert counts['history']==1,history.stderr
   prior_sessions=list((home/'pi/sessions/main').glob('*.jsonl'));assert len(prior_sessions)==1
   history_bytes=prior_sessions[0].read_bytes()
   assert b'LEGACY_HISTORY_REPLY' in history_bytes
  master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',35,120,0,0))
  launch=[shutil.which('node'),str(CLI)]+(['-c'] if legacy else ['--project'])
  if os.environ.get('COTHINK_TEST_CONTROLLING_TTY')=='1':launch=['/usr/bin/script','-q','/dev/null',*launch]
  child=subprocess.Popen(launch,cwd=repo,stdin=slave,stdout=slave,stderr=slave,env={**os.environ,'COTHINK_HOME':str(home),'PI_OFFLINE':'1','COTHINK_NO_UPDATE_CHECK':'1','TERM':'xterm-256color'},start_new_session=True)
  transcript=bytearray();deadline=time.monotonic()+120
  def pump():
   if time.monotonic()>deadline or child.poll() is not None or b'Error: ' in transcript:raise AssertionError(transcript.decode(errors='replace')[-6000:])
   if select.select([master],[],[],.05)[0]:
    try:transcript.extend(os.read(master,65536))
    except OSError as error:
     if error.errno!=errno.EIO:raise
  def wait(condition):
   while not condition():pump()
  def send(value):os.write(master,value.encode());pump()
  def records():
   values=[]
   for file in (home/'tasks').glob('*.json'):
    try:values.append(json.loads(file.read_text()))
    except json.JSONDecodeError:pass
   return values
  try:
   if legacy:
    wait(lambda:marker.exists() and 'COTHINK · 讨论'.encode() in transcript)
    old=json.loads(marker.read_text());before=len(transcript);send('/one\r');wait(lambda:'模式：ONE'.encode() in transcript[before:]);send('PRESERVED_LEGACY_DRAFT');wait(lambda:b'PRESERVED_LEGACY_DRAFT' in transcript[before:]);send('\x1bm')
    wait(lambda:'旧宿主已可信退出'.encode() in transcript and 'PROJECT · 项目'.encode() in transcript)
    wait(lambda:b'PRESERVED_LEGACY_DRAFT' in transcript)
    try:os.kill(old['pid'],0);raise AssertionError('old native shell is still alive')
    except ProcessLookupError:pass
    final_tick=marker.read_bytes();time.sleep(.12);assert marker.read_bytes()==final_tick,'old timer continued after handoff'
    handoffs=[json.loads(p.read_text()) for p in (home/'pi/handoffs').glob('*.json')]
    assert len(handoffs)==1 and handoffs[0]['status']=='stopped',handoffs
    saved=handoffs[0];session=Path(saved['sessionFile']);entries=[json.loads(line) for line in session.read_text().splitlines()]
    assert entries[0]['id']==saved['sessionId'];assert session.read_bytes().startswith(history_bytes);assert any(e.get('customType')=='cothink-team' for e in entries)
    assert any(e.get('customType')=='cothink-draft' and e['data']['text']=='PRESERVED_LEGACY_DRAFT' for e in entries),[(e.get('customType'),e.get('data')) for e in entries if e.get('customType')=='cothink-draft']
    send('\x15')
   else:wait(lambda:'PROJECT · 项目'.encode() in transcript)
   send('/project\r');send('Use installed pi-subagents and project-dialog to choose local options and write a.txt=TERMINAL_NATIVE through a native helper.\r')
   wait(lambda:'待确认的项目计划'.encode() in transcript);assert counts['plan']==1 and counts['root']==0 and counts['helper']==0
   back=len(transcript);send('\x1b');wait(lambda:'模式：PROJECT'.encode() in transcript[back:]);send('开始\r')
   wait(lambda:b'PROJECT_SELECT' in transcript);send('\r')
   wait(lambda:b'PROJECT_INPUT' in transcript);send('ENTERED\r')
   wait(lambda:b'PROJECT_CONFIRM' in transcript);send('\r')
   wait(lambda:any(r.get('project') and r.get('status') in ['completed','partial','failed','outcome_unknown'] for r in records()))
   task=next(r for r in records() if r.get('project'));assert not errors,errors;assert task['status']=='completed',task.get('error')
   assert counts['helper']==(0 if legacy else 2) and counts['plan']==1,counts
   assert task['usage']['calls']==counts['root']+counts['helper']
   if not legacy:assert task['work']['helpers'][0]['treatment']['decision']=='adopted'
   assert b'PROJECT_NOTIFY' in transcript
   assert (Path(task['work']['resultWorkspace'])/'a.txt').read_text()=='TERMINAL_NATIVE';assert (repo/'a.txt').read_text()=='original'
   print(json.dumps({'passed':('legacy timer -> trusted handoff -> draft/history/team restored -> ' if legacy else 'clean terminal ')+ ('/project -> plan -> start -> core write -> public acceptance' if legacy else '/project -> plan -> start -> original helper -> public acceptance'),'calls':counts,'projectCalls':task['usage']['calls']}))
  finally:
   if child.poll() is None:os.killpg(child.pid,signal.SIGTERM)
   try:child.wait(timeout=8)
   except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait()
   os.close(master);os.close(slave)
finally:server.shutdown();server.server_close()

if not legacy and sys.platform=='darwin':
 subprocess.run([sys.executable,__file__],env={**os.environ,'COTHINK_TEST_LEGACY_HANDOFF':'1','COTHINK_TEST_CONTROLLING_TTY':'1'},check=True)
