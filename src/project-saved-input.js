import {isDeepStrictEqual} from 'node:util';
// This proves only saved formal input; it grants no contribution or write authority.
async function acceptedInputHistory(record,attempt,v,version) {
  const work=record.work,parents=new Map(),writes=work.changes.filter(c=>!c.readOnly);
  if(!record.localExecutionClosedAt||record.cancelStopError||work.cleanupErrors?.length)return false;
  for(const saved of work.changes) {
    const fact=await v.inspect({changeId:saved.changeId});
    if(fact.changeId!==saved.changeId||fact.readOnly!==saved.readOnly||
      !['absent','stopped'].includes(fact.executionState))return false;
    if(saved.readOnly)continue;
    if(fact.status!=='accepted'||fact.actor!==saved.actor||fact.baseVersion!==saved.baseVersion||
      !isDeepStrictEqual(fact.scope,saved.scope)||!isDeepStrictEqual(fact.readScope,saved.readScope))return false;
    const rows=(work.acceptance??[]).filter(r=>r.changeId===saved.changeId&&r.status==='accepted');
    if(rows.length!==1)return false;
    const row=rows[0];
    if(!work.requests?.some(r=>r.action==='acceptChange'&&r.requestId===row.requestId&&
      r.changeId===saved.changeId&&r.dispatched&&r.status==='accepted'))return false;
    const accepted=await v.inspect({requestId:row.requestId});
    if(accepted.status!=='accepted'||accepted.verification!=='passed'||accepted.requestId!==row.requestId||
      accepted.changeId!==saved.changeId||!accepted.candidateVersion||!accepted.acceptedVersion||!accepted.expectedTip||
      !isDeepStrictEqual(accepted.checkPolicy,attempt.checkPolicy)||
      ['candidateVersion','acceptedVersion','expectedTip'].some(k=>accepted[k]!==row[k])||
      fact.acceptedVersion!==accepted.acceptedVersion||parents.has(accepted.acceptedVersion))return false;
    parents.set(accepted.acceptedVersion,accepted.expectedTip);
  }
  let current=version;const seen=new Set();
  for(let i=0;i<writes.length;i++){if(seen.has(current)||!parents.has(current))return false;seen.add(current);current=parents.get(current);}
  if(seen.has(current))return false;
  return current===work.startVersion&&parents.size===writes.length;
}

export async function savedInput(state,step,record,v,version,changeId) {
  const attempt=step.attempts.find(a=>a.taskId===record.id),work=record.work;
  if(!attempt||record.rootTaskId!==attempt.rootTaskId||record.submissionId!==attempt.submissionId||
    record.project?.id!==state.id||record.project.stepId!==step.id||record.project.commandId!==attempt.commandId||
    work?.root!==state.repo||work.integrationRef!==state.integrationRef||work.startVersion!==attempt.startVersion||
    !Array.isArray(work.changes)||
    !isDeepStrictEqual(record.project.scope,step.scope)||!isDeepStrictEqual(record.project.checks,step.checks))return null;
  const saved=work.changes.findLast(c=>(!changeId||c.changeId===changeId)&&c.readOnly&&
    (c.actor==='main'||c.actor==='result'&&c.changeId===work.resultChangeId)&&c.baseVersion===version&&c.privateVersion===version);
  if(!saved)return null;
  if(work.changes.some(c=>!c.readOnly)&&!await acceptedInputHistory(record,attempt,v,version))return null;
  const fact=await v.inspect({changeId:saved.changeId});
  if(fact.changeId!==saved.changeId||!fact.readOnly||!(fact.actor===saved.actor||saved.actor==='main'&&fact.actor==='result'&&saved.changeId===work.resultChangeId)||fact.baseVersion!==version||fact.privateVersion!==version)return null;
  return {taskId:record.id,changeId:saved.changeId,baseVersion:version,version};
}
