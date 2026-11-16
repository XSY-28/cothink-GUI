import {coveringProcessCheck, coverRestoredWorkers, restoredAssignment} from './project-restored-process-check.js';
export {coveringProcessCheck} from './project-restored-process-check.js';
import {continuationSources} from './project-continuation.js';
import { createHash } from 'node:crypto';
import { problem, readRequest, readRequests, readTask } from './task.js';
import { workModelIdentity } from "./model-roster.js";
import { projectRoutingBudget } from "./pi-model-runtime.js";

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

// Feedback is an ordinary new request in the same manager session. It never
// grants authority, changes assignment state or substitutes for final evidence.
export async function completionFeedback(task,runtime,result,{requirements=[],candidates=[],fileRequired=false,formal=false,pendingStepIds=[]}={}) {
  const root=task.rootOwner?.rootTask;
  if(!root||task.record.completionFeedback||task.signal.aborted||task.ioError||
      task.record.status!=="running"||root.signal.aborted||root.record.status!=="running"||
      root.record.cancelRequestedAt||task.record.cancelRequestedAt||root.record.processCheck?.gap||
      !result?.call?.sent||result.call.status!=="completed"||result.call.response?.stopReason!=="stop"||!result.text?.trim()||
      root.record.rootRequests?.some(call=>!call.notSent&&["failed","partial","cancelled","outcome_unknown"].includes(call.status)))return null;
  const gaps=requirements.flatMap(requirement=>{
    const {items,missing}=collaborationEvidence(requirement,candidates);
    const pending=requirement.stepIds?.filter(id=>pendingStepIds.includes(id))??[];
    const dueStepIds=requirement.stepIds?.filter(id=>!pending.includes(id));
    const due=missing.filter(gap=>!pending.length||gap==="step_coverage"&&
      dueStepIds.some(id=>!items.some(item=>item.stepId===id)));
    return due.length?[{requirement,missing:due,workers:items.length,
      ...(dueStepIds?{dueStepIds,pendingStepIds:pending}:{})}]:[];
  });
  if(!fileRequired&&!gaps.length)return null;
  if(gaps.length&&!root.record.constraints.allowedSubtasks.includes("work"))return null;
  if(formal)task.projectPolicy.admit("delegate",{actor:"main"});
  const budget=projectRoutingBudget(task);
  // Leave room for actual employee work, its mandatory check and consumption.
  // This is a lower bound; all later requests still use normal admission.
  const calls=task.requests();
  const collectable=formal?(task.record.members??[]).filter(member=>!member.collected&&!member.reviewOf&&
    ["running","completed"].includes(member.status)).flatMap(member=>{
      const call=calls.find(call=>call.role==="member:"+member.memberId&&call.sent&&["worker","worker-feedback"].includes(call.phase));
      return call?[{workId:member.workId,sessionId:call.projectSend.sessionId,stepId:task.record.project.stepId}]:[];
    }):task.record.stages.filter(({assignment:a})=>a&&!a.collected&&!a.review&&!a.supersededBy&&!a.closedAt&&!a.pause&&
      ["running","completed"].includes(a.status)).filter(stage=>calls.some(call=>call.stageId===stage.id&&call.sent))
      .map(stage=>({workId:stage.assignment.workId,sessionId:stage.sessionId}));
  const missingWorkers=Math.max(0,...gaps.map(({requirement,missing,dueStepIds})=>{
    const usable=collectable.filter(item=>!dueStepIds||dueStepIds.includes(item.stepId));
    const items=[...collaborationEvidence(requirement,candidates).items,...usable];
    const workers=Math.min(new Set(items.map(item=>item.workId)).size,new Set(items.map(item=>item.sessionId)).size);
    return missing.includes("required_workers")?Math.max(0,requirement.workers-workers):usable.length?0:1;
  }));
  const needed=gaps.length?2+missingWorkers*(formal?2:1):1;
  const minimum=needed+Math.max(budget.reservedForChecks,missingWorkers?1:0);
  const shortage=[["ROOT_BUDGET",budget.rootRemainingCalls],["PROJECT_BUDGET",budget.projectRemainingCalls]]
    .find(([,remaining])=>remaining!==null&&remaining<minimum);
  if(budget.hardCostCap!==null||shortage){
    task.record.completionFeedback={sourceRequestId:result.call.id,status:"not_sent",gaps,fileRequired,
      reason:budget.hardCostCap!==null?"ROOT_BUDGET: A hard cost cap prevents completion feedback.":
        `${shortage[0]}: Completion feedback and missing work need at least ${minimum} requests; ${shortage[1]} remain.`};
    task.save();return null;
  }
  const feedback=task.record.completionFeedback={sourceRequestId:result.call.id,status:"preparing",gaps,fileRequired};
  const prior=new Set(task.record.requestIds);
  const requests=()=>task.requests().filter(call=>!prior.has(call.id)&&call.stageId===result.call.stageId);
  task.save();
  try {
    const corrected=await runtime.prompt(JSON.stringify({source:"cothink-completion-feedback",
      sourceRequestId:result.call.id,gaps,fileRequired,
      instruction:"The saved final response leaves the listed explicit commitments unfulfilled. Complete only the missing work within the current authority and remaining budget. Scoped gaps apply to dueStepIds; pendingStepIds remain their own executors' responsibility. Use actual delegate and collect operations and consume the reports; text or repeated collection is not staffing. Reuse valid work already done. Do not reopen closed or unknown assignments. If fileRequired is true, propose the requested files using start_work; the original confirmation path still applies. If required details are missing, preserve your clarification question and explain the gap instead of inventing a project. If you cannot proceed, explain the exact blocker. This is the only completion feedback opportunity; final acceptance still requires verified evidence.",
    }),{custom:"cothink-completion-feedback"});
    Object.assign(feedback,{status:"completed",resultRequestId:corrected.call.id,requestIds:requests().map(call=>call.id)});
    task.save();return corrected;
  }catch(error){
    const calls=requests();
    feedback.status=calls.some(call=>["outcome_unknown","in_flight"].includes(call.status))?"outcome_unknown":"failed";
    feedback.requestIds=calls.map(call=>call.id);
    feedback.error={code:error.code??"COMPLETION_FEEDBACK",message:error.message};
    task.save();throw error;
  }
}

// This runs while the executor and its authority are still live. Collect and
// accept already dispose real assignments; the strict extractor needs no
// invented completed step or relaxed assignment status for these facts.
export async function formalCompletionFeedback(task,leader,result,checker,source) {
  await checker?.cover(source);
  const reports=checker?.reports(source,"main")??[];
  if(reports.length)return leader.prompt(JSON.stringify({
    source:"Host-bound process reports for your direct reports",processReports:reports,
    instruction:"Decide whether each current report requires correction, staffing, or no action. Preserve the reasons in your final response.",
  }));
  const root=task.rootOwner?.rootTask,requirements=root?.record.proposal?.collaboration??[];
  if(!requirements.length||task.record.completionFeedback)return null;
  const {projectChatState}=await import("./project.js");
  const {state}=await projectChatState(task.home,root.record.proposal.canonicalRepo);
  const current=state?.steps.find(step=>step.id===task.record.project.stepId);
  if(current?.attempts.at(-1)?.taskId!==task.record.id)return null;
  const sources=state.steps.flatMap(step=>{
    if(step===current)return [{record:task.record,stepId:step.id,relation:"owned"}];
    if(step.status!=="completed")return [];
    const attempt=step.attempts.at(-1);
    return [{record:readTask(task.home,attempt.taskId),stepId:step.id,
      relation:attempt.rootTaskId===root.record.id?"owned":"inherited"}];
  });
  const restoredReports=await coverRestoredWorkers(task,checker,source,
    formalCollaborationCandidates(root,state,sources,true).filter(item=>!item.checkRequestId||item.restorePending));
  if(restoredReports.length)return leader.prompt(JSON.stringify({
    source:'Host-bound process reports for restored employees',processReports:restoredReports,
    instruction:'Handle these restored employee observations within current authority. Do not redispatch completed employees merely to count their contribution. Explain unresolved issues honestly.'}));
  // Future scoped steps remain their own managers' responsibility. Global
  // commitments count earlier steps instead of re-staffing every step.
  const due=requirements.filter(requirement=>!requirement.stepIds||requirement.stepIds.includes(current.id));
  return completionFeedback(task,leader,result,{requirements:due,
    candidates:formalCollaborationCandidates(root,state,sources),formal:true,
    pendingStepIds:state.steps.filter(step=>step!==current&&step.status!=="completed").map(step=>step.id)});
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
  return missing.length?"协作承诺尚未履行。"+missing.map(gap=>labels[gap]).join("；")+"。"+
    (task.record.completionFeedback?.reason??""):null;
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

export function formalCollaborationCandidates(task,state,sources,includeUncovered=false) {
  const facts=[];
  const {inputs,inheritedRoots}=continuationSources(task,state,sources);
  for (const {record:child,stepId,relation} of inputs) {
    if (!child.members?.length) continue;
    const root=relation==="owned"?task.record:readTask(task.home,child.rootTaskId);
    const reusedRequirements=relation==="inherited"?root.proposal?.collaboration:null;
    const continued=inheritedRoots.has(root.id)&&root.proposal?.contextDigest===task.record.proposal.contextDigest;
    if (relation==="inherited"&&((!continued&&(task.record.proposal.action!=="resume"||root.projectOperation?.revision!==state.revision))||!reusedRequirements?.length||
        root.projectOperation.commandId!==child.project.commandId||
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
          (!(assignment.status==="disposed"&&assignment.outcome===member.status)&&
          !restoredAssignment(task.record,child,member,assignment,continued,includeUncovered,task.home))||
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
      const checkRequestId=coveringProcessCheck(task.home,root,child,member,result.projectSend.feedback,attemptCalls)??
        (continued?coveringProcessCheck(task.home,task.record,child,member,result.projectSend.feedback,attemptCalls):null);
      if (!checkRequestId&&!(includeUncovered&&continued)) continue;
      const intervals=executionCalls.filter(call=>call.projectSend.feedback===result.projectSend.feedback)
        .map(({transport})=>({start:transport.dispatchedAt,end:transport.lastBodyAt??transport.headersAt}))
        .filter(({start,end})=>start&&end&&start<end);
      facts.push({taskId:child.id,memberId:member.memberId,workId:member.workId,stepId,sessionId,
        resultRequestId:result.id,checkRequestId,restorePending:continued&&assignment.status==="result"&&!restoredAssignment(task.record,child,member,assignment,true,false,task.home),identity:assignment.identity,intervals,...(reusedRequirements?{reusedRequirements}:{})});
    }
  }
  return facts;
}
