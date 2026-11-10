import { createHash } from 'node:crypto';
import { problem, readRequest, readRequests, readTask } from './task.js';
import { workModelIdentity } from "./model-roster.js";

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function userCollaboration(record) {
  return (record.turnIntent?.collaboration??[]).map(({text,...requirement})=>({
    ...requirement,source:{kind:"user",taskId:record.id,text},
  }));
}
export function checkedPlanCollaboration(plan,steps) {
  const value=plan.collaboration;
  if (value===undefined) return null;
  if (!value||typeof value!=="object"||Array.isArray(value)||
      !Object.keys(value).length||Object.keys(value).some(key=>!["workers","parallel","distinctModels","stepIds"].includes(key)))
    throw problem("WORK_PLAN","plan.collaboration must specify workers, parallel, distinctModels or stepIds");
  const {parallel=false,distinctModels=false,workers=parallel||distinctModels?2:1,stepIds}=value;
  if (!Number.isSafeInteger(workers)||workers<(parallel||distinctModels?2:1)||
      typeof parallel!=="boolean"||typeof distinctModels!=="boolean")
    throw problem("WORK_PLAN","plan.collaboration needs a positive worker count, at least two for parallel or distinct-model work, and boolean flags");
  if (stepIds!==undefined&&(!Array.isArray(stepIds)||!stepIds.length||
      new Set(stepIds).size!==stepIds.length||stepIds.some(id=>!steps.some(step=>step.id===id))))
    throw problem("WORK_PLAN","plan.collaboration.stepIds must list distinct declared plan step IDs");
  if (parallel&&stepIds?.length>1) {
    const dependencies=new Map(steps.map(step=>[step.id,step.dependsOn]));
    const simultaneous=new Set(stepIds);
    for (const id of stepIds) {
      const visited=new Set();
      const pending=[...dependencies.get(id)];
      while (pending.length) {
        const dependency=pending.pop();
        if (simultaneous.has(dependency))
          throw problem("WORK_PLAN","plan.collaboration cannot require dependent steps to execute in parallel");
        if (visited.has(dependency)) continue;
        visited.add(dependency);
        pending.push(...dependencies.get(dependency));
      }
    }
  }
  return {workers,parallel,distinctModels,...(stepIds?{stepIds:[...stepIds]}:{})};
}

function collaborationEvidence(requirement,candidates) {
  const scoped=candidates.filter(item=>
    (!requirement.stepIds||requirement.stepIds.includes(item.stepId))&&
    (!item.reusedRequirements||item.reusedRequirements.some(source=>digest(source)===digest(requirement))));
  const gaps=items=>[
    (new Set(items.map(item=>item.workId)).size<requirement.workers||
      new Set(items.map(item=>item.sessionId)).size<requirement.workers)&&"required_workers",
    requirement.distinctModels&&new Set(items.map(item=>item.identity)).size<requirement.workers&&"distinct_models",
    requirement.stepIds?.some(id=>!items.some(item=>item.stepId===id))&&"step_coverage",
  ].filter(Boolean);
  const missing=gaps(scoped);
  if (missing.length||!requirement.parallel) return {items:scoped,missing};
  const starts=[...new Set(scoped.flatMap(item=>item.intervals.map(({start})=>start)))].sort();
  for (const start of starts) {
    const simultaneous=scoped.filter(item=>item.intervals.some(interval=>interval.start<=start&&start<interval.end));
    if (!gaps(simultaneous).length) return {items:simultaneous,missing:[]};
  }
  return {items:scoped,missing:["parallel_overlap"]};
}

// Called at the answer and formal delivery boundaries. Runtime-specific
// adapters supply only verified, processed and covered worker results.
export function recordCollaborationResult(task,{requirements=userCollaboration(task.record),candidates=[]}={}) {
  if (!requirements.length) return null;
  const results=requirements.map(requirement=>{
    const {items,missing}=collaborationEvidence(requirement,candidates);
    return {requirement,status:missing.length?"unfulfilled":"fulfilled",missing,
      evidence:items.map(({taskId,memberId,workId,stepId,sessionId,resultRequestId,checkRequestId,identity,intervals})=>
        ({taskId,memberId,workId,stepId,sessionId,resultRequestId,checkRequestId,identity,intervals}))};
  });
  task.record.collaborationResult=results;
  const labels={required_workers:"经经理处理和过程检查的员工结果数量不足",distinct_models:"实际参与的不同型号数量不足",
    step_coverage:"部分指定步骤缺少协作证据",parallel_overlap:"缺少实际请求重叠证据"};
  const missing=[...new Set(results.flatMap(result=>result.missing))];
  return missing.length?"协作承诺尚未履行。"+missing.map(gap=>labels[gap]).join("；")+"。":null;
}

export function ownedPhysicalRequest(record,child,call) {
  const claim=record.rootRequests?.find(item=>item.requestId===call.id);
  const stage=child.stages.find(item=>item.id===call.stageId);
  return call.sent&&call.status==="completed"&&call.transport?.projectDispatched===true&&
    stage?.callIds.includes(call.id)&&(child.id===record.id||stage.sessionId===call.projectSend?.sessionId)&&stage.role===call.role&&stage.phase===call.phase&&
    claim?.taskId===child.id&&claim.stageId===stage.id&&claim.sessionId===stage.sessionId&&
    claim.status==="completed"&&!claim.notSent&&claim.model?.provider===call.actualModel?.provider&&
    claim.model?.modelId===call.actualModel?.modelId;
}

function receivedWorkerResult(member,child,calls) {
  if (member.status==="accepted"&&!member.readOnly) {
    return !!member.rootReviewCallId&&calls.some(call=>
      call.id===member.rootReviewCallId&&call.role==="main")&&
      child.work?.acceptance?.some(acceptance=>acceptance.status==="accepted"&&
        acceptance.requestId===member.acceptance?.requestId&&acceptance.acceptedVersion===member.acceptedVersion);
  }
  const role=member.supervisorMemberId?"member:"+member.supervisorMemberId:"main";
  if (!member.collected||(member.supervisorMemberId&&!member.supervisorCollected)) return false;
  const collectTools=new Set(calls.filter(call=>call.role===role)
    .flatMap(call=>(call.response?.content??[]).filter(part=>part.type==="toolCall"&&part.name==="collect").map(part=>part.id)));
  return calls.some(call=>call.role===role&&call.context?.messages?.some(message=>
    message.role==="toolResult"&&!message.isError&&collectTools.has(message.toolCallId)&&
    message.content?.some?.(part=>{
      if (part.type!=="text") return false;
      try {
        return JSON.parse(part.text)?.members?.some(item=>
          item.memberId===member.memberId&&item.callId===member.callId&&item.status==="completed");
      } catch { return false; }
    })));
}

export function formalCollaborationCandidates(task,state,sources) {
  const facts=[];
  for (const {record:child,stepId,relation} of sources) {
    if (!child.members?.length) continue;
    const root=relation==="owned"?task.record:readTask(task.home,child.rootTaskId);
    const reusedRequirements=relation==="inherited"?root.proposal?.collaboration:null;
    if (relation==="inherited"&&(task.record.proposal.action!=="resume"||!reusedRequirements?.length||
        root.projectOperation?.revision!==state.revision||root.projectOperation.commandId!==child.project.commandId||
        root.workspace?.id!==task.record.workspace.id||root.sessionId!==task.record.sessionId||
        !root.projectOperation.childTaskIds?.includes(child.id))) continue;
    let calls;
    try { calls=readRequests(task.home,child).filter(call=>ownedPhysicalRequest(root,child,call)); }
    catch { continue; }
    const step=state.steps.find(item=>item.id===stepId);
    const processed=new Set();
    for (const member of child.members) {
      if (["completed","accepted"].includes(member.status)&&!member.reviewOf&&
          receivedWorkerResult(member,child,calls)) processed.add(member.memberId);
    }
    for (const member of child.members) {
      if (!processed.has(member.memberId)) continue;
      const supervisors=new Set([member.memberId]);
      let supervisor=member.supervisorMemberId;
      while (supervisor&&processed.has(supervisor)&&!supervisors.has(supervisor)) {
        supervisors.add(supervisor);
        supervisor=child.members.find(item=>item.memberId===supervisor)?.supervisorMemberId;
      }
      if (supervisor) continue;
      const assignment=state.staffAssignments?.[member.memberId];
      if (assignment?.taskId!==child.id||assignment.staffId!==member.staffId||
          assignment.status!=="disposed"||assignment.outcome!==member.status||
          assignment.workId!==member.workId||
          ![...step.works,...(step.subworks??[])].some(work=>work.id===(assignment.targetWorkId??assignment.workId)))
        continue;
      const role="member:"+member.memberId;
      const workerCalls=calls.filter(call=>
        call.role===role&&["worker-prepare","worker","worker-feedback","worker-conflict-resolution"].includes(call.phase)&&
        call.projectSend?.dispatchId===member.memberId&&call.projectSend?.workId===member.workId&&
        call.actualModel?.modelId&&assignment.identity===workModelIdentity(call.actualModel)&&
        assignment.model===call.actualModel.provider+"/"+call.actualModel.modelId);
      const executionCalls=workerCalls.filter(call=>["worker","worker-feedback"].includes(call.phase));
      const result=executionCalls.find(call=>call.id===member.callId&&call.response?.stopReason==="stop"&&call.text?.trim());
      const sessionId=result?.projectSend?.sessionId;
      if (!sessionId||sessionId===child.sessionId||sessionId===root.sessionId) continue;
      const attemptCalls=workerCalls.filter(call=>call.projectSend.feedback===result.projectSend.feedback);
      const checkRequestId=coveringProcessCheck(task.home,root,child,member,result.projectSend.feedback,attemptCalls);
      if (!checkRequestId) continue;
      const intervals=executionCalls.filter(call=>call.projectSend.feedback===result.projectSend.feedback)
        .map(({transport})=>({start:transport.dispatchedAt,end:transport.lastBodyAt??transport.headersAt}))
        .filter(({start,end})=>start&&end&&start<end);
      facts.push({taskId:child.id,memberId:member.memberId,workId:member.workId,stepId,sessionId,
        resultRequestId:result.id,checkRequestId,identity:assignment.identity,intervals,...(reusedRequirements?{reusedRequirements}:{})});
    }
  }
  return facts;
}

export function coveringProcessCheck(home,root,child,member,attempt,calls) {
  const requestIds=new Set(calls.map(call=>call.id));
  for (const observation of root.processCheck?.observations??[]) {
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
