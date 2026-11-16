import test from 'node:test';import assert from 'node:assert/strict';
import{readFileSync}from'node:fs';import{join}from'node:path';
import{fixture}from'./helpers/pi-fixture.js';import{repository}from'./helpers/git-fixture.js';
import{projectSession,confirmProject}from'./unified-project.fixture.js';
import{runProjectTurn,executeConfirmed}from'../src/project-turn.js';
import{readTask}from'../src/task.js';import{projectChatState}from'../src/project.js';
import{inspectFileContinuation}from'../src/project-continuation.js';
import{reserveFileContinuation}from'../src/project-file-confirmation.js';
import{revisedFailureRoute}from'../src/project-route-revision.js';import{createVersioning}from'../src/versioning.js';
const tool=(name,args={})=>({toolCalls:[{name,args}]});
test('explicit new failed-check diagnosis retains draft and history; ordinary resume remains blocked',{timeout:60000},async t=>{
 const plan={goal:'Deliver fixed A',scope:['a.txt'],readScope:['a.txt'],deliverables:['a.txt'],checks:[{command:'node',args:['-e',"if(require('fs').readFileSync('a.txt','utf8')!=='fixed A\\n')process.exit(1)"]}]};
 const judge={path:'a.txt',contains:'saved A',ifPresent:'repair',ifAbsent:'blocked',repairScope:['a.txt'],reason:'Correct the observed text under the original fixed check.'};
 const first=[tool('start_work',{action:'start',reason:'correct A',plan}),tool('read',{path:'a.txt'}),tool('edit',{path:'a.txt',edits:[{oldText:'base A',newText:'saved A'}]}),tool('prepare_change',{check:true}),tool('project_route_judge',judge),tool('read',{path:'a.txt'}),tool('edit',{path:'a.txt',edits:[{oldText:'saved A',newText:'middle A'}]}),tool('prepare_change',{check:true}),{text:'New check failed; preserve current draft.'}];
 let phase=0,index=0,wire;
 const f=await fixture(t,({body},n,req,res)=>{
  if(phase===0){if(n===4){res.destroy();return null;}return first[n-1];}
  if(phase===1)return first[index++ + 3]??{text:'Blocked'};
  if(!index)wire=body;
  return [tool('project_route_judge',{...judge,contains:'middle A'}),tool('read',{path:'a.txt'}),tool('edit',{path:'a.txt',edits:[{oldText:'middle A',newText:'fixed A'}]}),tool('prepare_change',{check:true}),tool('accept_change'),tool('accept_change'),{text:'Fixed A checked and delivered.'}][index++]??{text:'Delivered'};
 });
 const repo=repository(t),base=await projectSession(t,repo,f),proposal=await runProjectTurn({...base,input:plan.goal,budget:{maxCalls:40},frozenConstraints:{allowFileContinuation:true}});
 const interrupted=await confirmProject(base,proposal,{frozenConstraints:{allowFileContinuation:true}});
 const initial=await inspectFileContinuation({home:f.home,sourceRootTaskId:interrupted.record.id});assert.equal(initial.eligible,true,JSON.stringify(initial.blockers));
 const firstReservation=await reserveFileContinuation({home:f.home,sessionId:interrupted.record.sessionId,sourceRootTaskId:interrupted.record.id,draft:initial.draft,submissionId:'first-recovery',expectedRevision:initial.revision,expectedFormalVersion:initial.formalVersion,authorizationSource:{kind:'file_continuation',sourceTaskId:interrupted.record.id,mode:'user'}});
 phase=1;const firstSource=readTask(f.home,interrupted.record.id);
 const original=await runProjectTurn({...base,input:firstSource.input,taskId:firstReservation.taskId,submissionId:firstReservation.submissionId,budget:firstReservation.budgetSource.remaining,confirmedOperation:{source:firstSource,reservation:firstReservation,execute:task=>executeConfirmed(task,firstSource,firstReservation)}});
 const state=(await projectChatState(f.home,repo.project)).state,step=state.steps[0],route=step.route;
 assert.equal(route.status,'blocked',JSON.stringify(route));assert.ok(route.edit);assert.ok(route.recheck);
 const ordinary=await inspectFileContinuation({home:f.home,sourceRootTaskId:original.record.id});assert.equal(ordinary.eligible,false);
 const draft=ordinary.draft,routeRevision={reason:'The first correction exposed a new independently diagnosed check failure; reconsider this exact failed candidate.',candidate:route.recheck.candidate,sourceRequestId:route.recheck.evidence.requestId};
 const params={home:f.home,sourceRootTaskId:original.record.id,draft,routeRevision};
 const fact=await inspectFileContinuation(params);assert.equal(fact.eligible,true,JSON.stringify(fact.blockers));assert.equal(fact.recoveredRoute.status,'paused');assert.ok(!fact.recoveredRoute.edit);assert.ok(!fact.recoveredRoute.judgmentCall);
 for(const bad of [null,{...routeRevision,reason:''},{...routeRevision,candidate:route.candidate},{...routeRevision,sourceRequestId:route.evidence.requestId},{...routeRevision,scope:['other']}])assert.equal((await inspectFileContinuation({...params,routeRevision:bad})).eligible,false);
 const v=await createVersioning({home:f.home,project:repo.project,readOnly:true});
 try {
  const args={home:f.home,state,source:original.record,step,versioning:v,draft,routeRevision};
  for(const mutate of [s=>s.route.edit=null,s=>s.route.status='repair',s=>s.route.recheck.candidate=s.route.candidate,s=>s.routeHistory=[{routeRevision}],s=>s.checks[0].args=['-e','process.exit(0)']]){
   const changed=structuredClone(step);mutate(changed);await assert.rejects(revisedFailureRoute({...args,step:changed}),{code:'PROJECT_ROUTE_REVISION'});
  }
  const missing={...v,inspect:input=>input.requestId===routeRevision.sourceRequestId?Promise.resolve({status:'not_found'}):v.inspect(input)};
  await assert.rejects(revisedFailureRoute({...args,versioning:missing}),{code:'PROJECT_ROUTE_REVISION'});
  const wrongEdit={...v,inspect:async input=>{const result=await v.inspect(input);return input.requestId===route.edit.requestId?{...result,changeId:'wrong'}:result;}};
  await assert.rejects(revisedFailureRoute({...args,versioning:wrongEdit}),{code:'PROJECT_ROUTE_REVISION'});
  const unchanged={...v,inspect:input=>input.fromVersion===route.candidate?Promise.resolve({files:[]}):v.inspect(input)};
  await assert.rejects(revisedFailureRoute({...args,versioning:unchanged}),{code:'PROJECT_ROUTE_REVISION'});
  for(const mutate of [r=>r.baseVersion='wrong',r=>r.actor='member:other',r=>r.candidates.find(c=>c.candidateVersion===routeRevision.candidate).precheck.checks[0].sourceChanged=true,r=>r.candidates.find(c=>c.candidateVersion===routeRevision.candidate).precheck.status='passed']) {
   const invalid={...v,inspect:async input=>{const result=structuredClone(await v.inspect(input));if(input.requestId===routeRevision.sourceRequestId)mutate(result);return result;}};
   await assert.rejects(revisedFailureRoute({...args,versioning:invalid}),{code:'PROJECT_ROUTE_REVISION'});
  }

 }finally{await v.close();}
 const options={...params,sessionId:original.record.sessionId,submissionId:'explicit-new-diagnosis',expectedRevision:fact.revision,expectedFormalVersion:fact.formalVersion};
 await assert.rejects(reserveFileContinuation({...options,authorizationSource:{kind:'file_continuation',sourceTaskId:original.record.id,mode:'preauthorized_once'}}),{code:'CONTINUATION_AUTH'});
 const childPath=join(f.home,'tasks',route.taskId+'.json'),before=readFileSync(childPath);
 const reservation=await reserveFileContinuation({...options,authorizationSource:{kind:'file_continuation',sourceTaskId:original.record.id,mode:'user'}});
 await assert.rejects(reserveFileContinuation({...options,routeRevision:{...routeRevision,reason:'Changed authorization after reservation'},authorizationSource:{kind:'file_continuation',sourceTaskId:original.record.id,mode:'user'}}),{code:'CONTINUATION_AUTH'});
 assert.deepEqual(reservation.continuation.routeRevision,routeRevision);phase=2;index=0;
 const source=readTask(f.home,original.record.id),result=await runProjectTurn({...base,input:source.input,taskId:reservation.taskId,submissionId:reservation.submissionId,budget:reservation.budgetSource.remaining,confirmedOperation:{source,reservation,execute:task=>executeConfirmed(task,source,reservation)}});
 assert.equal(result.record.status,'completed',result.record.error);assert.deepEqual(wire.tools.map(x=>x.function.name),['project_route_judge']);
 assert.deepEqual(readFileSync(childPath),before);const after=(await projectChatState(f.home,repo.project)).state;
 assert.ok(after.steps[0].routeHistory.some(r=>r.status==='blocked'&&r.edit.requestId===route.edit.requestId&&r.recheck.evidence.requestId===routeRevision.sourceRequestId));
 assert.deepEqual(after.steps[0].checks,step.checks);assert.deepEqual(after.budget,state.budget);
});
