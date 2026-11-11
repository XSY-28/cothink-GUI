import test from "node:test";
import assert from "node:assert/strict";
import React, {act} from "react";
import {modalEnvironment} from "./gui-modal.fixture.js";
import {GUI_INPUT_VERSION} from "../src/gui-turn-options.js";

const team={id:"roster",name:"Roster",main:{provider:"p",modelId:"main"},secondary:[{provider:"p",modelId:"worker"}]};
const models=[{...team.main,name:"Main",thinkingLevels:["low","high","max"]},{...team.secondary[0],name:"Worker",thinkingLevels:["high","low"]}];
const boot={protocol:{unified:1,guiInput:Number(GUI_INPUT_VERSION)},teams:[team],models,providers:[],sessions:[],work:{},active:null};

test("composer offers exactly three unified levels beside send for legacy and current settings",async()=>{
 await modalEnvironment(async({root,container,win,Conversation})=>{
  const changes=[];
  const commands={changeSession:async(...args)=>changes.push(args),setError(){},recordView(){},setDraft(){},submit(){}};
  const session={id:"a",team,thinking:"max",thinkingScope:"main",turns:[]};
  const state={bootstrap:boot,session,selectedSessionId:"a",draft:"中文草稿",ready:true,errors:[],connection:"connected",materials:[]};
  const render=next=>act(()=>root.render(React.createElement(Conversation,{state:{...state,...next},commands})));
  await render();
  const trigger=container.querySelector('[aria-label="思考强度"]');
  assert.ok(trigger,"the composer exposes its thinking control");
  assert.match(trigger.textContent,/思考 max/);
  assert.equal(trigger.parentElement.parentElement.querySelector('button[type="submit"]').previousElementSibling,trigger.parentElement);
  await act(()=>trigger.dispatchEvent(new win.KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true,cancelable:true})));
  const choices=[...container.querySelectorAll('[role="menuitemradio"]')];
  assert.deepEqual(choices.map(node=>node.textContent),["low","high","max"]);
  assert.equal(win.document.activeElement,choices[0]);
  await act(()=>choices[0].dispatchEvent(new win.KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true,cancelable:true})));
  assert.equal(win.document.activeElement,choices[1]);
  await act(()=>choices[0].click());
  assert.deepEqual(changes,[["session.thinking",{scope:"all",level:"low"},"a"]]);
  assert.equal(win.document.activeElement,trigger);
  await act(()=>trigger.click());
  await act(()=>trigger.dispatchEvent(new win.KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true})));
  assert.equal(container.querySelector('[role="menu"]'),null);
  await render({session:{...session,thinking:"high",thinkingScope:"all"},bootstrap:{...boot,active:{sessionId:"a",status:"running"}}});
  assert.equal(container.querySelector('[aria-label="思考强度"]').disabled,false,"running tasks allow selecting the next task's level");
  await act(()=>container.querySelector('[aria-label="思考强度"]').click());
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

test("model errors stay visible without changing the fixed three menu levels",async()=>{
 await modalEnvironment(async({root,container,Conversation})=>{
  const state={bootstrap:{...boot,models:[models[0],{...models[1],thinkingLevels:["off"]}]},session:{id:"a",team,turns:[]},draft:"draft",ready:true,errors:[]};
  const commands={changeSession(){},setError(){},recordView(){}};
  await act(()=>root.render(React.createElement(Conversation,{state,commands})));
  await act(()=>container.querySelector('[aria-label="思考强度"]').click());
  assert.deepEqual([...container.querySelectorAll('[role="menuitemradio"]')].map(n=>n.textContent),["low","high","max"]);
  assert.match(container.textContent,/Worker.*high/);
  await act(()=>root.render(React.createElement(Conversation,{state:{...state,bootstrap:{...boot,models:[models[0]]}},commands})));
  assert.match(container.textContent,/目录.*worker/);
 });
});

async function workspaceFixture(run,{pendingRows}={}){
 await modalEnvironment(async({root,win,useGuiWorkspace})=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,"sessionStorage");
  Object.defineProperty(globalThis,"sessionStorage",{configurable:true,value:win.sessionStorage});
  if(pendingRows)win.sessionStorage.setItem("cothink.thinking-pending",JSON.stringify(pendingRows));
  const make=id=>({id,team,thinking:"high",thinkingScope:"all",project:null,turns:[],draft:"",editor:{text:"",workRequest:null,selectionId:null,editId:null,materials:[]},draftRevision:null,branchAnchor:"root-"+id});
  const records={a:make("a"),b:make("b")},writes=[],submits=[];
  let gui,finishThinking,lose=false,apply=true,readFails=false,beforeSessionRead=async()=>{};
  const api={subscribe:(_,status)=>{status("connected");return ()=>{};},read:async(kind,args={})=>{
   if(kind==="bootstrap")return {...boot,sessions:Object.values(records)};
   if(kind==="sessions")return {items:Object.values(records),nextCursor:null};
   if(kind==="session"){if(readFails)throw Error("read unavailable");await beforeSessionRead(args.id);return structuredClone(records[args.id]);}
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
    known:()=>{lose=false;apply=true;},onSessionRead:handler=>{beforeSessionRead=handler;},
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
  assert.equal(f.gui.state.session.thinking,"high");
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
  assert.equal(f.submits[0].thinking,"high");
  assert.equal(f.writes.filter(row=>row.name==="session.thinking").length,1);
 });
});

test("duplicate thinking recovery cannot release a newer save or submit its draft",async()=>{
 await workspaceFixture(async f=>{
  f.unknown({unreadable:true});let original,first,second,newer;
  await act(async()=>{original=f.gui.commands.changeSession("session.thinking",{scope:"all",level:"low"},"a");});
  await act(async()=>{f.finish();await original;});
  assert.equal(f.gui.state.thinkingSave?.status,"unknown");
  f.allowReads();f.known();
  let reads=0,releaseSecond=()=>{};
  f.onSessionRead(async()=>{if(++reads===2)await new Promise(resolve=>{releaseSecond=resolve;});});
  await act(async()=>{
   first=f.gui.commands.recoverThinkingSettings({adoptCurrent:true});
   second=f.gui.commands.recoverThinkingSettings({adoptCurrent:true});
   await first;
  });
  await act(async()=>{newer=f.gui.commands.changeSession("session.thinking",{scope:"all",level:"high"},"a");});
  await act(async()=>{releaseSecond();await second;});
  try{
   assert.equal(f.gui.state.thinkingSave?.status,"saving","the stale recovery must not clear the new high save's pending identity");
   await act(()=>f.gui.commands.setDraft("a","keep the next draft"));
   await act(async()=>f.gui.commands.submit({sessionId:"a"}));
   assert.equal(f.submits.length,0,"send remains blocked until the new setting's own receipt");
   assert.equal(f.gui.state.session.thinking,"low");
  }finally{await act(async()=>{f.finish();await newer;});}
  assert.equal(f.gui.state.session.thinking,"high");
  assert.equal(f.gui.state.thinkingSave,null);
  assert.equal(f.writes.filter(row=>row.name==="session.thinking").length,2,"one original choice and one new choice, with no replay");
 });
});



test("old pending empty and extra-level changes adopt saved current settings without replay and retain drafts",async()=>{
 for(const level of [undefined,null,"","medium","xhigh","off"]){
  await workspaceFixture(async f=>{
   assert.equal(f.gui.state.thinkingSave?.status,"unknown");
   await act(()=>f.gui.commands.setDraft("a","retained upgrade draft"));
   await act(async()=>f.gui.commands.recoverThinkingSettings());
   assert.equal(f.gui.state.thinkingSave,null);
   assert.equal(f.gui.state.session.thinking,"high");
   assert.equal(f.gui.state.draft,"retained upgrade draft");
   assert.equal(f.writes.filter(row=>row.name==="session.thinking").length,0,"never replays a pre-upgrade choice");
  },{pendingRows:[["a",{scope:"all",level}]]});
 }
});


test("thinking diagnostics use the selected level and configured output cap rather than catalog defaults",async t=>{
 const {fixture}=await import('./helpers/pi-fixture.js');
 const {readFileSync,writeFileSync}=await import('node:fs');const {join}=await import('node:path');
 const {createModelRuntime,projectModelFacts}=await import('../src/pi-runtime.js');
 const f=await fixture(t),path=join(f.home,'pi/models.json'),catalog=JSON.parse(readFileSync(path,'utf8'));
 catalog.providers.fixture.models[0].api='anthropic-messages';
 catalog.providers.fixture.models[1].thinkingLevelMap={off:null,minimal:null,low:'low',medium:null,high:null,xhigh:null,max:null};
 writeFileSync(path,JSON.stringify(catalog));
 const runtime=await createModelRuntime(f.home);
 const roster={...team,main:{...f.models.main,maxOutputTokens:4096},secondary:[f.models.secondary[0]]};
 const facts=await Promise.all([roster.main,...roster.secondary].map(ref=>projectModelFacts(runtime,{provider:ref.provider,modelId:ref.modelId,thinkingLevel:'high'})));
 assert.equal(facts[0].unavailableCode,'REQUIRED_OUTPUT_LIMIT');assert.equal(facts[1].available,false);
 for(const ref of [roster.main,...roster.secondary])assert.equal((await projectModelFacts(runtime,{...ref,thinkingLevel:'low'})).available,true);
 await modalEnvironment(async({root,container,Conversation})=>{
  const commands={changeSession(){},setError(){},recordView(){}};
  const render=async({level='low',refs=roster,models=facts}={})=>act(()=>root.render(React.createElement(Conversation,{state:{bootstrap:{...boot,models},session:{id:'a',team:refs,thinking:level,thinkingScope:'all',turns:[]},draft:'keep draft',ready:true,errors:[]},commands})));
  await render();await act(()=>container.querySelector('[aria-label="思考强度"]').click());
  const menu=()=>container.querySelector('[role="menu"]');
  assert.deepEqual([...container.querySelectorAll('[role="menuitemradio"]')].map(node=>node.textContent),['low','high','max']);
  assert.doesNotMatch(menu().textContent,/需要|要求|不支持|不可用/,'valid configured limits and low selection must clear only stale parameter errors');
  await render({refs:{...roster,main:{...f.models.main}}});assert.match(menu().textContent,/输出|maxOutputTokens/);
  await render({level:'high'});assert.match(menu().textContent,/r1.*high/);
  for(const issue of [{auth:'missing',unavailableCode:'MODEL_UNAVAILABLE',unavailableReason:'AUTH_ERROR_SENTINEL'},
   {transport:'unsupported',unavailableCode:'MODEL_TRANSPORT',unavailableReason:'TRANSPORT_ERROR_SENTINEL'},
   {unavailableCode:'CUSTOM_CONFIG',unavailableReason:'CONFIG_ERROR_SENTINEL'}]){
   await render({models:[{...facts[0],...issue},facts[1]]});assert.match(menu().textContent,new RegExp(issue.unavailableReason));
   assert.equal(container.querySelectorAll('[role="menuitemradio"]').length,3);
  }
 });
 assert.equal(f.calls.length,0);
});

test("damaged roster levels stay visible and allow correction or deletion without inventing a fourth option",async()=>{
 await modalEnvironment(async({root,container,TeamPanel,win})=>{
  const damaged={...team,id:'damaged',name:'Damaged',main:{...team.main,thinkingLevel:'future'}};
  const good={...team,id:'good',name:'Good'},saves=[],deletes=[];
  const commands={saveTeam:async value=>{saves.push(value);return {...value,id:'saved'};},removeTeam:async args=>deletes.push(args)};
  const render=current=>act(()=>root.render(React.createElement(TeamPanel,{session:{id:'a',team:current},teams:[damaged,good],models,providers:[{id:'p',configured:true}],commands,onClose(){}})));
  await render(damaged);assert.match(container.textContent,/future/);assert.ok(container.querySelector('[aria-label="管理 Damaged"]'));
  await act(()=>container.querySelector('[aria-label="管理 Damaged"]').click());
  await act(()=>container.querySelector('[aria-label="调整 Damaged"]').click());
  const select=container.querySelector('[aria-label="主模型思考档位"]');
  assert.deepEqual([...select.options].map(option=>option.value),['low','high','max']);
  assert.equal(select.selectedIndex,-1,'unknown data must not silently display low/high/max');
  assert.equal(select.getAttribute('aria-invalid'),'true');assert.match(container.textContent,/无法识别.*future/);
  const name=container.querySelector('[aria-label="新阵容名称"]');
  await act(()=>{Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype,'value').set.call(name,'Corrected roster');name.dispatchEvent(new win.Event('input',{bubbles:true}));});
  assert.equal(select.selectedIndex,-1,'an unrelated rerender must not display low for the still-invalid stored value');
  assert.equal(select.value,'');assert.equal(select.getAttribute('aria-invalid'),'true');
  assert.deepEqual([...select.options].map(option=>option.value),['low','high','max']);

  await act(()=>{select.value='low';select.dispatchEvent(new win.Event('change',{bubbles:true}));});
  assert.equal(select.getAttribute('aria-invalid'),null);
  await act(async()=>container.querySelector('form').dispatchEvent(new win.Event('submit',{bubbles:true,cancelable:true})));
  assert.equal(saves[0].main.thinkingLevel,'low');
  await render(good);await act(()=>container.querySelector('[aria-label="管理 Damaged"]').click());
  await act(()=>container.querySelector('[aria-label="删除 Damaged"]').click());
  await act(async()=>[...container.querySelectorAll('button')].find(button=>button.textContent==='确认删除').click());
  assert.deepEqual(deletes,[{sessionId:'a',teamId:'damaged'}]);
 });
});
