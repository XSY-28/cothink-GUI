import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectRestoredWorkerProof,restoredAssignment} from '../src/project-restored-process-check.js';
function setup(){
 const draft={taskId:'old',changeId:'old-change',version:'old-version'};
 const member={memberId:'writer',scope:['a.txt'],status:'completed',changeId:'old-change',rootReviewedVersion:'old-version',callId:'result'};
 const work={restoreRequestId:'restore',requests:[{requestId:'restore',action:'beginChange',dispatched:true,status:'open'}],acceptance:[{requestId:'accept',changeId:'new',status:'accepted',acceptedVersion:'formal'}]};
 const restore={status:'open',actor:'main',changeId:'new',privateVersion:'restored'};
 const accepted={status:'accepted',verification:'passed',changeId:'new',candidateVersion:'candidate',acceptedVersion:'formal'};
 const diffs={restored:[],candidate:[],formal:[]};
 const versioning={async inspect(input){if(input.requestId)return input.requestId==='restore'?restore:input.requestId==='accept'?accepted:{};assert.equal(input.fromVersion,draft.version);return {files:diffs[input.toVersion]};}};
 return {draft,member,work,restore,accepted,diffs,versioning,taskId:'current'};
}
test('restored worker proof binds public restore, accept and all three version comparisons',async()=>{
 const f=setup(),proof=await inspectRestoredWorkerProof(f.versioning,f);
 assert.equal(proof.sourceVersion,'old-version');assert.equal(proof.acceptanceRequestId,'accept');
 assert.equal(proof.taskId,'current');
});
for(const [name,mutate] of [
 ['wrong restore request',f=>f.work.restoreRequestId='wrong'],
 ['undispatched restore',f=>f.work.requests[0].dispatched=false],
 ['wrong restore actor',f=>f.restore.actor='member:other'],
 ['unknown restore',f=>f.restore.status='outcome_unknown'],
 ['wrong restore change',f=>f.restore.changeId='wrong'],
 ['failed acceptance',f=>f.accepted.status='check_failed'],
 ['unverified acceptance',f=>f.accepted.verification='unverified'],
 ['wrong accepted change',f=>f.accepted.changeId='wrong'],
 ['wrong accepted version',f=>f.accepted.acceptedVersion='wrong'],
 ...['restored','candidate','formal'].map(v=>['changed bytes at '+v,f=>f.diffs[v]=['a.txt']]),
])test('restored worker proof rejects '+name,async()=>{const f=setup();mutate(f);await assert.rejects(inspectRestoredWorkerProof(f.versioning,f),{code:'PROCESS_RESTORED_SOURCE'});});
test('pending restored assignments cannot count without host proof or matching lineage',async()=>{
 const f=setup(),root={projectOperation:{continuation:{draft:f.draft}}},child={id:'old'},assignment={status:'result',requestId:'result'};
 assert.equal(Boolean(restoredAssignment(root,child,f.member,assignment,true)),false);
 assert.equal(restoredAssignment(root,child,f.member,assignment,true,true),true);
 root.restoredWorkerProofs=[await inspectRestoredWorkerProof(f.versioning,f)];
 assert.equal(restoredAssignment(root,child,f.member,assignment,true),true);
 assert.equal(restoredAssignment(root,child,f.member,assignment,false,true),false);
 for(const [field,value] of [['taskId','other'],['changeId','other'],['version','other']]){
  const altered=structuredClone(root);altered.projectOperation.continuation.draft[field]=value;
  assert.equal(Boolean(restoredAssignment(altered,child,f.member,assignment,true,true)),false);
 }
 assert.equal(restoredAssignment(root,child,{...f.member,status:'running'},assignment,true,true),false);
 assert.equal(restoredAssignment(root,child,f.member,{...assignment,requestId:'other'},true,true),false);
});

function inputFixture(){
 const f=setup();delete f.work.restoreRequestId;
 f.sourceInput={taskId:'previous',changeId:'result',baseVersion:'saved-formal',version:'saved-formal'};
 Object.assign(f.work,{startVersion:'saved-formal',version:'formal',changes:[{changeId:'new',actor:'main',readOnly:false}],requests:[{action:'beginChange',requestId:'input',dispatched:true,status:'open'},{action:'acceptChange',requestId:'accept',changeId:'new',dispatched:true,status:'accepted'}]});
 f.work.acceptance[0].expectedTip='saved-formal';f.work.acceptance[0].candidateVersion='candidate';
 f.input={actor:'main',status:'open',readOnly:true,scope:[],readScope:['a.txt'],baseVersion:'saved-formal',privateVersion:'saved-formal'};
 f.accepted.expectedTip='saved-formal';f.diffs['saved-formal']=[];
 f.versioning.inspect=async x=>x.requestId?(x.requestId==='input'?f.input:f.accepted):{files:f.diffs[x.toVersion]};return f;
}
test('formal readonly input counts unchanged employee only after new public verified acceptance',async()=>{const f=inputFixture(),p=await inspectRestoredWorkerProof(f.versioning,f);assert.equal(p.inputRequestId,'input');assert.equal(p.acceptanceRequestId,'accept');});
for(const [name,mutate] of [
 ['not same input baseline',f=>f.sourceInput.baseVersion='other'],['wrong start',f=>f.work.startVersion='other'],
 ['writable initial projection',f=>f.input.readOnly=false],['wrong initial owner',f=>f.input.actor='result'],
 ['initial scope absent',f=>f.input.readScope=[]],['private input changed',f=>f.input.privateVersion='other'],
 ['no public acceptance',f=>f.work.acceptance=[]],['no new acceptance',f=>f.work.version='saved-formal'],
 ['undispatched accept',f=>f.work.requests[1].dispatched=false],['wrong accepted tip',f=>f.accepted.expectedTip='other'],
 ['unverified final accept',f=>f.accepted.verification='unverified'],['different final change',f=>f.accepted.changeId='other'],
 ['wrong candidate',f=>f.accepted.candidateVersion='other'],['employee write owner',f=>f.work.changes[0].actor='member:x'],
 ...['saved-formal','candidate','formal'].map(v=>['changed employee at '+v,f=>f.diffs[v]=['a.txt']]),
])test('formal input employee proof rejects '+name,async()=>{const f=inputFixture();mutate(f);await assert.rejects(inspectRestoredWorkerProof(f.versioning,f),{code:'PROCESS_RESTORED_SOURCE'});});
