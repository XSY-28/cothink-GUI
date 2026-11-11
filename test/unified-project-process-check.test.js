import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fixture} from './helpers/pi-fixture.js';
import { repository } from './helpers/git-fixture.js';
import { runProjectTurn } from '../src/project-turn.js';
import { confirmProject, projectSession } from "./unified-project.fixture.js";

async function processGroup(t, { projectBudget, rootBudget, attachPrivateMaterial, worker, inspect, onReports, thinking } = {}) {
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

test('a short formal GUI group receives a tool-free process check of actual employee requests', async t => {
  const {f,base,source,observations} = await processGroup(t,{attachPrivateMaterial:true,thinking:'low'});
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
  assert.ok(f.calls.every(call=>call.body.reasoning_effort==='low'));
  const {readRequests}=await import('../src/task.js');
  for(const record of [source.record,root.record,child])
    for(const sent of readRequests(f.home,record).filter(request=>request.sent)){
      assert.equal(sent.requestedModel.thinkingLevel,'low');
      assert.equal(sent.payload.reasoning_effort,'low');
    }
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
