import test from "node:test";
import assert from "node:assert/strict";
const projection = await import("../src/gui-projection.js").catch(() => ({}));
test("GUI final text keeps model-written version language verbatim without the host footer; CLI retains its default footer",async()=>{
  const {finalText}=await import("../src/presentation.js");
  const text="模型原文：宿主记录：正式版本 model-quoted；成果工作区：model-written。";
  const record={status:"completed",finalCallId:"final",work:{version:"host-version",resultWorkspace:"/host-result",integrationRef:"host-ref",finalCheck:{status:"passed",verification:"unverified"}}};
  const calls=[{id:"final",text}];
  assert.equal(projection.finalGuiText(record,calls),text);
  assert.match(finalText(record,calls),/host-version/);
  assert.match(finalText(record,calls),/未验证/);
  assert.equal(projection.finalGuiText({...record,status:"partial"},calls),"");
});
test("work exposes only saved task-owned log identifiers, including shell tools", () => {
  const record = {
    id: "t",
    sessionId: "s",
    status: "failed",
    models: { main: { provider: "p", modelId: "a" }, secondary: [] },
    stages: [],
    work: {
      root: "/fixture",
      finalCheck: { checks: [{ outputRef: "check-log" }] },
    },
    tools: [{ outputRef: "shell-log", rawSecret: "must-not-appear" }],
    members: [
      {
        memberId: "member",
        status: "failed",
        outputs: [{ outputRef: "member-log" }],
      },
    ],
  };
  const result = projection.projectGuiTask(record);
  assert.deepEqual(result.work.outputRefs, [
    "check-log",
    "shell-log",
    "member-log",
  ]);
  assert.doesNotMatch(JSON.stringify(result), /must-not-appear/);
});
test("elapsed display receives only existing task timestamps, without inferring missing completion time", () => {
  const record = {
    id: "t",
    sessionId: "s",
    createdAt: "2026-10-23T00:00:00.000Z",
    status: "running",
    models: { main: { provider: "p", modelId: "a" }, secondary: [] },
    stages: [],
  };
  const running = projection.projectGuiTask(record);
  assert.equal(running.createdAt, "2026-10-23T00:00:00.000Z");
  assert.equal(running.endedAt, null);
  assert.equal(running.cancelSettledAt, null);
  record.cancelSettledAt = "2026-10-23T00:00:11.000Z";
  assert.equal(projection.projectGuiTask(record).cancelSettledAt, record.cancelSettledAt);
  record.status = "completed";
  record.endedAt = "2026-10-23T00:00:08.000Z";
  assert.equal(
    projection.projectGuiTask(record).endedAt,
    "2026-10-23T00:00:08.000Z",
  );
});
test("projection preserves original text and recorded identities without leaking raw requests", () => {
  assert.equal(
    typeof projection.projectGuiTask,
    "function",
    "task projection must exist",
  );
  const record = {
    id: "task",
    sessionId: "session",
    input: "q",
    status: "completed",
    phase: "revision",
    singleModel: false,
    models: {
      main: { provider: "p", modelId: "a" },
      secondary: [{ provider: "p", modelId: "b" }],
    },
    stages: [
      {
        id: "d",
        role: "main",
        phase: "draft",
        status: "completed",
        modelRef: { provider: "p", modelId: "a" },
        callIds: ["c1"],
      },
      {
        id: "r",
        role: "reviewer-1",
        phase: "review",
        status: "completed",
        callIds: ["c2"],
      },
    ],
    requestIds: ["c1", "c2"],
    finalCallId: "c1",
  };
  const calls = [
    {
      id: "c1",
      stageId: "d",
      status: "completed",
      text: "<script>verbatim</script>",
      model: { provider: "p", id: "actual" },
      context: { headers: { authorization: "secret" } },
    },
    { id: "c2", stageId: "r", status: "completed", text: "review" },
  ];
  const result = projection.projectGuiTask(record, calls);
  assert.equal(result.messages[0].text, calls[0].text);
  assert.equal(result.messages[1].model, null);
  assert.doesNotMatch(JSON.stringify(result), /authorization|secret|consensus/);
  assert.equal(result.team, null);
});

test("projection reports physical request model and member participation without replacing historical authors", () => {
  const record = {
    id: "t",
    sessionId: "s",
    input: "q",
    status: "completed",
    phase: "work",
    singleModel: false,
    models: { main: { provider: "p", modelId: "a" }, secondary: [] },
    stages: [
      {
        id: "member-stage",
        role: "member:123",
        phase: "member",
        modelRef: { provider: "p", modelId: "old" },
      },
    ],
    members: [
      {
        memberId: "123",
        model: { provider: "p", modelId: "new" },
        status: "completed",
      },
    ],
  };
  const calls = [
    {
      id: "call",
      stageId: "member-stage",
      actualModel: { provider: "physical", modelId: "served" },
      status: "completed",
      text: "member original",
    },
  ];
  const result = projection.projectGuiTask(record, calls);
  assert.deepEqual(result.messages[0].model, {
    provider: "physical",
    modelId: "served",
  });
  assert.equal(
    result.participants.find((p) => p.id === "123").participated,
    true,
  );
  assert.equal(
    result.participants.find((p) => p.id === "123").model.modelId,
    "new",
  );
});

test("new ordinary conversation labels unused models as candidates and preserves historical reviewer roles", () => {
  const models={main:{provider:"p",modelId:"main"},secondary:[{provider:"p",modelId:"secondary"}]};
  const history={id:"turn",flow:"unified",status:"completed",models,stages:[]};
  assert.equal(projection.projectGuiTask(history).participants[1].role,"reviewer-1");
  const current=projection.projectGuiTask({...history,turnIntent:{fileRequired:false}});
  assert.deepEqual(current.participants,[]);
  assert.deepEqual(current.rosterCandidates,[models.main,models.secondary[0]]);
});

test("formal GUI process separates roles sharing one model and exposes only the saved role grant", () => {
  const model = {provider:"fixture",modelId:"main",apiKey:"DO_NOT_PROJECT"};
  const record = {
    id:"child",rootTaskId:"root",project:{rootTaskId:"root",commandId:"command"},status:"partial",
    models:{main:model,secondary:[{provider:"fixture",modelId:"spare"}]},
    stages:[
      {id:"leader-stage",role:"main",phase:"work",sessionId:"leader-session",callIds:["leader"]},
      {id:"worker-stage",role:"member:worker",phase:"worker",sessionId:"worker-session",callIds:["worker-call"]},
    ],
    members:[
      {memberId:"lead",staffId:"implementation",model,assignment:"Coordinate the file boundary",status:"queued"},
      {memberId:"worker",supervisorMemberId:"lead",staffId:"inspection",workId:"scope-a",model,
        assignment:"Read the approved file",reason:"Reads the approved format",readOnly:true,scope:[],readScope:["a.txt"],
        status:"failed",pause:{status:"unknown",reason:"Collect the original request",unresolvedRequestIds:["worker-call"]},
        materialGrant:{sources:[{id:"PRIVATE_INPUT"}],attachments:[],summary:{text:"PRIVATE_SUMMARY"}}},
      {memberId:"audit",reviewKind:"independent",reviewVersion:"candidate",model,status:"queued"},
    ],
    tools:[{kind:"skill_resource_read",resourceName:"review",resourcePath:"SKILL.md",resourceHash:"known-hash",
      actor:"member:worker",stageId:"worker-stage",status:"completed",content:"PRIVATE_SKILL"}],
    work:{},
  };
  const requests = [
    {id:"leader",stageId:"leader-stage",role:"main",sent:true,actualModel:model,status:"completed",
      response:{content:[{type:"toolCall",id:"unknown-tool",name:"delegate",arguments:{context:"PRIVATE_TOOL_ARGS"}}]}},
    {id:"worker-call",stageId:"worker-stage",role:"member:worker",sent:true,actualModel:model,status:"failed",
      context:{body:"PRIVATE_REQUEST"},limits:{maxOutputTokens:700},error:"provider refused"},
  ];
  const view = projection.projectGuiTask(record,requests);
  assert.deepEqual(view.participants.map(p=>[p.id,p.position,p.participated]),[
    ["main","manager",true],["lead","supervisor",false],["worker","employee",true],["audit","independent-review",false],
  ]);
  const worker = view.participants.find(p=>p.id==="worker");
  assert.deepEqual(worker.readScope,["a.txt"]);
  assert.equal(worker.reason,"Reads the approved format");
  assert.equal(worker.pause.status,"unknown");
  assert.equal(view.messages[1].sessionId,"worker-session");
  assert.equal(view.messages[1].maxOutputTokens,700);
  assert.equal(view.messages[1].error,"provider refused");
  assert.equal(view.skillReads[0].hash,"known-hash");
  assert.doesNotMatch(JSON.stringify(view),/PRIVATE_|DO_NOT_PROJECT/);
});

test("process check projects bound requests, covered workers and forwarded issues from the saved observation", () => {
  const actualModel = {provider:"fixture",modelId:"served"};
  const record = {id:"root",processCheck:{
    interval:60000,status:"outcome_unknown",gap:{code:"STOP_UNKNOWN",message:"stop not confirmed"},
    observations:[
      {id:"observation",taskId:"step",stageId:"checker",sessionId:"checker-session",requestId:"checked-request",
        sequence:1,kind:"periodic",delayMs:5000,missedIntervals:1,status:"completed",
        members:[
          {memberId:"worker",taskId:"step",leaderId:"lead",attempt:0,status:"waiting",blockers:1,evidenceIds:["evidence"],assignment:"PRIVATE_SNAPSHOT"},
          {memberId:"queued",taskId:"step",leaderId:"lead",attempt:0,status:"queued",evidenceIds:[]},
        ],
        covered:[{memberId:"worker",taskId:"step",attempt:0,evidenceIds:["evidence"]}]},
      {id:"lost",taskId:"step",stageId:"checker",sessionId:"checker-session",requestId:"missing",
        sequence:2,status:"completed",members:[{memberId:"queued",taskId:"step",attempt:0,evidenceIds:["evidence"]}],
        covered:[{memberId:"queued",taskId:"step",attempt:0,evidenceIds:["evidence"]}]},
    ],
    reports:[{id:"issue",observationId:"observation",memberId:"worker",taskId:"step",attempt:0,leaderId:"lead",
      kind:"blocker",status:"forwarded",reason:"Waiting on the tool",evidenceIds:["evidence"]}],
  }};
  const view = projection.projectGuiProcessCheck(record,[
    {id:"checked-request",taskId:"step",stageId:"checker",sessionId:"checker-session",role:"process-check",
      status:"completed",sent:true,actualModel,usage:{input:12,output:6},text:"PRIVATE_RAW_REPORT"},
  ]);
  assert.equal(view.status,"outcome_unknown");
  assert.equal(view.gap.message,"stop not confirmed");
  assert.deepEqual(view.observations[0].actualModel,actualModel);
  assert.deepEqual(view.observations[0].members.map(p=>[p.memberId,p.covered]),[["worker",true],["queued",false]]);
  assert.equal(view.observations[0].reports[0].reason,"Waiting on the tool");
  assert.equal(view.observations[1].status,"unverified");
  assert.equal(view.observations[1].members[0].covered,false);
  assert.doesNotMatch(JSON.stringify(view),/PRIVATE_/);
});

test('work preserves actual failed tool diagnostics as activities without returning request context',()=>{
 const record={id:'t',sessionId:'s',status:'partial',models:{main:{provider:'p',modelId:'m'},secondary:[]},stages:[],work:{}};
 const calls=[{id:'c',response:{content:[{type:'toolCall',id:'tool',name:'accept_change',arguments:{}}]},context:{headers:{authorization:'must-not-appear'}}}];
 const entries=[{type:'message',message:{role:'toolResult',toolCallId:'tool',isError:true,content:[{type:'text',text:'{"error":{"code":"EXECUTOR_CONFIG","message":"Fixed Docker execution config required"}}'}]}}];
 const result=projection.projectGuiTask(record,calls,entries);
 assert.ok(result.work.activities.some(x=>x.action==='accept_change'&&x.status==='failed'&&x.text.includes('Fixed Docker')));
 assert.doesNotMatch(JSON.stringify(result),/authorization|must-not-appear/);
});

test('visual projection separates sent images, completed review and current semantic judgment',()=>{
  const record={id:'visual',stages:[],members:[{memberId:'m',model:{provider:'p',modelId:'x'},status:'failed',understanding:'原题理解',taskConflict:{message:'关系颠倒',unresolved:true},feedback:['撤回错误建议']}],work:{version:'v2',visualEvidence:[
    {toolCallId:'failed',actor:'main',integrationVersion:'v2',imageRequestId:'req-failed',reviewedRequestId:'req-failed',result:'captured',images:[],review:{requestId:'req-failed',status:'completed',verdict:'match'}},
    {toolCallId:'stale',actor:'main',integrationVersion:'v1',imageRequestId:'req-old',reviewedRequestId:'req-old',result:'captured',images:[],review:{requestId:'req-old',integrationVersion:'v1',status:'completed',verdict:'match'}},
    {toolCallId:'mismatch',actor:'main',integrationVersion:'v2',imageRequestId:'req-new',reviewedRequestId:'req-new',result:'captured',images:[{sha256:'png'}],review:{requestId:'req-new',integrationVersion:'v2',imageHashes:['png'],status:'completed',verdict:'mismatch',observation:'看见反转关系',reasons:'不符合原题'}},
  ]}};
  const view=projection.projectGuiTask(record,[{id:'req-failed',status:'failed'},{id:'req-old',status:'completed'},{id:'req-new',status:'completed'}]);
  assert.equal(view.work.visualEvidence[0].checked,false);
  assert.equal(view.work.visualEvidence[0].imageRequestCompleted,false);
  assert.equal(view.work.visualEvidence[1].checked,false);
  assert.equal(view.work.visualEvidence[2].checked,true);
  assert.equal(view.work.visualEvidence[2].semanticMatch,false);
  assert.equal(view.work.visualEvidence[2].review.reasons,'不符合原题');
  assert.equal(view.work.members[0].taskConflict.unresolved,true);
  assert.deepEqual(view.work.members[0].feedback,['撤回错误建议']);
});

test('cancel projection distinguishes requested stop, unknown helper stop, and confirmed stop without inventing acceptance',()=>{
 const record={id:'t',status:'cancelled',cancelRequestedAt:'now',models:{main:{provider:'p',modelId:'m'},secondary:[]},stages:[],work:{helpers:[{helperId:'h',parentActorId:'main',model:{provider:'p',modelId:'m'},status:'running',usage:null}]}};
 let projected=projection.projectGuiTask(record);assert.equal(projected.status,'cancelling');assert.equal(projected.work.helpers[0].usage,null);
 record.work.helpers[0].status='outcome_unknown';assert.equal(projection.projectGuiTask(record).status,'stop_unknown');
 record.work.helpers[0].status='cancelled';record.work.helpers[0].stoppedAt='confirmed';record.cancelSettledAt='confirmed';
 projected=projection.projectGuiTask(record);assert.equal(projected.status,'cancelled');assert.deepEqual(projected.work.acceptance,[]);
});

test("result revision tracks the visible delivery but ignores timers, usage and process logs", () => {
  const record = {id:"t", status:"completed", finalCallId:"final", stages:[],
    work:{version:"v1", integrationRef:"ref", finalCheck:{status:"passed", verification:"passed",
      checks:[{name:"smoke", status:"passed", outputRef:"log-1", durationMs:1}]}}};
  const calls = [{id:"final",text:"Deliverable"}];
  const revision = (r,c=calls) => projection.projectGuiTask(r,c).resultRevision;
  const before = revision(record);
  assert.match(before,/^[0-9a-f]{64}$/);
  assert.notEqual(revision(record,[{id:"final",text:"Updated delivery"}]),before);
  const changed = structuredClone(record);
  changed.endedAt = "2026-11-07T10:00:00Z";
  changed.usage = {calls:99};
  changed.tools = [{outputRef:"new-process-log"}];
  changed.work.finalCheck.checks[0].durationMs = 999;
  changed.work.finalCheck.checks[0].outputRef = "log-2";
  assert.equal(revision(changed),before);
  changed.work.finalCheck.checks[0].status = "failed";
  assert.notEqual(revision(changed),before);
  changed.work.finalCheck.checks[0].status = "passed";
  changed.work.version = "v2";
  assert.notEqual(revision(changed),before);
  assert.equal(revision({status:"running",stages:[]},[]),null);
  assert.match(revision({status:"partial",stages:[]},[]),/^[0-9a-f]{64}$/);
  assert.notEqual(revision({status:"partial",stages:[]},[]),revision({status:"outcome_unknown",stages:[]},[]));
  const root={status:"completed",flow:"unified",stages:[],deliveryRef:{version:"v1",checksRef:[{requestId:"check-1"}]}};
  assert.notEqual(revision(root),revision({...root,deliveryRef:{...root.deliveryRef,version:"v2"}}));
  assert.notEqual(revision(root),revision({...root,deliveryRef:{...root.deliveryRef,checksRef:[{requestId:"check-2"}]}}));
});

test('saved draft versions refresh the original file list while a writer is still running',()=>{
  const record={status:'running',stages:[],work:{changes:[{changeId:'draft',actor:'main',baseVersion:'base',privateVersion:'saved-one',readOnly:false}]}};
  const first=projection.guiResultRevision(record,'');
  assert.match(first,/^[0-9a-f]{64}$/);
  const later=structuredClone(record);later.work.changes[0].privateVersion='saved-two';
  assert.notEqual(projection.guiResultRevision(later,''),first);
  const root={status:'running',stages:[]};
  assert.notEqual(projection.guiResultRevision(root,'',[record]),projection.guiResultRevision(root,'',[later]));
});
