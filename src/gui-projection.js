import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { correctionPolicyText, finalText } from "./presentation.js";
import {resolveDeliveryEvidence,resolveManagerFinal} from "./project-delivery.js";
import {checkedVisualReview} from "./visual-preview.js";
import { readRequests, taskDisplayStatus } from "./task.js";
import { commandProgress, diagnostic, publicModel, requestProgress } from "./gui-process-projection.js";
export { projectGuiProcessCheck, publicModel } from "./gui-process-projection.js";

const clone = (value) => (value === undefined ? null : structuredClone(value));
export function taskOutputRefs(record) {
  const refs = new Set();
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (key === "outputRef" && typeof item === "string") refs.add(item);
      else if (item && typeof item === "object") visit(item);
    }
  };
  visit(record.work);
  visit(record.tools);
  visit(record.members);
  return [...refs];
}
export function publicTeam(team) {
  return team
    ? {
        id: team.id,
        name: team.name,
        main: publicModel(team.main),
        secondary: team.secondary.map(publicModel),
      }
    : null;
}
function hasActualRoles(record) {
  return record.flow === "unified" && !!record.turnIntent ||
    !!record.rootTaskId && record.project?.rootTaskId === record.rootTaskId;
}
const tokenUsage = usage => usage ? Object.fromEntries(
  ["input", "output", "cacheRead", "cacheWrite"].filter(key => Number.isFinite(usage[key])).map(key => [key, usage[key]]),
) : null;

function actualParticipants(record, messages) {
  const members = record.members ?? [];
  const supervisors = new Set(members.map(member => member.supervisorMemberId).filter(Boolean));
  const callsByRole = Map.groupBy(messages.filter(message => message.role), message => message.role);
  const fromRole = (role, position, selectedModel) => {
    const calls = callsByRole.get(role) ?? [];
    return {
      requestRole: role,
      position,
      model: calls.findLast(call => call.sent && call.actualModel)?.actualModel ?? null,
      selectedModel,
      participated: calls.some(call => call.sent),
      status: calls.at(-1)?.status ?? "not_called",
    };
  };
  const participants = [...callsByRole.keys()].filter(role => !role.startsWith("member:")).map(role => ({
    id: role,
    role,
    ...fromRole(role, role === "main" ? "manager" : role === "process-check" ? "process-check" : null),
  }));
  for (const member of members) {
    const position = member.reviewKind === "independent" ? "independent-review" :
      member.reviewKind === "ordinary" ? "review" :
      supervisors.has(member.memberId) ? "supervisor" : "employee";
    participants.push({
      id: member.memberId, role: "member", ...fromRole("member:" + member.memberId, position, publicModel(member.model)),
      staffId: member.staffId ?? null,
      supervisorId: member.supervisorMemberId ?? null,
      workId: member.workId ?? null,
      assignment: member.assignment ?? null,
      reason: member.reason ?? null,
      status: member.status,
      scope: member.scope ?? null,
      readScope: member.readScope ?? null,
      reviewVersion: member.reviewVersion ?? null,
      sourceCount: member.materialGrant?.sources?.length ?? null,
      attachmentCount: member.materialGrant?.attachments?.length ?? null,
      error: diagnostic(member.error),
      pause: member.pause ? {
        status: member.pause.status,
        reason: member.pause.reason ?? null,
        unresolvedRequestIds: member.pause.unresolvedRequestIds ?? [],
      } : null,
    });
  }
  const managerReceipts = new Set((callsByRole.get("main") ?? [])
    .filter(call => call.sent && call.status === "completed").map(call => call.id));
  for (const stage of record.stages) {
    const assignment = stage.assignment;
    if (!assignment || stage.role !== "member:" + stage.id ||
        !["readonly-worker","readonly-feedback"].includes(stage.phase)) continue;
    const collected = managerReceipts.has(assignment.collected?.callId);
    const treatment = assignment.treatment;
    participants.push({
      id: stage.id, role:"member", ...fromRole(stage.role,"employee",publicModel(stage.modelRef)),
      workId: assignment.workId,
      supervisorId: assignment.leaderId,
      assignment: assignment.work,
      reason: assignment.reason,
      status: assignment.status,
      readOnly: true,
      scope: [],
      readScope: assignment.grant?.paths ?? [],
      inputVersion: assignment.grant?.version ?? null,
      sourceCount: assignment.evidence?.length ?? 0,
      attachmentCount: assignment.attachments?.length ?? 0,
      error: diagnostic(assignment.error),
      collected,
      treatment: collected && managerReceipts.has(treatment?.callId) ?
        {decision:treatment.decision,reason:treatment.reason} : null,
    });
  }
  return participants;
}

export function projectGuiTask(record, requests = [], sessionEntries = [], {deliveryVersion = record.work?.version, liveRequests = false} = {}) {
  const actualRoles = hasActualRoles(record);
  const stages = new Map(record.stages.map(stage => [stage.id,stage]));
  const messages = requests.map((call) => {
    const stage = stages.get(call.stageId);
    const role = stage && (!actualRoles || ((!call.role || call.role === stage.role) &&
      (!stage.callIds || stage.callIds.includes(call.id)))) ? stage.role : null;
    return {
      id: call.id,
      role,
      phase: stage?.phase ?? null,
      model: publicModel(
        call.actualModel ??
          call.model ??
          call.requestedModel ??
          call.modelRef ??
          stage?.modelRef,
      ),
      status: call.status,
      progress: requestProgress(call, liveRequests && record.status === "running"),
      text: role === "process-check" ? "" : call.text ?? "",
      ...(actualRoles && {
        taskId: record.id,
        stageId: stage?.id ?? null,
        sessionId: stage?.sessionId ?? record.sessionId ?? null,
        actualModel: call.sent === true ? publicModel(call.actualModel) : null,
        sent: call.sent === true,
        maxOutputTokens: call.limits?.maxOutputTokens ?? null,
        usage: tokenUsage(call.usage),
        error: diagnostic(call.error),
      }),
    };
  });
  const frozenRoster=record.team??record.models;
  const managerFlow=record.flow==="unified"&&!!record.turnIntent;
  const roster=[
    {id:"main",role:"main",model:publicModel(frozenRoster?.main)},
    ...(frozenRoster?.secondary??[]).map((model,i)=>{
      const id="reviewer-"+(i+1);
      return {id,role:id,model:publicModel(model)};
    }),
  ];
  const participants = actualRoles ? actualParticipants(record,messages) : roster.map((p) => {
    const calls = messages.filter((m) => m.role === p.role);
    return {
      ...p,
      status: calls.at(-1)?.status ?? "not_called",
      participated: calls.length > 0,
    };
  });
  for (const member of actualRoles ? [] : record.members ?? [])
    participants.push({
      id: member.memberId,
      role: "member",
      model: publicModel(member.model),
      status: member.status,
      participated: messages.some(message => message.role === "member:" + member.memberId),
    });
  const w = record.work;
  const activities = projectWorkHandoffs(record,requests,sessionEntries);
  const work = w
    ? {
        helpers: (w.helpers ?? []).map(h=>({helperId:h.helperId,parentActorId:h.parentActorId,parentHelperId:h.parentHelperId??null,
          model:publicModel(h.model),status:h.status,stoppedAt:h.stoppedAt??null,text:h.text??null,
          result: h.result ? {digest:h.result.digest,files:h.result.edits.map(e=>({path:e.path,deleted:e.contentBase64===null,mode:e.mode??null}))}:null,
          treatment:clone(h.treatment),import:clone(h.import),usage:clone(h.usage),usageSource:h.usageSource,error:clone(h.error),resultError:clone(h.resultError)})),
        root: w.root ?? null,
        startVersion: w.startVersion ?? null,
        version: w.version ?? null,
        integrationRef: w.integrationRef ?? null,
        resultWorkspace: w.resultWorkspace ?? null,
        changes: (w.changes??[]).map(({changeId,actor,baseVersion,privateVersion,readOnly})=>({changeId,actor,baseVersion,privateVersion,readOnly})),
        finalCheck: clone(w.finalCheck),
        visualEvidence: (w.visualEvidence ?? []).map(e => {
          const imageRequestCompleted = !!e.imageRequestId && requests.some(r => r.id === e.imageRequestId && r.status === "completed");
          const checked = checkedVisualReview(e,deliveryVersion,imageRequestCompleted);
          return {
            toolCallId:e.toolCallId, actor:e.actor, sourceVersion:e.sourceVersion, privateVersion:e.privateVersion, integrationVersion:e.integrationVersion??null,
            entry:e.entry, viewport:clone(e.viewport), result:e.result, error:e.error??null, diagnostics:clone(e.diagnostics), imageRequestId:e.imageRequestId,
            visibility:clone(e.visibility), execution:e.execution?{image:e.execution.image,network:e.execution.network}:null,
            actions:clone(e.actions), frameTimesMs:clone(e.frameTimesMs),
            imageRequestCompleted, checked, semanticMatch: checked && e.review.verdict === "match", review:clone(e.review),
            images:e.images.map((i,index)=>({ref:e.outputRef,index,sha256:i.sha256,capturedAtMs:i.capturedAtMs})),
          };
        }),
        outputRefs: taskOutputRefs(record),
        members: (record.members ?? []).map((m) => ({
          id: m.memberId,
          model: publicModel(m.model),
          status: m.status,
          text:
            messages.findLast(
              (message) => message.role === "member:" + m.memberId,
            )?.text ?? "",
          readOnly: !!m.readOnly,
          assignment: m.assignment ?? m.task ?? null,
          understanding: m.understanding ?? null,
          taskConflict: clone(m.taskConflict),
          feedback: clone(m.feedback ?? []),
        })),
        activities: [
          ...activities,
          ...(w.operations ?? []).map((o) => ({
            action: o.action,
            status: o.status,
            explanation: o.explanation,
            changedFiles: clone(o.changedFiles),
          })),
        ],
        acceptance: clone(w.acceptance ?? []),
      }
    : null;
  return {
    projectPreparationBlocked:clone(record.projectPreparationBlocked),continuationSource:clone(record.continuationSource),
    origin:record.origin??null,contextResult:record.contextResult??null,preparation:record.preparation??null,
    id: record.id,
    flow:record.flow,constraints:clone(record.constraints),budget:clone(record.budget),readAuthorization:clone(record.readAuthorization),projectOperation:clone(record.projectOperation),deliveryRef:clone(record.deliveryRef),
    sessionId: record.sessionId,
    createdAt: record.createdAt ?? null,
    endedAt: record.endedAt ?? null,
    cancelRequestedAt: record.cancelRequestedAt ?? null,
    cancelSettledAt: record.cancelSettledAt ?? null,
    input: record.input,
    materials:(record.materials??[]).map(({ownerId,...ref})=>clone(ref)),
    status: taskDisplayStatus(record),
    resultRevision: guiResultRevision(record, finalGuiText(record, requests)),
    phase: record.phase,
    managerFlow,
    actualRoles,
    ...(actualRoles && {
      rosterCandidates: [frozenRoster?.main, ...(frozenRoster?.secondary ?? [])].map(publicModel).filter(Boolean),
      scope: record.project ? {write:record.project.scope??null,read:record.project.readScope??null,
        inputVersion:record.project.startVersion??null,assignment:record.project.subgoal??null} :
        record.readAuthorization ? {read:record.readAuthorization.paths, inputVersion:record.readAuthorization.version} : null,
      skillReads: (record.tools ?? []).filter(tool => tool.kind === "skill_resource_read" &&
        tool.status === "completed" && typeof tool.actor === "string" && stages.get(tool.stageId)?.role === tool.actor).map(tool => ({
        name:tool.resourceName,path:tool.resourcePath,hash:tool.resourceHash,role:tool.actor,stageId:tool.stageId,
      })),
    }),
    mode: record.singleModel ? "one" : "cothink",
    singleModel: !!record.singleModel,
    team: publicTeam(record.team),
    participants,
    messages,
    commands: commandProgress(record,liveRequests),
    correctionPolicy: actualRoles ? correctionPolicyText : null,
    usage: clone(record.usage),
    error: record.error ?? null,
    activities: w ? [] : activities,
    workPlanError: clone(record.workPlanError),
    workRequest: clone(record.workRequest),
    answerSkills: clone(record.answerSkills??[]),
    work,
  };
}
export function projectGuiExecutions(home, task, sources) {
  return sources.map(({record:saved,relation}) => {
    const current=relation === "owned" ? task.rootOwner?.snapshotFor(saved.id) : null;
    const child=current?.record ?? saved;
    const entries=[...new Set(child.stages.map(stage=>stage.sessionFile).filter(Boolean))].flatMap(path=>{
      try {return readFileSync(path,"utf8").split("\n").filter(Boolean).map(line=>({...JSON.parse(line),processSessionFile:path}));}
      catch {return [];}
    });
    const identity={relation,rootTaskId:child.rootTaskId,stepId:child.project.stepId};
    try {
      return {...projectGuiTask(child,current?.requests ?? readRequests(home,child),entries,
        {deliveryVersion:task.record.deliveryRef?.version??null,liveRequests:!!current}),...identity};
    } catch(error) {
      return {...projectGuiTask(child,[],entries,{deliveryVersion:null}),...identity,error:"执行请求来源尚不能核验："+error.message};
    }
  });
}
// Hash only what can change the delivery the user reads.
export function guiResultRevision(record, text, executionTasks=[]) {
  const drafts=[record,...executionTasks].flatMap(source=>(source.work?.changes??[])
    .filter(change=>!change.readOnly&&change.privateVersion)
    .map(change=>[source.id,change.changeId,change.baseVersion,change.privateVersion,
      (source.members??[]).find(member=>member.changeId===change.changeId)?.collected]));
  const status = taskDisplayStatus(record);
  if (!drafts.length && !["completed", "partial", "failed", "cancelled", "blocked", "outcome_unknown", "stop_unknown"].includes(status))
    return null;
  const work = record.work;
  const accepted = !work?.resultWorkspace && work?.acceptance?.findLast(receipt => receipt.status === "accepted");
  const check = work?.finalCheck;
  const evidence = check ? [check.status, check.verification, check.version ?? check.candidateVersion,
    !!check.reusedFrom, check.checks?.map(result =>
      [result.name, result.command, result.status, result.verification, result.exitCode, result.signal])] : null;
  return createHash("sha256").update(JSON.stringify([
    status, text, record.error ?? null, drafts,
    work ? [work.startVersion, accepted?.acceptedVersion ?? work.version, work.integrationRef, evidence] : null,
    record.deliveryRef ? [record.deliveryRef.version,record.deliveryRef.checksRef,record.deliveryRef.artifactsDigest,record.deliveryPlacement,record.managerFinal?.callId] : null,
  ])).digest("hex");
}

export function guiDeliverySummary(home, record) {
  try {
    const delivery=resolveDeliveryEvidence(home,record);
    const status=taskDisplayStatus(record);
    let managerError;
    if(status==="completed" && record.managerFinal) {
      try { resolveManagerFinal(home,record,delivery); }
      catch(error) { managerError="经理终稿尚不能核验："+error.message; }
    }
    const deliveryError=delivery?.visualError??managerError;
    return {sources:delivery?.sources??[],visualSource:delivery?.visualSource,
      status:deliveryError&&status==="completed"?"partial":status,
      error:record.error??deliveryError??null};
  } catch(error) {
    return {sources:[],status:taskDisplayStatus(record)==="completed"?"partial":taskDisplayStatus(record),
      error:"正式交付来源尚不能核验："+error.message};
  }
}

export function finalGuiText(record, requests,home) {
  return finalText(record, requests, {localArtifacts:false, hostFooter:false,home});
}

/** A handoff exists only when a saved tool call and its tool result agree. */
export function projectWorkHandoffs(record, requests, sessionEntries) {
  const actualRoles = hasActualRoles(record);
  const resultKey = (toolId, sessionFile) => actualRoles ? JSON.stringify([sessionFile??null,toolId]) : toolId;
  const stages = new Map(record.stages.map(stage => [stage.id,stage]));
  const results = new Map(
    sessionEntries
      .filter(
        (entry) =>
          entry.type === "message" && entry.message?.role === "toolResult",
      )
      .map((entry) => [resultKey(entry.message.toolCallId,entry.processSessionFile), entry.message]),
  );
  const activities = [];
  for (const call of requests) {
    for (const tool of call.response?.content ?? []) {
      if (tool.type !== "toolCall") continue;
      const saved = results.get(resultKey(tool.id,stages.get(call.stageId)?.sessionFile));
      const savedText = (saved?.content ?? []).filter(part => part.type === "text").map(part => part.text).join("\n");
      let result;
      try { result = JSON.parse(savedText); } catch { /* Older text-only tool results. */ }
      const errorText = saved?.isError ? diagnostic(result?.error ?? result) ??
        (result === undefined ? savedText : "工具失败，未保存可显示的诊断。") : "";
      // Preserve concrete executor/check failures already recorded by Pi. This is
      // a saved activity, never a synthesized model message or inferred handoff.
      if (!["delegate", "feedback", "collect"].includes(tool.name)) {
        if (saved?.isError) activities.push({
          type: "activity", action: tool.name, callId: call.id,
          toolCallId: tool.id, model: publicModel(call.actualModel ?? call.requestedModel),
          text: actualRoles ? errorText : savedText,
          status: "failed",
        });
        continue;
      }
      const members =
        tool.name === "collect"
          ? result?.members
          : result?.memberId
            ? [result]
            : [];
      const known = (Array.isArray(members) ? members : []).filter((member) =>
        record.members?.some((m) => m.memberId === member.memberId),
      );
      if (!known.length) {
        activities.push({
          type: "activity",
          action: tool.name,
          callId: call.id,
          toolCallId: tool.id,
          model: publicModel(call.actualModel ?? call.requestedModel),
          text: actualRoles ? errorText : JSON.stringify(tool.arguments ?? {}),
          status: saved?.isError ? "failed" : actualRoles && !saved ? "unverified" : "recorded",
        });
        continue;
      }
      for (const member of known)
        activities.push({
          type: "handoff",
          action: tool.name,
          callId: call.id,
          toolCallId: tool.id,
          memberId: member.memberId,
          model: publicModel(call.actualModel ?? call.requestedModel),
          text:
            tool.name === "collect"
              ? (member.result ?? "")
              : (tool.arguments?.feedback ?? tool.arguments?.assignment ?? tool.arguments?.task ?? ""),
          status: saved.isError ? "failed" : "recorded",
          relatedCallIds:
            tool.name === "collect"
              ? requests
                  .filter(
                    (r) =>
                      r.role === "member:" + member.memberId &&
                      r.text === member.result,
                  )
                  .map((r) => r.id)
              : [],
        });
    }
  }
  return activities;
}
