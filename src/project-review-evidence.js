import {resolveDeliveryEvidence,resolveManagerFinal} from './project-delivery.js';
import {executionFacts} from './project-delivery-checks.js';
import {continuationLineage,continuationSourceRoots,locallyClosed} from './project-continuation.js';
import {hostOnlyRequest} from './transport-diagnostics.js';
import { isDeepStrictEqual } from "node:util";
import { inScope, createVersioning } from "./versioning.js";
import { readTask, readRequest, readRequests } from "./task.js";
import { assertProjectWorkReviewed } from "./project-review.js";

// Read first-parent changes after a candidate was accepted. A change followed by
// an exact revert is still a new candidate; endpoint comparisons alone miss it.
async function reviewedHistory(v, version, accepted) {
  if (!accepted.length) return;
  const pending = new Map(accepted.map(c => [c.acceptedVersion,c]));
  const laterChanges = new Set();
  let cursor, order = 0;
  do {
    const page = await v.inspect({history:{cursor,limit:100}});
    if (!cursor && page.versions[0]?.version !== version)
      throw Error("Formal tip moved during independent review verification");
    for (const row of page.versions) {
      const c = pending.get(row.version);
      if (c) {
        c.laterChanges = [...laterChanges];
        c.order = order;
        pending.delete(row.version);
        if (!pending.size) return;
      }
      if (!row.parents[0]) break;
      const diff = await v.inspect({fromVersion:row.parents[0],toVersion:row.version});
      for (const path of diff.files) laterChanges.add(path);
      order++;
    }
    cursor = page.nextCursor;
  } while (cursor);
  throw Error("Reviewed acceptance is absent from the current formal history");
}
// Re-query accepted candidates from agent-sync. Identical checks or an author's
// saved candidate ID cannot substitute for the accepted product and its content.
export async function reviewEvidence(v, home, state, step, version, task, requestFacts) {
  const reviewers = Object.values(state.staffAssignments ?? {}).filter(a => a.reviewReceipts?.length);
  if (!step.works.some(work => work.independentReview) && !reviewers.length) return [];
  const sources = new Map([[task.id,{record:task}]]);
  // A later review-only attempt owns its review, not the prior implementation.
  // Recover only the earlier change actually reviewed by this attempt, and
  // only for the same work under the same frozen scope.
  for (const reviewer of reviewers) {
    const source = reviewer.reviewSource;
    if (reviewer.taskId !== task.id || !source || source.taskId === task.id ||
        !step.attempts.some(a => a.taskId === source.taskId) ||
        !reviewer.reviewReceipts.some(r => r.reviewTaskId === task.id &&
          r.taskId === source.taskId && r.changeId === source.changeId)) continue;
    if (!sources.has(source.taskId)) {
      const record = readTask(home, source.taskId);
      if (record.project?.id !== state.id || record.project.stepId !== step.id ||
          record.work?.root !== state.repo || record.work.backend !== "agent-sync")
        throw Error("Cannot verify the original task for post-hoc independent review");
      sources.set(source.taskId,{record,priorWorkIds:new Set()});
    }
    const {record,priorWorkIds} = sources.get(source.taskId);
    const sameWorks = (source.workIds ?? []).filter(id =>
      step.works.some(work => work.id === id && record.project.works?.some(old =>
        old.id === id && isDeepStrictEqual(old.scope,work.scope))));
    for (const id of sameWorks) priorWorkIds.add(id);
  }

  const accepted = [];
  for (const {record,priorWorkIds} of sources.values()) {
    if (priorWorkIds && !priorWorkIds.size) continue;
    // Every acceptance for this work in the original task must participate in
    // the gate. Mentioning just one of two changed files cannot hide the other.
    for (const row of record.work?.acceptance ?? []) {
      const fact = requestFacts?.find(f => f.id === row.requestId)?.fact ??
        await v.inspect({requestId:row.requestId});
      if (fact.status !== "accepted" || fact.changeId !== row.changeId) continue;
      const change = await v.inspect({changeId:fact.changeId});
      const candidate = change.candidates.find(c => c.candidateVersion === fact.candidateVersion);
      if (!candidate) throw Error("Independent review candidate record is missing: " + fact.changeId);
      const {files} = await v.inspect({fromVersion:change.baseVersion,toVersion:fact.candidateVersion});
      const difference = await v.inspect({fromVersion:fact.candidateVersion,toVersion:version});
      accepted.push({...fact, ...candidate, taskId:record.id, files, difference:difference.files,
        priorWorkIds});
    }
  }
  await reviewedHistory(v, version, accepted);
  accepted.sort((a,b) => b.order - a.order);
  const receipts = [];
  for (const work of [...step.works, ...(step.subworks ?? [])]) {
    const candidates = accepted.filter(c => (!c.priorWorkIds || c.priorWorkIds.has(work.id)) &&
      c.files.some(path => inScope(path, work.scope)));
    const current = candidates.filter(c => {
      const scopes = [...work.scope, ...c.files, ...Object.values(c.basis).map(b => b.path),
        ...reviewers.filter(a => a.reviewSource?.changeId === c.changeId).flatMap(a => a.readScope ?? [])];
      return ![...c.difference,...c.laterChanges].some(path => inScope(path, scopes));
    });
    // A newer accept for the same files replaces an earlier candidate even if
    // its bytes coincidentally match. Keep each last producer, in actual formal order.
    const latest = new Map();
    for (const c of candidates)
      for (const path of c.files.filter(path => inScope(path,work.scope))) latest.set(path,c);
    const facts = [...new Set(latest.values())];
    if (facts.some(f => !current.includes(f) && (work.independentReview ||
        reviewers.some(a => a.reviewSource?.changeId === f.changeId &&
          a.reviewReceipts.some(r => r.verdict === "reject")))))
      throw Error("Independent review is stale on the current formal version: " + work.id);
    const verified = assertProjectWorkReviewed(state, {work,step,version,
      acceptedFacts:facts.filter(f => current.includes(f)), required:!!work.independentReview});
    if (work.independentReview && facts.some(f => f.priorWorkIds) &&
        !verified.some(r => r.reviewTaskId === task.id && r.taskId !== task.id && r.certified && r.verdict === "pass"))
      throw Error("独立评审未完成：本次补评没有绑定已接纳的原候选。");
    receipts.push(...verified);
  }
  return [...new Map(receipts.map(r => [r.requestId,r])).values()];
}

/** One public proof predicate for live repair completion and read-only historical recovery. */
export async function inspectRepairVerification({versioning,route,step,record,draft,result}) {
  const rejected=reason=>({verified:false,reason});
  if(!versioning||route?.status!=='repair'||!['scope_expansion','failed'].includes(route.kind)||
    !route.edit||route.taskId!==record?.id||route.edit.taskId!==record.id||
    route.edit.changeId!==route.changeId||route.revision!==step.revision||!step.checks?.length)
    return rejected('No matching diagnosed repair and frozen checks');
  try {
    const current=await versioning.inspect({changeId:route.changeId});
    if(draft&&(draft.taskId!==record.id||draft.changeId!==route.changeId||!draft.version))return rejected('Draft is outside the diagnosed repair');
    if(!draft&&(current.status!=='prepared'||current.basisStatus!=='current'))return rejected('Current repaired candidate is not prepared on its current basis');
    const edit=await versioning.inspect({requestId:route.edit.requestId});
    if(edit.status!=='applied'||!edit.privateVersion)return rejected('Original diagnosed edit has no applied receipt');
    const candidates=[...(current.candidates??[])].reverse();
    for(const candidate of candidates) {
      const checked=candidate.precheck;
      if(result&&candidate.candidateVersion!==result.binding?.candidateVersion)continue;
      if(!draft&&(current.candidateVersion!==candidate.candidateVersion||current.privateVersion!==candidate.privateVersion))continue;
      if(checked?.status!=='passed'||checked.verification!=='passed'||checked.tree!==candidate.tree||
        checked.binding?.candidateVersion!==candidate.candidateVersion||checked.binding?.policy!==candidate.policy||
        (record.project?.checkPolicy?.digest&&candidate.policy!==record.project.checkPolicy.digest)||
        checked.checks?.length!==step.checks.length||!step.checks.every((expected,index)=>{
          const actual=checked.checks[index];return actual?.command===expected.command&&
            isDeepStrictEqual(actual.args??[],expected.args??[])&&actual.exitCode===0&&actual.sourceChanged===false;
        }))continue;
      if(result){const supplied={...result};delete supplied.requestId;delete supplied.tree;
        const original={...checked};delete original.tree;
        if(result.tree!==candidate.tree||!isDeepStrictEqual(supplied,original))continue;}
      let same=true;
      for(const version of [edit.privateVersion,...(draft?[draft.version]:[])]) {
        const diff=await versioning.inspect({fromVersion:candidate.candidateVersion,toVersion:version});
        if(diff.files?.length||diff.binaryFiles?.length||diff.text){same=false;break;}
      }
      if(!same)continue;
      const requests=(record.work?.requests??[]).filter(request=>request.action==='prepareChange'&&
        request.changeId===route.changeId&&request.dispatched!==false&&(!result||request.requestId===result.requestId));
      for(const request of requests) {
        const receipt=await versioning.inspect({requestId:request.requestId});
        const fixed=receipt.candidates?.find(item=>item.candidateVersion===candidate.candidateVersion);
        if(receipt.changeId!==route.changeId||receipt.candidateVersion!==candidate.candidateVersion||
          receipt.privateVersion!==candidate.privateVersion||!isDeepStrictEqual(fixed?.precheck,checked))continue;
        return {verified:true,proof:{taskId:record.id,changeId:route.changeId,requestId:request.requestId,
          candidateVersion:candidate.candidateVersion,privateVersion:candidate.privateVersion,tree:candidate.tree,
          policy:candidate.policy,checks:structuredClone(checked.checks)}};
      }
    }
    return rejected('No public precheck receipt matches the exact repaired candidate and all frozen checks');
  }catch(error){return rejected('Public repair verification is unavailable: '+(error.code??error.message));}
}


/** Read-only evidence for this writer invocation; nothing is added to saved state. */
export async function completedContinuationEvidence(home,state) {
  if(!home||state.entryPolicy!=='unified')return [];
  const candidates=Object.entries(state.commands??{}).filter(([,command])=>command.status==='settled'&&command.continuation);
  if(!candidates.length)return [];
  const facts=[];let v;
  try {
    v=await createVersioning({home,project:state.repo,backend:'agent-sync',readOnly:true});
    const formal=await v.inspect();
    if(formal.version!==state.version||formal.integrationRef!==state.integrationRef)return [];
    const history=new Set();let cursor;
    do {
      const page=await v.inspect({history:{limit:100,...(cursor?{cursor}:{})}});
      for(const item of page.versions)history.add(item.version);
      cursor=page.nextCursor;
    }while(cursor);
    for(const [commandId,command] of candidates)try {
      const ref=command.continuation,root=readTask(home,command.rootTaskId);
      if(root.status!=='completed'||root.projectOperation?.commandId!==commandId||!isDeepStrictEqual(root.projectOperation.continuation,ref)||
        root.executionBinding?.formalRef!==state.integrationRef||!root.deliveryRef||!history.has(root.deliveryRef.version))continue;
      const lineage=continuationLineage(home,state,root);
      const delivery=resolveDeliveryEvidence(home,root);
      if(!delivery||delivery.visualError||!resolveManagerFinal(home,root,delivery))continue;
      for(const {record:source,stepId} of delivery.sources) {
        const step=state.steps.find(item=>item.id===stepId),attempt=step?.attempts.find(item=>item.taskId===source.id);
        if(!attempt||attempt.status!=='completed'||source.status!=='completed'||!isDeepStrictEqual(source.project.scope,step.scope)||
          !isDeepStrictEqual(attempt.check,source.work.finalCheck)||!history.has(attempt.version))continue;
        const closure=await executionFacts(v,source,readRequests(home,source));
        if(closure.pendingEffects.length||!locallyClosed(source,readRequests(home,source),closure))continue;
        let accepted=false;
        for(const row of source.work.acceptance??[]) {
          if(row.status!=='accepted'||!source.work.requests.some(request=>request.action==='acceptChange'&&request.requestId===row.requestId))continue;
          const receipt=await v.inspect({requestId:row.requestId});
          if(receipt.status==='accepted'&&receipt.verification==='passed'&&receipt.changeId===row.changeId&&
            receipt.candidateVersion===row.candidateVersion&&receipt.acceptedVersion===row.acceptedVersion&&
            history.has(receipt.acceptedVersion)&&(!attempt.acceptedVersion||attempt.acceptedVersion===receipt.acceptedVersion))accepted=true;
        }
        if(!accepted)continue;
        const checked=await v.inspect({requestId:source.work.finalCheck.requestId});
        if(checked.status!=='passed'||checked.verification!=='passed'||checked.version!==attempt.version||
          checked.binding?.version!==attempt.version||!isDeepStrictEqual(checked.checks,attempt.check.checks))continue;
        let rootsClosed=true;
        for(const ancestor of lineage) {
          const evidence=await executionFacts(v,ancestor,readRequests(home,ancestor));
          if(evidence.pendingEffects.length||!locallyClosed(ancestor,readRequests(home,ancestor),evidence)){rootsClosed=false;break;}
        }
        if(!rootsClosed)continue;
        const roots=continuationSourceRoots(state,ref);
        for(const original of step.attempts) {
          if(original.taskId===attempt.taskId||!roots.has(original.rootTaskId))continue;
          const prior=readTask(home,original.taskId),requests=readRequests(home,prior);
          if(prior.project?.id!==state.id||prior.project.stepId!==step.id||prior.rootTaskId!==original.rootTaskId||
            !isDeepStrictEqual(prior.project.scope,source.project.scope))continue;
          const priorFacts=await executionFacts(v,prior,requests);
          if(priorFacts.pendingEffects.length||!locallyClosed(prior,requests,priorFacts))continue;
          const unknown=requests.filter(request=>request.sent&&request.status==='outcome_unknown');
          if(unknown.some(request=>!ref.requestIds.includes(request.id)||request.phase==='project-effect'||!hostOnlyRequest(request)))continue;
          facts.push({projectId:state.id,formalRef:state.integrationRef,taskId:prior.id,successorTaskId:attempt.taskId,
            requestIds:unknown.map(request=>request.id),scope:[...prior.project.scope]});
        }
      }
    }catch { /* Missing, incomplete or forged evidence releases no occupancy. */ }
  }finally{await v?.close();}
  return facts;
}


/** Carry an unused, observed repair; never grant another judgment or edit. */
export async function inspectUnspentRepair({home,versioning,route,step,record,draft}) {
  if(!['repair','blocked'].includes(route?.status)||route.kind!=='failed'||route.edit||route.feedback||route.coordination||
    !route.judgmentCall||!route.probe?.completedAt||route.probe.error||route.probe.decision!=='repair'||
    record?.id!==route.taskId||record.project?.id!==route.projectId||record.project.stepId!==step.id||route.revision!==step.revision||
    draft?.taskId!==record.id||draft.changeId!==route.changeId||draft.version!==(route.expansion?.confirmedVersion??route.privateVersion)||
    !isDeepStrictEqual(record.project.checks,step.checks)||!isDeepStrictEqual(record.project.scope,step.scope)||
    !route.judgment?.repairScope?.length||route.judgment.repairScope.some(p=>!inScope(p,step.scope)))return false;
  try {
    const origin=route.restoredFrom?(step.routeHistory??[]).find(r=>r.status==='repair'&&!r.restoredFrom&&r.judgmentCall===route.judgmentCall&&
      isDeepStrictEqual(r.probe,route.probe)&&isDeepStrictEqual(r.judgment,route.judgment)):route;
    if(!origin||origin.status!=='repair'&&origin!==route||origin.edit||origin.feedback||origin.coordination)return false;
    const owner=origin===route?record:readTask(home,origin.taskId);
    if(owner.project.id!==route.projectId||owner.project.stepId!==step.id||!isDeepStrictEqual(owner.project.checks,step.checks)||!isDeepStrictEqual(owner.project.scope,step.scope))return false;
    const call=readRequest(home,owner.id,origin.judgmentCall);
    if(call.status!=='completed'||!call.sent||call.role!=='main'||!call.response?.content?.some(part=>part.type==='toolCall'&&
      part.name==='project_route_judge'&&['path','contains','ifPresent','ifAbsent','repairScope'].every(key=>isDeepStrictEqual(part.arguments?.[key],route.judgment[key]))))return false;
    for(const source of new Set([owner,record])){
      const at=source===owner?source.requestIds.indexOf(call.id):-1;if(source===owner&&at<0)return false;
      const tools=new Set(source.requestIds.slice(at+1).flatMap(id=>readRequest(home,source.id,id).response?.content?.filter(p=>p.type==='toolCall').map(p=>p.id)??[]));
      if(source.tools?.some(t=>tools.has(t.toolCallId)&&t.kernelInput&&t.kernelDispatched!==false))return false;
    }
    const unchanged=async version=>{const d=await versioning.inspect({fromVersion:version,toVersion:draft.version});return !d.files.length&&!d.binaryFiles?.length&&!d.text;};
    const failed=async(evidence,candidate,changeId)=>{
      const receipt=await versioning.inspect({requestId:evidence.requestId});
      const check=receipt.status==='check_failed'?receipt:receipt.candidates?.find(c=>c.candidateVersion===candidate)?.precheck;
      return receipt.changeId===changeId&&check?.status==='check_failed'&&check.binding?.candidateVersion===candidate&&
        (!owner.project.checkPolicy||check.binding.policy===owner.project.checkPolicy.digest)&&isDeepStrictEqual(check.checks,evidence.checks)&&
        check.checks.some(c=>c.exitCode!==0)&&check.checks.length<=step.checks.length&&check.checks.every((c,i)=>
          c.sourceChanged===false&&c.command===step.checks[i].command&&isDeepStrictEqual(c.args??[],step.checks[i].args??[]))&&await unchanged(candidate);
    };
    if(!await failed(origin.evidence,origin.candidate,origin.changeId))return false;
    if(route.status==='blocked'&&!route.recheck)return false;
    if(route.recheck&&!await failed(route.recheck.evidence,route.recheck.candidate,route.changeId))return false;
    const current=await versioning.inspect({changeId:route.changeId});
    if(current.privateVersion!==draft.version||current.readOnly||!record.work.changes.some(c=>c.changeId===route.changeId&&!c.readOnly))return false;
    if(route.expansion){const r=await versioning.inspect({requestId:route.expansion.requestId});if(!route.restoredFrom||r.status!=='open'||r.changeId!==route.changeId||r.privateVersion!==draft.version)return false;}
    const file=await versioning.read({version:origin.candidate,path:route.judgment.path});
    if(file.contentHash!==route.probe.contentHash||route.probe.path!==route.judgment.path||file.contentBase64===null)return false;
    const present=Buffer.from(file.contentBase64,'base64').toString('utf8').includes(route.judgment.contains);
    return present===route.probe.present&&route.judgment[present?'ifPresent':'ifAbsent']==='repair';
  }catch{return false;}
}
