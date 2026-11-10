import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fixture } from "./helpers/pi-fixture.js";
import { fixtureConversation, prepareSubmit } from "./helpers/gui-controller-fixture.js";

// Use the distributed runtime as well as the distributed controller in installed checks.
const root = resolve(process.env.COTHINK_TEST_PACKAGE_ROOT ?? fileURLToPath(new URL("..", import.meta.url)));
export const load = (path) => import(pathToFileURL(join(root, path)));
const { startGuiServer } = await load("src/gui-server.js");
export const { saveConfig } = await load("src/config.js");
export const { createTeamConfig } = await load("src/teams.js");
export const { readTask } = await load("src/task.js");
const { createApi } = await load("gui/src/api.js");
const { GUI_INPUT_VERSION, editorTurnInput } = await load("src/gui-turn-options.js");
export { editorTurnInput };

export async function host(t, f) {
  const h = await startGuiServer({ home: f.home, cwd: f.cwd, open: false });
  t.after(() => h.close());
  const origin = new URL(h.url).origin;
  async function request(path, body) {
    return fetch(origin + path, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${h.token}`, ...(body ? { "Content-Type": "application/json", "X-CoThink-GUI-Input":GUI_INPUT_VERSION } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
  async function json(path, body) {
    const response = await request(path, body);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  }
  const reads = [];
  const api = createApi(h.token, (path, options) => { reads.push(options.method); return fetch(origin + path, options); });
  return { close: h.close, get: json, action: (action, args) => json("/api/action", { action, args }), reads, recover: api.recover, request,
    reject: async (action, args) => {
      const response = await request("/api/action", { action, args });
      assert.equal(response.status, 400, await response.clone().text());
      assert.match(await response.text(), /损坏|缺失|不可用|修复/);
    } };
}
export async function setup(t) {
  const f = await fixture(t, (_, n) => ({ text: `HISTORY_REPLY_${n}` }));
  saveConfig(f.home, createTeamConfig({ formatVersion: 2, ...f.models }, "History fixture", "7c8094cd-3476-4bfa-8f53-055d87972896"));
  return f;
}
export async function send(h, sessionId, input, submissionId = input) {
  return settle(h,await h.action("task.submit",await prepareSubmit(h,{sessionId,input,submissionId})));
}
export async function settle(h, accepted) {
  for (let i = 0; i < 500; i++) {
    const task = await h.get("/api/task?id=" + accepted.taskId);
    if (task.status !== "running") {
      assert.equal(task.status, "completed", task.error);
      return task;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("history fixture did not settle");
}
export async function newSession(t,h) {
  return (await fixtureConversation(t,h)).id;
}
