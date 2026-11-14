import {restorationPaths} from './work-changes.js';
export {restorationPaths} from './work-changes.js';
export {admitContinuationRestore,bindContinuationRoute} from './project-completed-continuation.js';
import {inspectRepairVerification,inspectUnspentRepair} from './project-route.js';
import {hostOnlyRequest} from './transport-diagnostics.js';
import {completedContinuationCovers,recoverContinuationRoute} from './project-completed-continuation.js';
export {completedContinuationEvidence,completedContinuationCovers} from './project-completed-continuation.js';
import {isDeepStrictEqual} from 'node:util';
import {readTask,readRequest,readRequests,problem} from './task.js';
import {createVersioning,inScope,projectScopesOverlap} from './versioning.js';
import {projectChatState} from './project.js';
import {executionFacts} from './project-delivery-checks.js';
import {resolveDeliveryEvidence} from './project-delivery.js';

// These helpers read only the continuation written under the existing project writer.
// A caller-provided request list or a model tool argument is never authority.
export function confirmedContinuation(state,taskId) {
  const attempt=(state.steps??[]).flatMap(s=>s.attempts??[]).find(a=>a.taskId===taskId);
  const command=attempt&&state.commands?.[attempt.commandId];
  return attempt?.continuation&&command?.rootTaskId===attempt.rootTaskId&&
    isDeepStrictEqual(command.continuation,attempt.continuation)?attempt.continuation:null;
}
/** One dependency closure for eligibility, revision and execution authority. */
export function affectedProjectSteps(state,stepIds) {
  const affected=new Set(stepIds);
  for(let pass=0;pass<state.steps.length;pass++)for(const step of state.steps)
    if(step.dependsOn.some(id=>affected.has(id)))affected.add(step.id);
  return state.steps.filter(step=>affected.has(step.id)).map(step=>step.id);
}
export function continuationLineage(home,state,source) {
  const roots=[source],seen=new Set([source.id]);let current=source;
  while(current.projectOperation?.continuation) {
    const op=current.projectOperation,ref=op.continuation,command=state.commands?.[op.commandId];
    if(seen.has(ref.sourceRootTaskId))throw problem('CONTINUATION_SOURCE','继续来源存在循环');
    const previous=readTask(home,ref.sourceRootTaskId),reservation=previous.fileContinuationIntent;
    if(command?.rootTaskId!==current.id||command.status!=='settled'||!isDeepStrictEqual(command.continuation,ref)||
      previous.flow!=='unified'||previous.projectOperation?.projectId!==state.id||
      previous.sessionId!==source.sessionId||previous.workspace?.id!==source.workspace?.id||
      previous.proposal?.canonicalRepo!==state.repo||previous.proposal.contextDigest!==source.proposal.contextDigest||
      reservation?.taskId!==current.id||reservation.commandId!==op.commandId||
      !['reserved','consumed'].includes(reservation.status)||
      reservation.consumedByTaskId&&reservation.consumedByTaskId!==current.id||
      !isDeepStrictEqual(reservation.continuation,ref)||
      !isDeepStrictEqual(reservation.authorizationSource,current.operationAuthorization)||
      current.operationAuthorization?.kind!=='file_continuation'||current.operationAuthorization.sourceTaskId!==previous.id)
      throw problem('CONTINUATION_SOURCE','祖先继续授权或原命令回执不匹配：'+current.id);
    const permitted=new Set([...(previous.rootRequests??[]).map(r=>r.requestId),...(previous.projectOperation.continuation?.requestIds??[])]);
    if(ref.requestIds.some(id=>!permitted.has(id)))throw problem('CONTINUATION_SOURCE','祖先未知请求不属于已确认来源：'+current.id);
    roots.push(previous);seen.add(previous.id);current=previous;
  }
  return roots;
}
export function continuationSourceRoots(state,ref) {
  const roots=new Set();let current=ref;
  while(current&&!roots.has(current.sourceRootTaskId)) {
    roots.add(current.sourceRootTaskId);
    current=Object.values(state.commands??{}).find(c=>c.rootTaskId===current.sourceRootTaskId&&c.continuation)?.continuation;
  }
  return roots;
}
export function continuedTask(state,currentTaskId,oldTaskId,proofs) {
  if(completedContinuationCovers(state,currentTaskId,proofs,{taskId:oldTaskId}))return true;
  const ref=confirmedContinuation(state,currentTaskId);
  if(!ref)return false;
  const current=state.steps.find(step=>step.attempts.some(a=>a.taskId===currentTaskId));
  if(!current||!affectedProjectSteps(state,[ref.stepId]).includes(current.id))return false;
  return (state.steps??[]).some(s=>s.attempts.some(a=>a.taskId===oldTaskId&&continuationSourceRoots(state,ref).has(a.rootTaskId))&&
    (s===current||s.status==='completed'&&affectedProjectSteps(state,[s.id]).includes(current.id)));
}
export function continuedRequest(state,currentTaskId,requestId,proofs) {
  return completedContinuationCovers(state,currentTaskId,proofs,{requestId})||confirmedContinuation(state,currentTaskId)?.requestIds.includes(requestId)===true;
}

async function savedInput(state,step,record,v,version,changeId) {
  const attempt=step.attempts.find(a=>a.taskId===record.id),work=record.work;
  if(!attempt||record.rootTaskId!==attempt.rootTaskId||record.submissionId!==attempt.submissionId||
    record.project?.id!==state.id||record.project.stepId!==step.id||record.project.commandId!==attempt.commandId||
    work?.root!==state.repo||work.integrationRef!==state.integrationRef||work.startVersion!==attempt.startVersion||
    !Array.isArray(work.changes)||work.changes.some(c=>!c.readOnly)||
    !isDeepStrictEqual(record.project.scope,step.scope)||!isDeepStrictEqual(record.project.checks,step.checks))return null;
  const saved=work.changes.findLast(c=>(!changeId||c.changeId===changeId)&&c.readOnly&&
    (c.actor==='main'||c.actor==='result'&&c.changeId===work.resultChangeId)&&c.baseVersion===version&&c.privateVersion===version);
  if(!saved)return null;
  const fact=await v.inspect({changeId:saved.changeId});
  if(!fact.readOnly||fact.actor!==saved.actor||fact.baseVersion!==version||fact.privateVersion!==version)return null;
  return {taskId:record.id,changeId:saved.changeId,baseVersion:version,version};
}


export async function inspectFileContinuation({home,sourceRootTaskId,draft}) {
  const source=readTask(home,sourceRootTaskId),blockers=[];
  const add=(code,sourceId,message)=>blockers.push({code,sourceId,message});
  const result={eligible:false,blockers,requestIds:[],stepId:null,draft:null,projectId:null,revision:null,formalVersion:null};
  if(source.flow!=='unified'||!source.projectOperation||!source.proposal?.canonicalRepo) {
    add('CONTINUATION_SOURCE',source.id,'原任务没有可核对的项目执行来源');return result;
  }
  const {state}=await projectChatState(home,source.proposal.canonicalRepo);
  if(!state||state.id!==source.projectOperation.projectId) {add('CONTINUATION_PROJECT',source.id,'项目身份已变化');return result;}
  Object.assign(result,{projectId:state.id,revision:state.revision});
  if(source.status==='completed')add('CONTINUATION_COMPLETE',source.id,'已完成任务没有剩余工作需要接续');
  if(source.cancelRequestedAt)add('CONTINUATION_CANCELLED',source.id,'主动取消的任务不适用模型断连接续');
  if(source.localExecutionCloseError)add('LOCAL_CLOSE_FAILED',source.id,source.localExecutionCloseError);
  const ownAttempts=state.steps.flatMap(step=>step.attempts.filter(a=>a.rootTaskId===source.id).map(attempt=>({step,attempt})));
  const sourceRevision=source.projectOperation.revision??Math.max(0,...ownAttempts.map(({attempt})=>attempt.revision));
  if(sourceRevision!==state.revision)add('CONTINUATION_REVISION',source.id,'原目标所属项目修订已变化，请核对当前要求');
  const records=[source],requests=[];
  for(const {attempt} of ownAttempts)try {records.push(readTask(home,attempt.taskId));}
    catch(error){add('CONTINUATION_SOURCE',attempt.taskId,'原执行记录不可核实：'+error.message);}
  for(const record of records)try {requests.push(...readRequests(home,record));}
    catch(error){add('CONTINUATION_SOURCE',record.id,'原请求记录不可核实：'+error.message);}
  const unknown=requests.filter(r=>r.sent&&r.status==='outcome_unknown');
  let lineage=[source];
  try {lineage=continuationLineage(home,state,source);}catch(error){add(error.code,source.id,error.message);}
  const claims=new Map(lineage.flatMap(root=>(root.rootRequests??[]).map(claim=>[claim.requestId,claim])));
  for(const id of source.projectOperation.continuation?.requestIds??[]) {
    if(unknown.some(r=>r.id===id))continue;
    const claim=claims.get(id);
    try {
      if(!claim)throw problem('CONTINUATION_SOURCE','祖先请求缺少原始发送记录：'+id);
      const request=readRequest(home,claim.taskId,id);
      if(!request.sent||request.status!=='outcome_unknown')throw problem('PROPOSAL_STALE','祖先请求已有新回执：'+id);
      unknown.push(request);
    }catch(error){add(error.code??'CONTINUATION_SOURCE',id,error.message);}
  }
  result.requestIds=unknown.map(r=>r.id);
  if(!unknown.length)add('NO_UNKNOWN_MODEL',source.id,'原任务及已确认继续链不存在可接续的未知模型响应');
  for(const request of unknown) {
    if(!hostOnlyRequest(request))add('SERVER_EXECUTION_UNKNOWN',request.id,'无法核实该模型请求仅使用宿主执行工具');
    if(request.phase==='project-effect')add('EFFECT_UNKNOWN',request.id,'原生成效果尚未确认，不能以继续重做');
  }
  const consumed=(source.rootRequests??[]).filter(r=>!r.notSent).length;
  result.remainingBudget={...source.budget,maxCalls:source.budget.maxCalls===null?null:Math.max(0,source.budget.maxCalls-consumed)};
  if(result.remainingBudget.maxCalls===0)add('ROOT_BUDGET',source.id,'原根任务剩余调用额度不足');
  if(source.budget.maxCost!==null||state.budget.maxCost!==null)add('COST_UNKNOWN',source.id,'硬费用边界无法核实，不能新增付费调用');
  if(state.budget.maxCalls!==null&&(state.callIntents??[]).filter(c=>!c.notSent).length>=state.budget.maxCalls)
    add('PROJECT_BUDGET',state.id,'原项目调用额度不足');
  let v;
  try {
    v=await createVersioning({home,project:state.repo,backend:'agent-sync',readOnly:true});
    const formal=await v.inspect();result.formalVersion=formal.version;
    if(formal.integrationRef!==state.integrationRef)add('FORMAL_REF_CHANGED',state.id,'正式 ref 已变化');
    const finalOnly=state.status==='completed'&&source.deliveryRef;
    if(finalOnly) {
      try { resolveDeliveryEvidence(home,source);if(state.delivery?.version!==formal.version)throw Error('正式交付版本已变化'); }
      catch(error){add('DELIVERY_SOURCE',source.id,error.message);}
      if(draft)add('CONTINUATION_SOURCE',source.id,'仅补终稿不能选择文件草稿');
    } else {
      const {resolveTaskDraft}=await import('./gui-work.js');
      const candidates=[];
      for(const {step,attempt} of ownAttempts) {
        const record=records.find(r=>r.id===attempt.taskId);
        for(const change of record?.work?.changes??[]) {
          if(change.readOnly)continue;
          try {const ref=await resolveTaskDraft({home,record,changeId:change.changeId});if(ref)candidates.push({step,ref});}catch{}
        }
      }
      if(!candidates.length)for(const {step,attempt} of ownAttempts.filter(x=>x.step.status!=='completed')) {
        const record=records.find(r=>r.id===attempt.taskId);
        const ref=record&&await savedInput(state,step,record,v,formal.version);
        if(ref)candidates.push({step,ref,inputOnly:true});
      }
      // A failed startup may have no new projection. Reuse only its already
      // confirmed source reference; never prefer it over a newly saved draft.
      const previous=source.projectOperation.continuation;
      const startup=ownAttempts.find(({step,attempt})=>step.id===previous?.stepId&&records.some(r=>
        r.id===attempt.taskId&&!r.requestIds.length&&!r.tools?.length&&!r.work?.changes?.length))??
        (!ownAttempts.length&&!source.requestIds.length&&!source.rootRequests?.length&&!source.tools?.length&&
          !source.projectOperation.childTaskIds?.length?{step:state.steps.find(s=>s.id===previous?.stepId)}:null);
      if(!candidates.length&&startup?.step&&previous?.draft) {
        const record=readTask(home,previous.draft.taskId);
        if(lineage.some(root=>root.id===record.rootTaskId&&root.projectOperation?.childTaskIds.includes(record.id))) {
          const draftRef=await resolveTaskDraft({home,record,changeId:previous.draft.changeId});
          const ref=draftRef??await savedInput(state,startup.step,record,v,formal.version,previous.draft.changeId);
          if(isDeepStrictEqual(ref,previous.draft))candidates.push({step:startup.step,ref,inputOnly:!draftRef});
        }
      }
      result.drafts=candidates.map(c=>c.ref);
      const chosen=draft===undefined?(candidates.length===1?candidates[0]:null):candidates.find(c=>isDeepStrictEqual(c.ref,draft));
      if(!chosen)add('DRAFT_REQUIRED',source.id,draft===null?'空草稿引用仅允许核实交付后的终稿接续':candidates.length>1?'请选择确切保存草稿':'没有可核实的保存草稿');
      else {
        result.draft=chosen.ref;result.stepId=chosen.step.id;
        result.inputOnly=!!chosen.inputOnly;
        const recovered=await recoverContinuationRoute({home,state,source,step:chosen.step,versioning:v,formalVersion:formal.version,draft:chosen.ref});
        const route=recovered??chosen.step.route;
        if(recovered)result.recoveredRoute=recovered;
        result.requiresManual=result.inputOnly||!!recovered?.scopeRestoration||!!recovered?.inputOnlyFailure||!!route&&route.status!=='resolved';
        const verification=route?.status==='repair'?await inspectRepairVerification({versioning:v,route,step:chosen.step,
          record:readTask(home,route.taskId),draft:chosen.ref}):null;
        const unspent=route?.status==='repair'&&await inspectUnspentRepair({home,versioning:v,route,step:chosen.step,record:readTask(home,route.taskId),draft:chosen.ref});
        if(unspent)result.remainingRepair=route.judgment.repairScope;
        if(verification?.verified)result.repairVerification=verification.proof;
        else if(!unspent&&route&&route.status!=='resolved'&&result.requiresManual&&!recovered?.scopeRestoration&&!recovered?.inputOnlyFailure&&
          (result.inputOnly||route.status!=='paused'||!['scope_expansion','failed'].includes(route.kind)))
          add('PROJECT_ROUTE',route.taskId??source.id,verification?.reason??'原路线尚未解决；不能用继续清除判断或探测状态');
        const restored=await restorationPaths(v,chosen.ref,formal.version,chosen.step.scope);
        result.restorePaths=restored.paths;
        for(const path of restored.conflicts)add('RESTORE_CONFLICT',path,'正式版本与草稿存在重叠修改：'+path);
      }
    }
    result.affectedStepIds=result.stepId?affectedProjectSteps(state,[result.stepId]):[];
    const scope=result.stepId?state.steps.filter(step=>result.affectedStepIds.includes(step.id)).flatMap(step=>step.scope):state.scope;
    if(source.projectOperation.continuation?.stepId&&result.stepId&&
      !affectedProjectSteps(state,[source.projectOperation.continuation.stepId]).includes(result.stepId))
      add('CONTINUATION_SCOPE',result.stepId,'当前草稿不在祖先授权的继续步骤范围内');
    for(const {step,attempt} of state.steps.flatMap(step=>step.attempts.map(attempt=>({step,attempt})))) {
      if(!projectScopesOverlap(scope,step.scope))continue;
      const record=records.find(r=>r.id===attempt.taskId)??readTask(home,attempt.taskId);
      const facts=await executionFacts(v,record,readRequests(home,record));
      blockers.push(...facts.pendingEffects);
      if(lineage.some(root=>root.id===attempt.rootTaskId)&&!locallyClosed(record,readRequests(home,record),facts))
        add('LOCAL_CLOSE_MISSING',record.id,'缺少文件执行和工具结清回执');
    }
    for(const root of lineage) {
      const rootFacts=await executionFacts(v,root,readRequests(home,root));blockers.push(...rootFacts.pendingEffects);
      if(!locallyClosed(root,readRequests(home,root),rootFacts))add('LOCAL_CLOSE_MISSING',root.id,'缺少原任务模型、工具入口和执行结清证据');
    }
    for(const intent of state.callIntents??[]) if(intent.kind==='external'&&['intent','pending','outcome_unknown','unknown'].includes(intent.status)&&
      (!intent.scope?.length||projectScopesOverlap(scope,intent.scope)))add('MCP_PENDING',intent.id,'项目外部操作仍未结清');
  }catch(error){add(error.code??'CONTINUATION_INSPECT',source.id,error.message);}finally{await v?.close();}
  result.eligible=blockers.length===0;return result;
}

export function locallyClosed(record,requests,facts) {
  if(record.localExecutionCloseError||record.nativeShutdownError||record.cancelStopError||record.work?.cleanupErrors?.length)return false;
  if(Object.hasOwn(record,'localExecutionClosedAt'))return typeof record.localExecutionClosedAt==='string'&&Number.isFinite(Date.parse(record.localExecutionClosedAt));
  if(record.cancelSettledAt)return true;
  // Older terminal records seal host task/role tools. Public change receipts and
  // original request endings additionally prove the actual local work drained.
  return !!record.endedAt&&!['running','cancelling','stop_unknown'].includes(record.status)&&
    requests.every(r=>!!r.endedAt&&!['preparing','in_flight'].includes(r.status))&&
    facts.pendingEffects.length===0&&
    (record.stages??[]).every(s=>!s.assignment||s.assignment.settledAt);
}

/** Add verified source identities; the existing participation extractor checks their receipts. */
export function continuationSources(task,state,sources) {
  const continuation=task.record.projectOperation?.continuation;
  const command=state.commands?.[task.record.projectOperation?.commandId];
  const inheritedRoots=continuation&&command?.rootTaskId===task.record.id&&
    isDeepStrictEqual(command.continuation,continuation)?continuationSourceRoots(state,continuation):new Set();
  const inputs=[...sources],seen=new Set(sources.map(source=>source.record.id));
  for(const step of state.steps)for(const attempt of step.attempts) {
    if(!inheritedRoots.has(attempt.rootTaskId)||seen.has(attempt.taskId))continue;
    try {
      const child=readTask(task.home,attempt.taskId);
      if(child.rootTaskId!==attempt.rootTaskId||child.project?.commandId!==attempt.commandId||
        child.project?.id!==state.id||child.project?.stepId!==step.id)continue;
      inputs.push({record:child,stepId:step.id,relation:'inherited'});seen.add(child.id);
    }catch { /* Missing historical receipts cannot supply participation evidence. */ }
  }
  return {inputs,inheritedRoots};
}

/** At each actual dispatch, later complete receipts invalidate the old permission. */
export function assertContinuationRequests(home,ref) {
  if(!ref)return;
  const claims=new Map(),visited=new Set();let id=ref.sourceRootTaskId;
  while(id&&!visited.has(id)) {
    visited.add(id);const source=readTask(home,id);
    for(const claim of source.rootRequests??[])claims.set(claim.requestId,claim);
    id=source.projectOperation?.continuation?.sourceRootTaskId;
  }
  for(const requestId of ref.requestIds) {
    const claim=claims.get(requestId);
    if(!claim)throw problem('PROPOSAL_STALE','原继续请求来源已变化：'+requestId);
    const request=readRequest(home,claim.taskId,requestId);
    if(!request.sent||request.status!=='outcome_unknown')
      throw problem('PROPOSAL_STALE','原请求已有新的回执，请刷新继续确认：'+requestId);
  }
}
