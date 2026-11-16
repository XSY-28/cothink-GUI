import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import React, {act} from 'react';
import {fixture} from './helpers/pi-fixture.js';
import {controller,fixtureConversation,finished,load,submitDraft,seedFixtureConversationRepository} from './helpers/gui-controller-fixture.js';
import {modalEnvironment} from './gui-modal.fixture.js';


test('saved single-use continuation choice is explicit, frozen and never inferred from prose', async t=>{
  const {editorTurnInput,defaultTurnOptions}=await load('src/gui-turn-options.js');
  const {normalizeConstraints}=await load('src/project-turn.js');
  assert.equal(defaultTurnOptions().allowFileContinuation,false);
  assert.equal(normalizeConstraints({}).allowFileContinuation,false);
  assert.equal(editorTurnInput({id:randomUUID(),allowFileContinuation:true}).constraints.allowFileContinuation,true);
  assert.throws(()=>editorTurnInput({id:randomUUID(),allowFileContinuation:'yes'}));
  const f=await fixture(t),c=await controller(t,f),s=await fixtureConversation(t,c);
  const a=await submitDraft(c,{sessionId:s.id,input:'不要提问，说明颜色。'});
  assert.equal((await finished(c,a.taskId)).constraints.allowFileContinuation,false);
  const b=await submitDraft(c,{sessionId:s.id,input:'说明颜色。',turnOptions:{id:randomUUID(),allowFileContinuation:true}});
  assert.equal((await finished(c,b.taskId)).constraints.allowFileContinuation,true);
  assert.equal(f.calls.length,2);
});


test('continuation dialog reads eligibility before explicit execution and exposes blockers',async()=>{
 for(const eligible of [false,true])for(const inputOnly of [false,true]) await modalEnvironment(async({root,container,FileContinuation})=>{
  let reads=0,writes=0;const draft={taskId:'saved',changeId:'change',baseVersion:'base',version:'fixed'};
  const facts={eligible,inputOnly,creditExhausted:true,remainingRepair:inputOnly?undefined:["a.txt","b.txt"],draft,revision:2,formalVersion:'formal',remainingBudget:{maxCalls:4},
    blockers:eligible?[]:[{code:'PENDING_EFFECT',sourceId:'original-command',message:'外部写入尚未结清'}],models:['fixture/main · max']};
  await act(()=>root.render(React.createElement(FileContinuation,{turn:{taskId:'root'},
    onInspect:async()=>{reads++;return facts;},onContinue:async(t,f)=>{assert.deepEqual(f,facts);writes++;return {taskId:'next'};}})));
  await act(async()=>[...container.querySelectorAll('button')].find(b=>b.textContent==='从保存成果继续').click());
  assert.equal(reads,1);assert.equal(writes,0);
  const dialog=container.querySelector('[role="dialog"]');assert.ok(dialog);
  assert.match(dialog.textContent,/未知费用/);assert.match(dialog.textContent,/先恢复 API 额度/);assert.match(dialog.textContent,inputOnly?/已保存输入版本/:/未验收草稿/);
  if(!inputOnly)assert.match(dialog.textContent,/仍剩 1 次修复写入。允许路径：a.txt、b.txt/);
  const confirm=[...dialog.querySelectorAll('button')].find(b=>b.textContent==='确认并继续一次');
  assert.equal(confirm.disabled,!eligible);
  if(eligible){assert.match(dialog.textContent,/4/);await act(async()=>confirm.click());assert.equal(writes,1);}
  else {assert.match(dialog.textContent,/original-command/);assert.match(dialog.textContent,/外部写入尚未结清/);}
 });
});


test('GUI continues a disconnected saved draft once and recovers the same receipt',async t=>{
 const {repository}=await import('./helpers/git-fixture.js');
 const {execution}=await import('./helpers/agent-sync-fixture.js');
 const {readTask,readRequests}=await load('src/task.js');
 const plan={goal:'Update a.txt',scope:['a.txt'],deliverables:['a.txt'],checks:[{command:'node',args:['-e',"if(require('fs').readFileSync('a.txt','utf8')!=='finished A\\n')process.exit(1)"]}]};
 const tool=(name,args)=>({toolCalls:[{name,args}]});
 const replies=[tool('start_work',{action:'start',reason:'edit',plan}),tool('read',{path:'a.txt'}),
   tool('edit',{path:'a.txt',edits:[{oldText:'base A',newText:'saved A'}]}),null,
   tool('read',{path:'a.txt'}),tool('edit',{path:'a.txt',edits:[{oldText:'saved A',newText:'finished A'}]}),
   tool('accept_change',{}),tool('accept_change',{}),{text:'Delivered'}];
 const f=await fixture(t,(_,n,req,res)=>{if(n===4){res.destroy();return null;}return replies[n-1]??{text:'Delivered'};});
 const c=await controller(t,f,{work:{execution}}),session=seedFixtureConversationRepository(repository(t).project,await fixtureConversation(t,c));
 const proposed=await submitDraft(c,{sessionId:session.id,input:'Update a.txt.'});await finished(c,proposed.taskId);
 const proposal=(await c.session(session.id)).turns.at(-1);
 const original=await c.action('task.confirmWork',{sessionId:session.id,submissionId:randomUUID(),proposalRef:proposal.proposalRef,protocolVersion:1});
 await finished(c,original.taskId);
 // The user-visible terminal status can precede stopAndDrain by one microtask.
 for(let i=0;i<100&&(await c.bootstrap()).active;i++)await new Promise(r=>setTimeout(r,10));
 const facts=await c.action('task.inspectContinuation',{sessionId:session.id,sourceRootTaskId:original.taskId});
 assert.equal(facts.eligible,true,JSON.stringify(facts.blockers));
 const count=f.calls.length;
 const args={sessionId:session.id,sourceRootTaskId:original.taskId,submissionId:randomUUID(),protocolVersion:1,
   draft:facts.draft,expectedRevision:facts.revision,expectedFormalVersion:facts.formalVersion};
 const [a,b]=await Promise.all([c.action('task.continueWork',args),c.action('task.continueWork',{...args,submissionId:randomUUID()})]);
 assert.equal(a.taskId,b.taskId,'double click must join the one saved reservation');
 const done=await finished(c,a.taskId);assert.equal(done.status,'completed',done.error);
 for(let i=0;i<100&&(await c.bootstrap()).active;i++)await new Promise(r=>setTimeout(r,10));
 const again=await c.action('task.continueWork',args);assert.equal(again.taskId,a.taskId);
 assert.equal(readTask(f.home,original.taskId).status,'outcome_unknown');
 const originalChild=readTask(f.home,readTask(f.home,original.taskId).projectOperation.childTaskIds[0]);
 assert.equal(readRequests(f.home,originalChild).filter(r=>r.status==='outcome_unknown').length,1);
 const files=await c.files(a.taskId),item=files.items.find(x=>x.name==='a.txt'&&!x.ref.draft);
 assert.ok(item);assert.equal((await c.file(item.ref)).bytes.toString(),'finished A\n');
 assert.ok(f.calls.length>count);
 const sessionAfter=await c.session(session.id);
 const {createApi}=await import('../gui/src/api.js');
 const api=createApi('fixture',async()=>({ok:true,text:async()=>JSON.stringify(sessionAfter)}));
 assert.equal((await api.recover({kind:'file_continuation',sessionId:session.id,sourceRootTaskId:original.taskId,submissionId:args.submissionId})).taskId,a.taskId);
 const other=await fixtureConversation(t,c);
 await assert.rejects(c.action('task.inspectContinuation',{sessionId:other.id,sourceRootTaskId:original.taskId}),/分支/);
 const priorCalls=f.calls.length;await c.close();
 const {createGuiController}=await load('src/gui-controller.js');
 const reopened=await createGuiController({home:f.home,cwd:f.cwd});t.after(()=>reopened.close());
 const recovered=await reopened.action('task.continueWork',args);
 assert.equal(recovered.taskId,a.taskId,'host reopen queries the consumed receipt, not another execution');
 assert.equal(f.calls.length,priorCalls);

});


test('visible preauthorization is consumed once after closure and does not loop on another disconnect',async t=>{
 const {repository}=await import('./helpers/git-fixture.js');
 const {execution}=await import('./helpers/agent-sync-fixture.js');
 const {readTask}=await load('src/task.js');
 const tool=(name,args)=>({toolCalls:[{name,args}]});
 const plan={goal:'Update a.txt',scope:['a.txt'],deliverables:['a.txt'],checks:[{command:'node',args:['--version']}]};
 const replies=[tool('start_work',{action:'start',reason:'edit',plan}),tool('read',{path:'a.txt'}),
   tool('edit',{path:'a.txt',edits:[{oldText:'base A',newText:'saved A'}]}),null,tool('read',{path:'a.txt'})];
 const f=await fixture(t,(_,n,req,res)=>{if(n===4||n===6){res.destroy();return null;}return replies[n-1]??{text:'must not run'};});
 const c=await controller(t,f,{work:{execution}}),session=seedFixtureConversationRepository(repository(t).project,await fixtureConversation(t,c));
 const proposed=await submitDraft(c,{sessionId:session.id,input:'Update a.txt.',turnOptions:{id:randomUUID(),allowFileContinuation:true,maxCalls:'12'}});
 await finished(c,proposed.taskId);const proposal=(await c.session(session.id)).turns.at(-1);
 const original=await c.action('task.confirmWork',{sessionId:session.id,submissionId:randomUUID(),proposalRef:proposal.proposalRef,protocolVersion:1});
 let next;
 for(let i=0;i<500;i++){
   next=readTask(f.home,original.taskId).fileContinuationIntent?.taskId;
   if(next&&!(await c.bootstrap()).active){try{if(readTask(f.home,next).status!=='running')break;}catch{}}
   assert.equal(readTask(f.home,original.taskId).fileContinuationError,undefined);
   await new Promise(r=>setTimeout(r,20));
 }
 assert.ok(next,JSON.stringify(readTask(f.home,original.taskId)));
 assert.equal((await finished(c,next)).status,'outcome_unknown');
 const source=readTask(f.home,original.taskId),continued=readTask(f.home,next);
 assert.ok(source.localExecutionClosedAt);assert.equal(source.fileContinuationIntent.status,'consumed');
 assert.equal(continued.operationAuthorization.mode,'preauthorized_once');
 assert.equal(continued.fileContinuationIntent,undefined);
 assert.equal(f.calls.length,6,'the second failure must not start a third attempt');
 const files=await c.files(next);assert.ok(files.items.some(item=>item.ref?.draft),'saved draft stays readable');
 assert.equal(continued.budget.maxCalls,source.budget.maxCalls-source.rootRequests.filter(r=>!r.notSent).length);
});
