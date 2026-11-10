import { inScope, validProjectPath } from "./versioning.js";
import { problem } from "./task.js";

export const fail = (message) => {
  throw problem("PROJECT_STAFF", message);
};
export const active = (position) => position?.status === "active";
export const assignments = (state) => Object.values(state.staffAssignments ?? {});
export const position = (state, id) => state.staff.find((p) => p.id === id) ?? fail("Unknown project position: " + id);
export const requireText = (value, name) => {
  if (typeof value !== "string" || !value.trim()) fail(name + " is required.");
  return value.trim();
};
export function scopeList(value, bound, name) {
  if (!Array.isArray(value)) fail(name + " must be a list of repository paths.");
  for (const path of value) {
    if (!validProjectPath(path, true) || !inScope(path, bound))
      fail(name + " exceeds authority: " + path);
  }
  return [...new Set(value)];
}
function models(value, chain, allowedModels) {
  if (
    !Array.isArray(value) ||
    value.some((m) => typeof m !== "string" || !m.trim() ||
      chain.some((lead) => !lead.models.includes(m)) || (allowedModels && !allowedModels.includes(m)))
  )
    fail("Model is outside the supervisor's allowed roster.");
  return [...new Set(value)];
}
export function ancestry(state, id) {
  const chain = [], seen = new Set();
  while (id !== "root") {
    if (seen.has(id)) fail("Staff hierarchy contains a cycle.");
    seen.add(id);
    const row = position(state, id);
    chain.push(row);
    id = row.supervisorId;
  }
  return chain;
}
function attemptFor(state, taskId) {
  return taskStep(state, taskId)?.attempts.find((attempt) => attempt.taskId === taskId);
}
function depthSource(state, taskId) {
  const attempt = attemptFor(state, taskId);
  if (!attempt?.rootTaskId) return attempt;
  return state.steps.flatMap((step) => step.attempts ?? []).find((other) =>
    other.rootTaskId === attempt.rootTaskId && other.staffMaxDepth !== undefined) ?? attempt;
}
export function maxDepth(state, taskId) {
  return depthSource(state, taskId)?.staffMaxDepth ?? 3;
}
export function supervisors(state, id, taskId) {
  const chain = ancestry(state, id);
  if (chain.some((lead) => !active(lead) || !lead.canDelegate))
    fail("Not an active subgoal supervisor: " + id);
  if (chain.length + 1 >= maxDepth(state, taskId))
    fail("The last staff layer cannot supervise.");
  return chain;
}
function subtree(state, row) {
  const rows = new Map([[row.id, 0]]);
  for (const child of state.staff) {
    if (child.id === row.id || child.status === "retired") continue;
    const distance = ancestry(state, child.id).indexOf(row);
    if (distance > 0) rows.set(child.id, distance);
  }
  return rows;
}
function setDepth(state, actor, taskId, requested) {
  if (actor !== "root") fail("Only root can select the staff depth.");
  const source = depthSource(state, taskId);
  if (!source || !Number.isInteger(requested) || requested < 1 || requested > 4)
    fail("Select a staff depth from one to four for the current task.");
  if (requested < maxDepth(state, taskId) && assignments(state).some((a) =>
    a.status !== "disposed" &&
    (source.rootTaskId ? attemptFor(state, a.taskId)?.rootTaskId === source.rootTaskId : a.taskId === taskId) &&
    ancestry(state, a.staffId).length + 1 > requested))
    fail("Settle unresolved assignments before reducing the staff depth.");
  source.staffMaxDepth = requested;
  return {maxDepth:requested};
}
function handoff(row, input) {
  for (const key of ["version", "failure", "pending", "decision"]) {
    if (input[key] !== undefined) row.handoff[key] = requireText(input[key], key);
  }
}
export const actions = ["list", "appoint", "promote", "retain", "handoff", "transfer", "retire", "finish"];
function transferModels(state, row, target, taskId, rows) {
  const ancestors = ancestry(state, target);
  if (ancestors.some((lead) => lead.id === row.id)) fail("Transfer would create a staff cycle.");
  const chain = supervisors(state, target, taskId), next = chain[0];
  if (chain.length + 2 + Math.max(...rows.values()) > maxDepth(state, taskId))
    fail("Transfer would exceed the selected staff depth.");
  scopeList(row.scope, next?.scope ?? state.scope, "scope");
  scopeList(row.readScope, next?.readScope ?? state.readScope ?? ["."], "readScope");
  const allowed = models(row.models.length || !next ? row.models : next.models, chain);
  for (const childId of rows.keys())
    if (childId !== row.id) models(position(state, childId).models, chain);
  return allowed;
}

export function changeProjectStaff(state, action, input = {}, actor = "root", automatic = false,
  {taskId, allowedModels} = {}) {
  state.staff ??= [];
  if (action === "list") return state.staff;
  if (state.paused || state.status === "paused") fail("Project is paused.");
  if (action === "set_depth") return setDepth(state, actor, taskId, input.maxDepth);
  if (!actions.includes(action)) fail("Unknown staff action: " + action);
  const manager = actor === "root" ? null : supervisors(state, actor, taskId)[0];
  const id = requireText(input.id, "Staff id");
  if (id === "root" || !/^[\p{L}\p{N}][\p{L}\p{N}_.-]*$/u.test(id) || Object.hasOwn(Object.prototype, id))
    fail("Invalid staff id.");
  if (action === "appoint") {
    const parentId = input.supervisorId ?? actor;
    if ((manager || automatic && state.entryPolicy === "unified") && actor !== parentId)
      fail("Subgoal staffing is limited to direct reports.");
    const chain = supervisors(state, parentId, taskId), parent = chain[0];
    const scope = scopeList(input.scope ?? parent?.scope ?? state.scope, parent?.scope ?? state.scope, "scope");
    const readScope = scopeList(
      input.readScope ?? parent?.readScope ?? state.readScope ?? ["."],
      parent?.readScope ?? state.readScope ?? ["."],
      "readScope",
    );
    const allowed = models(input.models ?? parent?.models ?? [], chain, allowedModels);
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
    const rows = subtree(state, row);
    const held = assignments(state).filter((a) =>
      (a.staffId === id || row.transition.action === "transfer" && rows.has(a.staffId)) && a.status !== "disposed");
    if (held.length) fail("Unresolved assignments: " + held.map((a) => a.dispatchId).join(", "));
    const reports = state.staff.filter((p) => p.supervisorId === id && p.status !== "retired");
    if (reports.length && row.transition.action === "retire")
      fail("Transfer or retire remaining direct reports: " + reports.map((p) => p.id).join(", "));
    if (row.transition.action === "transfer") {
      row.models = transferModels(state, row, row.transition.supervisorId, taskId, rows);
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
    if (row.supervisorId !== actor) fail("Only the direct supervisor can promote a report.");
    const chain = ancestry(state, actor);
    if (chain.length + 2 >= maxDepth(state, taskId)) fail("Cannot promote a report in the last staff layer.");
    const subgoal = requireText(input.subgoal, "independently verifiable subgoal");
    const allowed = models(input.models, chain, allowedModels);
    if (!allowed.length) fail("Promotion requires a nonempty allowed roster.");
    Object.assign(row, {subgoal, models:allowed, canDelegate:true});
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
    if (dest) {
      const rows = subtree(state, row);
      transferModels(state, row, dest, taskId, rows);
      if (assignments(state).some((a) => a.staffId !== id && rows.has(a.staffId) && a.status !== "disposed"))
        fail("Settle unresolved descendant assignments before transferring this group.");
    }
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
// Only host-owned project steps and bounded role grants determine work identity.
export function taskStep(state, taskId) {
  return state.steps?.find((step) => step.attempts?.some((a) => a.taskId === taskId));
}
