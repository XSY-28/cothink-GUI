import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { problem, readRequest, readTask } from './task.js';
import { validProjectPath } from './versioning.js';
import {checkedVisualReview,projectVisualInput} from './visual-preview.js';
import {checkedCombinedVisual} from "./visual-project-delivery.js";
import { digest } from "./project-collaboration-evidence.js";

export function resolveDelivery(home,record) {
  return resolveDeliveryEvidence(home,record)?.sources??[];
}

function managerFinalBinding(record) {
  return digest([record.id,record.sessionId,record.models.main,record.proposal.contextDigest,record.constraints,record.deliveryRef]);
}
function sameCompletedDelivery(a,b) {
  const identity=ref=>[ref.projectId,ref.version,ref.artifactsDigest,ref.visualDigest??null,
    ref.sources.map(({taskId,callId})=>[taskId,callId]).sort(),ref.checksRef.map(({requestId,version})=>[requestId,version]).sort()];
  return !!(a&&b&&digest(identity(a))===digest(identity(b)));
}
function canonicalStepFinal(record,delivery) {
  // A step report's saved scope can cover the full receipt only if there are no other source reports.
  if(delivery.sources.length!==1||record.deliveryRef.visualDigest)return null;
  const {record:step,call,relation}=delivery.sources[0],main=record.models.main;
  if(relation!=='owned'||step.input!==record.handoffContext.input||!step.project?.handoffContext||
    digest(step.project.handoffContext)!==record.proposal.contextDigest||
    step.work?.version!==record.deliveryRef.version||delivery.checks.length!==1||
    step.work.finalCheck?.requestId!==delivery.checks[0].requestId||!call.sent||call.phase!=='work'||call.role!=='main'||
    !step.stages.some(stage=>stage.id===call.stageId&&stage.role==='main'&&stage.phase==='work'&&stage.callIds.includes(call.id))||
    call.actualModel?.provider!==main.provider||call.actualModel?.modelId!==main.modelId||!call.text?.trim()||
    call.response?.content?.some(block=>block.type==='toolCall'))return null;
  return call;
}

export function resolveManagerFinal(home,record,delivery,seen=new Set()) {
  const ref=record.managerFinal;
  if(!ref)return null;
  delivery??=resolveDeliveryEvidence(home,record);
  if(!delivery||delivery.visualError||seen.has(record.id)||ref.binding!==managerFinalBinding(record)||
    record.proposal.contextDigest!==digest(record.handoffContext)||record.projectOperation.planDigest!==digest(record.proposal))
    throw problem('MANAGER_FINAL','Manager report binding changed');
  seen.add(record.id);
  let call;
  if(ref.reusedFrom){
    if(!record.proposal?.reuseCompletedDelivery||!record.contextTaskIds?.includes(ref.reusedFrom))throw problem('MANAGER_FINAL','Report reuse is not authorized by this branch');
    const previous=readTask(home,ref.reusedFrom);
    if(previous.status!=='completed'||!sameCompletedDelivery(previous.deliveryRef,record.deliveryRef))throw problem('MANAGER_FINAL','Previous report covered a different delivery');
    call=resolveManagerFinal(home,previous,undefined,seen)??canonicalStepFinal(previous,resolveDeliveryEvidence(home,previous));
  } else if(ref.taskId===record.id){
    call=readRequest(home,record.id,ref.callId);
    const main=record.models.main;
    const stage=record.stages.find(stage=>stage.id===call.stageId&&stage.phase==='manager-final'&&stage.role==='main');
    const claim=record.rootRequests.find(claim=>claim.requestId===call.id&&claim.taskId===record.id&&claim.stageId===call.stageId&&!claim.notSent);
    if(record.finalCallId!==call.id||stage?.callIds.length!==1||stage.callIds[0]!==call.id||!claim||claim.sessionId!==stage.sessionId||
      call.phase!=='manager-final'||call.role!=='main'||call.actualModel?.provider!==main.provider||call.actualModel?.modelId!==main.modelId)
      throw problem('MANAGER_FINAL','Report is not the frozen manager’s request');
  } else call=canonicalStepFinal(record,delivery);
  if(!call||call.id!==ref.callId||call.taskId!==ref.taskId||call.status!=='completed'||!call.sent||!call.text?.trim()||
    call.response?.content?.some(block=>block.type==='toolCall')||
    digest(call.text)!==ref.textDigest||call.displayId!==ref.displayId)
    throw problem('MANAGER_FINAL','Manager report is missing, changed or incomplete');
  return call;
}

export async function adoptManagerFinal(task,delivery) {
  const {home,record}=task;
  if(record.managerFinal||record.stages.some(stage=>stage.phase==='manager-final'))throw problem('MANAGER_FINAL','Use the original manager request; no replay');
  let call,reusedFrom;
  if(record.proposal.reuseCompletedDelivery){
    for(const id of [...(record.contextTaskIds??[])].reverse()){
      try {
        const previous=readTask(home,id);
        if(previous.status!=='completed'||!sameCompletedDelivery(previous.deliveryRef,record.deliveryRef))continue;
        call=resolveManagerFinal(home,previous)??canonicalStepFinal(previous,resolveDeliveryEvidence(home,previous));
        if(call){reusedFrom=previous.managerFinal?.reusedFrom??previous.id;break;}
      } catch { /* Unverified historical reports cannot be adopted. */ }
    }
    if(!call)throw problem('MANAGER_FINAL','The saved delivery has no verifiable manager report to reuse');
  } else call=canonicalStepFinal(record,delivery);
  if(!call){
    if(record.budget.maxCalls!==null&&record.rootRequests.filter(claim=>!claim.notSent).length>=record.budget.maxCalls)
      throw problem('ROOT_BUDGET','本轮没有剩余模型请求额度。');
    if(!task.synthesizeManagerFinal)throw problem('MANAGER_FINAL','Manager session is not available');
    call=await task.synthesizeManagerFinal(delivery);
    if(!call.text?.trim()||call.response?.content?.some(block=>block.type==='toolCall'))
      throw problem('MANAGER_FINAL','经理请求没有返回可采用的答复。');
    record.finalCallId=call.id;
  }
  task.signal.throwIfAborted();
  record.managerFinal={taskId:call.taskId,callId:call.id,displayId:call.displayId,textDigest:digest(call.text),binding:managerFinalBinding(record),...(reusedFrom?{reusedFrom}:{})};
  resolveManagerFinal(home,record,delivery);
  if(!task.persistManagerFinal)throw problem('MANAGER_FINAL','Original conversation is not available');
  record.managerFinal.entryId=task.persistManagerFinal(call);
  task.save();
}

/** Reconstruct a historical delivery from the exact saved attempt and check set. */
export function resolveDeliveryEvidence(home,record) {
  const ref=record.deliveryRef;if(!ref)return null;
  if(!/^[\da-f-]{36}$/.test(ref.projectId))throw problem('DELIVERY_SOURCE','Invalid saved project identity');
  const state=JSON.parse(readFileSync(join(home,'project-delivery',ref.projectId,'state.json'),'utf8'));
  const command=state.commands?.[ref.commandId],delivery=state.deliveries?.[ref.revision]??state.delivery;
  if(record.flow!=='unified'||state.id!==ref.projectId||state.repo!==record.executionBinding?.canonicalRepo||
    record.executionBinding.projectId!==ref.projectId||record.projectOperation?.projectId!==ref.projectId||record.projectOperation?.revision!==ref.revision||
    record.projectOperation?.commandId!==ref.commandId||command?.rootTaskId!==record.id||command.status!=='settled'||
    delivery?.version!==ref.version||delivery?.revision!==ref.revision)throw problem('DELIVERY_SOURCE','Saved delivery identity, revision or version does not match');
  const checkIds=delivery.requestIds;
  if(!Array.isArray(checkIds)||!checkIds.length||new Set(checkIds).size!==checkIds.length||digest(ref.checksRef??null)!==digest(checkIds.map(requestId=>({projectId:state.id,revision:ref.revision,requestId,version:ref.version}))))throw problem('DELIVERY_CHECK','Delivery checks reference changed');
  const sourceIds=ref.sources?.map(source=>source.taskId);
  if(!Array.isArray(delivery.taskIds)||!sourceIds?.length||new Set(sourceIds).size!==sourceIds.length||
    digest([...sourceIds].sort())!==digest([...delivery.taskIds].sort()))throw problem('DELIVERY_SOURCE','Required delivery sources are missing, duplicated or unexpected');
  const usedSteps=new Set(),attempts=[],expectedArtifacts=new Map();
  const sources=ref.sources.map(source=>{
    const step=state.steps.find(s=>s.attempts.some(a=>a.taskId===source.taskId&&a.status==='completed')),a=step?.attempts.find(a=>a.taskId===source.taskId),child=readTask(home,source.taskId);
    if(!a||usedSteps.has(step.id)||child.project?.id!==state.id||child.project?.stepId!==step.id||
      child.project?.commandId!==a.commandId||child.rootTaskId!==a.rootTaskId||child.finalCallId!==source.callId||
      !child.requestIds.includes(source.callId)||child.status!=='completed'||child.work?.root!==state.repo||
      child.work.version!==a.version||child.work.startVersion!==a.startVersion)throw problem('DELIVERY_SOURCE','Child result lacks completed project provenance');
    if(source.relation==='owned'?(a.rootTaskId!==record.id||a.commandId!==ref.commandId||!record.projectOperation.childTaskIds.includes(a.taskId)):(source.relation!=='inherited'||a.rootTaskId===record.id))throw problem('DELIVERY_SOURCE','Wrong owned/inherited relation');
    if(state.commands?.[a.commandId]?.rootTaskId!==a.rootTaskId)throw problem('DELIVERY_SOURCE','Invalid delivery source operation owner');
    const call=readRequest(home,child.id,source.callId);if(call.status!=='completed')throw problem('DELIVERY_SOURCE','Final physical request is not complete');
    usedSteps.add(step.id);attempts.push(a);
    const declared=child.project.deliverables;
    if(!Array.isArray(a.artifacts)||!Array.isArray(declared)||digest(a.artifacts.map(item=>item.path).sort())!==digest([...declared].sort()))
      throw problem('DELIVERY_ARTIFACT','Missing or unexpected declared deliverables');
    for(const item of a.artifacts){
      const key=JSON.stringify([step.id,item.path]);
      if(expectedArtifacts.has(key)||!validProjectPath(item.path)||!/^[0-9a-f]{64}$/.test(item.sha256))throw problem('DELIVERY_ARTIFACT','Invalid step artifact receipt');
      expectedArtifacts.set(key,{version:a.version,hash:item.sha256});
    }
    return {record:child,call,stepId:step.id,relation:source.relation};
  });
  const checks=checkIds.map(id=>{
    const fact=state.finalChecks?.find(c=>c.requestId===id&&c.revision===ref.revision)?.check??attempts.find(a=>a.check?.requestId===id)?.check;
    if(fact?.version!==ref.version||fact.binding?.version!==ref.version||fact.status!=='passed'||fact.verification!=='passed')throw problem('DELIVERY_CHECK','Missing passed checks at delivered version');
    return fact;
  });
  if(!Array.isArray(delivery.artifacts)||!expectedArtifacts.size||
    (ref.artifactsDigest&&ref.artifactsDigest!==digest(delivery.artifacts)))throw problem('DELIVERY_ARTIFACT','Saved artifact receipts are missing or changed');
  const artifacts=new Map();
  for(const item of delivery.artifacts){
    const key=JSON.stringify([item.stepId,item.path]),original=expectedArtifacts.get(key);
    if(!original||item.deliveredVersion!==original.version||item.deliveredHash!==original.hash||item.inputVersion!==ref.version||
      !/^[0-9a-f]{64}$/.test(item.inputHash)||artifacts.has(item.path)&&artifacts.get(item.path)!==item.inputHash)throw problem('DELIVERY_ARTIFACT','Artifact receipt is not bound to the delivered version');
    expectedArtifacts.delete(key);artifacts.set(item.path,item.inputHash);
  }
  if(expectedArtifacts.size)throw problem('DELIVERY_ARTIFACT','Missing artifact from the saved delivery');
  // Root patches begin at the first executing attempt, which may differ from plan order.
  const byId=new Map(sources.map(source=>[source.record.id,source]));
  const startVersion=[...attempts].sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)))[0].startVersion;
  const missingVisual="已接纳文件，但正式组合版本缺少可核验的视觉复核；已保存的固定版本仍可打开。";
  let visualError=null,visualSource;
  if(ref.visualDigest || command.visual ||
    (record.proposal?.plan?.workRequest && state.visualContract && ref.revision===state.revision)) {
    visualError=missingVisual;
    const visual=command.visual,basis=visual?.basis,owner=state.commands?.[visual?.commandId];
    if(visual && ref.visualDigest===digest(visual) && digest(basis)===visual.basisDigest &&
      owner?.rootTaskId===visual.taskId && owner.status==="settled" &&
      basis.projectId===ref.projectId && basis.revision===ref.revision && basis.version===ref.version &&
      basis.integrationRef===record.executionBinding.formalRef && artifacts.has(basis.input.entry)) {
      try {
        const source=visual.taskId===record.id?record:readTask(home,visual.taskId);
        if(source.flow==="unified" && source.projectOperation?.commandId===visual.commandId &&
          source.projectOperation.projectId===ref.projectId && source.projectOperation.revision===ref.revision &&
          source.proposal?.plan?.goal===basis.approvedGoal &&
          (source.proposal.action==="resume" || source.handoffContext?.input===basis.originalTask) &&
          digest(projectVisualInput(source.proposal.plan.workRequest,[...artifacts.keys()]))===digest(basis.input)) {
          visualSource=source;
          visualError=visual.error ?? (checkedCombinedVisual(home,source,visual)?null:missingVisual);
        }
      } catch { visualError=missingVisual; }
    }
  } else if(record.proposal?.plan?.workRequest && !sources.some(({record:source})=>(source.work.visualEvidence??[]).some(e=>{
    if(!artifacts.has(e.entry)||e.integrationVersion!==ref.version||e.review?.verdict!=="match"||
      e.diagnostics?.blocked?.length||e.diagnostics?.pageErrors?.length||e.diagnostics?.resourceErrors?.length||
      e.diagnostics?.console?.some(message=>message.startsWith("error:"))||!source.requestIds.includes(e.imageRequestId))return false;
    try {return checkedVisualReview(e,ref.version,readRequest(home,source.id,e.imageRequestId).status==="completed");}
    catch{return false;}
  }))) visualError=missingVisual;
  return {sources:delivery.taskIds.map(id=>byId.get(id)),artifacts,checks,startVersion,visualError,visualSource};
}

export function resolveOwnedTasks(home,record,onRejected) {
  const operation=record.projectOperation;if(!operation?.childTaskIds?.length)return [];
  if(!/^[\da-f-]{36}$/.test(operation.projectId))throw problem('ROOT_CHILD','Invalid owned project identity');
  const state=JSON.parse(readFileSync(join(home,'project-delivery',operation.projectId,'state.json'),'utf8'));
  if(state.commands?.[operation.commandId]?.rootTaskId!==record.id||state.repo!==record.proposal?.canonicalRepo)throw problem('ROOT_CHILD','Unverified project operation owner');
  const attempts=state.steps.flatMap(step=>step.attempts);
  return [...new Set(operation.childTaskIds)].flatMap(id=>{
    try {
      const child=readTask(home,id),attempt=attempts.find(a=>a.taskId===id);
      if(!attempt||attempt.rootTaskId!==record.id||attempt.commandId!==operation.commandId||child.rootTaskId!==record.id||
        child.project?.commandId!==operation.commandId||child.project?.id!==state.id||child.project?.startVersion!==attempt.startVersion||
        child.work?.root&&child.work.root!==state.repo)throw problem('ROOT_CHILD','Unverified owned execution');
      return [child];
    } catch(error) {
      if(!onRejected)throw error;
      onRejected(error);
      return [];
    }
  });
}
