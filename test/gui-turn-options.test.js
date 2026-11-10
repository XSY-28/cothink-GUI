import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture } from "./helpers/pi-fixture.js";
import { controller, finished, load } from "./helpers/gui-controller-fixture.js";
import { repository } from "./helpers/git-fixture.js";
import { execution } from "./helpers/agent-sync-fixture.js";

const { readTask } = await load("src/task.js");

test('GUI no-work choice leaves answer review available and preserves legacy drafts', async t => {
  const {editorTurnInput}=await load('src/gui-turn-options.js');
  const cases=[
    {name:'direct answer',delegate:'review-only',review:false,allowedSubtasks:['review'],models:['main']},
    {name:'optional review',delegate:'review-only',review:false,requestReview:true,allowedSubtasks:['review'],models:['main','r1','main']},
    // The local fixture can prove dispatch to r1 but cannot certify provider identity.
    {name:'required review',delegate:'review-only',review:true,allowedSubtasks:['review'],models:['main','r1'],error:/无法核实不同实际型号/},
    {name:'legacy restriction',delegate:false,review:false,requestReview:true,allowedSubtasks:[],models:['main','main']},
  ];
  for (const {name,delegate,review,requestReview,allowedSubtasks,models,error} of cases) await t.test(name,async t=>{
    const f=await fixture(t,(_,n)=>requestReview&&n===1
      ? {toolCalls:[{name:'request_review',args:{reason:'check',draft:'draft to review'}}]}
      : {text:'answer'});
    const c=await controller(t,f), session=await c.action('session.create',{project:null});
    const editId=randomUUID();
    await c.action('session.draft',{sessionId:session.id,text:name,expectedDraftRevision:session.draftRevision,
      branchAnchor:session.branchAnchor,editId,workRequest:null,selectionId:null,turnOptions:{id:randomUUID(),delegate,review}});
    const saved=await c.session(session.id);
    const {constraints,budget}=editorTurnInput(saved.editor.turnOptions,{project:saved.project});
    const accepted=await c.action('task.submit',{sessionId:session.id,input:saved.draft,editorEditId:editId,
      submissionId:randomUUID(),protocolVersion:1,constraints,budget});
    const task=await finished(c,accepted.taskId);
    assert.equal(task.status,error?'partial':'completed',task.error);
    if(error)assert.match(task.error,error);
    assert.deepEqual(readTask(f.home,accepted.taskId).constraints,{readOnly:false,allowedSubtasks,requireDifferentModelReview:review});
    assert.deepEqual(f.calls.map(call=>call.body.model),models);
  });
});

test("clear file requests stop before dispatch while questions in the same folder still send", async t => {
  const f = await fixture(t, () => ({ text: "fixture answer" }));
  const c = await controller(t, f);
  const s = await c.action("session.create", { project: f.cwd });
  const input = "给我生成一个自行车骑鹈鹕的html界面，svg图像，不允许联网";
  const editId = randomUUID();
  await c.action("session.draft", {
    sessionId: s.id, text: input, editId,
    expectedDraftRevision: s.draftRevision, branchAnchor: s.branchAnchor,
    workRequest: null, selectionId: null,
  });
  await assert.rejects(c.action("task.submit", {
    sessionId: s.id, input, protocolVersion: 1,
    submissionId: randomUUID(), editorEditId: editId,
  }), { code: "PROJECT_NOT_PREPARED" });
  assert.equal(f.calls.length, 0);
  const after = await c.session(s.id);
  assert.equal(after.editor.text, input);
  assert.equal(after.turns.length, 0);

  const explicit = "把上次讨论的方案落地";
  const explicitEdit = randomUUID();
  await c.action("session.draft", {
    sessionId: s.id, text: explicit, editId: explicitEdit,
    expectedDraftRevision: after.draftRevision, branchAnchor: after.branchAnchor,
    workRequest: null, selectionId: null, turnOptions: {id:randomUUID(), fileWork:true},
  });
  await assert.rejects(c.action("task.submit", {
    sessionId: s.id, input: explicit, protocolVersion: 1,
    submissionId: randomUUID(), editorEditId: explicitEdit,
  }), { code: "PROJECT_NOT_PREPARED" });
  assert.equal(f.calls.length, 0);

  const chatInputs = ["修改 README.md 需要注意什么？", "请生成一份 README.md 示例，贴在聊天里"];
  for (const question of chatInputs) {
    const answer = await c.action("task.submit", {
      sessionId: s.id, input: question, protocolVersion: 1, submissionId: randomUUID(),
    });
    assert.equal((await finished(c, answer.taskId)).status, "completed");
  }
  assert.equal(f.calls.length, chatInputs.length);
});

test("file preflight reads explicit multiline requests without treating examples as actions", async () => {
  const {isGuiFileTask}=await load("src/gui-turn-options.js");
  for(const work of ["请先看需求：\n帮我生成 index.html。","请帮我写个 index.html","请新建\nindex.html",
    "请创建 柔性夹爪.md","Write a summary as summary.md.","Please create README.md."])
    assert.equal(isGuiFileTask(work), true, work);
  for(const chat of [
    "帮我生成 index.html\n不用创建文件，只在聊天里给示例。",
    'Generate a text-only explanation of the term "file" for a beginner.',
    "请解释下面的示例：\n> Create index.html\n```text\n生成一个文件。\n```",
  ]) assert.equal(isGuiFileTask(chat), false, chat);
});

test("network consent is explicit and offline work never dispatches a model request", async t => {
  const {editorTurnInput,guiNetworkChoice}=await load("src/gui-turn-options.js");
  const f=await fixture(t), c=await controller(t,f), session=await c.action("session.create",{project:null});
  const submit=(input,extra={})=>c.action("task.submit",{sessionId:session.id,input,submissionId:randomUUID(),protocolVersion:1,...extra});
  const input="请全程不联网，解释 CSS。";
  for(const offline of [input,"全程不得访问网络，帮我解释 HTML。","请不要访问互联网，用本地知识回答",
    "成品可以离线，生成过程禁止访问互联网。","解释网络访问政策并以“成品必须离线”为例。整次不要联网。"]){
    assert.equal(guiNetworkChoice(offline, {networkMode:"artifact-offline"}), "whole-turn-offline");
    await assert.rejects(submit(offline), /整轮离线/);
  }
  for(const question of ["禁止联网是什么意思？","禁止联网的设置在什么地方？","不要联网是个什么概念？","禁止联网模式如何运行？"])
    assert.equal(guiNetworkChoice(question),null);
  await assert.rejects(submit("请解释 CSS，不允许联网。"), /成品.*整轮|整轮.*成品/);
  assert.equal(f.calls.length,0);
  const mode={id:randomUUID(),networkMode:"artifact-offline"};
  const text="请解释 CSS，不允许联网。";
  const saved=await c.action("session.draft",{sessionId:session.id,text,editId:randomUUID(),
    expectedDraftRevision:session.draftRevision,branchAnchor:session.branchAnchor,workRequest:null,selectionId:null,turnOptions:mode});
  const answer=await submit(text,{...editorTurnInput(saved.editor.turnOptions),editorEditId:saved.editor.editId});
  assert.equal((await finished(c,answer.taskId)).status,"completed");
  assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].body.tools.some(tool=>tool.function.name==="start_work"),false);
  assert.equal(f.calls[0].body.tools.some(tool=>tool.function.name==="request_review"),true);
});

test("unconfigured execution and exhausted proposal budget reject before starting PROJECT", async t=>{
  const plan={goal:"Audit confirmation",scope:["a.txt"],deliverables:["a.txt"],checks:[{command:"node",args:["-e","process.exit(0)"]}]};
  for(const maxCalls of [1,3]) await t.test(String(maxCalls),async t=>{
    const f=await fixture(t,()=>({toolCalls:[{name:"start_work",args:{action:"start",reason:"fixture",plan}}]}));
    const c=await controller(t,f), session=await c.action("session.create",{project:repository(t).project});
    const submit=input=>c.action("task.submit",{sessionId:session.id,input,submissionId:randomUUID(),protocolVersion:1,budget:{maxCalls}});
    await assert.rejects(submit("请修改 a.txt 文件。"), /执行环境/);
    assert.equal(f.calls.length,0);
    const proposed=await submit("按刚刚讨论的需求做。");
    await finished(c,proposed.taskId);
    const turn=(await c.session(session.id)).turns.at(-1);
    assert.ok(turn.proposalRef);
    await assert.rejects(c.action("task.confirmWork",{sessionId:session.id,submissionId:randomUUID(),protocolVersion:1,proposalRef:turn.proposalRef}),
      maxCalls===1?/额度已用完/:/执行环境/);
    assert.equal((await c.session(session.id)).turns.at(-1).confirmationIntent,undefined);
    assert.equal(f.calls.length,1);
  });
});

test("continuing a saved directory blocker checks execution and old network requirements before any new request", async t=>{
  const {writePrivateJson}=await load("src/storage.js");
  const project=realpathSync(mkdtempSync(join(tmpdir(),"cothink-continuation-audit-")));
  t.after(()=>rmSync(project,{recursive:true,force:true}));
  const plan={goal:"Audit continuation",scope:["a.txt"],deliverables:["a.txt"],checks:[{command:"node",args:["-e","process.exit(0)"]}]};
  const f=await fixture(t,(_,n)=>n===1?{toolCalls:[{name:"start_work",args:{action:"start",reason:"fixture",plan}}]}:{text:"unexpected new request"});
  const c=await controller(t,f), session=await c.action("session.create",{project});
  const {taskId}=await c.action("task.submit",{sessionId:session.id,input:"按刚才讨论的做。",submissionId:randomUUID(),protocolVersion:1});
  const blocked=await finished(c,taskId);
  assert.equal(blocked.projectPreparationBlocked?.code,"PROJECT_NOT_PREPARED");
  const operationId=randomUUID(), prep=(action,extra={})=>c.action("project.prepare",{action,operationId,...extra});
  await prep("preview",{path:project});
  await prep("preview",{path:project,selectedPaths:[]});
  await prep("confirm");
  const resume=()=>c.action("task.continuePrepared",{sessionId:session.id,sourceTaskId:taskId,submissionId:randomUUID(),protocolVersion:1});
  await assert.rejects(resume(),{code:"PROJECT_EXECUTION_REQUIRED"});
  await c.action("settings.work",{work:{execution,checks:[]}});
  const source=readTask(f.home,taskId);
  // Older versions could save this blocked request before the new network-choice guard.
  source.input="按刚才讨论的做，不允许联网。";
  writePrivateJson(join(f.home,"tasks",taskId+".json"),source);
  await assert.rejects(resume(),{code:"NETWORK_POLICY"});
  assert.equal((await c.session(session.id)).turns.length,1);
  assert.equal(f.calls.length,1);
});
