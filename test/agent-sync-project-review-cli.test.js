import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { repository } from "./helpers/git-fixture.js";
import { fixture } from "./helpers/pi-fixture.js";
import { invoke } from "./helpers/cli-fixture.js";
import { execution } from "./helpers/agent-sync-fixture.js";
import { saveConfig } from "../src/config.js";
import { readTask, readRequests } from "../src/task.js";

const product = "answer.json";
const owner = "gpt-4o";
const reviewer = "claude-sonnet-4-5";
const secondReviewer = "deepseek-flash";
const modelProviders = {[owner]:"test-openai", [reviewer]:"test-anthropic", [secondReviewer]:"test-deepseek"};
const providerOrigins = {[owner]:"https://api.openai.com", [reviewer]:"https://api.anthropic.com", [secondReviewer]:"https://api.deepseek.com"};
const preload = fileURLToPath(new URL("./helpers/project-review-transport.mjs", import.meta.url));
const positionModel = model => modelProviders[model] + "/" + model;
const counterexample = "Passing the parsed object to Number() yields NaN for this candidate.";
const tool = (name, args = {}) => ({ toolCalls: [{ name, args }] });
function lastTool(body) {
  const text = body.messages.findLast(message => message.role === "tool")?.content;
  try { return JSON.parse(text); } catch { return text; }
}

for (const scenario of ["pass", "missing", "stale", "denied", "counterexample", "localhost", "laterRevert", "posthoc"]) {
  test(`project CLI with required independent review: ${scenario}`, async t => {
    const repo = repository(t);
    const goal = "Create answer.json containing a numeric answer of 42 and independently review it.";
    let next = "begin", candidate, replacementCandidate, dispatchId, denial, reviewerGrant, reviewedArtifact;
    const trace = [];
    const appoint = (id, model) => tool("project_staff", {action:"appoint", input:{id, need:"review",
      responsibility:"Independently review the exact numeric result", reason:"Its author cannot certify independence.",
      scope:[], readScope:[product], models:[positionModel(model)]}});
    const delegate = (id, model) => tool("delegate", {staffId:id, model:positionModel(model),
      assignment:"Review the exact prepared result", reason:"Inspect the field type in the candidate",
      readOnly:true, scope:[], readScope:[product], reviewOf:candidate.reviewOf});
    const f = await fixture(t, ({body}) => {
      const names = body.tools.map(entry => entry.function.name);
      const last = lastTool(body);
      const isRoot = names.includes("accept_change");
      trace.push([body.model, isRoot ? next : "employee", last?.error?.message]);
      if (!isRoot) {
        const material = body.messages.findLast(message => message.role === "user").content;
        if (JSON.stringify(material).includes("Independent task preparation")) {
          const prepared=JSON.parse(typeof material==='string'?material:material.map(p=>p.text??'').join('\n'));
          assert.match(prepared.instruction,/Preparation only/);
          assert.equal(prepared.assignment,undefined);assert.equal(prepared.implementationAdvice,undefined);
          return {text:"Check the original requirement against the frozen candidate."};
        }
        const text = typeof material === "string" ? material : material.map(p => p.text ?? "").join("\n");
        const context = JSON.parse(text);
        assert.match(context.instruction,/complete independent review/);
        assert.equal(context.assignment.text,'Review the exact candidate against the original task.');
        assert.equal(context.implementationAdvice.text,'','independent review never receives leader advice');
        assert.ok(body.messages.some(m=>m.role==='assistant'&&JSON.stringify(m.content).includes('Check the original requirement against the frozen candidate.')),'formal review reuses same-session preparation');
        reviewerGrant = names;
        reviewedArtifact = context.execution.reviewArtifact;
        if (scenario === "counterexample" && body.model === reviewer)
          return {text:JSON.stringify({verdict:"reject", observation:counterexample})};
        if (scenario === "missing") return {text:"It looks good to me."};
        return {text:JSON.stringify({verdict:"pass", observation:'The candidate adds answer.json with the numeric field "answer":42.'})};
      }
      if (next === "posthocAppoint") {
        next = "review";
        return appoint("qa",reviewer);
      }
      if (scenario === "laterRevert" && next === "end") {
        next = "readRevision";
        return {text:"First reviewed version is ready."};
      }
      if (["readRevision","readRevert"].includes(next)) {
        next = next === "readRevision" ? "editRevision" : "editRevert";
        return tool("read",{path:product});
      }
      if (["editRevision","editRevert"].includes(next)) {
        const revision = next === "editRevision";
        next = revision ? "acceptRevision" : "acceptRevert";
        const initial = '{"answer":42}', altered = '{"answer":42,"revision":2}';
        return tool("edit",{path:product, edits:[{oldText:revision ? initial : altered,newText:revision ? altered : initial}]});
      }
      if (["acceptRevision","acceptRevert"].includes(next)) {
        next = next === "acceptRevision" ? "finishRevision" : "finishRevert";
        return tool("accept_change");
      }
      if (next === "finishRevision") {
        next = "readRevert";
        return {text:"Revised version is ready."};
      }
      switch (next) {
        case "begin":
          next = "write";
          return tool("next_change", {reason:"Create the requested numeric result", scope:[product]});
        case "write":
          next = "prepare";
          return tool("write", {path:product, content:'{"answer":42}\n'});
        case "prepare":
          next = "appoint";
          return tool("prepare_change");
        case "appoint":
          candidate = last;
          if (scenario === "posthoc") {
            next = "end";
            return tool("accept_change");
          }
          next = "review";
          return appoint("qa", scenario === "denied" ? owner : reviewer);
        case "review":
          next = "collect";
          return delegate("qa", scenario === "denied" ? owner : reviewer);
        case "collect":
          dispatchId = last?.memberId;
          if (!dispatchId) {
            denial = last;
            next = "end";
            return tool("accept_change");
          }
          next = {stale:"modify", counterexample:"secondReviewer", posthoc:"posthocComplete"}[scenario] ?? "accept";
          return tool("collect", {memberId:dispatchId});
        case "secondReviewer":
          next = "secondReview";
          return appoint("secondQA", secondReviewer);
        case "secondReview":
          next = "secondCollect";
          return delegate("secondQA", secondReviewer);
        case "secondCollect":
          next = "accept";
          return tool("collect", {memberId:last.memberId});
        case "modify":
          next = "edit";
          return tool("read", {path:product});
        case "edit":
          next = "prepareAgain";
          return tool("edit", {path:product, edits:[{oldText:'{"answer":42}', newText:'{"answer":42,"revision":2}'}]});
        case "prepareAgain":
          next = "accept";
          return tool("prepare_change");
        case "accept":
          if (scenario === "stale") replacementCandidate = last;
          next = "end";
          return tool("accept_change");
        default: return {text:"The numeric result is ready."};
      }
    });
    const catalogFile = join(f.home, "pi", "models.json");
    const catalog = JSON.parse(readFileSync(catalogFile, "utf8"));
    const provider = catalog.providers.fixture;
    const origins = {...providerOrigins};
    if (scenario === "localhost") origins[reviewer] = new URL(f.endpoint).origin;
    catalog.providers = Object.fromEntries([owner, reviewer, secondReviewer].map(id => [
      modelProviders[id], {...provider, baseUrl:origins[id]+"/v1", models:[{...provider.models[0], id, name:id}]},
    ]));
    writeFileSync(join(f.home, "review-fixture-url"), f.endpoint);
    f.nodeArgs = ["--import", preload];
    writeFileSync(catalogFile, JSON.stringify(catalog));
    saveConfig(f.home, {formatVersion:2, main:{provider:modelProviders[owner],modelId:owner},
      secondary:[reviewer, secondReviewer].map(modelId => ({provider:modelProviders[modelId],modelId})), work:{execution}});
    const planFile = join(f.home, "review-plan.json");
    const checks = [{command:"node", args:["-e",`require('node:assert/strict').equal(require('./${product}').answer,42)`]}];
    const plan = scenario === "laterRevert" ? {scope:[product],goal:"Create, revise, and restore the numeric result.",
      steps:[
        {id:"initial",goal,deliverables:[product],independentReview:true,checks},
        {id:"revised",goal:"Add revision metadata",dependsOn:["initial"],deliverables:[product],checks},
        {id:"restored",goal:"Restore the reviewed bytes",dependsOn:["revised"],deliverables:[product],checks},
      ]} : {goal,scope:[product],deliverables:[product],independentReview:true,checks};
    writeFileSync(planFile,JSON.stringify(plan));
    let run = await invoke(f, ["project","start","--file",planFile,"--json"], "", repo.project);
    assert.ok(run.stdout, run.stderr);
    if (scenario === "posthoc") {
      const first = JSON.parse(run.stdout);
      assert.equal(first.status,"blocked");
      assert.match(first.steps[0].error,/独立评审未完成/);
      assert.equal(first.steps[0].attempts[0].check.status,"passed");
      next = "posthocAppoint";
      const revision = await invoke(f,["project","revise","--step","main","--goal",
        "Review the earlier accepted numeric result without rewriting the file.","--json"],"",repo.project);
      assert.equal(revision.code,0,revision.stderr);
      run = await invoke(f,["project","resume","--json"],"",repo.project);
    }
    const state = JSON.parse(run.stdout), step = state.steps[0], attempt = step.attempts.at(-1);
    const task = readTask(f.home, attempt.taskId);
    assert.ok(f.calls.length);
    for (const {body,headers} of f.calls) {
      assert.equal(headers.host, new URL(f.endpoint).host);
      assert.equal(headers["x-review-fixture-requested-url"], origins[body.model]+"/v1/chat/completions");
    }
    const evidence = JSON.stringify({trace, denial, error:task.error, blocker:state.blocker, stepError:step.error});
    assert.ok(candidate?.reviewOf, evidence);
    assert.deepEqual(candidate.diff.files, [product]);
    assert.equal(step.works[0].independentReview, true);
    assert.equal(attempt.check?.verification, "passed", evidence);
    if (scenario !== "laterRevert") assert.equal(attempt.check.version, state.version, evidence);
    const assignments = Object.values(state.staffAssignments ?? {});
    if (scenario === "denied") {
      assert.match(denial?.error?.message ?? "", /participat|independent|author|model/i, evidence);
      assert.equal(dispatchId, undefined);
      assert.equal(task.members.length, 0, evidence);
    } else {
      assert.ok(dispatchId, evidence);
      assert.ok(reviewedArtifact, evidence);
      assert.equal(reviewedArtifact.version, candidate.candidateVersion);
      assert.match(JSON.stringify(reviewedArtifact.diff), /answer.*42/);
      assert.ok(["edit", "write", "accept_change", "delegate"].every(name => !reviewerGrant.includes(name)));
      const assigned = assignments.find(row => row.dispatchId === dispatchId);
      assert.ok(assigned, evidence);
      const receipts = assigned.reviewReceipts ?? [];
      if (scenario === "missing") {
        assert.ok(receipts.every(receipt => receipt.verdict !== "pass"), evidence);
      } else {
        const receipt = receipts.find(receipt => receipt.verdict === (scenario === "counterexample" ? "reject" : "pass"));
        assert.ok(receipt, evidence);
        const call = readRequests(f.home, task).find(call => call.id === receipt.requestId);
        assert.ok(call?.sent && call.status === "completed", evidence);
        assert.equal(call.role, "member:" + dispatchId);
        const preparedCall=readRequests(f.home,task).find(r=>r.role===call.role&&r.phase==='worker-prepare');
        assert.ok(preparedCall?.status==='completed');
        assert.equal(preparedCall.projectSend.sessionId,call.projectSend.sessionId,'same reviewer session preserves preparation');
        assert.equal(call.transport.requestOrigin, origins[reviewer]);
        assert.equal(call.transport.responseOrigin, origins[reviewer]);
        assert.equal(receipt.candidateVersion, reviewedArtifact.version);
        assert.equal(receipt.certified, scenario !== "localhost", evidence);
        assert.equal(receipt.observedIdentity, scenario === "localhost" ? null : reviewer);
        if (scenario === "counterexample") {
          assert.equal(receipt.observation, counterexample);
          const second = assignments.find(row => row.staffId === "secondQA")?.reviewReceipts?.[0];
          assert.ok(second?.certified && second.verdict === "pass", evidence);
          assert.equal(second.candidateVersion, receipt.candidateVersion);
          assert.notEqual(second.requestId, receipt.requestId);
          assert.equal(second.observedIdentity, secondReviewer);
          assert.ok(step.error.includes(counterexample), evidence);
        }
        if (scenario === "pass") {
          assert.ok(state.delivery?.reviewReceipts.some(r => r.requestId === receipt.requestId), evidence);
        }
      }
    }
    if (scenario === "pass") {
      assert.equal(run.code, 0, evidence);
      assert.equal(state.status, "completed");
      assert.equal(state.delivery.version, state.version);
      const acceptance = task.work.acceptance.find(row => row.status === "accepted");
      assert.equal(acceptance?.acceptedVersion, state.version, evidence);
      assert.equal(JSON.parse(readFileSync(join(attempt.resultWorkspace,product),"utf8")).answer,42);
    } else if (scenario === "posthoc") {
      assert.equal(run.code,0,evidence);
      assert.equal(step.attempts.length,2,evidence);
      assert.equal(state.status,"completed",evidence);
      assert.equal(state.version,step.attempts[0].version,evidence);
      assert.equal(task.work.acceptance.length,0,"review-only revision must not create new product bytes");
      assert.ok(state.delivery.reviewReceipts.some(r => r.taskId === step.attempts[0].taskId &&
        r.reviewTaskId === attempt.taskId && r.certified && r.candidateVersion === candidate.candidateVersion),evidence);
    } else if (scenario === "laterRevert") {
      assert.notEqual(run.code,0,evidence);
      assert.equal(state.delivery,undefined);
      assert.ok(state.steps.every(row => row.status === "completed"), evidence);
      const versions = state.steps.map(row => row.attempts[0].check.version);
      assert.equal(new Set(versions).size,3,evidence);
      assert.equal(versions[2], state.version);
      assert.equal(state.steps[2].attempts[0].artifacts[0].sha256,attempt.artifacts[0].sha256);
      assert.match(state.blocker,/independent review is stale/i,evidence);
    } else {
      assert.notEqual(run.code, 0, evidence);
      assert.notEqual(state.status, "completed", evidence);
      assert.equal(state.delivery, undefined, evidence);
      assert.match(step.error, /独立评审未完成|independent review|未处理的评审反例/i, evidence);
      if (scenario === "stale") {
        const edit = task.tools.find(entry => entry.name === "edit");
        assert.equal(edit?.status, "completed", evidence);
        assert.ok(replacementCandidate?.candidateVersion, evidence);
        assert.notEqual(replacementCandidate.candidateVersion, candidate.candidateVersion);
        assert.equal(JSON.parse(readFileSync(join(attempt.resultWorkspace,product),"utf8")).revision,2);
      }
    }
  });
}
