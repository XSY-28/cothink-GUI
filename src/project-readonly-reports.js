import { observedIdentity, reviewFamily } from "./project-review.js";
import { workModelIdentity } from "./model-roster.js";
import { problem, readRequest, readTask } from './task.js';
import { coveringProcessCheck, digest, ownedPhysicalRequest } from "./project-collaboration-evidence.js";

export function readOnlyReport(home,record,stage) {
  const a=stage.assignment;
  if(!a?.resultRequestId||a.status!=="completed"||!a.settledAt)
    throw problem("ROLE_REPORT","No settled role report");
  const call=readRequest(home,record.id,a.resultRequestId);
  if(call.stageId!==stage.id||!ownedPhysicalRequest(record,record,call)||digest(call.text)!==a.reportDigest)
    throw problem("ROLE_REPORT","Saved report no longer matches its registered request");
  return call;
}

export function reportReceived(call,receipt) {
  return call?.context?.messages?.some(message=>message.role==="toolResult"&&message.toolCallId===receipt.toolCallId);
}

export function adoptedReadOnlySource(home,record,stage) {
  const a=stage.assignment,result=readOnlyReport(home,record,stage);
  if(a.treatment?.decision!=="adopt"||!a.collected)
    throw problem("ROLE_REPORT","Manager did not adopt the saved role report");
  const receipt=readRequest(home,record.id,a.treatment.callId);
  if(receipt.role!=="main"||!ownedPhysicalRequest(record,record,receipt)||!reportReceived(receipt,a.collected)||
      !receipt.response?.content?.some(item=>item.type==="toolCall"&&item.name==="collect"&&
        item.id===a.treatment.toolCallId&&item.arguments.assignmentId===stage.id&&
        item.arguments.decision==="adopt"&&item.arguments.reason===a.treatment.reason))
    throw problem("ROLE_REPORT","Manager adoption has no matching physical tool receipt");
  const ref={kind:"readonly-report",sessionId:stage.sessionId,id:result.id,field:"text",sha256:a.reportDigest};
  return {sourceId:digest(ref),ref,kind:ref.kind,role:"assistant",derived:true,text:result.text,assignmentId:stage.id};
}

/** SavedRef is host data, never a path; verify persisted ownership before consuming bytes. */
export function resolveHandoffContext(home,rootTaskId,contextRef,{commandId}={}) {
  const root=readTask(home,rootTaskId),op=root.projectOperation;
  if(!contextRef||Object.keys(contextRef).sort().join(',')!=='field,sha256,taskId'||contextRef.taskId!==rootTaskId||contextRef.field!=='handoffContext'||root.flow!=='unified'||!root.handoffContext||!op||op.commandId!==commandId||digest(op.contextRef)!==digest(contextRef)||digest(root.handoffContext)!==contextRef.sha256||root.proposal?.contextDigest!==contextRef.sha256||root.proposal?.workspaceId!==root.workspace?.id||root.proposal?.sessionId!==root.handoffContext?.sessionId)throw problem('CONTEXT_SOURCE','Saved handoff reference or operation owner changed');
  const value=root.handoffContext,source=readTask(home,value.sourceTaskId);
  if(!source.handoffContext||value.sessionId!==source.sessionId||value.input!==source.input||digest(source.handoffContext)!==contextRef.sha256||source.workspace?.id!==root.workspace?.id||source.proposal?.canonicalRepo!==root.proposal?.canonicalRepo||source.proposal?.contextDigest!==contextRef.sha256)throw problem('CONTEXT_SOURCE','Saved handoff source provenance changed');
  for(const item of value.materials??[]){
    if(item.kind!=="readonly-report")continue;
    const stage=source.stages.find(stage=>stage.id===item.assignmentId);
    if(!stage||digest(item)!==digest(adoptedReadOnlySource(home,source,stage)))
      throw problem("CONTEXT_SOURCE","A read-only handoff report does not match its saved adoption");
  }
  return structuredClone(value);
}

export function reviewSource(task,roles,target,args,call,selectedModel) {
  const a=target.assignment;
  if(a.review||a.supersededBy||!a.collected||!reportReceived(call,a.collected)||
      args.reportDigest!==a.reportDigest||typeof args.criteria!=="string"||!args.criteria.trim()||args.criteria.length>4000)
    throw problem("REVIEW_SOURCE","Review requires the exact current report and concrete criteria");
  const result=readOnlyReport(task.home,task.record,target);
  const participantRoles=new Set([target.role,"main"]);
  for(let parent=roles.get(a.leaderId)?.stage;parent;parent=roles.get(parent.assignment.leaderId)?.stage)
    participantRoles.add(parent.role);
  const pending=[target];
  for(let current; (current=pending.pop());){
    for(const {stage} of roles.values()){
      const child=stage.assignment;
      if(child.leaderId!==current.id||!child.collected||child.review||child.treatment?.decision==="discard")continue;
      const request=readOnlyReport(task.home,task.record,current);
      if(reportReceived(request,child.collected)){
        participantRoles.add(stage.role);
        pending.push(stage);
      }
    }
  }
  const calls=task.requests().filter(item=>item.sent&&participantRoles.has(item.role));
  const selected=reviewFamily(selectedModel.id);
  if(calls.some(item=>reviewFamily(item.actualModel.modelId)===selected))
    throw problem("REVIEW_SOURCE","Reviewer participated in this report or its decisions");
  const identities=new Set(calls.map(observedIdentity));
  return {target,review:{participantIdentities:[...identities],artifact:{
    source:"Untrusted fixed report under independent review",assignmentId:target.id,reportDigest:a.reportDigest,
    resultRequestId:result.id,criteria:args.criteria,report:result.text,
  }}};
}

export function reviewReceipt(stage,review,call) {
  const message=call.context?.messages?.find(item=>item.role==="user");
  const content=typeof message?.content==="string"?message.content:message?.content?.find(part=>part.type==="text")?.text;
  let actual,verdict;
  try{
    // The first user block may also contain appended, separately granted attachments.
    actual=JSON.parse(content.split("\n\n[User attachment ")[0]).review;
    verdict=JSON.parse(call.text);
  }catch{}
  if(!actual||digest(actual)!==digest(review.artifact)||call.stageId!==stage.id||!call.sent||
    !["pass","reject","uncertain"].includes(verdict?.verdict)||typeof verdict.observation!=="string"||!verdict.observation.trim())
    throw problem("REVIEW_SOURCE","Missing a completed review of the fixed report and its criteria");
  const identity=observedIdentity(call);
  return {requestId:call.id,candidate:review.artifact.reportDigest,criteriaDigest:digest(review.artifact.criteria),
    observedIdentity:identity,certified:!!identity&&review.participantIdentities.every(other=>other&&other!==identity),
    verdict:verdict.verdict,observation:verdict.observation};
}

export function collectReadOnlyEvidence({task,roles,stages,requests,finalCall,cancel,gaps}) {
  const candidates=[];
  for(const stage of stages){
    const a=stage.assignment;
    if(a.pause?.status==="settled"&&a.status==="not_sent")continue;
    if(a.status==="outcome_unknown"||!a.collected){
      gaps.add(a.error?.message??"A required role report was left uncollected");
      continue;
    }
    if(a.review){
      const original=roles.get(a.review.artifact.assignmentId).stage;
      let current=original;
      while(current.assignment.supersededBy)
        current=roles.get(current.assignment.supersededBy).stage;
      if(current!==original){
        const replaced=stages.some(({assignment:{review,reviewReceipt,treatment}})=>
          review?.artifact.assignmentId===current.id&&review.artifact.reportDigest===current.assignment.reportDigest&&
          reviewReceipt?.certified&&reviewReceipt.verdict==="pass"&&treatment?.decision!=="discard");
        if(!replaced)gaps.add("Independent review is required for the latest report after correction");
        continue;
      }
    }
    if(a.treatment?.decision==="discard"||a.supersededBy)continue;
    if(a.status!=="completed"){
      gaps.add(a.error?.message??"A required role report failed");
      continue;
    }
    const result=readOnlyReport(task.home,task.record,stage);
    const supervisor=roles.get(a.leaderId)?.stage;
    const consumer=supervisor?.assignment.status==="completed"?readOnlyReport(task.home,task.record,supervisor):
      a.leaderId==="main"?finalCall:null;
    if(!reportReceived(consumer,a.collected)){
      gaps.add("The direct supervisor did not consume a collected report");
      continue;
    }
    if(a.review&&(!a.reviewReceipt?.certified||a.reviewReceipt.verdict!=="pass"))
      gaps.add("Independent review of the fixed report is unverified or has unresolved findings");
    const employeeCalls=requests.filter(call=>call.stageId===stage.id&&call.sent&&call.status==="completed");
    const checkRequestId=coveringProcessCheck(task.home,task.record,task.record,{memberId:stage.id},stage.id,employeeCalls);
    if(!checkRequestId)gaps.add("Required process check coverage is incomplete");
    const intervals=employeeCalls.map(({transport})=>({start:transport.dispatchedAt,end:transport.lastBodyAt??transport.headersAt}))
      .filter(({start,end})=>start&&end&&start<end);
    if(checkRequestId&&!a.review)candidates.push({taskId:task.record.id,memberId:stage.id,workId:a.workId,
      sessionId:stage.sessionId,resultRequestId:result.id,checkRequestId,identity:workModelIdentity(result.actualModel),intervals});
  }
  if(task.record.processCheck?.reports?.some(report=>report.status==="pending"&&report.taskId===task.record.id))
    gaps.add("A process check reported an issue after the manager’s last response");
  const unknown=task.record.processCheck?.observations?.some(observation=>observation.status==="outcome_unknown")||
    stages.some(stage=>stage.assignment.status==="outcome_unknown")||[...roles.values()].some(handle=>handle.stopError);
  if(cancel&&unknown)throw problem("ROOT_STOP_UNKNOWN","One or more role requests could not be confirmed stopped; query their original receipts");
  return {candidates,gap:gaps.size?[...gaps].join(". "):unknown?"Read-only request settlement is unknown":null,unknown};
}
