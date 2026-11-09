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
