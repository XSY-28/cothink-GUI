import {continuedTask} from "./project-continuation.js";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { inScope, projectScopesOverlap } from "./versioning.js";
import { workModelIdentity } from "./workers.js";
import { problem } from "./task.js";
import { assertProjectReview, readReviewCandidate, completeProjectReview } from "./project-review.js";
import { registerSubwork, completedHandoff, canonical, sameMaterials, authorizedPosition, worksOf, actions, active, ancestry, assignments, changeProjectStaff, fail, maxDepth, needs, position, requireText, scopeList, supervisors, taskStep } from "./project-staff-topology.js";
export { changeProjectStaff } from "./project-staff-topology.js";

const overlap = (a, b) => a.some((path) => inScope(path, b)) || b.some((path) => inScope(path, a));
function leafMatches(works, scope) {
  return works.filter((w) => overlap(w.scope, scope) &&
    !works.some((child) => child.parentWorkId === w.id && overlap(child.scope, scope)));
}
function selectWork(state, input, row) {
  const step = taskStep(state, input.taskId);
  if (!step) {
    if (state.steps?.length || input.workId) fail("Work does not belong to a registered project step.");
    return {}; // Pre-project records retain their original, conservative identity lock.
  }
  const works = worksOf(step);
  const area = canonical(input.readOnly ? input.readScope : input.scope);
  const named = input.workId && works.find((w) => w.id === input.workId);
  if (input.workId && !named) fail("Unknown work in the authorized step: " + input.workId);
  const matches = leafMatches(works, area);
  const work = named || (matches.length === 1 ? matches[0] : null);
  if (input.reviewOf) {
    const source = input.reviewSource ?? state.staffAssignments?.[input.reviewOf];
    const candidate = source?.candidate ?? source?.version;
    if (named && (!overlap(area, named.scope) || ![source?.workId, ...(source?.workIds ?? [])].includes(named.id)))
      fail("A named review work must own the exact candidate and be within the read grant.");
    return {workId: JSON.stringify(["review", step.id, input.reviewOf, candidate, input.reviewKind ?? "independent", input.identity]),
      targetWorkId: source?.workId ?? named?.id};
  }
  if (named && input.readOnly && !overlap(area, named.scope))
    fail("Read scope does not reach the named work.");
  if (row.canDelegate && input.readOnly && !named)
    return {workId: JSON.stringify(["coordinate", step.id, canonical(row.scope),
      ...(row.supervisorId === "root" ? [] : [row.supervisorId])])};
  if (named && !input.readOnly && !matches.includes(named))
    fail("Select the registered subwork for that delivery boundary.");
  if (!work || (!input.readOnly && (!area.length || !area.every((path) => inScope(path, work.scope)))))
    fail("Select a registered work ID and a write scope within that work. Available: " +
      works.map((w) => w.id + " " + JSON.stringify(w.scope)).join(", "));
  if (input.readOnly)
    return {workId: JSON.stringify(["inspect", step.id, work.id]), targetWorkId: work.id};
  return {workId: work.id, ...(work.effect ? {effect: work.effect} : {})};
}
function actorAssignment(state, taskId, actorRole) {
  const a = assignments(state).find((a) => a.taskId === taskId && a.role === actorRole);
  if (!a || a.status !== "active") fail("No live project assignment for " + actorRole);
  assertUnpaused(a);
  const row = authorizedPosition(state, a);
  if (a.grantEpoch !== undefined && a.grantEpoch !== (row.transitions?.length ?? 0))
    fail("The original assignment grant has been handed off.");
  return a;
}
function verifyActor(state, input) {
  if (input.actorRole === undefined && !state.steps?.length) return;
  if (input.actorRole === "main" && input.actor === "root") return;
  const parent = actorAssignment(state, input.taskId, input.actorRole);
  if (parent.reviewOf || input.actor !== parent.staffId || input.supervisorMemberId !== parent.dispatchId)
    fail("Dispatch is outside the current supervisor session.");
}
function priorWork(state, prior) {
  if (prior.workId) return prior.workId;
  try {
    return selectWork(state, prior, position(state, prior.staffId)).workId;
  } catch {
    return undefined;
  }
}
function collision(state, a, input) {
  if (a.staffId === input.staffId) return true;
  if (!state.steps?.length) return a.identity === input.identity;
  if (a.reviewOf && a.reviewOf === input.reviewOf && a.status === "unknown") return true;
  const known = priorWork(state, a);
  if (known && input.workId) return known === input.workId ||
    (!a.readOnly && !input.readOnly && projectScopesOverlap(a.scope ?? [], input.scope ?? []));
  // An old unresolved operation with ambiguous materials must not gain a fresh
  // grant through a rename; allow only positively disjoint known targets.
  const area = (entry) => {
    const paths = entry.readOnly ? entry.readScope : entry.scope;
    return paths?.length ? paths : taskStep(state, entry.taskId)?.scope;
  };
  const before = area(a), after = area(input);
  if (before?.length && after?.length) return projectScopesOverlap(before, after);
  return true;
}
function admitAssignment(state, input, previous, proofs) {
  const { staffId, actor, identity, model, taskId } = input;
  for (const [name, val] of Object.entries({staffId, actor, identity, model, taskId})) requireText(val, name);
  if (state.paused || state.status === "paused") fail("Project is paused.");
  const constraints=taskStep(state,taskId)?.attempts.find(a=>a.taskId===taskId)?.constraints;
  if(constraints && !constraints.allowedSubtasks.includes("work") && !(constraints.allowedSubtasks.includes("review")&&input.readOnly&&!input.scope?.length&&input.reviewOf&&(input.reviewKind??"independent")==="independent"))fail("Root permits only independent read-only review assignments");
  const row = authorizedPosition(state, input);
  verifyActor(state, input);
  scopeList(input.scope ?? [], row.scope, "write scope");
  scopeList(input.readScope ?? [], row.readScope, "read scope");
  if(state.entryPolicy==="unified")scopeList(input.readScope??[],state.readScope,"root read scope");
  const held = assignments(state).find((a) => a !== previous && a.status !== "disposed" && !continuedTask(state,input.taskId,a.taskId,proofs) && collision(state, a, input));
  if (held) {
    if (held.actor === input.actor && (!input.actorRole || held.actorRole === input.actorRole))
      fail("Work or position held by " + held.dispatchId + ". Handle its original request/draft first.");
    fail("Work or position held by another authorized session.");
  }
  if (!input.readOnly && (state.rootWorkClaims ?? []).some((c) => !c.abandoned && !c.accepted && !continuedTask(state,taskId,c.taskId,proofs) &&
      taskStep(state, c.taskId)?.id === taskStep(state, taskId)?.id &&
      (c.workId === input.workId || projectScopesOverlap(c.scope, input.scope ?? []))))
    fail("Root already owns this work.");
  assertProjectReview(state, input);
}
function beginStaffAssignment(state, input, beforeNew, proofs) {
  state.staffAssignments ??= {};
  const row = authorizedPosition(state, input);
  verifyActor(state, input);
  const epoch = row.transitions?.length ?? 0;
  input = {...input, ...selectWork(state, input, row), grantEpoch: epoch};
  const prior = assignments(state).findLast((a) =>
    input.workId && priorWork(state, a) === input.workId && a.outcome !== "not_sent" && !continuedTask(state,input.taskId,a.taskId,proofs));
  if (prior) {
    if (state.status === "paused" || state.paused) fail("Project is paused.");
    if (sameMaterials(prior, input) && (prior.grantEpoch ?? 0) === epoch)
      return {...prior, reused: true};
    if (!completedHandoff(state, prior)) fail("This work already has an assignment. Use its original owner and materials or resolve the handoff.");
  }
  admitAssignment(state, input,undefined,proofs);
  const dispatchId = input.dispatchId ?? randomUUID();
  if (Object.hasOwn(state.staffAssignments, dispatchId) || Object.hasOwn(Object.prototype, dispatchId))
    fail("Dispatch id already exists or is invalid.");
  const role = "member:" + dispatchId;
  if (input.role && input.role !== role) fail("Role does not match the bound dispatch.");
  beforeNew?.();
  const a = { ...input, dispatchId, role, status: "active" };
  state.staffAssignments[a.dispatchId] = a;
  return a;
}
function recordRootSettlement(state, {taskId, changeId, requestId, reason, acceptedVersion}) {
  if (!requestId) fail("Root handoff requires its original settlement receipt.");
  for (const claim of state.rootWorkClaims ?? []) {
    if (claim.taskId === taskId && claim.changeId === changeId && !claim.abandoned) {
      if (acceptedVersion) claim.accepted = {requestId, version:acceptedVersion};
      else claim.abandoned = {requestId, reason};
    }
  }
}
function checkAssignedScope(state, assignment, scope) {
  if (!assignment.workId || !scope.length) return;
  const works = worksOf(taskStep(state, assignment.taskId));
  const work = works.find((w) => w.id === assignment.workId);
  if (assignment.readOnly || !work) fail("Read-only project work scope does not permit edits.");
  scopeList(scope, work.scope, "registered work scope");
  if (!leafMatches(works, scope).includes(work))
    fail("This work scope belongs to a registered subitem.");
}
function resumeAssignment(state, input, proofs) {
  const prev = state.staffAssignments?.[input.dispatchId];
  if (!prev || !["result", "disposed"].includes(prev.status))
    fail("Feedback requires a known, settled result.");
  assertUnpaused(prev);
  const next = { ...prev, ...input };
  if (prev.grantEpoch !== undefined && prev.grantEpoch !== (position(state, prev.staffId).transitions?.length ?? 0))
    fail("The original assignment grant has been handed off.");
  const newest = assignments(state).findLast((a) => a.workId && a.workId === prev.workId);
  if (newest && newest !== prev) fail("Work belongs to a later assignment.");
  for (const key of ["staffId", "identity", "taskId", "actor", "actorRole", "supervisorMemberId", "role", "model", "reviewOf", "workId"])
    if (next[key] !== prev[key]) fail("Feedback changes original assignment: " + key);
  if (prev.workId && prev.readOnly && !next.readOnly) fail("Cannot turn the original read-only work into an edit.");
  checkAssignedScope(state, prev, next.scope ?? []);
  if (prev.reviewOf && JSON.stringify(canonical(next.readScope)) !== JSON.stringify(canonical(prev.readScope)))
    fail("Review feedback must retain the fixed candidate read scope.");
  admitAssignment(state, next, prev,proofs);
  Object.assign(prev, next, { status: "active" });
  delete prev.candidate;
  delete prev.failure;
  return prev;
}
function updateStaffAssignment(state, id, patch) {
  const a = state.staffAssignments?.[id] ?? fail("Unknown dispatch: " + id);
  if (!["active", "result", "unknown", "disposed"].includes(patch.status))
    fail("Unknown assignment state: " + patch.status);
  if (a.status === "unknown" && patch.status !== "unknown")
    fail("Reconcile the original unknown operation: " + id);
  if (a.status === "disposed") {
    if (patch.status !== "disposed") fail("Assignment has already been disposed: " + id);
    return a;
  }
  for (const k of ["status", "requestId", "candidate", "baseVersion", "version", "failure", "changeId"])
    if (patch[k] != null) a[k] = patch[k];
  if (patch.status === "disposed" && ["abandoned", "accepted", "completed"].includes(patch.outcome))
    a.outcome = patch.outcome;
  if (patch.status === "unknown" && patch.requestId) {
    a.unknownRequestIds = [...new Set([...(a.unknownRequestIds ?? []), patch.requestId])];
  }
  return a;
}

function reconcileAssignments(state, record, requests, kernelFacts = []) {
  const facts = new Map(kernelFacts.map((f) => [f.requestId, f.status]));
  const abandoned = (record.work?.requests ?? []).filter((op) =>
    op.action === "abandonChange" && facts.get(op.requestId) === "abandoned");
  for (const op of abandoned)
    recordRootSettlement(state, {taskId: record.id, changeId: op.changeId, requestId: op.requestId});
  const resolved = (id) =>
    [
      "accepted",
      "applied",
      "completed",
      "open",
      "prepared",
      "abandoned",
      "passed",
      "check_failed",
      "failed",
      "rejected",
      "blocked",
      "conflict",
      "cancelled",
      "not_sent",
    ].includes(facts.get(id));
  for (const a of assignments(state).filter((a) => a.taskId === record.id)) {
    const member = record.members?.find((m) => "member:" + m.memberId === a.role);
    if (!a.workId && member) {
      try {
        const work = selectWork(state, { ...a, scope: member.scope ?? a.scope, readScope: member.readScope ?? a.readScope }, position(state, a.staffId));
        if (work.workId) Object.assign(a, work);
      } catch {
        // Keep the legacy lock if surviving project and task facts are insufficient.
      }
    }
    const calls = requests.filter((c) => c.role === a.role);
    const operations = [...(record.work?.requests ?? []), ...(record.tools ?? [])].filter(
      (op) =>
        op.requestId &&
        (op.requestId === member?.beginRequestId ||
          op.requestId === member?.refreshRequestId ||
          op.requestId === member?.kernelUnknownRequestId ||
          (member?.changeId && op.changeId === member.changeId)),
    );
    const unknownCalls = calls.filter((c) => c.sent && !["partial", "completed", "failed"].includes(c.status));
    const unknownOps = operations.filter(
      (op) =>
        !resolved(op.requestId) &&
        ["unknown", "outcome_unknown", "preparing", "in_flight", "pending", "waiting"].includes(op.status),
    );
    a.calls = calls.map((c) => ({
      id: c.id,
      sent: c.sent,
      status: c.status,
    }));
    // Establish a new fact for each previously unknown ID before releasing its owner.
    const unresolved = new Set([
      ...unknownCalls.map((c) => c.id),
      ...unknownOps.map((op) => op.requestId),
      ...(member?.kernelUnknownRequestId && !resolved(member.kernelUnknownRequestId)
        ? [member.kernelUnknownRequestId]
        : []),
    ]);
    for (const id of a.unknownRequestIds ?? []) {
      if (
        !resolved(id) &&
        !calls.some((c) => c.id === id && (!c.sent || ["completed", "failed", "partial"].includes(c.status)))
      )
        unresolved.add(id);
    }
    a.unknownRequestIds = [...unresolved];
    if (member?.changeId) a.changeId = member.changeId;
    if (member?.candidateVersion) a.candidate = member.candidateVersion;
    if (member?.baseVersion) a.baseVersion = member.baseVersion;
    if (member?.acceptedVersion) a.version = member.acceptedVersion;
    if (member?.error) a.failure = member.error;
    const neverStarted =
      record.status !== "running" &&
      !member?.changeId &&
      !a.changeId &&
      (!member?.beginRequestId || facts.get(member.beginRequestId) === "not_sent") &&
      !calls.some((c) => c.sent) &&
      operations.every((op) => facts.get(op.requestId) === "not_sent");
    if (
      a.pause?.status === "unknown" || unresolved.size ||
      (member?.status === "outcome_unknown" && !resolved(member.kernelUnknownRequestId ?? member.beginRequestId))
    )
      a.status = "unknown";
    else if (
      member?.status === "accepted" ||
      (member?.status === "abandoned" &&
        (a.outcome === "abandoned" || abandoned.some((op) => op.changeId === member.changeId) ||
          (!member.changeId && (!member.beginRequestId || facts.get(member.beginRequestId) === "not_sent")))) ||
      (member?.collected && member.status === "completed" && (member.readOnly || member.noChange))
    ) {
      a.status = "disposed";
      a.outcome = member.status;
    } else if (neverStarted) {
      a.status = "disposed";
      a.outcome = "not_sent";
    } else if (member && ["completed", "failed", "cancelled", "outcome_unknown"].includes(member.status))
      a.status = "result";
  }
}

function assertUnpaused(assignment) {
  if (assignment?.pause) throw problem("GROUP_PAUSED", "This assignment is paused under its original dispatch.");
}

function assignmentOwner(state, {taskId, actorRole, dispatchId, rootReview = false, allowPaused = false, resumeCandidate}) {
  if (state.paused || state.status === "paused") fail("Project is paused.");
  const a = state.staffAssignments?.[dispatchId];
  if (!a || a.taskId !== taskId) fail("Assignment unavailable to this session.");
  if (!allowPaused) {
    const continuation = a.pause?.continuations?.at(-1);
    if (!resumeCandidate || actorRole !== "main" || !rootReview || !continuation || continuation.revokedAt ||
      continuation.candidate !== resumeCandidate.candidate || continuation.privateVersion !== resumeCandidate.privateVersion)
      assertUnpaused(a);
  }
  const row = authorizedPosition(state, a);
  if ((a.grantEpoch ?? 0) !== (row.transitions?.length ?? 0))
    fail("Assignment authority has changed.");
  if (actorRole === "main" && (rootReview || a.actor === "root")) return a;
  if (actorRole === "main") fail("Only the direct supervisor controls this assignment.");
  const parent = actorAssignment(state, taskId, actorRole);
  if (a.supervisorMemberId !== parent.dispatchId || a.actor !== parent.staffId)
    fail("Only the direct supervisor controls this assignment.");
  return a;
}

function pauseAssignments(state, input, snapshot) {
  const target = assignmentOwner(state, {...input, allowPaused:true});
  const reason = requireText(input.reason, "Pause reason");
  const group = [target], affected = [];
  const candidates = assignments(state).filter((a) => a.taskId === input.taskId);
  const at = new Date().toISOString();
  for (const a of group) {
    group.push(...candidates.filter((child) => child.supervisorMemberId === a.dispatchId));
    if (a.status === "disposed") continue;
    const continuation = a.pause?.continuations?.at(-1);
    if (continuation && !continuation.revokedAt) {
      continuation.revokedAt = at;
      continuation.revokedBy = input.actorRole;
      continuation.revocationReason = reason;
      Object.assign(a.pause, snapshot(a.dispatchId), {status:"pausing"});
    }
    a.pause ??= {...snapshot(a.dispatchId), status:"pausing", reason, at, by:input.actorRole};
    affected.push({dispatchId:a.dispatchId, pause:a.pause});
  }
  if (!affected.length) fail("The assignment group has already been settled.");
  return affected;
}

function resumePausedCandidate(state, input) {
  const a = assignmentOwner(state, {...input, allowPaused:true});
  const pause = a.pause, reason = requireText(input.reason, "Candidate continuation reason");
  if (a.status !== "result" || pause?.status !== "settled" || pause.changeStatus !== "prepared" ||
    pause.candidate !== input.candidate || pause.privateVersion !== input.privateVersion)
    throw problem("GROUP_RESUME", "Only a settled, exact prepared candidate may continue.");
  const continuations = (pause.continuations ??= []);
  if (!continuations.length || continuations.at(-1).revokedAt)
    continuations.push({candidate:input.candidate, privateVersion:input.privateVersion, reason,
      by:input.actorRole, at:new Date().toISOString()});
  return pause;
}

export function createProjectStaff(host) {
  const change = (action, input, actor = "root", automatic = false, options) =>
    host.update((state) => action === "register_work"
      ? registerSubwork(state, options?.taskId, actor, input ?? {}, host.completedContinuations)
      : changeProjectStaff(state, action, input, actor, automatic, options));
  return {
    list: () => host.read().staff ?? [],
    rootReview: (ref, task, v, scope) => readReviewCandidate(host, ref, task, v, scope),
    reviewCandidate: (ref, task, v, scope, actorRole) => readReviewCandidate(host, ref, task, v, scope, actorRole),
    completeReview: (member, task, v) => completeProjectReview(host,member,task,v),
    assignment: (id) => host.read().staffAssignments?.[id],
    change,
    settledRoot: (detail) => host.update((state) => recordRootSettlement(state, detail)),
    begin: (input, beforeNew) => host.update((state) => beginStaffAssignment(state, input, beforeNew,host.completedContinuations)),
    resume: (input) => host.update((state) => resumeAssignment(state, input,host.completedContinuations)),
    update: (id, patch) => host.update((state) => updateStaffAssignment(state, id, patch)),
    pause: (input, snapshot) => host.update((state) => pauseAssignments(state, input, snapshot)),
    resumePausedCandidate: (input) => host.update((state) => resumePausedCandidate(state, input)),
    settlePause(dispatchId, receipt) {
      return host.update((state) => {
        const a = state.staffAssignments?.[dispatchId];
        if (a?.pause?.status !== "pausing") fail("No pending assignment pause.");
        Object.assign(a.pause, receipt);
        if (receipt.status === "unknown" && a.status !== "disposed") {
          a.status = "unknown";
          a.unknownRequestIds = [...new Set([...(a.unknownRequestIds ?? []), ...receipt.unresolvedRequestIds])];
        }
        return a.pause;
      });
    },
    canManage(taskId, staffId) {
      const state = host.read();
      const chain = ancestry(state, staffId);
      return chain.length + 1 < maxDepth(state, taskId) &&
        chain.every((row) => active(row) && row.canDelegate);
    },
    reconcile: (record, requests, facts) =>
      host.update((state) => reconcileAssignments(state, record, requests, facts)),
    works(taskId, actorRole = "main") {
      const state = host.read();
      const works = worksOf(taskStep(state, taskId));
      if (actorRole === "main") return works;
      const a = actorAssignment(state, taskId, actorRole);
      const row = supervisors(state, a.staffId, taskId)[0];
      return works.filter((w) => w.scope.every((path) => inScope(path, row.scope)));
    },
    checkOwner(input) {
      assignmentOwner(host.read(), input);
      return true;
    },
    checkIdentity({ taskId, role, identity, model }, state = host.read()) {
      const canonicalIdentity = identity ?? (model && workModelIdentity({ modelId: model.modelId ?? model.id }));
      const current = role === "main" ? {taskId, role, identity: canonicalIdentity} : actorAssignment(state, taskId, role);
      if (role !== "main") {
        const a = current;
        if (a.identity !== canonicalIdentity || (model?.provider && a.model !== model.provider + "/" + (model.modelId ?? model.id)))
          fail("Model does not match its current assignment.");
      }
      const locked = assignments(state).find((a) => !priorWork(state, a) && a.identity === canonicalIdentity &&
        a.status !== "disposed" && a !== current && !continuedTask(state,taskId,a.taskId,host.completedContinuations) && collision(state, a, current));
      if (locked) fail("Legacy model identity held by " + locked.dispatchId);
      return true;
    },
    checkWork({ taskId, role, action, scope = [], readScope = [], model }) {
      if (role === "main") return true;
      const state = host.read(), a = actorAssignment(state, taskId, role);
      const row = authorizedPosition(state, model ? {...a,model:typeof model==='string'?model:model.provider+'/'+(model.modelId??model.id)} : a);
      scopeList(scope, row.scope, "write scope");
      if (action !== "delegate") {
        checkAssignedScope(state, a, scope);
        if (a.workId) scopeList(readScope, [...(a.scope ?? []), ...(a.readScope ?? [])], "assignment read scope");
      }
      scopeList(readScope, [...row.scope, ...row.readScope], "read scope");
      return true;
    },
    claimWrite({taskId, role, scope = [], changeId}, draft) {
      if (!scope.length) return;
      const claim = (state) => {
        if (state.paused || state.status === "paused") fail("Project is paused.");
        const step = taskStep(state, taskId);
        if (!step || step.attempts.at(-1)?.taskId !== taskId) fail("No current project step owns this edit.");
        if (role !== "main") {
          const a = actorAssignment(state, taskId, role);
          if (a.readOnly) fail("Read-only assignments cannot modify project work.");
          checkAssignedScope(state, a, scope);
          scopeList(scope, a.scope, "assignment write scope");
          return;
        }
        const works = worksOf(step);
        const selected = leafMatches(works, scope);
        if (!selected.length || scope.some((p) => !selected.some((w) => inScope(p, w.scope))))
          fail("Root edit must select a registered work boundary. Available: " + works.map((w) => w.id + " " + JSON.stringify(w.scope)).join(", "));
        for (const w of selected) {
          const target = {taskId, role, workId: w.id, scope: w.scope};
          const owner = assignments(state).find((a) => a.outcome !== "not_sent" && !a.readOnly && !completedHandoff(state, a) && !continuedTask(state,taskId,a.taskId,host.completedContinuations) &&
            (priorWork(state, a) === w.id || (a.status !== "disposed" && collision(state, a, target))));
          if (owner) fail("This work belongs to its employee; use its original draft and feedback.");
        }
        const claims = (state.rootWorkClaims ??= []);
        for (const w of selected) {
          if (!claims.some((c) => c.taskId === taskId && c.workId === w.id && c.changeId === changeId))
            claims.push({taskId, role, workId: w.id, scope: w.scope, changeId, ...(w.effect ? {effect:w.effect} : {})});
        }
      };
      return draft ? claim(draft) : host.update(claim);
    },
    tools(actor = "root", admit = () => {}, taskId, allowedModels) {
      return [
        {
          name: "project_staff",
          label: "Project staff",
          description:
            "Manage persistent project positions, separate from a Team model. List existing positions first. Appoint only for an independent deliverable, independent review, or configured capability gap. Never add credentials or capacity. need is exactly deliverable, review or capability. register_work {scope} returns a stable work ID only within this step and the current position scope; inspect the available work IDs and scopes first. Supply an input object, e.g. appoint {id,responsibility,scope,readScope,models,need,reason}; promote {id,subgoal,models}; retain {id,reason}; handoff {id,decision,pending,failure,version}; transfer {id,supervisorId,reason} or retire {id,reason}, then finish {id} once unresolved work is settled." +
            (actor === "root" ? " Root may set_depth {maxDepth} for this turn. Count root as layer one, use three layers by default and select four for work that needs another supervisor. Settle affected assignments before reducing depth." : ""),
          parameters: Type.Object({
            action: Type.Union([...actions, "register_work", ...(actor === "root" ? ["set_depth"] : [])].map((a) => Type.Literal(a))),
            input: Type.Optional(
              Type.Object({
                id: Type.Optional(Type.String()),
                responsibility: Type.Optional(Type.String()),
                supervisorId: Type.Optional(Type.String()),
                scope: Type.Optional(Type.Array(Type.String())),
                readScope: Type.Optional(Type.Array(Type.String())),
                models: Type.Optional(Type.Array(Type.String())),
                need: Type.Optional(Type.Union(needs.map((need) => Type.Literal(need)))),
                reason: Type.Optional(Type.String()),
                subgoal: Type.Optional(Type.String()),
                decision: Type.Optional(Type.String()),
                pending: Type.Optional(Type.String()),
                failure: Type.Optional(Type.String()),
                version: Type.Optional(Type.String()),
                ...(actor === "root" ? {maxDepth:Type.Optional(Type.Integer({minimum:1, maximum:4}))} : {}),
              }),
            ),
          }),
          async execute(_id, { action, input }) {
            admit({staffControl:{action,input:input??{}}});
            const result = action === "list"
                ? host
                    .read()
                    .staff.filter((p) => actor === "root" || p.id === actor || p.supervisorId === actor)
                : change(action, input ?? {}, actor, true, {taskId, allowedModels});
            return {
              content: [{ type: "text", text: JSON.stringify(result) }],
            };
          },
        },
      ];
    },
  };
}
