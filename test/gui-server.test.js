import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture } from "./helpers/pi-fixture.js";
import { saveConfig } from "../src/config.js";
import { createTeamConfig } from "../src/teams.js";
import { readTask } from "../src/task.js";
import { GUI_INPUT_VERSION } from "../src/gui-turn-options.js";
import { fixtureConversation, prepareSubmit } from "./helpers/gui-controller-fixture.js";
import { completed, host, http, module } from "./gui-server.fixture.js";

test("input protocol 4 rejects old writes and new submissions but keeps history and prior receipts readable", async t => {
  const f = await host(t, true), s = await fixtureConversation(t, f);
  assert.equal(GUI_INPUT_VERSION, "4");
  assert.equal((await f.get("/api/bootstrap")).protocol.guiInput, 4);
  const args = await prepareSubmit(f, {sessionId:s.id, input:"accepted", submissionId:"protocol-4"});
  const accepted = await f.action("task.submit", args);
  await completed(f, accepted.taskId);
  const legacy = (action, args) => fetch(f.origin+"/api/action", {method:"POST", headers:{...f.headers,"Content-Type":"application/json","X-CoThink-GUI-Input":"3"}, body:JSON.stringify({action,args})});
  for (const [name, input] of [["session.thinking",{sessionId:s.id,level:"off",scope:"all"}], ["task.submit",{...args,submissionId:"new-old-page"}]]) {
    const rejected = await legacy(name,input);
    assert.equal(rejected.status,409);
    assert.equal((await rejected.json()).code,"GUI_INPUT_UPGRADE");
  }
  const receipt = await legacy("task.submit",args);
  assert.equal(receipt.status,200);
  assert.equal((await receipt.json()).taskId,accepted.taskId);
  assert.equal((await f.get("/api/session?id="+s.id)).turns.length,1);
  assert.equal(f.calls.length,1);
});

test("all API reads, events and writes require Bearer, exact Host and same Origin", async (t) => {
  const f = await host(t);
  assert.equal(f.h.server.address().address, "127.0.0.1");
  assert.equal(new URL(f.h.url).search, "");
  assert.equal(new URLSearchParams(new URL(f.h.url).hash.slice(1)).get("token"), f.h.token);
  for (const path of ["bootstrap", "sessions", "session?id=x", "task?id=x", "diff?id=x", "patch?id=x", "output?id=x&ref=x", "events"]) {
    assert.equal((await fetch(f.origin + "/api/" + path)).status, 403, path);
    assert.equal((await fetch(f.origin + "/api/" + path, { headers: { Authorization: "Bearer wrong" } })).status, 403, path);
  }
  assert.equal((await fetch(f.origin + "/api/action", { method: "POST", body: "{}", headers: { "Content-Type": "application/json", "X-CoThink-GUI-Input":GUI_INPUT_VERSION } })).status, 403);
  for (const path of ["/", "/api/bootstrap", "/api/events", "/api/action"]) {
    assert.equal((await http(f.origin, path, { headers: { ...f.headers, Host: "evil.test" } })).status, 403);
    assert.equal((await http(f.origin, path, { headers: { ...f.headers, Origin: "http://evil.test" } })).status, 403);
  }
  assert.equal((await http(f.origin, "/api/bootstrap", { headers: { ...f.headers, Host: `localhost:${f.h.server.address().port}` } })).status, 403);
  assert.equal((await fetch(f.origin + "/api/bootstrap", { headers: { ...f.headers, Origin: "null" } })).status, 403);
  const bootstrap = await fetch(f.origin + "/api/bootstrap", { headers: { ...f.headers, Origin: f.origin } });
  assert.equal(bootstrap.status, 200);
  assert.equal((await bootstrap.json()).configured, false);
  assert.equal(f.calls.length, 0);
});

test("actions accept bounded JSON only and reject unknown routes, actions and invalid parameters", async (t) => {
  const f = await host(t);
  const post = (body, type = "application/json") => fetch(f.origin + "/api/action", { method: "POST", headers: { ...f.headers, "Content-Type": type }, body });
  assert.equal((await post('{}', "text/plain")).status, 415);
  assert.equal((await post('{')).status, 400);
  assert.equal((await post('null')).status, 400);
  assert.equal((await post('{"action":"close","args":{}}')).status, 400);
  assert.equal((await post('{"action":"session.create","args":[]}')).status, 400);
  assert.equal((await post('{"action":"session.create","args":{},"token":"bad"}')).status, 400);
  assert.equal((await post(JSON.stringify({ action: "session.draft", args: { text: "x".repeat(1024 * 1024) } }))).status, 413);
  assert.equal((await fetch(f.origin + "/api/missing", { headers: f.headers })).status, 404);
  assert.equal((await fetch(f.origin + "/api/bootstrap", { method: "POST", headers: f.headers })).status, 405);
  for (const path of ["/api/task", "/api/task?id=a&id=b", "/api/output?id=a&ref=x&offset=-1", "/api/output?id=a&ref=x&limit=0", "/api/task?id=x&token=secret"]) {
    assert.equal((await fetch(f.origin + path, { headers: f.headers })).status, 400, path);
  }
  assert.equal(f.calls.length, 0);
});

test("static assets enforce realpath containment, security headers and missing-build guidance", async (t) => {
  const f = await host(t);
  writeFileSync(join(f.home, "outside.txt"), "PRIVATE_OUTSIDE_CANARY");
  symlinkSync(join(f.home, "outside.txt"), join(f.assets, "leak.txt"));
  symlinkSync(f.home, join(f.assets, "escape"), "dir");
  for (const path of ["/leak.txt", "/escape/outside.txt", "/%2e%2e%2foutside.txt", "/%2e%2e%5coutside.txt", "/%00", "/%zz"]) {
    const r = await http(f.origin, path);
    assert.ok([400, 403, 404].includes(r.status), path);
    assert.doesNotMatch(r.text, /PRIVATE_OUTSIDE_CANARY/);
  }
  const r = await fetch(f.origin);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("Content-Security-Policy"), /script-src 'self'/);
  assert.match(r.headers.get("Content-Security-Policy"), /object-src 'none'/);
  assert.equal(r.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(r.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(r.headers.get("Cache-Control"), "no-store");
  assert.doesNotMatch(await r.text(), new RegExp(f.h.token));
  assert.equal((await fetch(f.origin + "/app.js")).headers.get("Content-Type"), "text/javascript; charset=utf-8");
  assert.equal((await fetch(f.origin + "/missing.js")).status, 404);
  const missing = await module.startGuiServer({ home: f.home, cwd: f.cwd, open: false, assetDirectory: join(f.home, "not-built") });
  t.after(() => missing.close());
  const unavailable = await fetch(new URL(missing.url).origin);
  assert.equal(unavailable.status, 503);
  assert.match(await unavailable.text(), /build:gui/);
});

test("HTTP actions share durable tasks; refresh and event reconnection never resubmit or leak credentials", async (t) => {
  const f = await host(t, true, (_, n) => ({ text: `answer ${n} fixture-secret fixtureKey` }));
  await f.action("provider.save", { providerId: "localhttp", apiKey: "fixtureKey", custom: { baseUrl: f.endpoint, api: "openai-completions", modelId: "configured", name: "Configured", contextWindow: 32000, maxTokens: 4096 } });
  const s = await fixtureConversation(t,f);
  const args=await prepareSubmit(f,{sessionId:s.id,input:"question",submissionId:"durable"});
  const submitted = await f.action("task.submit",args);
  const done = await completed(f, submitted.taskId);
  assert.equal(done.status, "completed", done.error);
  assert.equal(f.calls.length, 1);
  for (const path of ["/api/bootstrap", `/api/session?id=${s.id}`, `/api/task?id=${submitted.taskId}`]) {
    const r = await fetch(f.origin + path, { headers: f.headers });
    assert.equal(r.status, 200);
    assert.doesNotMatch(await r.text(), /fixture-secret|fixtureKey/);
  }
  const duplicate = await f.action("task.submit",args);
  assert.equal(duplicate.taskId, submitted.taskId);
  const streams = await Promise.all([1, 2].map(async () => {
    const abort = new AbortController();
    const r = await fetch(f.origin + "/api/events", { headers: f.headers, signal: abort.signal });
    assert.equal(r.headers.get("Content-Type"), "text/event-stream; charset=utf-8");
    const reader = r.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /event: invalidate\ndata: \{\}/);
    return { abort, reader };
  }));
  await f.action("session.name", { sessionId: s.id, title: "Fixture conversation" });
  for (const stream of streams) {
    assert.match(new TextDecoder().decode((await stream.reader.read()).value), /event: invalidate/);
    stream.abort.abort();
  }
  const reconnect = new AbortController();
  const r = await fetch(f.origin + "/api/events", { headers: f.headers, signal: reconnect.signal });
  await r.body.getReader().read();
  reconnect.abort();
  assert.equal(f.calls.length, 1);
  assert.equal((await (await fetch(f.origin + `/api/task?id=${submitted.taskId}`, { headers: f.headers })).json()).id, submitted.taskId);
  await f.h.close();
  await f.h.close();
});

test("closing HTTP host cancels an active real controller task and closes event connections", async (t) => {
  const f = await host(t, true, async () => { await new Promise((r) => setTimeout(r, 400)); return { text: "slow" }; });
  const s = await fixtureConversation(t,f);
  const task = await f.action("task.submit",await prepareSubmit(f,{sessionId:s.id,input:"slow",submissionId:"cancel"}));
  const events = await fetch(f.origin + "/api/events", { headers: f.headers });
  const reader = events.body.getReader();
  await reader.read();
  await f.h.close();
  // Two-phase shutdown keeps observers live while cancellation settles. Drain
  // those final invalidations before checking the transport's eventual EOF.
  let ended=false;
  for(let n=0;n<100;n++) {
    const item=await reader.read();
    if(item.done){ended=true;break;}
    assert.match(new TextDecoder().decode(item.value),/event: invalidate/);
  }
  assert.equal(ended,true);
  assert.notEqual(readTask(f.home, task.taskId).status, "completed");
  assert.equal(f.h.server.listening, false);
  assert.equal(f.calls.length, 1);
});

async function cli(t, args, existingHome) {
  const home = existingHome ?? mkdtempSync(join(tmpdir(), "cothink-gui-cli-"));
  if (!existingHome) t.after(() => rmSync(home, { recursive: true, force: true }));
  const child = spawn(process.execPath, [new URL("../bin/cothink.js", import.meta.url).pathname, "gui", ...args], { env: { ...process.env, COTHINK_HOME: home, COTHINK_NO_TTY: "1", PI_OFFLINE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let stdout = "", stderr = "";
  child.stdout.on("data", (c) => { stdout += c; });
  child.stderr.on("data", (c) => { stderr += c; });
  const exited = once(child, "close");
  return { child, home, exited, output: () => ({ stdout, stderr }) };
}
test("CLI gui starts without configuration, supports port/no-open and closes on both signals", async (t) => {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const f = await cli(t, ["--port", "0", "--no-open"]);
    let url;
    for (let n = 0; n < 500; n++) {
      url = f.output().stdout.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      if (url || f.child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(url, JSON.stringify(f.output()));
    assert.equal((await fetch(url + "/api/bootstrap")).status, 403);
    assert.match(f.output().stdout, /#token=[A-Za-z0-9_-]+/);
    f.child.kill(signal);
    const [code] = await f.exited;
    assert.equal(code, signal === "SIGINT" ? 130 : 143, JSON.stringify(f.output()));
    await assert.rejects(fetch(url));
    assert.doesNotMatch(f.output().stderr, /首次配置需要交互终端/);
  }
});
test("CLI gui rejects invalid ports and unrelated arguments before opening", async (t) => {
  for (const args of [["--port", "-1"], ["--port", "65536"], ["--port", "1.5"], ["--port", "NaN"], ["unexpected"], ["--one"]]) {
    const f = await cli(t, args);
    const [code] = await f.exited;
    assert.equal(code, 2, JSON.stringify({ args, ...f.output() }));
    assert.doesNotMatch(f.output().stdout, /http:/);
  }
});


test("chunked JSON over the byte limit returns 413 while retaining usable HTTP service", async (t) => {
  const f = await host(t);
  const result = await new Promise((yes, no) => {
    const req = request(f.origin + "/api/action", { method: "POST", headers: { ...f.headers, "Content-Type": "application/json", "X-CoThink-GUI-Input":GUI_INPUT_VERSION, "Transfer-Encoding": "chunked" } }, (res) => {
      res.resume();
      res.on("end", () => yes(res.statusCode));
    });
    req.on("error", no);
    req.write('{"action":"session.draft","args":{"text":"');
    for (let n = 0; n < 17; n++) req.write("x".repeat(65536));
    req.end('"}}');
  });
  assert.equal(result, 413);
  assert.equal((await fetch(f.origin + "/api/bootstrap", { headers: f.headers })).status, 200);
});


test("CLI signal cancels an active task, saves partial status and releases its HTTP listener", async (t) => {
  const f = await fixture(t, async () => { await new Promise((r) => setTimeout(r, 800)); return { text: "slow" }; });
  saveConfig(f.home, createTeamConfig({ formatVersion: 2, ...f.models }, "Fixture", "7c8094cd-3476-4bfa-8f53-055d87972896"));
  const proc = await cli(t, ["--no-open"], f.home);
  let url;
  for (let n = 0; n < 500; n++) {
    url = proc.output().stdout.match(/http:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_-]+/)?.[0];
    if (url || proc.child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(url, "CLI did not produce a startup URL");
  const parsed = new URL(url), token = new URLSearchParams(parsed.hash.slice(1)).get("token");
  const action = async (action, args) => {
    const r = await fetch(parsed.origin + "/api/action", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-CoThink-GUI-Input":GUI_INPUT_VERSION }, body: JSON.stringify({ action, args }) });
    assert.equal(r.status, 200);
    return r.json();
  };
  const s = await fixtureConversation(t,{action});
  const get=async path=>(await fetch(parsed.origin+path,{headers:{Authorization:`Bearer ${token}`}})).json();
  const r = await action("task.submit",await prepareSubmit({action,get},{sessionId:s.id,input:"slow CLI",submissionId:"cli-signal"}));
  // Submission acknowledges the durable task before its first request is dispatched.
  // This case specifically exercises interrupting an in-flight request.
  for(let n=0;n<500&&!f.calls.length;n++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(f.calls.length,1,"fixture must receive the request before the signal");
  proc.child.kill("SIGTERM");
  assert.equal((await proc.exited)[0], 143);
  assert.notEqual(readTask(f.home, r.taskId).status, "completed");
  assert.equal(f.calls.length, 1);
  await assert.rejects(fetch(parsed.origin));
});

test('browser GUI CLI refuses Node preload before importing the business host',async t=>{
 const f=await fixture(t);const preload=join(f.home,'injection.mjs');writeFileSync(preload,'globalThis.__guiPreloaded=true;');
 const {invoke}=await import('./helpers/cli-fixture.js');
 const result=await invoke({...f,nodeArgs:['--import',preload]},['gui','--no-open']);
 assert.equal(result.code,2);assert.match(result.stderr,/干净入口/);assert.doesNotMatch(result.stdout,/http:/);assert.equal(f.calls.length,0);
});
