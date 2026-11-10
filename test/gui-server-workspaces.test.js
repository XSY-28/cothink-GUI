import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, realpathSync, rmSync, renameSync, symlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repository } from "./helpers/git-fixture.js";
import { GUI_INPUT_VERSION } from "../src/gui-turn-options.js";
import { fixtureConversation, fixtureWorkspace, prepareSubmit } from "./helpers/gui-controller-fixture.js";
import { completed, host } from "./gui-server.fixture.js";

test("navigation HTTP routes retain safe conflict codes and distinguish null-project pagination",async t=>{
  const f=await host(t,true), {createApi}=await import("../gui/src/api.js");
  const api=createApi(f.h.token,(path,options)=>fetch(f.origin+path,options));
  const s=await fixtureConversation(t,f);
  await assert.rejects(api.action("session.close",{sessionId:s.id}),e=>e.code==="SESSION_STATE_UNAVAILABLE" && e.status===409 && e.unknown===false);
  const emptyArchive=await api.action("session.archive",{sessionId:s.id,archived:true,expectedRevision:0});
  assert.equal(emptyArchive.navigation.archived,true);
  await api.action("session.archive",{sessionId:s.id,archived:false,expectedRevision:1});
  const run=await f.action("task.submit",await prepareSubmit(f,{sessionId:s.id,input:"HTTP navigation",submissionId:"nav-http"}));
  await completed(f,run.taskId);
  const archived=await api.action("session.archive",{sessionId:s.id,archived:true,expectedRevision:2});
  const history=await seedUngroupedHistory(f.home,"HTTP ungrouped history");
  const page=await api.read("sessions",{workspaceId:s.workspaceId,archived:"archived",query:"HTTP",limit:1});
  assert.deepEqual(page.items.map(row=>row.id),[s.id]);
  const ungrouped=await api.read("sessions",{project:"",query:"HTTP",limit:1});
  assert.deepEqual(ungrouped.items.map(row=>row.id),[history.getSessionId()]);
  await assert.rejects(api.action("session.pin",{sessionId:s.id,pinned:true,expectedRevision:0}),e=>e.code==="SESSION_STATE_CONFLICT" && e.status===409);
  await assert.rejects(api.read("sessions",{cursor:"invalid"}),e=>e.code==="CURSOR_EXPIRED" && e.status===409);
  for(const params of [{limit:101},{limit:0},{archived:"yes"},{query:"x".repeat(201)}]) await assert.rejects(api.read("sessions",params));
  const recovered=await api.action("session.archive",{sessionId:s.id,archived:false,expectedRevision:archived.navigation.revision});
  assert.equal(recovered.navigation.archived,false);
  assert.equal(f.calls.length,1);
});

test("workspace actions preserve auth, current conflict entries and unavailable table errors", async t => {
  const f = await host(t, true), workspaceId = randomUUID();
  const parent=repository(t), replacement=repository(t);
  const create = {workspaceId, name:"学习", project:realpathSync(parent.project), defaultRosterId:null};
  const post = async (action, args, authorized = true) => {
    const response = await fetch(f.origin + "/api/action", {method:"POST",
      headers:{"Content-Type":"application/json", "X-CoThink-GUI-Input":GUI_INPUT_VERSION, ...(authorized ? f.headers : {})},
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
  const path=realpathSync(replacement.project);
  const oldBind=await post("workspace.bind",{workspaceId,expectedRevision:0,path});
  assert.equal(oldBind.status,409);
  assert.equal(oldBind.body.code,"WORKSPACE_CONFLICT");
  assert.equal((await f.action("workspace.rebind",{workspaceId,expectedRevision:0,path,operationId:randomUUID()})).revision,1);
  const conflict = await post("workspace.update",{workspaceId,expectedRevision:0,change:{name:"Stale"}});
  assert.equal(conflict.status,409);
  assert.equal(conflict.body.code,"WORKSPACE_CONFLICT");
  assert.equal(conflict.body.workspace.revision,1);
  const session = await fixtureConversation(t,f,{workspace:{id:workspaceId}});
  const separate = await fixtureConversation(t,f);
  const independent=await prepareSubmit(f,{sessionId:separate.id,input:"Independent Team conversation"});
  await f.action("workspace.update",{workspaceId,expectedRevision:1,change:{archived:true}});
  const submit = () => post("task.submit",{sessionId:session.id,input:"Must not run",protocolVersion:1, submissionId:randomUUID(),editorEditId:randomUUID()});
  const archivedSubmit = await submit();
  assert.equal(archivedSubmit.status,409);
  assert.equal(archivedSubmit.body.code,"WORKSPACE_ARCHIVED");
  const blocked = await post("session.create",{sessionId:randomUUID(),workspaceId});
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
  const blockedIndependent = await post("task.submit",independent);
  assert.equal(blockedIndependent.status,409);
  assert.equal(blockedIndependent.body.code,"WORKSPACE_UNAVAILABLE");
  assert.equal(f.calls.length,0);
  assert.equal(readFileSync(join(f.home,"gui-workspaces.json"),"utf8"),damaged);
});

test("workspace bootstrap keeps the repository index unchanged", async t => {
  const f = await host(t,true), repo = repository(t);
  await fixtureWorkspace(t,f,{project:repo.project});
  const index = join(repo.project,".git/index");
  const original = readFileSync(index);
  const changedMtime = new Date(Date.now() + 60000);
  utimesSync(join(repo.project,"a.txt"),changedMtime,changedMtime);
  const response = await fetch(f.origin+"/api/bootstrap",{headers:f.headers});
  assert.equal(response.status,200);
  assert.equal((await response.json()).workspaces[0].projectAvailable,true);
  assert.deepEqual(readFileSync(index),original);
});

test("a replaced workspace path allows plain chat but cannot redirect project reads or plugin execution", async t => {
  const f = await host(t,true), repo = repository(t), replacement = repository(t);
  const session = await fixtureConversation(t,f,{project:repo.project});
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
    ["task.submit",{input:"Must not read a different repository",protocolVersion:1,submissionId:randomUUID(),editorEditId:randomUUID(),
      readAuthorization:{paths:["."]}}],
    ["extension.command",{input:"/must-not-run"}],
  ]) {
    const response = await fetch(f.origin+"/api/action",{method:"POST",
      headers:{...f.headers,"Content-Type":"application/json", "X-CoThink-GUI-Input":GUI_INPUT_VERSION},
      body:JSON.stringify({action,args:{sessionId:session.id,...args}})});
    assert.equal(response.status,409,await response.clone().text());
    assert.equal((await response.json()).code,"WORKSPACE_UNAVAILABLE");
  }
  assert.equal(f.calls.length,0);
  const plain=await f.action("task.submit",await prepareSubmit(f,{sessionId:session.id,input:"Ordinary question"}));
  assert.equal((await completed(f,plain.taskId)).status,"completed");
  assert.equal(f.calls.length,1);
  assert.ok(!f.calls[0].body.tools.some(tool=>tool.function.name==="read_project_context"));
});

test("HTTP reading records reject stale revisions with a safe conflict code", async t => {
  const f=await host(t);
  const s=await fixtureConversation(t,f,{defaultRosterId:null});
  const args={sessionId:s.id,expectedViewRevision:s.viewRevision,opened:true};
  const saved=await f.action("session.view",args);
  assert.equal(saved.viewRevision,s.viewRevision+1);
  const stale=await fetch(f.origin+"/api/action",{method:"POST",
    headers:{...f.headers,"Content-Type":"application/json", "X-CoThink-GUI-Input":GUI_INPUT_VERSION},body:JSON.stringify({action:"session.view",args})});
  assert.equal(stale.status,409);
  assert.equal((await stale.json()).code,"VIEW_CONFLICT");
  assert.equal(f.calls.length,0);
});

test("older HTTP clients can read history but cannot overwrite a v2 draft or submit", async t=>{
  const f=await host(t,true), s=await fixtureConversation(t,f);
  const editId=randomUUID();
  await f.action("session.draft",{sessionId:s.id,editorVersion:2,editId,text:"private draft",workRequest:null,
    selectionId:null,materials:[],expectedDraftRevision:s.draftRevision,branchAnchor:s.branchAnchor});
  const staleActions=[
    ["session.draft",{sessionId:s.id,editorVersion:2,editId:randomUUID(),text:"overwrite",workRequest:null,selectionId:null,materials:[],
      expectedDraftRevision:(await f.get("/api/session?id="+s.id)).draftRevision,branchAnchor:s.branchAnchor}],
    ["task.submit",{sessionId:s.id,input:"private draft",protocolVersion:1,submissionId:"stale",editorEditId:editId,materials:[],
      constraints:{readOnly:false,allowedSubtasks:["review","work"],requireDifferentModelReview:false},budget:{maxCalls:null}}],
  ];
  for(const [action,args] of staleActions){
    const response=await fetch(f.origin+"/api/action",{method:"POST",headers:{...f.headers,"Content-Type":"application/json","X-CoThink-GUI-Input":"2"},
      body:JSON.stringify({action,args})});
    assert.equal(response.status,409);
    assert.equal((await response.json()).code,"GUI_INPUT_UPGRADE");
  }
  const response=await fetch(f.origin+"/api/session?id="+s.id,{headers:f.headers});
  assert.equal(response.status,200);
  const saved=await response.json();
  assert.equal(saved.editor.editId,editId);
  assert.equal(saved.editor.text,"private draft");
  assert.equal(f.calls.length,0);
});

test("new HTTP conversation writes require an explicit Team and safe parent directory", async t => {
  const f=await host(t,true), workspaceId=randomUUID();
  const root=mkdtempSync(join(tmpdir(),"cothink-explicit-team-"));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const post=async (action,args,version=GUI_INPUT_VERSION)=>{
    const response=await fetch(f.origin+"/api/action",{method:"POST",headers:{...f.headers,"Content-Type":"application/json",
      "X-CoThink-GUI-Input":version},body:JSON.stringify({action,args})});
    return {status:response.status,body:await response.json()};
  };
  const team={workspaceId,name:"Owns each new conversation",defaultRosterId:null};
  assert.equal((await post("workspace.create",{...team,project:null})).status,409);
  assert.equal((await post("workspace.create",{...team,project:f.home})).status,409);
  assert.equal((await post("session.create",{sessionId:randomUUID(),workspaceId:null})).status,409);
  assert.equal((await post("session.create",{project:root})).status,409);
  assert.equal((await post("project.prepare",{action:"preview",operationId:randomUUID(),path:root})).status,409);
  const before=await f.get("/api/bootstrap");
  assert.deepEqual(before.workspaces,[]);
  const made=await f.action("workspace.create",{...team,project:root});
  assert.equal((await post("session.create",{sessionId:randomUUID(),workspaceId:made.id},"2")).body.code,"GUI_INPUT_UPGRADE");
  const room=await f.action("session.create",{sessionId:randomUUID(),workspaceId:made.id});
  assert.equal(room.workspaceId,made.id);
  assert.equal(room.teamDirectory,made.project);
  assert.notEqual(room.project,made.project);
  assert.equal(f.calls.length,0);
});

test("home Team transfer preserves constraints and exact original material references across recovery",async t=>{
  const f=await host(t,true), draftId=randomUUID(), sessionId=randomUUID(), workspaceId=randomUUID();
  const project=mkdtempSync(join(tmpdir(),"cothink-handoff-team-"));
  t.after(()=>rmSync(project,{recursive:true,force:true}));
  await f.action("workspace.create",{workspaceId,project,name:"First Team",defaultRosterId:null});
  const otherProject=mkdtempSync(join(tmpdir(),"cothink-other-team-"));
  t.after(()=>rmSync(otherProject,{recursive:true,force:true}));
  const other=await f.action("workspace.create",{workspaceId:randomUUID(),project:otherProject,name:"Other Team",defaultRosterId:null});
  const turnOptions={id:randomUUID(),readOnly:true,delegate:false,maxCalls:"2"};
  const editor={editorVersion:2,text:"/skill:doc-maintenance 核对附件",editId:randomUUID(),workRequest:null,selectionId:null,turnOptions,materials:[]};
  const original=await f.action("home.draft",{draftId,expectedRevision:null,editor});
  const bytes=Buffer.from("附件原文\r\n"), sha256=createHash("sha256").update(bytes).digest("hex");
  const upload={ownerId:draftId,uploadId:randomUUID(),name:"evidence.txt",mediaType:"text/plain",byteLength:bytes.length,sha256};
  const pending=await f.action("material.begin",upload);
  const reservation=await f.action("home.reserve",{draftId,expectedRevision:original.revision,sessionId,workspaceId});
  const reject=async (action,args,code)=>{
    const response=await fetch(f.origin+"/api/action",{method:"POST",headers:{...f.headers,"Content-Type":"application/json",
      "X-CoThink-GUI-Input":GUI_INPUT_VERSION},body:JSON.stringify({action,args})});
    assert.equal(response.status,409,await response.clone().text());
    assert.equal((await response.json()).code,code);
  };
  await reject("session.create",{sessionId,workspaceId:other.id,homeDraftId:draftId},"DRAFT_CONFLICT");
  await reject("session.create",{sessionId,workspaceId},"DRAFT_CONFLICT");
  const room=await f.action("session.create",{sessionId,workspaceId,homeDraftId:draftId});
  const status=()=>f.get("/api/session-creation?id="+sessionId);
  assert.equal((await status()).session.workspaceId,workspaceId);
  const transfer={draftId,expectedRevision:reservation.revision,sessionId};
  await reject("home.transfer",transfer,"MATERIAL_PENDING");
  assert.equal((await f.get("/api/bootstrap")).homeDraft.pendingCreateSessionId,sessionId);
  const binary=await fetch(f.origin+"/api/materials?ownerId="+draftId+"&uploadId="+upload.uploadId,{
    method:"POST",headers:{...f.headers,"Content-Type":"application/octet-stream","X-CoThink-GUI-Input":GUI_INPUT_VERSION},body:bytes});
  assert.equal(binary.status,200,await binary.clone().text());
  const ready=await binary.json();
  assert.equal(ready.id,pending.id);
  const changed=await f.action("home.draft",{draftId,expectedRevision:reservation.revision,
    editor:{...editor,editId:randomUUID(),materials:[{id:ready.id,sha256}]}});
  await reject("home.transfer",transfer,"DRAFT_CONFLICT");
  assert.equal((await f.get("/api/bootstrap")).homeDraft.editor.editId,changed.editor.editId);
  const result=await f.action("home.transfer",{...transfer,expectedRevision:changed.revision});
  assert.equal(result.id,room.id);
  assert.deepEqual(result.editor,changed.editor);
  assert.equal(result.materials[0].ownerId,draftId);
  const content=await fetch(f.origin+"/api/materials?ownerId="+sessionId+"&id="+ready.id+"&sha256="+sha256,{headers:f.headers});
  assert.equal(content.status,200,await content.clone().text());
  assert.deepEqual(Buffer.from(await content.arrayBuffer()),bytes);
  assert.equal((await f.get("/api/bootstrap")).homeDraft,null);
  assert.equal((await status()).session.editor.editId,changed.editor.editId);
  assert.equal(f.calls.length,0);
});

async function seedUngroupedHistory(home,title,draft) {
  const [{SessionManager},{neutralDirectory},{persistNewGuiSession}]=await Promise.all([
    import("@earendil-works/pi-coding-agent"),import("../src/conversation.js"),import("../src/gui-session-persistence.js"),
  ]);
  const directory=join(home,"pi/sessions/main");
  const manager=SessionManager.create(neutralDirectory(home),directory,{id:randomUUID()});
  manager.appendCustomEntry("cothink-project",{project:null});
  manager.appendCustomEntry("cothink-gui-workspace",{workspaceId:null});
  manager.appendCustomEntry("cothink-flow",{flow:"unified",version:1});
  if (title) manager.appendCustomEntry("cothink-title",{title});
  if (draft) manager.appendCustomEntry("cothink-draft",draft);
  return persistNewGuiSession({manager,directory,assertOwned:()=>{}});
}

test("ungrouped historical drafts stay readable but cannot start work or change ownership",async t=>{
  const f=await host(t,true);
  const {sessionWriterBusy}=await import("../src/storage.js");
  const editId=randomUUID(),text="Copyable historical draft";
  const saved=await seedUngroupedHistory(f.home,null,{text,editId});
  const sessionId=saved.getSessionId(),path=saved.getSessionFile(),original=readFileSync(path);
  const historical=await f.get("/api/session?id="+sessionId);
  assert.equal(historical.workspaceId,null);
  assert.equal(historical.draft,text);
  assert.equal(historical.readOnly,true);
  const unavailable=await fetch(f.origin+"/api/action",{method:"POST",headers:{...f.headers,"Content-Type":"application/json",
    "X-CoThink-GUI-Input":GUI_INPUT_VERSION},body:JSON.stringify({action:"context.organize",args:{
      sessionId,operationId:randomUUID(),sourceLeaf:historical.branchAnchor,budget:{maxCalls:1},protocolVersion:1,
    }})});
  assert.equal(unavailable.status,409);
  assert.equal((await unavailable.json()).code,"WORKSPACE_UNAVAILABLE");
  const submit=await fetch(f.origin+"/api/action",{method:"POST",headers:{...f.headers,"Content-Type":"application/json",
    "X-CoThink-GUI-Input":GUI_INPUT_VERSION},body:JSON.stringify({action:"task.submit",args:{
      sessionId,submissionId:randomUUID(),editorEditId:editId,input:text,materials:[],protocolVersion:1,
    }})});
  assert.equal(submit.status,409);
  assert.equal((await submit.json()).code,"WORKSPACE_UNAVAILABLE");
  const folder=mkdtempSync(join(tmpdir(),"cothink-new-owner-"));
  t.after(()=>rmSync(folder,{recursive:true,force:true}));
  const team=await f.action("workspace.create",{workspaceId:randomUUID(),project:folder,name:"New owner",defaultRosterId:null});
  const next=await f.action("session.create",{sessionId:randomUUID(),workspaceId:team.id});
  assert.equal(next.workspaceId,team.id);
  assert.deepEqual(readFileSync(path),original);
  assert.equal(sessionWriterBusy(join(f.home,"pi"),sessionId),false);
  assert.equal(f.calls.length,0);
});
