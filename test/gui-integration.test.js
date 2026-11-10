import test from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
  rmSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { fixture } from "./helpers/pi-fixture.js";
import { repository, git } from "./helpers/git-fixture.js";
const execution = JSON.parse(
  readFileSync(
    new URL("../packages/agent-sync/execution-manifest.json", import.meta.url),
  ),
).execution;
const root = resolve(
  process.env.COTHINK_TEST_PACKAGE_ROOT ??
    fileURLToPath(new URL("..", import.meta.url)),
);
const load = (p) => import(pathToFileURL(join(root, p)));
const { startGuiServer } = await load("src/gui-server.js");
const { neutralDirectory } = await load("src/conversation.js");
const tool = (name, args = {}) => ({ toolCalls: [{ name, args }] });
async function host(t, f) {
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
      headers: { ...headers, "Content-Type": "application/json", "X-CoThink-GUI-Input":"2" },
      body: JSON.stringify({ action, args }),
    });
    assert.equal(r.status, 200, await r.clone().text());
    return r.json();
  };
  return { h, origin, headers, get, action };
}
async function done(h, id) {
  for (let i = 0; i < 1500; i++) {
    const r = await h.get("/api/task?id=" + id);
    if (r.status !== "running") return r;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error("fixture task did not settle");
}
async function setup(h, f) {
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
  return h.action("team.save", {
    name: "HTTP integration",
    main: { provider: "configured", modelId: "main" },
    secondary: [f.models.secondary[0]],
  });
}
async function run(command, args, env = {}) {
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

test("blank HTTP setup uses unified calls and actual new CLI PTY refuses continuation before generation",async t=>{
 const f=await fixture(t,(_,n)=>({text:'ROUNDTRIP_REPLY '+n}));writeFileSync(join(f.cwd,'AGENTS.md'),'UNBOUND_AGENTS_CANARY');
 let h=await host(t,f);assert.equal((await h.get('/api/bootstrap')).configured,false);const team=await setup(h,f);
 const session=await h.action('session.create',{project:null});
 const send=async(input,id)=>{const r=await h.action('task.submit',{sessionId:session.id,input,submissionId:id,protocolVersion:1});assert.equal((await done(h,r.taskId)).status,'completed');return r;};
 const first=await send('GUI first question','first');await send('GUI second question','second');assert.equal(f.calls.length,2);
 await h.h.close();
 const cli=await run('python3',[fileURLToPath(new URL('./helpers/gui-cli-roundtrip.py',import.meta.url)),f.home,join(root,'bin/cothink.js'),neutralDirectory(f.home),'--expect-unified']);
 assert.equal(cli.code,0,cli.err);assert.match(cli.out,/unifiedRefused/);assert.equal(f.calls.length,2);
 h=await host(t,f);const restored=await h.get('/api/session?id='+session.id);assert.equal(restored.project,null);assert.equal(restored.team.id,team.id);assert.equal(restored.turns.length,2);assert.doesNotMatch(JSON.stringify(f.calls),/UNBOUND_AGENTS_CANARY/);
 assert.equal((await send('GUI first question','first')).taskId,first.taskId);assert.equal(f.calls.length,2);
});

test("HTTP cancellation in real review/member saves partial content without extra calls after SSE disconnect", async (t) => {
  for (const member of [false, true]) {
    let entered;
    const barrier = new Promise((r) => (entered = r));
    const f = await fixture(t, async (call, n, req, res) => {
      if (call.body.model === "r1") {
        entered();
        await new Promise((r) => {
          const timer = setTimeout(r, 30000);
          res.once("close", () => {
            clearTimeout(timer);
            r();
          });
        });
        return res.destroyed ? null : { text: "delayed member" };
      }
      if (member) {
        if (n === 1)
          return tool("start_work", {action:"start",reason:"member cancellation",plan:{goal:"member cancel",scope:["a.txt"],readScope:["."],deliverables:["a.txt"],checks:[{command:"node",args:["-e","require(\'fs\').accessSync(\'a.txt\')"]}]}});
        if(n===2)return tool("project_staff",{action:"appoint",input:{id:"reader",responsibility:"Read source",scope:[],readScope:["."],models:["fixture/r1"],need:"deliverable",reason:"inspect"}});
        if (n === 3)
          return tool("delegate", {
            staffId:"reader",
            model: "fixture/r1",
            assignment: "slow member",
            implementationAdvice: "read only fixture",
            reason: "inspection",
            scope: [],
            readScope: ["."],
            readOnly: true,
          });
        return tool("collect");
      }
      return n===1?tool("request_review",{reason:"inspect",draft:"saved draft"}):{text:"saved draft"};
    });
    const h = await host(t, f);
    await setup(h, f);
    await h.action("settings.work", { work: {execution, checks: [] } });
    const repo = member ? repository(t) : null;
    const s = await h.action("session.create", {
      project: repo?.project ?? null,
    });
    let a = await h.action("task.submit", {
      sessionId: s.id,
      input: member ? "member cancel" : "review cancel",
      protocolVersion:1, submissionId: "cancel",
    });
    if(member){const proposal=await done(h,a.taskId);a=await h.action("task.confirmWork",{sessionId:s.id,protocolVersion:1,submissionId:"confirm-member",proposalRef:proposal.proposalRef});}
    let timer;
    try {
      await Promise.race([
        barrier,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(Error("fixture did not enter reviewer/member")),
            15000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    const abort = new AbortController();
    const events = await fetch(h.origin + "/api/events", {
      headers: h.headers,
      signal: abort.signal,
    });
    await events.body.getReader().read();
    abort.abort();
    assert.equal((await h.get("/api/task?id=" + a.taskId)).status, "running");
    const n = f.calls.length;
    await h.action("task.cancel", { taskId: a.taskId });
    let task = await done(h, a.taskId);
    if(member)task=await done(h,task.projectOperation.childTaskIds[0]);
    assert.notEqual(task.status, "completed");
    assert.equal(f.calls.length, n);
    assert.ok(task.messages.some((x) => x.text === "saved draft" || JSON.stringify(x).includes("saved draft")) || member || readFileSync(join(f.home,"requests",(JSON.parse(readFileSync(join(f.home,"tasks",a.taskId+".json"))).requestIds[0])+".json"),"utf8").includes("saved draft"));
    if (member)
      assert.ok(
        task.participants.some((x) => x.role === "member" && x.participated),
      );
  }
});

test("HTTP Docker work patch reconstructs binary/delete/mode and old task diff stays fixed after later acceptance", async (t) => {
  const repo = repository(t);
  let round = 0,
    k = 0;
  const original = git(repo.project, "status", "--porcelain=v1");
  const f = await fixture(t, (call) => {
    if (
      (call.body.tools ?? []).some((x) => x.function?.name === "start_work")
    ) {
      round++;
      k = 0;
      return tool("start_work", {
        action:round===1?"start":"revise",reason:"full patch",plan:{goal:round===1?"first full patch":"second advance",scope:["a.txt","b.txt","asset.bin","run.sh"],readScope:["."],deliverables:["a.txt","asset.bin","run.sh"],works:[{id:"patch",scope:["a.txt","b.txt","asset.bin","run.sh"]}],checks:[{command:"node",args:["-e","if(!require(\'fs\').readFileSync(\'asset.bin\').equals(Buffer.from([0,255,1])))process.exit(1);console.log(\'PATCH_CHECK\')"]}]},
      });
    }
    k++;
    if(k===1)return tool("next_change",{reason:"binary/delete/mode patch",scope:["a.txt","b.txt","asset.bin","run.sh"],readScope:["."]});
    if (k === 2)
      return tool("bash", {
        command:
          round === 1
            ? "node -e \"const f=require('fs');f.writeFileSync('a.txt','first accepted\\n');f.unlinkSync('b.txt');f.writeFileSync('asset.bin',Buffer.from([0,255,1]));f.writeFileSync('run.sh','#!/bin/sh\\necho fixture\\n');f.chmodSync('run.sh',0o755)\""
            : "node -e \"require('fs').writeFileSync('a.txt','second accepted\\n')\"",
      });
    if (k === 3 || k === 4) return tool("accept_change");
    return { text: "delivered" };
  });
  const h = await host(t, f);
  await setup(h, f);
  await h.action("settings.work", {
    work: {
      execution,
      checks: [
        {
          command: "node",
          args: [
            "-e",
            "if(!require('fs').readFileSync('asset.bin').equals(Buffer.from([0,255,1])))process.exit(1);console.log('PATCH_CHECK')",
          ],
        },
      ],
    },
  });
  const s = await h.action("session.create", { project: repo.project });

  let a = await h.action("task.submit", {
    sessionId: s.id,
    input: "first full patch",
    protocolVersion:1, submissionId: "patch1",
  });
  const proposed=await done(h,a.taskId);a=await h.action("task.confirmWork",{sessionId:s.id,protocolVersion:1,submissionId:"patch-confirm1",proposalRef:proposed.proposalRef});
  const firstRoot=await done(h,a.taskId),first=await done(h,firstRoot.projectOperation.childTaskIds[0]);
  if(first.status!=="completed")writeFileSync("work/gui/desktop-unified/d3-d4-evidence/patch-failure.json",JSON.stringify({first,calls:f.calls.map(c=>c.body)},null,2));
  assert.equal(first.status, "completed", first.error);
  assert.equal(first.work.finalCheck.verification, "passed");
  const d = await h.get("/api/diff?id=" + a.taskId);
  assert.match(d.text, /GIT binary patch/);
  assert.match(d.text, /deleted file mode/);
  assert.match(d.text, /new file mode 100755/);
  const clone = join(repo.root, "rebuild");
  git(repo.root, "clone", "--no-hardlinks", repo.project, clone);
  git(clone, "checkout", "--detach", d.fromVersion);
  writeFileSync(join(repo.root, "patch.diff"), d.text);
  git(clone, "apply", "--index", "--binary", join(repo.root, "patch.diff"));
  assert.equal(
    git(clone, "write-tree"),
    git(repo.project, "rev-parse", d.toVersion + "^{tree}"),
  );
  const b = await h.action("task.submit", {
    sessionId: s.id,
    input: "second advance",
    protocolVersion:1, submissionId: "patch2",
  });
  const secondProposal=await done(h,b.taskId),confirmed=await h.action("task.confirmWork",{sessionId:s.id,protocolVersion:1,submissionId:"patch-confirm2",proposalRef:secondProposal.proposalRef});
  assert.equal((await done(h,confirmed.taskId)).status,"completed");
  assert.deepEqual(await h.get("/api/diff?id=" + a.taskId), d);
  const files = await h.get("/api/files?id=" + a.taskId);
  assert.equal(files.items.find(f=>f.name==='b.txt').status,'deleted');
  const oldRef = files.items.find(f=>f.name==='a.txt').ref;
  const oldBytes = await fetch(h.origin+'/api/file?'+new URLSearchParams({...oldRef,purpose:'download'}),{headers:h.headers});
  assert.equal(oldBytes.status,200);
  assert.equal(await oldBytes.text(),'first accepted\n');
  const binaryRef=files.items.find(f=>f.name==='asset.bin').ref;
  const binary=await fetch(h.origin+'/api/file?'+new URLSearchParams({...binaryRef,purpose:'download'}),{headers:h.headers});
  assert.deepEqual(Buffer.from(await binary.arrayBuffer()),Buffer.from([0,255,1]));
  assert.equal((await h.get('/api/file-diff?'+new URLSearchParams(binaryRef))).binary,true);
  const beforeNavigation=f.calls.length;
  const workspace=(await h.get("/api/bootstrap")).workspaces.find(row=>row.id===s.workspaceId);
  const search=(filters={})=>h.get("/api/sessions?"+new URLSearchParams({query:"asset.bin",...filters}));
  const match=(await search({workspaceId:workspace.id})).items.find(row=>row.id===s.id).match;
  assert.equal(match.field,"file");
  assert.deepEqual(match.fileRef,binaryRef);
  assert.equal(match.taskId,a.taskId);
  const archive=await h.action("workspace.update",{workspaceId:workspace.id,expectedRevision:workspace.revision,change:{archived:true}});
  assert.equal((await search()).items.some(row=>row.id===s.id),false);
  const archivedMatch=(await search({archived:"all"})).items.find(row=>row.id===s.id);
  assert.equal(archivedMatch.readOnly,true);
  assert.deepEqual(archivedMatch.match,match);
  const savedBinary=await fetch(h.origin+"/api/file?"+new URLSearchParams({...archivedMatch.match.fileRef,purpose:"download"}),{headers:h.headers});
  assert.deepEqual(Buffer.from(await savedBinary.arrayBuffer()),Buffer.from([0,255,1]));
  assert.equal((await h.get("/api/session?id="+s.id)).workspaceArchived,true,"file reads do not restore the archived Team");
  await h.action("workspace.update",{workspaceId:workspace.id,expectedRevision:archive.revision,change:{archived:false}});
  assert.equal((await search()).items.find(row=>row.id===s.id).readOnly,false);
  assert.equal(f.calls.length,beforeNavigation);

  assert.equal(readFileSync(join(repo.project, "a.txt"), "utf8"), "base A\n");
  assert.equal(git(repo.project, "status", "--porcelain=v1"), original);
});

test("HTTP distinguishes an empty unverified policy from configured checks without execution", async (t) => {
  for (const checks of [
    [],
    [{ command: "node", args: ["-e", "process.exit(0)"] }],
  ]) {
    const repo = repository(t);
    const f = await fixture(t, (_,n) => n===1
      ? tool("start_work", {action:"start",reason:"check boundary",plan:{goal:"policy test",scope:["a.txt"],deliverables:["a.txt"],checks}})
      : {text:"policy result"});
    const h = await host(t, f);
    await setup(h, f);
    await h.action("settings.work", { work: { checks } });
    const s = await h.action("session.create", { project: repo.project });

    const a = await h.action("task.submit", {
      sessionId: s.id,
      input: "policy test",
      protocolVersion:1, submissionId: "policy",
    });
    const task = await done(h, a.taskId);
    if (!checks.length) {
      assert.equal(task.proposalRef,undefined,"formal plan requires nonempty checks");assert.equal(task.work,null);
      assert.equal(readFileSync(join(repo.project,"a.txt"),"utf8"),"base A\n");
    } else {
      assert.ok(task.proposalRef);
      const refs=()=>git(repo.project,"for-each-ref","--format=%(refname) %(objectname)");
      const before=refs();
      const response=await fetch(h.origin+"/api/action",{
        method:"POST",headers:{...h.headers,"Content-Type":"application/json","X-CoThink-GUI-Input":"2"},
        body:JSON.stringify({action:"task.confirmWork",args:{sessionId:s.id,protocolVersion:1,submissionId:"policy-confirm",proposalRef:task.proposalRef}}),
      });
      assert.equal(response.status,400);
      const blocked=await response.json();
      assert.equal(blocked.code,"PROPOSAL_BLOCKED");
      assert.match(blocked.error,/执行环境/);
      assert.equal(f.calls.length,1);
      assert.equal(refs(),before);
      assert.equal((await h.get("/api/session?id="+s.id)).turns.at(-1).confirmationIntent,undefined);
    }
  }
});

test("missing Docker isolated child refuses host Shell fallback", async (t) => {
  if (!process.env.COTHINK_GUI_NO_DOCKER_CHILD) {
    const { mkdtempSync, symlinkSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const bin = mkdtempSync(join(tmpdir(), "gui-no-docker-"));
    t.after(() => rmSync(bin, { recursive: true, force: true }));
    // Only this child sees the restricted PATH. Docker Desktop and host config are untouched.
    const gitPath = (await run("/usr/bin/which", ["git"])).out.trim();
    symlinkSync(gitPath, join(bin, "git"));
    const r = await run(
      process.execPath,
      [
        "--test",
        "--test-name-pattern=missing Docker isolated child",
        fileURLToPath(import.meta.url),
      ],
      { PATH: bin, COTHINK_GUI_NO_DOCKER_CHILD: "1" },
    );
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /missing Docker isolated child/);
    return;
  }
  const repo = repository(t);
  let f;
  f = await fixture(t, (_, n) =>
    n === 1
      ? tool("start_work", {action:"start",reason:"unavailable executor",plan:{goal:"missing engine",scope:["a.txt"],deliverables:["a.txt"],checks:[{command:"node",args:["-e","process.exit(0)"]}]}})
      : n === 2
        ? tool("bash", {
            command: `echo forbidden > '${join(f.home, "HOST_FALLBACK_CANARY")}'`,
          })
        : { text: "cannot execute" },
  );
  const h = await host(t, f);
  await setup(h, f);
  await h.action("settings.work", {
    work: {
      execution,
      checks: [{ command: "node", args: ["-e", "process.exit(0)"] }],
    },
  });
  const s = await h.action("session.create", { project: repo.project });

  const a = await h.action("task.submit", {
    sessionId: s.id,
    input: "missing engine",
    protocolVersion:1, submissionId: "missing",
  });
  const proposal=await done(h,a.taskId),confirmed=await h.action("task.confirmWork",{sessionId:s.id,protocolVersion:1,submissionId:"missing-confirm",proposalRef:proposal.proposalRef});
  const task=await done(h,confirmed.taskId);
  assert.equal(existsSync(join(f.home, "HOST_FALLBACK_CANARY")), false);
  assert.notEqual(task.work?.finalCheck?.verification, "passed");
  assert.notEqual(task.status, "completed");
  assert.match(JSON.stringify(task), /docker|ENOENT|executor/i);
});
