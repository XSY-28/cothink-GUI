import {restoredWorkerLineage,verifyRestoredWorkerLineage} from './project-restored-lineage.js';
import {createHash} from 'node:crypto';
import {readTask,readRequest,problem} from './task.js';
import {createVersioning,inScope} from './versioning.js';
import {ownedPhysicalRequest} from './project-collaboration-evidence.js';

export function restoredAssignment(root,child,member,assignment,continued,allowPending=false,home) {
  const lineage=home?restoredWorkerLineage(home,root,child,member):null;
  const draft=home?lineage?.draft:root.projectOperation?.continuation?.draft;
  return !!continued&&member.status==='completed'&&assignment.status==='result'&&
    assignment.requestId===member.callId&&draft?.taskId===child.id&&
    draft.changeId===member.changeId&&draft.version===member.rootReviewedVersion&&
    (allowPending||root.restoredWorkerProofs?.some(p=>p.sourceTaskId===child.id&&p.memberId===member.memberId&&
      p.sourceChangeId===draft.changeId&&p.sourceVersion===draft.version&&p.resultRequestId===member.callId));
}

async function inspectFormalInputProof(versioning,{draft,sourceInput,member,work,taskId}) {
  const fail=()=>{throw problem('PROCESS_RESTORED_SOURCE','Formal input and accepted employee bytes are not verified');};
  if(!sourceInput||sourceInput.baseVersion!==sourceInput.version||work.startVersion!==sourceInput.version)fail();
  const initial=work.requests?.find(r=>r.action==='beginChange'&&r.dispatched&&r.status==='open');
  if(!initial)fail();
  const input=await versioning.inspect({requestId:initial.requestId});
  if(input.actor!=='main'||input.status!=='open'||!input.readOnly||input.baseVersion!==sourceInput.version||
    input.privateVersion!==sourceInput.version||!member.scope.every(p=>inScope(p,[...(input.scope??[]),...(input.readScope??[])])))fail();
  const versions=[sourceInput.version],seen=new Set(),receipts=[];let current=sourceInput.version;
  while(current!==work.version) {
    if(seen.has(current)||receipts.length>=128)fail();seen.add(current);
    const rows=(work.acceptance??[]).filter(r=>r.status==='accepted'&&r.expectedTip===current);
    if(rows.length!==1)fail();const row=rows[0];
    if(!work.requests.some(r=>r.action==='acceptChange'&&r.requestId===row.requestId&&r.changeId===row.changeId&&r.dispatched&&r.status==='accepted')||
      !work.changes?.some(c=>c.changeId===row.changeId&&c.actor==='main'&&!c.readOnly))fail();
    const fact=await versioning.inspect({requestId:row.requestId});
    if(fact.status!=='accepted'||fact.verification!=='passed'||fact.changeId!==row.changeId||
      fact.expectedTip!==current||fact.candidateVersion!==row.candidateVersion||fact.acceptedVersion!==row.acceptedVersion||!fact.acceptedVersion)fail();
    versions.push(fact.candidateVersion,fact.acceptedVersion);receipts.push(row.requestId);current=fact.acceptedVersion;
  }
  if(!receipts.length)fail();
  for(const version of versions){const diff=await versioning.inspect({fromVersion:draft.version,toVersion:version});if(!Array.isArray(diff.files)||diff.files.some(p=>inScope(p,member.scope)))fail();}
  return {sourceTaskId:draft.taskId,memberId:member.memberId,sourceChangeId:draft.changeId,sourceVersion:draft.version,
    resultRequestId:member.callId,taskId,inputRequestId:initial.requestId,acceptanceRequestId:receipts.at(-1),acceptanceRequestIds:receipts,acceptedVersion:current};
}

export async function inspectRestoredWorkerProof(versioning,{draft,sourceInput,member,work,taskId}) {
  if(!work.restoreRequestId&&sourceInput)return inspectFormalInputProof(versioning,{draft,sourceInput,member,work,taskId});
  const restore=await versioning.inspect({requestId:work.restoreRequestId});
  const acceptance=work.acceptance?.find(row=>row.changeId===restore.changeId&&row.status==='accepted');
  if(!acceptance||restore.status!=='open'||restore.actor!=='main'||
    !work.requests.some(r=>r.requestId===work.restoreRequestId&&r.action==='beginChange'&&r.dispatched&&r.status==='open'))
    throw problem('PROCESS_RESTORED_SOURCE','No public restored and accepted worker candidate');
  const accepted=await versioning.inspect({requestId:acceptance.requestId});
  if(accepted.status!=='accepted'||accepted.verification!=='passed'||accepted.changeId!==restore.changeId||
    accepted.acceptedVersion!==acceptance.acceptedVersion)throw problem('PROCESS_RESTORED_SOURCE','Worker candidate acceptance is not verified');
  for(const version of [restore.privateVersion,accepted.candidateVersion,accepted.acceptedVersion]) {
    const diff=await versioning.inspect({fromVersion:draft.version,toVersion:version});
    if(diff.files.some(path=>inScope(path,member.scope)))throw problem('PROCESS_RESTORED_SOURCE','Accepted content differs from the selected worker result');
  }
  return {sourceTaskId:draft.taskId,memberId:member.memberId,
    sourceChangeId:draft.changeId,sourceVersion:draft.version,resultRequestId:member.callId,
    taskId:taskId,restoreRequestId:work.restoreRequestId,acceptanceRequestId:accepted.requestId??acceptance.requestId,
    acceptedVersion:accepted.acceptedVersion};
}

// The caller's strict participation extractor has verified source lineage,
// assignment disposal, manager consumption and physical worker receipts.
// Only missing process coverage is supplemented, in the new root's budget.
export async function coverRestoredWorkers(task,checker,source,candidates) {
  if(!checker||!source||!candidates.length)return [];
  const root=task.rootOwner.rootTask;
  if((root.record.processCheck?.reports??[]).some(report=>candidates.some(item=>
    item.taskId===report.taskId&&item.memberId===report.memberId)))
    throw problem('PROCESS_RESTORED_ISSUES','Restored employee observations still require correction; saved work and reports are retained');
  const versioning=await createVersioning({home:task.home,project:root.record.workspace.project,readOnly:true});
  try {
    for(const item of candidates.filter(item=>item.restorePending)) {
      const child=readTask(task.home,item.taskId),member=child.members.find(m=>m.memberId===item.memberId);
      const lineage=restoredWorkerLineage(task.home,root.record,child,member);
      await verifyRestoredWorkerLineage(versioning,lineage,member);
      const proof=await inspectRestoredWorkerProof(versioning,{draft:lineage.draft,
        sourceInput:root.record.projectOperation?.continuation?.draft,member,work:task.record.work,taskId:task.record.id});
      proof.lineage=lineage.hops.map(({requests,acceptance,changes,...hop})=>hop);
      (root.record.restoredWorkerProofs??=[]).push(proof);
      root.save();
    }
  } finally {await versioning.close();}
  const missing=candidates.filter(item=>!item.checkRequestId);
  if(!missing.length)return [];
  const facts=missing.map(item=>{
    const child=readTask(task.home,item.taskId);
    const member=child.members.find(value=>value.memberId===item.memberId);
    const call=readRequest(task.home,child.id,item.resultRequestId);
    return {taskId:child.id,memberId:member.memberId,leaderId:'main',
      workId:member.workId,model:member.model,assignment:member.assignment,
      attempt:call.projectSend.feedback,status:member.status,waitingFor:[],blockers:0,
      errorCode:null,blockerIds:[],requests:[{id:call.id,phase:call.phase,status:call.status,
        at:call.transport.dispatchedAt,endedAt:call.endedAt}],actions:[],
      lastProgressAt:call.endedAt,evidenceIds:[call.id]};
  });
  const restored={...source,snapshot:()=>facts,isCurrent:report=>facts.some(fact=>
    fact.taskId===report.taskId&&fact.memberId===report.memberId&&fact.attempt===report.attempt)};
  checker.admit(restored,{restored:true}).commit();
  try {
    await checker.cover(restored);
    const reports=(root.record.processCheck?.reports??[]).filter(report=>
      report.status==='pending'&&restored.isCurrent(report));
    for(const report of reports){report.status='forwarded';report.forwardedAt=new Date().toISOString();}
    if(reports.length)root.save();
    return reports;
  } finally {await checker.detach(restored);}
}

export function coveringProcessCheck(home,root,child,member,attempt,calls) {
  const requestIds=new Set(calls.map(call=>call.id));
  for (const observation of root.processCheck?.observations??[]) {
    if (root.processCheck?.reports?.some(report=>report.observationId===observation.id&&report.taskId===child.id&&report.memberId===member.memberId)&&root.id!==child.rootTaskId)continue;
    if (observation.status!=="completed"||observation.commandId!==(root.projectOperation?.commandId??null)||!observation.covered?.some(item=>
      item.taskId===child.id&&item.memberId===member.memberId&&item.attempt===attempt&&
      item.evidenceIds?.some(id=>requestIds.has(id)))) continue;
    try {
      const owner=observation.taskId===child.id?child:readTask(home,observation.taskId);
      const call=readRequest(home,owner.id,observation.requestId);
      const last=call.context?.messages?.at(-1);
      const text=typeof last?.content==="string"?last.content:last?.content?.[0]?.text;
      const formal=owner.rootTaskId===root.id&&root.projectOperation?.childTaskIds.includes(owner.id)&&
        call.projectSend?.cause==="observe:"+observation.id&&call.projectSend?.sessionId===observation.sessionId;
      const claim=root.rootRequests?.find(claim=>claim.requestId===call.id);
      const readonly=owner.id===root.id&&claim?.cause==="observe:"+observation.id&&claim.sessionId===observation.sessionId;
      if ((formal||readonly)&&call.role==="process-check"&&call.stageId===observation.stageId&&
          last?.role==="user"&&typeof text==="string"&&createHash('sha256').update(text).digest('hex')===observation.snapshotDigest&&
          ownedPhysicalRequest(root,owner,call))
        return call.id;
    } catch {
      // Missing or corrupt receipts cannot satisfy the promise.
    }
  }
  return null;
}
