import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {createGuiController} from '../src/gui-controller.js';
import {startGuiServer} from '../src/gui-server.js';

function home(t) { const p=mkdtempSync(join(tmpdir(),'cothink-desktop-test-'));t.after(()=>rmSync(p,{recursive:true,force:true}));return p; }
test('desktop shutdown freezes writes but keeps authenticated history and draft persistence until final close', async t=>{
 const controller=await createGuiController({home:home(t),suggestedProject:null,installation:'desktop'});
 const h=await startGuiServer({controller,open:false});t.after(()=>h.close());
 const headers={Authorization:`Bearer ${h.token}`,'Content-Type':'application/json', "X-CoThink-GUI-Input":"2"};
 const origin=new URL(h.url).origin;
 const read=()=>fetch(origin+'/api/bootstrap',{headers});
 const action=(action,args={})=>fetch(origin+'/api/action',{method:'POST',headers,body:JSON.stringify({action,args})});
 const s=await (await action('session.create',{sessionId:randomUUID(),workspaceId:null})).json();
 const boot=await (await read()).json();
 assert.equal(boot.suggestedProject,null);
 assert.equal(boot.installation,'desktop');
 assert.equal(boot.updates.channel,'desktop-local');
 assert.equal(typeof h.beginShutdown,'function');
 assert.equal((await h.beginShutdown()).settled,true);
 assert.equal((await read()).status,200);
 assert.equal((await action('task.submit',{sessionId:s.id,input:'must not send',protocolVersion:1, submissionId:randomUUID()})).status,409);
 const saved=await action('session.draft',{sessionId:s.id,text:'keep on close',expectedDraftRevision:s.draftRevision,branchAnchor:s.branchAnchor,workRequest:null,selectionId:null,editId:randomUUID()});
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
 saveConfig(model.home,createTeamConfig({formatVersion:2,...model.models},'Fixture',randomUUID()));
 const f=await childHost(t,{COTHINK_HOME:model.home});const ready=await f.next('ready');
 const action=async(action,args)=>{const r=await fetch(ready.origin+'/api/action',{method:'POST',headers:{Authorization:`Bearer ${ready.token}`,'Content-Type':'application/json', "X-CoThink-GUI-Input":"2"},body:JSON.stringify({action,args})});assert.equal(r.status,200,await r.clone().text());return r.json();};
 const session=await action('session.create',{project:null});
 const submitted=await action('task.submit',{sessionId:session.id,input:'local fixture only',protocolVersion:1, submissionId:randomUUID()});
 for(let n=0;n<500&&!model.calls.length;n++)await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(model.calls.length,1);f.child.disconnect();
 assert.equal((await f.exited)[0],0);
 const saved=readTask(model.home,submitted.taskId);assert.equal(saved.id,submitted.taskId);
 assert.ok(saved.cancelRequestedAt);assert.ok(saved.cancelSettledAt);assert.notEqual(saved.status,'completed');
 assert.equal(model.calls.length,1);await assert.rejects(fetch(ready.origin));
});
