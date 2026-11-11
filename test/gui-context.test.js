import {modalEnvironment} from "./gui-modal.fixture.js";
import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {Window} from 'happy-dom';
import {fixture} from './helpers/pi-fixture.js';
import {createGuiController} from '../src/gui-controller.js';
import {saveConfig} from '../src/config.js';
import {controller,controllerModule,finished,fixtureConversation,prepareSubmit,submitDraft,teamId} from './helpers/gui-controller-fixture.js';
import {createTeamConfig} from '../src/teams.js';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {useGuiWorkspace} from '../gui/src/useGuiWorkspace.js';
import {Composer} from '../gui/src/Composer.js';

test('GUI organizer flushes complete options, keeps new input, and recovers a lost receipt without replay',async t=>{
 let release;const hold=new Promise(r=>release=r),f=await fixture(t,async()=>{await hold;return {text:'summary'};});t.after(()=>release());
 saveConfig(f.home,createTeamConfig({formatVersion:2,...f.models},'Fixture',teamId));
 let controller=await createGuiController({home:f.home,cwd:f.cwd}),s=await fixtureConversation(t, controller);await controller.close();
 const path=join(f.home,'pi/sessions/main',readdirSync(join(f.home,'pi/sessions/main')).find(n=>n.endsWith('.jsonl'))),manager=SessionManager.open(path);
 for(let i=0;i<14;i++){manager.appendMessage({role:'user',content:'User request '+i+'. '+'material '.repeat(650),timestamp:Date.now()});manager.appendMessage({role:'assistant',api:'openai-completions',provider:'fixture',model:'main',content:[{type:'text',text:'Response '+i+'. '+'evidence '.repeat(650)}],stopReason:'stop',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},timestamp:Date.now()});}
 controller=await createGuiController({home:f.home,cwd:f.cwd});t.after(()=>controller.close());
 const win=new Window({url:'http://localhost/'}),previous={};
 for(const key of ['window','document','navigator','HTMLElement','Event','sessionStorage']){previous[key]=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{configurable:true,value:key==='window'?win:win[key]});}
 globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 const {createRoot}=await import('react-dom/client'),container=win.document.createElement('div');win.document.body.append(container);const root=createRoot(container);
 let workspace,organizes=0,queries=0,operationId;const actions=[];
 const api={subscribe:(_invalidate,status)=>{status('connected');return ()=>{};},async read(kind,args={}){if(kind==='session')return controller.session(args.id);if(kind==='sessions')return controller.sessions(args);if(kind==='task')return controller.task(args.id);if(kind==='context-operation'){queries++;return controller.readContextOperation(args.operationId);}return controller.bootstrap();},async action(name,args){actions.push(name);const value=await controller.action(name,args);if(name==='context.organize'){organizes++;operationId=args.operationId;throw Object.assign(Error('lost receipt'),{unknown:true});}return value;}};
 function Harness(){workspace=useGuiWorkspace(api);return React.createElement(Composer,{session:workspace.state.session,boot:workspace.state.bootstrap,draft:workspace.state.draft,onDraft:text=>workspace.commands.setDraft(s.id,text),onSubmit(){},onChange(){},turnOptions:workspace.state.turnOptions,onTurnOptions:change=>workspace.commands.setTurnOptions(s.id,change),onOrganize:()=>workspace.commands.organizeContext(),busy:!!workspace.state.bootstrap.active,submitting:workspace.state.submitting,pending:!!workspace.state.pending});}
 try{
  await act(async()=>root.render(React.createElement(Harness)));await act(async()=>workspace.commands.openSession(s.id));
  await act(()=>{workspace.commands.setDraft(s.id,'preserve next task');workspace.commands.setTurnOptions(s.id,{maxCalls:'2',readOnly:true,delegate:false});});
  await act(async()=>workspace.commands.organizeContext());assert.equal(organizes,1);assert.ok(actions.indexOf('session.draft')<actions.indexOf('context.organize'));assert.equal(workspace.state.pending.kind,'context');
  const saved=await controller.session(s.id);assert.equal(saved.editor.text,'preserve next task');assert.equal(saved.editor.turnOptions.maxCalls,'2');assert.equal(saved.editor.turnOptions.readOnly,true);
  await act(()=>workspace.commands.setDraft(s.id,'newer local next task'));await act(async()=>workspace.commands.flushAllDrafts().catch(()=>{}));assert.equal((await controller.session(s.id)).editor.text,'preserve next task');
  await act(async()=>workspace.commands.recoverSubmission());assert.equal(organizes,1);assert.ok(queries>0);assert.equal(workspace.state.draft,'newer local next task');
  await act(async()=>{release();for(let i=0;i<500&&(await controller.bootstrap()).active;i++)await new Promise(r=>setTimeout(r,10));});
  await act(async()=>{await workspace.commands.refresh();await new Promise(r=>setTimeout(r,20));});await act(async()=>workspace.commands.flushAllDrafts());
  assert.equal((await controller.readContextOperation(operationId)).applied,true);assert.equal((await controller.session(s.id)).editor.text,'newer local next task');assert.equal(workspace.state.turnOptions.maxCalls,'2');assert.equal(organizes,1);
 }finally{release();await act(()=>root.unmount());win.happyDOM.abort();for(const [key,value]of Object.entries(previous)){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}delete globalThis.IS_REACT_ACT_ENVIRONMENT;}
});

test("accepted submit freezes mode and thinking before immediately following changes, with a cached runtime", async (t) => {
  const f = await fixture(t);
  const catalogPath = join(f.home, "pi/models.json");
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  for (const model of catalog.providers.fixture.models) model.reasoning = true;
  writeFileSync(catalogPath, JSON.stringify(catalog));
  const c = await controller(t, f),
    s = await fixtureConversation(t, c);
  await c.action("session.thinking", { sessionId: s.id, level: "low", scope:"all" });
  const warm = await submitDraft(c, {
    sessionId: s.id,
    input: "warm context",
    protocolVersion:1, submissionId: "freeze-warm",
  });
  await finished(c, warm.taskId);
  const args=await prepareSubmit(c,{sessionId:s.id,input:"accepted before edits",submissionId:"freeze-current"});
  const pending=c.action("task.submit",args);
  const mode = assert.rejects(c.action("session.mode", { sessionId: s.id, mode:"one" }),/移除/);
  const thinking = c.action("session.thinking", {
    sessionId: s.id,
    level: "high",
    scope: "all",
  });
  const current = await pending;
  await Promise.all([mode, thinking]);
  const task = await finished(c, current.taskId);
  assert.equal(
    task.singleModel,
    false,
    "accepted current task keeps its unified flow",
  );
  assert.equal(task.team.main.thinkingLevel, "low");
  assert.ok(task.team.secondary.every(ref => ref.thinkingLevel === "low"));
  assert.equal(f.calls.length, 2);
  const next = await submitDraft(c, {
    sessionId: s.id,
    input: "next snapshot",
    protocolVersion:1, submissionId: "freeze-next",
  });
  const nextTask = await finished(c, next.taskId);
  assert.equal(nextTask.flow, "unified");
  assert.equal(nextTask.team.main.thinkingLevel, "high");
  assert.ok(nextTask.team.secondary.every(ref => ref.thinkingLevel === "high"));
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.calls.map(call => call.body.reasoning_effort), ["low", "low", "high"]);
});

test("new GUI choices are strict, default high and reject incompatible roster members", async t => {
  const f=await fixture(t),path=join(f.home,"pi/models.json"),catalog=JSON.parse(readFileSync(path,"utf8"));
  const c=await controller(t,f),s=await fixtureConversation(t,c);
  assert.equal((await c.session(s.id)).thinking,"high");
  assert.equal((await c.session(s.id)).thinkingScope,"all");
  for(const level of ["off","minimal","medium","xhigh","",null,"future"])
    await assert.rejects(c.action("session.thinking",{sessionId:s.id,level,scope:"all"}),/思考/);
  await assert.rejects(c.action("session.thinking",{sessionId:s.id,level:"low",scope:"main"}),/范围/);
  await c.action("session.thinking",{sessionId:s.id,level:"low",scope:"all"});
  catalog.providers.fixture.models[1].reasoning=false;writeFileSync(path,JSON.stringify(catalog));
  await assert.rejects(c.action("session.thinking",{sessionId:s.id,level:"high",scope:"all"}),/fixture\/r1.*high.*off/);
  const projected=(await c.bootstrap()).models.find(model=>model.provider==="fixture"&&model.modelId==="r1");
  assert.equal(projected.available,false,"current GUI availability evaluates its high default, not historical native off");
  assert.equal((await c.session(s.id)).thinking,"low");
  assert.equal(f.calls.length,0);
});

test("all-model thinking persists, freezes every role reference and uses high for omitted new choices without mutating roster defaults", async t => {
  const f = await fixture(t), path = join(f.home, "pi/models.json"), catalog = JSON.parse(readFileSync(path, "utf8"));
  for (const model of catalog.providers.fixture.models) model.reasoning = true;
  writeFileSync(path, JSON.stringify(catalog));
  f.models.secondary[0].thinkingLevel = "medium";
  const c = await controller(t, f), s = await fixtureConversation(t, c);
  await c.action("session.thinking", {sessionId:s.id, level:"low", scope:"all"});
  assert.equal((await c.session(s.id)).thinkingScope, "all");
  assert.equal(f.calls.length, 0);
  const first = await submitDraft(c, {sessionId:s.id, input:"all low"});
  const task = await finished(c, first.taskId);
  assert.ok([task.team.main, ...task.team.secondary].every(ref => ref.thinkingLevel === "low"));
  const fork = await c.action("session.fork", {sessionId:s.id, taskId:task.id});
  assert.equal(fork.thinking, "low");
  assert.equal(fork.thinkingScope, "all");
  await c.close();
  const reopened = await controllerModule.createGuiController({home:f.home, cwd:f.cwd});
  t.after(() => reopened.close());
  assert.equal((await reopened.session(s.id)).thinkingScope, "all");
  await reopened.action("session.thinking", {sessionId:s.id, scope:"all"});
  const next = await submitDraft(reopened, {sessionId:s.id, input:"roster defaults"});
  const restored = await finished(reopened, next.taskId);
  assert.equal(restored.team.main.thinkingLevel, "high");
  assert.equal(restored.team.secondary[0].thinkingLevel, "high");
  assert.deepEqual(f.calls.map(call => call.body.reasoning_effort), ["low", "high"]);
});

test("changing roster after all-model thinking selection rejects incompatible submit before any request", async t => {
  const f = await fixture(t), path = join(f.home, "pi/models.json"), catalog = JSON.parse(readFileSync(path, "utf8"));
  for (const model of catalog.providers.fixture.models) model.reasoning = true;
  writeFileSync(path, JSON.stringify(catalog));
  const c = await controller(t, f), s = await fixtureConversation(t, c);
  await c.action("session.thinking", {sessionId:s.id, level:"low", scope:"all"});
  catalog.providers.fixture.models[1].reasoning = false;
  writeFileSync(path, JSON.stringify(catalog));
  await assert.rejects(submitDraft(c, {sessionId:s.id, input:"must not send"}), /fixture\/r1.*low/);
  assert.equal(f.calls.length, 0);
});


test("legacy main-only choices normalize for current display and new tasks while raw history stays intact",async t=>{
 const {readConversationMetadata}=await import('../src/conversation.js');
 const f=await fixture(t),c=await controller(t,f),s=await fixtureConversation(t,c);
 await c.close();
 const dir=join(f.home,'pi/sessions/main'),path=join(dir,readdirSync(dir).find(name=>name.endsWith('.jsonl')));
 const manager=SessionManager.open(path);manager.appendCustomEntry('cothink-thinking',{level:'xhigh',scope:'main'});
 const before=readFileSync(path,'utf8');
 const reopened=await controllerModule.createGuiController({home:f.home,cwd:f.cwd});t.after(()=>reopened.close());
 assert.equal((await reopened.session(s.id)).thinking,'max');
 assert.equal((await reopened.session(s.id)).thinkingScope,'all');
 assert.equal(readFileSync(path,'utf8'),before,'projection never rewrites saved history');
 assert.equal(readConversationMetadata(SessionManager.open(path)).thinking,'xhigh');
 assert.equal(readConversationMetadata(SessionManager.open(path)).thinkingScope,'main');
 const sent=await submitDraft(reopened,{sessionId:s.id,input:'normalized new task'}),task=await finished(reopened,sent.taskId);
 assert.ok([task.team.main,...task.team.secondary].every(ref=>ref.thinkingLevel==='max'));
 assert.equal(f.calls[0].body.reasoning_effort,'max');
});

test("current preference normalization agrees across backend and GUI without changing native history",async()=>{
 const team={id:"roster",name:"Roster",main:{provider:"p",modelId:"main"},secondary:[{provider:"p",modelId:"worker"}]};
 const models=[{...team.main,name:"Main",thinkingLevels:["low","high","max"]},{...team.secondary[0],name:"Worker",thinkingLevels:["high","low"]}];
 const backend=await import("../src/thinking.js"),view=await import("../gui/src/view.js");
 const rows=[[undefined,"high"],[null,"high"],["","high"],["off","low"],["minimal","low"],["low","low"],["medium","high"],["high","high"],["xhigh","max"],["max","max"]];
 for(const [input,expected] of rows){
  assert.equal(backend.normalizeThinkingPreference(input),expected);
  assert.equal(view.normalizeThinkingPreference(input),expected);
  assert.deepEqual(view.conversationThinking({team,thinking:input,thinkingScope:"main"},models).levels,["low","high","max"]);
  assert.equal(view.conversationThinking({team,thinking:input,thinkingScope:"main"},models).level,expected);
  assert.equal(view.conversationThinking({team,thinking:input,thinkingScope:"main"},models).scope,"all");
 }
 for(const invalid of ["future",false,42]){
  assert.throws(()=>backend.normalizeThinkingPreference(invalid),/思考/);
  assert.throws(()=>view.normalizeThinkingPreference(invalid),/思考/);
 }
});

test("omitted new choices persist high for every model without rewriting older tasks",async t=>{
  const f=await fixture(t), path=join(f.home,"pi/models.json"), catalog=JSON.parse(readFileSync(path,"utf8"));
  catalog.providers.fixture.models[0].reasoning=true;
  writeFileSync(path,JSON.stringify(catalog));
  const c=await controller(t,f), s=await fixtureConversation(t, c);
  await c.action("session.thinking",{sessionId:s.id,level:"high"});
  const team=await c.action("team.save",{name:"Low team",main:{...f.models.main,thinkingLevel:"low"},secondary:f.models.secondary});
  await c.action("session.team",{sessionId:s.id,teamId:team.id});
  assert.equal((await c.session(s.id)).thinking,"high");
  const first=await submitDraft(c,{sessionId:s.id,input:"with conversation override",protocolVersion:1, submissionId:"override-first"});
  assert.equal((await finished(c,first.taskId)).team.main.thinkingLevel,"high");
  await c.action("session.thinking",{sessionId:s.id});
  assert.equal((await c.session(s.id)).thinking,"high");
  await c.close();
  const reopened=await controllerModule.createGuiController({home:f.home,cwd:f.cwd});t.after(()=>reopened.close());
  assert.equal((await reopened.session(s.id)).thinking,"high","default high survives closing and reopening the host");
  const second=await submitDraft(reopened,{sessionId:s.id,input:"follow selected team",protocolVersion:1, submissionId:"override-second"});
  assert.equal((await finished(reopened,second.taskId)).team.main.thinkingLevel,"high");
  assert.equal((await reopened.task(first.taskId)).team.main.thinkingLevel,"high");
  assert.equal((await reopened.bootstrap()).teams.length,2,"the previous Team remains saved");
  assert.equal(f.calls.length,2,"two ordinary answers use one main request each");
  assert.deepEqual(f.calls.filter(call=>call.body.model==="main").map(call=>call.body.reasoning_effort),
    ["high","high"], "the fixture receives the effective thinking level, not only a matching task label");
});

test("roster editor always offers three levels and projects legacy model defaults",async()=>{
 const team={id:"roster",name:"Roster",main:{provider:"p",modelId:"main"},secondary:[{provider:"p",modelId:"worker"}]};
 const models=[{...team.main,name:"Main",thinkingLevels:["low","high","max"]},{...team.secondary[0],name:"Worker",thinkingLevels:["high","low"]}];
 const rows=[[undefined,"high"],["off","low"],["minimal","low"],["medium","high"],["xhigh","max"]];
 await modalEnvironment(async({root,container,TeamPanel,win})=>{
  for(const [input,expected]of rows){
   const roster={...team,id:"old",name:"Original",main:{...team.main,thinkingLevel:input}};
   const changes=[];
   await act(()=>root.render(React.createElement(TeamPanel,{key:String(input),session:{id:"s",team:roster},teams:[roster],models,providers:[{id:"p",configured:true}],commands:{saveTeam:async value=>{changes.push(value);return {...value,id:"saved"};}},onClose(){}})));
   await act(()=>container.querySelector('[aria-label="管理 Original"]').click());
   await act(()=>[...container.querySelectorAll("button")].find(button=>button.textContent==="调整另存").click());
   for(const select of container.querySelectorAll('select[aria-label$="思考档位"]'))assert.deepEqual([...select.options].map(option=>option.value),["low","high","max"]);
   const select=container.querySelector('[aria-label="主模型思考档位"]');assert.equal(select.value,expected);
   await act(()=>{select.value="max";select.dispatchEvent(new win.Event("change",{bubbles:true}));});
   await act(async()=>container.querySelector("form").dispatchEvent(new win.Event("submit",{bubbles:true,cancelable:true})));
   assert.equal(changes[0].main.thinkingLevel,"max");
  }
 });
});
