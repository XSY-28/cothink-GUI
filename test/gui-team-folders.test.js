import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,renameSync,rmSync,writeFileSync} from "node:fs";
import {dirname,join} from "node:path";
import {tmpdir} from "node:os";
import {controller,finished,prepareSubmit,teamId} from "./helpers/gui-controller-fixture.js";
import {execution} from "./helpers/agent-sync-fixture.js";
import {fixture} from "./helpers/pi-fixture.js";
import {createConversationFolder,placeConversationDelivery,requireConversationFileWork} from "../src/gui-work.js";
import {git} from "../packages/agent-sync/src/git.js";

const tool=(name,args={})=>({toolCalls:[{name,args}]});
test("a Team owns one folder per conversation and accepted work lands in its own folder",async t=>{
  const folder=realpathSync(mkdtempSync(join(tmpdir(),"cothink-team-folders-")));
  t.after(()=>rmSync(folder,{recursive:true,force:true}));
  writeFileSync(join(folder,"keep.txt"),"Team parent");
  let pendingPlan=false;
  const f=await fixture(t,(_,n)=>pendingPlan?tool("start_work",{action:"start",reason:"deliver pending file",plan:{
    goal:"Create pending.txt",scope:["pending.txt"],deliverables:["pending.txt"],checks:[
      {command:"node",args:["-e","require('fs').accessSync('pending.txt')"]},
    ],
  }}):[
    tool("start_work",{action:"start",reason:"deliver file",plan:{goal:"Create index.html",scope:["index.html"],deliverables:["index.html"],checks:[
      {command:"node",args:["-e","require('fs').accessSync('index.html')"]},
    ]}}),
    tool("write",{path:"index.html",content:"<h1>本地成果</h1>\n"}),
    tool("accept_change"),tool("accept_change"),{text:"文件已完成"},
  ][n-1]??{text:"文件已完成"});
  const c=await controller(t,f,{work:{execution}});
  const workspaceId=randomUUID();
  await c.action("workspace.create",{workspaceId,name:"会话目录",project:folder,defaultRosterId:teamId});
  const a=await c.action("session.create",{workspaceId,sessionId:randomUUID()});
  const b=await c.action("session.create",{workspaceId,sessionId:randomUUID()});
  assert.equal(dirname(a.project),folder);
  assert.equal(dirname(b.project),folder);
  assert.notEqual(a.project,b.project);
  assert.ok(existsSync(a.project)&&existsSync(b.project));
  assert.equal(f.calls.length,0);
  const started=await c.action("task.submit",await prepareSubmit(c,{sessionId:a.id,input:"请生成 index.html，不允许联网。",protocolVersion:1,submissionId:"folder-proposal"}));
  const proposal=await finished(c,started.taskId);
  assert.ok(proposal.proposalRef,proposal.error);
  const confirmArgs={sessionId:a.id,protocolVersion:1,submissionId:"folder-confirm",proposalRef:proposal.proposalRef};
  const confirmed=await c.action("task.confirmWork",confirmArgs);
  const result=await finished(c,confirmed.taskId);
  assert.equal(result.status,"completed",result.error);
  assert.equal(readFileSync(join(a.project,"index.html"),"utf8"),"<h1>本地成果</h1>\n");
  assert.equal(existsSync(join(b.project,"index.html")),false);
  assert.equal(existsSync(join(folder,".git")),false);
  assert.equal(readFileSync(join(folder,"keep.txt"),"utf8"),"Team parent");
  const turn=(await c.session(a.id)).turns.find(item=>item.taskId===confirmed.taskId);
  assert.ok(turn?.canFork);
  assert.equal((await c.sessions({workspaceId})).items.length,2);

  pendingPlan=true;
  const pending=await c.action("task.submit",await prepareSubmit(c,{sessionId:b.id,input:"请生成 pending.txt。"}));
  const pendingProposal=await finished(c,pending.taskId);
  assert.ok(pendingProposal.proposalRef,pendingProposal.error);
  const pendingArgs={sessionId:b.id,protocolVersion:1,submissionId:"archived-confirm",proposalRef:pendingProposal.proposalRef};
  const sourcePath=join(f.home,"tasks",pending.taskId+".json");
  const before=readFileSync(sourcePath),calls=f.calls.length;
  const currentB=await c.session(b.id);
  const archivedB=await c.action("session.archive",{sessionId:b.id,expectedRevision:currentB.navigation.revision,archived:true});
  await assert.rejects(c.action("task.confirmWork",pendingArgs),{code:"SESSION_STATE_UNAVAILABLE"});
  assert.ok(readFileSync(sourcePath).equals(before),"an archived conversation cannot reserve a confirmation");
  await c.action("session.archive",{sessionId:b.id,expectedRevision:archivedB.navigation.revision,archived:false});

  const moved=folder+"-moved";
  t.after(()=>rmSync(moved,{recursive:true,force:true}));
  renameSync(folder,moved);
  await assert.rejects(c.action("task.confirmWork",pendingArgs),{code:"WORKSPACE_UNAVAILABLE"});
  assert.ok(readFileSync(sourcePath).equals(before),"an unavailable conversation folder cannot reserve a confirmation");
  await assert.rejects(c.action("session.fork",{sessionId:a.id,taskId:turn.taskId}));
  const currentA=await c.session(a.id);
  await c.action("session.archive",{sessionId:a.id,expectedRevision:currentA.navigation.revision,archived:true});
  const consumedSource=join(f.home,"tasks",started.taskId+".json");
  const savedReceipt=readFileSync(consumedSource);
  assert.deepEqual(await c.action("task.confirmWork",confirmArgs),confirmed,"the consumed receipt is readable after archive and folder loss");
  await assert.rejects(c.action("task.confirmWork",{...confirmArgs,sessionId:b.id}),/提议不属于/);
  await assert.rejects(c.action("task.confirmWork",{...confirmArgs,proposalRef:{...confirmArgs.proposalRef,planDigest:"0".repeat(64)}}),{code:"PROPOSAL_SOURCE"});
  assert.ok(readFileSync(consumedSource).equals(savedReceipt),"the receipt query must not rewrite the original proposal");
  assert.equal(f.calls.length,calls);
});

test("publication does not overwrite a local file with the same name, even if Git ignores it",async t=>{
  const parent=realpathSync(mkdtempSync(join(tmpdir(),"cothink-publish-")));
  t.after(()=>rmSync(parent,{recursive:true,force:true}));
  const f=await fixture(t);
  const folder=createConversationFolder(f.home,parent,randomUUID());
  await requireConversationFileWork(f.home,folder);
  const p=folder.project;
  const text=async(args,input)=>(await git(p,args,input)).toString().trim();
  const base=await text(["rev-parse","HEAD"]);
  const blob=await text(["hash-object","-w","--stdin"],Buffer.from("验收成果\n"));
  const tree=await text(["mktree"],Buffer.from(`100644 blob ${blob}\tindex.html\n`));
  const version=await text(["commit-tree",tree,"-p",base,"-m","Fixture accepted result"]);
  mkdirSync(join(p,".git","info"),{recursive:true});
  writeFileSync(join(p,".git","info","exclude"),"index.html\n");
  writeFileSync(join(p,"index.html"),"用户本地文件\n");
  await assert.rejects(placeConversationDelivery(f.home,folder,version));
  assert.equal(readFileSync(join(p,"index.html"),"utf8"),"用户本地文件\n");
  assert.equal(await text(["rev-parse","HEAD"]),base);
  assert.equal(await text(["cat-file","blob",`${version}:index.html`]),"验收成果");
});
