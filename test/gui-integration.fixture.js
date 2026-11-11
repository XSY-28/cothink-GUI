import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

export const execution = JSON.parse(
  readFileSync(
    new URL("../packages/agent-sync/execution-manifest.json", import.meta.url),
  ),
).execution;
export const root = resolve(
  process.env.COTHINK_TEST_PACKAGE_ROOT ??
    fileURLToPath(new URL("..", import.meta.url)),
);
export const load = (p) => import(pathToFileURL(join(root, p)));
export const {GUI_INPUT_VERSION}=await load("src/gui-turn-options.js");
const { startGuiServer } = await load("src/gui-server.js");
export const tool = (name, args = {}) => ({ toolCalls: [{ name, args }] });
export async function host(t, f) {
  const h = await startGuiServer({ home: f.home, cwd: f.cwd, open: false });
  t.after(() => h.close());
  const origin = new URL(h.url).origin,
    headers = { Authorization: `Bearer ${h.token}` };
  const get = async (path) => {
    const r = await fetch(origin + path, { headers });
    assert.equal(r.status, 200, await r.clone().text());
    return r.json();
  };
  const action = async (action, args) => {
    const r = await fetch(origin + "/api/action", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", "X-CoThink-GUI-Input":GUI_INPUT_VERSION },
      body: JSON.stringify({ action, args }),
    });
    assert.equal(r.status, 200, await r.clone().text());
    return r.json();
  };
  return { h, origin, headers, get, action };
}
export async function done(h, id) {
  for (let i = 0; i < 1500; i++) {
    const r = await h.get("/api/task?id=" + id);
    if (r.status !== "running") return r;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error("fixture task did not settle");
}
export async function setup(h, f) {
  await h.action("provider.save", {
    providerId: "configured",
    apiKey: "dummy-local-key",
    custom: {
      baseUrl: f.endpoint,
      api: "openai-completions",
      modelId: "main",
      name: "main",
      contextWindow: 32000,
      maxTokens: 4096,
    },
  });
  const path=join(f.home,"pi/models.json"),catalog=JSON.parse(readFileSync(path,"utf8"));
  Object.assign(catalog.providers.configured.models[0],{reasoning:true,thinkingLevelMap:{max:"max"}});
  writeFileSync(path,JSON.stringify(catalog));
  await h.action("provider.save",{providerId:"configured",apiKey:"dummy-local-key"});
  return h.action("team.save", {
    name: "HTTP integration",
    main: { provider: "configured", modelId: "main" },
    secondary: [f.models.secondary[0]],
  });
}
export async function run(command, args, env = {}) {
  return new Promise((yes, no) => {
    const childEnv = { ...process.env, ...env };
    delete childEnv.NODE_TEST_CONTEXT;
    const p = spawn(command, args, {
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    p.stdout.on("data", (x) => (out += x));
    p.stderr.on("data", (x) => (err += x));
    p.on("error", no);
    p.on("close", (code) => yes({ code, out, err }));
  });
}
