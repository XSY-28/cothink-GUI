import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture } from "./helpers/pi-fixture.js";
import { controller, fixtureConversation, fixtureWorkspace, finished, load, prepareSubmit, seedFixtureConversationRepository, submitDraft, teamId } from "./helpers/gui-controller-fixture.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { repository } from "./helpers/git-fixture.js";
import { execution } from "./helpers/agent-sync-fixture.js";

const { readTask } = await load("src/task.js");
const { loadConfig } = await load("src/config.js");

test('retired ordinary review drafts require explicit adoption and preserve no-delegation', async t => {
  const {editorTurnInput}=await load('src/gui-turn-options.js');
  const f=await fixture(t),c=await controller(t,f),session=await fixtureConversation(t, c);
  const choices={id:randomUUID(),delegate:'review-only',review:true};
  const retired=await prepareSubmit(c,{sessionId:session.id,input:'kept old draft',turnOptions:choices});
  assert.deepEqual(editorTurnInput(choices).constraints.allowedSubtasks,[]);
  await assert.rejects(c.action('task.submit',retired),{code:'TURN_CONSTRAINTS'});
  assert.equal((await c.session(session.id)).editor.turnOptions.review,true);
  assert.equal(f.calls.length,0);
  const adopted=await prepareSubmit(c,{sessionId:session.id,input:retired.input,turnOptions:{...choices,delegate:false,review:false}});
  const accepted=await c.action('task.submit',adopted);
  assert.equal((await finished(c,accepted.taskId)).status,'completed');
  assert.deepEqual(readTask(f.home,accepted.taskId).constraints.allowedSubtasks,[]);
  assert.deepEqual(f.calls.map(call=>call.body.model),['main']);
});

test("without an execution environment, file requests stop before dispatch while questions still send", async t => {
  const f = await fixture(t, () => ({ text: "fixture answer" }));
  const c = await controller(t, f);
  const s = await fixtureConversation(t,c);
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
  }), { code: "PROJECT_EXECUTION_REQUIRED" });
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
  }), { code: "PROJECT_EXECUTION_REQUIRED" });
  assert.equal(f.calls.length, 0);

  const chatInputs = ["修改 README.md 需要注意什么？", "请生成一份 README.md 示例，贴在聊天里"];
  for (const question of chatInputs) {
    const answer = await submitDraft(c,{sessionId:s.id,input:question});
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

test("whole-turn offline requests dispatch no models and older explicit choices still work", async t => {
  const {guiNetworkChoice}=await load("src/gui-turn-options.js");
  const f=await fixture(t), c=await controller(t,f), session=await fixtureConversation(t, c);
  const submit=input=>submitDraft(c,{sessionId:session.id,input});
  const input="请全程不联网，解释 CSS。";
  for(const offline of [input,"全程不得访问网络，帮我解释 HTML。","请不要访问互联网，用本地知识回答",
    "成品可以离线，生成过程禁止访问互联网。","解释网络访问政策并以“成品必须离线”为例。整次不要联网。"]){
    assert.equal(guiNetworkChoice(offline, {networkMode:"artifact-offline"}), "whole-turn-offline");
    await assert.rejects(submit(offline), /整轮离线/);
  }
  for(const question of ["禁止联网是什么意思？","禁止联网的设置在什么地方？","不要联网是个什么概念？","禁止联网模式如何运行？"])
    assert.equal(guiNetworkChoice(question),null);
  await assert.rejects(submit("请解释 CSS，不允许联网。"), {code:"NETWORK_POLICY"});
  assert.equal(f.calls.length,0);
  const mode={id:randomUUID(),networkMode:"artifact-offline",readOnly:true};
  const text="请解释 CSS，不允许联网。";
  const answer=await submitDraft(c,{sessionId:session.id,input:text,turnOptions:mode});
  assert.equal((await finished(c,answer.taskId)).status,"completed");
  assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].body.tools.some(tool=>tool.function.name==="start_work"),false);
  assert.equal(f.calls[0].body.tools.some(tool=>tool.function.name==="request_review"),false);
});

test("unconfigured execution and exhausted proposal budget reject before starting PROJECT", async t=>{
  const plan={goal:"Audit confirmation",scope:["a.txt"],deliverables:["a.txt"],checks:[{command:"node",args:["-e","process.exit(0)"]}]};
  for(const maxCalls of [1,3]) await t.test(String(maxCalls),async t=>{
    const f=await fixture(t,()=>({toolCalls:[{name:"start_work",args:{action:"start",reason:"fixture",plan}}]}));
    const c=await controller(t,f), session=seedFixtureConversationRepository(repository(t).project,await fixtureConversation(t,c));
    const submit=input=>submitDraft(c,{sessionId:session.id,input,budget:{maxCalls}});
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
  const c=await controller(t,f), workspace=await fixtureWorkspace(t,c,{project});
  const manager=SessionManager.create(f.cwd,join(f.home,"pi/sessions/main"));
  manager.appendCustomEntry("cothink-project",{project:workspace.project});
  manager.appendCustomEntry("cothink-team",{team:loadConfig(f.home).teams.find(team=>team.id===teamId)});
  manager.appendMessage({role:"user",content:"old work request",timestamp:Date.now()});
  const session=await c.session(manager.getSessionId());
  assert.equal(session.workspaceId,workspace.id);
  const {taskId}=await submitDraft(c,{sessionId:session.id,input:"按刚才讨论的做。"});
  const blocked=await finished(c,taskId);
  assert.equal(blocked.projectPreparationBlocked?.code,"PROJECT_NOT_PREPARED");
  // Recreate the preparation receipt left by an older app.
  const {prepareGuiProject}=await load("src/gui-project-preparation.js");
  const operationId=randomUUID();
  const {expectedTree}=await prepareGuiProject(f.home,{action:"preview",operationId,path:project,selectedPaths:[]});
  await c.action("project.prepare",{action:"confirm",operationId,sessionId:session.id,sourceTaskId:taskId,expectedTree});
  const resume=()=>c.action("task.continuePrepared",{sessionId:session.id,sourceTaskId:taskId,submissionId:randomUUID(),protocolVersion:1});
  await assert.rejects(resume(),{code:"PROJECT_EXECUTION_REQUIRED"});
  await c.action("settings.work",{work:{execution,checks:[]}});
  const source=readTask(f.home,taskId);
  // Older versions could save this blocked request before the new network-choice guard.
  source.input="按刚才讨论的做，不允许联网。";
  delete source.turnIntent;
  writePrivateJson(join(f.home,"tasks",taskId+".json"),source);
  await assert.rejects(resume(),{code:"NETWORK_POLICY"});
  assert.equal((await c.session(session.id)).turns.length,1);
  assert.equal(f.calls.length,1);
});
