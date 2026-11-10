import test from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {fixtureConversation, prepareSubmit, teamId} from "./helpers/gui-controller-fixture.js";
import { fixture } from "./helpers/pi-fixture.js";

const root = resolve(process.env.COTHINK_TEST_PACKAGE_ROOT ?? fileURLToPath(new URL("..", import.meta.url)));
const load = (path) => import(pathToFileURL(join(root, path)));
const {GUI_INPUT_VERSION}=await load("src/gui-turn-options.js");
const { startGuiServer } = await load("src/gui-server.js");
const { saveConfig } = await load("src/config.js");
const { createTeamConfig } = await load("src/teams.js");
const { readTask, readRequests } = await load("src/task.js");

async function host(t, f) {
  const h = await startGuiServer({ home: f.home, cwd: f.cwd, open: false });
  t.after(() => h.close());
  const origin = new URL(h.url).origin;
  const json = async (path, body) => {
    const r = await fetch(origin + path, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${h.token}`, ...(body ? { "Content-Type": "application/json", "X-CoThink-GUI-Input":GUI_INPUT_VERSION } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(r.status, 200, await r.clone().text());
    return r.json();
  };
  return { close: h.close, get: json, action: (action, args) => json("/api/action", { action, args }) };
}
async function settle(h, id) {
  for (let i = 0; i < 500; i++) {
    const task = await h.get("/api/task?id=" + id);
    if (task.status !== "running") return task;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("partial HTTP task did not settle");
}

const phase="draft", index=1, model="main", label="主模型答复";
for (const cap of [undefined, 77]) {
  test(`HTTP manager reply length retains text, identity and cap across reopen without replay (cap=${cap})`, async (t) => {
    const partial = "已收到的片段 😄\n".repeat(600) + "PARTIAL_END";
    const f = await fixture(t, () => ({ text: partial, finish: "length", noUsage: true }));
    const models = structuredClone(f.models);
    if (cap !== undefined) for (const ref of [models.main, ...models.secondary]) ref.maxOutputTokens = cap;
    saveConfig(f.home, createTeamConfig({ formatVersion: 2, ...models }, "Partial fixture", teamId));
    let h = await host(t, f);
    const s = await fixtureConversation(t, h);
    const args = await prepareSubmit(h,{ sessionId:s.id,input:"长回答",submissionId:"long-answer" });
    const accepted = await h.action("task.submit", args);
    const task = await settle(h, accepted.taskId);
    assert.equal(task.status, "partial");
    assert.equal(task.phase, phase);
    assert.equal(task.messages.length, index);
    const last = task.messages.at(-1);
    assert.equal(last.status, "partial");
    assert.equal(last.phase, phase);
    assert.equal(last.model.provider, "fixture");
    assert.equal(last.model.modelId, model);
    assert.equal(last.text, partial);
    assert.match(task.error, new RegExp(label));
    assert.match(task.error, new RegExp(`fixture/${model}`));
    assert.match(task.error, /length/);
    assert.match(task.error, /输出.*上下文/);
    if (cap === undefined) assert.match(task.error, /未指定.*服务商默认/);
    else assert.match(task.error, /77 tokens/);
    assert.equal(task.usage.unknownCalls, 1);
    assert.equal(task.usage.cost, null);
    const saved = readTask(f.home, task.id);
    const request = readRequests(f.home, saved).at(-1);
    assert.equal(request.phase, "draft", "the original journal phase remains readable");
    assert.equal(request.response.stopReason, "length");
    assert.equal(request.limits.maxOutputTokens, cap ?? null);
    assert.equal(request.text, partial);
    assert.equal(saved.finalCallId, null);
    assert.equal(f.calls.length, index);
    for (const call of f.calls) assert.equal(call.body.max_tokens ?? call.body.max_completion_tokens, cap);
    await h.close();
    h = await host(t, f);
    assert.deepEqual(await h.get("/api/task?id=" + task.id), task);
    assert.equal((await h.get("/api/session?id=" + s.id)).turns[0].status, "partial");
    const duplicate = await h.action("task.submit", args);
    assert.equal(duplicate.taskId, task.id);
    assert.equal(f.calls.length, index, "history and duplicate confirmation never repeat a request or continue phases");
    assert.match(task.error, /模型设置.*输出额度/, "GUI users receive an actionable settings entry");
    assert.match(task.error, /--max-output-tokens/, "CLI users retain their actionable parameter");
  });
}

test("HTTP lost provider response remains unknown after reopen and duplicate confirmation never resends", async (t) => {
  const f = await fixture(t, (_call, _n, _req, res) => { res.destroy(); return null; });
  saveConfig(f.home, createTeamConfig({ formatVersion: 2, ...f.models }, "Unknown fixture", teamId));
  let h = await host(t, f);
  const s = await fixtureConversation(t, h);
  const args = await prepareSubmit(h,{ sessionId:s.id,input:"响应丢失",submissionId:"unknown-response" });
  const accepted = await h.action("task.submit", args);
  const task = await settle(h, accepted.taskId);
  assert.equal(task.status, "outcome_unknown");
  assert.equal(task.messages.length, 1);
  assert.equal(task.messages[0].status, "outcome_unknown");
  assert.equal(task.usage.unknownCalls, 1);
  assert.equal(task.usage.cost, null);
  await h.close();
  h = await host(t, f);
  assert.equal((await h.get("/api/task?id=" + task.id)).messages[0].status, "outcome_unknown");
  assert.equal((await h.action("task.submit", args)).taskId, task.id);
  assert.equal(f.calls.length, 1);
});
