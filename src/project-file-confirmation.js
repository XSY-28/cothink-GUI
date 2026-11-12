import { loadInputMaterials } from "./context.js";
import {guiTurnIntent} from "./gui-turn-options.js";
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import {join,relative,sep} from 'node:path';
import { problem, readRequest, readTask } from './task.js';
import {legacyGit} from './git-versioning.js';
import { validProjectPath, inScope } from './versioning.js';
import { projectChatState } from './project.js';
import { digest, formalCollaborationCandidates, recordCollaborationResult } from "./project-collaboration-evidence.js";
import { adoptManagerFinal, resolveDeliveryEvidence } from "./project-delivery.js";

export function selectedExecutionScope(selectedPath, root, reportedPath) {
  const path=realpathSync(selectedPath),canonicalRoot=realpathSync(root);
  const relativePath=relative(canonicalRoot,path).split(sep).join('/')||'.';
  if(!validProjectPath(relativePath,true)||(reportedPath!==undefined&&reportedPath!==relativePath))
    throw problem('PROJECT_SCOPE','所选目录与已核实的仓库范围不一致。');
  return {path,root:canonicalRoot,relativePath};
}
export function checkPlanScope(plan, scope) {
  if(!plan||!scope||scope.relativePath==='.')return;
  const within=paths=>paths===undefined||(Array.isArray(paths)&&paths.every(path=>
    validProjectPath(path,true)&&inScope(path,[scope.relativePath])));
  const units=[plan,...(Array.isArray(plan.steps)?plan.steps:[])];
  for(const unit of units){
    const nested=[...(Array.isArray(unit?.works)?unit.works:[]),...(Array.isArray(unit?.subworks)?unit.subworks:[])];
    if([unit,...nested].some(value=>!value||!within(value.scope)||!within(value.readScope)||!within(value.deliverables)))
      throw problem('PROJECT_SCOPE',`文件工作限于仓库相对目录 ${scope.relativePath}。请提供该目录内的范围和交付路径。`);
  }
}

export function completedDelivery(state) {
  return state?.status==="completed"&&!!state.delivery&&
    state.delivery.version===state.version&&state.delivery.revision===state.revision;
}

export function assertConfirmedProjectState(proposal,{repo,version,state,expectedRevision}) {
  if(proposal.canonicalRepo!==repo||proposal.version!==version||(state?.revision??null)!==(expectedRevision??null))
    throw problem("PROPOSAL_STALE","Confirmed project version/revision changed before dispatch");
  if(proposal.reuseCompletedDelivery&&!completedDelivery(state))
    throw problem("PROPOSAL_STALE","已交付状态已变化，无法只沿用已有成果。请重新核对。");
}

export function workConfirmationBlocker(source) {
  const {proposal,frozenConfig}=source;
  if(!proposal)return null;
  const blocker=(source.turnIntent??guiTurnIntent(source.input??"",proposal.constraints)).blocker;
  if(blocker)return blocker;
  if(proposal.reuseCompletedDelivery)return null;
  if(proposal.budgetAtProposal?.remainingCalls===0)
    return "本轮模型请求额度已用完，请调整额度后重新发起计划。";
  if(frozenConfig&&!frozenConfig.work?.execution)
    return "提议生成时未配置项目执行环境。请完成设置后重新发起计划。";
  return null;
}

export function checkedProposal(home,source,ref,{sessionId,workspaceId}) {
  if(!source.handoffContext||source.proposal?.contextDigest!==digest(source.handoffContext))throw problem('PROPOSAL_SOURCE','Frozen handoff context changed');
  if(source.proposal?.packageDigest!==digest(source.packageSnapshot))throw problem('PROPOSAL_SOURCE','Frozen package provenance changed');
  if(source.flow!=='unified'||source.sessionId!==sessionId||source.workspace?.id!==workspaceId||!source.proposal||digest(source.proposal)!==ref.planDigest||digest(source.proposalRef)!==digest(ref)||ref.sourceTaskId!==source.id)throw problem('PROPOSAL_SOURCE','Proposal identity, branch or immutable bytes changed');
  if(['running','outcome_unknown'].includes(source.status)||source.cancelRequestedAt&&!source.cancelSettledAt)throw problem('PROPOSAL_PENDING','Source root is not settled');
  for(const claim of source.rootRequests??[]){const r=readRequest(home,claim.taskId,claim.requestId);if(r.status==='outcome_unknown'||r.sent&&r.usage==null&&source.budget.maxCost!==null)throw problem('PROPOSAL_PENDING','Source request outcome or required cost is unknown');}
  return source.proposal;
}
export async function reserveConfirmation({home,source,proposalRef,sessionId,workspaceId,submissionId,save}) {
  const proposal=checkedProposal(home,source,proposalRef,{sessionId,workspaceId});
  if(source.confirmationIntent)return source.confirmationIntent;
  const blocker=workConfirmationBlocker(source);
  if(blocker)throw problem('PROPOSAL_BLOCKED',blocker);
  const {repo,state}=await projectChatState(home,proposal.canonicalRepo);
  if(proposal.executionScope){
    selectedExecutionScope(proposal.executionScope.path,repo,proposal.executionScope.relativePath);
    checkPlanScope(proposal.plan,proposal.executionScope);
    if(state)checkPlanScope({...state,readScope:state.readScope??['.']},proposal.executionScope);
  }
  const currentVersion=state?.version??await legacyGit(repo,['rev-parse','--verify','HEAD^{commit}']);
  assertConfirmedProjectState(proposal,{repo,version:currentVersion,state,expectedRevision:proposal.expectedRevision});
  const consumed=(source.rootRequests??[]).filter(r=>!r.notSent).length;
  const remaining={...source.budget,maxCalls:source.budget.maxCalls===null?null:Math.max(0,source.budget.maxCalls-consumed)};
  if(remaining.maxCalls===0&&!proposal.reuseCompletedDelivery)throw problem('PROPOSAL_BLOCKED','本轮模型请求额度已用完，请调整额度后重新发起计划。');
  const reservation={taskId:randomUUID(),commandId:randomUUID(),submissionId,proposalRef:structuredClone(proposalRef),budgetSource:{sourceTaskId:source.id,consumed,budget:source.budget,remaining},status:'reserved'};
  source.confirmationIntent=reservation;save();return reservation;
}
export async function confirmationState({home,source,reservation,receiptOnly=false}) {
  if(typeof reservation.taskId!=="string"||!/^[\da-f-]{36}$/.test(reservation.taskId)||
    typeof reservation.commandId!=="string"||!/^[\da-f-]{36}$/.test(reservation.commandId)||
    !["reserved","consumed"].includes(reservation.status)||
    reservation.status==="consumed"&&reservation.consumedByTaskId!==reservation.taskId||
    digest(reservation.proposalRef)!==digest(source.proposalRef))
    throw problem("CONFIRMATION_ID","Reservation does not match its original proposal");
  const taskFile=join(home,'tasks',reservation.taskId+'.json');
  if(existsSync(taskFile)){
    const task=readTask(home,reservation.taskId);
    if(task.sessionId!==source.sessionId||task.submissionId!==reservation.submissionId||
      task.workspace?.id!==source.workspace?.id||task.workspace?.project!==source.workspace?.project||
      !task.confirmationSource||digest(task.confirmationSource)!==digest(reservation.proposalRef))
      throw problem('CONFIRMATION_ID','Reserved root does not match its original proposal');
    return {task,mayCreate:false};
  }
  if(reservation.status==="consumed")throw problem("CONFIRMATION_UNKNOWN","Consumed confirmation has no saved root; no replay");
  if(receiptOnly)return {task:null,mayCreate:false};
  const {queryProjectOperation}=await import('./project.js');
  const op=await queryProjectOperation({home,cwd:source.proposal.canonicalRepo,commandId:reservation.commandId});
  if(op.exists||op.state?.steps.some(s=>s.attempts.some(a=>a.rootTaskId===reservation.taskId))||op.state?.callIntents?.some(c=>c.rootTaskId===reservation.taskId))throw problem('CONFIRMATION_UNKNOWN','Command or child evidence exists without its reserved root; no replay');
  return {task:null,mayCreate:true};
}
export async function executeConfirmed(task,source,reservation) {
  task.signal.throwIfAborted();
  if(task.record.status!=='running')throw problem('ROOT_STOPPED','Root ended before confirmed execution');
  const {runProjectOperation}=await import('./project.js');
  task.signal.throwIfAborted();
  if(task.record.status!=='running')throw problem('ROOT_STOPPED','Root ended during confirmed execution admission');
  const p=source.proposal;
  if(p.executionScope){
    selectedExecutionScope(p.executionScope.path,p.canonicalRepo,p.executionScope.relativePath);
    checkPlanScope(p.plan,p.executionScope);
  }
  if(reservation.authorizationSource)task.record.operationAuthorization=reservation.authorizationSource;
  else task.record.confirmationSource=reservation.proposalRef;
  task.record.budgetSource=reservation.budgetSource;
  task.record.phase='project';
  if(!source.handoffContext||p.contextDigest!==digest(source.handoffContext)||source.handoffContext?.input!==source.input||source.handoffContext?.sourceTaskId!==source.id||source.handoffContext?.sessionId!==source.sessionId)throw problem('CONTEXT_SOURCE','Frozen proposal context changed or is missing');
  loadInputMaterials(task.home,source.handoffContext.attachmentRefs??[]);
  task.record.handoffContext=structuredClone(source.handoffContext);
  task.record.proposal=structuredClone(p);
  task.record.managerFinal=null;
  task.record.projectOperation={action:p.action,commandId:reservation.commandId,projectId:p.projectId,expectedRevision:p.expectedRevision,
    planRef:{taskId:task.record.id,field:'proposal',sha256:digest(p)},planDigest:digest(p),
    frozenConfigRef:{taskId:task.record.id,field:'frozenConfig',sha256:digest(task.record.frozenConfig)},
    contextRef:{taskId:task.record.id,field:'handoffContext',sha256:digest(task.record.handoffContext)},status:'intent',childTaskIds:[]};
  task.save();
  const control=new AbortController();let resolveSettled;
  const settled=new Promise(resolve=>{resolveSettled=resolve;});
  task.rootOwner.registerExecution({commandId:reservation.commandId,cancel:()=>control.abort(),settled});
  try {
    const result=await runProjectOperation({home:task.home,cwd:p.canonicalRepo,action:p.action,commandId:reservation.commandId,rootTaskId:task.record.id,expectedRevision:p.expectedRevision??undefined,providedPlan:p.action==='resume'?undefined:p.plan,
      frozenConfig:task.record.frozenConfig,contextRef:task.record.projectOperation.contextRef,rootOwner:task.rootOwner,signal:AbortSignal.any([task.signal,control.signal])});
    task.record.executionBinding=result.executionBinding;
    task.record.projectOperation.projectId=result.state.id;
    task.record.projectOperation.status=result.state.status;
    task.record.projectOperation.revision=result.state.revision;
    let collaborationCandidates=[];
    let delivery;
    if(result.state.delivery){
      const sources=result.state.steps.filter(s=>s.status==='completed').map(step=>{
        const a=step.attempts.at(-1),child=readTask(task.home,a.taskId);
        return {taskId:a.taskId,callId:child.finalCallId,relation:a.rootTaskId===task.record.id?'owned':'inherited'};
      });
      task.record.deliveryRef={projectId:result.state.id,commandId:reservation.commandId,revision:result.state.revision,sources,version:result.state.delivery.version,
        artifactsDigest:digest(result.state.delivery.artifacts),
        ...(result.state.delivery.visual ? {visualDigest:digest(result.state.delivery.visual)} : {}),
        checksRef:result.state.delivery.requestIds.map(requestId=>({projectId:result.state.id,revision:result.state.revision,requestId,version:result.state.delivery.version}))};
      if(task.signal.aborted){task.save();return task;}
      try { delivery=resolveDeliveryEvidence(task.home,task.record); }
      catch(error){
        task.finish("partial","正式交付来源尚不能核验："+error.message);
        return task;
      }
      if (p.collaboration?.length) collaborationCandidates=formalCollaborationCandidates(task,result.state,delivery.sources);
      if(delivery.visualError){
        task.finish("partial",delivery.visualError);
        return task;
      }
      if (task.record.workspace.managedDirectory) {
        task.save();
        try {
          const {placeConversationDelivery}=await import("./gui-work.js");
          await placeConversationDelivery(task.home,task.record.workspace,result.state.delivery.version);
          task.record.deliveryPlacement={status:"placed",version:result.state.delivery.version};
        } catch (error) {
          task.record.deliveryPlacement={status:"failed",version:result.state.delivery.version,error:error.message};
          if(task.signal.aborted){task.save();return task;}
          task.finish("partial","成果已保存，但未能放入对话文件夹："+error.message);
          return task;
        }
      }
    }
    const collaborationGap=recordCollaborationResult(task,{requirements:p.collaboration??[],candidates:collaborationCandidates});
    const completionBlockers=collaborationGap?[...new Set((delivery?.sources??[])
      .map(({record})=>record.completionFeedback?.reason).filter(Boolean))]:[];
    task.save();
    if(task.signal.aborted){return task;}
    if(delivery&&result.state.status==='completed'&&!collaborationGap){
      try { await adoptManagerFinal(task,delivery); }
      catch(error) {
        if(task.ioError)throw task.ioError;
        if(task.signal.aborted)return task;
        const unknown=task.requests().some(call=>call.phase==='manager-final'&&call.sent&&call.status==='outcome_unknown');
        task.finish(unknown?'outcome_unknown':'partial','文件已通过核对，缺少经理终稿：'+error.message);
        return task;
      }
    }
    task.finish(result.state.status==='completed'&&!collaborationGap?'completed':result.state.steps.some(step=>step.status==='unknown')?'outcome_unknown':result.state.status==='paused'?'blocked':'partial',[result.state.error,collaborationGap,...completionBlockers].filter(Boolean).join(" ")||null);return task;
  }finally{try { await task.rootOwner.processCheck.close(); } finally { resolveSettled(); }}
}
