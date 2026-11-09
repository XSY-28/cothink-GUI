import { createHash, randomUUID } from "node:crypto";
import { Type } from "typebox";
import { inScope, projectScopesOverlap, assertProjectPathSpellings, validProjectPath } from "./versioning.js";
import { workModelIdentity } from "./workers.js";
import { problem } from "./task.js";
import { assertProjectReview, readReviewCandidate, completeProjectReview } from "./project-review.js";

const fail = (message) => {
  throw problem("PROJECT_STAFF", message);
};
const active = (position) => position?.status === "active";
const assignments = (state) => Object.values(state.staffAssignments ?? {});
const position = (state, id) => state.staff.find((p) => p.id === id) ?? fail("Unknown project position: " + id);
const requireText = (value, name) => {
  if (typeof value !== "string" || !value.trim()) fail(name + " is required.");
  return value.trim();
};
function scopeList(value, bound, name) {
  if (!Array.isArray(value)) fail(name + " must be a list of repository paths.");
  for (const path of value) {
    if (!validProjectPath(path, true) || !inScope(path, bound))
      fail(name + " exceeds authority: " + path);
  }
  return [...new Set(value)];
}
function models(value, parent) {
  if (
    !Array.isArray(value) ||
    value.some((m) => typeof m !== "string" || !m.trim() || (parent && !parent.models.includes(m)))
  )
    fail("Model is outside the supervisor's allowed roster.");
  return [...new Set(value)];
}
function supervisor(state, id) {
  if (id === "root") return null;
  const lead = position(state, id);
  if (!active(lead) || !lead.canDelegate || lead.supervisorId !== "root")
    fail("Not an active subgoal supervisor: " + id);
  return lead;
}
function handoff(row, input) {
  for (const key of ["version", "failure", "pending", "decision"]) {
    if (input[key] !== undefined) row.handoff[key] = requireText(input[key], key);
  }
}
const actions = ["list", "appoint", "promote", "retain", "handoff", "transfer", "retire", "finish"];
function transferModels(state, row, target) {
  const next = supervisor(state, target);
  if (next && row.canDelegate) fail("Transfer would create an extra supervisor layer.");
  scopeList(row.scope, next?.scope ?? state.scope, "scope");
  scopeList(row.readScope, next?.readScope ?? ["."], "readScope");
  return models(row.models.length || !next ? row.models : next.models, next);
}

export function changeProjectStaff(state, action, input = {}, actor = "root", automatic = false) {
  state.staff ??= [];
  if (action === "list") return state.staff;
  if (!actions.includes(action)) fail("Unknown staff action: " + action);
  if (state.status === "paused") fail("Project is paused.");
  const manager = supervisor(state, actor);
  const id = requireText(input.id, "Staff id");
  if (id === "root" || !/^[\p{L}\p{N}][\p{L}\p{N}_.-]*$/u.test(id) || Object.hasOwn(Object.prototype, id))
    fail("Invalid staff id.");
  if (action === "appoint") {
    const parentId = input.supervisorId ?? actor;
    if (manager && actor !== parentId) fail("Subgoal staffing is limited to direct reports.");
    const parent = supervisor(state, parentId);
    const scope = scopeList(input.scope ?? parent?.scope ?? state.scope, parent?.scope ?? state.scope, "scope");
    const readScope = scopeList(
      input.readScope ?? parent?.readScope ?? state.readScope ?? ["."],
      parent?.readScope ?? state.readScope ?? ["."],
      "readScope",
    );
    const allowed = models(input.models ?? parent?.models ?? [], parent);
    const responsibility = requireText(input.responsibility, "responsibility");
    if (automatic) {
      if (!["deliverable", "review", "capability"].includes(input.need))
        fail("Explain the independent deliverable, independent review or configured capability gap.");
      requireText(input.reason, "staffing reason and existing coverage");
      const covered = state.staff.find(
        (p) =>
          active(p) &&
          p.supervisorId === parentId &&
          p.responsibility === responsibility &&
          scope.every((s) => inScope(s, p.scope)) &&
          readScope.every((s) => inScope(s, p.readScope)) &&
          (!p.models.length || allowed.every((m) => p.models.includes(m))),
      );
      if (covered) return covered;
    }
    if (state.staff.some((p) => p.id === id)) fail("Staff id already in use, including history: " + id);
    const row = {
      id,
      supervisorId: parentId,
      responsibility,
      scope,
      readScope,
      models: allowed,
      status: "active",
      retained: false,
      canDelegate: false,
      handoff: {},
      source: automatic ? "automatic" : "user",
    };
    if (automatic) Object.assign(row, { need: input.need, reason: input.reason });
    state.staff.push(row);
    return row;
  }
  const row = position(state, id);
  if (manager && row.supervisorId !== actor && !(id === actor && action === "handoff"))
    fail("Not a direct report: " + id);
  if (row.status === "retired") fail("Position retired; its history is read-only.");
  if (action === "handoff") {
    handoff(row, input);
    return row;
  }
  if (action === "finish") {
    if (row.status !== "draining") fail("Start a transfer or retirement before finishing.");
    const held = assignments(state).filter((a) => a.staffId === id && a.status !== "disposed");
    if (held.length) fail("Unresolved assignments: " + held.map((a) => a.dispatchId).join(", "));
    const reports = state.staff.filter((p) => p.supervisorId === id && p.status !== "retired");
    if (reports.length)
      fail("Transfer or retire remaining direct reports: " + reports.map((p) => p.id).join(", "));
    if (row.transition.action === "transfer") {
      row.models = transferModels(state, row, row.transition.supervisorId);
      row.supervisorId = row.transition.supervisorId;
      row.status = "active";
    } else row.status = "retired";
    (row.transitions ??= []).push({
      ...row.transition,
      handoff: { ...row.handoff },
    });
    delete row.transition;
    return row;
  }
  if (!active(row) && !["transfer", "retire"].includes(action)) fail("Position is draining: " + id);
  if (action === "promote") {
    if (manager || row.supervisorId !== "root") fail("Only root can promote a direct report.");
    row.subgoal = requireText(input.subgoal, "independently verifiable subgoal");
    row.models = models(input.models, null);
    if (!row.models.length) fail("Promotion requires a nonempty allowed roster.");
    row.canDelegate = true;
  } else if (action === "retain") {
    if (
      new Set(
        assignments(state)
          .filter(
            (a) =>
              a.staffId === id &&
              a.status === "disposed" &&
              a.outcome !== "not_sent" &&
              (a.requestId || a.candidate || a.calls?.some((c) => c.sent)),
          )
          .map((a) => a.taskId),
      ).size < 2
    )
      fail("Retention needs completed responsibility across at least two project tasks.");
    row.retentionReason = requireText(input.reason, "handover cost");
    row.retained = true;
  } else {
    const reason = requireText(input.reason, "handover reason");
    const dest = action === "transfer" ? requireText(input.supervisorId, "new supervisorId") : undefined;
    if (dest === id) fail("A position cannot supervise itself.");
    if (dest && manager && dest !== actor) fail("Root decides cross-group transfers.");
    if (dest) transferModels(state, row, dest);
    handoff(row, input);
    row.transition = {
      action,
      reason,
      from: row.supervisorId,
      ...(dest ? { supervisorId: dest } : {}),
    };
    row.status = "draining";
  }
  return row;
}

function authorizedPosition(state, { staffId, actor, model }) {
  const row = position(state, staffId);
  if (!active(row) || row.supervisorId !== actor)
    fail("Position unavailable or outside this supervisor's authority: " + staffId);
  const parent = supervisor(state, actor);
  if ((row.models.length && !row.models.includes(model)) || (parent && !parent.models.includes(model)))
    fail("Model is outside the allowed roster: " + model);
  return row;
}
// Only host-owned project steps and bounded role grants determine work identity.
function taskStep(state, taskId) {
  return state.steps?.find((step) => step.attempts?.some((a) => a.taskId === taskId));
}
function worksOf(step) {
  const planned = step?.works ?? (step?.deliverables ?? step?.scope ?? []).map((path) => ({
    id: step.id + ":" + path, scope: [path],
  }));
  return [...planned, ...(step?.subworks ?? [])];
}
const overlap = (a, b) => a.some((path) => inScope(path, b)) || b.some((path) => inScope(path, a));
const canonical = (paths) => [...new Set(paths ?? [])].sort();
function registerSubwork(state, taskId, actor, input) {
  const step = taskStep(state, taskId);
  if (state.paused || state.status === "paused" || !step || step.attempts.at(-1)?.taskId !== taskId)
    fail("Registration needs a current project step.");
  const manager = supervisor(state, actor);
  const scope = canonical(scopeList(input.scope, manager?.scope ?? step.scope, "subwork scope"));
  if (!scope.length) fail("Subwork needs a nonempty, bounded delivery scope.");
  scopeList(scope, step.scope, "step scope");
  const boundary = scope.filter((p) => !scope.some((other) => other !== p && inScope(p, [other])));
  const historical = [
    ...state.steps.flatMap((s) => [...(s.scope ?? []), ...worksOf(s).flatMap((w) => w.scope)]),
    ...state.staff.flatMap((p) => [...(p.scope ?? []), ...(p.readScope ?? [])]),
    ...assignments(state).flatMap((a) => [...(a.scope ?? []), ...(a.readScope ?? [])]),
  ];
  assertProjectPathSpellings([...historical, ...boundary]);
  const matches = worksOf(step).filter((w) => projectScopesOverlap(w.scope, boundary));
  const exact = matches.find((w) => JSON.stringify(canonical(w.scope)) === JSON.stringify(boundary));
  if (exact) return exact;
  if (matches.some((w) => !boundary.every((p) => inScope(p, w.scope)) || w.effect || w.independentReview || w.parentWorkId) ||
      matches.length > 1 || step.independentReview)
    fail("Subwork must be disjoint from siblings and preserve the original frozen checks and effects.");
  if (assignments(state).some((a) => a.outcome !== "not_sent" && !a.readOnly && projectScopesOverlap(a.scope ?? [], boundary)) ||
    (state.rootWorkClaims ?? []).some((c) => projectScopesOverlap(c.scope, boundary)))
    fail("This boundary already belongs to a claimed work.");
  const hash = createHash("sha256").update(JSON.stringify(boundary)).digest("hex");
  const work = {id: step.id + ":sub:" + hash, scope: boundary,
    ...(matches[0] ? {parentWorkId: matches[0].id} : {})};
  if (worksOf(step).some((w) => w.id === work.id)) fail("Registered work ID collision.");
  (step.subworks ??= []).push(work);
  return work;
}
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
    return {workId: JSON.stringify(["coordinate", step.id, canonical(row.scope)])};
  if (named && !input.readOnly && !matches.includes(named))
    fail("Select the registered subwork for that delivery boundary.");
  if (!work || (!input.readOnly && (!area.length || !area.every((path) => inScope(path, work.scope)))))
    fail("Select a registered work ID and a write scope within that work. Available: " +
      works.map((w) => w.id).join(", "));
  if (input.readOnly)
    return {workId: JSON.stringify(["inspect", step.id, work.id]), targetWorkId: work.id};
  return {workId: work.id, ...(work.effect ? {effect: work.effect} : {})};
}
function actorAssignment(state, taskId, actorRole) {
  const a = assignments(state).find((a) => a.taskId === taskId && a.role === actorRole);
  if (!a || a.status !== "active") fail("No live project assignment for " + actorRole);
  const row = authorizedPosition(state, a);
  if (a.grantEpoch !== undefined && a.grantEpoch !== (row.transitions?.length ?? 0))
    fail("The original assignment grant has been handed off.");
  return a;
}
function verifyActor(state, input) {
  if (input.actorRole === undefined && !state.steps?.length) return;
  if (input.actorRole === "main" && input.actor === "root") return;
  const parent = actorAssignment(state, input.taskId, input.actorRole);
  if (input.actor !== parent.staffId || input.supervisorMemberId !== parent.dispatchId)
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
function sameMaterials(a, b) {
  return ["staffId", "actor", "actorRole", "supervisorMemberId", "model", "identity", "assignment", "implementationAdvice",
    "readOnly", "reviewOf", "reviewKind"].every((key) => (a[key] ?? null) === (b[key] ?? null)) &&
    ["scope", "readScope", "dependsOn"].every((key) => JSON.stringify(canonical(a[key])) === JSON.stringify(canonical(b[key])));
}
function admitAssignment(state, input, previous) {
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
  const held = assignments(state).find((a) => a !== previous && a.status !== "disposed" && collision(state, a, input));
  if (held) {
    if (held.actor === input.actor && (!input.actorRole || held.actorRole === input.actorRole))
      fail("Work or position held by " + held.dispatchId + ". Handle its original request/draft first.");
    fail("Work or position held by another authorized session.");
  }
  if (!input.readOnly && (state.rootWorkClaims ?? []).some((c) => !c.abandoned &&
      taskStep(state, c.taskId)?.id === taskStep(state, taskId)?.id &&
      (c.workId === input.workId || projectScopesOverlap(c.scope, input.scope ?? []))))
    fail("Root already owns this work.");
  assertProjectReview(state, input);
}
function beginStaffAssignment(state, input) {
  state.staffAssignments ??= {};
  const row = authorizedPosition(state, input);
  verifyActor(state, input);
  const epoch = row.transitions?.length ?? 0;
  input = {...input, ...selectWork(state, input, row), grantEpoch: epoch};
  const prior = assignments(state).findLast((a) =>
    input.workId && priorWork(state, a) === input.workId && a.outcome !== "not_sent");
  if (prior) {
    if (state.status === "paused" || state.paused) fail("Project is paused.");
    if (sameMaterials(prior, input) && (prior.grantEpoch ?? 0) === epoch)
      return {...prior, reused: true};
    if (!completedHandoff(state, prior)) fail("This work already has an assignment. Use its original owner and materials or resolve the handoff.");
  }
  admitAssignment(state, input);
  const dispatchId = input.dispatchId ?? randomUUID();
  if (Object.hasOwn(state.staffAssignments, dispatchId) || Object.hasOwn(Object.prototype, dispatchId))
    fail("Dispatch id already exists or is invalid.");
  const role = "member:" + dispatchId;
  if (input.role && input.role !== role) fail("Role does not match the bound dispatch.");
  const a = { ...input, dispatchId, role, status: "active" };
  state.staffAssignments[a.dispatchId] = a;
  return a;
}
function completedHandoff(state, a) {
  return a.status === "disposed" && a.outcome === "abandoned" &&
    (position(state, a.staffId).transitions?.length ?? 0) > (a.grantEpoch ?? 0);
}
function recordRootAbandonment(state, {taskId, changeId, requestId, reason}) {
  if (!requestId) fail("Root handoff requires its original abandonment receipt.");
  for (const claim of state.rootWorkClaims ?? []) {
    if (claim.taskId === taskId && claim.changeId === changeId && !claim.abandoned)
      claim.abandoned = {requestId, reason};
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
function resumeAssignment(state, input) {
  const prev = state.staffAssignments?.[input.dispatchId];
  if (!prev || !["result", "disposed"].includes(prev.status))
    fail("Feedback requires a known, settled result.");
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
  admitAssignment(state, next, prev);
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
    recordRootAbandonment(state, {taskId: record.id, changeId: op.changeId, requestId: op.requestId});
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
      unresolved.size ||
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

export function createProjectStaff(host) {
  const change = (action, input, actor = "root", automatic = false) =>
    host.update((state) => changeProjectStaff(state, action, input, actor, automatic));
  return {
    list: () => host.read().staff ?? [],
    rootReview: (ref, task, v, scope) => readReviewCandidate(host, ref, task, v, scope),
    reviewCandidate: (ref, task, v, scope, actorRole) => readReviewCandidate(host, ref, task, v, scope, actorRole),
    completeReview: (member, task, v) => completeProjectReview(host,member,task,v),
    assignment: (id) => host.read().staffAssignments?.[id],
    change,
    abandonedRoot: (detail) => host.update((state) => recordRootAbandonment(state, detail)),
    begin: (input) => host.update((state) => beginStaffAssignment(state, input)),
    resume: (input) => host.update((state) => resumeAssignment(state, input)),
    update: (id, patch) => host.update((state) => updateStaffAssignment(state, id, patch)),
    reconcile: (record, requests, facts) =>
      host.update((state) => reconcileAssignments(state, record, requests, facts)),
    works(taskId, actorRole = "main") {
      const state = host.read();
      const works = worksOf(taskStep(state, taskId));
      if (actorRole === "main") return works;
      const a = actorAssignment(state, taskId, actorRole);
      const row = supervisor(state, a.staffId);
      return works.filter((w) => w.scope.every((path) => inScope(path, row.scope)));
    },
    checkOwner({taskId, actorRole, dispatchId, rootReview = false}) {
      const state = host.read();
      if (state.paused || state.status === "paused") fail("Project is paused.");
      const a = state.staffAssignments?.[dispatchId];
      if (!a || a.taskId !== taskId) fail("Assignment unavailable to this session.");
      const row = authorizedPosition(state, a);
      if (!active(row) || row.supervisorId !== a.actor ||
        (a.grantEpoch ?? 0) !== (row.transitions?.length ?? 0))
        fail("Assignment authority has changed.");
      if (actorRole === "main" && (rootReview || a.actor === "root")) return true;
      if (actorRole === "main") fail("Only the direct supervisor controls this assignment.");
      const parent = actorAssignment(state, taskId, actorRole);
      if (a.supervisorMemberId !== parent.dispatchId || a.actor !== parent.staffId)
        fail("Only the direct supervisor controls this assignment.");
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
        a.status !== "disposed" && a !== current && collision(state, a, current));
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
          fail("Root edit must select a registered work boundary.");
        for (const w of selected) {
          const target = {taskId, role, workId: w.id, scope: w.scope};
          const owner = assignments(state).find((a) => a.outcome !== "not_sent" && !a.readOnly && !completedHandoff(state, a) &&
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
    tools(actor = "root", admit = () => {}, taskId) {
      return [
        {
          name: "project_staff",
          label: "Project staff",
          description:
            "Manage persistent project positions, separate from a Team model. List existing positions first. Appoint only for an independent deliverable, independent review, or configured capability gap. Never add credentials or capacity. register_work {scope} returns a stable work ID for a bounded subitem of this step. Supply an input object, e.g. appoint {id,responsibility,scope,readScope,models,need,reason}; promote {id,subgoal,models}; retain {id,reason}; handoff {id,decision,pending,failure,version}; transfer {id,supervisorId,reason} or retire {id,reason}, then finish {id} once unresolved work is settled.",
          parameters: Type.Object({
            action: Type.Union([...actions, "register_work"].map((a) => Type.Literal(a))),
            input: Type.Optional(
              Type.Object({
                id: Type.Optional(Type.String()),
                responsibility: Type.Optional(Type.String()),
                supervisorId: Type.Optional(Type.String()),
                scope: Type.Optional(Type.Array(Type.String())),
                readScope: Type.Optional(Type.Array(Type.String())),
                models: Type.Optional(Type.Array(Type.String())),
                need: Type.Optional(Type.String()),
                reason: Type.Optional(Type.String()),
                subgoal: Type.Optional(Type.String()),
                decision: Type.Optional(Type.String()),
                pending: Type.Optional(Type.String()),
                failure: Type.Optional(Type.String()),
                version: Type.Optional(Type.String()),
              }),
            ),
          }),
          async execute(_id, { action, input }) {
            admit({staffControl:{action,input:input??{}}});
            const result = action === "register_work"
              ? host.update((state) => registerSubwork(state, taskId, actor, input ?? {}))
              : action === "list"
                ? host
                    .read()
                    .staff.filter((p) => actor === "root" || p.id === actor || p.supervisorId === actor)
                : change(action, input ?? {}, actor, true);
            return {
              content: [{ type: "text", text: JSON.stringify(result) }],
            };
          },
        },
      ];
    },
  };
}
