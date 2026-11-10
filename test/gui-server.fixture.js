import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "./helpers/pi-fixture.js";
import { saveConfig } from "../src/config.js";
import { createTeamConfig } from "../src/teams.js";
import { GUI_INPUT_VERSION } from "../src/gui-turn-options.js";

export const module = await import("../src/gui-server.js").catch(() => ({}));

export async function host(t, configured = false, handler) {
  assert.equal(typeof module.startGuiServer, "function", "GUI HTTP host must exist");
  const f = await fixture(t, handler);
  if (configured) saveConfig(f.home, createTeamConfig({ formatVersion: 2, ...f.models }, "Fixture", "7c8094cd-3476-4bfa-8f53-055d87972896"));
  const assets = join(f.home, "assets");
  mkdirSync(assets);
  writeFileSync(join(assets, "index.html"), "<!doctype html><title>fixture GUI</title><script src='/app.js'></script>");
  writeFileSync(join(assets, "app.js"), "document.title='local asset'");
  const h = await module.startGuiServer({ home: f.home, cwd: f.cwd, open: false, assetDirectory: assets });
  t.after(() => h.close());
  const origin = new URL(h.url).origin;
  const headers = { Authorization: `Bearer ${h.token}` };
  const action = async (action, args = {}) => {
    const r = await fetch(origin + "/api/action", { method: "POST", headers: { ...headers, "Content-Type": "application/json", "X-CoThink-GUI-Input":GUI_INPUT_VERSION, Origin: origin }, body: JSON.stringify({ action, args }) });
    assert.equal(r.status, 200, await r.clone().text());
    return r.json();
  };
  const get=async path=>{
    const r=await fetch(origin+path,{headers});
    assert.equal(r.status,200,await r.clone().text());
    return r.json();
  };
  return { ...f, h, origin, headers, action, get, assets };
}
export function http(origin, path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = request(origin + path, options, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.end(options.body);
  });
}
export async function completed(f, id) {
  for (let n = 0; n < 500; n++) {
    const r = await fetch(`${f.origin}/api/task?id=${id}`, { headers: f.headers });
    const task = await r.json();
    if (task.status !== "running") return task;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("fixture task did not settle");
}
