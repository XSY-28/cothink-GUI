import test from "node:test";
import assert from "node:assert/strict";
import React, {act} from "react";
import {modalEnvironment} from "./gui-modal.fixture.js";
import {GUI_INPUT_VERSION} from "../src/gui-turn-options.js";

const team={id:"roster",name:"Roster",main:{provider:"p",modelId:"main"},secondary:[{provider:"p",modelId:"worker"}]};
const models=[{...team.main,name:"Main",thinkingLevels:["low","high","max"]},{...team.secondary[0],name:"Worker",thinkingLevels:["high","low"]}];
const boot={protocol:{unified:1,guiInput:Number(GUI_INPUT_VERSION)},teams:[team],models,providers:[],sessions:[],work:{},active:null};

test("composer offers common SDK levels beside send and preserves legacy main-only settings",async()=>{
 await modalEnvironment(async({root,container,win,Conversation})=>{
  const changes=[];
  const commands={changeSession:async(...args)=>changes.push(args),setError(){},recordView(){},setDraft(){},submit(){}};
  const session={id:"a",team,thinking:"max",thinkingScope:"main",turns:[]};
  const state={bootstrap:boot,session,selectedSessionId:"a",draft:"中文草稿",ready:true,errors:[],connection:"connected",materials:[]};
  const render=next=>act(()=>root.render(React.createElement(Conversation,{state:{...state,...next},commands})));
  await render();
  const trigger=container.querySelector('[aria-label="思考强度"]');
  assert.ok(trigger,"the composer exposes its thinking control");
  assert.match(trigger.textContent,/主模型 max/);
  assert.equal(trigger.parentElement.parentElement.querySelector('button[type="submit"]').previousElementSibling,trigger.parentElement);
  await act(()=>trigger.dispatchEvent(new win.KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true,cancelable:true})));
  const choices=[...container.querySelectorAll('[role="menuitemradio"]')];
  assert.deepEqual(choices.map(node=>node.textContent),["跟随阵容","low","high"]);
  assert.equal(win.document.activeElement,choices[0]);
  await act(()=>choices[0].dispatchEvent(new win.KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true,cancelable:true})));
  assert.equal(win.document.activeElement,choices[1]);
  await act(()=>choices[1].click());
  assert.deepEqual(changes,[["session.thinking",{scope:"all",level:"low"},"a"]]);
  assert.equal(win.document.activeElement,trigger);
  await act(()=>trigger.click());
  await act(()=>trigger.dispatchEvent(new win.KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true})));
  assert.equal(container.querySelector('[role="menu"]'),null);
  await render({session:{...session,thinking:"high",thinkingScope:"all"},bootstrap:{...boot,active:{sessionId:"a",status:"running"}}});
  assert.equal(container.querySelector('[aria-label="思考强度"]').disabled,false,"running tasks allow selecting the next task's level");
  await act(()=>container.querySelector('[aria-label="思考强度"]').click());
  assert.match(container.textContent,/作用于下一条消息/);
  await render({session:{...session,id:"b"},selectedSessionId:"b"});
  assert.equal(container.querySelector('[role="menu"]'),null,"navigation closes the original menu");
  await render({bootstrap:{...boot,protocol:{unified:1,guiInput:3}}});
  assert.equal(container.querySelector('[aria-label="思考强度"]').disabled,true);
  assert.equal(container.querySelector('button[type="submit"]').disabled,true,"protocol 3 cannot submit an all-scope setting");
  for(const next of [{session:{...session,readOnly:true}},{session:{...session,team:null}},{session:null},
    {thinkingSave:{status:"saving"}},{thinkingSave:{status:"unknown"}}, {connection:"reconnecting"}]){
   await render(next);
   assert.equal(container.querySelector('[aria-label="思考强度"]').disabled,true);
  }
 });
});

test("incompatible and missing model capabilities explain the roster without inventing levels",async()=>{
 await modalEnvironment(async({root,container,Conversation})=>{
  const state={bootstrap:{...boot,models:[models[0],{...models[1],thinkingLevels:["off"]}]},session:{id:"a",team,turns:[]},draft:"draft",ready:true,errors:[]};
  const commands={changeSession(){},setError(){},recordView(){}};
  await act(()=>root.render(React.createElement(Conversation,{state,commands})));
  await act(()=>container.querySelector('[aria-label="思考强度"]').click());
  assert.deepEqual([...container.querySelectorAll('[role="menuitemradio"]')].map(n=>n.textContent),["跟随阵容"]);
  assert.match(container.textContent,/共同支持.*Main.*Worker/);
  await act(()=>root.render(React.createElement(Conversation,{state:{...state,bootstrap:{...boot,models:[models[0]]}},commands})));
  assert.match(container.textContent,/目录.*worker/);
 });
});

async function workspaceFixture(run){
 await modalEnvironment(async({root,win,useGuiWorkspace})=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,"sessionStorage");
  Object.defineProperty(globalThis,"sessionStorage",{configurable:true,value:win.sessionStorage});
  const make=id=>({id,team,thinking:null,thinkingScope:null,project:null,turns:[],draft:"",editor:{text:"",workRequest:null,selectionId:null,editId:null,materials:[]},draftRevision:null,branchAnchor:"root-"+id});
  const records={a:make("a"),b:make("b")},writes=[],submits=[];
  let gui,finishThinking,lose=false,apply=true,readFails=false;
  const api={subscribe:(_,status)=>{status("connected");return ()=>{};},read:async(kind,args={})=>{
   if(kind==="bootstrap")return {...boot,sessions:Object.values(records)};
   if(kind==="sessions")return {items:Object.values(records),nextCursor:null};
   if(kind==="session"){if(readFails)throw Error("read unavailable");return structuredClone(records[args.id]);}
   if(kind==="task")return {id:args.id,status:"completed"};
  },action:async(name,args)=>{
   writes.push({name,args:structuredClone(args)});
   const row=records[args.sessionId];
   if(name==="session.draft"){
    assert.equal(args.expectedDraftRevision,row.draftRevision,"conditional editor writes retain their host revision");
    assert.equal(args.branchAnchor,row.branchAnchor,"settings receipts must rebase the editor branch anchor");
    Object.assign(row,{draft:args.text,editor:{text:args.text,workRequest:args.workRequest,selectionId:args.selectionId,editId:args.editId,materials:args.materials},draftRevision:args.editId,branchAnchor:args.editId});
   }
   if(name==="session.thinking"){
    await new Promise(resolve=>{finishThinking=resolve;});
    if(apply)Object.assign(row,{thinking:args.level??null,thinkingScope:args.scope,branchAnchor:"thinking-"+writes.length});
    if(lose)throw Object.assign(Error("save response lost"),{unknown:true});
   }
   if(name==="task.submit"){submits.push({args:structuredClone(args),thinking:row.thinking});return {taskId:"task",sessionId:args.sessionId};}
   return structuredClone(row);
  }};
  function Harness(){gui=useGuiWorkspace(api);return null;}
  try{
   await act(async()=>root.render(React.createElement(Harness)));
   await run({get gui(){return gui;},records,writes,submits,
    finish:()=>finishThinking(),unknown:({persist=true,unreadable=false}={})=>{lose=true;apply=persist;readFails=unreadable;},allowReads:()=>{readFails=false;},
    settle:()=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,700));})});
  }finally{
   await act(()=>root.unmount());
   if(previous)Object.defineProperty(globalThis,"sessionStorage",previous);else delete globalThis.sessionStorage;
  }
 });
}

test("malformed optional thinking recovery storage does not prevent opening the workspace",async()=>{
 for(const stored of [{scope:"all"},[null,["a"],["a",null],["b",{scope:"all",level:42}]]]){
  await modalEnvironment(async({root,win,useGuiWorkspace})=>{
   const previous=Object.getOwnPropertyDescriptor(globalThis,"sessionStorage");
   Object.defineProperty(globalThis,"sessionStorage",{configurable:true,value:win.sessionStorage});
   win.sessionStorage.setItem("cothink.thinking-pending",JSON.stringify(stored));
   let gui;
   const api={subscribe:()=>()=>{},read:async kind=>kind==="bootstrap"?{...boot,sessions:[]}:kind==="sessions"?{items:[]}:null};
   function Harness(){gui=useGuiWorkspace(api);return null;}
   try{await act(async()=>root.render(React.createElement(Harness)));assert.equal(gui.state.ready,true);}
   finally{await act(()=>root.unmount());if(previous)Object.defineProperty(globalThis,"sessionStorage",previous);else delete globalThis.sessionStorage;}
  });
 }
});

test("thinking save serializes with typed drafts, immediately blocks send and rebases newer edits",async()=>{
 await workspaceFixture(async f=>{
  await act(()=>f.gui.commands.setDraft("a","first"));
  let saving;
  await act(async()=>{
   saving=f.gui.commands.changeSession("session.thinking",{scope:"all",level:"low"},"a");
   await f.gui.commands.submit({sessionId:"a"});
  });
  assert.equal(f.submits.length,0,"an immediate programmatic send cannot race the setting save");
  await act(()=>f.gui.commands.setDraft("a","newer 中文草稿"));
  await f.settle();
  await act(async()=>{f.finish();await saving;});
  await f.settle();
  assert.equal(f.records.a.editor.text,"newer 中文草稿");
  assert.equal(f.gui.state.draftConflict,false);
  assert.equal(f.gui.state.thinkingSave,null);
  await act(async()=>f.gui.commands.submit({sessionId:"a"}));
  assert.equal(f.submits.length,1);
  assert.equal(f.submits[0].thinking,"low");
  assert.equal(f.submits[0].args.input,"newer 中文草稿");
 });
});

test("unknown thinking response recovers by reading and late receipts stay with their original session",async()=>{
 await workspaceFixture(async f=>{
  f.unknown();let saving;
  await act(async()=>{saving=f.gui.commands.changeSession("session.thinking",{scope:"all",level:"high"},"a");});
  await act(async()=>f.gui.commands.openSession("b"));
  await act(async()=>{f.finish();await saving;});
  assert.equal(f.gui.state.session.id,"b");
  assert.equal(f.gui.state.session.thinking,null);
  await act(async()=>f.gui.commands.openSession("a"));
  assert.equal(f.gui.state.session.thinking,"high");
  assert.equal(f.gui.state.thinkingSave,null);
  assert.equal(f.writes.filter(row=>row.name==="session.thinking").length,1);
 });
});

test("unknown unapplied save stays blocked until explicit adoption of persisted settings without replay",async()=>{
 await workspaceFixture(async f=>{
  f.unknown({persist:false,unreadable:true});let saving;
  await act(()=>f.gui.commands.setDraft("a","keep unsent"));
  await act(async()=>{saving=f.gui.commands.changeSession("session.thinking",{scope:"all",level:"low"},"a");});
  await act(async()=>{f.finish();await saving;});
  assert.equal(f.gui.state.thinkingSave?.status,"unknown");
  await act(async()=>f.gui.commands.submit({sessionId:"a"}));
  assert.equal(f.submits.length,0);
  f.allowReads();
  await act(async()=>f.gui.commands.recoverThinkingSettings({adoptCurrent:true}));
  assert.equal(f.gui.state.thinkingSave,null);
  assert.equal(f.gui.state.draft,"keep unsent");
  await act(async()=>f.gui.commands.submit({sessionId:"a"}));
  assert.equal(f.submits.length,1);
  assert.equal(f.submits[0].thinking,null);
  assert.equal(f.writes.filter(row=>row.name==="session.thinking").length,1);
 });
});
