import {readTask,problem} from './task.js';
import {projectChatState} from './project.js';
import {createVersioning} from './versioning.js';
import {resolveDeliveryEvidence} from './project-delivery.js';
import {formalCollaborationCandidates,digest} from './project-collaboration-evidence.js';
import {restoredWorkerLineage,verifyRestoredWorkerLineage} from './project-restored-lineage.js';
import {inspectRestoredWorkerProof} from './project-restored-process-check.js';

// Final-only reuse has no writable draft. Reverify the original contribution at
// its own accepted version instead of pretending to restore a new employee.
export async function prepareFinalVisualParticipation(task,source,reservation) {
 if(!reservation.continuation?.visualRevision)return null;
 const {state}=await projectChatState(task.home,source.proposal.canonicalRepo);
 const fail=()=>{throw problem('FINAL_VISUAL_SOURCE','Final visual participation source changed');};
 if(source.deliveryRef?.version!==state.version||reservation.proposal.version!==state.version||
  state.steps.some(s=>s.status!=='completed')||!source.localExecutionClosedAt)fail();
 const delivery=resolveDeliveryEvidence(task.home,source);
 if(!delivery)fail();
 const v=await createVersioning({home:task.home,project:source.workspace.project,readOnly:true});
 try{
  if((await v.inspect()).version!==state.version)fail();
  for(const proof of source.restoredWorkerProofs??[]){
   const child=readTask(task.home,proof.sourceTaskId),member=child.members?.find(m=>m.memberId===proof.memberId);
   if(!member||member.status!=='completed'||!member.collected)fail();
   const lineage=restoredWorkerLineage(task.home,source,child,member);
   await verifyRestoredWorkerLineage(v,lineage,member);
   const owner=readTask(task.home,proof.taskId);
   if(owner.rootTaskId!==source.id||!owner.localExecutionClosedAt||owner.work?.version!==state.version)fail();
   const verified=await inspectRestoredWorkerProof(v,{draft:lineage.draft,sourceInput:source.projectOperation.continuation?.draft,member,work:owner.work,taskId:owner.id});
   if(Object.entries(verified).some(([key,value])=>digest(value)!==digest(proof[key])))fail();
  }
 }finally{await v.close();}
 const candidates=formalCollaborationCandidates({home:task.home,record:source},state,delivery.sources);
 const evidence={sourceTaskId:source.id,version:state.version,stepsDigest:digest(state.steps),candidates};
 task.record.finalVisualParticipation=structuredClone(evidence);task.save();return evidence;
}
export function finalVisualCandidates(evidence,state){
 if(!evidence||state.version!==evidence.version||digest(state.steps)!==evidence.stepsDigest)
  throw problem('FINAL_VISUAL_SOURCE','Accepted steps changed during final-only verification');
 return evidence.candidates;
}
