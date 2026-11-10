import { createHash } from "node:crypto";
import { inScope } from "./versioning.js";
import { problem, readRequests, readTask } from "./task.js";
import { workModelIdentity } from "./workers.js";

const reject = (message) => {
  throw problem("REVIEW_SOURCE", message);
};
const canonical = (id) => (typeof id === "string" && id ? workModelIdentity({ modelId: id }) : null);
const allAssignments = (state) => Object.values(state.staffAssignments ?? {});

// The request model alone is only a routing selector. Require the provider's own
// response and an identifiable direct route. Opaque aliases remain diagnostic.
const directModelFamilies = {
  "api.openai.com":
    /^(?:gpt-(?:4o|[4-6](?:\.\d+)?)(?:-(?:mini|nano|turbo|pro|sol|astra|luna|terra|codex))?|o[134](?:-(?:mini|pro))?)$/,
  "api.anthropic.com": /^claude-(?:opus|sonnet|haiku)-\d(?:-\d)?$/,
  "api.deepseek.com": /^deepseek-v\d(?:\.\d+)?-(?:flash|pro)(?:-1017)?$/,
  "api.moonshot.cn": /^kimi-k\d(?:\.\d+)?(?:-pro)?$/,
  "api.moonshot.ai": /^kimi-k\d(?:\.\d+)?(?:-pro)?$/,
};
export function reviewFamily(id) {
  if (typeof id !== "string" || !id) return null;
  // A datestamped snapshot and its floating selector can resolve to one model.
  return canonical(id)
    .replace(/-(?:20\d\d-\d\d-\d\d|20\d{6})$/, "")
    .replace(/^(claude-(?:opus|sonnet|haiku)-\d)\.(\d)$/, "$1-$2")
    .replace(/^(gpt-\d)\.0(?=-|$)/, "$1");
}
export function observedIdentity(call) {
  let url;
  try {
    url = new URL(call.actualModel?.baseUrl);
  } catch {
    return null;
  }
  const family = reviewFamily(call.actualModel?.modelId);
  if (
    !family ||
    url.protocol !== "https:" ||
    url.port ||
    !Object.hasOwn(directModelFamilies, url.hostname) ||
    !directModelFamilies[url.hostname].test(family)
  )
    return null;
  if (call.transport?.requestOrigin !== url.origin || call.transport?.responseOrigin !== url.origin)
    return null;
  const reported = new Set(
    (call.events ?? [])
      .flatMap((e) => [e?.model, e?.message?.model, e?.response?.model])
      .filter(Boolean)
      .map(reviewFamily),
  );
  return reported.size === 1 && reported.has(family) ? family : null;
}

function candidateOwners(state, source) {
  const assignments = allAssignments(state);
  const owners = new Map();
  const visited = new Set();
  let complete = true;
  function add(taskId, role, staffId, identity) {
    owners.set(taskId + "/" + role, { taskId, role, staffId, identity });
  }
  function walk(a) {
    if (!a || visited.has(a.dispatchId)) return;
    visited.add(a.dispatchId);
    add(a.taskId, a.role, a.staffId, a.identity);
    if (a.actor === "root") {
      add(a.taskId, "main", "root", a.rootIdentity);
      return;
    }
    const parents = assignments.filter(
      (p) =>
        p.taskId === a.taskId &&
        p.staffId === a.actor &&
        (!a.supervisorMemberId || p.dispatchId === a.supervisorMemberId),
    );
    if (parents.length !== 1) complete = false;
    for (const p of parents) walk(p);
  }
  const workIds = new Set(source.workIds ?? []);
  if (source.workId) workIds.add(source.workId);
  for (const a of assignments) {
    if (a.dispatchId === source.reference || (workIds.has(a.workId) && !a.readOnly)) walk(a);
  }
  if (source.actor === "root" && !source.staffId) add(source.taskId, "main", "root", source.identity);
  for (const claim of state.rootWorkClaims ?? []) {
    if (workIds.has(claim.workId)) add(claim.taskId, "main", "root", claim.identity);
  }
  return { owners: [...owners.values()], complete, workIds: [...workIds] };
}

// Always inspect the original task plus kernel receipts; a mutable dispatch ID
// is never itself proof of a candidate. A second prepare may wrap the same draft.
export async function readReviewCandidate(host, reference, task, v, readScope, actorRole = "main") {
  const state = host.read();
  if (actorRole !== "main") {
    const manager = allAssignments(state).find((a) => a.taskId === task.record.id && a.role === actorRole);
    const source = state.staffAssignments?.[reference];
    if (
      !manager ||
      manager.status !== "active" ||
      source?.taskId !== task.record.id ||
      (source.dispatchId !== manager.dispatchId && source.supervisorMemberId !== manager.dispatchId)
    )
      reject("Review source outside this supervisor's assignment.");
  }
  let taskId, changeId, candidate, actor, author;
  if (reference.startsWith("root:")) {
    const match = /^root:([a-f0-9-]{36}):([a-f0-9-]{36}):([a-f0-9]{40}|[a-f0-9]{64})$/.exec(reference);
    if (!match) reject("Copy the exact root reviewOf reference returned by prepare_change.");
    [, taskId, changeId, candidate] = match;
    actor = "main";
  } else {
    author = state.staffAssignments?.[reference];
    if (!author || !["disposed", "result"].includes(author.status) || !author.candidate || !author.changeId)
      reject("The source has no settled, prepared employee candidate.");
    ({ taskId, changeId, candidate, role: actor } = author);
  }
  const recordFor = (id) => (id === task.record.id ? task.record : readTask(host.home, id));
  if (!state.steps.some((step) => step.attempts.some((a) => a.taskId === taskId)))
    reject("The source task is not an attempt of this project.");
  const record = recordFor(taskId);
  if (
    record.project?.id !== state.id ||
    record.work?.root !== state.repo ||
    !record.work.changes.some((c) => c.changeId === changeId && c.actor === actor) ||
    (author &&
      !record.members?.some(
        (m) =>
          m.memberId === author.dispatchId && m.changeId === changeId && m.candidateVersion === candidate,
      ))
  )
    reject("The project task did not own this candidate.");
  const change = await v.inspect({ changeId });
  const fixed = change.candidates?.find(
    (c) =>
      c.candidateVersion === candidate &&
      c.privateVersion === change.privateVersion &&
      c.basisRevision === change.basisRevision,
  );
  if (
    change.actor !== actor ||
    !fixed ||
    !["prepared", "accepted"].includes(change.status) ||
    (change.status === "prepared" && change.basisStatus !== "current")
  )
    reject("The named version is not this change's fixed, current candidate.");
  const diff = await v.inspect({ fromVersion: change.baseVersion, toVersion: candidate });
  if (!diff.files.length || diff.files.some((p) => !inScope(p, readScope)))
    reject("The reviewer's read scope must cover the entire candidate diff.");
  const source = {
    reference,
    taskId,
    changeId,
    candidate,
    baseVersion: change.baseVersion,
    privateVersion: fixed.privateVersion,
    basisRevision: fixed.basisRevision,
    tree: fixed.tree,
    files: diff.files,
    actor: author?.actor ?? "root",
    staffId: author?.staffId,
    identity: author?.identity ?? canonical(record.models.main?.modelId),
    workIds: author?.workId
      ? [author.workId]
      : (state.rootWorkClaims ?? [])
          .filter((c) => c.taskId === taskId && c.changeId === changeId)
          .map((c) => c.workId),
  };
  const chain = candidateOwners(state, source);
  const callsByTask = new Map();
  for (const p of chain.owners) {
    if (!callsByTask.has(p.taskId)) {
      callsByTask.set(
        p.taskId,
        p.taskId === task.record.id ? task.requests() : readRequests(host.home, recordFor(p.taskId)),
      );
    }
    const calls = callsByTask.get(p.taskId).filter((c) => c.sent && c.role === p.role);
    const ids = [...new Set(calls.map(observedIdentity))];
    p.identities = [
      ...new Set([p.identity, ...calls.map((c) => canonical(c.actualModel?.modelId))].filter(Boolean)),
    ];
    p.verifiedIdentity = ids.length === 1 ? ids[0] : null;
    if (!p.verifiedIdentity || !p.identities.every((id) => reviewFamily(id) === p.verifiedIdentity))
      chain.complete = false;
  }
  source.participants = chain.owners;
  source.completeChain = chain.complete && chain.owners.length > 0 && chain.workIds.length > 0;
  const artifact = {
    source: "Untrusted artifact under review",
    baseVersion: change.baseVersion,
    version: candidate,
    diff,
  };
  source.artifactHash = artifactHash(artifact);
  return { source, artifact };
}

export function assertProjectReview(state, input) {
  const fail = (message) => {
    throw problem("PROJECT_STAFF", message);
  };
  if (!input.reviewOf) {
    if (input.reviewKind) fail("reviewKind needs an actual reviewOf candidate.");
    return;
  }
  const strict = (input.reviewKind ?? "independent") === "independent";
  if (!strict && input.reviewKind !== "ordinary") fail("Unknown review kind.");
  const source = input.reviewSource ?? state.staffAssignments?.[input.reviewOf];
  if (
    !source?.candidate ||
    (source.reference ? source.reference !== input.reviewOf : !["disposed", "result"].includes(source.status))
  )
    fail("Review needs a prepared product version.");
  if (!input.readOnly || input.scope?.length || source.staffId === input.staffId)
    fail("Reviewer participated or has write authority.");
  if (!strict) return;
  const participants =
    source.participants ?? candidateOwners(state, { ...source, reference: input.reviewOf }).owners;
  if (
    reviewFamily(source.identity) === reviewFamily(input.identity) ||
    participants.some(
      (p) =>
        p.staffId === input.staffId ||
        (p.identities ?? [p.identity]).some((id) => reviewFamily(id) === reviewFamily(input.identity)) ||
        (state.callIntents ?? []).some(
          (c) =>
            !c.notSent &&
            c.taskId === p.taskId &&
            c.role === p.role &&
            reviewFamily(c.identity) === reviewFamily(input.identity),
        ),
    )
  )
    fail("Reviewer participated in this candidate's implementation or decisions.");
}

function artifactHash(artifact) {
  return createHash("sha256").update(JSON.stringify(artifact)).digest("hex");
}
function receivedArtifact(call, source) {
  const messages = call.payload?.messages ?? call.payload?.input ?? [];
  if (!Array.isArray(messages)) return false;
  return messages.some((message) => {
    if (message.role !== "user") return false;
    const parts =
      typeof message.content === "string"
        ? [message.content]
        : Array.isArray(message.content)
          ? message.content.map((part) => part.text)
          : [];
    return parts.some((text) => {
      if (typeof text !== "string" || !text.includes(source.candidate)) return false;
      let material;
      try {
        material = JSON.parse(text);
      } catch {
        return false;
      }
      const artifact = material?.execution?.reviewArtifact;
      return (
        material.source === "CoThink host-provided member material; not a new user message" &&
        material.execution?.reviewInstruction &&
        artifact?.version === source.candidate &&
        artifactHash(artifact) === source.artifactHash
      );
    });
  });
}

export async function completeProjectReview(host, member, task, v) {
  const a = host.read().staffAssignments?.[member.memberId];
  const source = a?.reviewSource;
  if (
    !source ||
    !a.readOnly ||
    a.scope?.length ||
    !member.readOnly ||
    member.status !== "completed" ||
    a.taskId !== task.record.id ||
    a.role !== "member:" + member.memberId ||
    member.reviewVersion !== source.candidate
  )
    reject("Review is not a completed read-only session on the bound candidate.");
  const calls = task.requests();
  const call = calls.find(
    (c) =>
      c.id === member.callId &&
      c.taskId === a.taskId &&
      c.role === a.role &&
      ["worker", "worker-feedback"].includes(c.phase) &&
      c.status === "completed" &&
      c.sent &&
      c.response?.stopReason === "stop",
  );
  if (
    !call ||
    !receivedArtifact(call, source) ||
    call.actualModel?.provider + "/" + call.actualModel?.modelId !== a.model
  )
    reject("Missing completed candidate-bound reviewer request.");
  let verdict;
  try {
    verdict = JSON.parse(call.text);
  } catch {
    return;
  }
  if (
    !["pass", "uncertain", "reject"].includes(verdict?.verdict) ||
    typeof verdict.observation !== "string" ||
    !verdict.observation.trim()
  )
    return;
  const observed = observedIdentity(call);
  const kind = a.reviewKind ?? "independent";
  const certified =
    kind === "independent" &&
    !!observed &&
    source.completeChain &&
    source.participants.every(
      (p) => p.verifiedIdentity && p.verifiedIdentity !== observed && p.staffId !== a.staffId,
    );
  const receipt = {
    requestId: call.id,
    reviewTaskId: a.taskId,
    reviewer: a.staffId,
    dispatchId: a.dispatchId,
    model: a.model,
    observedIdentity: observed,
    kind,
    label:
      kind === "ordinary"
        ? reviewFamily(source.identity) === reviewFamily(a.identity)
          ? "同型号复查"
          : "普通复查"
        : "独立评审",
    certified: !!certified,
    verdict: verdict.verdict,
    observation: verdict.observation,
    taskId: source.taskId,
    changeId: source.changeId,
    candidateVersion: source.candidate,
    privateVersion: source.privateVersion,
    tree: source.tree,
    basisRevision: source.basisRevision,
    evidenceKey: "candidate:" + source.changeId + ":" + source.privateVersion + ":" + source.basisRevision,
  };
  const objection = verdict.counterexample;
  if (
    verdict.verdict === "reject" &&
    objection?.kind === "missing_text" &&
    typeof objection.text === "string" &&
    objection.text.trim() &&
    source.files.includes(objection.path)
  ) {
    receipt.counterexample = { kind: "missing_text", path: objection.path, text: objection.text };
  }
  const refuted = allAssignments(host.read())
    .flatMap((p) => p.reviewReceipts ?? [])
    .find(
      (r) => r.requestId === verdict.refutesRequestId && sameCandidate(r, receipt) && r.verdict === "reject",
    );
  // A model cannot clear a behavioral counterexample with an unrelated true
  // quotation. The only same-version refutation supported here is an exact,
  // checkable absence claim disproved by bytes read from that same file.
  if (
    refuted?.counterexample?.kind === "missing_text" &&
    verdict.verdict === "pass" &&
    verdict.evidence?.path === refuted.counterexample.path &&
    verdict.evidence?.quote === refuted.counterexample.text &&
    inScope(verdict.evidence.path, a.readScope)
  ) {
    const file = await v.read({ version: source.candidate, path: verdict.evidence.path });
    if (
      file.contentBase64 &&
      Buffer.from(file.contentBase64, "base64").toString("utf8").includes(verdict.evidence.quote)
    ) {
      receipt.refutesRequestId = refuted.requestId;
      receipt.fileEvidence = {
        path: verdict.evidence.path,
        quote: verdict.evidence.quote,
        hash: file.contentHash,
      };
    }
  }
  host.update((state) => {
    const live = state.staffAssignments[a.dispatchId];
    if (
      !live ||
      live.status !== "active" ||
      live.reviewSource?.candidate !== source.candidate ||
      !state.callIntents?.some(
        (c) => c.id === call.id && !c.notSent && c.taskId === a.taskId && c.role === a.role,
      )
    )
      reject("The review assignment no longer owns the completed request.");
    const receipts = (live.reviewReceipts ??= []);
    if (!receipts.some((r) => r.requestId === receipt.requestId)) receipts.push(receipt);
  });
  return receipt;
}

function sameCandidate(r, f) {
  return (
    r.changeId === f.changeId &&
    r.taskId === f.taskId &&
    (r.candidateVersion === f.candidateVersion ||
      (r.privateVersion &&
        r.privateVersion === f.privateVersion &&
        r.tree &&
        r.tree === f.tree &&
        r.basisRevision != null &&
        r.basisRevision === f.basisRevision))
  );
}

export function assertProjectWorkReviewed(
  state,
  {
    work,
    step,
    acceptedFacts = [],
    required = work?.independentReview === true || step?.independentReview === true,
  },
) {
  if (required && !acceptedFacts.length) reject("独立评审未完成：缺少可核验的已接纳候选。");
  const results = [];
  const reviews = allAssignments(state).flatMap((a) => a.reviewReceipts ?? []);
  for (const fact of acceptedFacts) {
    const receipts = reviews.filter((r) => sameCandidate(r, fact));
    const pending = receipts.find(
      (r) =>
        r.verdict === "reject" &&
        !receipts.some(
          (response) =>
            response.verdict === "pass" && response.refutesRequestId === r.requestId && response.fileEvidence,
        ),
    );
    if (pending) reject("未处理的评审反例 " + pending.requestId + "：" + pending.observation);
    if (required && !receipts.some((r) => r.certified && r.verdict === "pass" && r.kind === "independent"))
      reject("独立评审未完成：当前候选缺少异型号、只读且已完成的通过回执。");
    results.push(...receipts);
  }
  return results;
}
