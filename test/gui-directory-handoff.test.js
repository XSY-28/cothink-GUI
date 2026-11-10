import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {spawnSync} from "node:child_process";
import {mkdirSync,mkdtempSync,realpathSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {chromium} from "playwright";
import {fixture} from "./helpers/pi-fixture.js";
import {controller,load,productRoot,teamId} from "./helpers/gui-controller-fixture.js";

const {startGuiServer}=await load("src/gui-server.js");

test("scope recovery is read-only and neutral directory creation refuses symlink aliases", t => {
  const directory=mkdtempSync(join(tmpdir(),"cothink-neutral-"));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const probe=spawnSync(process.execPath,["--input-type=module","-e",`
    import assert from "node:assert/strict";
    import {createHash} from "node:crypto";
    import {existsSync,mkdirSync,statSync,symlinkSync,realpathSync} from "node:fs";
    import {tmpdir} from "node:os";
    import {join} from "node:path";
    import {pathToFileURL} from "node:url";
    const load = f => import(pathToFileURL(join(process.argv[1],f)));
    const {neutralDirectory}=await load("src/conversation.js");
    const {scopeAfterTruncatedTail}=await load("src/gui-session-persistence.js");
    const {CURRENT_SESSION_VERSION}=await load("node_modules/@earendil-works/pi-coding-agent/dist/index.js");
    const temp=realpathSync(tmpdir()), home=join(temp,"private-data"), root=join(temp,"cothink-chat");
    const target=join(temp,"untouched");
    mkdirSync(target,{mode:0o755});
    const header={type:"session",version:CURRENT_SESSION_VERSION,id:"7c8094cd-3476-4bfa-8f53-055d87972896",cwd:target};
    const lines=[JSON.stringify(header),"{}","{}","{}","{"];
    assert.equal(scopeAfterTruncatedTail(lines,home,1),undefined);
    assert.equal(existsSync(root),false);
    mkdirSync(root,{mode:0o700});
    const key=createHash("sha256").update(home).digest("hex").slice(0,24);
    symlinkSync(target,join(root,key),process.platform==="win32"?"junction":"dir");
    const permissions=statSync(target).mode;
    assert.equal(scopeAfterTruncatedTail(lines,home,1),undefined);
    assert.throws(()=>neutralDirectory(home),/不可安全使用/);
    assert.equal(statSync(target).mode,permissions);
  `,productRoot],{env:{...process.env,TMPDIR:directory,TMP:directory,TEMP:directory},encoding:"utf8"});
  assert.equal(probe.status,0,probe.stderr);
});

test("changed Team directory can start a fresh conversation with the original draft text", async t => {
  const f = await fixture(t);
  const c = await controller(t, f);
  const parent = mkdtempSync(join(tmpdir(),"cothink-handoff-"));
  t.after(()=>rmSync(parent,{recursive:true,force:true}));
  const oldPath = join(parent,"old"), newPath = join(parent,"new");
  mkdirSync(oldPath);
  mkdirSync(newPath);
  const workspaceId = randomUUID();
  const team = await c.action("workspace.create", {workspaceId,name:"项目目录迁移",project:realpathSync(oldPath),defaultRosterId:teamId});
  const old = await c.action("session.create", {sessionId:randomUUID(), workspaceId});
  await c.action("workspace.rebind", {
    workspaceId, expectedRevision:team.revision, path:realpathSync(newPath), operationId:randomUUID(),
  });
  await assert.rejects(c.action("session.create", {
    workspaceId,sessionId:randomUUID(),handoff:{project:realpathSync(oldPath),text:"过期目标"},
  }),{code:"WORKSPACE_CONFLICT"});
  const host = await startGuiServer({home:f.home, cwd:f.cwd, open:false, controller:c});
  t.after(() => host.close());
  const browser = await chromium.launch({headless:true});
  t.after(() => browser.close());
  const page = await browser.newPage({viewport:{width:1280,height:820}});
  page.setDefaultTimeout(5000);
  await page.goto(host.url);
  await page.getByRole("navigation",{name:"工作导航"}).getByRole("button",{name:"项目目录迁移",exact:true}).click();
  const input = page.getByLabel("输入问题",{exact:true});
  const draft = "请生成 index.html";
  await input.fill(draft);
  await page.getByRole("button",{name:"用新目录继续",exact:true}).click();
  const dialog = page.getByRole("dialog",{name:"使用 Team 目录",exact:true});
  await dialog.getByText(realpathSync(newPath),{exact:true}).waitFor();
  await dialog.getByRole("button",{name:"新建并复制草稿",exact:true}).click();
  await dialog.waitFor({state:"hidden"});
  assert.equal(await input.inputValue(),draft);
  const chats = await c.sessions({workspaceId});
  assert.equal(chats.items.length,2);
  const next = await c.session(chats.items.find(item=>item.id!==old.id).id);
  const original = await c.session(old.id);
  assert.equal(next.project,realpathSync(newPath));
  assert.equal(next.editor.text,draft);
  assert.deepEqual(next.editor.materials,[]);
  assert.equal(next.editor.turnOptions??null,null);
  assert.equal(original.project,realpathSync(oldPath));
  assert.equal(original.editor.text,draft);

  // A receipt from the previous destination cannot acknowledge a new handoff.
  const savedTeam=(await c.bootstrap()).workspaces.find(row=>row.id===workspaceId);
  await c.action("workspace.rebind", {
    workspaceId,expectedRevision:savedTeam.revision,path:realpathSync(oldPath),operationId:randomUUID(),
  });
  await page.evaluate(({workspaceId,sessionId,project,text})=>{
    const scope=JSON.stringify(["workspace",workspaceId]);
    sessionStorage.setItem("cothink.creations",JSON.stringify([[scope,{
      sessionId,options:{workspaceId,handoff:{project,text}},
    }]]));
  },{workspaceId,sessionId:next.id,project:realpathSync(newPath),text:draft});
  await page.reload();
  await page.getByRole("navigation",{name:"工作导航"}).getByRole("button",{name:"项目目录迁移",exact:true}).click();
  await page.getByRole("button",{name:"用新目录继续",exact:true}).click();
  await dialog.getByText(realpathSync(oldPath),{exact:true}).waitFor();
  await dialog.getByRole("button",{name:"新建并复制草稿",exact:true}).click();
  await dialog.getByRole("alert").filter({hasText:/上一次新建已保存/}).waitFor();
  assert.equal((await c.sessions({workspaceId})).items.length,2);
  assert.equal(f.calls.length,0);
});
