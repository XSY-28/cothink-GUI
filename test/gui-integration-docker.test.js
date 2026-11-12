import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { fixtureConversation, seedFixtureConversationRepository, submitDraft } from "./helpers/gui-controller-fixture.js";
import { fixture } from "./helpers/pi-fixture.js";
import { repository, git } from "./helpers/git-fixture.js";
import { GUI_INPUT_VERSION, done, execution, host, run, setup, tool } from "./gui-integration.fixture.js";

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
  const roster = await setup(h, f);
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
  const s = seedFixtureConversationRepository(repo.project,await fixtureConversation(t,h,{defaultRosterId:roster.id}));

  let a = await submitDraft(h, {
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
  git(repo.root, "clone", "--no-hardlinks", s.project, clone);
  git(clone, "checkout", "--detach", d.fromVersion);
  writeFileSync(join(repo.root, "patch.diff"), d.text);
  git(clone, "apply", "--index", "--binary", join(repo.root, "patch.diff"));
  assert.equal(
    git(clone, "write-tree"),
    git(s.project, "rev-parse", d.toVersion + "^{tree}"),
  );
  const b = await submitDraft(h, {
    sessionId: s.id,
    input: "second advance",
    protocolVersion:1, submissionId: "patch2",
  });
  const secondProposal=await done(h,b.taskId),confirmed=await h.action("task.confirmWork",{sessionId:s.id,protocolVersion:1,submissionId:"patch-confirm2",proposalRef:secondProposal.proposalRef});
  assert.equal((await done(h,confirmed.taskId)).status,"completed");
  assert.deepEqual(await h.get("/api/diff?id=" + a.taskId), d);
  const files = await h.get("/api/files?id=" + a.taskId);
  assert.equal(files.items.some(f=>f.name==='b.txt'),false,"the deleted path is recorded in the patch, not as a delivered file");
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

  assert.equal(readFileSync(join(s.project, "a.txt"), "utf8"), "second accepted\n");
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
    const roster = await setup(h, f);
    await h.action("settings.work", { work: { checks } });
    const s = seedFixtureConversationRepository(repo.project,await fixtureConversation(t,h,{defaultRosterId:roster.id}));

    const a = await submitDraft(h, {
      sessionId: s.id,
      input: "policy test",
      protocolVersion:1, submissionId: "policy",
    });
    const task = await done(h, a.taskId);
    if (!checks.length) {
      assert.equal(task.proposalRef,undefined,"formal plan requires nonempty checks");assert.equal(task.work,null);
      assert.equal(readFileSync(join(s.project,"a.txt"),"utf8"),"base A\n");
    } else {
      assert.ok(task.proposalRef);
      const refs=()=>git(s.project,"for-each-ref","--format=%(refname) %(objectname)");
      const before=refs();
      const response=await fetch(h.origin+"/api/action",{
        method:"POST",headers:{...h.headers,"Content-Type":"application/json","X-CoThink-GUI-Input":GUI_INPUT_VERSION},
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
  const roster = await setup(h, f);
  await h.action("settings.work", {
    work: {
      execution,
      checks: [{ command: "node", args: ["-e", "process.exit(0)"] }],
    },
  });
  const s = seedFixtureConversationRepository(repo.project,await fixtureConversation(t,h,{defaultRosterId:roster.id}));

  const a = await submitDraft(h, {
    sessionId: s.id,
    input: "missing engine", budget:{maxCalls:1},
    protocolVersion:1, submissionId: "missing",
  });
  const task=await done(h,a.taskId);
  assert.equal(task.workPlanError.code,"DOCKER_MISSING");
  assert.equal(task.proposalRef,undefined);
  assert.equal(f.calls.length,1);
  assert.equal(existsSync(join(f.home, "HOST_FALLBACK_CANARY")), false);
  assert.notEqual(task.work?.finalCheck?.verification, "passed");
  assert.notEqual(task.status, "completed");
  assert.match(JSON.stringify(task), /docker|ENOENT|executor/i);
});
