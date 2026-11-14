import React,{act} from "react";
import {modalEnvironment} from "./gui-modal.fixture.js";
import {GUI_INPUT_VERSION} from "../src/gui-turn-options.js";
const protocol={unified:1,guiInput:Number(GUI_INPUT_VERSION)};
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { host, newSession, readTask, send, setup } from "./gui-history.fixture.js";

test("conversation summaries do not hydrate subordinate streams; explicit process reads still do",async t=>{
  const fs=await import('node:fs'),{syncBuiltinESMExports}=await import('node:module'),{randomUUID}=await import('node:crypto');
  const {createTask}=await import('../src/task.js');
  const f=await setup(t),h=await host(t,f),sessionId=await newSession(t,h),parent=await send(h,sessionId,'Parent result');
  const child=createTask({home:f.home,input:'Internal execution',models:f.models,sessionId,rootTaskId:parent.id,
    project:{id:'project',stepId:'step',rootTaskId:parent.id,scope:['a.txt'],readScope:['a.txt']}});
  const stage=child.beginPhase('work','main',f.models.main),id=randomUUID();
  const call={id,taskId:child.record.id,stageId:stage.id,role:'main',phase:'work',status:'in_flight',sent:true,events:[],
    payload:{internalBytes:'x'.repeat(200000)},actualModel:f.models.main};
  child.register(call);stage.callIds.push(id);child.writeRequest(call);child.save();
  child.appendRequestEvent(call,{choices:[{index:0,delta:{content:'Visible child stream'}}]});
  const paths=new Set([join(f.home,'requests',id+'.json'),join(f.home,'requests',id+'.events.jsonl')]);
  const original=fs.default.readFileSync;let reads=0;
  fs.default.readFileSync=function(path,...args){if(paths.has(String(path)))reads++;return original.call(this,path,...args);};syncBuiltinESMExports();
  try {
    const first=await h.get('/api/session?id='+sessionId);assert.equal(first.turns[0].finalText,'HISTORY_REPLY_1');
    child.appendRequestEvent(call,{choices:[{index:0,delta:{content:' continues'}}]});
    await h.get('/api/bootstrap');await h.get('/api/sessions');
    assert.equal(reads,0,'a conversation overview must not load execution payloads or growing event journals');
    const detail=await h.get('/api/task?id='+child.record.id);
    assert.ok(reads>0,'an explicit process read still observes the actual stored stream');
    assert.equal(detail.messages[0].text,'Visible child stream continues');assert.equal(detail.status,'outcome_unknown');
  } finally {fs.default.readFileSync=original;syncBuiltinESMExports();child.finish('partial');}
  assert.equal(f.calls.length,1);
});

test("legacy view stays byte-identical until explicit save and preserves the first observed result across a later revision", async t => {
  const {mkdirSync} = await import("node:fs");
  const f = await setup(t);
  let h = await host(t,f);
  const sessionId = await newSession(t,h), first = await send(h,sessionId,"Legacy result");
  const task = readTask(f.home,first.id), piPath = task.stages[0].sessionFile;
  await h.close();
  // Keep the exact Pi branch topology while recreating an old session without a GUI marker.
  const entries = readFileSync(piPath,"utf8").trim().split("\n").map(JSON.parse);
  const marker = entries.find(entry => entry.customType==="cothink-gui-workspace");
  marker.customType = "legacy-fixture";
  writeFileSync(piPath,entries.map(entry=>JSON.stringify(entry)).join("\n")+"\n");
  const viewDir=join(f.home,"session-ui"), viewPath=join(viewDir,sessionId+".json");
  mkdirSync(viewDir,{recursive:true});
  const original='{"schemaVersion":1, "revision":3, "archived":false, "pinned":true, "changedAt":null}\n';
  writeFileSync(viewPath,original);
  h = await host(t,f);
  const observed = await h.get("/api/session?id="+sessionId);
  assert.equal(observed.view.initialized,false);
  assert.equal(observed.view.seenResults[first.id],first.resultRevision);
  assert.equal(readFileSync(viewPath,"utf8"),original);
  const path=join(f.home,"requests",task.finalCallId+".json");
  const call=JSON.parse(readFileSync(path,"utf8"));
  writeFileSync(path,JSON.stringify({...call,text:"A newer result"}));
  const latest = await h.get("/api/session?id="+sessionId);
  assert.notEqual(latest.turns[0].resultRevision,first.resultRevision);
  assert.equal(latest.view.seenResults[first.id],first.resultRevision);
  const saved=await h.action("session.view",{sessionId,expectedViewRevision:observed.viewRevision,opened:true});
  assert.equal(saved.view.initialized,true);
  assert.equal(saved.view.seenResults[first.id],first.resultRevision);
  await h.close();
  h = await host(t,f);
  const restored = await h.get("/api/session?id="+sessionId);
  assert.equal(restored.view.seenResults[first.id],first.resultRevision);
  assert.equal(restored.turns[0].resultRevision,latest.turns[0].resultRevision);
  assert.equal(restored.navigation.revision,3);
  assert.equal(restored.navigation.pinned,true);
  assert.equal(f.calls.length,1);
});

test("workspace handles /team locally while busy and freezes one HTML submission per conversation until recovery",async()=>{
  await modalEnvironment(async({root,win,useGuiWorkspace})=>{
    const previous=Object.getOwnPropertyDescriptor(globalThis,"sessionStorage");
    Object.defineProperty(globalThis,"sessionStorage",{configurable:true,value:win.sessionStorage});
    const team={id:"fixture",name:"Fixture",main:{provider:"p",modelId:"main"},secondary:[]};
    const records={a:{id:"a",project:"/a",draft:"",turns:[],team},b:{id:"b",project:"/b",draft:"",turns:[],team}};
    let active={sessionId:"other",taskId:"running"}, unknown=false, found=false, workspace, taskStatus="completed";
    const submits=[],actions=[],taskReads=[];
    const api={subscribe:()=>()=>{},read:async(kind,args={})=>{
      if(kind==="bootstrap")return {protocol,teams:[],models:[],providers:[],sessions:Object.values(records),work:{},active};
      if(kind==="sessions")return {items:Object.values(records).filter(r=>!args.project || r.project===args.project),nextCursor:null};
      if(kind==="session")return records[args.id];
      if(kind==="task"){taskReads.push(args.id);if(args.id==="reserved")throw Error("ENOENT reserved task record");return {id:args.id,status:taskStatus};}
    },action:async(name,args)=>{
      actions.push({name,args});
      if(name==="session.draft"){
        const saved=records[args.sessionId]; saved.draft=args.text;
        saved.editor={text:args.text,workRequest:args.workRequest,selectionId:args.selectionId,editId:args.editId};
        saved.draftRevision=args.editId; saved.branchAnchor=args.editId; return saved;
      }
      if(name==="task.submit"){submits.push(args);if(unknown)throw Object.assign(Error("response lost"),{unknown:true});return {taskId:"task-b",sessionId:args.sessionId};}
      return {};
    },recover:async()=>found ? {taskId:"task-a"} : null};
    function Harness(){workspace=useGuiWorkspace(api);return null;}
    try{
      await act(async()=>root.render(React.createElement(Harness)));
      await act(()=>workspace.commands.setDraft("a","/team"));
      let result;await act(async()=>{result=await workspace.commands.submit({sessionId:"a"});});
      assert.deepEqual(result,{local:"team"});assert.equal(submits.length,0);assert.equal(workspace.state.pending,null);
      assert.equal(workspace.state.draft,"");
      active={sessionId:"a",taskId:"reserved",status:"preparing"};
      await act(async()=>workspace.commands.refresh());
      assert.equal(taskReads.includes("reserved"),false,"preparation must not read a reserved ID before the host registers it");
      assert.deepEqual(workspace.state.errors,[]);
      active={sessionId:"a",taskId:"registered",status:"running"};
      await act(async()=>workspace.commands.refresh());
      assert.equal(taskReads.includes("registered"),false,"unopened process details are not polled just because a task is active");
      await act(async()=>workspace.commands.selectTask("registered"));
      assert.ok(taskReads.includes("registered"),"an explicit reader request observes the registered task");
      active={sessionId:"a",taskId:"reserved",status:"running"};
      await act(async()=>workspace.commands.selectTask("reserved"));
      assert.match(workspace.state.errors[0],/ENOENT/,"missing records reported as readable still surface the real error");
      await act(()=>workspace.commands.setError(""));
      await act(async()=>workspace.commands.selectTask(null));
      active=null;await act(async()=>workspace.commands.refresh());
      await act(()=>workspace.commands.setWorkRequest("a",{kind:"html-svg"}));
      await act(async()=>workspace.commands.openSession("b"));
      assert.equal(workspace.state.workRequest,null);
      await act(()=>workspace.commands.setDraft("b","plain question"));
      await act(async()=>workspace.commands.submit({sessionId:"b"}));
      assert.equal(submits.length,1);assert.equal(submits[0].workRequest,undefined);
      await act(async()=>workspace.commands.openSession("a"));
      assert.deepEqual(workspace.state.workRequest,{kind:"html-svg"});
      await act(()=>workspace.commands.setDraft("a","make the page"));
      unknown=true;await act(async()=>workspace.commands.submit({sessionId:"a"}));
      assert.equal(submits.length,2);assert.equal(submits[1].workRequest,undefined,"legacy editor marker cannot bypass unified planning");assert.equal(submits[1].protocolVersion,1);
      const submissionId=submits[1].submissionId;
      assert.equal(workspace.state.pending.submissionId,submissionId);
      await act(()=>workspace.commands.setWorkRequest("a",null));
      assert.deepEqual(workspace.state.workRequest,{kind:"html-svg"},"pending intent cannot be changed into a second operation");
      await act(async()=>workspace.commands.submit({sessionId:"a"}));
      assert.equal(submits.length,2);
      await act(async()=>workspace.commands.recoverSubmission());
      assert.equal(workspace.state.pending.submissionId,submissionId);
      found=true;taskStatus="outcome_unknown";await act(async()=>workspace.commands.recoverSubmission());
      assert.equal(submits.length,2,"recovery never repeats task.submit");
      assert.equal(workspace.state.pending,null);assert.equal(workspace.state.workRequest,null);
      assert.equal(workspace.state.draft,"","confirmed recovery consumes only its submitted editor");
      assert.deepEqual(workspace.state.errors,[],"confirmed submission clears its resolved transport error");
      assert.equal(workspace.state.task.status,"outcome_unknown","submission acknowledgement does not resolve the task's own unknown result");
      assert.equal(actions.filter(a=>a.name==="task.submit").length,2);
      await act(()=>workspace.commands.setDraft("a","explicit next task"));
      await act(async()=>workspace.commands.submit({sessionId:"a"}));
      assert.equal(submits.length,3);
      await act(()=>workspace.commands.setError("response lost"));
      await act(async()=>workspace.commands.recoverSubmission());
      assert.deepEqual(workspace.state.errors,["response lost"],"a newer unrelated error survives even when its text matches the old submission error");
      assert.equal(submits.length,3,"confirming the second association sends nothing");
    }finally{
      await act(()=>root.unmount());
      if(previous)Object.defineProperty(globalThis,"sessionStorage",previous);else delete globalThis.sessionStorage;
    }
  });
});

test('a preflight-only continuation keeps the saved-file action in its conversation',async t=>{
 const f=await setup(t),h=await host(t,f),sessionId=await newSession(t,h),original=await send(h,sessionId,'Original result');
 const record=readTask(f.home,original.id),path=join(f.home,'tasks',record.id+'.json');
 Object.assign(record,{flow:'unified',status:'partial',error:'Startup stopped before a child task',finalCallId:null,requestIds:[],stages:[],projectOperation:{childTaskIds:[]}});
 writeFileSync(path,JSON.stringify(record));assert.equal((await h.get('/api/session?id='+sessionId)).turns[0].hasWork,false);
 record.projectOperation.continuation={draft:{taskId:'original-child',changeId:'saved-change',baseVersion:'old',version:'saved'}};
 writeFileSync(path,JSON.stringify(record));assert.equal((await h.get('/api/session?id='+sessionId)).turns[0].hasWork,true,'the existing continuation dialog must remain reachable for its original saved reference');
 assert.equal(f.calls.length,1,'projecting the action must not execute or reauthorize anything');
});
