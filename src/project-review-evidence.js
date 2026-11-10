import { isDeepStrictEqual } from "node:util";
import { inScope } from "./versioning.js";
import { readTask } from "./task.js";
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
