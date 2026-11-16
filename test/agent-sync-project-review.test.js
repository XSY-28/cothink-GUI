import test from "node:test";
import assert from "node:assert/strict";
import {
  readReviewCandidate,
  assertProjectReview,
  completeProjectReview,
  assertProjectWorkReviewed,
} from "../src/project-review.js";

function setup() {
  const repo = "/project";
  const state = {
    id: "project",
    repo,
    steps: [{ attempts: [{ taskId: "task" }] }],
    callIntents: [],
    staffAssignments: {},
  };
  const host = { read: () => state, update: (fn) => fn(state) };
  const record = {
    id: "task",
    project: { id: state.id },
    models: { main: { modelId: "gpt-4o" } },
    members: [],
    work: { root: repo, changes: [{ changeId: "change", actor: "member:author" }] },
  };
  const calls = [];
  const task = { record, requests: () => calls };
  function call(id, role, modelId, more = {}) {
    const origin =
      "https://" +
      (modelId.startsWith("claude")
        ? "api.anthropic.com"
        : modelId.startsWith("kimi")
          ? "api.moonshot.cn"
          : modelId.startsWith("deepseek")
            ? "api.deepseek.com"
            : "api.openai.com");
    calls.push({
      id,
      taskId: "task",
      role,
      status: "completed",
      sent: true,
      response: { stopReason: "stop" },
      actualModel: { modelId, provider: "fixture", baseUrl: origin },
      transport: { requestOrigin: origin, responseOrigin: origin },
      events: [{ model: modelId }],
      ...more,
    });
    state.callIntents.push({ id, taskId: "task", role, identity: modelId });
  }
  const assign = (id, actor, modelId, more = {}) =>
    (state.staffAssignments[id] = {
      taskId: "task",
      role: "member:" + id,
      dispatchId: id,
      staffId: id,
      actor,
      identity: modelId,
      model: "fixture/" + modelId,
      status: "active",
      scope: [],
      readScope: ["."],
      ...more,
    });
  call("decision", "main", "gpt-4o");
  assign("lead", "root", "kimi-k3.1-pro");
  call("lead-call", "member:lead", "kimi-k3.1-pro");
  assign("author", "lead", "deepseek-v4.1-flash-1017", {
    supervisorMemberId: "lead",
    workId: "build",
    changeId: "change",
    candidate: "fixed",
    status: "result",
  });
  call("author-call", "member:author", "deepseek-v4.1-flash-1017");
  record.members.push({ memberId: "author", changeId: "change", candidateVersion: "fixed" });
  const fixed = { candidateVersion: "fixed", privateVersion: "draft", tree: "tree", basisRevision: 1 };
  const change = {
    changeId: "change",
    actor: "member:author",
    status: "prepared",
    basisStatus: "current",
    baseVersion: "base",
    privateVersion: "draft",
    basisRevision: 1,
    candidates: [fixed],
  };
  const v = {
    inspect: async (q) => (q.changeId ? change : { files: ["entry.js"], patch: "+correct" }),
    read: async () => ({ contentBase64: Buffer.from("correct\n").toString("base64"), contentHash: "hash" }),
  };
  const source = async () => (await readReviewCandidate(host, "author", task, v, ["entry.js"])).source;
  async function review(id, modelId, kind, body, extra = {}) {
    const { source: reviewSource, artifact } = await readReviewCandidate(host, "author", task, v, [
      "entry.js",
    ]);
    const a = assign(id, "root", modelId, {
      readOnly: true,
      reviewOf: "author",
      reviewSource,
      reviewKind: kind,
    });
    assertProjectReview(state, a);
    const requestId = id + "-call";
    call(requestId, a.role, modelId, {
      phase: "worker",
      payload: {
        messages: [
          {
            role: "user",
            content: JSON.stringify({
              source: "CoThink host-provided member material; not a new user message",
              execution: { reviewArtifact: artifact, reviewInstruction: "Give verdict" },
            }),
          },
        ],
      },
      text: JSON.stringify(body),
      ...extra,
    });
    return completeProjectReview(
      host,
      { memberId: id, callId: requestId, readOnly: true, reviewVersion: "fixed", status: "completed" },
      task,
      v,
    );
  }
  const fact = { taskId: "task", changeId: "change", ...fixed };
  const verify = (facts = [fact], required = true) =>
    assertProjectWorkReviewed(state, { acceptedFacts: facts, required });
  return { state, record, host, call, assign, source, review, verify, v, task, change, fact, calls };
}

test("review checks the original author, transferred author and deciding ancestors but not unrelated roles", async () => {
  const s = setup();
  s.assign("former", "root", "claude-opus-5-5", { status: "disposed", workId: "build" });
  s.call("former-call", "member:former", "claude-opus-5-5");
  s.assign("other", "root", "claude-sonnet-4-5", { status: "disposed", workId: "other-work" });
  s.call("other-call", "member:other", "claude-sonnet-4-5");
  for (const id of [
    "gpt-4o",
    "gpt-4o-2024-05-13",
    "kimi-k3.1-pro",
    "deepseek-v4.1-flash-1017",
    "claude-opus-5-5",
    "anthropic.claude-opus-5-5",
  ])
    await assert.rejects(
      s.review("review-" + id, id, undefined, { verdict: "pass", observation: "marker present" }),
      /participated/,
    );
  const r = await s.review("reader", "claude-sonnet-4-5", undefined, {
    verdict: "pass",
    observation: "marker present",
  });
  assert.equal(r.certified, true);
  assert.equal(s.verify()[0].requestId, "reader-call");
  await assert.rejects(readReviewCandidate(s.host, "author", s.task, s.v, ["outside"]), /entire candidate/);
  s.change.privateVersion = "updated";
  await assert.rejects(s.source(), /fixed, current/);
});

test("ordinary same-model receipts and opaque routes cannot certify an independent pass", async () => {
  for (const mode of [
    "ordinary",
    "opaque",
    "proxy",
    "localhost",
    "redirect",
    "providerMismatch",
    "noProviderEvidence",
    "missingAncestor",
  ]) {
    const s = setup();
    if (mode === "missingAncestor") delete s.state.staffAssignments.lead;
    const id =
      mode === "ordinary" ? "deepseek-v4.1-flash-1017" : mode === "opaque" ? "r2" : "claude-sonnet-4-5";
    const extra =
      mode === "proxy"
        ? { actualModel: { modelId: id, provider: "fixture", baseUrl: "https://router.example/api" } }
        : mode === "localhost"
          ? { actualModel: { modelId: id, provider: "fixture", baseUrl: "http://127.0.0.1:1234" } }
          : mode === "redirect"
            ? {
                transport: {
                  requestOrigin: "https://api.anthropic.com",
                  responseOrigin: "https://router.invalid",
                },
              }
            : mode === "providerMismatch"
              ? { events: [{ model: "gpt-4o" }] }
              : mode === "noProviderEvidence"
                ? { events: [] }
                : {};
    const r = await s.review(
      "inspector",
      id,
      mode === "ordinary" ? "ordinary" : undefined,
      { verdict: "pass", observation: "marker" },
      extra,
    );
    assert.equal(r.certified, false, mode);
    if (mode === "ordinary") assert.equal(r.label, "同型号复查");
    assert.throws(() => s.verify(), /独立评审未完成/, mode);
  }
});

test("a request must actually finish on this candidate to yield a verdict; stale and empty evidence cannot deliver", async () => {
  const s = setup();
  for (const [id, patch] of [
    ["unknown", { status: "outcome_unknown" }],
    ["unsent", { sent: false }],
    ["wrong-input", { payload: { messages: [{ role: "user", content: "fixed" }] } }],
    ["truncated", { response: { stopReason: "length" } }],
  ]) {
    await assert.rejects(
      s.review(id, "claude-sonnet-4-5", undefined, { verdict: "pass", observation: "marker" }, patch),
      /completed candidate/,
    );
  }
  await s.review("no-verdict", "claude-sonnet-4-5", undefined, { observation: "agree" });
  assert.throws(() => s.verify(), /独立评审未完成/);
  await s.review("valid", "claude-sonnet-4-5", undefined, { verdict: "pass", observation: "marker" });
  assert.equal(s.verify([{ ...s.fact, candidateVersion: "second-prepare" }]).length, 1);
  assert.throws(
    () => s.verify([{ ...s.fact, candidateVersion: "patched", privateVersion: "changed" }]),
    /独立评审未完成/,
  );
  assert.throws(() => s.verify([]), /缺少可核验/);
});

test("a second vote or a true but irrelevant file quotation cannot erase a counterexample", async () => {
  const s = setup();
  const dissent = await s.review("opponent", "claude-sonnet-4-5", undefined, {
    verdict: "reject",
    observation: "the expected literal correct is absent",
    counterexample: { kind: "missing_text", path: "entry.js", text: "correct" },
  });
  const pass = await s.review("agree", "claude-opus-5-5", undefined, {
    verdict: "pass",
    observation: "it worked",
    refutesRequestId: dissent.requestId,
    evidence: { path: "entry.js", quote: "c" },
  });
  assert.equal(pass.refutesRequestId, undefined);
  assert.equal(pass.evidenceKey, dissent.evidenceKey);
  assert.throws(() => s.verify(), /未处理的评审反例/);
  await s.review("refuter", "claude-opus-5-5", undefined, {
    verdict: "pass",
    observation: "the specified file contains exactly correct",
    refutesRequestId: dissent.requestId,
    evidence: { path: "entry.js", quote: "correct" },
  });
  assert.equal(s.verify().length, 3);
  const behavioral = await s.review("counter", "claude-sonnet-4-5", undefined, {
    verdict: "reject",
    observation: "input 0 is interpreted as an empty option",
  });
  await s.review("fourth", "claude-opus-5-5", undefined, {
    verdict: "pass",
    observation: "there is a correct marker",
    refutesRequestId: behavioral.requestId,
    evidence: { path: "entry.js", quote: "correct" },
  });
  assert.throws(() => s.verify(), /input 0/);
});

test("review read tool pages the exact candidate and refuses live tip, logs and out-of-scope paths", async () => {
  const { workspaceTools } = await import("../src/workspaces.js");
  const reads = [];
  const versioning = {
    read: async (query) => {
      reads.push(query);
      return {
        version: query.version,
        contentBase64: Buffer.from("candidate-only\n").toString("base64"),
        contentHash: "hash",
      };
    },
  };
  const task = { record: { status: "running", tools: [] }, signal: new AbortController().signal, save() {} };
  const change = {
    workspace: process.cwd(),
    changeId: "observation",
    privateVersion: "live-tip",
    readScope: ["entry.js"],
  };
  const defs = workspaceTools({
    task,
    stage: { id: "review-stage", role: "member:qa" },
    versioning,
    change,
    reviewVersion: "fixed",
    readOnly: true,
  });
  const read = defs.find((t) => t.name === "read");
  const r = await read.execute("one", { path: "entry.js" });
  assert.match(r.content[0].text, /candidate-only/);
  assert.deepEqual(reads, [{ version: "fixed", path: "entry.js" }]);
  assert.equal(task.record.tools[0].reviewVersion, "fixed");
  await assert.rejects(read.execute("two", { path: "outside.js" }), /scope/);
  await assert.rejects(read.execute("three", { path: "output:from-writer" }), /fixed candidate/);
  assert.equal(reads.length, 1);
});

test("uncertainty remains visible without vetoing a different qualified verdict", async () => {
  const s = setup();
  const unsure = { verdict: "uncertain", observation: "I am unsure about the preferred style" };
  await s.review("opinion", "deepseek-v4.1-flash-1017", "ordinary", unsure);
  await s.review("strict-opinion", "claude-opus-5-5", "independent", unsure);
  assert.equal(s.verify([s.fact], false).length, 2);
  assert.throws(() => s.verify(), /独立评审未完成/);
  await s.review("pass", "claude-sonnet-4-5", "independent", {
    verdict: "pass",
    observation: "Rendered output matches the requested input.",
  });
  assert.deepEqual(
    s.verify().map((r) => r.verdict),
    ["uncertain", "uncertain", "pass"],
  );
});

test("a floating selector and its official dated response describe one model family", async () => {
  const s = setup();
  const r = await s.review(
    "reader",
    "claude-sonnet-4-5",
    undefined,
    { verdict: "pass", observation: "marker" },
    { events: [{ model: "claude-sonnet-4-5-20250929" }] },
  );
  assert.equal(r.observedIdentity, "claude-sonnet-4-5");
  assert.equal(r.certified, true);
});

test("a subgroup may submit its own candidate for review but cannot look up a sibling candidate", async () => {
  const s = setup();
  s.assign("sibling", "root", "claude-sonnet-4-5");
  await assert.rejects(
    readReviewCandidate(s.host, "author", s.task, s.v, ["."], "member:sibling"),
    /outside this supervisor/,
  );
  assert.equal(
    (await readReviewCandidate(s.host, "author", s.task, s.v, ["."], "member:lead")).source.staffId,
    "author",
  );
});

async function retractionFixture() {
 const s=setup(),session='review-session',dispatch='same-reviewer';
 const old=await s.review(dispatch,'claude-sonnet-4-5',undefined,{verdict:'reject',observation:'A claimed reachable input state violates the contract.'},
  {projectSend:{sessionId:session,dispatchId:dispatch,workId:'review-fixed',feedback:0}});
 const prior=s.calls.find(c=>c.id===old.requestId),call=structuredClone(prior);
 Object.assign(call,{id:'explicit-retraction',phase:'worker-feedback',text:JSON.stringify({verdict:'pass',observation:'The earlier state is unreachable under the verified input gate.',retractsRequestId:old.requestId,retractionReason:'My prior behavioral objection required an unreachable input state.'})});
 call.projectSend.feedback=1;s.calls.push(call);s.state.callIntents.push({id:call.id,taskId:'task',role:call.role});
 const finish=()=>completeProjectReview(s.host,{memberId:dispatch,callId:call.id,readOnly:true,reviewVersion:'fixed',status:'completed'},s.task,s.v);
 return {...s,old,prior,call,finish};
}
test('same reviewer explicitly withdraws its own same-candidate rejection after completed feedback without deleting it',async()=>{
 const s=await retractionFixture(),before=structuredClone(s.old),r=await s.finish();
 assert.equal(r.retractsRequestId,s.old.requestId);assert.equal(r.retractionEvidence.sessionId,'review-session');
 assert.deepEqual(s.old,before);assert.equal(s.verify().length,2);
});
for(const [name,mutate]of[
 ['plain pass',s=>{const v=JSON.parse(s.call.text);delete v.retractsRequestId;s.call.text=JSON.stringify(v);}],
 ['no explicit reason',s=>{const v=JSON.parse(s.call.text);delete v.retractionReason;s.call.text=JSON.stringify(v);}],
 ['different referenced rejection',s=>{const v=JSON.parse(s.call.text);v.retractsRequestId='another-reject';s.call.text=JSON.stringify(v);}],
 ['different session',s=>s.call.projectSend.sessionId='other'],
 ['different reviewer dispatch',s=>s.call.projectSend.dispatchId='other'],
 ['different work',s=>s.call.projectSend.workId='other'],
 ['no new feedback',s=>s.call.projectSend.feedback=0],
 ['ordinary worker not feedback',s=>s.call.phase='worker'],
 ['older request order',s=>{s.calls.splice(s.calls.indexOf(s.call),1);s.calls.unshift(s.call);}],
 ['unknown old rejection',s=>s.prior.status='outcome_unknown'],
 ['unsent old rejection',s=>s.prior.sent=false],
 ['truncated old rejection',s=>s.prior.response.stopReason='length'],
 ['tampered old candidate material',s=>s.prior.payload={messages:[]}],
 ['tampered old observation',s=>s.prior.text=JSON.stringify({verdict:'reject',observation:'different'})],
 ['different exact candidate receipt',s=>s.old.candidateVersion='another'],
 ['different reviewer receipt',s=>s.old.reviewer='another'],
])test('retraction cannot clear rejection: '+name,async()=>{
 const s=await retractionFixture();mutate(s);const r=await s.finish();assert.equal(r.retractsRequestId,undefined);
 // Candidate receipt corruption cannot be used as a successful retraction either.
 if(name!=='different exact candidate receipt')assert.throws(()=>s.verify(),/未处理的评审反例/);
});
for(const [name,patch]of[['unknown',{status:'outcome_unknown'}],['unsent',{sent:false}],['length',{response:{stopReason:'length'}}],['changed model',{actualModel:{provider:'fixture',modelId:'other'}}]])test('incomplete or changed reviewer never records retraction: '+name,async()=>{
 const s=await retractionFixture();Object.assign(s.call,patch);await assert.rejects(s.finish(),/completed candidate/);assert.throws(()=>s.verify(),/未处理的评审反例/);
});
