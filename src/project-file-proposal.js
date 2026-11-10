import { randomUUID } from 'node:crypto';
import { problem, readTask } from './task.js';
import {legacyGit} from './git-versioning.js';
import { projectChatState, validateChatPlan, validateProjectRevision, assertProjectReviewRequirement, preserveReviewRequest } from './project.js';
import { projectVisualInput } from './visual-preview.js';
import { checkedPlanCollaboration, digest, userCollaboration } from "./project-collaboration-evidence.js";
import { checkPlanScope, completedDelivery, executeConfirmed, selectedExecutionScope, workConfirmationBlocker } from "./project-file-confirmation.js";
import { resolveHandoffContext } from "./project-readonly-reports.js";

export function validateWorkIntent(task,args) {
  if(!args||Object.keys(args).some(key=>!["action","reason","plan","planRef"].includes(key))||
    !["start","resume","revise"].includes(args.action)||typeof args.reason!=="string"||!args.reason.trim()||
    (args.action==="resume"?(!args.planRef||args.plan!==undefined):(!args.plan||args.planRef!==undefined)))
    throw problem("WORK_PLAN","start/revise require a complete plan, resume requires planRef, and reason must be nonempty");
  let plan=args.plan,previous,authorityRoot,planCollaboration;
  if(args.planRef){
    const ref=args.planRef;
    if(ref.field!=="proposal"||typeof ref.taskId!=="string"||!/^[\da-f-]{36}$/i.test(ref.taskId)||
      !/^[\da-f]{64}$/i.test(ref.sha256??"")||Object.keys(ref).length!==3||
      !task.record.contextTaskIds?.includes(ref.taskId))
      throw problem("WORK_PLAN","planRef must refer to a saved proposal in this conversation branch");
    previous=readTask(task.home,ref.taskId);
    if(previous.workspace?.id!==task.record.workspace.id||!previous.proposal||digest(previous.proposal)!==ref.sha256)
      throw problem("WORK_PLAN","Saved plan does not belong to this conversation");
    plan=previous.proposal.plan;
    authorityRoot=previous.executionBinding?previous:previous.confirmationIntent?.consumedByTaskId?readTask(task.home,previous.confirmationIntent.consumedByTaskId):null;
  }else{
    if(Object.hasOwn(plan,"repo"))throw problem("WORK_PLAN","Model plans cannot choose a repository");
    if(task.record.constraints.requireDifferentModelReview)plan={...plan,independentReview:true};
    if(task.record.turnIntent?.workRequest)
      plan={...plan,workRequest:{...plan.workRequest,...task.record.turnIntent.workRequest}};
    // The same validator builds the formal definitions. Keep the original plan
    // shape for saved refs while preserving any review requirement in the input.
    const {plan:checkedPlan,state:checked}=validateChatPlan(plan,{userInput:task.record.input});
    plan=checkedPlan;
    planCollaboration=checkedPlanCollaboration(plan,checked.steps);
    if (planCollaboration&&!task.record.constraints.allowedSubtasks.includes("work"))
      throw problem("WORK_PLAN","plan.collaboration conflicts with this turn's delegation limit");
    if(!task.record.constraints.allowedSubtasks.includes("review")&&
      checked.steps.some(step=>step.works.some(work=>work.independentReview)))
      throw problem("REVIEW_REQUIRED","Plan review requirement conflicts with forbidden review delegation");
    if(plan.workRequest)
      plan={...plan,workRequest:{kind:"html-svg",...projectVisualInput(plan.workRequest,checked.steps.flatMap(step=>step.deliverables))}};
  }
  return {plan,previous,authorityRoot,planCollaboration};
}
export async function checkWorkProject(task,args,{plan,previous,authorityRoot,planCollaboration},admittedScope) {
  const {state,repo}=await projectChatState(task.home,admittedScope?.root??task.record.workspace.project);
  if(admittedScope&&repo!==admittedScope.root)throw problem('PROJECT_SCOPE','目录的实际仓库已改变，请重新选择。');
  const scope=selectedExecutionScope(task.record.workspace.project,repo,admittedScope?.relativePath);
  if(state)checkPlanScope({...state,readScope:state.readScope??['.']},scope);
  plan={...plan,readScope:plan.readScope??plan.scope};
  checkPlanScope(plan,scope);
  if(previous&&previous.proposal.canonicalRepo!==repo)
    throw problem("WORK_PLAN","Saved plan does not belong to this conversation");
  if(args.action==='start'&&state)throw problem('WORK_PLAN','Project already exists; use its saved resume/revise intent');
  if(args.action!=='start'&&!state)throw problem('WORK_PLAN','No formal project exists to resume or revise');
  if(args.action==='resume'){
    if(!authorityRoot||authorityRoot.projectOperation?.revision!==state.revision)
      throw problem('WORK_PLAN','Saved resume authority does not describe the current project revision');
    const requiresAdditionalReview=preserveReviewRequest(task.record.input,plan)!==plan;
    assertProjectReviewRequirement(state,requiresAdditionalReview?{requireDifferentModelReview:true}:task.record.constraints);
    if(!task.record.constraints.allowedSubtasks.includes("review")&&state.steps.some(step=>
      [...step.works,...(step.subworks??[])].some(work=>work.independentReview)))
      throw problem("REVIEW_REQUIRED","Saved project review requirement conflicts with forbidden review delegation");
  }
  if(args.action==='revise')validateProjectRevision(state,plan);
  const version=state?.version??await legacyGit(repo,['rev-parse','--verify','HEAD^{commit}']);
  return {plan,state,repo,scope,authorityRoot,version,planCollaboration,previous};
}
export async function prepareWork(task,intent,{plan,state,repo,scope,authorityRoot,version,planCollaboration,previous}) {
  // Formal execution and confirmation are connected below; proposal is immutable after saving.
  const args=intent.args;
  // Keep the actual earlier operation inputs even when their surrounding history
  // has been compacted. Do not re-expand the earlier snapshots' material arrays.
  const inherited=new Map();
  const attachmentRefs=new Map((task.record.handoffContext.attachmentRefs??[]).map(ref=>[ref.id,ref]));
  for(const attempt of state?.steps.flatMap(step=>step.attempts)??[]){
    if(!attempt.rootTaskId||!attempt.contextRef)continue;
    const context=resolveHandoffContext(task.home,attempt.rootTaskId,attempt.contextRef,{commandId:attempt.commandId});
    for(const ref of context.attachmentRefs??[])if(!attachmentRefs.has(ref.id))attachmentRefs.set(ref.id,ref);
    for(const item of [...(context.inheritedInputs??[]),{input:context.input,sourceTaskId:context.sourceTaskId,sessionId:context.sessionId,rootTaskId:attempt.rootTaskId,commandId:attempt.commandId,contextRef:attempt.contextRef,source:'Earlier confirmed operation user input; preserve constraints, current confirmed plan defines execution authority'}])inherited.set(item.sourceTaskId,item);
  }
  task.record.handoffContext.inheritedInputs=[...inherited.values()];
  if(attachmentRefs.size)task.record.handoffContext.attachmentRefs=[...attachmentRefs.values()];
  task.record.proposal={action:args.action,plan,constraints:task.record.constraints,canonicalRepo:repo,...(scope?{executionScope:scope}:{}),version,projectId:state?.id??null,expectedRevision:state?.revision??null,toolCallId:intent.toolCallId,workspaceId:task.record.workspace.id??null,sessionId:task.record.sessionId,budget:task.record.budget,contextDigest:digest(task.record.handoffContext),packageDigest:digest(task.record.packageSnapshot),budgetAtProposal:{spentCalls:task.record.rootRequests.filter(r=>!r.notSent).length,remainingCalls:task.record.budget.maxCalls===null?null:Math.max(0,task.record.budget.maxCalls-task.record.rootRequests.filter(r=>!r.notSent).length)},source:{taskId:task.record.id,callId:intent.callId}};
  const collaboration=[...userCollaboration(task.record),...(previous?.proposal.collaboration??[])];
  if (planCollaboration) collaboration.push({...planCollaboration,source:{kind:"plan",taskId:task.record.id,callId:intent.callId,field:"plan.collaboration"}});
  if (collaboration.length) task.record.proposal.collaboration=collaboration;
  // Parallel interpretation requires a new host-issued approval. Old proposals
  // and plans relying on implicit ordering retain their sequential execution.
  if(args.action==='start')task.record.proposal.stepScheduling=plan.steps?.length>1&&
    plan.steps.every(step=>Array.isArray(step.dependsOn))?'dependencies-v1':'sequential-v1';
  if(args.action==="resume"&&completedDelivery(state))task.record.proposal.reuseCompletedDelivery=true;
  task.record.proposalRef={sourceTaskId:task.record.id,toolCallId:intent.toolCallId,planDigest:digest(task.record.proposal),workspace:task.record.workspace.id??null,revision:state?.revision??null};
  if(args.action==='resume' && state.status!=='paused' && !authorityRoot?.cancelRequestedAt && authorityRoot?.sessionId===task.record.sessionId && authorityRoot.executionBinding?.projectId===state.id && authorityRoot.executionBinding.canonicalRepo===repo && state.entryPolicy==='unified' && !workConfirmationBlocker(task.record)){
    const authorizationSource={kind:'existing_project',taskId:authorityRoot.id,projectId:state.id,revision:state.revision};
    const reservation={commandId:randomUUID(),proposalRef:task.record.proposalRef,budgetSource:{sourceTaskId:task.record.id,consumed:task.record.proposal.budgetAtProposal.spentCalls,remaining:task.record.budget},authorizationSource};
    delete task.record.proposalRef;task.save();return executeConfirmed(task,task.record,reservation);
  }
  task.save();task.finish('blocked','具体工作提议已保存，请核对计划后确认执行。');return task;
}
