export {completedContinuationEvidence} from './project-review-evidence.js';
import {restorationPaths} from './work-changes.js';
import {inspectRepairVerification,inspectUnspentRepair} from './project-route.js';
import {isDeepStrictEqual} from 'node:util';
import {readTask,readRequest,problem} from './task.js';
import {createVersioning,projectScopesOverlap,inScope} from './versioning.js';
import {continuationLineage,confirmedContinuation,continuedTask} from './project-continuation.js';

export function completedContinuationCovers(state,currentTaskId,proofs,{taskId,requestId}) {
  const current=state.steps?.find(step=>step.attempts.some(attempt=>attempt.taskId===currentTaskId));
  return !!current&&!!proofs?.some(proof=>proof.projectId===state.id&&proof.formalRef===state.integrationRef&&
    (taskId?proof.taskId===taskId:proof.requestIds.includes(requestId))&&
    projectScopesOverlap(current.scope,proof.scope));
}


/** Public formal acceptance closes an earlier privately verified route. */
export async function checkedRouteAcceptance(versioning,step,row) {
  if(!versioning||row?.status!=='accepted'||!row.requestId||!row.acceptedVersion)return null;
  const fact=await versioning.inspect({requestId:row.requestId});
  if(fact.status!=='accepted'||fact.verification!=='passed'||fact.changeId!==row.changeId||
    fact.candidateVersion!==row.candidateVersion||fact.acceptedVersion!==row.acceptedVersion||
    fact.checks?.length!==step.checks.length||!step.checks.every((expected,i)=>{
      const actual=fact.checks[i];return actual.command===expected.command&&isDeepStrictEqual(actual.args??[],expected.args??[])&&actual.exitCode===0&&actual.sourceChanged===false;
    }))return null;
  return {candidate:fact.candidateVersion,requestId:row.requestId,checks:fact.checks,acceptedVersion:fact.acceptedVersion};
}

/** Reclassify only scope observations with verifiable original authority. */
export async function recoverContinuationRoute({home,state,source,step,versioning,formalVersion,draft}) {
  if(step.route?.status==='blocked'&&draft&&await inspectUnspentRepair({home,versioning,route:step.route,step,record:readTask(home,step.route.taskId),draft}))return {...structuredClone(step.route),status:'repair'};
  const inputOnlyFailure=await incompleteInput({home,state,source,step,versioning,formalVersion});
  if(inputOnlyFailure)return {status:'resolved',inputOnlyFailure};
  const restoredGrant=await recoverRestoredScope({home,state,source,step,versioning});
  if(restoredGrant)return {status:'resolved',scopeRestoration:restoredGrant};
  const route=step.route,observation=route?.recheck;
  if(route?.status!=='blocked'||!['failed','scope_expansion'].includes(route.kind)||!observation?.candidate||
    !Array.isArray(observation.evidence?.previousScope)||!Array.isArray(observation.evidence?.requestedScope)||
    observation.evidence.requestedScope.some(path=>!inScope(path,step.scope)))return null;
  const lineage=continuationLineage(home,state,source),roots=new Set(lineage.map(root=>root.id));
  const records=step.attempts.filter(a=>roots.has(a.rootTaskId)).map(a=>readTask(home,a.taskId));
  for(const record of records.filter(r=>r.rootTaskId===source.id)) {
    const prior=record.project?.route;
    if(prior?.status!=='resolved'||prior.candidate!==route.candidate||prior.taskId!==route.taskId||
      record.work?.startVersion!==formalVersion)continue;
    for(const op of record.work.requests??[]) {
      if(op.action!=='refreshChange'||op.status!=='rejected'||op.dispatched!==false||op.error?.code!=='PROJECT_ROUTE')continue;
      const change=await versioning.inspect({changeId:op.changeId});
      if(change.actor!=='main'||change.privateVersion!==observation.candidate||
        !isDeepStrictEqual([...change.scope].sort(),[...observation.evidence.previousScope].sort()))continue;
      for(const accepted of records.flatMap(r=>r.work?.acceptance??[]).filter(row=>row.acceptedVersion===formalVersion)) {
        const proof=await checkedRouteAcceptance(versioning,step,accepted);if(!proof)continue;
        return {projectId:state.id,revision:step.revision,stepId:step.id,taskId:record.id,actor:'main',
          candidate:change.privateVersion,privateVersion:change.privateVersion,changeId:change.changeId,
          kind:'scope_expansion',evidence:structuredClone(observation.evidence),status:'paused',at:observation.at,
          priorAcceptance:proof};
      }
    }
  }
  return null;
}

async function incompleteInput({home,state,source,step,versioning,formalVersion}) {
  const route=step.route;
  if(route?.kind!=='failed'||route.status!=='paused'||route.changeId||route.judgmentCall||route.probe||route.edit||route.candidate!==formalVersion)return null;
  const record=readTask(home,route.taskId),attempt=step.attempts.find(a=>a.taskId===record.id),work=record.work;
  if(!attempt||!continuationLineage(home,state,source).some(r=>r.id===attempt.rootTaskId)||record.rootTaskId!==attempt.rootTaskId||
    record.project?.id!==state.id||work?.root!==state.repo||work.startVersion!==formalVersion||work.acceptance?.length||
    !work.changes?.length||work.changes.some(c=>!c.readOnly)||record.tools?.some(t=>t.kernelInput)||
    work.execution?.engine!=='docker'||work.execution.network!=='none'||work.finalCheck?.requestId!==route.evidence.requestId)return null;
  for(const c of work.changes)if(!(await versioning.inspect({changeId:c.changeId})).readOnly)return null;
  const check=await versioning.inspect({requestId:route.evidence.requestId});
  if(check.status!=='check_failed'||check.version!==formalVersion||record.project.checkPolicy&&check.binding?.policy!==record.project.checkPolicy.digest||
    !isDeepStrictEqual(record.project.checks,step.checks)||check.checks?.length!==step.checks.length||check.checks.some((c,i)=>
      c.sourceChanged!==false||c.command!==step.checks[i].command||!isDeepStrictEqual(c.args??[],step.checks[i].args??[])))return null;
  const missing=[];
  for(const path of step.deliverables)if(!(await versioning.read({version:formalVersion,path})).contentHash)missing.push(path);
  return missing.length?{taskId:record.id,requestId:check.requestId,version:formalVersion,missing}:null;
}

function restorationAuthority(home,state,binding) {
  const ref=confirmedContinuation(state,binding.taskId);
  const attempt=state.steps.flatMap(step=>step.attempts).find(row=>row.taskId===binding.taskId);
  const root=attempt&&readTask(home,attempt.rootTaskId);
  if(!ref?.draft||ref.stepId!==binding.stepId||binding.constraints?.readOnly||root?.operationAuthorization?.kind!=='file_continuation'||
    root.projectOperation?.commandId!==attempt.commandId||!isDeepStrictEqual(root.projectOperation.continuation,ref)||
    root.operationAuthorization.sourceTaskId!==ref.sourceRootTaskId)
    throw problem('CONTINUATION_AUTH','恢复必须属于已确认继续的新执行尝试');
  return {ref,root,step:state.steps.find(step=>step.id===binding.stepId)};
}

/** A narrowed restore copies bytes, not a new restriction on the confirmed step. */
export function restoredScopeGrant(home,state,taskId,changeId) {
  try {
    const task=readTask(home,taskId),binding={taskId,stepId:task.project?.stepId,constraints:task.project?.constraints};
    const {ref,step}=restorationAuthority(home,state,binding),work=task.work,change=work?.changes?.[0];
    if(change?.changeId!==changeId||change.actor!=='main'||change.readOnly||!work.restoreRequestId||
      !work.requests.some(r=>r.requestId===work.restoreRequestId&&r.action==='beginChange'&&r.status==='open'&&r.dispatched===true)||
      !isDeepStrictEqual(task.project.scope,step.scope)||!isDeepStrictEqual(task.project.checks,step.checks))return null;
    return {taskId,changeId,requestId:work.restoreRequestId,draft:ref.draft,scope:step.scope};
  }catch{return null;}
}

async function recoverRestoredScope({home,state,source,step,versioning}) {
  const route=step.route;
  if(route?.kind!=='scope_expansion'||!['paused','blocked','repair'].includes(route.status)||route.actor!=='main')return null;
  const grant=restoredScopeGrant(home,state,route.taskId,route.changeId);
  if(!grant||!Array.isArray(route.evidence?.requestedScope)||
    route.evidence.requestedScope.some(path=>!inScope(path,grant.scope)))return null;
  const old=readTask(home,route.taskId),lineage=continuationLineage(home,state,source);
  if(!lineage.some(root=>root.id===old.rootTaskId)||old.project.route&&old.project.route.status!=='resolved')return null;
  if(!old.work.requests.some(r=>r.action==='refreshChange'&&r.changeId===route.changeId&&r.status==='rejected'&&
    r.dispatched===false&&r.error?.code==='PROJECT_ROUTE'))return null;
  const receipt=await versioning.inspect({requestId:grant.requestId});
  if(receipt.changeId!==route.changeId||receipt.actor!=='main'||receipt.readOnly||receipt.status!=='open'||
    receipt.baseVersion!==old.work.startVersion||receipt.privateVersion!==route.candidate||
    !isDeepStrictEqual(receipt.scope,route.evidence.previousScope))return null;
  const restored=await restorationPaths(versioning,grant.draft,receipt.baseVersion,step.scope);
  if(restored.conflicts.length||!isDeepStrictEqual(restored.paths,receipt.scope))return null;
  const diff=await versioning.inspect({fromVersion:grant.draft.version,toVersion:receipt.privateVersion});
  if(diff.files.some(path=>inScope(path,restored.paths)))return null;
  return grant;
}
export async function admitContinuationRestore({home,host,binding,input,versioning}) {
  const state=host.read(),{ref,root,step}=restorationAuthority(home,state,binding);
  const task=readTask(home,binding.taskId);
  if(readTask(home,ref.draft.taskId).work?.changes.find(c=>c.changeId===ref.draft.changeId)?.readOnly&&root.operationAuthorization.mode!=='user')
    throw problem('CONTINUATION_AUTH','未改变的输入版本仅允许明确手动继续');
  const restored=await restorationPaths(versioning,ref.draft,binding.startVersion,step.scope),writing=restored.paths.length>0;
  if(input.actor!=='main'||input.readOnly!==!writing||input.restoreFrom!==(writing?ref.draft.version:undefined)||input.baseVersion!==binding.startVersion||
    (writing?input.requestId!==task.work?.restoreRequestId:task.work.changes.length||task.requestIds.length)||input.readScope.some(path=>!inScope(path,binding.readScope)))
    throw problem('CONTINUATION_AUTH','恢复输入不属于原保存版本与本次授权');
  if(restored.conflicts.length||!isDeepStrictEqual(input.scope,restored.paths))
    throw problem('RESTORE_CONFLICT','恢复路径或正式文件已变化');
  const route=await recoverContinuationRoute({home,state,source:readTask(home,ref.sourceRootTaskId),step,versioning,formalVersion:binding.startVersion,draft:ref.draft})??step.route;
  if((route?.scopeRestoration||route?.inputOnlyFailure)&&root.operationAuthorization.mode!=='user')throw problem('CONTINUATION_AUTH','旧判断须明确手动继续');
  const verification=route?.status==='repair'?await inspectRepairVerification({versioning,route,step,
    record:readTask(home,route.taskId),draft:ref.draft}):null;
  const unspent=route?.status==='repair'&&await inspectUnspentRepair({home,versioning,route,step,record:readTask(home,route.taskId),draft:ref.draft});
  if(route&&route.status!=='resolved'&&(root.operationAuthorization.mode!=='user'||
    (!verification?.verified&&!unspent&&(route.status!=='paused'||!['scope_expansion','failed'].includes(route.kind)))))
    throw problem('PROJECT_ROUTE',verification?.reason??'原路线仍需核实；本次恢复不能清除暂停或未决判断');
}
export async function bindContinuationRoute({home,host,binding,change,versioning}) {
  const state=host.read(),{ref,root,step}=restorationAuthority(home,state,binding),storedRoute=step.route;
  const recovered=await recoverContinuationRoute({home,state,source:readTask(home,ref.sourceRootTaskId),step,versioning,formalVersion:binding.startVersion,draft:ref.draft});
  const route=recovered??storedRoute;
  if(recovered?.scopeRestoration||recovered?.inputOnlyFailure) {
    if(root.operationAuthorization.mode!=='user')throw problem('CONTINUATION_AUTH','旧恢复范围判断须明确手动继续');
    return host.update(current=>{
      const next=current.steps.find(item=>item.id===binding.stepId);
      if(next.attempts.at(-1)?.taskId!==binding.taskId||!isDeepStrictEqual(next.route,storedRoute))throw problem('PROJECT_ROUTE','原路线已变化');
      (next.routeHistory??=[]).push({...next.route,...(recovered.scopeRestoration?{scopeRestoration:recovered.scopeRestoration}:{inputOnlyFailure:recovered.inputOnlyFailure})});
      delete next.route;
      return recovered;
    });
  }
  if(!route||route.status==='resolved')return null;
  const oldTask=readTask(home,route.taskId);
  const verification=route.status==='repair'?await inspectRepairVerification({versioning,route,step,record:oldTask,draft:ref.draft}):null;
  const unspent=route.status==='repair'&&await inspectUnspentRepair({home,versioning,route,step,record:oldTask,draft:ref.draft});
  if((route.status!=='paused'&&!verification?.verified&&!unspent)||root.operationAuthorization.mode!=='user'||
    !continuedTask(state,binding.taskId,route.taskId)||change.actor!=='main'||change.readOnly||
    change.baseVersion!==binding.startVersion||change.privateVersion==null)
    throw problem('PROJECT_ROUTE','继续不能重新授权这条原路线');
  const saved=await versioning.inspect({changeId:change.changeId});
  if(saved.privateVersion!==change.privateVersion||saved.status!=='open')throw problem('PROJECT_ROUTE','恢复副本已变化');
  const basis=verification?.verified?[verification.proof.candidateVersion,verification.proof.privateVersion,ref.draft.version]:[route.candidate,route.privateVersion,ref.draft.version];
  for(const version of new Set(basis)) {
    if(!version)throw problem('PROJECT_ROUTE','原路线缺少确定版本');
    const diff=await versioning.inspect({fromVersion:version,toVersion:change.privateVersion});
    if(diff.files.some(path=>inScope(path,[...step.scope,...binding.readScope])))
      throw problem('PROJECT_ROUTE','原暂停候选与恢复版本的可见文件不一致，不能沿用其判断');
  }
  const original=!unspent&&!verification?.verified&&route.judgmentCall?readRequest(home,oldTask.id,route.judgmentCall):null;
  const source={taskId:route.taskId,changeId:route.changeId,revision:oldTask.project.revision,candidate:route.candidate,
    privateVersion:route.privateVersion,judgmentCall:route.judgmentCall??null};
  return host.update(current=>{
    const next=current.steps.find(item=>item.id===binding.stepId);
    if(next.attempts.at(-1)?.taskId!==binding.taskId||!isDeepStrictEqual(next.route,storedRoute))
      throw problem('PROJECT_ROUTE','绑定恢复副本前原路线已变化');
    if(recovered){(next.routeHistory??=[]).push(next.route);next.route=structuredClone(recovered);}
    if(unspent)(next.routeHistory??=[]).push(structuredClone(next.route));
    const active=next.route;
    active.restoredFrom=source;
    active.taskId=binding.taskId;active.changeId=change.changeId;active.privateVersion=change.privateVersion;
    active.candidate=change.privateVersion;active.actor='main';
    if(unspent){delete active.next;delete active.correction;delete active.recheck;delete active.expansion;return structuredClone(active);}
    if(verification?.verified) {
      active.status='resolved';active.recheck={kind:'precheck',...verification.proof,restoredVersion:change.privateVersion};
      delete active.correction;delete active.judgmentCall;
      return structuredClone(active);
    }
    active.correction={sourceTaskId:oldTask.id,requestId:original?.id??null,status:original?.status??null,
      response:original?.response??null,error:oldTask.error??null,
      instruction:'The previous paused-route judgment did not resolve this boundary. Use the original response/error as corrective feedback. Submit only project_route_judge for the exact restored candidate; do not repeat its rejected tools or treat the old request as unsent.'};
    delete active.judgmentCall;
    return structuredClone(active);
  });
}

/** Observations only: never authorizes skipping a current fixed check or review. */
export async function continuationObservations(versioning,source,draft,checks,home,execution) {
  const owned=!versioning;
  versioning??=await createVersioning({home,project:source.work.root,readOnly:true,execution});
  try {
  const result={candidate:draft.version,commands:[],invalidated:[],fixedChecksRequired:true};
  const current=await versioning.inspect();
  const environment=({workContainers,checkContainers,...config}={})=>config;
  const conditions=!!draft.baseVersion&&current.version===draft.baseVersion&&isDeepStrictEqual(source.project?.checks,checks)&&
    source.work?.execution?.network==='none'&&isDeepStrictEqual(environment(source.work.execution),environment(current.execution));
  for(const tool of source.tools??[]) {
    if(tool.name!=='bash'||!tool.requestId)continue;
    const reject=reason=>result.invalidated.push({requestId:tool.requestId,reason});
    if(!conditions){reject('checks_or_environment_changed');continue;}
    if(tool.status!=='completed'||tool.kernelDispatched!==true||tool.exitCode!==0||
      !tool.kernelInput?.expectedVersion||typeof tool.kernelInput.command!=='string'){
      reject('not_a_completed_observation');continue;
    }
    try {
      const start=source.work.operations?.find(op=>op.action==='command_start'&&op.requestId===tool.requestId);
      const owner=source.work.changes?.find(c=>c.changeId===start?.changeId);
      if(!owner||owner.changeId!==draft.changeId){reject('command_source_unbound');continue;}
      const change=await versioning.inspect({changeId:owner.changeId});
      if(change.actor!==owner.actor||change.privateVersion!==draft.version){reject('command_source_changed');continue;}
      const receipt=await versioning.inspect({requestId:tool.requestId});
      if(receipt.status!=='completed'||receipt.requestId!==tool.requestId||receipt.exitCode!==0||
        !receipt.privateVersion||!Array.isArray(receipt.changedFiles)||receipt.changedFiles.length){
        reject('receipt_not_successful_or_changed_source');continue;
      }
      const before=await versioning.inspect({fromVersion:tool.kernelInput.expectedVersion,toVersion:receipt.privateVersion});
      const restored=await versioning.inspect({fromVersion:receipt.privateVersion,toVersion:draft.version});
      if(!Array.isArray(before.files)||before.files.length||!Array.isArray(restored.files)||restored.files.length){
        reject('candidate_changed');continue;
      }
      result.commands.push({requestId:tool.requestId,recordedCommand:tool.kernelInput.command,
        observedVersion:receipt.privateVersion,candidate:draft.version,outputRef:receipt.outputRef,
        exitCode:0,checks:structuredClone(checks),execution:structuredClone(environment(current.execution))});
    } catch {reject('evidence_unavailable');}
  }
  return result;
  } finally {if(owned)await versioning.close();}
}

export function continuationToolHistory(source) {
  return (source.tools??[]).map(({snapshot,tools,kernelInput,...tool})=>({
        ...tool,
        // Runtime sources and tool registrations already belong to the frozen
        // runtime. Restored files are read from their public version, not copied
        // into a new prompt as internal snapshots or edit payloads.
        ...(kernelInput?.command?{command:kernelInput.command,args:kernelInput.args??[]}:{}),
        ...(tool.name==='resource_exec'&&tool.result?{result:{...tool.result,
          files:Object.keys(tool.result.files??{}),
          edits:(tool.result.edits??[]).map(({contentBase64,...edit})=>edit),
        }}:{}),
      }));
}
