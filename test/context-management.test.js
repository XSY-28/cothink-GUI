import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import { fixtureConversation, prepareSubmit } from './helpers/gui-controller-fixture.js';
import {createGuiController} from '../src/gui-controller.js';
import { settled, setup } from "./context-management.fixture.js";

for(const split of [false,true])test(`controller organize records actual ${split?2:1} summary requests and retains original history`,async t=>{
 const {f,c,s,path,leaf}=await setup(t,()=>({text:'A sourced summary retaining the original constraints.'}),split),before=readFileSync(path,'utf8'),operationId=randomUUID();
 const result=await c.action('context.organize',{sessionId:s.id,operationId,sourceLeaf:leaf,budget:{maxCalls:2},protocolVersion:1});
 assert.equal(result.taskId,operationId);const done=await settled(c,operationId);assert.equal(done.status,'completed',done.error);assert.equal(done.applied,true);assert.equal(f.calls.length,split?2:1);
 assert.ok(f.calls.every(call=>!JSON.stringify(call.body.messages).includes('OLD_PROCESS_MUST_NOT_BE_SUMMARIZED')));
 assert.ok(readFileSync(path,'utf8').startsWith(before));assert.equal(done.requests.length,f.calls.length);assert.ok(done.requests.every(r=>r.phase==='context-summary'));
 const duplicate=await c.action('context.organize',{sessionId:s.id,operationId,sourceLeaf:leaf,budget:{maxCalls:2},protocolVersion:1});assert.equal(duplicate.taskId,operationId);assert.equal(f.calls.length,split?2:1);
 await assert.rejects(c.action('context.organize',{sessionId:s.id,operationId,sourceLeaf:leaf,budget:{maxCalls:1},protocolVersion:1}));
});
test('split preparation rejects insufficient budget before first physical request',async t=>{
 const {f,c,s,leaf,path}=await setup(t,undefined,true),before=readFileSync(path),operationId=randomUUID();
 await c.action('context.organize',{sessionId:s.id,operationId,sourceLeaf:leaf,budget:{maxCalls:1},protocolVersion:1});
 const result=await settled(c,operationId);assert.equal(result.status,'failed');assert.equal(result.preparation.expectedCalls,2);assert.equal(f.calls.length,0);assert.ok(readFileSync(path,'utf8').startsWith(before.toString()));assert.equal(SessionManager.open(path).getEntries().filter(e=>e.type==='compaction').length,0);
});
test('503 and length preserve original entries without retry or application',async t=>{
 for(const response of [{error:503},{text:'partial',finish:'length'}]){
  const {f,c,s,leaf,path}=await setup(t,()=>response),before=readFileSync(path),operationId=randomUUID();
  await c.action('context.organize',{sessionId:s.id,operationId,sourceLeaf:leaf,budget:{maxCalls:2},protocolVersion:1});
  const result=await settled(c,operationId);assert.equal(result.status,'failed');assert.equal(result.applied,false);assert.equal(f.calls.length,1);assert.ok(readFileSync(path,'utf8').startsWith(before.toString()));assert.equal(SessionManager.open(path).getEntries().filter(e=>e.type==='compaction').length,0);
 }
});
test('actual cancellation drains compact; source mutation blocked, another draft remains writable',async t=>{
 let entered,release;const started=new Promise(r=>entered=r),held=new Promise(r=>release=r);
 const {f,c,s,leaf,path,workspace}=await setup(t,async(_call,_n,_req,res)=>{entered();await Promise.race([held,new Promise(r=>res.once('close',r))]);return {text:'too late'};});
 t.after(()=>release());const other=await fixtureConversation(t,c,{workspace}),before=readFileSync(path),operationId=randomUUID();
 await c.action('context.organize',{sessionId:s.id,operationId,sourceLeaf:leaf,budget:{maxCalls:2},protocolVersion:1});await started;
 for(const name of ['session.name','session.thinking','session.mode'])await assert.rejects(c.action(name,{sessionId:s.id,title:'drift',level:'low',mode:'one'}),{code:'CONTEXT_BUSY'});
 const queued=await prepareSubmit(c,{sessionId:other.id,input:'next conversation',submissionId:randomUUID(),protocolVersion:1});
 assert.equal((await c.session(other.id)).draft,'next conversation');
 await assert.rejects(c.action('task.submit',queued),/不自动排队/);
 await c.action('task.cancel',{taskId:operationId});release();
 const result=await c.readContextOperation(operationId);assert.equal(result.status,'cancelled');assert.equal(result.applied,false);assert.equal((await c.bootstrap()).active,null);assert.ok(readFileSync(path,'utf8').startsWith(before.toString()));assert.equal(SessionManager.open(path).getEntries().filter(e=>e.type==='compaction').length,0);assert.equal(f.calls.length,1);
});
test('real EISDIR append failure quarantines memory and restart query cannot replay',async t=>{
 let path;const data=await setup(t,()=>({text:'successful model result, failed disk'}));path=data.path;
 const originalAppend=fs.appendFileSync;fs.appendFileSync=(target,value,...rest)=>{if(target===path&&String(value).includes('\"type\":\"compaction\"')){renameSync(path,path+'.preserved');mkdirSync(path);}return originalAppend(target,value,...rest);};syncBuiltinESMExports();t.after(()=>{fs.appendFileSync=originalAppend;syncBuiltinESMExports();});
 const {f,c,s}=data,operationId=randomUUID();
 const submit=await prepareSubmit(c,{sessionId:s.id,input:'unsafe continuation',submissionId:randomUUID(),protocolVersion:1});
 const leaf=(await c.session(s.id)).branchAnchor,before=readFileSync(path);
 await c.action('context.organize',{sessionId:s.id,operationId,sourceLeaf:leaf,budget:{maxCalls:2},protocolVersion:1});
 const result=await settled(c,operationId);assert.equal(result.status,'outcome_unknown');assert.equal(result.applied,false);assert.ok(readFileSync(path+'.preserved','utf8').startsWith(before.toString()));
 const record=JSON.parse(readFileSync(join(f.home,'tasks',operationId+'.json')));assert.equal(record.contextRecovery.entries.filter(e=>e.type==='compaction').length,1);assert.notEqual(record.contextRecovery.leaf,leaf);
 await assert.rejects(c.action('task.submit',submit),/上下文写入未确认|历史|EISDIR/);
 await c.close();const reopened=await createGuiController({home:f.home,cwd:f.cwd});t.after(()=>reopened.close());
 assert.equal((await reopened.readContextOperation(operationId)).applied,false);assert.equal(f.calls.length,1);
});
test('persisted source drift is rejected before append and corrupt tails remain unchanged on restart',async t=>{
 let path;const data=await setup(t,()=>{writeFileSync(path,'{"broken":', {flag:'a'});return {text:'do not apply'};});path=data.path;const {f,c,s,leaf}=data,operationId=randomUUID();
 await c.action('context.organize',{sessionId:s.id,operationId,sourceLeaf:leaf,budget:{maxCalls:2},protocolVersion:1});
 const result=await settled(c,operationId);assert.equal(result.applied,false);assert.ok(readFileSync(path,'utf8').endsWith('{"broken":'));assert.equal(f.calls.length,1);
 await c.close();const recovered=await createGuiController({home:f.home,cwd:f.cwd});t.after(()=>recovered.close());const bytes=readFileSync(path);await recovered.readContextOperation(operationId);assert.deepEqual(readFileSync(path),bytes);assert.equal(f.calls.length,1);
});
test('writer token lost after response prevents compaction and later generation',async t=>{
 let locks;const data=await setup(t,()=>{const names=readdirSync(locks).filter(n=>/^\d+\.json$/.test(n)).sort((a,b)=>parseInt(a)-parseInt(b));const path=join(locks,names.at(-1));const claim=JSON.parse(readFileSync(path));writeFileSync(path,JSON.stringify({...claim,token:randomUUID()}));return {text:'writer lost'};});
 const {f,c,s,path}=data;locks=join(f.home,'pi/sessions',s.id+'.locks');const operationId=randomUUID();
 const submit=await prepareSubmit(c,{sessionId:s.id,input:'no more',submissionId:randomUUID(),protocolVersion:1});
 const leaf=(await c.session(s.id)).branchAnchor;
 await c.action('context.organize',{sessionId:s.id,operationId,sourceLeaf:leaf,budget:{maxCalls:2},protocolVersion:1});
 const result=await settled(c,operationId);assert.equal(result.applied,false);assert.equal(SessionManager.open(path).getEntries().filter(e=>e.type==='compaction').length,0);assert.equal(f.calls.length,1);
 await assert.rejects(c.action('task.submit',submit),/写入权已丢失|上下文写入未确认/);assert.equal(f.calls.length,1);
});
test('HTTP context action and read-only operation route enforce authentication and identity',async t=>{
 const {f,c,s,leaf}=await setup(t,()=>({text:'HTTP summary'}));await c.close();
 const {startGuiServer}=await import('../src/gui-server.js');const server=await startGuiServer({home:f.home,cwd:f.cwd,open:false,port:0});t.after(()=>server.close());const origin=new URL(server.url).origin,headers={Authorization:'Bearer '+server.token,'Content-Type':'application/json', "X-CoThink-GUI-Input":"3"},operationId=randomUUID();
 const response=await fetch(origin+'/api/action',{method:'POST',headers,body:JSON.stringify({action:'context.organize',args:{sessionId:s.id,operationId,sourceLeaf:leaf,budget:{maxCalls:2},protocolVersion:1}})});assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).taskId,operationId);
 let result;for(let i=0;i<500;i++){result=await (await fetch(origin+'/api/context-operation?operationId='+operationId,{headers})).json();if(result.status==='completed')break;await new Promise(r=>setTimeout(r,10));}assert.equal(result.applied,true);const count=f.calls.length;
 assert.equal((await fetch(origin+'/api/context-operation?operationId='+operationId)).status,403);assert.equal((await fetch(origin+'/api/context-operation?operationId='+operationId+'&path=/etc/passwd',{headers})).status,400);
 await fetch(origin+'/api/context-operation?operationId='+operationId,{headers});assert.equal(f.calls.length,count);
});
test('guard rejects actual in-memory branch drift without moving it back',async t=>{
 let owned;const {f,c,s,leaf,path}=await setup(t,()=>{owned.branch(owned.getBranch().find(e=>e.type==='message'&&e.message.role==='user').id);return {text:'stale branch summary'};});
 const open=SessionManager.open;SessionManager.open=function(...args){const manager=open.apply(this,args);if(manager.getSessionId()===s.id)owned=manager;return manager;};t.after(()=>{SessionManager.open=open;});
 const operationId=randomUUID();await c.action('context.organize',{sessionId:s.id,operationId,sourceLeaf:leaf,budget:{maxCalls:2},protocolVersion:1});const result=await settled(c,operationId);
 assert.equal(result.applied,false);assert.match(result.error,/source changed/i);assert.notEqual(owned.getLeafId(),leaf);assert.equal(owned.getEntries().filter(e=>e.type==='compaction').length,0);assert.equal(SessionManager.open(path).getEntries().filter(e=>e.type==='compaction').length,0);assert.equal(f.calls.length,1);
});
test('task.cancel waits the actual public compact lifecycle before recording settled',async t=>{
 const {f,c,s,path}=await setup(t,()=>({text:'completed summary'}));await c.close();
 const {createRuntime}=await import('../src/pi-runtime.js'),{createTask}=await import('../src/task.js'),{createRootOwner,normalizeRootBudget,normalizeConstraints}=await import('../src/project-turn.js'),{contextSnapshot,compactContext}=await import('../src/context-management.js');
 let entered,release;const reached=new Promise(r=>entered=r),held=new Promise(r=>release=r);t.after(()=>release());
 const manager=SessionManager.open(path),runtime=await createRuntime({home:f.home,cwd:f.cwd,modelRef:f.models.main,sessionManager:manager,projectManaged:true,contextAccess:true,resourceOptions:{noContextFiles:true},extensionFactories:[{name:'hold-public-compaction-event',factory:pi=>{pi.on('session_compact',async()=>{entered();await held;});}}]});t.after(()=>runtime.dispose());
 const task=createTask({home:f.home,input:'explicit organize',models:f.models,flow:'unified',origin:'context.organize',sessionId:s.id,sourceLeaf:manager.getLeafId(),sourceSnapshot:contextSnapshot(manager),constraints:normalizeConstraints(),budget:normalizeRootBudget({maxCalls:2})});createRootOwner(task);
 const running=compactContext({task,runtime,quarantine:error=>{runtime.selectionError=error.message;}});await reached;
 const stopping=task.cancel();await new Promise(r=>setImmediate(r));assert.equal(task.record.cancelSettledAt,undefined);
 release();await Promise.all([running,stopping]);assert.ok(task.record.cancelSettledAt);assert.equal(f.calls.length,1);
});
test('split second-request failure retains first usage without applying or retrying',async t=>{
 const {f,c,s,leaf,path}=await setup(t,(_call,n)=>n===1?{text:'first partial summary'}:{error:503},true),operationId=randomUUID();
 await c.action('context.organize',{sessionId:s.id,operationId,sourceLeaf:leaf,budget:{maxCalls:2},protocolVersion:1});const result=await settled(c,operationId);
 assert.equal(result.applied,false);assert.equal(result.status,'failed');assert.equal(f.calls.length,2);assert.equal(result.requests[0].status,'completed');assert.ok(result.requests[0].usage);assert.equal(SessionManager.open(path).getEntries().filter(e=>e.type==='compaction').length,0);
});
test('unknown transport result is queried without a second send or compaction',async t=>{
 const {f,c,s,leaf,path}=await setup(t,(_call,_n,_req,res)=>{res.destroy();return null;}),operationId=randomUUID();
 await c.action('context.organize',{sessionId:s.id,operationId,sourceLeaf:leaf,budget:{maxCalls:2},protocolVersion:1});const result=await settled(c,operationId);
 assert.equal(result.applied,false);assert.equal(f.calls.length,1);assert.equal(result.status,'outcome_unknown');assert.ok(result.requests.some(r=>r.usage===null));assert.equal(SessionManager.open(path).getEntries().filter(e=>e.type==='compaction').length,0);
 await c.readContextOperation(operationId);assert.equal(f.calls.length,1);
});
