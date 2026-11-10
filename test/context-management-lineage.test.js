import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {fixture} from './helpers/pi-fixture.js';
import { prepareSubmit } from './helpers/gui-controller-fixture.js';
import {createGuiController} from '../src/gui-controller.js';
import { answer, settled, setup } from "./context-management.fixture.js";

test('model tools search read and save a derived note with verified branch references',async t=>{
 let ref,noteRef;const toolResult=call=>JSON.parse(call.body.messages.findLast(m=>m.role==='tool').content);
 const {f,c,s,path}=await setup(t,(call,n)=>{
  if(n===1)return {toolCalls:[{name:'search_context',args:{query:'User request 3.',limit:3}}]};
  if(n===2){ref=toolResult(call).items[0].ref;return {toolCalls:[{name:'read_context',args:{ref,limit:100}}]};}
  if(n===3){assert.match(toolResult(call).text,/User request 3/);return {toolCalls:[{name:'save_context_note',args:{text:'Derived handoff; retain original permission limits.',sources:[ref]}}]};}
  if(n===4){noteRef=toolResult(call).ref;return {toolCalls:[{name:'read_context',args:{ref:noteRef}}]};}
  if(n===5){assert.equal(toolResult(call).derived,true);assert.deepEqual(toolResult(call).sources,[ref]);return {toolCalls:[{name:'get_capabilities',args:{}}]};}
  if(n===6){assert.equal(toolResult(call).environment.contextToolsAvailable,true);return {text:'Original sources and derived note are readable.'};}
 },false,8);
 const accepted=await c.action('task.submit',await prepareSubmit(c,{sessionId:s.id,input:'Use prior source and save handoff',submissionId:randomUUID(),protocolVersion:1}));
 for(let i=0;i<500&&(await c.bootstrap()).active;i++)await new Promise(r=>setTimeout(r,10));
 const done=await c.task(accepted.taskId);assert.equal(done.status,'completed',done.error);assert.equal(f.calls.length,6);
 const note=SessionManager.open(path).getBranch().find(e=>e.customType==='cothink-context-note');assert.equal(note.data.taskId,accepted.taskId);assert.equal(note.data.author.role,'main');assert.deepEqual(note.data.sources,[ref]);
 const {createContextAccess}=await import('../src/context-management.js');const manager=SessionManager.open(path),access=createContextAccess({home:f.home,manager});
 assert.throws(()=>access.read({ref:{...ref,sessionId:randomUUID()}}),{code:'CONTEXT_SOURCE'});assert.throws(()=>access.read({ref:{path:'/etc/passwd'}}),{code:'CONTEXT_SOURCE'});assert.throws(()=>access.read({ref,limit:999999}),{code:'CONTEXT_RANGE'});
 manager.branch(ref.id);assert.equal(access.search({query:'Derived handoff'}).items.length,0);assert.throws(()=>access.read({ref:noteRef}),{code:'CONTEXT_SOURCE'});
 assert.doesNotMatch(JSON.stringify(await c.getSessionCapabilities(s.id)),/fixture-secret|auth\.json|payload/);
 const fork=await c.action('session.fork',{sessionId:s.id,taskId:accepted.taskId});const forkFile=join(f.home,'pi/sessions/main',readdirSync(join(f.home,'pi/sessions/main')).find(name=>name.includes(fork.id)));const inherited=createContextAccess({home:f.home,manager:SessionManager.open(forkFile)});assert.match(inherited.read({ref}).text,/User request 3/);assert.equal(inherited.read({ref:noteRef}).derived,true);
});
test('successful restart is read-only and historical reply fork preserves summary and later messages',async t=>{
 // Keep enough content to compact, but leave room for the real roster and tool prompt.
 const {f,c,s,path}=await setup(t,call=>({text:JSON.stringify(call.body.messages).includes('<conversation>')?'PERSISTED_COMPACTION_SENTINEL':'Original answer'}),false,9);
 const first=await c.action('task.submit',await prepareSubmit(c,{sessionId:s.id,input:'reply before organize',submissionId:randomUUID(),protocolVersion:1}));
 for(let i=0;i<500&&(await c.bootstrap()).active;i++)await new Promise(r=>setTimeout(r,10));
 const leaf=(await c.session(s.id)).branchAnchor,operationId=randomUUID();await c.action('context.organize',{sessionId:s.id,operationId,sourceLeaf:leaf,budget:{maxCalls:2},protocolVersion:1});assert.equal((await settled(c,operationId)).applied,true);
 await c.action('task.submit',await prepareSubmit(c,{sessionId:s.id,input:'reply after organize',submissionId:randomUUID(),protocolVersion:1}));
 for(let i=0;i<500&&(await c.bootstrap()).active;i++)await new Promise(r=>setTimeout(r,10));
 assert.match(JSON.stringify(f.calls.at(-1).body.messages),/PERSISTED_COMPACTION_SENTINEL/);
 const before=readFileSync(path),calls=f.calls.length;await c.close();
 const recovered=await createGuiController({home:f.home,cwd:f.cwd});t.after(()=>recovered.close());
 assert.equal((await recovered.readContextOperation(operationId)).applied,true);assert.deepEqual(readFileSync(path),before);assert.equal(f.calls.length,calls);
 const branch=await recovered.action('session.fork',{sessionId:s.id,taskId:first.taskId});assert.equal(branch.turns.length,1);assert.equal(branch.context.summary,null);assert.deepEqual(readFileSync(path),before);assert.equal(f.calls.length,calls);
});

test('SDK fork context proves selected ancestry and rejects foreign, changed or forged sources',async t=>{
 const {createContextAccess}=await import('../src/context-management.js');
 const {createTask}=await import('../src/task.js');
 const f=await fixture(t),directory=join(f.home,'pi/sessions/main');mkdirSync(directory,{recursive:true});
 const parent=SessionManager.create(f.cwd,directory),parentId=parent.getSessionId();
 const user=parent.appendMessage({role:'user',content:'SELECTED_PARENT_INPUT',timestamp:1});
 parent.appendLabelChange(user,'Selected source');
 parent.appendMessage(answer('SELECTED_PARENT_REPLY'));
 const task=createTask({home:f.home,input:'EXACT_PARENT_TASK',models:f.models,sessionId:parentId});task.finish('failed');
 const leaf=parent.appendCustomEntry('cothink-task',{taskId:task.record.id});
 const original=createContextAccess({home:f.home,manager:parent}),ref=original.search({query:'SELECTED_PARENT_INPUT'}).items[0].ref;
 const taskRef=original.search({query:'EXACT_PARENT_TASK'}).items[0].ref;
 parent.appendMessage({role:'user',content:'EXCLUDED_PARENT_SIBLING',timestamp:2});parent.appendMessage(answer('sibling'));
 const siblingRef=original.search({query:'EXCLUDED_PARENT_SIBLING'}).items[0].ref;
 const parentPath=parent.getSessionFile(),parentBytes=readFileSync(parentPath);
 parent.createBranchedSession(leaf);
 const fork=SessionManager.forkFrom(parent.getSessionFile(),f.cwd,directory);
 const sessionBytes=()=>Object.fromEntries(readdirSync(directory).sort().map(name=>[name,readFileSync(join(directory,name))]));
 const savedSessions=sessionBytes();
 const access=createContextAccess({home:f.home,manager:fork});
 assert.equal(access.read({ref}).text,'SELECTED_PARENT_INPUT');
 assert.equal(access.read({ref:taskRef}).text,'EXACT_PARENT_TASK');
 assert.match(JSON.stringify(access.freeze()),/SELECTED_PARENT_INPUT/);
 assert.doesNotMatch(JSON.stringify(access.freeze()),/EXCLUDED_PARENT_SIBLING/);
 assert.throws(()=>access.read({ref:siblingRef}),{code:'CONTEXT_SOURCE'});
 assert.throws(()=>access.read({ref:{...ref,sessionId:randomUUID()}}),{code:'CONTEXT_SOURCE'});
 const entries=[fork.getHeader(),...fork.getEntries()];
 const altered=structuredClone(entries);altered.find(e=>e.id===user).message.content='FORGED_INHERITED_TEXT';
 assert.throws(()=>createContextAccess({home:f.home,manager:SessionManager.inMemory(f.cwd,undefined,altered)}).freeze(),{code:'CONTEXT_SOURCE'});
 assert.deepEqual(sessionBytes(),savedSessions,'lineage verification and in-memory SDK label rechain neither add nor rewrite session files');
 const outside=join(f.home,'outside-session.jsonl');writeFileSync(outside,parentBytes);
 for(const target of [outside,join(directory,'escape.jsonl')]){
   if(target!==outside)fs.symlinkSync(outside,target);
   const changed=structuredClone(entries);changed[0].parentSession=target;
   assert.throws(()=>createContextAccess({home:f.home,manager:SessionManager.inMemory(f.cwd,undefined,changed)}).freeze(),{code:'CONTEXT_SOURCE'});
 }
 const foreignCwd=join(f.home,'foreign-project');mkdirSync(foreignCwd);
 const crossProject=SessionManager.forkFrom(parentPath,foreignCwd,directory);
 assert.throws(()=>createContextAccess({home:f.home,manager:crossProject}).freeze(),{code:'CONTEXT_SOURCE'});
 const forged=SessionManager.create(f.cwd,directory);forged.appendMessage(answer('unrelated'));
 forged.appendCustomEntry('cothink-fork',{sessionId:parentId,taskId:task.record.id});
 forged.appendCustomEntry('cothink-task',{taskId:task.record.id});
 assert.throws(()=>createContextAccess({home:f.home,manager:forged}).freeze(),{code:'CONTEXT_SOURCE'});
 assert.deepEqual(readFileSync(parentPath),parentBytes,'original parent bytes were only read');
 assert.equal(f.calls.length,0);
});
