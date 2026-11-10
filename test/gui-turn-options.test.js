import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture } from "./helpers/pi-fixture.js";
import { controller, finished, load } from "./helpers/gui-controller-fixture.js";

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
