import test from 'node:test';
import assert from 'node:assert/strict';
import {rmSync} from 'node:fs';
import {join} from 'node:path';
import {fixture} from './helpers/pi-fixture.js';
import {repository} from './helpers/git-fixture.js';
import {projectSession,confirmProject} from './unified-project.fixture.js';
import {runProjectTurn} from '../src/project-turn.js';
import {createTask,readTask,readRequests} from '../src/task.js';
import {createVersioning} from '../src/versioning.js';
import {inspectFileContinuation,restorationPaths,assertContinuationRequests} from '../src/project-continuation.js';
import {reserveFileContinuation} from '../src/project-file-confirmation.js';
import {createWorkChanges} from '../src/work-changes.js';
import {replace,accept} from '../packages/agent-sync/test/helpers/repository.js';
import {writePrivateJson} from '../src/storage.js';
import {executionFacts} from '../src/project-delivery-checks.js';

test('exact public restore preserves unrelated additions, deletion and mode; overlapping change conflicts',async t=>{
 const repo=repository(t,{cleanup:false}),v=await createVersioning({home:repo.home,project:repo.project});t.after(async()=>{await v.close();rmSync(repo.root,{recursive:true,force:true});});
 const old=await v.beginChange({requestId:'saved-begin',actor:'main',intent:'saved draft',scope:['.'],readScope:['.']});
 await replace(v,old,'a.txt','saved A\n','save-a',{mode:'100755'});
 await replace(v,old,'b.txt',null,'delete-b');
 await replace(v,old,'new.txt','saved new\n','add-new');
 const draft={taskId:'unused',changeId:old.changeId,baseVersion:old.baseVersion,version:(await v.inspect({changeId:old.changeId})).privateVersion};
 await v.abandonChange(old.changeId);
 const later=await v.beginChange({requestId:'later-begin',actor:'later',intent:'unrelated formal change',scope:['later.txt'],readScope:['.']});
 await replace(v,later,'later.txt','keep later\n','later-edit');await accept(v,later,'later-accept');
 const formal=(await v.inspect()).version,restore=await restorationPaths(v,draft,formal,['.']);
 assert.deepEqual(new Set(restore.paths),new Set(['a.txt','b.txt','new.txt']));assert.deepEqual(restore.conflicts,[]);
 const restored=await v.beginChange({requestId:'restore-begin',actor:'continued',intent:'exact saved draft',scope:restore.paths,readScope:['.'],baseVersion:formal,restoreFrom:draft.version});
 assert.equal((await v.read({changeId:restored.changeId,path:'a.txt'})).mode,'100755');
 assert.equal((await v.read({changeId:restored.changeId,path:'b.txt'})).contentBase64,null);
 assert.equal(Buffer.from((await v.read({changeId:restored.changeId,path:'later.txt'})).contentBase64,'base64').toString(),'keep later\n');
 await accept(v,restored,'restore-accept');
 assert.deepEqual((await restorationPaths(v,draft,(await v.inspect()).version,['.'])).paths,[],'already restored paths are not repeated');
 const overlap=await v.beginChange({requestId:'overlap-begin',actor:'later',intent:'overlap',scope:['a.txt'],readScope:['.']});
 await replace(v,overlap,'a.txt','conflicting A\n','conflict-edit');await accept(v,overlap,'conflict-accept');
 assert.deepEqual((await restorationPaths(v,draft,(await v.inspect()).version,['.'])).conflicts,['a.txt']);
});

test('one disconnected fixture checks stale, external effect, closure and budget rejection without another request',async t=>{
 const tool=(name,args)=>({toolCalls:[{name,args}]});
 const plan={goal:'Change a.txt',scope:['a.txt'],deliverables:['a.txt'],checks:[{command:'node',args:['-e','process.exit(0)']}]};
 const replies=[tool('start_work',{action:'start',reason:'edit',plan}),tool('read',{path:'a.txt'}),tool('edit',{path:'a.txt',edits:[{oldText:'base A',newText:'saved A'}]})];
 const f=await fixture(t,(_,n,req,res)=>{if(n===4){res.destroy();return null;}return replies[n-1]??{text:'unexpected'};});
 const repo=repository(t),base=await projectSession(t,repo,f),proposal=await runProjectTurn({...base,input:'Change a.txt.',budget:{maxCalls:12}}),root=await confirmProject(base,proposal);
 const original=readTask(f.home,root.record.id),count=f.calls.length;
 const inspect=()=>inspectFileContinuation({home:f.home,sourceRootTaskId:original.id});
 const checked=await inspect();assert.equal(checked.eligible,true,JSON.stringify(checked.blockers));
 for(const [name,mutate,code] of [
   ['cost cap',r=>r.budget.maxCost=1,'COST_UNKNOWN'],
   ['calls exhausted',r=>r.budget.maxCalls=r.rootRequests.filter(x=>!x.notSent).length,'ROOT_BUDGET'],
   ['stop failure',r=>r.localExecutionCloseError='stop failed','LOCAL_CLOSE_FAILED'],
   ['closure not saved',r=>r.localExecutionClosedAt=null,'LOCAL_CLOSE_MISSING'],
   ['native process unclosed',r=>(r.tools??=[]).push({nativeBackground:true,id:'old-native-id'}),'EXECUTION_STOP_UNKNOWN'],
   ['cancelled',r=>r.cancelRequestedAt=new Date().toISOString(),'CONTINUATION_CANCELLED'],
   ['external MCP',r=>(r.tools??=[]).push({kind:'project_mcp_call',requestId:'original-mcp-id',status:'outcome_unknown'}),'MCP_PENDING'],
 ]) {
   const changed=structuredClone(original);mutate(changed);writePrivateJson(join(f.home,'tasks',original.id+'.json'),changed);
   const result=await inspect();assert.equal(result.eligible,false,name);assert.ok(result.blockers.some(b=>b.code===code),JSON.stringify(result.blockers));
   assert.equal(f.calls.length,count,name+' must not send');
 }
 writePrivateJson(join(f.home,'tasks',original.id+'.json'),original);
 const args={home:f.home,sessionId:original.sessionId,sourceRootTaskId:original.id,draft:checked.draft,submissionId:'receipt',authorizationSource:{kind:'file_continuation',sourceTaskId:original.id,mode:'user'},expectedRevision:checked.revision,expectedFormalVersion:checked.formalVersion};
 const emptyDraft=await inspectFileContinuation({home:f.home,sourceRootTaskId:original.id,draft:null});
 assert.equal(emptyDraft.eligible,false,'explicit null cannot select a file draft');
 assert.ok(emptyDraft.blockers.some(b=>b.code==='DRAFT_REQUIRED'));
 await assert.rejects(reserveFileContinuation({...args,draft:null}),{code:'CONTINUATION_BLOCKED'});
 assert.equal(readTask(f.home,original.id).fileContinuationIntent,undefined,'null draft cannot reserve an execution attempt');
 assert.equal(f.calls.length,count,'null draft cannot send another model request');
 await assert.rejects(reserveFileContinuation({...args,expectedRevision:checked.revision+1}),{code:'PROPOSAL_STALE'});
 await assert.rejects(reserveFileContinuation({...args,authorizationSource:{kind:'model',sourceTaskId:original.id}}),{code:'CONTINUATION_AUTH'});
 await assert.rejects(reserveFileContinuation({...args,save(){throw Error('disk failure');}}),/disk failure/);
 assert.equal(readTask(f.home,original.id).fileContinuationIntent,undefined,'failed save issues no durable permit');
 const claim=original.rootRequests.find(r=>checked.requestIds.includes(r.requestId));
 const request=readRequests(f.home,readTask(f.home,claim.taskId)).find(r=>r.id===claim.requestId);
 assertContinuationRequests(f.home,{sourceRootTaskId:original.id,requestIds:checked.requestIds});
 writePrivateJson(join(f.home,'requests',request.id+'.json'),{...request,status:'completed'});
 assert.throws(()=>assertContinuationRequests(f.home,{sourceRootTaskId:original.id,requestIds:checked.requestIds}),{code:'PROPOSAL_STALE'});
 writePrivateJson(join(f.home,'requests',request.id+'.json'),request);
 const legacy=structuredClone(original);delete legacy.localExecutionClosedAt;
 writePrivateJson(join(f.home,'tasks',original.id+'.json'),legacy);
 assert.equal((await inspect()).eligible,true,'old closure can be recomputed from original ended requests and public stopped changes');
 assert.equal(f.calls.length,count);
});


test('lost restore receipt queries the same public operation and never allocates a second change',async t=>{
 const repo=repository(t,{cleanup:false}),v=await createVersioning({home:repo.home,project:repo.project});
 t.after(async()=>{await v.close();rmSync(repo.root,{recursive:true,force:true});});
 const draft=await v.beginChange({requestId:'draft-begin',actor:'main',scope:['a.txt'],readScope:['.'],intent:'saved draft'});
 await replace(v,draft,'a.txt','saved bytes\n','draft-edit');
 const version=(await v.inspect({changeId:draft.changeId})).privateVersion;
 await v.abandonChange(draft.changeId);
 const formal=(await v.inspect()).version;
 const task=createTask({home:repo.home,input:'restore saved version',models:{main:{},secondary:[]}});
 const work=task.record.work={requests:[],changes:[]};let calls=0;
 const wrapped={...v,async beginChange(...args){calls++;const actual=await v.beginChange(...args);throw Object.assign(Error('lost restore response'),{actual});}};
 const changes=createWorkChanges({task,work,members:new Map(),observerErrors:[],save:task.save,guard(){},notify(){},
   getVersioning:()=>wrapped,getPluginWork:()=>null,getMainBinding:()=>null,
   syncChange(value){const old=work.changes.find(c=>c.changeId===value.changeId);if(old)Object.assign(old,value);else work.changes.push(value);task.save();return value;}});
 const options={requestId:'saved-restore',baseVersion:formal,restoreFrom:version};
 let lost;
 try {await changes.begin('main',['a.txt'],['.'],'restore',false,options);}catch(error){lost=error.actual;}
 assert.ok(lost?.changeId,'the real public restore completed before response loss');
 const restored=await changes.begin('main',['a.txt'],['.'],'restore',false,options);
 assert.equal(restored.changeId,lost.changeId);assert.equal(calls,1);
 assert.equal(Buffer.from((await v.read({changeId:restored.changeId,path:'a.txt'})).contentBase64,'base64').toString(),'saved bytes\n');
 work.requests.push({action:'beginChange',requestId:'missing-restore',status:'preparing',dispatched:true});task.save();
 await assert.rejects(changes.begin('main',['a.txt'],['.'],'restore',false,{...options,requestId:'missing-restore'}),{code:'OPERATION_UNKNOWN'});
 assert.equal(calls,1,'not_found without an undispatched receipt cannot replay the old restore');
 assert.equal((await v.inspect()).version,formal,'restoration did not accept anything');
});


test('an explicit public begin validation rejection is unsent; absent or uncertain receipts stay unknown',async t=>{
 const repo=repository(t,{cleanup:false}),v=await createVersioning({home:repo.home,project:repo.project});
 t.after(async()=>{await v.close();rmSync(repo.root,{recursive:true,force:true});});
 const task=createTask({home:repo.home,input:'Inspect already accepted files',models:{main:{},secondary:[]}});
 const work=task.record.work={requests:[],changes:[],operations:[]};
 const changes=createWorkChanges({task,work,members:new Map(),observerErrors:[],save:task.save,guard(){},notify(){},
  getVersioning:()=>v,getPluginWork:()=>null,getMainBinding:()=>null,syncChange:value=>value});
 await assert.rejects(changes.begin('main',[],['a.txt'],'empty restoration',false,{requestId:'empty-restore'}),{code:'SCOPE'});
 assert.equal((await v.inspect({requestId:'empty-restore'})).status,'not_found');
 assert.equal(work.requests[0].status,'rejected');assert.equal(work.requests[0].error.code,'SCOPE');
 const facts=await executionFacts(v,task.record,[]);
 assert.equal(facts.kernelRequests[0].status,'not_sent');assert.deepEqual(facts.operationUnknown,[]);
 for(const patch of [{status:'preparing'},{status:'outcome_unknown'},{error:{code:'UNKNOWN'}},{action:'acceptChange'}]){
  const record=structuredClone(task.record);Object.assign(record.work.requests[0],patch);
  assert.ok((await executionFacts(v,record,[])).operationUnknown.includes('empty-restore'));
 }
});

test('old restored-scope rejection keeps its failed check and resumes only the original grant',async t=>{
 const {executeConfirmed}=await import('../src/project-turn.js');
 const {projectChatState}=await import('../src/project.js');
 const {readFileSync}=await import('node:fs');
 const tool=(name,args={})=>({toolCalls:[{name,args}]});
 const plan={goal:'Deliver A and B',scope:['a.txt','b.txt'],readScope:['a.txt','b.txt'],deliverables:['a.txt','b.txt'],
  checks:[{command:'node',args:['-e',"const f=require('fs');if(f.readFileSync('a.txt','utf8')!=='saved A\\n'||f.readFileSync('b.txt','utf8')!=='finished B\\n')process.exit(1)"]}]};
 let phase=0,index=0;
 const f=await fixture(t,(_,n,req,res)=>{
  if(phase===0){if(n===4){res.destroy();return null;}return [tool('start_work',{action:'start',reason:'files',plan}),tool('read',{path:'a.txt'}),tool('edit',{path:'a.txt',edits:[{oldText:'base A',newText:'saved A'}]})][n-1];}
  if(phase===1)return [tool('refresh_change',{scope:['a.txt','b.txt'],readScope:['a.txt','b.txt'],reason:'original step grant'}),
   tool('read',{path:'b.txt'}),tool('write',{path:'b.txt',content:'unfinished B\n'}),tool('prepare_change',{check:true}),{text:'Keep the failed check.'}][index++]??{text:'Stopped'};
  return [tool('refresh_change',{scope:['a.txt','b.txt'],readScope:['a.txt','b.txt'],reason:'original step grant'}),
   tool('read',{path:'b.txt'}),tool('write',{path:'b.txt',content:'finished B\n'}),tool('accept_change'),tool('accept_change'),{text:'Delivered'}][index++]??{text:'Delivered'};
 });
 const repo=repository(t),base=await projectSession(t,repo,f),proposal=await runProjectTurn({...base,input:'Deliver A and B.',budget:{maxCalls:40}}),first=await confirmProject(base,proposal);
 const resume=async root=>{
  const fact=await inspectFileContinuation({home:f.home,sourceRootTaskId:root.id});assert.equal(fact.eligible,true,JSON.stringify(fact));
  const reservation=await reserveFileContinuation({home:f.home,sessionId:root.sessionId,sourceRootTaskId:root.id,draft:fact.draft,
   submissionId:'resume-'+root.id,authorizationSource:{kind:'file_continuation',sourceTaskId:root.id,mode:'user'},expectedRevision:fact.revision,expectedFormalVersion:fact.formalVersion});
  const source=readTask(f.home,root.id);index=0;
  return runProjectTurn({...base,input:root.input,taskId:reservation.taskId,submissionId:reservation.submissionId,budget:reservation.budgetSource.remaining,
   confirmedOperation:{source,reservation,execute:task=>executeConfirmed(task,source,reservation)}});
 };
 phase=1;const middle=await resume(first.record);assert.notEqual(middle.record.status,'completed');
 const {state}=await projectChatState(f.home,repo.project),step=state.steps[0],child=readTask(f.home,middle.record.projectOperation.childTaskIds[0]);
 assert.equal(step.route.kind,'failed','a genuine fixed-check failure still enters the normal route');
 const v=await createVersioning({home:f.home,project:repo.project,readOnly:true});
 try{
  const restore=await v.inspect({requestId:child.work.restoreRequestId}),failed=structuredClone(step.route),statePath=join(f.home,'project-delivery',state.id,'state.json'),childPath=join(f.home,'tasks',child.id+'.json');
  // Replay the old host's scope-rejection metadata over real restore/refresh/check receipts.
  step.route={...failed,kind:'scope_expansion',status:'blocked',candidate:restore.privateVersion,privateVersion:restore.privateVersion,
   evidence:{previousScope:restore.scope,requestedScope:step.scope},recheck:{candidate:failed.candidate,evidence:failed.evidence}};
  child.work.requests.push({action:'refreshChange',changeId:restore.changeId,requestId:'old-scope-rejection',status:'rejected',dispatched:false,error:{code:'PROJECT_ROUTE'}});
  writePrivateJson(statePath,state);writePrivateJson(childPath,child);
  const oldTask=readFileSync(childPath),originalRequest=readRequests(f.home,readTask(f.home,first.record.projectOperation.childTaskIds[0])).find(r=>r.status==='outcome_unknown');
  const unknownPath=join(f.home,'requests',originalRequest.id+'.json'),oldUnknown=readFileSync(unknownPath);
  const good=await inspectFileContinuation({home:f.home,sourceRootTaskId:middle.record.id});assert.equal(good.eligible,true,JSON.stringify(good));assert.equal(good.requiresManual,true);
  await assert.rejects(reserveFileContinuation({home:f.home,sessionId:middle.record.sessionId,sourceRootTaskId:middle.record.id,draft:good.draft,
   submissionId:'automatic-reclassification',authorizationSource:{kind:'file_continuation',sourceTaskId:middle.record.id,mode:'preauthorized_once'},expectedRevision:good.revision,expectedFormalVersion:good.formalVersion}));
  for(const corrupt of [route=>route.evidence.requestedScope.push('outside.txt'),route=>route.candidate='wrong',route=>route.kind='failed']){
   const bad=structuredClone(state);corrupt(bad.steps[0].route);writePrivateJson(statePath,bad);
   assert.ok((await inspectFileContinuation({home:f.home,sourceRootTaskId:middle.record.id})).blockers.some(b=>b.code==='PROJECT_ROUTE'));
  }
  writePrivateJson(statePath,state);phase=2;const done=await resume(middle.record);assert.equal(done.record.status,'completed',done.record.error);
  const after=(await projectChatState(f.home,repo.project)).state;
  assert.ok(after.steps[0].routeHistory.some(r=>r.status==='blocked'&&r.recheck.evidence.checks.some(c=>c.exitCode!==0)&&r.scopeRestoration));
  assert.equal(Buffer.from((await v.read({version:after.version,path:'b.txt'})).contentBase64,'base64').toString(),'finished B\n');
  assert.deepEqual(readFileSync(childPath),oldTask);assert.deepEqual(readFileSync(unknownPath),oldUnknown);
 }finally{await v.close();}
});

test('known acceptance isolates an old local edit without claiming its missing receipt succeeded',async t=>{
 const {execution}=await import('./helpers/agent-sync-fixture.js');
 const repo=repository(t,{cleanup:false}),checks=[{command:'node',args:['-e',"if(require('fs').readFileSync('a.txt','utf8')!=='kept A\\n')process.exit(1)"]}];
 const v=await createVersioning({home:repo.home,project:repo.project,execution,checks});
 t.after(async()=>{await v.close();rmSync(repo.root,{recursive:true,force:true});});
 const change=await v.beginChange({requestId:'begin-local',actor:'main',intent:'bounded local edit',scope:['a.txt'],readScope:['a.txt']});
 await replace(v,change,'a.txt','kept A\n','known-edit');
 const row={action:'edit',requestId:'old-missing-edit',changeId:change.changeId,status:'outcome_unknown'};
 const record={work:{execution,changes:[change],requests:[row]}};
 assert.ok((await executionFacts(v,record,[])).pendingEffects.some(p=>p.code==='KERNEL_PENDING'));
 const accepted=await accept(v,change,'known-accept');assert.equal(accepted.status,'accepted');
 const facts=await executionFacts(v,record,[]);
 assert.deepEqual(facts.pendingEffects,[]);assert.equal(facts.kernelRequests[0].status,'not_found');assert.equal(facts.kernelRequests[0].isolatedClosed,true);
 assert.deepEqual(facts.operationUnknown,['old-missing-edit']);assert.equal(row.status,'outcome_unknown');
 for(const action of ['acceptChange','importEdits']){
  const unknown={...record,work:{...record.work,requests:[{...row,action}]}};
  assert.ok((await executionFacts(v,unknown,[])).pendingEffects.some(p=>p.code==='KERNEL_PENDING'));
 }
 const external={...record,work:{...record.work,execution:{...execution,network:'bridge'}}};
 assert.ok((await executionFacts(v,external,[])).pendingEffects.some(p=>p.code==='KERNEL_PENDING'));
 assert.equal(Buffer.from((await v.read({version:accepted.acceptedVersion,path:'a.txt'})).contentBase64,'base64').toString(),'kept A\n');
});
