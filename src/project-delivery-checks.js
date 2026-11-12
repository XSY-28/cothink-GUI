import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { legacyGit } from "./git-versioning.js";
import { createVersioning } from "./versioning.js";
import { readTask, taskDisplayStatus } from "./task.js";
import { reviewEvidence } from "./project-review-evidence.js";

export const now = () => new Date().toISOString();
export async function formal(home, repo) {
  let v;
  try {
    v = await createVersioning({
      home,
      project: repo,
      backend: "agent-sync",
      readOnly: true,
    });
    return await v.inspect();
  } catch (e) {
    if (e.code !== "NO_PROJECT") throw e;
    return {
      version: await legacyGit(repo, [
        "rev-parse",
        "--verify",
        "HEAD^{commit}",
      ]),
      integrationRef: null,
    };
  } finally {
    await v?.close();
  }
}
export async function ownedParents(v, home, state, currentRecord, currentFacts = []) {
  const parents = new Map();
  for (const step of state.steps) for (const attempt of step.attempts) {
    if (!attempt.checkPolicy) continue;
    const record = currentRecord?.id === attempt.taskId ? currentRecord : savedTask(home, attempt.taskId);
    if (!record?.work || record.submissionId !== attempt.submissionId || record.project?.id !== state.id ||
        record.project.stepId !== step.id || record.project.revision !== attempt.revision ||
        record.rootTaskId !== attempt.rootTaskId || record.project.commandId !== attempt.commandId ||
        record.work.root !== state.repo || record.work.integrationRef !== state.integrationRef ||
        record.work.startVersion !== attempt.startVersion || !isDeepStrictEqual(record.project.checkPolicy, attempt.checkPolicy)) continue;
    for (const row of record.work.acceptance ?? []) {
      if (!record.work.requests?.some(r => r.action === 'acceptChange' && r.requestId === row.requestId && r.dispatched)) continue;
      const fact = (record === currentRecord && currentFacts.find(x => x.id === row.requestId)?.fact) ||
        await v.inspect({requestId:row.requestId});
      if (fact.status === 'accepted' && fact.requestId === row.requestId && fact.changeId === row.changeId &&
          fact.candidateVersion === row.candidateVersion && fact.verification === 'passed' &&
          isDeepStrictEqual(fact.checkPolicy, attempt.checkPolicy))
        parents.set(fact.acceptedVersion, fact.expectedTip);
    }
  }
  return parents;
}
export function onOwnedLine(parents, from, to) {
  for (let i = 0; from !== to && i < parents.size; i++) from = parents.get(from);
  return from === to;
}
export async function evidence(home, state, step, record, requests, attempt) {
  const {repo} = state;
  const w = record.work;
  const evidence = {
    endedAt: now(),
    taskStatus: taskDisplayStatus(record),
    requestIds: requests.map((r) => r.id),
    usage: record.usage ?? null,
    version: w?.version ?? null,
    resultWorkspace: w?.resultWorkspace ?? null,
    artifacts: [],
  };
  if (
    requests.some((r) => r.sent && r.status === "outcome_unknown") ||
    ["stop_unknown", "cancelling"].includes(evidence.taskStatus) ||
    record.tools?.some(t=>t.kind==="project_mcp_call"&&["intent","pending","outcome_unknown"].includes(t.status)) ||
    record.tools?.some(t=>t.kind==="project_mcp_runtime"&&t.requests?.some(r=>!r.originalRequestId&&["pending","outcome_unknown"].includes(r.status))) ||
    record.work?.helpers?.some((h) => !h.stoppedAt) ||
    record.tools?.some((t) => (t.nativeBackground || t.kind === "employee_script_result" || t.kind === "project_plugin_runtime" || t.kind === "project_mcp_runtime" && t.containerId) && !t.stoppedAt)
  )
    evidence.unknown = true;
  evidence.unknownIdentities = [
    ...new Set(
      requests
        .filter((r) => r.sent && r.status === "outcome_unknown")
        .map((r) => r.actualModel?.modelId ?? r.requestedModel?.modelId)
        .filter(Boolean),
    ),
  ];
  let v;
  try {
    if (!w?.root)
      throw Error(record.error ?? "No managed file work was recorded");
    if (realpathSync(w.root) !== repo || w.backend !== "agent-sync")
      throw Error("Work did not use the authorized repository");
    v = await createVersioning({
      home,
      project: repo,
      backend: "agent-sync",
      readOnly: true,
    });
    const f = await v.inspect();
    evidence.formalVersion = f.version;
    evidence.integrationRef = f.integrationRef;
    const ids = [
      ...new Set(
        [
          ...(w.requests ?? []),
          ...(w.acceptance ?? []),
          ...(record.tools ?? []).filter((t) => t.kernelInput),
          ...(w.helpers ?? []).map((h) => h.import),
          ...(record.tools ?? []).map((t) => t.import),
        ]
          .map((x) => x?.requestId)
          .filter(Boolean),
      ),
    ];
    const facts = [];
    for (const id of ids)
      facts.push({ id, fact: await v.inspect({ requestId: id }) });
    const undispatched = new Set([
      ...(w.requests ?? []).filter(r => r.dispatched === false),
      ...(record.tools ?? []).filter(t => t.kernelInput && t.kernelDispatched === false),
    ].map(r => r.requestId));
    evidence.kernelRequests = facts.map(({ id, fact }) => ({
      requestId: id,
      status: fact.status === "not_found" && undispatched.has(id) ? "not_sent" : fact.status,
    }));
    if (
      evidence.kernelRequests.some(r =>
        ["unknown", "outcome_unknown", "pending", "not_found"].includes(r.status),
      )
    )
      evidence.unknown = true;
    // The immutable public accept receipts bind each new formal tip to its parent.
    // A check from this task alone does not authorize somebody else's intervening commit.
    const parents = attempt.checkPolicy ? await ownedParents(v, home, state, record, facts) : new Map(
      facts
        .filter(
          ({ fact }) => fact.status === "accepted" && fact.acceptedVersion,
        )
        .map(({ fact }) => [fact.acceptedVersion, fact.expectedTip]),
    );
    const checkedVersion = attempt.checkPolicy ? w.version : f.version;
    evidence.ownedLine = onOwnedLine(parents, f.version, attempt.startVersion);
    if (attempt.checkPolicy) {
      evidence.advancesProject = onOwnedLine(parents, f.version, state.version);
      evidence.acceptedVersion = [...facts].reverse().find(({fact}) => fact.status === 'accepted' &&
        isDeepStrictEqual(fact.checkPolicy, attempt.checkPolicy))?.fact.acceptedVersion ?? null;
    }
    const check = facts.find((x) => x.id === w.finalCheck?.requestId)?.fact;
    evidence.check = check ?? null;
    if (
      !evidence.ownedLine ||
      w.startVersion !== attempt.startVersion ||
      w.integrationRef !== f.integrationRef
    )
      throw Error(
        "Input version or formal ref differs from the authorized intent",
      );
    if (record.status !== "completed")
      throw Error(record.error ?? "Task did not complete");
    if (evidence.unknown)
      throw Error("Outstanding request or writer; inspect the original task");
    if (
      !check ||
      check.status !== "passed" ||
      check.verification !== "passed" ||
      check.version !== checkedVersion ||
      check.binding?.version !== checkedVersion ||
      w.version !== checkedVersion ||
      (attempt.checkPolicy && (check.binding?.policy !== attempt.checkPolicy.digest ||
        !onOwnedLine(parents, f.version, checkedVersion) ||
        !onOwnedLine(parents, checkedVersion, attempt.startVersion) ||
        (evidence.acceptedVersion && !onOwnedLine(parents, checkedVersion, evidence.acceptedVersion)))) ||
      check.checks?.length !== step.checks.length ||
      !check.checks.every(
        (c, i) =>
          c.exitCode === 0 &&
          !c.sourceChanged &&
          c.command === step.checks[i].command &&
          JSON.stringify(c.args) === JSON.stringify(step.checks[i].args ?? []),
      )
    )
      throw Error(
        "No passing fixed normal-entry check on the current formal version",
      );
    const output = await v.inspect({ changeId: w.resultChangeId });
    if (
      output.baseVersion !== checkedVersion ||
      !output.readOnly ||
      output.workspace !== w.resultWorkspace
    )
      throw Error("Result projection is not bound to the checked version");
    for (const path of step.deliverables) {
      const item = await v.read({ version: checkedVersion, path });
      if (!item.contentHash || item.version !== checkedVersion)
        throw Error("Missing deliverable at checked version: " + path);
      if (evidence.acceptedVersion && (await v.read({version:evidence.acceptedVersion,path})).contentHash !== item.contentHash)
        throw Error("Checked deliverable differs from this step's accepted version: " + path);
      evidence.artifacts.push({ path, sha256: item.contentHash });
    }
    const reviews = await reviewEvidence(v, home, state, step, checkedVersion, record, facts);
    if (reviews.length) evidence.reviewReceipts = reviews;
  } catch (e) {
    evidence.error = e.message;
  } finally {
    await v?.close();
  }
  return evidence;
}

export async function provePrevious(home, s, version, dependencyIds, deliveryReviews) {
  const needed = new Set(dependencyIds ?? s.steps.map((x) => x.id));
  for (let i = 0; i < s.steps.length && s.stepScheduling !== 'dependencies-v1'; i++)
    for (const step of s.steps)
      if (needed.has(step.id))
        for (const parent of step.dependsOn) needed.add(parent);
  const completed = s.steps.filter(
    (step) => step.status === "completed" && needed.has(step.id),
  );
  if (!completed.length) return [];
  const inputs = [];
  let v;
  try {
    v = await createVersioning({
      home,
      project: s.repo,
      backend: "agent-sync",
      readOnly: true,
    });
    for (const step of completed) {
      if (deliveryReviews && (step.works.some(work => work.independentReview) ||
          Object.values(s.staffAssignments ?? {}).some(a => a.reviewReceipts?.length))) {
        const task = readTask(home,step.attempts.at(-1).taskId);
        deliveryReviews.push(...await reviewEvidence(v,home,s,step,version,task));
      }
      for (const artifact of step.attempts.at(-1).artifacts) {
        const previous = step.attempts.at(-1);
        const original = await v.read({
          version: previous.version,
          path: artifact.path,
        });
        const actual = await v.read({ version, path: artifact.path });
        if (original.contentHash !== artifact.sha256 || !actual.contentHash ||
            (s.stepScheduling === 'dependencies-v1' && dependencyIds && actual.contentHash !== artifact.sha256))
          throw Error(
            "Missing previous deliverable or invalid receipt: " +
              step.id +
              " / " +
              artifact.path,
          );
        inputs.push({
          stepId: step.id,
          path: artifact.path,
          deliveredVersion: previous.version,
          deliveredHash: artifact.sha256,
          inputVersion: version,
          inputHash: actual.contentHash,
        });
      }
    }
    return inputs;
  } finally {
    await v?.close();
  }
}
export async function verifyDelivery(host, s, signal) {
  const f = host.kernel ? await host.kernel.inspect() : await formal(host.home, s.repo);
  if (f.version !== s.version || f.integrationRef !== s.integrationRef)
    throw Error("Formal tip changed since project acceptance");
  const reviewReceipts = [];
  const artifacts = await provePrevious(host.home, s, f.version, undefined, reviewReceipts);
  const matches = () => {
    const state = host.read();
    return (
      !signal.aborted &&
      state.status === "active" &&
      state.revision === s.revision
    );
  };
  if (!matches()) return;
  const receipts = s.steps.map((step) => step.attempts.at(-1).check);
  if (
    receipts.every(
      (r) => r?.version === f.version && r.verification === "passed",
    )
  ) {
    host.update((state) => {
      state.delivery = {
        version: f.version,
        revision: s.revision,
        artifacts,
        ...(reviewReceipts.length ? {reviewReceipts} : {}),
        requestIds: receipts.map((r) => r.requestId),
      };
    });
    return;
  }
  const checks = s.steps.flatMap((step) => step.checks);
  const execution = s.steps[0].attempts.at(-1).execution;
  if (
    !execution ||
    s.steps.some(
      (step) =>
        JSON.stringify(step.attempts.at(-1).execution) !==
        JSON.stringify(execution),
    )
  )
    throw Error(
      "Combined verification needs the same recorded fixed execution environment for all steps",
    );
  const previous = s.finalChecks?.findLast(
    (x) => x.revision === s.revision && x.version === f.version,
  );
  const reuse = previous && previous.check?.status !== "cancelled";
  const requestId = reuse ? previous.requestId : randomUUID();
  if (!reuse)
    host.update((state) => {
      (state.finalChecks ??= []).push({
        revision: s.revision,
        version: f.version,
        requestId,
        at: now(),
      });
    });
  const controller = new AbortController();
  host.finalController = controller;
  let v;
  try {
    v = host.kernel ?? await createVersioning({
      home: host.home,
      project: s.repo,
      checks,
      execution,
      signal: AbortSignal.any([signal, controller.signal]),
    });
    const authorized = await v.inspect();
    if (
      authorized.version !== f.version ||
      authorized.integrationRef !== s.integrationRef
    )
      throw Error("Formal tip moved during delivery verification");
    if (!matches() || controller.signal.aborted) return;
    let fact = await v.inspect({ requestId });
    if (fact.status === "not_found")
      fact = await v.checkCurrent({ requestId, signal: controller.signal,
        ...(host.kernel ? {checkPolicy:host.policy('project-final')} : {}) });
    host.update((state) => {
      const row = state.finalChecks.find((x) => x.requestId === requestId);
      row.check = fact;
    });
    if (!matches()) return;
    if (
      fact.version !== f.version ||
      fact.binding?.version !== f.version ||
      (host.kernel && !isDeepStrictEqual(fact.binding?.policy,host.policy('project-final').digest)) ||
      fact.status !== "passed" ||
      fact.verification !== "passed" ||
      fact.checks.length !== checks.length ||
      !fact.checks.every(
        (c, i) =>
          c.exitCode === 0 &&
          !c.sourceChanged &&
          c.command === checks[i].command &&
          JSON.stringify(c.args) === JSON.stringify(checks[i].args ?? []),
      )
    )
      throw Error(
        "Combined delivery checks did not pass at " +
          f.version +
          " (" +
          fact.status +
          ", request " +
          requestId +
          ")",
      );
    host.update((state) => {
      state.delivery = {
        version: f.version,
        revision: s.revision,
        artifacts,
        ...(reviewReceipts.length ? {reviewReceipts} : {}),
        requestIds: [requestId],
      };
    });
  } catch (e) {
    if (matches() && !controller.signal.aborted) throw e;
  } finally {
    if (!host.kernel) await v?.close();
    host.finalController = null;
  }
}
export function savedTask(home, id) {
  try {
    return readTask(home, id);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
