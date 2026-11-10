import { randomUUID } from "node:crypto";
import { inScope, validProjectPath, withChangeQueue } from "./versioning.js";
import { problem } from "./task.js";

export function createMemberControls({
  task,staff,work,members,save,notify,syncChange,currentRequest,receivedVersion,guardMember,
  getVersioning,getPluginWork,
}) {
  function pauseEvidence(m) {
    const role = "member:" + m.record.memberId, change = m.binding?.current;
    const roles = new Set([role, ...task.record.stages.filter((s) => s.creatorRole === role).map((s) => s.role)]);
    const requests = task.requests().filter((r) => roles.has(r.role)).map((r) => ({
      id:r.id, role:r.role, status:r.status, sent:r.sent === true,
      dispatched:r.transport?.projectDispatched === true, usage:r.usage ?? null,
      actualCost:r.actualCost ?? null, estimatedCost:r.estimatedCost ?? null,
    }));
    const operations = work.requests.filter((r) => r.requestId === m.record.beginRequestId ||
      (change?.changeId && r.changeId === change.changeId)).map((r) => ({
      id:r.requestId, action:r.action, status:r.status, dispatched:r.dispatched === true,
    }));
    const traces = task.record.tools ?? [];
    for (const trace of traces)
      if (trace.actor === role && trace.requestId && trace.kernelInput && !operations.some((r) => r.id === trace.requestId))
        operations.push({id:trace.requestId, action:trace.name, status:trace.status});
    const owned = [...(work.helpers ?? []), ...traces.filter((r) => r.nativeBackground ||
      ["employee_script_result", "project_plugin_runtime"].includes(r.kind))];
    const ownerIds = new Set([...roles, ...[...roles].filter((id) => id.startsWith("helper:")).map((id) => id.slice(7))]);
    for (const owner of ownerIds)
      for (const child of owned)
        if (child.parentActorId === owner && child.helperId) ownerIds.add(child.helperId);
    const processes = owned.filter((r) => ownerIds.has(r.parentActorId)).map((r) => ({
      id:r.helperId ?? r.resultId ?? r.sessionId, kind:r.kind ?? "helper", status:r.status,
      stoppedAt:r.stoppedAt ?? null, stopError:r.stopError ?? null,
    }));
    return {changeId:change?.changeId ?? null, privateVersion:change?.privateVersion ?? null,
      candidate:change?.candidateVersion ?? null, acceptedVersion:change?.acceptedVersion ?? null,
      requests, operations, processes};
  }
  function stopMemberRuntime(m) {
    m.stopPromise ??= Promise.allSettled([
      Promise.resolve().then(() => getPluginWork()?.stopActor?.("member:" + m.record.memberId)),
      Promise.resolve().then(() => m.runtime?.session.abort()),
    ]).then((results) => {
      const failed = results.find((r) => r.status === "rejected");
      if (failed) { m.record.stopError = failed.reason?.message ?? String(failed.reason); save(); }
      return results;
    });
    return m.stopPromise;
  }
  async function settleMemberPause(m) {
    const v=getVersioning();
    const stop = await m.stopPromise;
    await m.promise;
    const receipt = async () => {
      const facts = pauseEvidence(m);
      const unresolvedRequestIds = facts.requests
        .filter((r) => (r.sent || r.dispatched) && !["completed", "failed", "partial"].includes(r.status)).map((r) => r.id);
      for (const operation of facts.operations) {
        const original = operation.dispatched === false ? {status:"not_sent"}
          : await v.inspect({requestId:operation.id}).catch(() => ({status:"unknown"}));
        operation.status = original.status === "not_found" && operation.dispatched !== true ? "not_sent" : original.status;
        if (["unknown", "not_found", "outcome_unknown", "pending", "preparing", "in_flight"].includes(operation.status))
          unresolvedRequestIds.push(operation.id);
      }
      const stopErrors = stop.filter((r) => r.status === "rejected").map((r) => r.reason?.message ?? String(r.reason));
      if (facts.changeId) {
        const current = await v.inspect({changeId:facts.changeId}).catch((error) => {
          stopErrors.push("Original draft verification: " + error.message);
        });
        if (current) Object.assign(facts, {
          changeStatus:current.status, privateVersion:current.privateVersion,
          candidate:current.candidateVersion ?? facts.candidate, acceptedVersion:current.acceptedVersion ?? null,
        });
        if (current?.status === "outcome_unknown") stopErrors.push("Original draft status remains unknown.");
      }
      const unresolvedProcess = facts.processes.some((p) => p.stopError ||
        ["outcome_unknown", "unknown"].includes(p.status) ||
        (!p.stoppedAt && !["completed", "failed", "cancelled", "not_sent"].includes(p.status)));
      m.record.pause = staff.settlePause(m.record.memberId, {...facts, unresolvedRequestIds, stopErrors,
        status:unresolvedRequestIds.length || stopErrors.length || unresolvedProcess ? "unknown" : "settled",
        settledAt:new Date().toISOString()});
      if (m.record.pause.status === "unknown" && m.record.status !== "accepted") m.record.status = "outcome_unknown";
      save();
      notify(false);
    };
    const changeId = m.binding?.current.changeId;
    return changeId ? withChangeQueue(v, changeId, receipt) : receipt();
  }
  async function readPausedCandidate(m, {candidate, privateVersion}) {
    const change = await getVersioning().inspect({changeId:m.binding.current.changeId});
    if (change.status !== "prepared" || change.candidateVersion !== candidate || change.privateVersion !== privateVersion)
      throw problem("GROUP_RESUME", "The original candidate or draft no longer matches the supplied version.");
    if (change.basisStatus !== "current")
      throw problem("GROUP_RESUME", "The preserved candidate's input basis has changed.");
    return syncChange(change);
  }
  function requestStaffGroup(m, args) {
    guardMember(m);
    const deny = (message) => { throw problem("GROUP_REPORT", message); };
    if (m.conflictHalted || m.resolvingConflict || !m.record.understandingCallId)
      deny("Group reports require a live, prepared project assignment.");
    const requestId = currentRequest(m.binding)?.id;
    if (!requestId) deny("Group reports need an actual request from this assignment.");
    let proposal, forwardedFrom;
    if (args.forwardRequestId !== undefined) {
      if (Object.keys(args).length !== 1 || !staff.canManage(task.record.id, m.record.staffId))
        deny("Only the direct supervisor may forward the original report.");
      const child = [...members.values()].find((candidate) => candidate.record.supervisorMemberId === m.record.memberId &&
        candidate.record.staffGroupRequests?.some((report) => report.id === args.forwardRequestId));
      const original = child?.record.staffGroupRequests.find((report) => report.id === args.forwardRequestId);
      if (!original || !receivedVersion(m.binding.role, child.record.staffGroupRequestReceipt, original.id))
        deny("Collect and receive this direct report's exact request before forwarding.");
      proposal = original.proposal;
      forwardedFrom = original.id;
    } else {
      const boundary = task.record.project.scope ?? staff.works(task.record.id).flatMap((work) => work.scope);
      if (!args.blocker?.trim() || !args.scope?.length || args.scope.some((path) =>
        !validProjectPath(path, true) || !inScope(path, boundary)) ||
        !Array.isArray(args.dependsOn) || args.dependsOn.some((id) => !id.trim()) ||
        !Number.isSafeInteger(args.maxCalls) || args.maxCalls < 0)
        deny("Provide a blocker, bounded proposed scope, dependencies and proposed call count.");
      proposal = {blocker:args.blocker.trim(), scope:[...new Set(args.scope)],
        dependsOn:[...new Set(args.dependsOn)], maxCalls:args.maxCalls};
    }
    const reports = (m.record.staffGroupRequests ??= []);
    const existing = reports.find((r) => r.forwardedFrom === forwardedFrom && JSON.stringify(r.proposal) === JSON.stringify(proposal));
    if (existing) return existing;
    const report = {id:randomUUID(), dispatchId:m.record.memberId, requestId, proposal, ...(forwardedFrom ? {forwardedFrom} : {})};
    reports.push(report);
    save();
    return report;
  }
  return {pauseEvidence,stopMemberRuntime,settleMemberPause,readPausedCandidate,requestStaffGroup};
}
