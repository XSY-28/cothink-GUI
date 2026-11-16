import{isDeepStrictEqual}from'node:util';
import{inScope}from'./versioning.js';
/** Explicit manual recovery of saved bytes, never a collected result or contribution. */
export async function stoppedMemberDraft({source,record,state,step,attempt,draft,v}){
 if(!draft||draft.taskId!==record?.id||step.status==='completed'||!source.localExecutionClosedAt||
    source.localExecutionCloseError||source.cancelRequestedAt||!record.localExecutionClosedAt||record.cancelStopError||
    record.work?.cleanupErrors?.length||!['cancelled','outcome_unknown','failed','partial'].includes(record.status)||
    record.rootTaskId!==source.id||!source.projectOperation.childTaskIds.includes(record.id)||
    attempt.rootTaskId!==source.id||attempt.taskId!==record.id||record.submissionId!==attempt.submissionId||
    record.project?.id!==state.id||record.project.stepId!==step.id||record.project.commandId!==attempt.commandId||
    record.work.root!==state.repo||record.work.integrationRef!==state.integrationRef||record.work.startVersion!==attempt.startVersion||
    !isDeepStrictEqual(record.project.scope,step.scope)||!isDeepStrictEqual(record.project.checks,step.checks))return null;
 const member=record.members?.find(m=>m.changeId===draft.changeId&&!m.collected&&
   ['cancelled','outcome_unknown','failed'].includes(m.status)&&!m.readOnly&&!m.stopError);
 const saved=record.work.changes.find(c=>c.changeId===draft.changeId);
 if(!member||!saved||saved.readOnly||saved.actor!=='member:'+member.memberId||
    !isDeepStrictEqual(draft,{taskId:record.id,changeId:saved.changeId,baseVersion:saved.baseVersion,version:saved.privateVersion})||
    !isDeepStrictEqual(saved.scope,member.scope)||saved.scope.some(p=>!inScope(p,step.scope)))return null;
 const fact=await v.inspect({changeId:saved.changeId});
 if(fact.changeId!==saved.changeId||fact.actor!==saved.actor||fact.readOnly||fact.status!=='abandoned'||
    fact.executionState!=='stopped'||fact.baseVersion!==draft.baseVersion||fact.privateVersion!==draft.version||
    !isDeepStrictEqual(fact.scope,saved.scope)||!isDeepStrictEqual(fact.readScope,saved.readScope))return null;
 const operations=record.work.operations??[];
 const tools=(record.tools??[]).filter(t=>t.changeId===saved.changeId&&t.kernelDispatched&&t.requestId&&
   record.stages.some(s=>s.id===t.stageId&&s.role===saved.actor)&&
   operations.some(o=>o.action==='private_ref_updated'&&o.changeId===saved.changeId&&o.requestId===t.requestId));
 let receipt=false;
 for(const tool of [...tools].reverse()){
  const r=await v.inspect({requestId:tool.requestId});
  if(['applied','completed'].includes(r.status)&&r.requestId===tool.requestId&&(!r.changeId||r.changeId===saved.changeId)&&r.privateVersion===draft.version){receipt=true;break;}
 }
 if(!receipt)return null;
 const diff=await v.inspect({fromVersion:draft.baseVersion,toVersion:draft.version});
 if(!diff.files.length||diff.files.some(p=>!inScope(p,saved.scope)||!inScope(p,step.scope)))return null;
 await v.read({version:draft.version,path:'.',kind:'tree'});
 return {...draft};
}
