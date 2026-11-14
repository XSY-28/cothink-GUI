import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/pi-fixture.js';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {writePrivateJson} from '../src/storage.js';
import {repository} from './helpers/git-fixture.js';
import {projectSession,confirmProject} from './unified-project.fixture.js';
import {runProjectTurn,executeConfirmed} from '../src/project-turn.js';
import {inspectFileContinuation,completedContinuationEvidence} from '../src/project-continuation.js';
import {reserveFileContinuation} from '../src/project-file-confirmation.js';
import {readTask,readRequests} from '../src/task.js';
import {projectChatState} from '../src/project.js';
import {createVersioning} from '../src/versioning.js';
const tool=(name,args={})=>({toolCalls:[{name,args}]});
const plan=value=>({goal:'Deliver '+value,scope:['a.txt'],readScope:['a.txt'],deliverables:['a.txt'],
  checks:[{command:'node',args:['-e',`if(require('fs').readFileSync('a.txt','utf8')!==${JSON.stringify(value+'\n')})process.exit(1)`]}]});
async function continueRoot(base,source) {
 const checked=await inspectFileContinuation({home:base.home,sourceRootTaskId:source.id});
 assert.equal(checked.eligible,true,JSON.stringify(checked.blockers));
 const reservation=await reserveFileContinuation({home:base.home,sessionId:source.sessionId,sourceRootTaskId:source.id,draft:checked.draft,
   submissionId:'continue-'+source.id,authorizationSource:{kind:'file_continuation',sourceTaskId:source.id,mode:'user'},
   expectedRevision:checked.revision,expectedFormalVersion:checked.formalVersion});
 const saved=readTask(base.home,source.id);
 return runProjectTurn({...base,input:saved.input,taskId:reservation.taskId,submissionId:reservation.submissionId,budget:reservation.budgetSource.remaining,
   confirmedOperation:{source:saved,reservation,execute:task=>executeConfirmed(task,saved,reservation)}});
}

test('accepted continuation releases only its old uncertainty for later ordinary confirmed same-file revisions',async t=>{
 let phase='original',index=0;
 const original=[tool('start_work',{action:'start',reason:'save source',plan:plan('saved A')}),tool('read',{path:'a.txt'}),
   tool('edit',{path:'a.txt',edits:[{oldText:'base A',newText:'saved A'}]})];
 const recovery=[tool('read',{path:'a.txt'}),tool('accept_change'),tool('accept_change'),{text:'Saved A is checked and delivered.'}];
 const f=await fixture(t,({body},n,req,res)=>{
   if(phase==='original'){if(n===4){res.destroy();return null;}return original[n-1];}
   if(phase==='recovery')return recovery[index++]??{text:'Recovered'};
   if(phase==='failed-revision')return index++===0?tool('start_work',{action:'revise',reason:'explicit but unfulfilled goal',plan:plan('revised A')}):{text:'No implementation yet.'};
   const value=phase==='revision'?'revised A':'later A',before=phase==='revision'?'saved A':'revised A';
   const script=[tool('start_work',{action:'revise',reason:'new explicit user goal',plan:plan(value)}),
     tool('read',{path:'a.txt'}),tool('edit',{path:'a.txt',edits:[{oldText:before,newText:value}]}),tool('accept_change'),{text:value+' checked and delivered.'}];
   return script[index++]??{text:value+' delivered'};
 });
 const repo=repository(t),base=await projectSession(t,repo,f);
 const proposal=await runProjectTurn({...base,input:'Save A.',budget:{maxCalls:30}}),lost=await confirmProject(base,proposal);
 assert.equal(lost.record.status,'outcome_unknown',lost.record.error);
 const oldChild=readTask(f.home,lost.record.projectOperation.childTaskIds[0]);
 const unknown=readRequests(f.home,oldChild).find(r=>r.sent&&r.status==='outcome_unknown');assert.ok(unknown);
 phase='recovery';index=0;const recovered=await continueRoot(base,lost.record);
 assert.equal(recovered.record.status,'completed',recovered.record.error);
 const before=(await projectChatState(f.home,repo.project)).state;
 assert.equal(before.steps[0].attempts[0].status,'unknown');
 const proof=await completedContinuationEvidence(f.home,before);
 assert.ok(proof.some(fact=>fact.taskId===oldChild.id&&fact.requestIds.includes(unknown.id)),JSON.stringify(proof));
 const sentBeforeNegative=f.calls.length;
 for(const [name,alter] of [
   ['incomplete successor',s=>s.steps[0].attempts[1].status='blocked'],
   ['forged command',s=>s.commands[recovered.record.projectOperation.commandId].continuation.requestIds=[]],
   ['wrong scope',s=>s.steps[0].scope=['b.txt']],
   ['wrong formal line',s=>s.version=repo.baseVersion],
 ]) {
   const changed=structuredClone(before);alter(changed);
   assert.equal((await completedContinuationEvidence(f.home,changed)).length,0,name);
 }
 const completeRoot=readTask(f.home,recovered.record.id);
 writePrivateJson(join(f.home,'tasks',completeRoot.id+'.json'),{...completeRoot,status:'partial'});
 assert.equal((await completedContinuationEvidence(f.home,before)).length,0,'partial delivery cannot release occupancy');
 writePrivateJson(join(f.home,'tasks',completeRoot.id+'.json'),completeRoot);
 const acceptedChild=readTask(f.home,recovered.record.projectOperation.childTaskIds[0]),forged=structuredClone(acceptedChild);
 forged.work.acceptance[0].requestId=randomUUID();
 writePrivateJson(join(f.home,'tasks',forged.id+'.json'),forged);
 assert.equal((await completedContinuationEvidence(f.home,before)).length,0,'a made-up accepted receipt cannot release the old request');
 writePrivateJson(join(f.home,'tasks',acceptedChild.id+'.json'),acceptedChild);
 assert.equal(f.calls.length,sentBeforeNegative,'proof inspection performs no model request');
 for(const next of ['failed-revision','revision','again']) {
   phase=next;index=0;
   const proposal=await runProjectTurn({...base,input:next==='revision'?'Now revise A.':'Revise A once more.',budget:{maxCalls:12}});
   assert.equal(proposal.record.status,'blocked',proposal.record.error);
   const task=await confirmProject(base,proposal);
   if(next==='failed-revision')assert.notEqual(task.record.status,'completed');
   else assert.equal(task.record.status,'completed',task.record.error);
   assert.equal(task.record.projectOperation.continuation,undefined,'normal user revisions need no new unknown exception');
 }
 const after=(await projectChatState(f.home,repo.project)).state;
 assert.equal(after.steps[0].attempts.length,5);
 assert.equal(after.steps[0].attempts[0].status,'unknown');
 assert.equal(readRequests(f.home,readTask(f.home,oldChild.id)).find(r=>r.id===unknown.id).status,'outcome_unknown');
 assert.notEqual(after.callIntents.find(r=>r.id===unknown.id).notSent,true);
 const v=await createVersioning({home:f.home,project:repo.project,readOnly:true});
 try {assert.equal(Buffer.from((await v.read({version:after.version,path:'a.txt'})).contentBase64,'base64').toString(),'later A\n');}
 finally{await v.close();}
});

test('ordinary revision remains blocked when no verified accepted continuation has completed',async t=>{
 let original=true,index=0;
 const first=[tool('start_work',{action:'start',reason:'save source',plan:plan('saved A')}),tool('read',{path:'a.txt'}),
   tool('edit',{path:'a.txt',edits:[{oldText:'base A',newText:'saved A'}]})];
 const f=await fixture(t,(_,n,req,res)=>{
   if(original){if(n===4){res.destroy();return null;}return first[n-1];}
   index++;return tool('start_work',{action:'revise',reason:'new ordinary goal has no exception',plan:plan('revised A')});
 });
 const repo=repository(t),base=await projectSession(t,repo,f),proposal=await runProjectTurn({...base,input:'Save A.'}),lost=await confirmProject(base,proposal);
 assert.equal(lost.record.status,'outcome_unknown');const before=f.calls.length;
 original=false;
 const proposed=await runProjectTurn({...base,input:'Now revise A.'}),blocked=await confirmProject(base,proposed);
 assert.notEqual(blocked.record.status,'completed');assert.equal(index,1,'only the new user planning request is sent');
 assert.equal(f.calls.length,before+1);assert.deepEqual(blocked.record.projectOperation.childTaskIds,[]);
 const state=(await projectChatState(f.home,repo.project)).state;
 assert.deepEqual(await completedContinuationEvidence(f.home,state),[]);assert.equal(state.steps[0].attempts[0].status,'unknown');
});

test('ordinary staffing after accepted recovery does not reuse an old unknown assignment',async t=>{
 let phase='original',main=0;
 const original=[tool('start_work',{action:'start',reason:'save source and investigate',plan:plan('saved A')}),
   tool('read',{path:'a.txt'}),tool('edit',{path:'a.txt',edits:[{oldText:'base A',newText:'saved A'}]}),
   tool('project_staff',{action:'appoint',input:{id:'reader',responsibility:'Inspect A',scope:['a.txt'],readScope:['a.txt'],models:['fixture/r2'],need:'deliverable',reason:'Separate observation'}}),
   tool('delegate',{staffId:'reader',workId:'main:a.txt',model:'fixture/r2',assignment:'Inspect A',scope:[],readScope:['a.txt'],readOnly:true,reason:'Independent observation'}),
   tool('collect'),{text:'Draft saved; worker response lost.'}];
 const recovery=[tool('read',{path:'a.txt'}),tool('accept_change'),tool('accept_change'),{text:'Saved A checked.'}];
 const revised=[tool('start_work',{action:'revise',reason:'new ordinary user goal',plan:plan('revised A')}),
   tool('delegate',{staffId:'reader',workId:'main:a.txt',model:'fixture/r2',assignment:'Inspect the new goal',scope:[],readScope:['a.txt'],readOnly:true,reason:'New independent observation'}),
   tool('collect'),tool('read',{path:'a.txt'}),tool('edit',{path:'a.txt',edits:[{oldText:'saved A',newText:'revised A'}]}),
   tool('accept_change'),{text:'Revised A checked after the new observation.'}];
 const f=await fixture(t,({body},n,req,res)=>{
   if(JSON.stringify(body.messages).includes('cothink-process-observation'))return {text:'{"issues":[]}'};
   if(body.model==='r2'){if(phase==='original'){res.destroy();return null;}return {text:'The new goal and A evidence were independently inspected.'};}
   return (phase==='original'?original:phase==='recovery'?recovery:revised)[main++]??{text:'Done'};
 });
 const repo=repository(t),base=await projectSession(t,repo,f),proposal=await runProjectTurn({...base,input:'Save A and inspect it.',budget:{maxCalls:40}}),lost=await confirmProject(base,proposal);
 assert.equal(lost.record.status,'outcome_unknown',lost.record.error);
 const old=readTask(f.home,lost.record.projectOperation.childTaskIds[0]),oldId=old.members[0].memberId;
 const unknown=readRequests(f.home,old).find(r=>r.sent&&r.status==='outcome_unknown');assert.ok(unknown);
 phase='recovery';main=0;const recovered=await continueRoot(base,lost.record);assert.equal(recovered.record.status,'completed',recovered.record.error);
 phase='revised';main=0;const nextPlan=await runProjectTurn({...base,input:'Revise A with a new observation.',budget:{maxCalls:20}}),next=await confirmProject(base,nextPlan);
 assert.equal(next.record.status,'completed',next.record.error);
 const current=readTask(f.home,next.record.projectOperation.childTaskIds[0]);
 assert.equal(current.members.length,1);assert.notEqual(current.members[0].memberId,oldId);assert.equal(current.members[0].status,'completed');
 const state=(await projectChatState(f.home,repo.project)).state;
 assert.equal(state.staffAssignments[oldId].status,'unknown');assert.equal(state.callIntents.filter(call=>call.id===unknown.id).length,1);
 assert.equal(readRequests(f.home,readTask(f.home,old.id)).find(r=>r.id===unknown.id).status,'outcome_unknown');
});

test('a completed final-only continuation certifies its accepted inherited file successor for later revision',async t=>{
 const multi=value=>({goal:'Deliver A and verify B',scope:['a.txt','b.txt'],readScope:['a.txt','b.txt'],steps:[
   {id:'a',goal:'Deliver '+value,scope:['a.txt'],deliverables:['a.txt'],checks:plan(value).checks},
   {id:'b',goal:'Verify unchanged B',dependsOn:['a'],scope:['b.txt'],deliverables:['b.txt'],checks:[{command:'node',args:['-e',"if(require('fs').readFileSync('b.txt','utf8')!=='base B\\n')process.exit(1)"]}]},
 ]});
 let phase='original',index=0;
 const first=[tool('start_work',{action:'start',reason:'two checked steps',plan:multi('saved A')}),tool('read',{path:'a.txt'}),tool('edit',{path:'a.txt',edits:[{oldText:'base A',newText:'saved A'}]})];
 const recovered=[tool('read',{path:'a.txt'}),tool('accept_change'),tool('accept_change'),{text:'A checked'}, {text:'B checked'}];
 const revised=[tool('start_work',{action:'revise',reason:'new user goal after recovered delivery',plan:multi('revised A')}),tool('read',{path:'a.txt'}),
   tool('edit',{path:'a.txt',edits:[{oldText:'saved A',newText:'revised A'}]}),tool('accept_change'),{text:'Revised A checked'},{text:'B checked'},{text:'Both delivered'}];
 const f=await fixture(t,(_,n,req,res)=>{
   if(phase==='original'){if(n===4){res.destroy();return null;}return first[n-1];}
   if(phase==='recovery'){if(index===5){index++;res.destroy();return null;}return recovered[index++];}
   if(phase==='final')return {text:'Both files delivered with original unknowns retained.'};
   return revised[index++]??{text:'Delivered'};
 });
 const repo=repository(t),base=await projectSession(t,repo,f),proposed=await runProjectTurn({...base,input:'Deliver A and verify B.',budget:{maxCalls:30}}),original=await confirmProject(base,proposed);
 const oldChild=readTask(f.home,original.record.projectOperation.childTaskIds[0]),oldUnknown=readRequests(f.home,oldChild).find(r=>r.sent&&r.status==='outcome_unknown');
 phase='recovery';index=0;const lostFinal=await continueRoot(base,original.record);
 assert.equal(lostFinal.record.status,'outcome_unknown',lostFinal.record.error);assert.ok(lostFinal.record.deliveryRef);
 phase='final';const delivered=await continueRoot(base,lostFinal.record);assert.equal(delivered.record.status,'completed',delivered.record.error);
 assert.equal(delivered.record.projectOperation.continuation.stepId,null);
 assert.deepEqual(delivered.record.projectOperation.childTaskIds,[]);
 const state=(await projectChatState(f.home,repo.project)).state;
 assert.ok((await completedContinuationEvidence(f.home,state)).some(fact=>fact.requestIds.includes(oldUnknown.id)));
 phase='revision';index=0;const proposal=await runProjectTurn({...base,input:'Now revise A and keep B.',budget:{maxCalls:15}}),changed=await confirmProject(base,proposal);
 assert.equal(changed.record.status,'completed',changed.record.error);
 const v=await createVersioning({home:f.home,project:repo.project,readOnly:true});
 try {assert.equal(Buffer.from((await v.read({version:(await v.inspect()).version,path:'a.txt'})).contentBase64,'base64').toString(),'revised A\n');}
 finally {await v.close();}
 assert.equal(readRequests(f.home,readTask(f.home,oldChild.id)).find(r=>r.id===oldUnknown.id).status,'outcome_unknown');
});


for(const disconnect of [false,true])test('accepted root work can pass to an employee '+(disconnect?'after a zero-file continuation':'after the manager narrows its next change'),async t=>{
 let main=0,employee=0,memberId,failure,interrupted=false;
 const spec={goal:'Manager delivers a.txt, then an employee independently executes its exact check.',
  scope:['a.txt','b.txt'],readScope:['a.txt','b.txt'],deliverables:['a.txt'],collaboration:{workers:1},
  checks:[{command:'node',args:['-e',"if(require('fs').readFileSync('a.txt','utf8')!=='delivered A\\n')process.exit(1)"]}]};
 const assignment={staffId:'checker',model:'fixture/r1',scope:['a.txt'],readScope:['a.txt'],
  assignment:'Read and run the exact check on the formally accepted a.txt, report the result; do not change files.',reason:'An actual employee verifies the manager deliverable.'};
 const f=await fixture(t,({body},n,req,res)=>{try{
  if(JSON.stringify(body.messages).includes('cothink-process-observation'))return {text:'{"issues":[]}'};
  const names=(body.tools??[]).map(x=>x.function.name),last=body.messages.findLast(x=>x.role==='tool')?.content??'';
  if(main===0){main++;return tool('start_work',{action:'start',reason:'bounded handoff',plan:spec});}
  if(names.includes('accept_change'))switch(++main){
   case 2:return tool('read',{path:'a.txt'});
   case 3:return tool('edit',{path:'a.txt',edits:[{oldText:'base A',newText:'delivered A'}]});
   case 4:return tool('project_staff',{action:'appoint',input:{id:'checker',responsibility:'Check a.txt',models:['fixture/r1'],scope:['a.txt'],need:'deliverable',reason:'Independent execution of the exact file check'}});
   case 5:return tool('delegate',assignment);
   case 6:assert.match(last,/Root already owns this work/,'unaccepted root work stays held');return tool('accept_change');
   case 7:if(JSON.parse(last).status==='review_required'){main--;return tool('accept_change');}assert.equal(JSON.parse(last).status,'accepted',last);return tool('next_change',{scope:['b.txt'],readScope:['a.txt','b.txt'],reason:'Retain only unrelated manager work after formal acceptance'});
   case 8:if(disconnect&&!interrupted){interrupted=true;res.destroy();return null;}return tool('delegate',assignment);
   case 9:memberId=JSON.parse(last).memberId;assert.ok(memberId,'accepted root claim must not block the employee: '+last);return tool('collect',{memberId});
   default:assert.match(last,/VERIFIED_DELIVERY/);return {text:'Manager file delivered and employee verification collected.'};
  }
  if(!names.includes('bash'))return {text:'I understand the independent exact-file check and will use only my authorized tools.'};
  return [tool('read',{path:'a.txt'}),tool('bash',{command:"node -e \"if(require('fs').readFileSync('a.txt','utf8')!=='delivered A\\\\n')process.exit(1);console.log('VERIFIED_DELIVERY')\""}),{text:'VERIFIED_DELIVERY: read actual a.txt and exact command exited 0; no source modifications.'}][employee++]??{text:'VERIFIED_DELIVERY'};
 }catch(error){failure??=error;return {text:'Fixture failure retained.'};}});
 const repo=repository(t),base=await projectSession(t,repo,f);
 const proposed=await runProjectTurn({...base,input:spec.goal,budget:{maxCalls:22}});let result=await confirmProject(base,proposed);
 if(disconnect){
  assert.equal(result.record.status,'outcome_unknown',result.record.error);
  const old=readTask(f.home,result.record.projectOperation.childTaskIds[0]),unknown=readRequests(f.home,old).find(r=>r.status==='outcome_unknown');
  const inspection=await inspectFileContinuation({home:f.home,sourceRootTaskId:result.record.id});
  assert.equal(inspection.eligible,true,JSON.stringify(inspection.blockers));assert.deepEqual(inspection.restorePaths,[]);
  main=7;result=await continueRoot(base,result.record);
  assert.equal(readRequests(f.home,readTask(f.home,old.id)).find(r=>r.id===unknown.id).status,'outcome_unknown');
 }
 if(failure)throw failure;
 assert.equal(result.record.status,'completed',result.record.error);
 const child=readTask(f.home,result.record.projectOperation.childTaskIds[0]);
 assert.equal(child.members.length,1);assert.equal(child.members[0].memberId,memberId);assert.equal(child.members[0].collected,true);
 assert.equal(result.record.collaborationResult[0].status,'fulfilled');
 assert.ok(child.tools.some(x=>x.name==='bash'&&x.exitCode===0));
 if(!disconnect)assert.ok(child.work.acceptance.some(x=>x.status==='accepted'&&x.verification==='passed'));
 else assert.equal(child.work.changes.find(c=>c.actor==='main').readOnly,true,'matching formal bytes require no restore write');
});
