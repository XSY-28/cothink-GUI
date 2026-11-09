import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,watch} from 'node:fs';
import {join} from 'node:path';
import {fixture} from './helpers/pi-fixture.js';
import {repository,git} from './helpers/git-fixture.js';
import {execution} from './helpers/agent-sync-fixture.js';
import {runProjectTurn,reserveConfirmation,confirmationState,executeConfirmed,resolveDelivery,digest} from '../src/project-turn.js';
import {runProjectCommand} from '../src/project.js';

const deliveryContext=record=>record.handoffContext;

test('unified proposal confirmation performs real checked accepted edit with owned lineage and stable replay',async t=>{
 const repo=repository(t);
 const plan={goal:'Change a.txt',scope:['a.txt'],deliverables:['a.txt'],checks:[{command:'node',args:['-e',"if(!require('fs').readFileSync('a.txt','utf8').includes('changed A'))process.exit(1)"]}]};
 const replies=[{toolCalls:[{name:'start_work',args:{action:'start',reason:'edit',plan}}]},
 {toolCalls:[{name:'read_skill',args:{name:'doc-maintenance'}}]},
 {toolCalls:[{name:'read',args:{path:'a.txt'}}]},
 {toolCalls:[{name:'edit',args:{path:'a.txt',edits:[{oldText:'base A',newText:'changed A'}]}}]},
 {toolCalls:[{name:'accept_change',args:{}}]},{text:'Changed A'}];
 const f=await fixture(t,(_,n)=>replies[n-1]??{text:'done'});
 const config={formatVersion:2,...f.models,secondary:[],work:{execution}};
 const base=await projectSession(t,repo,f),manager=base.mainRuntime.sessionManager;
 manager.appendMessage({role:'user',content:[{type:'text',text:'COMPACTED_RAW_MUST_STAY_OMITTED'}],timestamp:0});
 const earlier=manager.appendMessage({role:'user',content:[{type:'text',text:'EARLIER_USER_MARKER'}],timestamp:1});
 manager.appendMessage({role:'assistant',content:[{type:'text',text:'HISTORICAL_ASSISTANT_MARKER'}],timestamp:2});
 const summary=manager.appendCompaction('DERIVED_SUMMARY_MARKER',earlier,123,{cothinkContext:{taskId:'summary-operation',sessionId:manager.getSessionId(),sourceLeaf:earlier}});
 const source=await runProjectTurn({...base,input:'Change a.txt; retain UNIQUE_USER_CONSTRAINT',frozenConfig:config,budget:{maxCalls:8}});
 manager.appendMessage({role:'user',content:[{type:'text',text:'LATER_MUST_NOT_REBUILD_CONTEXT'}],timestamp:3});
 assert.equal(source.record.status,'blocked',source.record.error);assert.ok(source.record.proposal);
 const hash=digest(source.record.proposal);
 const reservation=await reserveConfirmation({home:f.home,source:source.record,proposalRef:source.record.proposalRef,sessionId:source.record.sessionId,workspaceId:null,submissionId:'confirm-1',save:source.save});
 const again=await reserveConfirmation({home:f.home,source:source.record,proposalRef:source.record.proposalRef,sessionId:source.record.sessionId,workspaceId:null,submissionId:'confirm-2',save:source.save});
 assert.equal(again.taskId,reservation.taskId);assert.equal(reservation.budgetSource.remaining.maxCalls,7);assert.equal(digest(source.record.proposal),hash);
 assert.equal((await confirmationState({home:f.home,source:source.record,reservation})).mayCreate,true);
 const root=await runProjectTurn({home:f.home,cwd:repo.project,input:source.record.input,workspace:source.record.workspace,frozenConfig:config,budget:reservation.budgetSource.remaining,taskId:reservation.taskId,submissionId:reservation.submissionId,
 confirmedOperation:{source:source.record,reservation,execute:task=>executeConfirmed(task,source.record,reservation)}});
 assert.equal(root.record.status,'completed',root.record.error);
 assert.ok(JSON.stringify(f.calls[1].body.messages).includes('Change a.txt; retain UNIQUE_USER_CONSTRAINT'),'actual formal worker receives verbatim user constraint omitted by plan');
 const workerContext=JSON.stringify(f.calls[1].body.messages);
 for(const value of ['EARLIER_USER_MARKER','HISTORICAL_ASSISTANT_MARKER','DERIVED_SUMMARY_MARKER',earlier,summary,'summary-operation'])assert.ok(workerContext.includes(value),value);
 assert.doesNotMatch(workerContext,/LATER_MUST_NOT_REBUILD_CONTEXT|COMPACTED_RAW_MUST_STAY_OMITTED/);
 assert.ok(deliveryContext(root.record).materials.some(x=>x.kind==='assistant'&&x.ref.id));
 const {resolveHandoffContext}=await import('../src/project-turn.js');
 assert.throws(()=>resolveHandoffContext(f.home,root.record.id,{...root.record.projectOperation.contextRef,sha256:'bad'},{commandId:root.record.projectOperation.commandId}),/reference/);
 assert.throws(()=>resolveHandoffContext(f.home,root.record.id,root.record.projectOperation.contextRef,{commandId:'wrong-owner'}),/owner/);
 assert.equal(root.record.finalCallId,null);assert.equal(root.record.projectOperation.childTaskIds.length,1);
 const delivery=resolveDelivery(f.home,root.record);assert.equal(delivery.length,1);assert.equal(delivery[0].relation,'owned');
 for(const record of [root.record,delivery[0].record])assert.deepEqual(record.skillResources.map(s=>({name:s.name,hash:s.hash,files:s.files})),source.record.skillResources.map(s=>({name:s.name,hash:s.hash,files:s.files})),'proposal, confirmed root and PROJECT child retain identical frozen resources');
 assert.equal(readFileSync(join(delivery[0].record.work.resultWorkspace,'a.txt'),'utf8'),'changed A\n');
 assert.equal(readFileSync(join(repo.project,'a.txt'),'utf8'),'base A\n');
 assert.equal(root.record.rootRequests.filter(r=>!r.notSent).length,5);
 assert.ok(delivery[0].record.tools.some(x=>x.kind==='skill_resource_read'&&x.resourceName==='doc-maintenance'));
 await assert.rejects(runProjectCommand({home:f.home,cwd:repo.project,args:['resume']}),/owning GUI root/);
 git(repo.project,'status','--porcelain');const alternate=join(repo.root,'alternate');git(repo.project,'worktree','add','--detach',alternate,'HEAD');
 await assert.rejects(runProjectCommand({home:f.home,cwd:alternate,args:['resume']}),/another canonical worktree/);assert.equal(f.calls.length,6);
 const bad=structuredClone(root.record);bad.deliveryRef.sources[0].callId=source.record.requestIds[0];assert.throws(()=>resolveDelivery(f.home,bad),/provenance/);
});

test('formal project budget can refuse a child even when root budget remains',async t=>{
 const repo=repository(t),plan={goal:'Verify a.txt',scope:['a.txt'],budget:{maxCalls:0},deliverables:['a.txt'],checks:[{command:'node',args:['-e',"require('fs').accessSync('a.txt')"]}]};
 const f=await fixture(t,()=>({toolCalls:[{name:'start_work',args:{action:'start',reason:'verify',plan}}]}));const config={formatVersion:2,...f.models,work:{execution}};
 const source=await runProjectTurn({home:f.home,cwd:repo.project,input:'verify',workspace:{id:null,project:repo.project},frozenConfig:config,budget:{maxCalls:10}});
 const reservation=await reserveConfirmation({home:f.home,source:source.record,proposalRef:source.record.proposalRef,sessionId:source.record.sessionId,workspaceId:null,submissionId:'confirm',save:source.save});
 const root=await runProjectTurn({home:f.home,cwd:repo.project,input:source.record.input,workspace:source.record.workspace,frozenConfig:config,budget:reservation.budgetSource.remaining,taskId:reservation.taskId,submissionId:reservation.submissionId,confirmedOperation:{execute:task=>executeConfirmed(task,source.record,reservation)}});
 assert.notEqual(root.record.status,'completed');assert.equal(f.calls.length,1);assert.equal(root.record.budget.maxCalls,9);assert.equal(root.record.rootRequests.filter(c=>!c.notSent).length,0);
});

// Keep the actual Pi session so automatic resume uses the same authority branch.
async function projectSession(t,repo,f){
 const {createRuntime}=await import('../src/pi-runtime.js'),{cothinkExtension}=await import('../src/extensions/cothink.js');
 const host={allowWork:true,flow:'unified'},rt=await createRuntime({home:f.home,cwd:repo.project,modelRef:f.models.main,projectManaged:true,extensionFactories:[{name:'cothink',factory:cothinkExtension(host)}]});
 t.after(()=>rt.dispose());rt.hostContext=task=>{host.task=task;host.runtime=rt;};
 return {home:f.home,cwd:repo.project,workspace:{id:null,project:repo.project},frozenConfig:{formatVersion:2,...f.models,work:{execution}},mainRuntime:rt};
}
async function confirmProject(base,source,extra={}){
 const reservation=await reserveConfirmation({home:base.home,source:source.record,proposalRef:source.record.proposalRef,sessionId:source.record.sessionId,workspaceId:null,submissionId:'confirm-'+source.record.id,save:source.save});
 return runProjectTurn({...base,input:source.record.input,taskId:reservation.taskId,submissionId:reservation.submissionId,budget:reservation.budgetSource.remaining,...extra,confirmedOperation:{source:source.record,reservation,execute:task=>executeConfirmed(task,source.record,reservation)}});
}
test('cancellation during formal admission creates no resumable project or child sends',async t=>{
 const {projectChatState}=await import('../src/project.js');
 const repo=repository(t),plan={goal:'Verify a.txt',scope:['a.txt'],deliverables:['a.txt'],checks:[{command:'node',args:['-e',"require('fs').accessSync('a.txt')"]}]};let planRef;
 const f=await fixture(t,(_,n)=>n===1?{toolCalls:[{name:'start_work',args:{action:'start',reason:'verify',plan}}]}:{toolCalls:[{name:'start_work',args:{action:'resume',reason:'explain saved state',planRef}}]});
 const base=await projectSession(t,repo,f),source=await runProjectTurn({...base,input:'Verify a.txt'});
 const abort=new AbortController(),watchDir=join(f.home,'project-delivery','sessions');mkdirSync(watchDir,{recursive:true});let admissionObserved=false;
 // The real writer lock is created after the initial abort gate, immediately before awaited version admission.
 const watcher=watch(watchDir,(_event,name)=>{if(String(name).endsWith('.locks')){admissionObserved=true;watcher.close();abort.abort();}});t.after(()=>watcher.close());
 const root=await confirmProject(base,source,{signal:abort.signal});
 assert.equal(admissionObserved,true);assert.equal(root.record.status,'cancelled');assert.ok(root.record.cancelSettledAt);
 assert.equal((await projectChatState(f.home,repo.project)).state,null);assert.equal(root.record.executionBinding,undefined);assert.deepEqual(root.record.projectOperation.childTaskIds,[]);assert.equal(f.calls.length,1);
 assert.equal(root.record.projectOperation.commandId,source.record.confirmationIntent.commandId);
 planRef={taskId:root.record.id,field:'proposal',sha256:digest(root.record.proposal)};
 const later=await runProjectTurn({...base,input:'Explain the current state',contextTaskIds:[source.record.id,root.record.id]});
 assert.notEqual(later.record.status,'completed');assert.match(later.record.error,/No formal project/);assert.equal(later.record.projectOperation,undefined);assert.equal(f.calls.length,2);
});
test('stronger review on resume refuses old accepted delivery for automatic and confirmed execution',async t=>{
 const {projectChatState}=await import('../src/project.js'),{readTask}=await import('../src/task.js');
 const repo=repository(t),plan={goal:'Change a.txt',scope:['a.txt'],deliverables:['a.txt'],checks:[{command:'node',args:['-e',"if(require('fs').readFileSync('a.txt','utf8')!=='changed A\\n')process.exit(1)"]}]};let planRef;
 const replies=[{toolCalls:[{name:'start_work',args:{action:'start',reason:'edit',plan}}]}, {toolCalls:[{name:'read',args:{path:'a.txt'}}]}, {toolCalls:[{name:'edit',args:{path:'a.txt',edits:[{oldText:'base A',newText:'changed A'}]}}]}, {toolCalls:[{name:'accept_change',args:{}}]}, {text:'Changed A'}];
 let revise=false;
 const f=await fixture(t,(_,n)=>replies[n-1]??{toolCalls:[{name:'start_work',args:revise?{action:'revise',reason:'require independent review',plan:{...plan,independentReview:true}}:{action:'resume',reason:'continue saved delivery',planRef}}]});
 const base=await projectSession(t,repo,f),source=await runProjectTurn({...base,input:'Change a.txt'}),first=await confirmProject(base,source);
 assert.equal(first.record.status,'completed',first.record.error);const childId=first.record.projectOperation.childTaskIds[0],before=readTask(f.home,childId),projectBefore=(await projectChatState(f.home,repo.project)).state;
 planRef={taskId:first.record.id,field:'proposal',sha256:digest(first.record.proposal)};
 const automatic=await runProjectTurn({...base,input:'Continue with required independent review',frozenConstraints:{requireDifferentModelReview:true},contextTaskIds:[first.record.id]});
 await t.test('same-session automatic resume is incomplete',()=>{assert.notEqual(automatic.record.status,'completed');assert.match(automatic.record.error,/异型号独立评审.*当前项目修订/);assert.equal(automatic.record.deliveryRef,undefined);assert.equal(automatic.record.projectOperation,undefined);assert.equal(f.calls.length,6);});
 // A different actual session needs confirmation. Tighten the confirmed root too, so the dispatch boundary must independently reject stale/legacy weaker proposals.
 const other=await projectSession(t,repo,f),pending=await runProjectTurn({...other,input:'Resume saved project',contextTaskIds:[first.record.id]});assert.ok(pending.record.proposalRef);
 const confirmed=await confirmProject(other,pending,{frozenConstraints:{requireDifferentModelReview:true}});
 await t.test('explicit confirmation cannot weaken the current root requirement',()=>{assert.notEqual(confirmed.record.status,'completed');assert.match(confirmed.record.error,/异型号独立评审.*当前项目修订/);assert.equal(confirmed.record.deliveryRef,undefined);assert.deepEqual(confirmed.record.projectOperation.childTaskIds,[]);assert.equal(f.calls.length,7);});
 assert.deepEqual(readTask(f.home,childId),before);assert.deepEqual((await projectChatState(f.home,repo.project)).state,projectBefore);
 revise=true;
 const revision=await runProjectTurn({...base,input:'Explicitly revise the plan to require independent review',frozenConstraints:{requireDifferentModelReview:true},contextTaskIds:[first.record.id]});assert.ok(revision.record.proposalRef,revision.record.error);
 const revised=await confirmProject(base,revision,{frozenConstraints:{requireDifferentModelReview:true},budget:{maxCalls:0}}),revisedState=(await projectChatState(f.home,repo.project)).state;
 assert.equal(revisedState.revision,2);assert.ok(revisedState.steps.every(step=>step.works.every(work=>work.independentReview===true)));
 assert.notEqual(revised.record.status,'completed');assert.equal(revised.record.deliveryRef,undefined);assert.equal(f.calls.length,8,'no review evidence is fabricated when the root has no send allowance');assert.deepEqual(readTask(f.home,childId),before);
});

test('cancellation during child runtime preparation settles the persisted unsent child',async t=>{
 const {ModelRuntime}=await import('@earendil-works/pi-coding-agent');
 const {projectChatState}=await import('../src/project.js'),{readTask}=await import('../src/task.js');
 const repo=repository(t),plan={goal:'Verify a.txt',scope:['a.txt'],deliverables:['a.txt'],checks:[{command:'node',args:['-e',"require('fs').accessSync('a.txt')"]}]};
 const f=await fixture(t,(_,n)=>n===1?{toolCalls:[{name:'start_work',args:{action:'start',reason:'verify',plan}}]}:{text:'Verified'});
 const base=await projectSession(t,repo,f),source=await runProjectTurn({...base,input:'Verify a.txt'});
 const abort=new AbortController(),create=ModelRuntime.create;let barrierHits=0;
 // Interrupt only the child's actual preparation; keep the real runtime, task factory and PROJECT scheduler.
 t.mock.method(ModelRuntime,'create',async function(...args){barrierHits++;abort.abort();await new Promise(resolve=>setImmediate(resolve));return create.apply(this,args);});
 const root=await confirmProject(base,source,{signal:abort.signal}),state=(await projectChatState(f.home,repo.project)).state;
 const step=state.steps[0],attempt=step.attempts.at(-1),raw=JSON.parse(readFileSync(join(f.home,'tasks',attempt.taskId+'.json'),'utf8')),child=readTask(f.home,attempt.taskId);
 assert.equal(barrierHits,1);assert.equal(root.record.status,'cancelled');assert.ok(root.record.cancelSettledAt);assert.equal(f.calls.length,1);
 assert.equal(raw.status,'cancelled');assert.equal(child.status,'cancelled');assert.ok(raw.cancelRequestedAt);assert.ok(raw.cancelSettledAt);assert.deepEqual(raw.requestIds,[]);
 assert.equal(raw.rootTaskId,root.record.id);assert.equal(raw.project.commandId,root.record.projectOperation.commandId);
 assert.deepEqual(root.record.projectOperation.childTaskIds,[],'a rejected child is not retroactively registered after root stop');
 assert.equal(state.status,'paused');assert.equal(step.status,'pending');assert.equal(attempt.taskStatus,'cancelled');assert.doesNotMatch(attempt.error,/进程可能已中断或仍在运行/);
});
