import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { fixture } from "./helpers/pi-fixture.js";
import { git, repository } from "./helpers/git-fixture.js";
import { createTeamConfig } from "../src/teams.js";
import { saveConfig } from "../src/config.js";
import { startGuiServer } from "../src/gui-server.js";
import { createGuiController } from "../src/gui-controller.js";
import { payloadImageHashes } from "../src/visual-preview.js";
import { editorTurnInput } from "../src/gui-turn-options.js";
import { readTask } from "../src/task.js";
import { invalidUtf8Tree } from "../packages/agent-sync/test/helpers/repository.js";
import { listGuiProjectMaterials, readGuiProjectMaterial } from "../src/gui-materials.js";
import { readProjectContext } from "../src/versioning.js";

const hash=bytes=>createHash("sha256").update(bytes).digest("hex");
const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAFElEQVR42mNklAtgYGBgYmBgQFAACEIAdYij2wsAAAAASUVORK5CYII=","base64");
const editor=(materials=[],text="")=>({editorVersion:2,text,materials,workRequest:null,selectionId:null,editId:randomUUID()});

async function setup(t,controllerOptions={}, modelHandler){
  const f=await fixture(t,modelHandler);
  const config=createTeamConfig({formatVersion:2,...f.models},"fixture",randomUUID());
  saveConfig(f.home,config);
  const path=join(f.home,"pi","models.json"),catalog=JSON.parse(readFileSync(path,"utf8"));
  for(const model of catalog.providers.fixture.models)model.input.push("image");
  writeFileSync(path,JSON.stringify(catalog));
  const assets=join(f.home,"assets");mkdirSync(assets);writeFileSync(join(assets,"index.html"),"<!doctype html><title>fixture</title>");
  let host,origin,headers;
  async function restart(){
    if(host)await host.close();
    const controller=await createGuiController({home:f.home,cwd:f.cwd,...controllerOptions});
    host=await startGuiServer({home:f.home,cwd:f.cwd,open:false,assetDirectory:assets,controller});
    origin=new URL(host.url).origin;
    headers={Authorization:`Bearer ${host.token}`,Origin:origin,"X-CoThink-GUI-Input":"2"};
  }
  await restart();t.after(()=>host.close());
  const request=(path,opts={})=>fetch(origin+path,{...opts,headers:{...headers,...opts.headers}});
  const get=(kind,args={})=>request("/api/"+kind+"?"+new URLSearchParams(args));
  const action=(action,args={})=>request("/api/action",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action,args})});
  const ok=async response=>{const r=await response;assert.equal(r.status,200,await r.clone().text());return r.json();};
  const begin=(ownerId,bytes,name,mediaType,uploadId=randomUUID())=>({ownerId,uploadId,byteLength:bytes.length,sha256:hash(bytes),name,mediaType});
  const upload=(intent,bytes,more={})=>request("/api/materials?"+new URLSearchParams({ownerId:intent.ownerId,uploadId:intent.uploadId}),{method:"POST",headers:{"Content-Type":"application/octet-stream",...more},body:bytes});
  const open=(id,project=null)=>ok(action("session.create",{sessionId:id,project}));
  async function complete(id){
    for(let attempt=0;attempt<500;attempt++){
      const result=await ok(get("task",{id}));
      if(result.status!=="running")return result;
      await new Promise(r=>setTimeout(r,10));
    }
    throw Error("task unsettled");
  }
  return {...f,restart,request,get,action,ok,begin,upload,open,complete};
}

test("authenticated HTTP upload is recoverable across restart and home transfer, with immutable task refs",async t=>{
 const f=await setup(t),draftId=randomUUID(),sessionId=randomUUID();
 let home=await f.ok(f.action("home.draft",{draftId,expectedRevision:null,editor:editor()}));
 const image=f.begin(draftId,png,"proof.png","image/png");
 assert.equal((await f.upload(image,png)).status,404,"begin must be durable before upload");
 await f.ok(f.action("material.begin",image));
 await f.restart();
 assert.equal((await f.ok(f.get("bootstrap"))).homeDraft.materialUploads[0].uploadId,image.uploadId);
 assert.equal((await f.ok(f.get("capabilities",{draftId}))).phase,"next-turn");
 assert.equal((await f.upload(image,png,{Origin:"https://foreign.example"})).status,403);
 const ready=await f.ok(f.upload(image,png));
 await f.restart();
 assert.equal((await f.ok(f.get("materials",{ownerId:draftId,uploadId:image.uploadId}))).status,"ready");
 assert.equal((await f.ok(f.get("bootstrap"))).homeDraft.materialUploads[0].status,"unknown");
 assert.equal((await f.ok(f.get("materials",{ownerId:draftId}))).find(r=>r.uploadId===image.uploadId).id,ready.id);
 const ref={id:ready.id,sha256:ready.sha256},wanted=editor([ref]);
 home=await f.ok(f.action("home.draft",{draftId,expectedRevision:home.revision,editor:wanted}));
 home=await f.ok(f.action("home.reserve",{draftId,expectedRevision:home.revision,sessionId,workspaceId:null}));
 await f.ok(f.action("session.create",{sessionId,workspaceId:null,homeDraftId:draftId}));
 const session=await f.ok(f.action("home.transfer",{draftId,expectedRevision:home.revision,sessionId}));
 assert.deepEqual(session.editor.materials,[ref]);assert.equal(session.materials[0].name,"proof.png");
 assert.equal((await f.get("materials",{ownerId:draftId,id:ref.id})).status,404);
 assert.deepEqual(Buffer.from(await (await f.get("materials",{ownerId:sessionId,id:ref.id})).arrayBuffer()),png);
 const id=randomUUID(),submit={sessionId,submissionId:id,protocolVersion:1,input:"",editorEditId:wanted.editId,materials:[ref]};
 const changed=await f.action("task.submit",{...submit,materials:[]});assert.equal(changed.status,409);
 const accepted=await f.ok(f.action("task.submit",submit)),result=await f.complete(accepted.taskId);
 assert.equal(result.status,"completed",result.error);assert.equal(result.materials[0].id,ref.id);
 assert.ok(payloadImageHashes(f.calls[0].body).has(ref.sha256));
 assert.equal((await f.ok(f.action("task.submit",submit))).taskId,accepted.taskId);
 assert.equal((await f.action("task.submit",{...submit,input:"changed"})).status,409);
 assert.equal(f.calls.length,1);
 const other=randomUUID();await f.open(other);
 assert.equal((await f.get("materials",{ownerId:other,id:ref.id,taskId:accepted.taskId})).status,404);
 const fork=await f.ok(f.action("session.fork",{sessionId,taskId:accepted.taskId}));
 assert.deepEqual(Buffer.from(await (await f.get("materials",{ownerId:fork.id,id:ref.id,taskId:accepted.taskId})).arrayBuffer()),png);
});

test("project copy import checks exact preview bytes and folder identity; fixed selection rejects version drift",async t=>{
 const f=await setup(t),repo=repository(t),sessionId=randomUUID();
 const path=realpathSync(repo.project);
 await f.open(sessionId,path);
 const current=join(path,"a.txt");writeFileSync(current,"uncommitted preview\n");
 const select={ownerId:sessionId,source:"current",path:"a.txt"};
 const list=await f.ok(f.action("project.materials",{ownerId:sessionId,source:"current"}));
 assert.ok(list.entries.some(entry=>entry.path==="a.txt"));
 const preview=await f.get("project-material",select);assert.equal(preview.status,200,await preview.clone().text());
 assert.equal(await preview.text(),"uncommitted preview\n");
 const selected={path:"a.txt",sha256:preview.headers.get("x-cothink-content-hash"),sourceToken:preview.headers.get("x-cothink-material-source"),uploadId:randomUUID()};
 writeFileSync(current,"changed disk\n");
 const rejected=await f.action("project.material.import",{ownerId:sessionId,source:"current",paths:[selected]});
 assert.equal(rejected.status,409,await rejected.clone().text());
 writeFileSync(current,"uncommitted preview\n");
 const [imported]=await f.ok(f.action("project.material.import",{ownerId:sessionId,source:"current",paths:[selected]}));
 assert.equal(imported.sha256,hash(Buffer.from("uncommitted preview\n")));
 if(process.platform!=="win32"){
   symlinkSync(join(f.home,"pi","models.json"),join(path,"escape.json"));
   assert.equal((await f.get("project-material",{...select,path:"escape.json"})).status,400);
 }
 const saved=await f.ok(f.action("project.materials",{ownerId:sessionId,source:"saved"}));
 const fixed=await f.get("project-material",{ownerId:sessionId,source:"saved",path:"a.txt",version:saved.version});
 assert.equal(fixed.status,200,await fixed.clone().text());
 assert.equal(await fixed.text(),"base A\n");
 const session=await f.ok(f.get("session",{id:sessionId}));
 const chosen={...editor([],"read fixed version"),turnOptions:{id:randomUUID(),readAllowed:true,readPaths:"a.txt",readProject:path,readWorkspaceId:session.workspaceId,readVersion:saved.version}};
 await f.ok(f.action("session.draft",{sessionId,...chosen,expectedDraftRevision:session.draftRevision,branchAnchor:session.branchAnchor}));
 git(path,"add","a.txt");git(path,"commit","-m","advance fixture only");
 const send=await f.action("task.submit",{sessionId,input:chosen.text,submissionId:randomUUID(),protocolVersion:1,editorEditId:chosen.editId,
  constraints:{readOnly:false,allowedSubtasks:["review","work"],requireDifferentModelReview:false},budget:{maxCalls:null},readAuthorization:{paths:["a.txt"],version:saved.version}});
 assert.equal(send.status,409,await send.clone().text());
 assert.equal((await send.json()).code,"READ_VERSION");assert.equal(f.calls.length,0);
});

test("fixed-version selection preserves literal paths and text; binary context reads are refused",async t=>{
 const repo=repository(t),root=realpathSync(repo.project),sessionId=randomUUID();
 const chosenPath=" docs/example.py",differentPath="docs/private.txt",commaPath="guide,notes.txt",imagePath=" docs/pixel.png";
 const input="Read the authorized fixed version",source="\n    print('fixture')\n";
 mkdirSync(join(root," docs"));mkdirSync(join(root,"docs"));
 for(const [path,body] of [[chosenPath,source],[differentPath,"PRIVATE_MARKER"],[commaPath,"comma-name fixture"],[imagePath,png]])
   writeFileSync(join(root,path),body);
 git(root,"status","--porcelain");
 git(root,"add","--",chosenPath,differentPath,commaPath,imagePath);
 git(root,"commit","-m","audit fixture with exact path spellings");
 const paths=[chosenPath,differentPath,commaPath,imagePath];
 const f=await setup(t,{},(_,n)=>n===1?{toolCalls:paths.map(path=>({
   name:"read_project_context",args:{operation:"read",paths:[path]},
 }))}:{text:"fixture answer"});
 const session=await f.open(sessionId,root);
 const saved=await f.ok(f.action("project.materials",{ownerId:sessionId,source:"saved"}));
 const scoped=await f.ok(f.action("project.materials",{ownerId:sessionId,source:"saved",path:" docs",version:saved.version}));
 assert.ok(saved.entries.some(entry=>entry.path===commaPath));
 assert.ok(scoped.entries.some(entry=>entry.path===chosenPath));
 assert.ok(!scoped.entries.some(entry=>entry.path===imagePath),"the saved-version text picker does not offer images");
 const location={project:root,workspaceId:session.workspaceId};
 const options={id:randomUUID(),readAllowed:true,readPaths:[" docs",commaPath],readProject:root,
   readWorkspaceId:session.workspaceId,readVersion:saved.version};
 assert.deepEqual(editorTurnInput({...options,readPaths:" docs"},location).readAuthorization.paths,[" docs"],"old picker values remain literal");
 const chosen={...editor([],input),turnOptions:options};
 await f.ok(f.action("session.draft",{sessionId,...chosen,expectedDraftRevision:session.draftRevision,branchAnchor:session.branchAnchor}));
 const result=await f.ok(f.action("task.submit",{sessionId,input,submissionId:randomUUID(),protocolVersion:1,editorEditId:chosen.editId,
   ...editorTurnInput(options,location)}));
 assert.equal((await f.complete(result.taskId)).status,"completed");
 assert.deepEqual(readTask(f.home,result.taskId).readAuthorization.paths,[" docs",commaPath]);
 const responses=f.calls[1].body.messages.filter(message=>message.role==="tool").map(message=>message.content);
 assert.deepEqual(JSON.parse(responses[0]).items.map(({text})=>text),source.split("\n"));
 assert.match(responses[1],/unauthorized/);
 assert.ok(!responses.some(response=>response.includes("PRIVATE_MARKER")));
 assert.equal(JSON.parse(responses[2]).items[0].path,commaPath);
 assert.match(responses[3],/UTF-8 text/);
});

test("saved material listing and context reads never alias a malformed filename to a selected name",async t=>{
 const {home,project}=repository(t),root=realpathSync(project);
 const {version,validName}=await invalidUtf8Tree(root),stat=statSync(root,{bigint:true});
 const saved={source:"saved",root,path:root,scope:".",version,identity:[String(stat.dev),String(stat.ino)]};
 const readAuthorization={version,canonicalRepo:root,paths:[validName]};
 const task={home,record:{readAuthorization}};
 const result=await readProjectContext(task,{operation:"read",paths:[validName]});
 assert.deepEqual(result.items,[{path:validName,line:1,text:"AUTHORIZED"}]);
 const listing=await listGuiProjectMaterials(saved);
 assert.deepEqual(listing.entries.map(({path,fileCount})=>[path,fileCount]),[[validName,1]]);
});

test("saved material and ordinary Git context reads ignore replacement refs",async t=>{
 const {home,project,baseVersion:version}=repository(t),root=realpathSync(project);
 const authorized=git(root,"rev-parse",version+":a.txt"),unselected=git(root,"rev-parse",version+":b.txt");
 git(root,"status","--porcelain");
 git(root,"replace",authorized,unselected);
 assert.equal(git(root,"cat-file","blob",authorized),"base B");
 const readAuthorization={version,canonicalRepo:root,paths:["a.txt"]};
 const result=await readProjectContext({home,record:{readAuthorization}},{operation:"read",paths:["a.txt"]});
 assert.deepEqual(result.items.map(({text})=>text),["base A",""]);
 const stat=statSync(root,{bigint:true}),saved={source:"saved",root,path:root,scope:".",version,identity:[String(stat.dev),String(stat.ino)]};
 assert.equal((await readGuiProjectMaterial(saved,"a.txt")).bytes.toString(),"base A\n");
});

test("a lost ready response is recoverable, while a removed attachment never reappears on replay",async t=>{
 const f=await setup(t),sessionId=randomUUID(),bytes=Buffer.from("preserved even after remove");
 let session=await f.open(sessionId);
 const intent=f.begin(sessionId,bytes,"report.txt","text/plain");
 await f.ok(f.action("material.begin",intent));
 await f.ok(f.upload(intent,bytes));
 await f.restart();
 session=await f.ok(f.get("session",{id:sessionId}));
 const [outstanding]=session.materialUploads;
 assert.equal(outstanding.uploadId,intent.uploadId);assert.equal(outstanding.status,"unknown");
 const ready=await f.ok(f.get("materials",{ownerId:sessionId,uploadId:intent.uploadId}));
 const ref={id:ready.id,sha256:ready.sha256};
 session=await f.ok(f.action("session.draft",{sessionId,...editor([ref]),expectedDraftRevision:session.draftRevision,branchAnchor:session.branchAnchor}));
 assert.deepEqual(session.materialUploads,[]);
 const oldBytes=await f.get("materials",{ownerId:sessionId,id:ready.id});
 assert.equal(await oldBytes.text(),bytes.toString());
 session=await f.ok(f.action("session.draft",{sessionId,...editor(),expectedDraftRevision:session.draftRevision,branchAnchor:session.branchAnchor}));
 assert.deepEqual(session.materials,[]);
 assert.equal((await f.ok(f.upload(intent,bytes))).id,ready.id);
 await f.restart();
 const after=await f.ok(f.get("session",{id:sessionId}));
 assert.deepEqual(after.materialUploads,[]);assert.deepEqual(after.materials,[]);
 assert.equal((await f.get("materials",{ownerId:sessionId,id:ready.id})).status,404);
 assert.equal((await f.ok(f.get("materials",{ownerId:sessionId,uploadId:intent.uploadId}))).status,"ready");
 const saved=(await f.ok(f.get("materials",{ownerId:sessionId}))).find(row=>row.id===ready.id);
 assert.equal(saved.acknowledged,true);
});

test("replacing a selected directory with identical file bytes invalidates its current-copy preview",async t=>{
 const f=await setup(t),sessionId=randomUUID(),root=join(realpathSync(f.home),"project");
 mkdirSync(root);writeFileSync(join(root,"a.txt"),"same");
 await f.open(sessionId,root);
 const preview=await f.get("project-material",{ownerId:sessionId,source:"current",path:"a.txt"});
 assert.equal(preview.status,200,await preview.clone().text());
 const row={path:"a.txt",sha256:preview.headers.get("x-cothink-content-hash"),sourceToken:preview.headers.get("x-cothink-material-source"),uploadId:randomUUID()};
 renameSync(root,root+"-old");mkdirSync(root);writeFileSync(join(root,"a.txt"),"same");
 const result=await f.action("project.material.import",{ownerId:sessionId,source:"current",paths:[row]});
 assert.equal(result.status,409,await result.clone().text());
});

test("settings actions expose local skill, execution and fake OAuth states through authenticated HTTP",async t=>{
 let inspected;
 const f=await setup(t,{
  oauthRuntime:async()=>({getProvider:()=>({auth:{oauth:{login:true}}}),async login(_provider,_kind,ui){
   ui.notify({type:"auth_url",url:"https://example.test/authorize?state=state-only-in-link"});
   assert.equal(await ui.prompt({type:"text"}),"local fixture");
  }}),
  executionInspector:async(_home,options)=>(inspected=options,{diagnostic:{status:"ok"},probe:{status:options.probe?"passed":"not_run"}}),
 });
 const initial=await f.ok(f.get("bootstrap"));assert.deepEqual(initial.oauthOperations,[]);
 const probe=await f.ok(f.action("settings.inspectExecution",{probe:true}));
 assert.equal(probe.probe.status,"passed");assert.equal(inspected.probe,true);
 const skillDirectory=join(f.home,"fixture-skill");mkdirSync(skillDirectory);
 const skill=join(skillDirectory,"SKILL.md");writeFileSync(skill,"---\nname: fixture-skill\ndescription: test local skill\n---\nRead this only on request.\n");
 await f.ok(f.action("settings.localSkills",{paths:[skill]}));
 const boot=await f.ok(f.get("bootstrap"));assert.deepEqual(boot.localSkillPaths,[skill]);
 assert.ok((await f.ok(f.get("capabilities"))).skills.some(row=>row.name==="fixture-skill"));
 const started=await f.ok(f.action("oauth.start",{providerId:"fixture"}));
 let state;
 for(let i=0;i<40;i++){
   state=await f.ok(f.action("oauth.query",{operationId:started.operationId}));
   if(state.prompt)break;
   await new Promise(resolve=>setTimeout(resolve,10));
 }
 assert.ok(state.prompt);assert.doesNotMatch(JSON.stringify(state),/state-only-in-link/);
 const link=await f.ok(f.action("oauth.open",{operationId:started.operationId}));
 assert.equal(new URL(link.url).origin,"https://example.test");
 await f.ok(f.action("oauth.respond",{operationId:started.operationId,promptId:state.prompt.id,value:"local fixture"}));
 for(let i=0;i<40;i++){
   state=await f.ok(f.action("oauth.query",{operationId:started.operationId}));
   if(state.status==="saved")break;
   await new Promise(resolve=>setTimeout(resolve,10));
 }
 assert.equal(state.status,"saved");assert.equal(f.calls.length,0);
});
