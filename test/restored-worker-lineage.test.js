import test from 'node:test';
import assert from 'node:assert/strict';
import {restoredWorkerLineage,verifyRestoredWorkerLineage} from '../src/project-restored-lineage.js';
function fixture(){
 const draft={taskId:'child0',changeId:'worker',baseVersion:'base',version:'worker-v'};
 const member={memberId:'m',status:'completed',collected:true,scope:['tests/a'],changeId:'worker',rootReviewedVersion:'worker-v'};
 const root=n=>({id:'r'+n,sessionId:'session',workspace:{id:'w',project:'/p'},status:'partial',localExecutionClosedAt:'closed',projectOperation:{projectId:'p',commandId:'cmd'+n,childTaskIds:['child'+n]}});
 const records={r0:root(0),r1:root(1),r2:root(2)};
 records.r1.projectOperation.continuation={sourceRootTaskId:'r0',stepId:'s',draft};
 const next={taskId:'child1',changeId:'main',baseVersion:'base',version:'main-v'};
 records.r2.projectOperation.continuation={sourceRootTaskId:'r1',stepId:'s',draft:next};
 for(let n=0;n<2;n++)records['r'+n].fileContinuationIntent={taskId:'r'+(n+1),commandId:'cmd'+(n+1),continuation:structuredClone(records['r'+(n+1)].projectOperation.continuation)};
 records.child0={id:'child0',rootTaskId:'r0',sessionId:'child-session0',status:'partial',localExecutionClosedAt:'closed',project:{projectId:'p',commandId:'cmd0',stepId:'s'},work:{changes:[{changeId:'worker',baseVersion:'base',privateVersion:'worker-v',scope:['tests/a'],actor:'member:m'}]}};
 records.child1={id:'child1',rootTaskId:'r1',sessionId:'child-session1',status:'partial',localExecutionClosedAt:'closed',project:{projectId:'p',commandId:'cmd1',stepId:'s',continuation:structuredClone(records.r1.projectOperation.continuation)},work:{restoreRequestId:'restore',requests:[{requestId:'restore',action:'beginChange',dispatched:true,status:'open'}],changes:[{changeId:'main',baseVersion:'base',privateVersion:'main-v',scope:['tests'],actor:'main'}]}};
 const receipt={actor:'main',status:'open',changeId:'main',baseVersion:'base',privateVersion:'restored-v',scope:['tests/a']},diffs={};
 const versioning={async inspect(x){return x.requestId?receipt:{files:diffs[x.toVersion]??[]};}};
 const discover=()=>restoredWorkerLineage('home',records.r2,records.child0,member,{read:(_,id)=>records[id]});
 return {records,member,receipt,diffs,versioning,discover};
}
test('two-hop discovery is pending until all public restore and byte evidence validates',async()=>{const f=fixture(),l=f.discover();assert.equal(l.hops.length,1);assert.equal(l.draft.changeId,'worker');await verifyRestoredWorkerLineage(f.versioning,l,f.member);assert.equal(f.records.r2.restoredWorkerProofs,undefined);});
for(const [name,change] of [
 ['uncollected',f=>f.member.collected=false],['unfinished worker',f=>f.member.status='running'],
 ['different source version',f=>f.member.rootReviewedVersion='other'],
 ['cross session',f=>f.records.r0.sessionId='other'],['cross project',f=>f.records.r0.projectOperation.projectId='other'],
 ['cross workspace',f=>f.records.r0.workspace.id='other'],['unclosed root',f=>delete f.records.r1.localExecutionClosedAt],
 ['unclosed child',f=>delete f.records.child1.localExecutionClosedAt],['wrong child owner',f=>f.records.child1.rootTaskId='r0'],
 ['wrong command',f=>f.records.child1.project.commandId='cmd0'],['wrong step',f=>f.records.child1.project.stepId='other'],
 ['stale version',f=>f.records.child1.work.changes[0].privateVersion='stale'],
 ['out of scope',f=>f.records.child1.work.changes[0].scope=['other']],['wrong reservation',f=>f.records.r1.fileContinuationIntent.taskId='other'],
 ['changed continuation requests',f=>f.records.child1.project.continuation.requestIds=['forged']],
 ['broken selected draft',f=>f.records.child1.project.continuation.draft.version='other'],
 ['cycle',f=>f.records.r1.projectOperation.continuation.sourceRootTaskId='r2'],
 ['read failure',f=>delete f.records.r0],
])test('lineage discovery rejects '+name,()=>{const f=fixture();change(f);assert.equal(f.discover(),null);});
for(const [name,change] of [
 ['unknown restore',f=>f.receipt.status='outcome_unknown'],['wrong actor',f=>f.receipt.actor='member:other'],
 ['wrong change',f=>f.receipt.changeId='other'],['wrong base',f=>f.receipt.baseVersion='other'],['receipt scope',f=>f.receipt.scope=['other']],
 ['undispatched',f=>f.records.child1.work.requests[0].dispatched=false],
 ...['worker-v','restored-v','main-v'].map(v=>['changed '+v,f=>f.diffs[v]=['tests/a']]),
])test('public chain rejects '+name,async()=>{const f=fixture();change(f);await assert.rejects(verifyRestoredWorkerLineage(f.versioning,f.discover(),f.member),{code:'PROCESS_RESTORED_SOURCE'});});

function bridge(){
 const f=fixture(),r=f.records;
 const selected={taskId:'child1',changeId:'next',baseVersion:'formal-v',version:'next-v'};
 r.r2.projectOperation.continuation.draft=selected;r.r1.fileContinuationIntent.continuation.draft=structuredClone(selected);
 r.child1.project.readScope=['tests'];
 r.child1.work.changes.push({changeId:'next',baseVersion:'formal-v',privateVersion:'next-v',scope:['notes'],actor:'main'});
 r.child1.work.acceptance=[{status:'accepted',requestId:'accept',changeId:'main',candidateVersion:'candidate-v',expectedTip:'base',acceptedVersion:'formal-v'}];
 r.child1.work.requests.push({action:'acceptChange',requestId:'accept',changeId:'main',dispatched:true,status:'accepted'});
 r.child1.work.requests.push({action:'beginChange',requestId:'next-begin',dispatched:true,status:'open'});
 f.accepted={status:'accepted',verification:'passed',changeId:'main',candidateVersion:'candidate-v',expectedTip:'base',acceptedVersion:'formal-v'};
 f.next={actor:'main',status:'open',changeId:'next',baseVersion:'formal-v',privateVersion:'new-base-v',scope:['notes'],readScope:['tests']};
 f.publicChanges={main:{changeId:'main',status:'accepted',actor:'main',readOnly:false,executionState:'stopped',baseVersion:'base',acceptedVersion:'formal-v'}};
 f.versioning.inspect=async x=>x.changeId?f.publicChanges[x.changeId]:x.requestId?(x.requestId==='restore'?f.receipt:x.requestId==='accept'?f.accepted:f.next):{files:f.diffs[x.toVersion]??[]};
 return f;
}
test('accepted predecessor bridges a narrower next-main scope without granting worker write access',async()=>{
 const f=bridge(),l=f.discover();assert.ok(l);await verifyRestoredWorkerLineage(f.versioning,l,f.member);
 assert.equal(l.hops[0].acceptanceRequestId,'accept');assert.deepEqual(f.records.child1.work.changes.at(-1).scope,['notes']);
});
for(const [name,change] of [
 ['missing acceptance',f=>f.records.child1.work.acceptance=[]],
 ['wrong formal base',f=>f.records.child1.work.changes.at(-1).baseVersion='other'],
 ['missing baseline read authority',f=>f.records.child1.project.readScope=['notes']],
])test('accepted bridge discovery rejects '+name,()=>{const f=bridge();change(f);assert.equal(f.discover(),null);});
for(const [name,change] of [
 ['unverified accept',f=>f.accepted.verification='unverified'],['failed accept',f=>f.accepted.status='check_failed'],
 ['wrong accepted change',f=>f.accepted.changeId='other'],['wrong candidate',f=>f.accepted.candidateVersion='other'],
 ['wrong accepted version',f=>f.accepted.acceptedVersion='other'],['next base disconnected',f=>f.next.baseVersion='other'],
 ['next owner',f=>f.next.actor='member:other'],['next public read scope',f=>f.next.readScope=['notes']],['next unknown',f=>f.next.status='outcome_unknown'],
 ['missing public next begin',f=>f.records.child1.work.requests.pop()],
 ...['candidate-v','formal-v','new-base-v','next-v'].map(v=>['changed worker bytes at '+v,f=>f.diffs[v]=['tests/a']]),
])test('accepted bridge public proof rejects '+name,async()=>{const f=bridge();change(f);await assert.rejects(verifyRestoredWorkerLineage(f.versioning,f.discover(),f.member),{code:'PROCESS_RESTORED_SOURCE'});});

function resultBridge(){
 const f=bridge(),r=f.records,w=r.child1.work;
 // Restore writes a narrow browser file, while the employee test remains in its
 // authorized immutable read baseline. No write scope is enlarged.
 f.receipt.scope=['browser'];f.receipt.readScope=['tests'];
 const selected={taskId:'child1',changeId:'result',baseVersion:'formal-2',version:'formal-2'};
 r.r2.projectOperation.continuation.draft=selected;r.r1.fileContinuationIntent.continuation.draft=structuredClone(selected);
 w.resultChangeId='result';w.changes.push({changeId:'result',actor:'main',readOnly:true,scope:[],baseVersion:'formal-2',privateVersion:'formal-2'});
 w.acceptance.push({status:'accepted',requestId:'accept2',changeId:'next',candidateVersion:'candidate-2',expectedTip:'formal-v',acceptedVersion:'formal-2'});
 w.requests.push({action:'acceptChange',requestId:'accept2',changeId:'next',dispatched:true,status:'accepted'},{action:'beginChange',requestId:'result-begin',dispatched:true,status:'open'});
 f.accepted2={status:'accepted',verification:'passed',changeId:'next',candidateVersion:'candidate-2',expectedTip:'formal-v',acceptedVersion:'formal-2'};
 f.result={actor:'result',changeId:'result',status:'open',readOnly:true,scope:[],readScope:['tests'],baseVersion:'formal-2',privateVersion:'formal-2'};
 f.publicChanges.next={changeId:'next',status:'accepted',actor:'main',readOnly:false,executionState:'absent',baseVersion:'formal-v',acceptedVersion:'formal-2'};
 f.versioning.inspect=async x=>x.changeId?f.publicChanges[x.changeId]:x.requestId?({restore:f.receipt,accept:f.accepted,accept2:f.accepted2,'next-begin':f.next,'result-begin':f.result}[x.requestId]):{files:f.diffs[x.toVersion]??[]};
 return f;
}
test('two verified accepts bridge a stopped readonly result and narrow restore without widening scope',async()=>{
 const f=resultBridge(),l=f.discover();assert.ok(l);await verifyRestoredWorkerLineage(f.versioning,l,f.member);
 assert.deepEqual(l.hops[0].acceptanceRequestIds,['accept','accept2']);assert.deepEqual(f.receipt.scope,['browser']);
});
for(const [name,change] of [
 ['broken second tip',f=>f.accepted2.expectedTip='alien'],
 ['unverified second accept',f=>f.accepted2.verification='unverified'],
 ['wrong second candidate',f=>f.accepted2.candidateVersion='alien'],
 ['different second change',f=>f.accepted2.changeId='alien'],
 ['second still active',f=>f.publicChanges.next.executionState='running'],
 ['second not accepted',f=>f.publicChanges.next.status='open'],
 ['second actor is other employee',f=>f.publicChanges.next.actor='member:other'],
 ['second public base disconnected',f=>f.publicChanges.next.baseVersion='alien'],
 ['unregistered accept',f=>f.records.child1.work.requests.find(x=>x.requestId==='accept2').dispatched=false],
 ['ambiguous accepted branch',f=>f.records.child1.work.acceptance.push({...f.records.child1.work.acceptance[1],requestId:'dup'})],
 ['readonly result owner mismatch',f=>f.result.actor='member:other'],
 ['not designated result',f=>f.records.child1.work.resultChangeId='other'],
 ['result public read scope absent',f=>f.result.readScope=[]],
 ['restore public read scope absent',f=>f.receipt.readScope=[]],
 ...['candidate-2','formal-2'].map(v=>['changed employee bytes '+v,f=>f.diffs[v]=['tests/a']]),
])test('multi-accept result bridge rejects '+name,async()=>{const f=resultBridge();change(f);await assert.rejects(verifyRestoredWorkerLineage(f.versioning,f.discover(),f.member),{code:'PROCESS_RESTORED_SOURCE'});});
