import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, existsSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,join} from 'node:path';
import {fork,spawnSync} from 'node:child_process';
import {EventEmitter, once} from 'node:events';
import {runInNewContext} from 'node:vm';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {createGuiController} from '../src/gui-controller.js';
import {startGuiServer} from '../src/gui-server.js';
import {GUI_INPUT_VERSION} from '../src/gui-turn-options.js';
import {fixtureConversation,prepareSubmit} from './helpers/gui-controller-fixture.js';

function home(t) { const p=mkdtempSync(join(tmpdir(),'cothink-desktop-test-'));t.after(()=>rmSync(p,{recursive:true,force:true}));return p; }
test('desktop shutdown freezes writes but keeps authenticated history and draft persistence until final close', async t=>{
 const controller=await createGuiController({home:home(t),suggestedProject:null,installation:'desktop'});
 const h=await startGuiServer({controller,open:false});t.after(()=>h.close());
 const headers={Authorization:`Bearer ${h.token}`,'Content-Type':'application/json', "X-CoThink-GUI-Input":GUI_INPUT_VERSION};
 const origin=new URL(h.url).origin;
 const read=()=>fetch(origin+'/api/bootstrap',{headers});
 const action=(action,args={})=>fetch(origin+'/api/action',{method:'POST',headers,body:JSON.stringify({action,args})});
 const api={action:async(name,args)=>{const r=await action(name,args);assert.equal(r.status,200,await r.clone().text());return r.json();}};
 const s=await fixtureConversation(t,api,{defaultRosterId:null});
 const submit=await prepareSubmit(controller,{sessionId:s.id,input:'must not send',protocolVersion:1,submissionId:randomUUID()});
 const boot=await (await read()).json();
 assert.equal(boot.suggestedProject,null);
 assert.equal(boot.installation,'desktop');
 assert.equal(boot.updates.channel,'desktop-local');
 assert.equal(typeof h.beginShutdown,'function');
 assert.equal((await h.beginShutdown()).settled,true);
 assert.equal((await read()).status,200);
 const stopped=await action('task.submit',submit);
 assert.equal(stopped.status,409);
 assert.equal((await stopped.json()).code,'HOST_SHUTTING_DOWN');
 const current=await controller.session(s.id);
 const saved=await action('session.draft',{...current.editor,sessionId:s.id,text:'keep on close',expectedDraftRevision:current.draftRevision,branchAnchor:current.branchAnchor,editId:randomUUID()});
 assert.equal(saved.status,200,await saved.clone().text());
 await h.close();assert.equal(h.server.listening,false);
});

test('failed drain leaves HTTP and SSE available and close does not misreport success',async t=>{
 let allow=false,closed=false;
 const controller={subscribe:()=>()=>{},bootstrap:async()=>({readable:true}),
  beginShutdown:async()=>({settled:allow,reason:allow?null:'stop_unknown',taskRefs:['owned-task']}),
  shutdownState:()=>({settled:allow,reason:allow?null:'stop_unknown',taskRefs:['owned-task']}),
  close:async()=>{assert.equal(allow,true);closed=true;}};
 const h=await startGuiServer({controller,open:false});t.after(async()=>{allow=true;await h.close();});
 const headers={Authorization:`Bearer ${h.token}`},origin=new URL(h.url).origin;
 await assert.rejects(h.close(),/停止|settle|shutdown|stop_unknown/i);
 assert.equal(closed,false);assert.equal(h.server.listening,true);
 assert.equal((await fetch(origin+'/api/bootstrap',{headers})).status,200);
 const abort=new AbortController();const r=await fetch(origin+'/api/events',{headers,signal:abort.signal});
 assert.equal(r.status,200);abort.abort();
 allow=true;await h.close();assert.equal(closed,true);
});

async function childHost(t,extra={}) {
 const path=new URL('../desktop/host.mjs',import.meta.url);assert.equal(existsSync(path),true,'desktop host exists');
 const nonce=randomUUID();const child=fork(path,[],{env:{...process.env,PI_OFFLINE:'1',COTHINK_HOME:home(t),COTHINK_DESKTOP_NONCE:nonce,...extra},silent:true,execArgv:[]});
 const messages=[],waiters=[];let output='';
 child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);
 child.on('message',m=>{messages.push(m);for(const f of [...waiters])f();});
 const exited=once(child,'exit');t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
 const next=type=>new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{waiters.splice(waiters.indexOf(check),1);reject(Error('No '+type+'; '+output));},15000);
  function check(){const m=messages.find(m=>m.type===type);if(m){clearTimeout(timer);waiters.splice(waiters.indexOf(check),1);resolve(m);}}
  waiters.push(check);check();
 });
 return {child,next,nonce,exited,output:()=>output};
}
test('real Node child ready handshake is private, authenticated, and shuts down by request ID',async t=>{
 const f=await childHost(t);const ready=await f.next('ready');
 assert.equal(ready.nonce,f.nonce);assert.equal(ready.protocolVersion,1);assert.match(ready.origin,/^http:\/\/127\.0\.0\.1:\d+$/);
 assert.equal((await fetch(ready.origin+'/api/bootstrap')).status,403);
 const response=await fetch(ready.origin+'/api/bootstrap',{headers:{Authorization:`Bearer ${ready.token}`}});
 assert.equal(response.status,200);assert.equal((await response.json()).suggestedProject,null);
 const requestId=randomUUID();f.child.send({type:'prepareShutdown',requestId});
 const stopped=await f.next('stopped');assert.equal(stopped.requestId,requestId);assert.equal(stopped.settled,true);
 assert.equal((await f.exited)[0],0);assert.doesNotMatch(f.output(),new RegExp(ready.token));
 await assert.rejects(fetch(ready.origin));
});
test('parent IPC loss stops the real child without an automatic restart',async t=>{
 const f=await childHost(t);const ready=await f.next('ready');f.child.disconnect();
 assert.equal((await f.exited)[0],0);await assert.rejects(fetch(ready.origin));
});
test('preloaded Node injection is refused before backend import',async t=>{
 const f=await childHost(t,{NODE_OPTIONS:'--no-warnings'});const failure=await f.next('startupError');
 assert.equal(failure.code,'UNTRUSTED_STARTUP');assert.equal((await f.exited)[0],1);
});

test('close draft collection includes unselected edits and excludes acknowledged snapshots',async()=>{
 const {createDraftBook}=await import('../gui/src/view.js');const book=createDraftBook();
 book.load('first','',0,null);book.load('second','',0,null);
 book.edit('first','unsaved first');book.edit('second','saved second');
 const second=book.snapshot('second');book.confirmed(second,{editor:{editId:second.editId},draftRevision:1,branchAnchor:null});
 assert.equal(typeof book.pending,'function');
 assert.deepEqual(book.pending().map(s=>s.sessionId),['first']);
 const first=book.snapshot('first');book.edit('first','newer while saving');
 book.confirmed(first,{editor:{editId:first.editId},draftRevision:1,branchAnchor:null});
 assert.equal(book.pending()[0].text,'newer while saving');
});

test('IPC parent loss cancels an in-flight real HTTP fixture request and persists its original task identity',async t=>{
 const {fixture}=await import('./helpers/pi-fixture.js');
 const {saveConfig}=await import('../src/config.js');const {createTeamConfig}=await import('../src/teams.js');
 const {readTask}=await import('../src/task.js');
 const model=await fixture(t,async()=>{await new Promise(resolve=>setTimeout(resolve,800));return {text:'late fixture'};});
 const defaultRosterId=randomUUID();
 saveConfig(model.home,createTeamConfig({formatVersion:2,...model.models},'Fixture',defaultRosterId));
 const f=await childHost(t,{COTHINK_HOME:model.home});const ready=await f.next('ready');
 const action=async(action,args)=>{const r=await fetch(ready.origin+'/api/action',{method:'POST',headers:{Authorization:`Bearer ${ready.token}`,'Content-Type':'application/json', "X-CoThink-GUI-Input":GUI_INPUT_VERSION},body:JSON.stringify({action,args})});assert.equal(r.status,200,await r.clone().text());return r.json();};
 const session=await fixtureConversation(t,{action},{defaultRosterId});
 const input='local fixture only';
 const savedDraft=await action('session.draft',{sessionId:session.id,text:input,expectedDraftRevision:session.draftRevision,branchAnchor:session.branchAnchor,workRequest:null,selectionId:null,editId:randomUUID()});
 const submitted=await action('task.submit',{sessionId:session.id,input,protocolVersion:1,submissionId:randomUUID(),editorEditId:savedDraft.editor.editId});
 for(let n=0;n<500&&!model.calls.length;n++)await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(model.calls.length,1);f.child.disconnect();
 assert.equal((await f.exited)[0],0);
 const saved=readTask(model.home,submitted.taskId);assert.equal(saved.id,submitted.taskId);
 assert.ok(saved.cancelRequestedAt);assert.ok(saved.cancelSettledAt);assert.notEqual(saved.status,'completed');
 assert.equal(model.calls.length,1);await assert.rejects(fetch(ready.origin));
});

const desktopMain = readFileSync(new URL('../desktop/main.cjs', import.meta.url), 'utf8');
const buildFixture = {backendVersion:'0.8.14-desktop.3', protocolVersion:1, buildId:'a'.repeat(64)};
const nativeRequire = createRequire(import.meta.url);

// Exercise the actual main-process event handlers with a controlled clock and
// host replies. This also verifies filesystem preferences without starting App.
async function desktopShell(profile, port = 32123, {env={},platform="darwin"}={}) {
 const state={host:[], renderer:[], dialogs:[], timers:new Set(), quit:0, handlers:new Map()};
 const origin='http://127.0.0.1:'+port;
 const app=new EventEmitter();
 app.setName=()=>{};
 app.getPath=key=>{assert.ok(['userData','home'].includes(key));return profile;};
 app.requestSingleInstanceLock=()=>true;
 app.whenReady=()=>Promise.resolve();
 app.quit=()=>{
  let prevented=false;
  app.emit('before-quit',{preventDefault(){prevented=true;}});
  if(!prevented)state.quit++;
 };
 const child=new EventEmitter();
 child.connected=true;
 child.send=message=>state.host.push(message);
 const ipcMain=new EventEmitter();
 ipcMain.handle=(name, fn)=>state.handlers.set(name,fn);
 class BrowserWindow extends EventEmitter {
  constructor(){
   super();
   const wc=this.webContents=new EventEmitter();
   state.wc=wc;
   wc.session={setPermissionRequestHandler(){},setPermissionCheckHandler(){}};
   wc.mainFrame={url:origin+'/'};
   wc.setWindowOpenHandler=()=>{};
   wc.send=(type,message)=>state.renderer.push({type,...message});
  }
  loadURL(){return Promise.resolve();}
  isDestroyed(){return false;}
  show(){this.emit('show');}
  restore(){}
  focus(){}
 }
 const electron={app,BrowserWindow,ipcMain,shell:{},clipboard:{},
  Menu:{setApplicationMenu(menu){state.menu=menu;},buildFromTemplate:menu=>menu},
  dialog:{showMessageBox(...args){state.dialogs.push(args.at(-1));return Promise.resolve({response:0});}},
 };
 const nonce=randomUUID();
 let firstUUID=true;
 runInNewContext(desktopMain,{
  require(name){
   if(name==='electron')return electron;
   if(name==='node:child_process')return {spawn:(executable,args,options)=>{state.spawn={executable,args,options};return child;}};
   if(name==='node:crypto')return {randomUUID:()=>{if(!firstUUID)return randomUUID();firstUUID=false;return nonce;}};
   if(name==='node:fs')return {...nativeRequire(name),readFileSync(path,...args){
    return basename(path)==='build.json' ? JSON.stringify(buildFixture) : readFileSync(path,...args);
   }};
   return nativeRequire(name);
  },
  __dirname:join(profile,'desktop-fixture'),
  process:{env,platform,resourcesPath:profile},URL,
  setTimeout(callback,delay){const timer={callback,delay};state.timers.add(timer);return timer;},
  clearTimeout(timer){state.timers.delete(timer);},
 });
 await new Promise(resolve=>setImmediate(resolve));
 return {app,child,ipcMain,state,nonce,ready(){
  child.emit('message',{type:'ready',nonce,origin:origin+'/',token:'x'.repeat(43),...buildFixture});
  state.wc.emit('did-finish-load');
 }, invoke(name,value,frame=state.wc.mainFrame){
  const handler=state.handlers.get(name);
  assert.equal(typeof handler,'function','missing desktop IPC '+name);
  return handler({sender:state.wc,senderFrame:frame},value);
 }};
}

test('desktop theme survives a new main process and port, with main-frame-only writes', async t=>{
 const profile=home(t);
 const first=await desktopShell(profile,32123);
 first.ready();
 assert.equal(await first.invoke('cothink:theme:read'),null);
 await first.invoke('cothink:theme:write','dark');
 assert.equal(await first.invoke('cothink:theme:read'),'dark');
 const next=await desktopShell(profile,32124);
 next.ready();
 assert.equal(await next.invoke('cothink:theme:read'),'dark');
 await assert.rejects(async()=>next.invoke('cothink:theme:write','light',{url:'http://127.0.0.1:32124/'}));
 await assert.rejects(async()=>next.invoke('cothink:theme:write','unknown'));
 assert.equal(await next.invoke('cothink:theme:read'),'dark');
});

test('desktop shows one accurate startup failure dialog and exposes the exact build in About',async t=>{
 const f=await desktopShell(home(t));
 f.child.emit('message',{type:'startupError',nonce:f.nonce,code:'HOST_START_FAILED'});
 f.child.emit('exit',1,null);
 assert.equal(f.state.dialogs.length,1);
 assert.match(f.state.dialogs[0].message,/启动失败/);
 assert.doesNotMatch(f.state.dialogs[0].message,/已加载内容/);
 const about=f.state.menu[0].submenu.find(item=>item.label==='关于 CoThink');
 await about.click();
 assert.ok(f.state.dialogs.at(-1).detail.includes(buildFixture.buildId));
});

test('desktop final quit timeout allows rechecking the same stop without unlocking the saved editor',async t=>{
 const f=await desktopShell(home(t));
 f.ready();
 f.app.quit();
 const drain=f.state.host[0];
 f.child.emit('message',{type:'shutdownState',requestId:drain.requestId,settled:true});
 const flush=f.state.renderer.at(-1);
 assert.equal(flush.phase,'prepare');
 f.ipcMain.emit('cothink:close-ack',{sender:f.state.wc,senderFrame:f.state.wc.mainFrame},
  {requestId:flush.requestId,saved:true});
 const final=f.state.host.at(-1);
 assert.equal(final.finalize,true);
 f.child.emit('message',{type:'shutdownState',requestId:final.requestId,settled:false,reason:'正在停止所属任务并保存。'});
 f.app.quit();
 assert.equal(f.state.host.length,2,'another Quit waits while the acknowledgement timer is active');
 const timer=[...f.state.timers][0];
 assert.ok(timer?.delay>0,'final acknowledgement needs its own bounded wait');
 f.state.timers.delete(timer);
 timer.callback();
 assert.match(f.state.dialogs.at(-1).message,/尚未确认/);
 assert.equal(f.state.quit,0);
 f.app.emit('activate');
 f.app.emit('second-instance');
 assert.ok(!f.state.renderer.some(message=>message.phase==='resume'));
 f.app.quit();
 assert.equal(f.state.host.length,3);
 assert.equal(f.state.host.at(-1).requestId,final.requestId);
 assert.equal(f.state.host.at(-1).finalize,true);
 f.child.emit('message',{type:'stopped',requestId:final.requestId,settled:true});
 assert.equal(f.state.timers.size,0);
 assert.equal(f.state.quit,1);
});


test('desktop backend appends standard macOS tool directories without changing inherited precedence or process env',async t=>{
 const profile=home(t),env={PATH:'/custom/approved/bin:/usr/bin:/bin',KEEP_FIXTURE:'retained'};
 const f=await desktopShell(profile,32123,{env});
 assert.ok(f.state.spawn,'normal desktop startup must spawn the backend');
 assert.equal(f.state.spawn.options.env.PATH,[
  '/custom/approved/bin','/usr/bin','/bin',join(profile,'.docker/bin'),
  '/usr/local/bin','/opt/homebrew/bin','/Applications/Docker.app/Contents/Resources/bin',
 ].join(':'));
 assert.equal(f.state.spawn.options.env.KEEP_FIXTURE,'retained');
 assert.deepEqual(env,{PATH:'/custom/approved/bin:/usr/bin:/bin',KEEP_FIXTURE:'retained'});
 for(const inherited of [{},{PATH:''}]){
  const original={...inherited},clean=await desktopShell(profile,32125,{env:inherited});
  const backendEnv=clean.state.spawn.options.env;
  assert.ok(backendEnv.PATH.startsWith('/usr/bin:/bin:/usr/sbin:/sbin:'),'missing or empty PATH must preserve system tools');
  if(process.platform==='darwin'){
   const systemTool=spawnSync('true',[],{env:backendEnv});
   assert.equal(systemTool.error,undefined);
   assert.equal(systemTool.status,0,'a real system executable must remain discoverable');
  }
  assert.deepEqual(inherited,original);
 }
 const windows=await desktopShell(profile,32124,{env:{PATH:'C:\\fixture'},platform:'win32'});
 assert.equal(windows.state.spawn.executable,join(profile,'node','bin','node.exe'));
 assert.equal(windows.state.spawn.options.env.PATH,'C:\\fixture');
});

test('desktop preload refusal is preserved before any backend environment construction',async t=>{
 for(const variable of ['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE']){
  const env={PATH:'/usr/bin:/bin',[variable]:'fixture-preload'};
  const f=await desktopShell(home(t),32123,{env});
  assert.equal(f.state.spawn,undefined);
  assert.match(f.state.dialogs[0]?.message,/预加载环境/);
  assert.equal(env[variable],'fixture-preload');
 }
});
