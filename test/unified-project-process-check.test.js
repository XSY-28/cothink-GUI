import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {fixture} from './helpers/pi-fixture.js';
import { repository } from './helpers/git-fixture.js';
import { runProjectTurn } from '../src/project-turn.js';
import { confirmProject, projectSession } from "./unified-project.fixture.js";

async function processGroup(t, { projectBudget, rootBudget, attachPrivateMaterial, worker, inspect, onReports, thinking, rosterSize } = {}) {
  const repo = repository(t);
  const plan = {
    goal: 'Change a.txt with an employee check of b.txt',
    ...(projectBudget === undefined ? {} : { budget:{maxCalls:projectBudget} }),
    scope: ['a.txt', 'b.txt'],
    deliverables: ['a.txt'],
    checks: [{command:'node',args:['-e',"if(require('fs').readFileSync('a.txt','utf8')!=='changed A\\n')process.exit(1)"]}],
  };
  const responses = [
    {name:'project_staff',args:{action:'appoint',input:{id:'reader',responsibility:'Read b.txt',models:['fixture/r2'],scope:['b.txt'],need:'deliverable',reason:'Separate read'}}},
    {name:'delegate',args:{staffId:'reader',workId:'main:a.txt',model:'fixture/r2',assignment:'Report whether b.txt exists',scope:[],readScope:['a.txt','b.txt'],readOnly:true,reason:'Independent observation'}},
    {name:'collect',args:{}},
    {name:'read',args:{path:'a.txt'}},
    {name:'edit',args:{path:'a.txt',edits:[{oldText:'base A',newText:'changed A'}]}},
    {name:'accept_change',args:{}},
  ];
  let leaderTurn = 0;
  const observations = [];
  const f = await fixture(t, async ({body}, n) => {
    if (n === 1) return {toolCalls:[{name:'start_work',args:{action:'start',reason:'edit',plan}}]};
    const current = body.messages.findLast(message => message.role === 'user')?.content;
    const raw = typeof current === 'string' ? current : current?.map(part=>part.text).join('');
    if (raw?.includes('cothink-process-observation')) {
      const snapshot = JSON.parse(raw);
      observations.push({snapshot,tools:body.tools??[]});
      return inspect ? inspect(snapshot, observations.length) : {text:JSON.stringify({issues:[]})};
    }
    if (body.model === 'r2') {
      await worker?.();
      return {text:'b.txt exists; original task and read-only scope understood.'};
    }
    const toolResult = body.messages.at(-1);
    if (onReports && toolResult?.role === 'tool') {
      let result;
      try { result = JSON.parse(toolResult.content); } catch {}
      if (result?.processReports?.length) {
        onReports(result.processReports);
        return {toolCalls:[{name:'collect',args:{}}]};
      }
    }
    const reply = responses[leaderTurn++];
    return reply ? {toolCalls:[reply]} : {text:'Changed a.txt after the b.txt investigation.'};
  });
  if (thinking) {
    const path=join(f.home,'pi/models.json'),catalog=JSON.parse(readFileSync(path,'utf8'));
    for(const model of catalog.providers.fixture.models)model.reasoning=true;
    writeFileSync(path,JSON.stringify(catalog));
    for(const ref of [f.models.main,...f.models.secondary])ref.thinkingLevel=thinking;
  }
  if(rosterSize===2) f.models.secondary=[f.models.secondary[1]];
  if(rosterSize===3) f.models.secondary=f.models.secondary.slice(0,2);
  const base = await projectSession(t,repo,f);
  const materials = [];
  if (attachPrivateMaterial) {
    const {createGuiMaterialStore} = await import('../src/gui-materials.js');
    const store = createGuiMaterialStore(f.home);
    const bytes = Buffer.from('PRIVATE_ROOT_ATTACHMENT_MARKER');
    const upload = {ownerId:randomUUID(),uploadId:randomUUID(),name:'private.txt',mediaType:'text/plain',
      byteLength:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
    store.begin(upload);
    materials.push(store.read(await store.publish({...upload,body:bytes})));
  }
  const source = await runProjectTurn({...base,input:'Change a.txt after checking b.txt.',budget:rootBudget,materials});
  assert.equal(f.calls.length,1,'a confirmation proposal starts no checker');
  return {f,base,source,observations};
}

for(const rosterSize of [2,3])for(const thinking of ['low','high','max'])
test(`formal ${rosterSize}-model group sends ${thinking} for manager, employee and checker`, async t => {
  const {f,base,source,observations} = await processGroup(t,{attachPrivateMaterial:true,thinking,rosterSize});
  assert.match(JSON.stringify(f.calls[0].body),/PRIVATE_ROOT_ATTACHMENT_MARKER/);
  const root = await confirmProject(base,source);
  assert.ok(observations.length >= 1,JSON.stringify({error:root.record.error,process:root.record.processCheck,toolResults:f.calls.flatMap(call=>call.body.messages.filter(message=>message.role==='tool').slice(-1).map(message=>message.content))}));
  assert.equal(root.record.status,'completed',root.record.error);
  const checks = root.record.processCheck.observations;
  const {readTask,readRequest} = await import('../src/task.js');
  const child = readTask(f.home,root.record.projectOperation.childTaskIds[0]);
  const member = child.members[0];
  const covered = checks.find(check=>check.covered?.some(fact=>fact.memberId===member.memberId));
  assert.ok(covered,'an actual worker send was covered even if the first snapshot was queued');
  const request = readRequest(f.home,covered.taskId,covered.requestId);
  assert.equal(request.phase,'process-check');
  assert.equal(request.projectSend.cause,'observe:'+covered.id);
  assert.equal(request.sent,true);
  assert.ok(f.calls.every(call=>call.body.reasoning_effort===thinking));
  const {readRequests}=await import('../src/task.js');
  for(const record of [source.record,root.record,child])
    for(const sent of readRequests(f.home,record).filter(request=>request.sent)){
      assert.equal(sent.requestedModel.thinkingLevel,thinking);
      assert.equal(sent.payload.reasoning_effort,thinking);
    }
  assert.equal([source.record.team?.main??base.frozenConfig.main,...base.frozenConfig.secondary].length,rosterSize);
  assert.ok(f.calls.some(call=>call.body.model==='r2'),'actual employee request');
  assert.ok(f.calls.some(call=>call.body.messages.at(-1)?.role==='tool'),'actual leader tool continuation request');
  const evidenceDir='work/unified-thinking-three-levels';mkdirSync(evidenceDir,{recursive:true});
  writeFileSync(join(evidenceDir,`formal-${rosterSize}-${thinking}-roles.json`),JSON.stringify({rosterSize,thinking,
    requests:[source.record,root.record,child].flatMap(record=>readRequests(f.home,record).filter(row=>row.sent).map(row=>({
      phase:row.phase,role:row.role,model:row.requestedModel?.modelId,level:row.requestedModel?.thinkingLevel,effort:row.payload?.reasoning_effort}))),
    wire:f.calls.map((call,index)=>({index:index+1,model:call.body.model,effort:call.body.reasoning_effort})),
  },null,2));
  assert.equal(new Set(checks.map(check=>check.sessionId)).size,1);
  for (const {snapshot,tools} of observations) {
    assert.deepEqual(tools,[]);
    assert.doesNotMatch(JSON.stringify(snapshot),/PRIVATE_ROOT_ATTACHMENT_MARKER/);
  }
});

test('a periodic checker reports an actual waiting worker to its collecting leader', async t => {
  let time = Date.parse('2026-11-10T00:00:00Z'), due, timers = 0;
  const timerReady = Promise.withResolvers();
  const followingTimer = Promise.withResolvers();
  const workerArrived = Promise.withResolvers();
  const releaseWorker = Promise.withResolvers();
  t.after(() => releaseWorker.resolve());
  const delivered = [];
  const clock = {
    now: () => time,
    set(fn) {
      due = fn;
      if (++timers === 1) timerReady.resolve();
      if (timers === 2) followingTimer.resolve();
      return fn;
    },
    clear(fn) { if (due === fn) due = null; },
  };
  const {base,source,observations} = await processGroup(t, {
    worker() { workerArrived.resolve(); return releaseWorker.promise; },
    inspect(snapshot,n) {
      if (n === 1) return {text:'{"issues":[]}'};
      const [employee] = snapshot.members;
      if (n === 3) releaseWorker.resolve();
      return {text:JSON.stringify({issues:[{memberId:employee.memberId,kind:'blocker',
        reason:'Inspect why the first request is still running.',evidenceIds:employee.evidenceIds.slice(-1)}]})};
    },
    onReports(reports) { delivered.push(...reports); },
  });
  const pending = confirmProject(base,source,{processCheckClock:clock,signal:AbortSignal.timeout(45000)});
  await Promise.race([Promise.all([timerReady.promise,workerArrived.promise]),pending]);
  assert.ok(due,'periodic inspection armed while employee is active');
  time += 180000;
  due();
  await Promise.race([followingTimer.promise,pending]);
  time += 60000;
  due();
  const root = await pending;
  assert.equal(root.record.status,'completed',root.record.error);
  assert.equal(delivered.length,1);
  assert.equal(delivered[0].kind,'blocker');
  assert.equal(delivered[0].leaderId,'main');
  const periodic = root.record.processCheck.observations.filter(check=>check.kind==='periodic');
  assert.equal(periodic.length,2);
  assert.equal(root.record.processCheck.reports.length,1);
  assert.equal(periodic[0].delayMs,120000);
  assert.equal(periodic[0].missedIntervals,2);
  assert.ok(observations[1].snapshot.members[0].requests.some(request=>request.status==='in_flight'));
});

test('first assignment is refused before a worker or checker can consume the last project request', async t => {
  const {f,base,source,observations} = await processGroup(t,{projectBudget:3});
  const root = await confirmProject(base,source);
  assert.notEqual(root.record.status,'completed');
  assert.equal(root.record.processCheck?.gap?.code,'PROJECT_BUDGET');
  assert.equal(observations.length,0);
  assert.equal(f.calls.filter(call=>call.body.model==='r2').length,0);
});

test('cancelled project never reissues an in-flight checker request when read back', async t => {
  const checkerArrived = Promise.withResolvers();
  const {f,base,source,observations} = await processGroup(t, {
    inspect() { checkerArrived.resolve(); return null; },
  });
  const abort = new AbortController();
  const pending = confirmProject(base,source,{signal:abort.signal});
  await Promise.race([checkerArrived.promise,pending]);
  assert.equal(observations.length,1);
  abort.abort();
  const root = await pending;
  assert.equal(root.record.status,'cancelled');
  const {readTask,readRequest} = await import('../src/task.js');
  const observed = readTask(f.home,root.record.id).processCheck.observations[0];
  assert.equal(readRequest(f.home,observed.taskId,observed.requestId).sent,true);
  assert.equal(observed.status,'outcome_unknown');
  assert.equal(observed.usage,null);
  assert.equal(observations.length,1);
});

test('a root call limit also reserves the mandatory checker before assignment', async t => {
  const {f,base,source,observations} = await processGroup(t,{rootBudget:{maxCalls:4}});
  const root = await confirmProject(base,source);
  assert.notEqual(root.record.status,'completed');
  assert.equal(root.record.processCheck?.gap?.code,'ROOT_BUDGET');
  assert.equal(observations.length,0);
  assert.equal(f.calls.filter(call=>call.body.model==='r2').length,0);
});

test('a known observer service failure is reported and cannot satisfy process coverage', async t => {
  const {f,base,source,observations} = await processGroup(t, {inspect:()=>({error:503})});
  const root = await confirmProject(base,source);
  assert.notEqual(root.record.status,'completed');
  assert.equal(observations.length,1);
  assert.equal(root.record.processCheck.status,'blocked');
  const [observation] = root.record.processCheck.observations;
  const {readRequest} = await import('../src/task.js');
  assert.equal(readRequest(f.home,observation.taskId,observation.requestId).httpStatus,503);
  assert.equal(observation.status,'failed');
  assert.equal(observation.covered,undefined);
});

for (const fenced of [false,true]) test(`checker accepts ${fenced?'one outer JSON fence':'plain JSON'} without a correction request`,async t=>{
  const {base,source,observations}=await processGroup(t,{inspect:()=>({text:fenced?'```json\n{"issues":[]}\n```':'{"issues":[]}'})});
  const root=await confirmProject(base,source);
  assert.equal(root.record.status,'completed',root.record.error);
  assert.equal(root.record.processCheck.observations.length,observations.length);
  assert.ok(root.record.processCheck.observations.every(row=>row.status==='completed'&&!row.correctionOf));
});

test('a completed invalid checker response gets one bound correction with unchanged source facts and honest accounting',async t=>{
  let invalid=false;
  const {f,base,source}=await processGroup(t,{thinking:'high',inspect(snapshot){
    if(!invalid&&snapshot.members.some(member=>member.evidenceIds.length)){
      invalid=true;
      return {text:JSON.stringify({issues:[{memberId:snapshot.members[0].memberId,kind:'blocker',
        evidenceIds:['invented-evidence'],reason:'Unsupported claim'}]})};
    }
    return {text:'{"issues":[]}'};
  }});
  const root=await confirmProject(base,source);
  assert.equal(root.record.status,'completed',root.record.error);
  const observations=root.record.processCheck.observations;
  const original=observations.find(row=>row.status==='failed');
  const correction=observations.find(row=>row.correctionOf===original?.id);
  assert.ok(original,'invalid semantic output remains a failed observation');
  assert.ok(correction,'a separate correction observation is recorded');
  assert.equal(correction.status,'completed');
  assert.notEqual(correction.stageId,original.stageId);
  assert.notEqual(correction.requestId,original.requestId);
  assert.deepEqual(correction.members,original.members);
  assert.deepEqual(correction.model,original.model);
  assert.equal(correction.observedAt,original.observedAt);
  assert.match(original.error,/outside this observation/);
  const {readRequest,readTask,readRequests}=await import('../src/task.js');
  const failedCall=readRequest(f.home,original.taskId,original.requestId);
  const correctedCall=readRequest(f.home,correction.taskId,correction.requestId);
  assert.equal(failedCall.status,'completed','transport completion is preserved');
  assert.match(failedCall.text,/invented-evidence/);
  assert.equal(correctedCall.status,'completed');
  assert.deepEqual(correctedCall.actualModel,failedCall.actualModel);
  const body=JSON.parse(correctedCall.context.messages.at(-1).content[0].text);
  assert.equal(body.correction.requestId,failedCall.id);
  assert.equal(body.correction.error,original.error);
  assert.equal(correctedCall.projectSend.cause,'observe:'+correction.id);
  const child=readTask(f.home,root.record.projectOperation.childTaskIds[0]);
  const {coveringProcessCheck}=await import('../src/project-collaboration-evidence.js');
  const workerCalls=readRequests(f.home,child).filter(call=>call.role==='member:'+child.members[0].memberId);
  assert.equal(coveringProcessCheck(f.home,root.record,child,child.members[0],0,workerCalls),correction.requestId);
  const physical=[...root.requests(),...readRequests(f.home,child)].filter(call=>call.sent);
  assert.equal(physical.length,f.calls.length-1,'proposal is outside confirmed root');
  assert.equal(root.record.rootRequests.filter(row=>!row.notSent).length,physical.length);
  assert.equal(root.record.usage.calls,physical.length);
  assert.equal(observations.filter(row=>row.correctionOf===original.id).length,1);
  assert.equal(root.record.processCheck.reports.length,0,'spoofed issue cannot be forwarded');
  assert.ok(f.calls.every(call=>call.body.reasoning_effort==='high'));
  mkdirSync('work/long-task-reliability',{recursive:true});
  writeFileSync('work/long-task-reliability/task-2-accounting.json',JSON.stringify({
    observations,rootRequests:root.record.rootRequests,
    requests:physical.map(({id,stageId,sessionId,status,usage,projectSend,payload})=>({id,stageId,sessionId,status,usage,projectSend,effort:payload.reasoning_effort})),
    wire:f.calls.map(({body})=>({model:body.model,effort:body.reasoning_effort})),
  },null,2));
});

for (const text of ['{"issues":[{"memberId":"spoofed","kind":"blocker","evidenceIds":["fake"],"reason":"bad"}]}',
  'prose {"issues":[]}', '```json\n{"issues":[]}\n```\n{"issues":[]}'])
test(`checker refuses a second invalid result without looping: ${text.slice(0,24)}`,async t=>{
  const {base,source,observations}=await processGroup(t,{inspect:()=>({text})});
  const root=await confirmProject(base,source);
  assert.notEqual(root.record.status,'completed');
  assert.equal(observations.length,2);
  const [original,correction]=root.record.processCheck.observations;
  assert.equal(correction.correctionOf,original.id);
  assert.equal(original.status,'failed');assert.equal(correction.status,'failed');
  assert.ok(original.error);assert.ok(correction.error);
  assert.equal(root.record.processCheck.reports.length,0);
  assert.equal(root.record.processCheck.gap.observationId,correction.id);
});

for(const limits of [{rootBudget:{maxCalls:6},code:'ROOT_BUDGET'},{projectBudget:5,code:'PROJECT_BUDGET'}])
test(`checker correction respects ${limits.code} while retaining the completed invalid original`,async t=>{
  const {f,base,source,observations}=await processGroup(t,{...limits,inspect:()=>({text:'{"issues":false}'})});
  const root=await confirmProject(base,source);
  assert.notEqual(root.record.status,'completed');
  assert.equal(observations.length,1,'budget refusal sends no correction');
  const [original,correction]=root.record.processCheck.observations;
  assert.equal(original.status,'failed');assert.match(original.error,/issues list/);
  assert.equal(correction.correctionOf,original.id);
  assert.match(root.record.processCheck.gap.message,/call budget exhausted/i);
  const {readRequest}=await import('../src/task.js');
  assert.equal(readRequest(f.home,original.taskId,original.requestId).status,'completed');
  assert.equal(readRequest(f.home,correction.taskId,correction.requestId).sent,false);
});

test('cancelling an in-flight correction keeps the original and unknown correction without another send',async t=>{
  const arrived=Promise.withResolvers(),controller=new AbortController();
  const {f,base,source,observations}=await processGroup(t,{inspect(snapshot,n){
    if(n===1)return {text:'{"issues":false}'};
    arrived.resolve();return null;
  }});
  const pending=confirmProject(base,source,{signal:controller.signal});
  await Promise.race([arrived.promise,pending]);
  controller.abort();
  const root=await pending;
  assert.equal(root.record.status,'cancelled');
  assert.equal(observations.length,2);
  const [original,correction]=root.record.processCheck.observations;
  assert.equal(original.status,'failed');assert.equal(correction.status,'outcome_unknown');
  assert.equal(correction.correctionOf,original.id);
  const {readTask,readRequest}=await import('../src/task.js');
  assert.equal(readTask(f.home,root.record.id).processCheck.observations.length,2);
  assert.equal(readRequest(f.home,original.taskId,original.requestId).status,'completed');
  assert.equal(readRequest(f.home,correction.taskId,correction.requestId).usage,null);
});

test('an output-limited checker response stays partial without a semantic correction',async t=>{
  const {base,source,observations}=await processGroup(t,{inspect:()=>({text:'{"issues":',finish:'length'})});
  const root=await confirmProject(base,source);
  assert.notEqual(root.record.status,'completed');
  assert.equal(observations.length,1);
  assert.equal(root.record.processCheck.observations.length,1);
  assert.equal(root.record.processCheck.observations[0].correctionOf,undefined);
  assert.match(root.record.processCheck.gap.message,/partial/);
});

test('failed observation persistence never starts a correction',async t=>{
  const {base,source,observations}=await processGroup(t,{inspect:()=>({text:'{"issues":false}'})});
  let failed=false;
  const root=await confirmProject(base,source,{onTaskCreated(task){
    const save=task.save;
    task.save=()=>{
      if(!failed&&task.record.processCheck?.observations.some(row=>row.error)){
        failed=true;throw new Error('Observation persistence unavailable');
      }
      return save();
    };
  }});
  assert.equal(failed,true);
  assert.notEqual(root.record.status,'completed');
  assert.equal(observations.length,1);
  assert.equal(root.record.processCheck.observations.length,1);
});
