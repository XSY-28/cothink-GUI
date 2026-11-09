import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, symlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture } from "./helpers/pi-fixture.js";
import { saveConfig } from "../src/config.js";
import { createTeamConfig } from "../src/teams.js";
import { repository, git } from "./helpers/git-fixture.js";
import { execution } from "./helpers/agent-sync-fixture.js";
import { readTask } from "../src/task.js";
const module = await import("../src/gui-server.js").catch(() => ({}));

async function host(t, configured = false, handler) {
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
    const r = await fetch(origin + "/api/action", { method: "POST", headers: { ...headers, "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ action, args }) });
    assert.equal(r.status, 200, await r.clone().text());
    return r.json();
  };
  return { ...f, h, origin, headers, action, assets };
}
function http(origin, path, options = {}) {
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
async function completed(f, id) {
  for (let n = 0; n < 500; n++) {
    const r = await fetch(`${f.origin}/api/task?id=${id}`, { headers: f.headers });
    const task = await r.json();
    if (task.status !== "running") return task;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("fixture task did not settle");
}

test("all API reads, events and writes require Bearer, exact Host and same Origin", async (t) => {
  const f = await host(t);
  assert.equal(f.h.server.address().address, "127.0.0.1");
  assert.equal(new URL(f.h.url).search, "");
  assert.equal(new URLSearchParams(new URL(f.h.url).hash.slice(1)).get("token"), f.h.token);
  for (const path of ["bootstrap", "sessions", "session?id=x", "task?id=x", "diff?id=x", "patch?id=x", "output?id=x&ref=x", "events"]) {
    assert.equal((await fetch(f.origin + "/api/" + path)).status, 403, path);
    assert.equal((await fetch(f.origin + "/api/" + path, { headers: { Authorization: "Bearer wrong" } })).status, 403, path);
  }
  assert.equal((await fetch(f.origin + "/api/action", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } })).status, 403);
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
  const s = await f.action("session.create", { project: null });
  const submitted = await f.action("task.submit", { sessionId: s.id, input: "question", protocolVersion:1, submissionId: "durable" });
  const done = await completed(f, submitted.taskId);
  assert.equal(done.status, "completed", done.error);
  assert.equal(f.calls.length, 1);
  for (const path of ["/api/bootstrap", `/api/session?id=${s.id}`, `/api/task?id=${submitted.taskId}`]) {
    const r = await fetch(f.origin + path, { headers: f.headers });
    assert.equal(r.status, 200);
    assert.doesNotMatch(await r.text(), /fixture-secret|fixtureKey/);
  }
  const duplicate = await f.action("task.submit", { sessionId: s.id, input: "question", protocolVersion:1, submissionId: "durable" });
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
  const s = await f.action("session.create", { project: null });
  const task = await f.action("task.submit", { sessionId: s.id, input: "slow", protocolVersion:1, submissionId: "cancel" });
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
    const req = request(f.origin + "/api/action", { method: "POST", headers: { ...f.headers, "Content-Type": "application/json", "Transfer-Encoding": "chunked" } }, (res) => {
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

test("HTTP work routes serve fixed diffs, plain patches and only task-owned paginated output", async (t) => {
  const repo = repository(t);
  const f = await host(t, true, (_call, n) => {
    const tool = (name, args = {}) => ({ toolCalls: [{ name, args }] });
    if (n === 1) return tool("start_work", {action:"start",reason:"change fixture",plan:{goal:"change source",scope:["a.txt"],deliverables:["a.txt"],checks:[{command:"node",args:["-e","console.log(\'HTTP check log\')"]}]}});
    if (n === 2) return tool("read", { path: "a.txt" });
    if (n === 3) return tool("write", { path: "a.txt", content: "HTTP accepted output\n" });
    if (n === 4 || n === 5) return tool("accept_change");
    return { text: "Delivered original reply" };
  });
  const original = git(repo.project, "status", "--porcelain=v1");
  await f.action("settings.work", { work: { execution, checks: [{ command: "node", args: ["-e", "console.log('HTTP check log')"] }] } });
  const s = await f.action("session.create", { project: repo.project });
  await f.action("session.name", { sessionId: s.id, title: "Fixture conversation" });
  const proposal = await f.action("task.submit", { sessionId: s.id, input: "change source", protocolVersion:1, submissionId: "http-work" });
  const proposed=await completed(f,proposal.taskId);
  const task=await f.action("task.confirmWork",{sessionId:s.id,protocolVersion:1,submissionId:"http-confirm",proposalRef:proposed.proposalRef});
  const rootDone=await completed(f,task.taskId);
  const done=await completed(f,rootDone.projectOperation.childTaskIds[0]);
  assert.equal(done.status, "completed", done.error);
  assert.equal(done.work.finalCheck.verification, "passed");
  const diff = await (await fetch(`${f.origin}/api/diff?id=${task.taskId}`, { headers: f.headers })).json();
  assert.equal(diff.fromVersion, done.work.startVersion);
  assert.match(diff.text, /HTTP accepted output/);
  const patch = await fetch(`${f.origin}/api/patch?id=${task.taskId}`, { headers: f.headers });
  assert.equal(patch.headers.get("Content-Type"), "text/plain; charset=utf-8");
  assert.equal(await patch.text(), diff.text);
  const ref = done.work.finalCheck.checks[0].outputRef;
  const page = async (offset, limit) => (await fetch(`${f.origin}/api/output?id=${task.taskId}&ref=${ref}&offset=${offset}&limit=${limit}`, { headers: f.headers })).json();
  const first = await page(0, 3), rest = await page(first.nextOffset, 65536);
  assert.match(first.text + rest.text, /HTTP check log/);
  assert.equal(rest.eof, true);
  const foreign = await fetch(`${f.origin}/api/output?id=${task.taskId}&ref=foreign`, { headers: f.headers });
  assert.equal(foreign.status, 400);
  assert.match((await foreign.json()).error, /outputRef.*任务/);
  assert.equal(readFileSync(join(repo.project, "a.txt"), "utf8"), "base A\n");
  assert.equal(git(repo.project, "status", "--porcelain=v1"), original);
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
    const r = await fetch(parsed.origin + "/api/action", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ action, args }) });
    assert.equal(r.status, 200);
    return r.json();
  };
  const s = await action("session.create", { project: null });
  const r = await action("task.submit", { sessionId: s.id, input: "slow CLI", protocolVersion:1, submissionId: "cli-signal" });
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

test('visual artifacts require authentication and exact task registration; traversal, cross-task paths and non-PNG bytes fail',async t=>{
 const f=await host(t);const {createTask}=await import('../src/task.js');const {createHash}=await import('node:crypto');
 const task=createTask({home:f.home,input:'visual',models:f.models});const ref='preview-ref',dir=join(f.home,'artifacts',task.record.id,ref);mkdirSync(dir,{recursive:true});
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr1kAAAAASUVORK5CYII=','base64');const path=join(dir,'0.png');writeFileSync(path,png);
 task.record.work={visualEvidence:[{outputRef:ref,images:[{path,sha256:createHash('sha256').update(png).digest('hex')}]}]};task.save();
 const url=`${f.origin}/api/artifact?id=${task.record.id}&ref=${ref}&index=0`;
 assert.equal((await fetch(url)).status,403);const ok=await fetch(url,{headers:f.headers});assert.equal(ok.status,200);assert.equal(ok.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await ok.arrayBuffer()),png);
 for(const query of [`id=${task.record.id}&ref=../preview-ref&index=0`,`id=${task.record.id}&ref=${ref}&index=1`])assert.equal((await fetch(`${f.origin}/api/artifact?${query}`,{headers:f.headers})).status,400);
 task.record.work.visualEvidence[0].images[0].path=join(f.home,'elsewhere.png');writeFileSync(join(f.home,'elsewhere.png'),png);task.save();assert.equal((await fetch(url,{headers:f.headers})).status,400);
 task.record.work.visualEvidence[0].images[0].path=path;writeFileSync(path,'<svg onload="bad()"/>');task.save();assert.equal((await fetch(url,{headers:f.headers})).status,400);
});


test("navigation HTTP routes retain safe conflict codes and distinguish null-project pagination",async t=>{
  const f=await host(t,true), {createApi}=await import("../gui/src/api.js");
  const api=createApi(f.h.token,(path,options)=>fetch(f.origin+path,options));
  const s=await f.action("session.create",{project:null});
  await assert.rejects(api.action("session.close",{sessionId:s.id}),e=>e.code==="SESSION_STATE_UNAVAILABLE" && e.status===409 && e.unknown===false);
  const emptyArchive=await api.action("session.archive",{sessionId:s.id,archived:true,expectedRevision:0});
  assert.equal(emptyArchive.navigation.archived,true);
  await api.action("session.archive",{sessionId:s.id,archived:false,expectedRevision:1});
  const run=await f.action("task.submit",{sessionId:s.id,input:"HTTP navigation",protocolVersion:1, submissionId:"nav-http"});
  await completed(f,run.taskId);
  const archived=await api.action("session.archive",{sessionId:s.id,archived:true,expectedRevision:2});
  const page=await api.read("sessions",{project:"",archived:"archived",query:"HTTP",limit:1});
  assert.equal(page.items[0].id,s.id);
  await assert.rejects(api.action("session.pin",{sessionId:s.id,pinned:true,expectedRevision:0}),e=>e.code==="SESSION_STATE_CONFLICT" && e.status===409);
  await assert.rejects(api.read("sessions",{cursor:"invalid"}),e=>e.code==="CURSOR_EXPIRED" && e.status===409);
  for(const params of [{limit:101},{limit:0},{archived:"yes"},{query:"x".repeat(201)}]) await assert.rejects(api.read("sessions",params));
  const recovered=await api.action("session.archive",{sessionId:s.id,archived:false,expectedRevision:archived.navigation.revision});
  assert.equal(recovered.navigation.archived,false);
  assert.equal(f.calls.length,1);
});

test("workspace actions preserve auth, current conflict entries and unavailable table errors", async t => {
  const f = await host(t, true), workspaceId = randomUUID();
  const create = {workspaceId, name:"学习", project:null, defaultRosterId:null};
  const post = async (action, args, authorized = true) => {
    const response = await fetch(f.origin + "/api/action", {method:"POST",
      headers:{"Content-Type":"application/json", ...(authorized ? f.headers : {})},
      body:JSON.stringify({action,args})});
    return {status:response.status, body:await response.json()};
  };
  assert.equal((await post("workspace.create",create,false)).status,403);
  const invalid = await post("workspace.create",{...create,defaultRosterId:randomUUID()});
  assert.equal(invalid.status,400);
  assert.match(invalid.body.error,/阵容/);
  assert.equal((await f.action("workspace.create",create)).id,workspaceId);
  const duplicate = await post("workspace.create",create);
  assert.equal(duplicate.status,409);
  assert.equal(duplicate.body.code,"WORKSPACE_CONFLICT");
  assert.equal(duplicate.body.workspace.id,workspaceId);
  const repo = await repository(t);
  assert.equal((await f.action("workspace.bind",{workspaceId,expectedRevision:0,path:repo.project})).revision,1);
  const conflict = await post("workspace.update",{workspaceId,expectedRevision:0,change:{name:"Stale"}});
  assert.equal(conflict.status,409);
  assert.equal(conflict.body.code,"WORKSPACE_CONFLICT");
  assert.equal(conflict.body.workspace.revision,1);
  const session = await f.action("session.create",{project:repo.project});
  const generic = await f.action("session.create",{project:null});
  await f.action("session.name",{sessionId:generic.id,title:"Generic fixture"});
  const archived = await f.action("workspace.update",{workspaceId,expectedRevision:1,change:{archived:true}});
  const submit = () => post("task.submit",{sessionId:session.id,input:"Must not run",protocolVersion:1, submissionId:randomUUID()});
  const archivedSubmit = await submit();
  assert.equal(archivedSubmit.status,409);
  assert.equal(archivedSubmit.body.code,"WORKSPACE_ARCHIVED");
  const blocked = await post("session.create",{project:archived.project});
  assert.equal(blocked.status,409);
  assert.equal(blocked.body.code,"WORKSPACE_ARCHIVED");
  const damaged = '{"schemaVersion":999}';
  writeFileSync(join(f.home,"gui-workspaces.json"),damaged);
  const unavailable = await post("workspace.update",{workspaceId,expectedRevision:2,change:{name:"Unsafe"}});
  assert.equal(unavailable.status,409);
  assert.equal(unavailable.body.code,"WORKSPACE_UNAVAILABLE");
  const uncertainSubmit = await submit();
  assert.equal(uncertainSubmit.status,409);
  assert.equal(uncertainSubmit.body.code,"WORKSPACE_UNAVAILABLE");
  assert.equal(readFileSync(join(f.home,"gui-workspaces.json"),"utf8"),damaged);
  assert.equal(f.calls.length,0);
  const accepted = await post("task.submit",{sessionId:generic.id,input:"Independent generic conversation",protocolVersion:1, submissionId:randomUUID()});
  assert.equal(accepted.status,200,accepted.body.error);
  assert.equal((await completed(f,accepted.body.taskId)).status,"completed");
  assert.equal(f.calls.length,1);
  assert.equal(readFileSync(join(f.home,"gui-workspaces.json"),"utf8"),damaged);
});

test("workspace bootstrap keeps the repository index unchanged", async t => {
  const f = await host(t,true), repo = repository(t);
  await f.action("session.create",{project:repo.project});
  const index = join(repo.project,".git/index");
  const original = readFileSync(index);
  const changedMtime = new Date(Date.now() + 60000);
  utimesSync(join(repo.project,"a.txt"),changedMtime,changedMtime);
  const response = await fetch(f.origin+"/api/bootstrap",{headers:f.headers});
  assert.equal(response.status,200);
  assert.equal((await response.json()).workspaces[0].projectAvailable,true);
  assert.deepEqual(readFileSync(index),original);
});

test("a replaced workspace path cannot redirect task or plugin execution to another repository", async t => {
  const f = await host(t,true), repo = repository(t), replacement = repository(t);
  const session = await f.action("session.create",{project:repo.project});
  renameSync(repo.project,join(repo.root,"moved"));
  symlinkSync(replacement.project,repo.project,"junction");
  const get = async path => {
    const response = await fetch(f.origin + path,{headers:f.headers});
    assert.equal(response.status,200);
    return response.json();
  };
  const readable = await get("/api/session?id="+session.id);
  assert.equal(readable.project,session.project);
  assert.equal(readable.workspaceId,session.workspaceId);
  assert.equal((await get("/api/bootstrap")).workspaces[0].projectAvailable,false);
  for (const [action,args] of [
    ["task.submit",{input:"Must not run",protocolVersion:1, submissionId:randomUUID()}],
    ["extension.command",{input:"/must-not-run"}],
  ]) {
    const response = await fetch(f.origin+"/api/action",{method:"POST",
      headers:{...f.headers,"Content-Type":"application/json"},
      body:JSON.stringify({action,args:{sessionId:session.id,...args}})});
    assert.equal(response.status,409,await response.clone().text());
    assert.equal((await response.json()).code,"WORKSPACE_UNAVAILABLE");
  }
  assert.equal(f.calls.length,0);
});

test("HTTP reading records reject stale revisions with a safe conflict code", async t => {
  const f=await host(t);
  const s=await f.action("session.create",{sessionId:randomUUID(),workspaceId:null});
  const args={sessionId:s.id,expectedViewRevision:s.viewRevision,opened:true};
  const saved=await f.action("session.view",args);
  assert.equal(saved.viewRevision,s.viewRevision+1);
  const stale=await fetch(f.origin+"/api/action",{method:"POST",
    headers:{...f.headers,"Content-Type":"application/json"},body:JSON.stringify({action:"session.view",args})});
  assert.equal(stale.status,409);
  assert.equal((await stale.json()).code,"VIEW_CONFLICT");
  assert.equal(f.calls.length,0);
});

test('browser GUI CLI refuses Node preload before importing the business host',async t=>{
 const f=await fixture(t);const preload=join(f.home,'injection.mjs');writeFileSync(preload,'globalThis.__guiPreloaded=true;');
 const {invoke}=await import('./helpers/cli-fixture.js');
 const result=await invoke({...f,nodeArgs:['--import',preload]},['gui','--no-open']);
 assert.equal(result.code,2);assert.match(result.stderr,/干净入口/);assert.doesNotMatch(result.stdout,/http:/);assert.equal(f.calls.length,0);
});
