import {GUI_INPUT_VERSION} from "../src/gui-turn-options.js";
import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { fixtureConversation, fixtureWorkspace, prepareSubmit } from "./helpers/gui-controller-fixture.js";
import { modalEnvironment } from "./gui-modal.fixture.js";

test("damaged Pi affiliation keeps history readable and requires an explicit context for creation", async t => {
  const {fixture}=await import("./helpers/pi-fixture.js");
  const {createGuiController}=await import("../src/gui-controller.js");
  const {saveConfig}=await import("../src/config.js");
  const {createTeamConfig}=await import("../src/teams.js");
  const {readFileSync,readdirSync,writeFileSync}=await import("node:fs");
  const {join}=await import("node:path");
  const f=await fixture(t,()=>({text:"保存的答复"}));
  const rosterId=crypto.randomUUID();
  saveConfig(f.home,createTeamConfig({formatVersion:2,...f.models},"Fixture",rosterId));
  const controller=await createGuiController({home:f.home,cwd:f.cwd});
  t.after(()=>controller.close());
  const {SessionManager}=await import("@earendil-works/pi-coding-agent");
  const manager=SessionManager.create(f.cwd,join(f.home,"pi/sessions/main"));
  manager.appendCustomEntry("cothink-project",{project:null});
  manager.appendCustomEntry("cothink-gui-workspace",{workspaceId:null});
  manager.appendCustomEntry("cothink-title",{title:"未分组旧记录"});
  manager.appendMessage({role:"user",content:"历史内容",timestamp:Date.now()});
  manager.appendMessage({role:"assistant",content:[{type:"text",text:"历史答复"}],api:"openai-completions",
    provider:"fixture",model:"main",usage:{input:0,output:0,totalTokens:0,cost:{input:0,output:0,total:0}},
    stopReason:"stop",timestamp:Date.now()});
  const generic=await controller.session(manager.getSessionId());
  const workspace=await fixtureWorkspace(t,controller,{defaultRosterId:rosterId});
  const damaged=await fixtureConversation(t,controller,{workspace});

  await controller.action("session.name",{sessionId:damaged.id,title:"归属异常夹具"});
  const {taskId}=await controller.action("task.submit",await prepareSubmit(controller,{
    sessionId:damaged.id,input:"保存的问题",submissionId:"unknown-affiliation",
  }));
  for (let i=0;i<200 && (await controller.task(taskId)).status==="running";i++)
    await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal((await controller.task(taskId)).status,"completed");
  const {draftRevision,branchAnchor}=await controller.session(damaged.id);
  await controller.action("session.draft",{sessionId:damaged.id,text:"保存的草稿",expectedDraftRevision:draftRevision,
    branchAnchor,editId:crypto.randomUUID(),workRequest:null,selectionId:null,turnOptions:null});
  const dir=join(f.home,"pi/sessions/main");
  const path=join(dir,readdirSync(dir).find(name=>name.endsWith(damaged.id+".jsonl")));
  const entries=readFileSync(path,"utf8").trimEnd().split("\n").map(JSON.parse);
  entries.find(entry=>entry.customType==="cothink-gui-workspace").data={workspaceId:"bad"};
  let bytes=entries.map(JSON.stringify).join("\n")+"\n";
  writeFileSync(path,bytes);

  try {
    const projected=await controller.session(damaged.id);
    assert.equal(projected.workspaceId,undefined);
    assert.equal(projected.readOnly,true);
    assert.match(projected.workspaceError,/归属损坏/);
    const globalPage=await controller.sessions();
    const damagedRow=globalPage.items.find(row=>row.id===damaged.id);
    assert.equal(damagedRow.workspaceId,undefined);
    assert.equal(damagedRow.workspaceError,projected.workspaceError);
    assert.equal(damagedRow.readOnly,true);
    assert.deepEqual((await controller.sessions({workspaceId:null})).items.map(row=>row.id),[generic.id]);

    await modalEnvironment(async ({root,container,win,useGuiWorkspace,Conversation,ConversationPicker,Navigation}) => {
      const previous=Object.getOwnPropertyDescriptor(globalThis,"sessionStorage");
      Object.defineProperty(globalThis,"sessionStorage",{configurable:true,value:win.sessionStorage});
      win.sessionStorage.setItem("cothink.session",damaged.id);
      const reads=[], creates=[];
      let gui;
      const waitList=async()=>{for (let i=0;i<50 && gui.state.navigationLoading;i++) await act(async()=>new Promise(resolve=>setTimeout(resolve,10)));};
      const api={
        subscribe:()=>()=>{},
        read:async (kind,args={})=>{
          reads.push({kind,args});
          if (kind==="session" || kind==="task") return controller[kind](args.id);
          return controller[kind]({...args,...(args.workspaceId==="" ? {workspaceId:null} : {})});
        },
        action:async (name,args)=>{
          if (name==="session.create") creates.push(args);
          return controller.action(name,args);
        },
      };
      function Harness() {
        gui=useGuiWorkspace(api);
        const {state,commands}=gui;
        return React.createElement(React.Fragment,null,
          React.createElement(Navigation,{workspaceId:state.workspaceId,ready:state.ready,connection:state.connection,
            workspaces:state.bootstrap.workspaces,onOpenWorkspace:commands.selectWorkspace}),
          React.createElement(Conversation,{state,commands}),
          React.createElement(ConversationPicker,{state,commands,scope:state.navigationQuery.scope,onOpenSession:commands.openSession}));
      }
      try {
        await act(async()=>root.render(React.createElement(Harness)));
        for (let i=0;i<50 && !gui.state.ready;i++) await act(async()=>new Promise(resolve=>setTimeout(resolve,10)));
        assert.equal(gui.state.ready,true);
        assert.equal(gui.state.workspaceId,undefined);
        assert.match(container.querySelector("h1").textContent,/归属待核对/);
        assert.equal(container.querySelector("nav [aria-current=page]"),null);
        assert.match(container.querySelector(".composer").textContent,/会话的 Team 归属损坏；原记录保留。/);
        assert.doesNotMatch(container.querySelector(".composer").textContent,/若被其他 CLI|发送前请在顶部选择阵容/);
        assert.match(container.textContent,/保存的答复/);
        assert.equal(container.querySelector("textarea").value,"保存的草稿");
        assert.equal(container.querySelector("textarea").disabled,true);
        assert.equal(reads.filter(row=>row.kind==="sessions").length,0,"unknown group cannot make a scoped listing");
        const newChat=[...container.querySelectorAll("button")].find(button=>button.textContent.includes("新建对话"));
        assert.equal(newChat.disabled,true);
        for (const options of [undefined,{workspaceId:undefined},{workspaceId:null}])
          await assert.rejects(gui.commands.createSession(options),/请先.*选择/);
        assert.equal(creates.length,0);

        await act(async()=>gui.commands.searchSessions({scope:"all",query:"保存的问题"}));
        await waitList();
        assert.equal(reads.at(-1).kind,"sessions");
        assert.equal(Object.hasOwn(reads.at(-1).args,"workspaceId"),false);
        assert.equal(gui.state.sessions.find(row=>row.id===damaged.id).match.taskId,taskId);
        assert.match(container.textContent,/归属待核对.*保存的问题/s);
        assert.ok(reads.some(row=>row.kind==="task" && row.args.id===taskId));
        assert.equal(readFileSync(path,"utf8"),bytes);

        // A well-formed ID with no Team row is also unknown, even for a live holder.
        entries.find(entry=>entry.customType==="cothink-gui-workspace").data={workspaceId:crypto.randomUUID()};
        bytes=entries.map(JSON.stringify).join("\n")+"\n";
        writeFileSync(path,bytes);
        await act(async()=>gui.commands.refresh());
        assert.equal(gui.state.workspaceId,undefined);
        assert.match(gui.state.session.workspaceError,/归属无法确认/);
        assert.match(container.querySelector(".composer").textContent,/归属无法确认/);
        assert.equal(gui.state.sessions.find(row=>row.id===damaged.id).workspaceId,undefined);
        assert.equal(container.querySelector("textarea").value,"保存的草稿");

        await act(async()=>gui.commands.searchSessions({scope:"all",query:""}));
        await waitList();
        const genericEntry=container.querySelector(`[title="${generic.title}"]`);
        assert.ok(genericEntry,"ungrouped history remains reachable through global search");
        await act(async()=>genericEntry.click());
        for (let i=0;i<50 && gui.state.session?.id!==generic.id;i++) await act(async()=>new Promise(resolve=>setTimeout(resolve,10)));
        assert.equal(gui.state.workspaceId,null);
        assert.equal(container.querySelector(`[title="${generic.title}"]`).getAttribute("aria-current"),"page");
        assert.equal(gui.state.session.id,generic.id);
        await act(async()=>gui.commands.searchSessions({scope:"project",query:""}));
        await waitList();
        assert.deepEqual(gui.state.sessions.map(row=>row.id),[generic.id]);
        await assert.rejects(gui.commands.createSession({workspaceId:null}),/请先.*选择/);
        assert.equal(creates.length,0);
        await act(async()=>gui.commands.createSession({workspaceId:workspace.id}));
        assert.equal(creates.length,1);
        assert.equal(creates[0].workspaceId,workspace.id);
        assert.equal(gui.state.session.workspaceId,workspace.id);
      } finally {
        await act(()=>root.unmount());
        if(previous)Object.defineProperty(globalThis,"sessionStorage",previous);else delete globalThis.sessionStorage;
      }
    });
    assert.equal(readFileSync(path,"utf8"),bytes);
    assert.equal(f.calls.length,1);
  } finally {
    await controller.close();
  }
});


test("Team navigation keeps project identity and distinguishes empty, archived and unavailable lists",async()=>{
 await modalEnvironment(async({root,container,Navigation})=>{
  const rows=[{id:"a",name:"CoThink 开发"},{id:"b",name:"LLM 学习",attention:{kind:"unread"}},{id:"c",name:"课程笔记"}];
  const props={workspaces:rows,workspaceId:"b",ready:true,connection:"connected"};
  await act(()=>root.render(React.createElement(Navigation,{...props,sessions:[{id:"s",workspaceId:"b",title:"Only in picker",navigation:{}}]})));
  assert.equal(container.querySelector('[aria-label="新建"]').textContent,"");
  assert.equal(container.querySelector('[aria-label="最近对话"],[title="Only in picker"],[aria-label*="中新建对话"]'),null);
  const selectedTeam=container.querySelector('[aria-current="page"]');
  assert.equal(selectedTeam.getAttribute("aria-label"),"LLM 学习");
  assert.equal(selectedTeam.title,"");
  assert.match(selectedTeam.getAttribute("aria-description"),/有新结果/);
  assert.doesNotMatch(selectedTeam.textContent,/LLM 学习/);
  await act(()=>root.render(React.createElement(Navigation,{...props,workspaces:[]})));
  assert.match(container.textContent,/创建第一个 Team，开始持续的工作。/);
  await act(()=>root.render(React.createElement(Navigation,{...props,workspaces:rows.map(row=>({...row,archived:true}))})));
  assert.match(container.textContent,/已归档 Team 可在搜索或设置中恢复/);
  assert.doesNotMatch(container.textContent,/创建第一个/);
  await act(()=>root.render(React.createElement(Navigation,{...props,workspaces:null})));
  assert.match(container.textContent,/工作列表暂不可用/);
  assert.doesNotMatch(container.textContent,/创建第一个/);
  await act(()=>root.render(React.createElement(Navigation,{...props,workspaces:[],connection:"reconnecting"})));
  assert.doesNotMatch(container.textContent,/创建第一个/);
 });
});


test("saved Team survives rejected or unknown first conversation creation without automatic recreation",async()=>{
 for (const unknown of [false,true]) await modalEnvironment(async({root,container,win,useGuiWorkspace,Conversation})=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,"sessionStorage");
  Object.defineProperty(globalThis,"sessionStorage",{configurable:true,value:win.sessionStorage});
  let gui;const workspaces=[],actions=[],reads=[];
  const api={subscribe:()=>()=>{},read:async(kind,args)=>{
    reads.push({kind,args});
    if(kind==="bootstrap")return {protocol:{unified:1},teams:[],models:[],providers:[],sessions:[],workspaces,work:{},active:null};
    if(kind==="sessions")return {items:[],workspaces};
    throw Error("Original session cannot yet be read");
  },action:async(name,args)=>{
    actions.push({name,args});
    if(name==="workspace.create") {const row={id:args.workspaceId,name:args.name,project:args.project,revision:1};workspaces.push(row);return row;}
    if(name==="session.create")throw Object.assign(Error(unknown?"lost acknowledgement":"creation rejected"),{unknown});
  }};
  function Harness(){gui=useGuiWorkspace(api);return React.createElement(Conversation,{state:gui.state,commands:gui.commands,workspace:gui.state.bootstrap.workspaces?.[0],onConversations(){}});}
  try {
    await act(async()=>root.render(React.createElement(Harness)));
    let saved;await act(async()=>{saved=await gui.commands.createWorkspace({name:"未发消息的 Team",project:"/team",defaultRosterId:null});});
    assert.equal(saved.id,workspaces[0].id);
    assert.equal(gui.state.session,null);
    assert.equal(gui.state.bootstrap.workspaces.length,1);
    assert.equal(actions.filter(row=>row.name==="workspace.create").length,1);
    const creates=actions.filter(row=>row.name==="session.create");assert.equal(creates.length,1);
    assert.match(container.textContent,/Team 已保存/);
    if(unknown){
      assert.match(container.textContent,/创建结果尚未确认/);
      assert.ok(container.textContent.includes(creates[0].args.sessionId));
      assert.deepEqual(reads.filter(row=>row.kind==="session").map(row=>row.args.id),[creates[0].args.sessionId]);
      assert.doesNotMatch(container.textContent,/从‘对话’中新建/);
    } else assert.match(container.textContent,/creation rejected/);
  } finally {
    if(previous)Object.defineProperty(globalThis,"sessionStorage",previous);else delete globalThis.sessionStorage;
  }
 });
});

test("stale homepage reservation and transfer expose draft recovery and keep the original creation ID",async()=>{
  for(const phase of ["reserve","transfer"]) await modalEnvironment(async({root,container,win,useGuiWorkspace,Conversation})=>{
    const previous=Object.getOwnPropertyDescriptor(globalThis,"sessionStorage");
    Object.defineProperty(globalThis,"sessionStorage",{configurable:true,value:win.sessionStorage});
    const draftId=crypto.randomUUID(), sessionId=crypto.randomUUID(), workspaceId=crypto.randomUUID();
    const editor={editorVersion:2,text:"Local saved text",editId:crypto.randomUUID(),workRequest:null,
      selectionId:null,turnOptions:null,materials:[{id:crypto.randomUUID(),sha256:"a".repeat(64)}]};
    const material=editor.materials.map(ref=>({...ref,status:"ready",name:"fixture.txt",mediaType:"text/plain",byteLength:12}));
    const initial={draftId,revision:1,editor,materials:material,pendingCreateSessionId:phase==="transfer"?sessionId:null,targetWorkspaceId:phase==="transfer"?workspaceId:null};
    let host=structuredClone(initial), gui;
    const requests=[];
    const savedSession=()=>({id:sessionId,project:"/team/conversation",workspaceId,team:null,turns:[],
      editor:host.editor,materials:material,draftRevision:"transferred",branchAnchor:"transferred"});
    const conflict=()=>Object.assign(Error("首页保存稿已变化"),{code:"DRAFT_CONFLICT"});
    const api={subscribe:()=>()=>{},read:async(kind,args)=>{
      if(kind==="bootstrap")return {protocol:{unified:1,guiInput:Number(GUI_INPUT_VERSION)},homeDraft:structuredClone(host),
        teams:[],models:[],providers:[],sessions:[],workspaces:[],work:{},active:null};
      if(kind==="sessions")return {items:[]};
      if(kind==="session-creation"){
        requests.push({name:"query",id:args.id});
        return {status:"confirmed",session:savedSession()};
      }
    },action:async(name,args)=>{
      requests.push({name,...args});
      if(name==="home.reserve")throw conflict();
      if(name==="home.draft"){
        assert.equal(args.expectedRevision,host.revision);
        host={...host,editor:args.editor,revision:host.revision+1};
        return structuredClone(host);
      }
      if(name==="home.transfer"){
        if(args.expectedRevision!==host.revision)throw conflict();
        const result=savedSession();
        host=null;
        return result;
      }
      throw Error("Unexpected mutation: "+name);
    }};
    function Harness(){
      gui=useGuiWorkspace(api);
      return React.createElement(Conversation,{state:gui.state,commands:gui.commands});
    }
    const button=label=>[...container.querySelectorAll("button")].find(node=>node.textContent===label);
    try {
      await act(async()=>root.render(React.createElement(Harness)));
      host={...host,revision:2,pendingCreateSessionId:sessionId,targetWorkspaceId:workspaceId,
        editor:{...editor,text:"Other window's saved text",editId:crypto.randomUUID()}};
      if(phase==="reserve")await act(async()=>assert.rejects(gui.commands.transferHome({workspaceId}),/首页保存稿已变化/));
      else await act(async()=>button("查询原会话").click());
      assert.equal(gui.state.draftConflict,true,phase);
      assert.equal(container.querySelector("textarea").value,editor.text);
      assert.ok(button("读取保存稿"));
      assert.ok(button("以本机稿再保存"));
      await act(async()=>button(phase==="reserve"?"读取保存稿":"以本机稿再保存").click());
      assert.equal(gui.state.draftConflict,false);
      assert.equal(gui.state.homeDraft.pendingCreateSessionId,sessionId);
      assert.deepEqual(gui.state.homeDraft.editor.materials,editor.materials);
      const expected=phase==="reserve"?"Other window's saved text":editor.text;
      assert.equal(container.querySelector("textarea").value,expected);
      await act(async()=>button("查询原会话").click());
      assert.ok(gui.state.session,JSON.stringify({phase,errors:gui.state.errors,requests}));
      assert.equal(gui.state.session.id,sessionId);
      assert.equal(container.querySelector("textarea").value,expected);
      assert.ok(requests.filter(row=>row.name==="query").every(row=>row.id===sessionId));
      assert.ok(requests.every(row=>!["session.create","task.submit"].includes(row.name)));
    } finally {
      await act(()=>root.unmount());
      if(previous)Object.defineProperty(globalThis,"sessionStorage",previous);else delete globalThis.sessionStorage;
    }
  });
});
