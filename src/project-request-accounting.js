import { problem } from "./task.js";
import { readTask, readRequest, readRequests } from "./task.js";

export function validateProjectBudget(budget = {}) {
  if (
    !budget ||
    typeof budget !== "object" ||
    Array.isArray(budget) ||
    Object.keys(budget).some((k) => !["maxCalls", "maxCost"].includes(k))
  )
    throw problem("PROJECT_BUDGET", "Budget accepts maxCalls and maxCost only");
  const { maxCalls = null, maxCost = null } = budget;
  if (
    (maxCalls !== null && (!Number.isSafeInteger(maxCalls) || maxCalls < 0)) ||
    (maxCost !== null && (!Number.isFinite(maxCost) || maxCost < 0))
  )
    throw problem("PROJECT_BUDGET", "Budget limits must be non-negative numbers (whole calls) or null");
  return { maxCalls, maxCost };
}

// Called by the exclusive recovering host. The adapter never dispatches until
// the original request's sent marker was written. Keep the ID even when reclaimed.
export function reconcileProjectCalls(state, task, requests) {
  // A task intent is durable before the project claim/transport receipt. A crash
  // in that interval cannot turn an unresolved original effect into a fresh one.
  for(const trace of task.tools??[])if(trace.kind==='project_mcp_call'&&['intent','pending','outcome_unknown'].includes(trace.status)&&trace.requestId) {
    if((state.callIntents??[]).some(c=>c.id===trace.requestId))continue;
    const step=state.steps.find(s=>s.attempts.some(a=>a.taskId===task.id));
    const work=[...(step?.works??[]),...(step?.subworks??[])].find(w=>w.id===trace.workId);
    (state.callIntents??=[]).push({kind:'external',id:trace.requestId,taskId:task.id,role:trace.parentActorId,sessionId:trace.sessionId,
      server:trace.server,sourceDigest:trace.sourceDigest,workId:trace.workId,scope:trace.scope??work?.scope??step?.scope,
      tool:trace.tool,args:trace.args??null,payloadDigest:trace.payloadDigest,...(trace.effect?{effect:trace.effect}:{}),
      ...(trace.containerProofDigest?{containerProofDigest:trace.containerProofDigest}:{}),
      status:'outcome_unknown',sent:trace.sent??null,costBound:null,actualCost:null,recoveredFromTaskIntent:true});
  }
  for (const claim of (state.callIntents ?? []).filter((c) => c.kind !== "external" && c.taskId === task.id)) {
    const request = requests.find((r) => r.id === claim.id);
    if (request?.sent === false && !request.transport?.projectDispatched) claim.notSent = true;
  }
}
export function projectUsage(state, home) {
  const known = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const observed = new Set();
  let unknownCalls = 0,
    unknownTasks = 0,
    knownEstimate = 0,
    unknownEstimates = 0,
    helpers = 0;
  function addUsage(usage, estimate) {
    if (usage) for (const key of Object.keys(known)) known[key] += usage[key] ?? 0;
    else unknownCalls++;
    if (Number.isFinite(estimate)) knownEstimate += estimate;
    else unknownEstimates++;
  }
  for (const step of state.steps)
    for (const attempt of step.attempts) {
      try {
        const task = readTask(home, attempt.taskId);
        for (const call of readRequests(home, task))
          if (call.sent) {
            observed.add(call.id);
            addUsage(call.usage, call.estimatedCost);
          }
        for (const h of task.work?.helpers ?? [])
          if (h.native || h.process) {
            helpers++;
            if(!h.native?.projectManaged&&!task.stages?.some(s=>s.nativeLaunchId===h.helperId))addUsage(h.usage, h.usage?.cost);
          }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        unknownTasks++;
      }
    }
  const claims = state.callIntents ?? [];
  for (const claim of claims) {
    if (claim.phase !== "visual-review" || claim.taskId !== claim.rootTaskId || claim.notSent ||
        observed.has(claim.id)) continue;
    try {
      const call = readRequest(home, claim.taskId, claim.id);
      if (call.sent && call.transport?.projectDispatched) {
        observed.add(call.id);
        addUsage(call.usage, call.estimatedCost);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const unconfirmed = claims.filter((c) => c.kind !== "external" && !c.notSent && !observed.has(c.id)).length;
  return {
    calls: observed.size,
    externalOperations: (state.callIntents ?? []).filter(c=>c.kind==="external"&&!c.notSent).length,
    unresolvedExternal: (state.callIntents ?? []).filter(c=>c.kind==="external"&&!c.notSent&&c.status!=="completed").map(c=>c.id),
    helpers,
    known,
    unknownCalls,
    unknownTasks,
    unconfirmed,
    knownCatalogEstimate: knownEstimate,
    unknownEstimates,
    actualCost: observed.size || helpers || unconfirmed || unknownTasks || (state.callIntents??[]).some(c=>c.kind==="external"&&!c.notSent) ? null : 0,
  };
}
