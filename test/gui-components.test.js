import {GUI_INPUT_VERSION} from "../src/gui-turn-options.js";
import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { Window } from "happy-dom";
import { Composer } from "../gui/src/Composer.js";
import { fixtureConversation } from "./helpers/gui-controller-fixture.js";
import { componentUrl, modalEnvironment } from "./gui-modal.fixture.js";

const protocol={unified:1,guiInput:Number(GUI_INPUT_VERSION)};

test('skill settings show host capabilities and save only explicit disabled names',async()=>{
 await modalEnvironment(async({root,container,Settings})=>{
  const saved=[],boot={configured:true,version:'fixture',providers:[],models:[],teams:[],work:{},builtinSkills:{names:['doc-maintenance','context-management'],disabled:[]}};
  const capabilities={phase:'next-turn',skills:[{name:'doc-maintenance',version:'0.1.0',description:'Docs',explicitOnly:false}],tools:['read_skill'],permissions:{fileWrite:false,scriptExecution:false},environment:{managedExecutionConfigured:false,contextToolsAvailable:false},diagnostics:[]};
  await act(async()=>root.render(React.createElement(Settings,{boot,session:{id:'selected'},initialTab:'skills',commands:{getCapabilities:async id=>{assert.equal(id,'selected');return capabilities;},saveBuiltinSkills:async args=>saved.push(args)},onClose(){}})));
  await act(async()=>{await new Promise(r=>setTimeout(r,0));});
  assert.match(container.textContent,/当前角色不可用/);assert.match(container.textContent,/当前未获文件写入权限/);
  const toggle=container.querySelector('input[type="checkbox"]');await act(()=>toggle.click());
  await act(async()=>container.querySelector('form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})));
  assert.deepEqual(saved,[{builtinSkills:{disabled:['doc-maintenance']}}]);assert.match(container.textContent,/技能选择已保存/);
 });
});
test('unknown builtin save reads actual persisted preference once without replaying the write',async t=>{
 const {fixture}=await import('./helpers/pi-fixture.js'),{createGuiController}=await import('../src/gui-controller.js'),{saveConfig}=await import('../src/config.js'),{createTeamConfig}=await import('../src/teams.js');
 const f=await fixture(t);saveConfig(f.home,createTeamConfig({formatVersion:2,...f.models},'Fixture','7c8094cd-3476-4bfa-8f53-055d87972896'));
 const controller=await createGuiController({home:f.home,cwd:f.cwd});t.after(()=>controller.close());
 await modalEnvironment(async({root,win,useGuiWorkspace})=>{
  const prior=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage');Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:win.sessionStorage});let workspace,writes=0,persist=true;
  const api={subscribe:()=>()=>{},read:async(kind,args={})=>kind==='session'?controller.session(args.id):kind==='sessions'?controller.sessions(args):controller.bootstrap(),action:async(name,args)=>{writes++;if(persist)await controller.action(name,args);throw Object.assign(Error('lost saved receipt'),{unknown:true});}};
  function Harness(){workspace=useGuiWorkspace(api);return null;}
  try {await act(async()=>root.render(React.createElement(Harness)));let result;
   await act(async()=>{result=await workspace.commands.saveBuiltinSkills({builtinSkills:{disabled:['doc-maintenance']}});});
   assert.equal(writes,1);assert.deepEqual(result.disabled,['doc-maintenance']);assert.deepEqual(workspace.state.bootstrap.builtinSkills.disabled,['doc-maintenance']);assert.equal(f.calls.length,0);
   persist=false;await act(async()=>{await assert.rejects(workspace.commands.saveBuiltinSkills({builtinSkills:{disabled:[]}}),{unknown:true});});assert.equal(writes,2);assert.deepEqual((await controller.bootstrap()).builtinSkills.disabled,['doc-maintenance']);
  }finally{await act(()=>root.render(null));if(prior)Object.defineProperty(globalThis,'sessionStorage',prior);else delete globalThis.sessionStorage;}
 });
});
test('formal capability panel labels coordinator and executor permissions separately and refreshes actors',async()=>{
 await modalEnvironment(async({root,container,Settings})=>{
  const base={phase:'project',scope:'coordinator',skills:[],tools:[],permissions:{fileWrite:false,scriptExecution:false},environment:{managedExecutionConfigured:true,contextToolsAvailable:false},diagnostics:[]};
  const executor={...base,phase:'work',source:{taskId:'owned-task',stageId:'owned-stage',role:'main'},tools:['read','write','resource_exec'],permissions:{fileWrite:true,scriptExecution:true}};
  let reads=0,resolveRefresh;const boot={configured:true,version:'fixture',providers:[],models:[],teams:[],work:{},builtinSkills:{names:['doc-maintenance','context-management'],disabled:[]},active:{taskId:'root',status:'running'}};
  const props={boot,session:{id:'session'},initialTab:'skills',commands:{getCapabilities:async()=>{reads++;return reads===1?{...base,executors:[executor]}:new Promise(resolve=>resolveRefresh=resolve);}},onClose(){}};
  await act(async()=>root.render(React.createElement(Settings,props)));
  const coordinator=container.querySelector('[aria-label="能力来源 协调器"]'),child=container.querySelector('[aria-label="能力来源 所属执行者 main"]');
  assert.match(coordinator.textContent,/当前未获文件写入权限/);assert.doesNotMatch(coordinator.textContent,/resource_exec/);
  assert.match(child.textContent,/当前允许受管文件写入/);assert.match(child.textContent,/resource_exec/);assert.match(container.textContent,/协调器与所属执行者/);
  await act(async()=>root.render(React.createElement(Settings,{...props,boot:{...boot,active:{taskId:'root',status:'running'}}})));
  assert.ok(container.querySelector('[aria-label="能力来源 所属执行者 main"]'),'same-owner refresh keeps readable content while the request is pending');
  await act(async()=>resolveRefresh({...base,executors:[]}));
  assert.equal(container.querySelector('[aria-label="能力来源 所属执行者 main"]'),null);assert.match(container.textContent,/尚无已绑定的活动执行者/);assert.equal(reads,2);
 });
});

test("Settings contains Tab focus while work fields are disabled by an active task or a pending save", async () => {
  await modalEnvironment(async ({ win, container, root, Settings }) => {
    const base = {
      configured: true,
      teams: [],
      models: [],
      providers: [],
      work: { checks: [] },
      releaseNotes: { full: "local" },
      version: "fixture",
    };
    let finishSave;
    for (const state of ["active", "busy"]) {
      const props = {
        boot: {protocol,
          ...base,
          active: state === "active" ? { taskId: "running" } : null,
        },
        session: null,
        commands: {
          saveWorkSettings: () =>
            new Promise((resolve) => {
              finishSave = resolve;
            }),
        },
        onRefresh: async () => {},
        onTeamSaved: async () => {},
        onClose: () => {},
      };
      await act(() =>
        root.render(React.createElement(Settings, { ...props, key: state })),
      );
      await act(() =>
        [...container.querySelectorAll(".settings-nav button")]
          .find((n) => n.textContent === "项目执行")
          .click(),
      );
      if (state === "busy")
        await act(() =>
          container
            .querySelector("form")
            .dispatchEvent(
              new win.Event("submit", { bubbles: true, cancelable: true }),
            ),
        );
      const save = [...container.querySelectorAll("button")].find(
        (n) => n.textContent === "保存工作设置",
      );
      assert.equal(save.disabled, false, "the control itself is not disabled");
      assert.equal(
        save.closest("fieldset").disabled,
        true,
        "the ancestor fieldset disables this control",
      );
      const close = container.querySelector('[aria-label="关闭设置"]'),
        lastEnabled = state === "active"
          ? [...container.querySelectorAll("button")].find(n=>n.textContent === "返回运行任务")
          : container.querySelector(".settings-advanced summary");
      lastEnabled.focus();
      const forward = new win.KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      });
      await act(() => lastEnabled.dispatchEvent(forward));
      assert.equal(
        forward.defaultPrevented,
        true,
        `${state}: forward Tab must wrap before disabled descendants`,
      );
      assert.equal(win.document.activeElement, close);
      const reverse = new win.KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      await act(() => close.dispatchEvent(reverse));
      assert.equal(
        reverse.defaultPrevented,
        true,
        `${state}: reverse Tab must wrap`,
      );
      assert.equal(win.document.activeElement, lastEnabled);
      if (state === "busy")
        await act(async () => {
          finishSave({});
        });
    }
  });
});

test("Modal skips invisible ancestor controls and uses a collapsed summary as a real focus stop", async () => {
  await modalEnvironment(async ({ win, container, root, Modal }) => {
    let closes=0;
    await act(() =>
      root.render(
        React.createElement(
          Modal,
          { title: "Focus", onClose: () => {closes++;} },
          React.createElement(
            "details",
            null,
            React.createElement("summary", null, "More"),
            React.createElement("button", null, "Closed content"),
          ),
          React.createElement(
            "div",
            { hidden: true },
            React.createElement("button", null, "Hidden ancestor"),
          ),
          React.createElement(
            "div",
            { style: { display: "none" } },
            React.createElement("button", null, "No display"),
          ),
          React.createElement(
            "div",
            { style: { visibility: "hidden" } },
            React.createElement("button", null, "No visibility"),
          ),
        ),
      ),
    );
    const summary = container.querySelector("summary"),
      close = container.querySelector('[aria-label="关闭Focus"]');
    summary.focus();
    const forward = new win.KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    await act(() => summary.dispatchEvent(forward));
    assert.equal(forward.defaultPrevented, true);
    assert.equal(win.document.activeElement, close);
    const reverse = new win.KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(() => close.dispatchEvent(reverse));
    assert.equal(reverse.defaultPrevented, true);
    assert.equal(win.document.activeElement, summary);
    summary.blur();
    assert.equal(win.document.activeElement,win.document.body);
    await act(()=>win.document.body.dispatchEvent(new win.KeyboardEvent("keydown",{key:"Tab",bubbles:true,cancelable:true})));
    assert.equal(win.document.activeElement,close,"orphan focus returns to the modal on Tab");
    close.blur();
    await act(()=>win.document.body.dispatchEvent(new win.KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true})));
    assert.equal(closes,1,"Escape still closes after a focused control is removed");
    container.setAttribute("inert","");
    await act(()=>win.document.body.dispatchEvent(new win.KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true})));
    assert.equal(closes,1,"an inert parent modal cannot consume the active layer's Escape");
    container.removeAttribute("inert");
  });
});

test("composer blocks IME confirmation, keeps drafts editable during a run and leaves roster to the header", async () => {
  await modalEnvironment(async ({ win, container, root }) => {
    const sent = [];
    const team = {
      id: "t",
      name: "Fixture",
      main: { provider: "p", modelId: "main" },
      secondary: [],
    };
    const base = {
      session: { id: "s", mode: "cothink", team },
      boot: {protocol,
        teams: [team],
        models: [
          { provider: "p", modelId: "main", thinkingLevels: ["low", "high"] },
        ],
      },
      draft: "中文草稿",
      onDraft: () => {},
      onSubmit: () => sent.push("sent"),
      onChange: () => {},
      onSettings: () => {},
    };
    await act(() => root.render(React.createElement(Composer, base)));
    const textarea = container.querySelector("textarea");
    await act(() =>
      textarea.dispatchEvent(
        new win.CompositionEvent("compositionstart", { bubbles: true }),
      ),
    );
    await act(() =>
      textarea.dispatchEvent(
        new win.KeyboardEvent("keydown", {
          key: "Enter",
          keyCode: 229,
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    await act(() =>
      textarea.dispatchEvent(
        new win.CompositionEvent("compositionend", { bubbles: true }),
      ),
    );
    await act(() =>
      textarea.dispatchEvent(
        new win.KeyboardEvent("keydown", {
          key: "Enter",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    assert.equal(sent.length, 0);
    await act(() =>
      textarea.dispatchEvent(
        new win.KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    assert.equal(sent.length, 1);
    assert.equal(container.querySelector('[aria-label="team"]'), null);
    assert.equal(container.querySelectorAll('[type="submit"]').length, 1);

    await act(() =>
      root.render(React.createElement(Composer, { ...base, busy: true })),
    );
    assert.equal(container.querySelector("textarea").disabled, false);
    assert.equal(container.querySelector('[type="submit"]').disabled, true);
    assert.doesNotMatch(container.textContent, /下一条模式/);
    await act(() =>
      container.querySelector("textarea").dispatchEvent(
        new win.KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    assert.equal(sent.length, 1);
  });
});


test("invalid work-check arguments show a form error and do not send a settings action", async () => {
  const win = new Window({ url: "http://localhost/" }),
    prior = {};
  win.document.write("<!doctype html><html><body></body></html>");
  // happy-dom lacks compatMode; the shipped index has a standards-mode doctype.
  Object.defineProperty(win.document, "compatMode", { value: "CSS1Compat" });
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Event",
    "KeyboardEvent",
    "CompositionEvent",
    "DOMParser",
  ]) {
    prior[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: win[key],
    });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { Settings } = await import(componentUrl);
  const { createRoot } = await import("react-dom/client");
  const container = win.document.createElement("div");
  win.document.body.append(container);
  const root = createRoot(container),
    actions = [];
  const boot = {protocol,
    configured: true,
    teams: [],
    models: [],
    providers: [],
    work: { checks: [{ command: "npm", args: ["test"] }] },
    releaseNotes: { full: "local" },
    version: "fixture",
  };
  try {
    await act(() =>
      root.render(
        React.createElement(Settings, {
          boot,
          session: null,
          commands: {
            saveWorkSettings: async (...args) => {
              actions.push(args);
              return {};
            },
          },
          onRefresh: async () => {},
          onTeamSaved: async () => {},
          onClose: () => {},
        }),
      ),
    );
    const workButton = [...container.querySelectorAll("button")].find(
      (n) => n.textContent === "项目执行",
    );
    await act(() => workButton.click());
    const args = [...container.querySelectorAll("label")]
      .find((n) => n.textContent.includes("参数（JSON 数组）"))
      .querySelector("input");
    await act(() => {
      Object.getOwnPropertyDescriptor(
        win.HTMLInputElement.prototype,
        "value",
      ).set.call(args, "{ malformed");
      args.dispatchEvent(new win.Event("input", { bubbles: true }));
      args.dispatchEvent(new win.Event("change", { bubbles: true }));
    });
    await act(() =>
      container
        .querySelector("form")
        .dispatchEvent(
          new win.Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    assert.match(
      container.querySelector('[role="alert"]')?.textContent || "",
      /参数.*JSON/,
    );
    assert.equal(actions.length, 0);
  } finally {
    await act(() => root.unmount());
    win.happyDOM.abort();
    for (const [key, descriptor] of Object.entries(prior)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});

test("application refreshes preserve typed drafts across sessions and cancel the actual active task from history", async () => {
  const win = new Window({ url: "http://127.0.0.1:9999/#token=fixture" }),
    prior = {};
  Object.defineProperty(win.document, "compatMode", { value: "CSS1Compat" });
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Event",
    "KeyboardEvent",
    "CompositionEvent",
    "DOMParser",
    "sessionStorage",
    "localStorage",
  ]) {
    prior[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: win[key],
    });
  }
  for (const key of ["matchMedia", "requestAnimationFrame"]) {
    prior[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: win[key].bind(win),
    });
  }
  prior.fetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { App } = await import(componentUrl),
    { createRoot } = await import("react-dom/client");
  const container = win.document.createElement("div");
  win.document.body.append(container);
  const root = createRoot(container);
  const team = {
    id: "t",
    name: "Fixture",
    main: { provider: "p", modelId: "main" },
    secondary: [{ provider: "p", modelId: "review" }],
  };
  const sessions = {
    a: {
      id: "a",
      title: "Active chat",
      workspaceId:null,
      persisted: true, navigation:{revision:0,archived:false,pinned:false},
      project: null,
      mode: "cothink",
      team,
      draft: "saved a",
      turns: [
        {
          taskId: "task-a",
          input: "running task",
          status: "running",
          mode: "cothink",
          finalText: "",
        },
      ],
      readOnly: false,
    },
    b: {
      id: "b",
      title: "History chat",
      workspaceId:null,
      persisted: true, navigation:{revision:0,archived:false,pinned:false},
      project: null,
      mode: "one",
      team,
      draft: "saved b",
      turns: [],
      readOnly: false,
    },
  };
  const task = {
    id: "task-a",
    sessionId: "a",
    status: "running",
    phase: "draft",
    mode: "cothink",
    team,
    participants: [],
    messages: [],
    usage: { calls: 0 },
    work: null,
  };
  let active = { taskId: "task-a", sessionId: "a", status: "running" },
    stream, delaySessionA = false, releaseSessionA, rejectSubmission, loseNextPin = false, notesUnread = true;
  const actions = [];
  globalThis.fetch = async (path, options) => {
    const url = new URL(path, "http://fixture");
    if (url.pathname === "/api/events")
      return new Response(
        new ReadableStream({
          start(controller) {
            stream = controller;
            options.signal.addEventListener("abort", () => controller.close(), {
              once: true,
            });
          },
        }),
      );
    let result;
    if (url.pathname === "/api/bootstrap")
      result = {
        protocol,
        configured: true,
        version: "fixture",
        teams: [team],
        models: [{ provider: "p", modelId: "main", thinkingLevels: [] }],
        providers: [],
        sessions: Object.values(sessions).filter(s=>!s.navigation.archived),
        active,
        work: {},
        releaseNotes: { unread: notesUnread, full: "local", summary:"Installed fixture changes" },
      };
    else if (url.pathname === "/api/sessions") result = {items:Object.values(sessions).filter(s=>{
      const archived=url.searchParams.get("archived") || "active";
      return archived==="all" || (archived==="archived" ? s.navigation.archived : !s.navigation.archived);
    }),nextCursor:null,errors:[]};
    else if (url.pathname === "/api/session") {
      const id = url.searchParams.get("id");
      if (id === "a" && delaySessionA) {
        delaySessionA = false;
        await new Promise(resolve => {releaseSessionA = resolve;});
      }
      result = sessions[id];
    }
    else if (url.pathname === "/api/task") result = task;
    else if (url.pathname === "/api/action") {
      const body = JSON.parse(options.body);
      actions.push(body);
      if(body.action === "releaseNotes.ack") notesUnread=false;
      if (body.action === "task.submit") await new Promise((_, reject) => {rejectSubmission = reject;});
      if (body.action === "session.draft") {
        const saved=sessions[body.args.sessionId];
        saved.draft=body.args.text;
        saved.editor={text:body.args.text,workRequest:body.args.workRequest,selectionId:body.args.selectionId,editId:body.args.editId};
        saved.draftRevision=body.args.editId; saved.branchAnchor=body.args.editId;
        return new Response(JSON.stringify(saved));
      }
      if (["session.archive","session.pin"].includes(body.action)) {
        const s=sessions[body.args.sessionId], field=body.action === "session.pin" ? "pinned" : "archived";
        assert.equal(s.navigation.revision,body.args.expectedRevision);
        s.navigation={...s.navigation,[field]:body.args[field],revision:s.navigation.revision+1};
        if (field==="pinned" && loseNextPin) {loseNextPin=false;throw Error("pin response lost");}
        return new Response(JSON.stringify({sessionId:s.id,navigation:s.navigation}));
      }
      if (body.action === "task.cancel") {
        assert.equal(body.args.taskId, "task-a");
        active = null;
        task.status = "cancelled";
      }
      result = {};
    }
    return new Response(JSON.stringify(result));
  };
  const settle = () =>
    act(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });
  const showHistory = async () => {
    if (!container.querySelector('[role="dialog"][aria-label="对话"]')) {
      await act(()=>container.querySelector(".conversation-picker-trigger").click());
      await settle();
    }
  };
  const pickerRow = title => container.querySelector('[role="dialog"][aria-label="对话"]').querySelector(`[title="${title}"]`);
  const assertUngrouped = () => assert.match(container.querySelector("h1").textContent,/未分组对话/);
  const openHistory = async title => {
    await showHistory();
    await act(()=>pickerRow(title).click());
    await settle();
  };
  try {
    await act(async () => {
      root.render(React.createElement(App));
    });
    await settle();
    assert.equal(container.querySelector("textarea").value, "saved a");
    assert.equal(container.querySelector('[role="dialog"]'),null,"unread release notes never interrupt startup");
    const settingsButton=container.querySelector('nav button[aria-label="设置"]');
    assert.equal(settingsButton.getAttribute("aria-description"),"更新记录未读");
    assert.equal(settingsButton.textContent.trim(),"");
    await act(()=>container.querySelector('[aria-label="暂时收起本地更新提示"]').click());
    assert.equal(actions.some(a=>a.action==="releaseNotes.ack"),false,"dismissing a notice is not acknowledgement");
    assert.doesNotMatch(container.textContent,/查看本次更新/);
    await act(()=>settingsButton.click());
    await act(()=>[...container.querySelectorAll('.settings-nav button')].find(b=>b.textContent==='偏好与更新').click());
    await act(()=>container.querySelector('.local-release summary').click());
    assert.equal(actions.some(a=>a.action==="releaseNotes.ack"),false,"opening notes is not acknowledgement");
    await act(()=>[...container.querySelectorAll('button')].find(b=>b.textContent==='我已看过此版本更新').click());
    await settle();
    assert.equal(actions.filter(a=>a.action==="releaseNotes.ack").length,1);
    assert.equal(actions.find(a=>a.action==="releaseNotes.ack").args.version,'fixture');
    await act(()=>container.querySelector('[aria-label="关闭设置"]').click());
    assert.equal(container.querySelector('nav [title="Active chat"]'),null,"conversation history belongs in the project picker");
    assert.equal([...container.querySelectorAll("header.topbar button")].filter(n=>n.getAttribute("aria-label") === "阵容").length,1);
    await showHistory();
    const runningMenu=pickerRow("Active chat").parentElement.querySelector('details');
    await act(()=>runningMenu.querySelector('summary').click());
    assert.equal([...runningMenu.querySelectorAll('button')].find(b=>b.textContent==="归档对话").disabled,true);
    assert.match(runningMenu.textContent,/任务进行中/);
    await act(()=>runningMenu.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})));
    assert.equal(runningMenu.open,false);
    assert.equal(win.document.activeElement,runningMenu.querySelector('summary'));
    await act(() => {
      const input = container.querySelector("textarea");
      Object.getOwnPropertyDescriptor(
        win.HTMLTextAreaElement.prototype,
        "value",
      ).set.call(input, "new unsent a");
      input.dispatchEvent(new win.Event("input", { bubbles: true }));
    });
    await act(() => {
      stream.enqueue(
        new TextEncoder().encode("event: invalidate\ndata: {}\n\n"),
      );
    });
    await settle();
    assert.equal(container.querySelector("textarea").value, "new unsent a");
    await openHistory("History chat");
    assert.equal(container.querySelector("textarea").value, "saved b");
    await openHistory("Active chat");
    assert.equal(container.querySelector("textarea").value, "new unsent a");
    await openHistory("History chat");
    await act(() =>
      [...container.querySelectorAll("button")]
        .find((n) => n.textContent === "停止")
        .click(),
    );
    await settle();
    assert.equal(actions.filter((a) => a.action === "task.cancel").length, 1);
    assert.equal(actions.some((a) => a.action === "task.submit"), false);

    // A slow historical read cannot take the user back from B to A.
    delaySessionA = true;
    await openHistory("Active chat");
    await openHistory("History chat");
    await act(() => releaseSessionA());
    await settle();
    assertUngrouped();
    assert.equal(container.querySelector("textarea").value, "saved b");

    await openHistory("Active chat");
    assert.equal(container.querySelector('[aria-label="查看过程"]'),null);
    assert.equal(container.querySelector("textarea").value, "new unsent a");
    assert.equal(actions.some(a => a.action === "task.submit"), false);

    // An uncertain A submission remains associated with A while B stays selected.
    await act(() => container.querySelector("form.composer").dispatchEvent(new win.Event("submit", {bubbles:true,cancelable:true})));
    await settle();
    assert.equal(actions.filter(a => a.action === "task.submit").length, 1);
    await openHistory("History chat");
    await act(() => rejectSubmission(Error("lost response")));
    await settle();
    assertUngrouped();
    assert.equal(container.querySelector("textarea").value, "saved b");
    assert.equal(JSON.parse(win.sessionStorage.getItem("cothink.pending")).sessionId, "a");
    assert.match(container.textContent, /提交确认丢失/);
    await act(() => container.querySelector("form.composer").dispatchEvent(new win.Event("submit", {bubbles:true,cancelable:true})));
    assert.equal(actions.filter(a => a.action === "task.submit").length, 1);
    await act(()=>[...container.querySelectorAll("button")].find(b=>b.textContent==="保留草稿并放弃关联").click());
    const archiveRow = async title => {
      await showHistory();
      const row=pickerRow(title).parentElement;
      await act(()=>row.querySelector("summary").click());
      await act(()=>[...row.querySelectorAll("button")].find(b=>b.textContent==="归档对话").click());
      await settle();
    };
    await archiveRow("History chat");
    assertUngrouped();
    assert.equal(container.querySelector("textarea").value,"new unsent a");
    await archiveRow("Active chat");
    assertUngrouped();
    assert.equal(actions.some(a=>a.action==="session.create"),false,"archiving the last visible row never creates an empty history");
    await act(()=>container.querySelector('[role="dialog"][aria-label="对话"] button[aria-label^="关闭"]').click());
    await act(()=>settingsButton.click());
    await act(()=>[...container.querySelectorAll("button")].find(b=>b.textContent==="已归档").click());
    await settle();
    const archivedRow=container.querySelector('[title="History chat"]').parentElement;
    await act(()=>archivedRow.querySelector("summary").click());
    await act(()=>[...archivedRow.querySelectorAll("button")].find(b=>b.textContent==="恢复对话").click());
    await settle();
    assertUngrouped();
    assert.equal(container.querySelector("textarea").value,"","restoring in settings leaves the empty homepage editor");
    await act(()=>container.querySelector('[aria-label="关闭设置"]').click());
    await settle();
    await showHistory();
    loseNextPin=true;
    const restoredRow=pickerRow("History chat").parentElement;
    await act(()=>restoredRow.querySelector("summary").click());
    await act(()=>[...restoredRow.querySelectorAll("button")].find(b=>b.textContent==="置顶").click());
    await settle();
    assert.equal(actions.filter(a=>a.action==="session.pin").length,1,"lost navigation response is never resent");
    assert.match(container.textContent,/已置顶/);
    assert.equal(actions.filter(a=>a.action==="task.submit").length,1);
    await act(()=>container.querySelector('[role="dialog"][aria-label="对话"] button[aria-label^="关闭"]').click());
    // A delayed archive read must not dismiss a newer roster editor.
    await act(()=>settingsButton.click());
    await act(()=>[...container.querySelectorAll("button")].find(b=>b.textContent==="已归档").click());
    await settle();
    delaySessionA=true;
    await act(()=>container.querySelector('[title="Active chat"]').click());
    await settle();
    await act(()=>[...container.querySelectorAll('.settings-nav button')].find(b=>/认证/.test(b.textContent)).click());
    await act(()=>[...container.querySelectorAll('button')].find(b=>b.textContent==='打开阵容').click());
    assert.equal(container.querySelector('[role="dialog"] h2')?.textContent,'阵容');
    await act(()=>[...container.querySelectorAll('.team-modal button')].find(b=>b.textContent==='＋ 新建阵容').click());
    await act(()=>{const input=container.querySelector('[aria-label="新阵容名称"]');Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype,'value').set.call(input,'Unsent team');input.dispatchEvent(new win.Event('input',{bubbles:true}));});
    await act(()=>releaseSessionA());
    await settle();
    assert.equal(container.querySelector('[role="dialog"] h2')?.textContent,'阵容','older settings callback cannot dismiss a newer overlay');
    assert.equal(container.querySelector('[aria-label="新阵容名称"]').value,'Unsent team');
  } finally {
    await act(() => root.unmount());
    win.happyDOM.abort();
    for (const [key, descriptor] of Object.entries(prior)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});

test('a model used as a work member is not also labeled unused because its reviewer role was idle',async()=>{
 await modalEnvironment(async({root,container,Collaboration})=>{
  const model=id=>({provider:'fixture',modelId:id});
  const task={id:'work',status:'completed',phase:'work',participants:[
   {id:'main',role:'main',model:model('main'),participated:true,status:'completed'},
   ...['r1','r2','r3'].map((id,i)=>({id:'reviewer-'+(i+1),role:'reviewer-'+(i+1),model:model(id),participated:false,status:'not_called'})),
   {id:'actual-member',role:'member',model:model('r1'),participated:true,status:'completed'}],
   messages:[{id:'member-call',role:'member:actual-member',model:model('r1'),text:'actual member',phase:'worker',status:'completed'}],work:{members:[{id:'actual-member',model:model('r1'),status:'completed'}],activities:[]},usage:{calls:9}};
  await act(()=>root.render(React.createElement(Collaboration,{task,expanded:false,tab:'collaboration',setTab(){},onExpand(){},onClose(){},api:{}})));
  assert.match(container.textContent,/完整阵容 · 2 位本轮未参与/);
  const unused=[...container.querySelectorAll('.inactive-member')].map(x=>x.textContent);
  assert.ok(unused.every(x=>!x.includes('r1')));assert.equal(container.querySelectorAll('.participant').length,2);
 });
});

test("new process view distinguishes assigned scopes, actual requests and checker coverage", async () => {
  await modalEnvironment(async ({root,container,Collaboration})=>{
    const model={provider:"fixture",modelId:"shared"};
    const source={id:"child",stepId:"step",relation:"owned",status:"partial",actualRoles:true,
      scope:{assignment:"Verify the file boundary",read:["notes.md"],write:[]},
      participants:[{id:"member",staffId:"file-checker",role:"member",position:"employee",requestRole:"member:member",
        assignment:"核对指定材料",reason:"熟悉此格式",readScope:["notes.md"],scope:[],selectedModel:model,model,
        status:"outcome_unknown",pause:{status:"unknown",unresolvedRequestIds:["worker-call"]}}],
      messages:[{id:"worker-call",role:"member:member",phase:"worker",actualModel:model,status:"outcome_unknown",sent:true,
        error:"响应未确认",maxOutputTokens:700}],
      skillReads:[{name:"doc-maintenance",path:"SKILL.md",hash:"skill-hash",role:"member:member",stageId:"worker"}],
    };
    const task={id:"root",actualRoles:true,managerFlow:true,participants:[],messages:[],budget:{maxCalls:8},
      usage:{calls:3},status:"partial",executionTasks:[source],rosterCandidates:[model],
      processCheck:{status:"blocked",interval:60000,gap:{code:"PROCESS_BUDGET",message:"本轮检查额度耗尽"},observations:[
        {id:"observation",kind:"periodic",sequence:1,status:"completed",delayMs:1000,missedIntervals:1,actualModel:model,
          usage:{input:12,output:6},members:[{taskId:"child",memberId:"member",status:"waiting",covered:true,blockers:1},
            {taskId:"child",memberId:"queued",status:"queued",covered:false}],
          reports:[{id:"issue",taskId:"child",memberId:"member",leaderId:"main",kind:"blocker",reason:"等待文件读取",status:"forwarded"}]},
      ]},
    };
    await act(()=>root.render(React.createElement(Collaboration,{task,expanded:true,tab:"collaboration",setTab(){},onExpand(){},onClose(){},commands:{}})));
    assert.match(container.textContent,/本轮请求上限 8/);
    assert.match(container.textContent,/员工 · file-checker/);
    assert.match(container.textContent,/选人理由：熟悉此格式/);
    assert.match(container.textContent,/读取范围：notes\.md/);
    assert.match(container.textContent,/停止未确认/);
    assert.match(container.textContent,/700 tokens/);
    assert.match(container.textContent,/已读取技能.*doc-maintenance/s);
    assert.match(container.textContent,/覆盖 1 \/ 2/);
    assert.match(container.textContent,/跳过 1 个间隔/);
    assert.match(container.textContent,/等待文件读取.*已送直属负责人/s);
    assert.match(container.textContent,/本轮检查额度耗尽/);
    assert.doesNotMatch(container.textContent,/独立评审|主答初稿/);
  });
});

test('update settings keep controls disabled during a check and show a save failure without claiming success', async () => {
  await modalEnvironment(async ({container,root,Settings})=>{
    const {createUpdateService,formatUpdateStatus,updateInstructions}=await import('../src/updates.js');
    const {mkdtempSync,rmSync}=await import('node:fs');const {join}=await import('node:path');const {tmpdir}=await import('node:os');
    const home=mkdtempSync(join(tmpdir(),'gui-update-settings-'));
    const service=createUpdateService({home,currentVersion:'1.0.0',env:{},fetchImpl:async()=>new Response(JSON.stringify({name:'cothink-v2',version:'2.0.0'}))});
    await service.check({manual:true});const s=service.snapshot();
    const boot={protocol,configured:true,teams:[],models:[],providers:[],work:{},version:'1.0.0',releaseNotes:{full:'local'},updates:{...s,message:formatUpdateStatus(s),instructions:updateInstructions(s)}};
    let calls=0,fail;
    const commands={configureUpdates:async()=>{calls++;await new Promise((_,reject)=>fail=reject);}};
    try {
      await act(()=>root.render(React.createElement(Settings,{boot,session:null,commands,onRefresh:async()=>{},onClose:()=>{},initialTab:'updates'})));
      const check=[...container.querySelectorAll('button')].find(b=>b.textContent==='检查更新');
      const toggle=container.querySelector('.update-settings input[type="checkbox"]');
      await act(()=>toggle.click());
      assert.equal(calls,1);assert.equal(toggle.disabled,true);assert.equal(check.disabled,true);
      await act(()=>fail(Error('无法保存更新偏好，原文件保留。')));
      assert.equal(toggle.checked,true);assert.match(container.textContent,/无法保存更新偏好/);
      assert.doesNotMatch(container.textContent,/设置已保存/);assert.equal(check.disabled,false);
      assert.match(container.textContent,/页面连接本机宿主；查新由宿主访问 npm/);
      const desktopBoot={...boot,installation:'desktop',updates:{channel:'desktop-local',currentVersion:'1.0.0',message:'本地桌面候选'}};
      await act(()=>root.render(React.createElement(Settings,{key:'desktop',boot:desktopBoot,session:null,commands,onRefresh:async()=>{},onClose:()=>{},initialTab:'updates'})));
      assert.match(container.textContent,/桌面仅显示本地版本与随包更新记录/);
      assert.doesNotMatch(container.textContent,/查新由宿主访问 npm/);
      assert.equal([...container.querySelectorAll('button')].some(b=>b.textContent==='检查更新'),false);
    } finally {service.close();rmSync(home,{recursive:true,force:true});}
  });
});

test('collaboration shows unresolved conflict and separates a completed mismatch review from semantic success', async()=>{
  await modalEnvironment(async({root,container,Collaboration})=>{
    const task={id:'fidelity-ui',status:'partial',phase:'visual-review',participants:[],messages:[],usage:{calls:8},work:{
      activities:[],acceptance:[{status:'accepted'}],members:[{id:'m',model:{provider:'fixture',modelId:'r1'},taskConflict:{message:'原题自行车骑鹈鹕，委派颠倒。',unresolved:true},feedback:['撤回颠倒建议']}],
      visualEvidence:[{toolCallId:'image',entry:'index.html',actor:'main',checked:true,semanticMatch:false,result:'captured',imageRequestId:'review',imageRequestCompleted:true,viewport:{width:375,height:667},images:[],review:{verdict:'mismatch',status:'completed',observation:'看到鹈鹕骑自行车',reasons:'主体关系与原题相反'}}],
    }};
    const props={task,expanded:true,setTab(){},onExpand(){},onClose(){},api:{}};
    await act(()=>root.render(React.createElement(Collaboration,{...props,tab:'collaboration'})));
    assert.match(container.textContent,/成员题意冲突 · 尚未解决/);
    assert.match(container.textContent,/撤回颠倒建议/);
    await act(()=>root.render(React.createElement(Collaboration,{...props,tab:'checks'})));
    assert.match(container.textContent,/最终版本审查完成/);
    assert.match(container.textContent,/模型判断不符合/);
    assert.match(container.textContent,/主体关系与原题相反/);
    assert.doesNotMatch(container.textContent,/模型判断符合/);
  });
});


test("removed Option+M mode shortcut leaves text and submission untouched", async () => {
  await modalEnvironment(async ({win, container, root}) => {
    const changes = [], drafts = [], submissions = [];
    const base = {
      session: {id: "s", mode: "cothink"}, boot: {protocol,models: [], teams: []},
      draft: "keep this draft", onDraft: value => drafts.push(value),
      onSubmit: () => submissions.push(true), onChange: (...args) => changes.push(args),
      onSettings: () => {},
    };
    const render = props => act(() => root.render(React.createElement(Composer, {...base, ...props})));
    const press = async (overrides = {}) => {
      const event = new win.KeyboardEvent("keydown", {key: "µ", code: "KeyM", altKey: true,
        bubbles: true, cancelable: true, ...overrides});
      await act(() => container.querySelector("textarea").dispatchEvent(event));
      return event;
    };
    await render({});
    assert.equal((await press()).defaultPrevented, false);
    assert.deepEqual(changes, []);
    await render({busy: true, session: {...base.session, mode: "one"}});
    await press();
    assert.deepEqual(changes, []);
    for (const event of [{repeat: true}, {isComposing: true}, {keyCode: 229},
      {ctrlKey: true}, {metaKey: true}, {shiftKey: true}, {altKey: false}]) await press(event);
    assert.equal(changes.length, 0);
    for (const props of [{session: {...base.session, readOnly: true}},
      {session: {...base.session, selectionError: "write failed"}}, {submitting: true}, {pending: true}]) {
      await render(props); await press();
    }
    assert.equal(changes.length, 0);
    assert.equal(container.querySelector("textarea").value, "keep this draft");
    assert.deepEqual(drafts, []);
    assert.deepEqual(submissions, []);
  });
});


test("archived settings search and restore stay in settings while viewing selects the matched message",async()=>{
  await modalEnvironment(async({root,container,Settings,win})=>{
    const boot={protocol,configured:true,teams:[],models:[],providers:[],work:{},version:"fixture",releaseNotes:{full:"local"}};
    let archived=true,closes=0; const requests=[], changes=[], opens=[];
    const row={id:"archived",title:"Saved answer",project:null,persisted:true,navigation:{revision:3,archived:true,pinned:false},match:{snippet:"needle answer",taskId:"old-task",field:"finalText"}};
    const commands={
      querySessions:async args=>{requests.push(args);return {items:archived ? [row] : [],nextCursor:null};},
      setSessionNavigation:async args=>{changes.push(args);archived=false;},
      openSession:(...args)=>opens.push(args),
    };
    await act(async()=>root.render(React.createElement(Settings,{boot,commands,initialTab:"archives",onClose(){closes++;},api:{},onRefresh(){}})));
    assert.match(container.textContent,/needle answer/);
    const menu=container.querySelector('[title="Saved answer"]').parentElement.querySelector('details');
    await act(()=>menu.querySelector('summary').click());
    await act(()=>menu.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})));
    assert.equal(menu.open,false);
    assert.ok(container.querySelector('[role="dialog"]'),"Escape in a row menu leaves settings open");
    assert.equal(win.document.activeElement,menu.querySelector('summary'));
    await act(()=>menu.querySelector('summary').dispatchEvent(new win.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})));
    assert.equal(closes,1,"a closed row menu passes the next Escape to its modal");
    await act(()=>container.querySelector('[title="Saved answer"]').click());
    assert.deepEqual(opens,[["archived","old-task",undefined,"finalText"]]);
    await act(async()=>{
      const input=container.querySelector('input');
      Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype,"value").set.call(input,"needle");
      input.dispatchEvent(new win.Event("input",{bubbles:true}));
    });
    assert.equal(requests.at(-1).query,"needle"); assert.equal(requests.at(-1).archived,"archived");
    await act(async()=>[...container.querySelectorAll('button')].find(b=>b.textContent==="恢复对话").click());
    assert.deepEqual(changes,[{sessionId:"archived",expectedRevision:3,change:{archived:false}}]);
    assert.equal(opens.length,1,"restore does not navigate");
    assert.match(container.textContent,/没有匹配的归档对话/);
  });
});

test("archived composer preserves draft and blocks submission without claiming another writer",async()=>{
  await modalEnvironment(async({root,container,win})=>{
    let sends=0;
    await act(()=>root.render(React.createElement(Composer,{session:{id:"a",navigation:{archived:true},mode:"one",team:{id:"t",main:{provider:"p",modelId:"m"},secondary:[]}},boot:{protocol,models:[],teams:[]},draft:"keep unsent",onDraft(){},onSubmit(){sends++;},onChange(){},onSettings(){}})));
    assert.equal(container.querySelector('textarea').disabled,true);
    assert.equal(container.querySelector('textarea').value,"keep unsent");
    assert.match(container.textContent,/已归档/); assert.doesNotMatch(container.textContent,/被其他入口占用/);
    await act(()=>container.querySelector('form').dispatchEvent(new win.Event("submit",{bubbles:true,cancelable:true})));
    assert.equal(sends,0);
  });
});


test("delayed new-chat preserves the old draft and a newer navigation wins",async()=>{
  await modalEnvironment(async({root,container,win,useGuiWorkspace})=>{
    const previous=Object.getOwnPropertyDescriptor(globalThis,"sessionStorage");
    Object.defineProperty(globalThis,"sessionStorage",{configurable:true,value:win.sessionStorage});
    const records={a:{id:"a",workspaceId:"team-a",project:"/a",draft:"draft A",turns:[]},b:{id:"b",workspaceId:"team-b",project:"/b",draft:"draft B",turns:[]},c:{id:"c",workspaceId:"team-c",project:"/c",draft:"draft C",turns:[]}};
    const delays=new Map(), creates=[], forks=[];
    const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
    const api={
      subscribe:()=>()=>{},
      read:async(kind,args={})=>{
        const key=kind === "session" ? "session:"+args.id : kind === "sessions" && args.project ? "project:"+args.project : null;
        if(key && delays.has(key)){const wait=delays.get(key);delays.delete(key);await wait.promise;}
        if(kind === "bootstrap")return {protocol,teams:[],models:[],providers:[],sessions:[records.a],work:{},active:null};
        if(kind === "session")return records[args.id];
        if(kind === "sessions")return {items:Object.values(records).filter(s=>!args.project || s.project===args.project),nextCursor:null};
      },
      action:async(name,args)=>{
        if(name === "session.fork"){const wait=deferred();forks.push({wait,args});return wait.promise;}
        if(name !== "session.create")return {};
        const wait=deferred();creates.push({wait,workspaceId:args.workspaceId});return wait.promise;
      },
    };
    function Harness(){
      const {state,commands}=useGuiWorkspace(api);
      const run=p=>p.catch(e=>commands.setError(e.message));
      return React.createElement("div",null,
        ...["a","b","c"].map(id=>React.createElement("button",{key:id,onClick:()=>run(commands.openSession(id))},"open "+id)),
        React.createElement("button",{onClick:()=>run(commands.selectProject("/b"))},"project B"),
        React.createElement("button",{onClick:()=>run(commands.createSession({workspaceId:"team-a"}))},"new A"),
        React.createElement("button",{onClick:()=>run(commands.createSession({workspaceId:"team-b"}))},"new B"),
        React.createElement("button",{onClick:()=>commands.setDraft("a","unsent source draft")},"edit A"),
        React.createElement("button",{onClick:()=>run(commands.forkSession({sessionId:"a",taskId:"task-a"}))},"fork A"),
        React.createElement("textarea",{readOnly:true,disabled:!state.session,value:state.draft}),
        React.createElement("output",null,JSON.stringify({id:state.session?.id,project:state.currentProject,errors:state.errors})));
    }
    const click=label=>act(async()=>[...container.querySelectorAll("button")].find(b=>b.textContent===label).click());
    const state=()=>JSON.parse(container.querySelector("output").textContent);
    try {
      await act(async()=>root.render(React.createElement(Harness)));
      assert.equal(state().id,"a");
      const slowA=deferred(), slowB=deferred();delays.set("session:a",slowA);delays.set("project:/b",slowB);
      await click("open a"); await click("project B");
      assert.equal(container.querySelector("textarea").disabled,true,"choosing B cannot leave A sendable");
      assert.equal(container.querySelector("textarea").value,"");
      await act(async()=>slowA.resolve());
      assert.equal(state().project,"/b"); assert.equal(state().id,undefined);
      await act(async()=>slowB.resolve());
      assert.equal(state().id,"b"); assert.equal(container.querySelector("textarea").value,"draft B");
      const staleB=deferred();delays.set("project:/b",staleB);
      await click("project B"); await click("open c");
      await act(async()=>staleB.reject(Error("obsolete project failure")));
      assert.equal(state().id,"c"); assert.deepEqual(state().errors,[]);
      await click("new A");
      assert.equal(state().id,"c");
      assert.equal(container.querySelector("textarea").value,"draft C");
      await act(async()=>creates[0].wait.reject(Error("creation rejected")));
      assert.equal(state().id,"c");
      assert.equal(container.querySelector("textarea").value,"draft C");
      assert.match(state().errors[0],/creation rejected/);
      await click("new A"); await click("new A");
      assert.equal(creates.length,2,"repeat activation in one Team must not allocate another session");
      await click("new B");
      assert.deepEqual(creates.map(item=>item.workspaceId),["team-a","team-a","team-b"]);
      assert.equal(state().id,"c");
      assert.equal(container.querySelector("textarea").value,"draft C");
      records.nb={id:"nb",workspaceId:"team-b",project:"/b",draft:"new B draft",turns:[]};records.na={id:"na",workspaceId:"team-a",project:"/a",draft:"new A draft",turns:[]};
      await act(async()=>creates[2].wait.resolve(records.nb));
      await act(async()=>creates[1].wait.resolve(records.na));
      assert.equal(state().id,"nb"); assert.equal(state().project,"/b");
      assert.equal(container.querySelector("textarea").value,"new B draft");
      await click("open a"); assert.equal(container.querySelector("textarea").value,"draft A","navigation kept the earlier draft book");
      await click("edit A");await click("fork A");await click("open c");
      records.fa={id:"fa",workspaceId:"team-fa",project:"/a",draft:"",turns:[]};
      await act(async()=>forks[0].wait.resolve(records.fa));
      assert.equal(state().id,"c","a late fork never steals newer navigation");
      await click("open a");assert.equal(container.querySelector("textarea").value,"unsent source draft");
      await click("fork A");records.fb={id:"fb",workspaceId:"team-fb",project:"/a",draft:"",turns:[]};
      await act(async()=>forks[1].wait.resolve(records.fb));
      assert.equal(state().id,"fb");assert.equal(container.querySelector("textarea").value,"");
      await click("open a");assert.equal(container.querySelector("textarea").value,"unsent source draft","fork preserves the source editor");

    } finally {
      await act(()=>root.unmount());
      if(previous)Object.defineProperty(globalThis,"sessionStorage",previous);else delete globalThis.sessionStorage;
    }
  });
});

test("Team panel preserves exchanged model settings, dirty edits and saved facts when switching fails",async()=>{
  await modalEnvironment(async({root,container,win,TeamPanel,Modal})=>{
    const main={provider:"p",modelId:"main",thinkingLevel:"low",maxOutputTokens:123};
    const reviewer={provider:"p",modelId:"reviewer",thinkingLevel:"high",maxOutputTokens:456};
    const team={id:"old",name:"Original",main,secondary:[reviewer]};
    const models=[main,reviewer].map(r=>({...r,name:r.modelId,reasoning:true,thinkingLevels:["low","high"],api:"openai-completions"}));
    const saves=[], switches=[], changes=[];let closes=0;
    const panel=React.createRef();
    const trigger=win.document.createElement("button");trigger.textContent="team";win.document.body.append(trigger);trigger.focus();
    const commands={saveTeam:async v=>{saves.push(v);return {...v,id:"saved",name:"Saved"};},selectTeam:async v=>{switches.push(v);throw Error("fixture switch failed");},
      changeSession:async(...args)=>changes.push(args),refresh:async()=>{},refreshTeams:async()=>({providers:[]})};
    const render=busy=>act(()=>root.render(React.createElement(Modal,{title:"Team",onClose:()=>panel.current.requestClose()},
      React.createElement(TeamPanel,{ref:panel,busy,session:{id:"session",team,thinking:"high"},teams:[{...team,main:{...main,maxOutputTokens:789}}],models,providers:[{id:"p",configured:true,authKind:"api_key"}],commands,onClose:()=>closes++}))));
    await render(true);
    assert.match(container.textContent,/阵容暂只读/);
    assert.equal(container.querySelector('[aria-label="此对话的思考设置"]'),null);
    assert.deepEqual(changes,[],"the roster only describes conversation settings");
    await render(false);
    const click=text=>act(async()=>{const button=[...container.querySelectorAll("button")].find(b=>b.textContent===text);button.focus();button.click();});
    assert.match(container.textContent,/所有模型统一采用思考档位：high/);
    const savedRow=container.querySelector('[aria-label="使用 Original"]');
    assert.equal(savedRow.disabled,true,"the current row cannot silently replace a different historical snapshot");
    assert.match(savedRow.textContent,/与当前快照不同/);
    await act(()=>savedRow.click());
    assert.deepEqual(switches,[]);
    await act(()=>container.querySelector('[aria-label="管理 Original"]').click());
    await click("使用已保存参数");
    assert.deepEqual(switches,[{sessionId:"session",teamId:"old"}],"an older effective snapshot can explicitly return to its saved Team without creating another Team");
    await click("按当前快照另存");
    assert.match(container.textContent,/协作候选/);
    assert.doesNotMatch(container.textContent,/普通问答的评审模型/);
    await act(()=>{const select=container.querySelector('[aria-label="主模型"]');select.value=JSON.stringify(["p","reviewer"]);select.dispatchEvent(new win.Event("change",{bubbles:true}));});
    assert.equal(container.querySelector('[aria-label="主模型输出额度"]').value,"456");
    assert.equal(container.querySelector('[aria-label="副模型 1输出额度"]').value,"123");
    assert.equal(container.querySelector('[aria-label="副模型 1"]').value,JSON.stringify(["p","main"]));
    await act(()=>container.querySelector('[role="dialog"]').dispatchEvent(new win.KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true})));
    assert.equal(closes,0);assert.match(container.textContent,/放弃未保存的编辑/);
    await click("继续编辑");
    assert.notEqual(win.document.activeElement,win.document.body,"continue editing must restore a usable focus target");
    await act(()=>win.document.activeElement.dispatchEvent(new win.KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true})));
    assert.match(container.textContent,/放弃未保存的编辑/,"the next Escape from actual focus must reopen the guard");
    await click("继续编辑");
    assert.equal(container.querySelector('[aria-label="主模型输出额度"]').value,"456");
    await act(()=>{const input=container.querySelector('[aria-label="新阵容名称"]');Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype,"value").set.call(input,"Saved");input.dispatchEvent(new win.Event("input",{bubbles:true}));});
    await click("保存并使用");
    assert.equal(saves.length,1);assert.equal(switches.length,2);assert.equal(saves[0].name,"Saved");
    assert.deepEqual(saves[0].main,reviewer);assert.deepEqual(saves[0].secondary,[main]);
    assert.match(container.textContent,/已保存「Saved」。当前对话未切换/);
    assert.notEqual(win.document.activeElement,win.document.body,"unmounting the save button retains keyboard access");
    assert.ok([...container.querySelectorAll("button")].some(b=>b.textContent==="使用已保存的「Saved」"));
    await act(()=>container.querySelector('[aria-label="关闭Team"]').click());
    assert.equal(closes,1,"confirmed saved fields do not masquerade as unsaved after switching fails");
    await act(()=>root.render(null));
    assert.equal(win.document.activeElement,trigger,"local transition focus must not steal the modal's original opener");
    trigger.remove();
  });
});

test("unknown Team saves are read-only reconciled and never recreated or automatically selected by name",async()=>{
  await modalEnvironment(async({root,container,win,TeamPanel})=>{
    const team={id:"old",name:"Original",main:{provider:"p",modelId:"a",thinkingLevel:"medium"},secondary:[{provider:"p",modelId:"b",thinkingLevel:"xhigh"}]};
    let saves=0, reads=0, switches=0;
    const props={session:{id:"s",team},teams:[team],models:["a","b"].map(modelId=>({provider:"p",modelId,name:modelId,thinkingLevels:["low","high","max"]})),providers:[{id:"p",configured:true}],
      commands:{saveTeam:async()=>{saves++;throw Object.assign(Error("lost reply"),{unknown:true});},refreshTeams:async()=>{reads++;return {providers:[]};},refresh:async()=>{},selectTeam:async()=>switches++},onClose(){}};
    const click=text=>act(async()=>[...container.querySelectorAll("button")].find(b=>b.textContent===text).click());
    await act(()=>root.render(React.createElement(TeamPanel,props)));
    await act(()=>container.querySelector('[aria-label="管理 Original"]').click());
    await click("调整另存");
    await act(()=>{const input=container.querySelector('[aria-label="新阵容名称"]');Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype,"value").set.call(input,"Maybe saved");input.dispatchEvent(new win.Event("input",{bubbles:true}));});
    await act(async()=>container.querySelector("form").dispatchEvent(new win.Event("submit",{bubbles:true,cancelable:true})));
    assert.equal(saves,1);assert.equal(reads,1);
    const observed={...team,id:"observed",name:"Maybe saved",main:{...team.main,thinkingLevel:"high",maxOutputTokens:999},secondary:team.secondary.map(ref=>({...ref,thinkingLevel:"max"}))};
    const damaged={...observed,id:"damaged",main:{...observed.main,thinkingLevel:"future"}};
    await act(()=>root.render(React.createElement(TeamPanel,{...props,teams:[team,observed,damaged]})));
    await click("读取阵容列表核对");
    assert.equal(saves,1);assert.equal(switches,0);assert.equal(reads,2);
    assert.match(container.textContent,/999 tokens/);
    assert.match(container.textContent,/思考 high/);assert.match(container.textContent,/思考 max/);assert.match(container.textContent,/无效（future）/);
    assert.equal(container.querySelector('[aria-label="新阵容名称"]').value,"Maybe saved");
    assert.equal([...container.querySelectorAll("button")].find(b=>b.textContent==="仅保存新阵容").disabled,true);
    await click("取消编辑");assert.match(container.textContent,/保存结果仍未知/);
  });
});

test("Team authentication stays in the editing flow and cancel retains confirmed provider saves",async()=>{
  await modalEnvironment(async({root,container,win,TeamPanel})=>{
    const team={id:"old",name:"Original",main:{provider:"p",modelId:"a"},secondary:[{provider:"p",modelId:"b"}]};
    const auth=[],saves=[];
    const props={session:{id:"s",team},teams:[team],models:["a","b"].map(modelId=>({provider:"p",modelId,name:modelId,thinkingLevels:["low","high","max"]})),providers:[{id:"p",name:"Provider P",apiKey:true,configured:false}],
      commands:{saveProvider:async value=>auth.push(value),saveTeam:async value=>saves.push(value),refresh:async()=>{}},onClose(){}};
    const click=text=>act(async()=>[...container.querySelectorAll("button")].find(b=>b.textContent===text).click());
    await act(()=>root.render(React.createElement(TeamPanel,props)));
    await act(()=>container.querySelector('[aria-label="管理 Original"]').click());
    await click("调整另存");
    const key=container.querySelector('[aria-label="p API key"]');
    assert.equal(key.type,"password");
    assert.equal([...container.querySelectorAll("button")].find(b=>b.textContent==="保存 p 认证").disabled,true);
    await act(()=>{
      Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype,"value").set.call(key,"fixture-secret-key");
      key.dispatchEvent(new win.Event("input",{bubbles:true}));
      const name=container.querySelector('[aria-label="新阵容名称"]');
      Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype,"value").set.call(name,"Unsent edit");
      name.dispatchEvent(new win.Event("input",{bubbles:true}));
    });
    await click("保存 p 认证");
    assert.deepEqual(auth,[{providerId:"p",apiKey:"fixture-secret-key"}]);
    assert.equal(container.querySelector('[aria-label="p API key"]').value,"");
    assert.match(container.textContent,/远端权限尚未验证/);
    await act(()=>root.render(React.createElement(TeamPanel,{...props,providers:[{id:"p",name:"Provider P",configured:true,apiKey:true,authKind:"api_key"}]})));
    assert.match(container.textContent,/将复用已配置 API key/);
    assert.equal(container.querySelector('[aria-label="新阵容名称"]').value,"Unsent edit");
    await click("取消编辑");
    assert.match(container.textContent,/已确认保存的认证及对话思考设置会保留/);
    await click("放弃未保存修改");
    assert.equal(saves.length,0);assert.equal(auth.length,1);
    assert.equal(container.querySelector('[aria-label="新阵容名称"]'),null);
  });
});

test('file reader ignores a late file response, aborts departed reads and revokes static preview blobs on close',async()=>{
  await modalEnvironment(async({container,root,FilePanel})=>{
    const refs=['a.txt','b.html'].map(path=>({taskId:'task',version:'fixed',path}));
    const items=refs.map((ref,i)=>({ref,name:ref.path,status:'added',readable:true,previewKind:i?'static':'text'}));
    const pending=[],revoked=[];const originalCreate=URL.createObjectURL,originalRevoke=URL.revokeObjectURL;
    URL.createObjectURL=()=> 'blob:verified-preview';URL.revokeObjectURL=url=>revoked.push(url);
    const commands={loadFiles:async()=>({items,warnings:[],fromVersion:'start',toVersion:'fixed'}),readFile:(ref,options)=>new Promise(resolve=>pending.push({ref,options,resolve})),downloadPatch:async()=>'',revealTask:async()=>{}};
    const task={id:'task',status:'completed',work:{version:'fixed'}};
    const render=ref=>React.createElement(FilePanel,{task,selection:{fileRef:ref,tab:'preview'},commands,onSelection:()=>{},onClose:()=>{},onRecords:()=>{},api:{}});
    try {
      await act(async()=>root.render(render(refs[0])));
      assert.equal(pending.length,1);
      await act(async()=>root.render(render(refs[1])));
      assert.equal(pending[0].options.signal.aborted,true);
      await act(async()=>pending[1].resolve({bytes:new TextEncoder().encode('<p>safe static</p>'),version:'fixed',representation:'static-preview',mediaType:'text/html'}));
      const frame=container.querySelector('iframe');assert.ok(frame);assert.equal(frame.getAttribute('sandbox'),'');assert.equal(frame.getAttribute('referrerpolicy'),'no-referrer');
      await act(async()=>pending[0].resolve({bytes:new TextEncoder().encode('OLD FILE MUST NOT APPEAR'),version:'fixed',representation:'original',mediaType:'text/plain'}));
      assert.doesNotMatch(container.textContent,/OLD FILE MUST NOT APPEAR/);assert.ok(container.querySelector('iframe'));
      await act(async()=>root.render(null));assert.deepEqual(revoked,['blob:verified-preview']);
    }finally{URL.createObjectURL=originalCreate;URL.revokeObjectURL=originalRevoke;}
  });
});

test("project inspection keeps the newer path when an older read completes",async()=>{
  await modalEnvironment(async({root,container,win,ProjectDialog})=>{
    const waits=[],opened=[];
    const commands={inspectProject:path=>new Promise(resolve=>waits.push({path,resolve})),
      bindWorkspace:async (workspace,path)=>{opened.push(path);return {...workspace,project:path};}};
    await act(()=>root.render(React.createElement(ProjectDialog,{commands,workspace:{id:"team",name:"Existing",revision:1},onSaved(){},onClose(){}})));
    const manual=container.querySelector("form > details");
    assert.equal(manual.open,false);
    await act(()=>manual.querySelector("summary").click());
    const enter = async path => {
      await act(()=>{const input=container.querySelector('input');Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype,'value').set.call(input,path);input.dispatchEvent(new win.Event('input',{bubbles:true}));});
      await act(()=>[...container.querySelectorAll("button")].find(b=>b.textContent==="只读检查目录").click());
    };
    await enter("/old");
    await enter("/new");
    const value=canonicalPath=>({canonicalPath,directoryAvailable:true});
    await act(()=>waits[0].resolve(value('/old')));
    assert.equal(container.querySelector('.project-inspection'),null,'stale result must not offer the wrong project');
    await act(()=>waits[1].resolve(value('/new')));
    assert.match(container.textContent,/已选目录：\/new/);
    await act(async()=>{container.querySelector('form').dispatchEvent(new win.Event('submit',{bubbles:true,cancelable:true}));});
    assert.deepEqual(opened,['/new']);
  });
});

test("native directory picker suggests an empty Team name and retains the selected directory on cancellation",async()=>{
  await modalEnvironment(async({root,container,win,ProjectDialog})=>{
    const inputs=[],selections=["/tmp/学习目录",null,"/tmp/另一个目录"];
    win.cothinkDesktop={chooseProjectDirectory:async path=>{inputs.push(path);return selections.shift();}};
    const commands={inspectProject:async path=>({canonicalPath:path,directoryAvailable:true})};
    await act(()=>root.render(React.createElement(ProjectDialog,{commands,onSaved(){},onClose(){}})));
    const button=()=>[...container.querySelectorAll("button")].find(node=>node.textContent==="选择或新建文件夹…");
    assert.ok(button());
    const name=container.querySelector("input");
    await act(async()=>button().click());
    assert.equal(name.value,"学习目录");
    await act(async()=>button().click());
    assert.match(container.textContent,/\/tmp\/学习目录/);
    const setName=value=>act(()=>{
      Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype,"value").set.call(name,value);
      name.dispatchEvent(new win.Event("input",{bubbles:true}));
    });
    const create=container.querySelector('button[type="submit"]');
    await setName("🌱".repeat(80));
    assert.equal(create.disabled,false);
    await setName("🌱".repeat(81));
    assert.equal(create.disabled,true);
    await setName("我填的名称");
    await act(async()=>button().click());
    assert.equal(name.value,"我填的名称");
    assert.deepEqual(inputs,[undefined,"/tmp/学习目录","/tmp/学习目录"]);
  });
});


test("Team creation requires a folder even without a default roster",async()=>{
  await modalEnvironment(async({root,container,win,ProjectDialog})=>{
    const requests=[],saved=[];
    win.cothinkDesktop={chooseProjectDirectory:async()=>"/team"};
    const commands={inspectProject:async canonicalPath=>({canonicalPath,directoryAvailable:true}),
      createWorkspace:async args=>{requests.push(args);return {id:"new",...args};}};
    await act(()=>root.render(React.createElement(ProjectDialog,{commands,onSaved:value=>saved.push(value),onClose(){}})));
    assert.match(container.textContent,/不设默认，每条对话单独选择/);
    await act(()=>{const input=container.querySelector("input");Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype,"value").set.call(input,"课程笔记");input.dispatchEvent(new win.Event("input",{bubbles:true}));});
    const submit=()=>act(async()=>container.querySelector("form").dispatchEvent(new win.Event("submit",{bubbles:true,cancelable:true})));
    await submit();
    assert.equal(requests.length,0);
    await act(async()=>[...container.querySelectorAll("button")].find(b=>b.textContent==="选择或新建文件夹…").click());
    await submit();
    assert.deepEqual(requests,[{name:"课程笔记",project:"/team",defaultRosterId:null}]);
    assert.equal(saved[0].id,"new");
  });
});


test("reply branch action targets its own completed reply and compact composer omits permanent hints",async()=>{
 await modalEnvironment(async({root,container,win,Conversation})=>{
  const forks=[],team={id:"t",name:"T",main:{provider:"p",modelId:"m"},secondary:[{provider:"p",modelId:"r"}]};
  const state={bootstrap:{protocol,teams:[team],models:[],sessions:[],active:null},session:{id:"a",title:"Title",project:"/repo",projectStatus:{executionReady:false},team,turns:[{taskId:"first",input:"question",finalText:"answer",status:"completed",canFork:true}]},task:null,draft:"draft",ready:true,errors:[]};
  const props={state,commands:{setDraft(){},setError(){},openSession(){},refresh(){},abandonSubmission(){}},onFork:id=>{forks.push(id);},onSettings(){},onToggleNavigation(){},onCopy(){}};
  await act(()=>root.render(React.createElement(Conversation,props)));
  assert.equal(container.querySelector('[aria-label="重命名对话"]'),null);
  assert.doesNotMatch(container.textContent,/Enter 发送 · Shift\+Enter|问答 3 次 \/ 工作不限|文件工作需要准备/);
  const fork=()=>container.querySelector('[aria-label="从这里分支"]');
  await act(()=>fork().click());
  assert.deepEqual(forks,['first']);
  await act(()=>root.render(React.createElement(Conversation,{...props,state:{...state,session:{...state.session,turns:[{...state.session.turns[0],canFork:false,status:'running'}]}}})));
  assert.equal(fork().disabled,true);
 });
});

test("file proposal shows the frozen collaboration requirements beside confirmation",async()=>{
 await modalEnvironment(async({root,container,Conversation})=>{
  const turn={taskId:"proposal",input:"Compare the two outputs",finalText:"Work proposal",status:"blocked",
    proposalRef:{sourceTaskId:"proposal"},proposal:{collaboration:[
      {workers:2,parallel:true,distinctModels:true,stepIds:["compare-a","compare-b"],source:{kind:"plan"}},
    ]}};
  const state={bootstrap:{protocol,teams:[],models:[],sessions:[],active:null},
    session:{id:"a",title:"Title",turns:[turn]},draft:"",ready:true,errors:[]};
  await act(()=>root.render(React.createElement(Conversation,{state,commands:{}})));
  const requirements=container.querySelector('[aria-label="协作要求"]');
  assert.ok(requirements);
  assert.match(requirements.textContent,/至少 2 名员工.*并行.*不同模型.*compare-a.*compare-b/);
  assert.ok([...container.querySelectorAll("button")].some(button=>button.textContent==="确认上述计划并执行"&&!button.disabled));
 });
});

test("reply headers use their own persisted elapsed time without opening task details",async()=>{
 await modalEnvironment(async({root,container,Conversation})=>{
  const base={createdAt:"2026-11-08T00:00:00Z",endedAt:"2026-11-08T00:00:18Z",input:"question",finalText:"answer"};
  const turns=[{...base,taskId:"done",status:"completed"},{...base,taskId:"failed",status:"failed"},{...base,taskId:"cancel",status:"cancelled",cancelSettledAt:"2026-11-08T00:00:25Z"},{...base,taskId:"unknown",status:"stop_unknown"},{...base,taskId:"old",status:"completed",endedAt:null}];
  const state={bootstrap:{protocol,teams:[],models:[],sessions:[],active:null},session:{id:"a",title:"Title",turns},task:null,tasksById:{},draft:"",ready:true,errors:[]};
  const props={state,commands:{setDraft(){},setError(){},openSession(){},refresh(){},abandonSubmission(){}}};
  await act(()=>root.render(React.createElement(Conversation,props)));
  const headers=[...container.querySelectorAll("article > header")].map(node=>node.textContent);
  assert.deepEqual(headers,["用时 18秒","用时 18秒失败","用时 25秒已停止","用时未确认停止未确认","用时未知"]);
  assert.ok(headers.every(text=>!text.includes("CoThink")&&!text.includes("多模型")&&!text.includes("◌")));
  await act(()=>root.render(React.createElement(Conversation,{...props,state:{...state,session:{...state.session,turns:[{...base,taskId:"running",status:"cancelling",createdAt:new Date(Date.now()-12000).toISOString()}]}}})));
  assert.match(container.querySelector("article > header").textContent,/已用时 1[2-3]秒正在停止/);
 });
});

test("workspace editor queue keeps complete snapshots across navigation, lost acknowledgement and explicit conflict recovery",async()=>{
  await modalEnvironment(async({root,win,useGuiWorkspace})=>{
    const previous=Object.getOwnPropertyDescriptor(globalThis,"sessionStorage");
    Object.defineProperty(globalThis,"sessionStorage",{configurable:true,value:win.sessionStorage});
    const make=id=>({id,project:null,turns:[],draft:"",editor:{text:"",workRequest:null,selectionId:null,editId:null},draftRevision:null,branchAnchor:"root-"+id});
    const records={a:make("a"),b:make("b")}, saves=[];
    let workspace, releaseFirst, first=true, lose=false;
    const api={subscribe:()=>()=>{},read:async(kind,args={})=>{
      if(kind==="bootstrap")return {protocol,teams:[],models:[],providers:[],sessions:Object.values(records),work:{},active:null};
      if(kind==="sessions")return {items:Object.values(records),nextCursor:null};
      if(kind==="session")return structuredClone(records[args.id]);
    },action:async(name,args)=>{
      if(name!=="session.draft")return {};
      saves.push(structuredClone(args));
      const current=records[args.sessionId];
      if(args.expectedDraftRevision!==current.draftRevision)throw Object.assign(Error("external edit"),{code:"DRAFT_CONFLICT"});
      const saved={...current,draft:args.text,editor:{text:args.text,workRequest:args.workRequest,selectionId:args.selectionId,editId:args.editId},draftRevision:"draft-"+saves.length,branchAnchor:"leaf-"+saves.length};
      records[args.sessionId]=saved;
      if(first){first=false;await new Promise(resolve=>{releaseFirst=resolve;});}
      if(lose){lose=false;throw Object.assign(Error("lost save response"),{unknown:true});}
      return structuredClone(saved);
    }};
    const settle=()=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,700));});
    function Harness(){workspace=useGuiWorkspace(api);return null;}
    try {
      await act(async()=>root.render(React.createElement(Harness)));
      await act(()=>workspace.commands.setWorkRequest("a",{kind:"html-svg"}));
      await act(()=>workspace.commands.setDraft("a","first A"));
      await act(async()=>workspace.commands.openSession("b"));
      assert.equal(saves.length,1); assert.deepEqual(saves[0].workRequest,{kind:"html-svg"});
      await act(()=>workspace.commands.setDraft("a","newer A"));
      await act(()=>workspace.commands.setDraft("b","keep B"));
      await act(async()=>{releaseFirst();}); await settle();
      assert.equal(records.a.editor.text,"newer A"); assert.equal(records.b.editor.text,"keep B");
      assert.equal(saves[1].expectedDraftRevision,"draft-1"); assert.equal(workspace.state.draft,"keep B");
      await act(async()=>workspace.commands.openSession("a"));
      assert.deepEqual(workspace.state.workRequest,{kind:"html-svg"});
      lose=true; const before=saves.length;
      await act(()=>workspace.commands.insertCommand("a","/skill:example")); await settle();
      assert.equal(saves.length,before+1,"lost acknowledgement is read back without another write");
      assert.equal(workspace.state.draft,"newer A\n/skill:example");
      assert.equal(workspace.state.draftConflict,false);
      records.a={...records.a,draft:"external",editor:{...records.a.editor,text:"external",editId:"external"},draftRevision:"external",branchAnchor:"external-leaf"};
      await act(()=>workspace.commands.setDraft("a","local conflicting")); await settle();
      assert.equal(workspace.state.draftConflict,true); assert.equal(workspace.state.draft,"local conflicting");
      const conflictWrites=saves.length;
      await act(()=>workspace.commands.setDraft("a","later local")); await settle();
      assert.equal(saves.length,conflictWrites,"conflict never auto-selects local content");
      await act(async()=>workspace.commands.resolveDraft("a","local"));
      assert.equal(records.a.editor.text,"later local"); assert.equal(saves.at(-1).expectedDraftRevision,"external");
      records.a={...records.a,draft:"saved choice",editor:{...records.a.editor,text:"saved choice"},draftRevision:"remote-again"};
      await act(async()=>workspace.commands.resolveDraft("a","saved"));
      assert.equal(workspace.state.draft,"saved choice"); assert.equal(workspace.state.draftConflict,false);
      const cleanWrites=saves.length;
      records.a.navigation={archived:true};
      await act(async()=>workspace.commands.openSession("b"));
      assert.equal(saves.length,cleanWrites,"reading a saved archived draft never schedules a write");
    } finally {
      await act(()=>root.unmount());
      if(previous)Object.defineProperty(globalThis,"sessionStorage",previous);else delete globalThis.sessionStorage;
    }
  });
});

test("a delayed post-submit task read cannot overwrite the next saved editor on navigation or restart",async()=>{
  await modalEnvironment(async({root,win,useGuiWorkspace})=>{
    const previous=Object.getOwnPropertyDescriptor(globalThis,"sessionStorage");
    Object.defineProperty(globalThis,"sessionStorage",{configurable:true,value:win.sessionStorage});
    const team={id:"fixture",name:"Fixture",main:{provider:"p",modelId:"main"},secondary:[]};
    const make=id=>({id,team,project:"/"+id,turns:[],draft:"",editor:{text:"",workRequest:null,selectionId:null,editId:null},draftRevision:null,branchAnchor:"root-"+id});
    const records={a:make("a"),b:make("b")}, saves=[],submits=[];
    let workspace,releaseTask,taskReadStarted;
    const entered=new Promise(resolve=>{taskReadStarted=resolve;});
    const api={subscribe:()=>()=>{},read:async(kind,args={})=>{
      if(kind==="bootstrap")return {protocol,teams:[],models:[],providers:[],sessions:Object.values(records),work:{},active:null};
      if(kind==="sessions")return {items:Object.values(records),nextCursor:null};
      if(kind==="session")return structuredClone(records[args.id]);
      if(kind==="task"){
        if(!releaseTask){taskReadStarted();await new Promise(resolve=>{releaseTask=resolve;});}
        return {id:args.id,status:"completed"};
      }
    },action:async(name,args)=>{
      if(name==="task.submit"){submits.push(structuredClone(args));return {taskId:"submitted",sessionId:args.sessionId};}
      if(name!=="session.draft")return {};
      const current=records[args.sessionId];
      assert.equal(args.expectedDraftRevision,current.draftRevision,"host conditional write must remain effective");
      saves.push(structuredClone(args));
      records[args.sessionId]={...current,draft:args.text,
        editor:{text:args.text,workRequest:args.workRequest,selectionId:args.selectionId,editId:args.editId},
        draftRevision:"draft-"+saves.length,branchAnchor:"leaf-"+saves.length};
      return structuredClone(records[args.sessionId]);
    }};
    function Harness(){workspace=useGuiWorkspace(api);return null;}
    try {
      await act(async()=>root.render(React.createElement(Harness,{key:"initial"})));
      await act(()=>workspace.commands.setWorkRequest("a",{kind:"html-svg"}));
      await act(()=>workspace.commands.setDraft("a","first task"));
      let sending;
      await act(async()=>{sending=workspace.commands.submit({sessionId:"a"});await entered;});
      assert.equal(workspace.state.draft,"");
      await act(()=>workspace.commands.setDraft("a","next unsent task"));
      await act(async()=>{await new Promise(resolve=>setTimeout(resolve,700));});
      assert.equal(records.a.editor.text,"next unsent task");
      const newest=structuredClone(records.a.editor);
      await act(async()=>{releaseTask();await sending;});
      assert.deepEqual(saves.map(save=>save.text),["first task","next unsent task"],"old cleared snapshot must not publish after newer autosave");
      assert.deepEqual(records.a.editor,newest); assert.equal(workspace.state.draft,newest.text);
      assert.equal(submits.length,1); assert.equal(submits[0].input,"first task");
      assert.equal(submits[0].workRequest,undefined); assert.equal(submits[0].protocolVersion,1); assert.equal(newest.workRequest,null);
      await act(async()=>workspace.commands.openSession("b"));
      await act(async()=>workspace.commands.openSession("a"));
      assert.deepEqual(records.a.editor,newest); assert.equal(workspace.state.draft,newest.text);
      // Recreate the hook/book from host state; a local display alone cannot prove durability.
      await act(async()=>root.render(React.createElement(Harness,{key:"restarted"})));
      assert.equal(workspace.state.draft,newest.text); assert.equal(workspace.state.workRequest,null);
      assert.deepEqual(records.a.editor,newest);
    } finally {
      await act(()=>root.unmount());
      if(previous)Object.defineProperty(globalThis,"sessionStorage",previous);else delete globalThis.sessionStorage;
    }
  });
});

test("view updates use the acknowledged revision and keep a newer selected session",async()=>{
  await modalEnvironment(async({root,win,useGuiWorkspace})=>{
    const previous=Object.getOwnPropertyDescriptor(globalThis,"sessionStorage");
    Object.defineProperty(globalThis,"sessionStorage",{configurable:true,value:win.sessionStorage});
    const make=id=>({id,project:null,turns:[],draft:"",viewRevision:1,view:{anchor:null,seenResults:{},lastOpenedAt:null}});
    const records={a:make("a"),b:make("b")}, writes=[];
    let workspace, release, lostSeen;
    const blocked=new Promise(resolve=>{release=resolve;});
    const api={subscribe:()=>()=>{},read:async(kind,{id}={})=>{
      if(kind==="bootstrap")return {protocol,teams:[],models:[],providers:[],sessions:Object.values(records),work:{},active:null};
      if(kind==="sessions")return {items:Object.values(records),nextCursor:null};
      if(kind==="session")return structuredClone(records[id]);
      return {id};
    },action:async(name,args)=>{
      if(name!=="session.view")return {};
      writes.push(args);
      if(args.opened && args.sessionId==="a")await blocked;
      const row=records[args.sessionId];
      assert.equal(args.expectedViewRevision,row.viewRevision);
      if(args.seen && lostSeen==="unsaved")throw Object.assign(Error("unknown seen acknowledgement"),{unknown:true});
      if(args.anchor)row.view.anchor=args.anchor;
      if(args.seen)row.view.seenResults[args.seen.taskId]=args.seen.resultRevision;
      if(args.opened)row.view.lastOpenedAt="now";
      const receipt=structuredClone({sessionId:row.id,viewRevision:++row.viewRevision,view:row.view});
      if(args.seen && lostSeen==="saved")throw Object.assign(Error("saved seen with lost acknowledgement"),{unknown:true});
      return receipt;
    }};
    function Harness(){workspace=useGuiWorkspace(api);return null;}
    try{
      await act(async()=>root.render(React.createElement(Harness)));
      const anchor={taskId:"task",part:"input",offsetPx:20};
      let saving;
      await act(async()=>{saving=workspace.commands.recordView("a",{anchor});});
      await act(async()=>workspace.commands.openSession("b"));
      await act(async()=>{release();await saving;});
      assert.deepEqual(records.a.view.anchor,anchor);
      assert.equal(writes.find(w=>w.anchor).expectedViewRevision,2);
      assert.equal(workspace.state.session.id,"b");
      assert.equal(workspace.state.session.view.anchor,null);
      const seen={taskId:"result",resultRevision:"r1"};
      lostSeen="unsaved";
      await act(async()=>workspace.commands.recordView("b",{seen}));
      assert.match(workspace.state.readingError,/unknown seen acknowledgement/);
      await act(async()=>workspace.commands.recordView("b",{anchor}));
      assert.match(workspace.state.readingError,/unknown seen acknowledgement/);
      assert.deepEqual(records.b.view.seenResults,{});
      assert.equal(writes.filter(w=>w.seen?.resultRevision==="r1").length,1);
      records.b.view.seenResults.result="r1";
      records.b.viewRevision++;
      await act(async()=>workspace.commands.refresh());
      assert.equal(workspace.state.readingError,null,"authoritative read confirms the exact pending result");
      assert.equal(writes.filter(w=>w.seen?.resultRevision==="r1").length,1,"refresh does not resend");
      lostSeen="saved";
      await act(async()=>workspace.commands.recordView("b",{seen:{...seen,resultRevision:"r2"}}));
      assert.equal(records.b.view.seenResults.result,"r2");
      assert.equal(workspace.state.readingError,null,"readback confirms the save despite a lost response");
      assert.equal(writes.filter(w=>w.seen?.resultRevision==="r2").length,1);
    }finally{
      release();
      await act(()=>root.unmount());
      if(previous)Object.defineProperty(globalThis,"sessionStorage",previous);else delete globalThis.sessionStorage;
    }
  });
});

test("roster search and row actions keep conversation selection separate from the Team default", async()=>{
  await modalEnvironment(async({root,container,win,TeamPanel})=>{
    const main={provider:"p",modelId:"primary"}, reviewer={provider:"p",modelId:"reviewer"}, other={provider:"q",modelId:"q-123"}, unauth={provider:"r",modelId:"r-321"};
    const first={id:"first",name:"原组合",main,secondary:[reviewer]}, next={id:"next",name:"备选组合",main:other,secondary:[reviewer]};
    const scope={id:"group",revision:1,defaultRosterId:first.id};
    const actions=[];
    const props={session:{id:"chat",team:first},workspace:scope,teams:[first,next],models:[{...main,name:"Primary"},{...reviewer,name:"Reviewer"},{...other,name:"Northstar"},{...unauth,name:"Unconfigured"}].map(model=>({...model,thinkingLevels:["low","high","max"]})),
      providers:[{id:"p",configured:true},{id:"q",configured:true},{id:"r",configured:false}],
      commands:{selectTeam:async args=>actions.push(["current",args]),updateWorkspace:async (...args)=>actions.push(["default",...args])},onClose(){}};
    await act(()=>root.render(React.createElement(TeamPanel,props)));
    const labeled=label=>container.querySelector(`[aria-label="${label}"]`);
    const input=(label,value)=>act(()=>{
      const field=labeled(label);
      assert.ok(field,label);
      Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype,"value").set.call(field,value);
      field.dispatchEvent(new win.Event("input",{bubbles:true}));
    });
    const click=label=>act(async()=>{const button=labeled(label);assert.ok(button,label);button.click();});
    await input("搜索阵容","Northstar");
    assert.equal(labeled("使用 原组合"),null);
    await click("使用 备选组合");
    assert.deepEqual(actions,[["current",{sessionId:"chat",teamId:"next"}]]);
    await click("管理 备选组合");
    await click("将 备选组合 设为此 Team 默认");
    assert.deepEqual(actions.at(-1),["default",scope,{defaultRosterId:"next"}]);
    assert.equal(actions.length,2);
    await input("搜索阵容","原组合");
    await click("管理 原组合");
    assert.equal(labeled("删除 原组合").disabled,true);
    assert.match(labeled("删除 原组合").parentElement.textContent,/当前对话正在使用/);
    await click("调整 原组合");
    await input("搜索主模型","r-321");
    const select=labeled("主模型");
    assert.equal([...select.options].some(option=>option.textContent.includes("Reviewer")),false);
    assert.match([...select.options].find(option=>option.value==='["r","r-321"]').textContent,/Unconfigured.*缺少认证/);
    await act(()=>root.render(React.createElement(TeamPanel,{...props,key:"only",session:{id:"chat"},teams:[first]})));
    await click("管理 原组合");
    assert.equal(labeled("删除 原组合").disabled,true);
    assert.match(labeled("删除 原组合").parentElement.textContent,/至少保留一个阵容/);
  });
});

test("a Team without conversations can set a valid default and rejects an invalid roster",async()=>{
  await modalEnvironment(async({root,container,TeamPanel})=>{
    const main={provider:"p",modelId:"a"}, reviewer={provider:"p",modelId:"b"};
    const unconfigured={provider:"q",modelId:"c"}, gone={provider:"p",modelId:"retired"};
    const active={id:"valid",name:"可用",main,secondary:[reviewer]};
    const missing={id:"missing",name:"下架副模型",main,secondary:[reviewer,gone]};
    const noAuth={id:"unauth",name:"副模型未认证",main,secondary:[reviewer,unconfigured]};
    const group={id:"team",revision:1,defaultRosterId:null};
    const defaults=[];
    const props={workspace:group,teams:[active,missing,noAuth],models:[main,reviewer,unconfigured].map(model=>({...model,thinkingLevels:["low","high","max"]})),
      providers:[{id:"p",configured:true},{id:"q",configured:false}],
      commands:{updateWorkspace:async(row,change)=>defaults.push([row,change])},onClose(){}};
    const labeled=label=>container.querySelector(`[aria-label="${label}"]`);
    const click=label=>act(async()=>labeled(label).click());
    await act(()=>root.render(React.createElement(TeamPanel,props)));
    assert.equal(labeled("使用 可用").disabled,true);
    assert.match(labeled("使用 下架副模型").textContent,/retired.*目录不可用/);
    await click("管理 下架副模型");
    assert.equal(labeled("将 下架副模型 设为此 Team 默认").disabled,true);
    await click("将 下架副模型 设为此 Team 默认");
    assert.match(labeled("使用 副模型未认证").textContent,/q.*缺少认证/);
    await click("管理 副模型未认证");
    assert.equal(labeled("将 副模型未认证 设为此 Team 默认").disabled,true);
    await click("将 副模型未认证 设为此 Team 默认");
    assert.deepEqual(defaults,[]);
    await click("管理 可用");
    await click("将 可用 设为此 Team 默认");
    assert.deepEqual(defaults,[[group,{defaultRosterId:"valid"}]]);
    await act(()=>root.render(React.createElement(TeamPanel,{...props,workspace:{...group,archived:true}})));
    assert.equal(labeled("将 可用 设为此 Team 默认").disabled,true);
    await click("将 可用 设为此 Team 默认");
    assert.equal(defaults.length,1);
  });
});

test("roster default failure retries only the default and keeps the current conversation",async()=>{
  await modalEnvironment(async({root,container,TeamPanel})=>{
    const first={id:"one",name:"原阵容",main:{provider:"p",modelId:"a"},secondary:[{provider:"p",modelId:"b"}]};
    const next={...first,id:"two",name:"新阵容"};
    const group={id:"team",revision:1,defaultRosterId:first.id};
    const calls=[];
    let current=first, saved={...group};
    const commands={
      selectTeam:async value=>{calls.push(["switch",value.teamId]);current=next;},
      updateWorkspace:async (row,change)=>{
        calls.push(["default",row.revision]);
        if(row.revision!==2)throw Object.assign(Error("default conflict"),{code:"WORKSPACE_CONFLICT"});
        saved={...saved,...change,revision:3};
        return saved;
      },
      refreshTeams:async()=>({workspaces:[{...saved,revision:2}]})
    };
    await act(()=>root.render(React.createElement(TeamPanel,{session:{id:"s",team:first},workspace:group,teams:[first,next],models:[first.main,...first.secondary].map(model=>({...model,thinkingLevels:["low","high","max"]})),providers:[{id:"p",configured:true}],commands,onClose(){}})));
    const click=label=>act(async()=>{
      const button=[...container.querySelectorAll("button")].find(b=>(b.getAttribute("aria-label")||b.textContent)===label);
      assert.ok(button,label);
      button.click();
    });
    await click("管理 新阵容");
    await click("将 新阵容 设为此 Team 默认");
    assert.equal(current.id,first.id);
    assert.equal(saved.defaultRosterId,first.id);
    assert.match(container.textContent,/默认阵容未保存/);
    await click("重新保存默认阵容");
    assert.equal(saved.defaultRosterId,next.id);
    assert.equal(current.id,first.id);
    assert.deepEqual(calls,[["default",1],["default",2]]);
  });
});

test("lost stop acknowledgement remains pending on the original task until the host reports its end",async()=>{
  await modalEnvironment(async({root,win,useGuiWorkspace})=>{
    const previous=Object.getOwnPropertyDescriptor(globalThis,"sessionStorage");
    Object.defineProperty(globalThis,"sessionStorage",{configurable:true,value:win.sessionStorage});
    let active={taskId:"running",sessionId:"a"}, workspace;
    const stops=[];
    const api={subscribe:()=>()=>{},read:async kind=>{
      if(kind==="bootstrap")return {protocol,teams:[],models:[],providers:[],sessions:[],work:{},active};
      if(kind==="sessions")return {items:[]};
      return {id:"running",status:"running"};
    },action:async(name,args)=>{
      if(name!=="task.cancel")return {};
      stops.push(args.taskId);
      throw Object.assign(Error("lost stop reply"),{unknown:true});
    }};
    function Harness(){workspace=useGuiWorkspace(api);return null;}
    try {
      await act(async()=>root.render(React.createElement(Harness)));
      await act(async()=>workspace.commands.cancelTask().catch(()=>{}));
      assert.equal(workspace.state.stopping?.status,"stop_unknown");
      assert.equal(workspace.state.bootstrap.active.taskId,"running");
      await act(async()=>workspace.commands.cancelTask().catch(()=>{}));
      assert.deepEqual(stops,["running"]);
      active=null;
      await act(async()=>workspace.commands.refresh());
      assert.equal(workspace.state.stopping,null);
    } finally {
      await act(()=>root.unmount());
      if(previous)Object.defineProperty(globalThis,"sessionStorage",previous);else delete globalThis.sessionStorage;
    }
  });
});

test("a confirmed workspace default stays visible during and after a stale bootstrap refresh",async()=>{
  await modalEnvironment(async({root,win,useGuiWorkspace})=>{
    const previous=Object.getOwnPropertyDescriptor(globalThis,"sessionStorage");
    Object.defineProperty(globalThis,"sessionStorage",{configurable:true,value:win.sessionStorage});
    const original={id:"team",revision:1,name:"Team",defaultRosterId:"old"};
    let saved=original, block=false, workspace, release;
    const wait=new Promise(resolve=>{release=resolve;});
    const api={subscribe:()=>()=>{},read:async kind=>{
      if(kind==="bootstrap"){
        const before=saved;
        if(block){block=false;await wait;}
        return {protocol,teams:[],models:[],providers:[],sessions:[],workspaces:[before],work:{},active:null};
      }
      return {items:[]};
    },action:async(name,args)=>{
      if(name!=="workspace.update")return {};
      saved={...saved,...args.change,revision:2};
      return saved;
    }};
    function Harness(){workspace=useGuiWorkspace(api);return null;}
    try {
      await act(async()=>root.render(React.createElement(Harness)));
      block=true;
      let refresh;
      await act(async()=>{refresh=workspace.commands.refresh();});
      await act(async()=>workspace.commands.updateWorkspace(original,{defaultRosterId:"new"}));
      assert.equal(saved.defaultRosterId,"new");
      assert.equal(workspace.state.bootstrap.workspaces[0].defaultRosterId,"new");
      await act(async()=>{release();await refresh;});
      assert.equal(workspace.state.bootstrap.workspaces[0].defaultRosterId,"new");
    } finally {
      release();
      await act(()=>root.unmount());
      if(previous)Object.defineProperty(globalThis,"sessionStorage",previous);else delete globalThis.sessionStorage;
    }
  });
});

test('versioned per-session turn options survive reopen and unknown submit without granting another project access',async t=>{
 const {fixture}=await import('./helpers/pi-fixture.js');const {git}=await import('./helpers/git-fixture.js');
 const {writeFileSync}=await import('node:fs');const {join}=await import('node:path');
 const {createGuiController}=await import('../src/gui-controller.js');const {saveConfig}=await import('../src/config.js');const {createTeamConfig}=await import('../src/teams.js');const {readTask}=await import('../src/task.js');const {randomUUID}=await import('node:crypto');
 const f=await fixture(t),rosterId=randomUUID();saveConfig(f.home,createTeamConfig({formatVersion:2,...f.models},'Options fixture',rosterId));
 let controller=await createGuiController({home:f.home,cwd:f.cwd});t.after(()=>controller.close());
 const a=await fixtureConversation(t,controller,{defaultRosterId:rosterId});
 const b=await fixtureConversation(t,controller,{defaultRosterId:rosterId});
 for (const room of [a,b]) {
   git(room.project,'init','-b','main');
   writeFileSync(join(room.project,'a.txt'),'base A\n');
   git(room.project,'status','--porcelain');
   git(room.project,'add','--','a.txt');
   git(room.project,'commit','-m','fixture base');
 }
 await modalEnvironment(async({root,win,useGuiWorkspace})=>{
  const oldStorage=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage');Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:win.sessionStorage});
  let workspace,loseSubmit=false,submitted;
  const api={subscribe:()=>()=>{},async read(kind,args={}){return kind==='session'?controller.session(args.id):kind==='task'?controller.task(args.id):kind==='sessions'?controller.sessions(args):controller.bootstrap();},
   async action(name,args){const value=await controller.action(name,args);if(name==='task.submit'){submitted=value;if(loseSubmit){loseSubmit=false;throw Object.assign(Error('lost acknowledgement'),{unknown:true});}}return value;},
   async recover(pending){return (await controller.session(pending.sessionId)).submissions.find(s=>s.submissionId===pending.submissionId)??null;}};
  function Harness(){workspace=useGuiWorkspace(api);return null;}
  try{
   await act(async()=>root.render(React.createElement(Harness)));
   await act(async()=>workspace.commands.openSession(a.id));
   await act(()=>{workspace.commands.setDraft(a.id,'question with saved limits');workspace.commands.setTurnOptions(a.id,{maxCalls:'3',readOnly:true,delegate:false,readAllowed:true,readPaths:'a.txt',readVersion:git(a.project,'rev-parse','HEAD')});});
   await act(async()=>workspace.commands.flushAllDrafts());const savedA=await controller.session(a.id);assert.equal(savedA.editor.turnOptions.maxCalls,'3');assert.equal(savedA.editor.turnOptions.readProject,savedA.project);
   await act(async()=>workspace.commands.openSession(b.id));assert.equal(workspace.state.turnOptions,null,'A opt-in never becomes B consent');
   await act(()=>workspace.commands.setTurnOptions(b.id,{maxCalls:'1'}));await act(async()=>workspace.commands.flushAllDrafts());
   await act(()=>root.render(null));await controller.close();controller=await createGuiController({home:f.home,cwd:f.cwd});
   await act(async()=>root.render(React.createElement(Harness)));
   for(let n=0;n<50&&!workspace.state.ready;n++)await act(async()=>new Promise(r=>setTimeout(r,10)));
   await act(async()=>workspace.commands.openSession(a.id));
   assert.equal(workspace.state.turnOptions.maxCalls,'3');assert.equal(workspace.state.turnOptions.readOnly,true);assert.equal(workspace.state.turnOptions.readAllowed,true);
   await assert.rejects(controller.action('task.submit',{sessionId:b.id,input:savedA.draft,submissionId:'foreign-editor',protocolVersion:1,editorEditId:savedA.editor.editId,budget:{maxCalls:3},constraints:{readOnly:true,allowedSubtasks:[]},readAuthorization:{paths:['a.txt']}}),/草稿|选项/);assert.equal(f.calls.length,0);
   loseSubmit=true;await act(async()=>workspace.commands.submit({sessionId:a.id}));assert.ok(workspace.state.pending,JSON.stringify(workspace.state.errors));assert.equal(workspace.state.turnOptions.maxCalls,'3');
   await act(()=>workspace.commands.setTurnOptions(a.id,{maxCalls:'9'}));assert.equal(workspace.state.turnOptions.maxCalls,'3','unknown submission retains its original options');
   await act(async()=>workspace.commands.openSession(b.id));assert.equal(workspace.state.turnOptions.maxCalls,'1');assert.equal(workspace.state.turnOptions.readAllowed,false);
   await act(async()=>workspace.commands.openSession(a.id));await act(async()=>workspace.commands.recoverSubmission());assert.equal(workspace.state.turnOptions,null,'acknowledgement consumes only the submitted choice');
   for(let n=0;n<100&&(await controller.bootstrap()).active;n++)await new Promise(r=>setTimeout(r,10));
   const task=readTask(f.home,submitted.taskId);assert.equal(task.budget.maxCalls,3);assert.equal(task.constraints.readOnly,true);assert.equal(task.readAuthorization.canonicalRepo,savedA.project);assert.equal(task.readAuthorization.source.editorEditId,savedA.editor.editId);assert.equal(f.calls.length,1);
  }finally{await act(()=>root.render(null));if(oldStorage)Object.defineProperty(globalThis,'sessionStorage',oldStorage);else delete globalThis.sessionStorage;}
 });
});

test("execution settings keep a read-only Docker diagnosis separate from an explicit probe", async () => {
  await modalEnvironment(async ({root,container,Settings}) => {
    const calls = [];
    const commands = {inspectExecution: async ({probe}) => {
      calls.push(probe);
      return {checkedAt:"2026-11-09T00:00:00Z",configDigest:"first",
        diagnostic:{status:"passed",code:"LOCAL_IMAGE_FOUND",message:"本机固定镜像已存在。"},
        probe:{status:probe?"passed":"not_run",message:probe?"固定镜像已成功启动并清理。":undefined}};
    }};
    const boot={configured:true,providers:[],executionConfigDigest:"first",work:{execution:{image:"sha256:fixture"}}};
    const render = value => root.render(React.createElement(Settings,{boot:value,initialTab:"work",commands,onClose(){}}));
    const button = title => [...container.querySelectorAll("button")].find(b=>b.textContent===title);
    await act(async()=>render(boot));
    assert.deepEqual(calls,[]);
    await act(async()=>button("只读检查 Docker")?.click());
    assert.deepEqual(calls,[false]);
    assert.match(container.textContent,/尚未运行容器探针/);
    await act(async()=>button("检查执行环境")?.click());
    assert.deepEqual(calls,[false,true]);
    assert.match(container.textContent,/固定镜像已成功启动并清理/);
    await act(async()=>render({...boot,executionConfigDigest:"changed"}));
    assert.doesNotMatch(container.textContent,/固定镜像已成功启动并清理/);
    assert.match(container.textContent,/配置已变更，请重新检查/);
  });
});

test("OAuth settings submit a single prompt and cancel a waiting operation when closing", async () => {
  await modalEnvironment(async ({win,root,container,Settings}) => {
    const calls=[];
    const prompt={id:"prompt",type:"manual_code",message:"粘贴授权回调地址"};
    const operation={operationId:"login",providerId:"fixture",status:"running",prompt,message:"等待完成登录"};
    const boot={configured:true,version:"fixture",providers:[{id:"fixture",name:"Fixture OAuth",oauth:true}],work:{}};
    const commands={
      startOAuth:async provider=>{calls.push(["start",provider]);return operation;},
      getOAuth:async()=>operation,
      respondOAuth:async(...args)=>{calls.push(["respond",...args]);return {...operation,prompt:null};},
      cancelOAuth:async id=>{calls.push(["cancel",id]);return {...operation,status:"cancelled"};},
    };
    await act(async()=>root.render(React.createElement(Settings,{boot,commands,onClose:()=>root.render(null)})));
    const provider=container.querySelector("select");
    await act(async()=>{provider.value="fixture";provider.dispatchEvent(new win.Event("change",{bubbles:true}));});
    const start=[...container.querySelectorAll("button")].find(b=>b.textContent==="使用 OAuth 登录");
    assert.ok(start);
    await act(async()=>start.click());
    const reply=container.querySelector('input[autocomplete="off"][type="password"]');
    assert.ok(reply);
    reply.value="private callback";
    await act(async()=>reply.form.dispatchEvent(new win.Event("submit",{bubbles:true,cancelable:true})));
    assert.doesNotMatch(container.textContent,/private callback/);
    await act(async()=>container.querySelector('button[aria-label="关闭设置"]').click());
    assert.deepEqual(calls,[["start","fixture"],["respond","login","prompt","private callback"],["cancel","login"]]);
  });
});

test("local skill settings submit the selected list and preserve its draft after a host conflict", async () => {
  await modalEnvironment(async ({root,container,Settings}) => {
    const attempts=[];
    const boot={configured:true,version:"fixture",providers:[],work:{},localSkillPaths:["/one/SKILL.md","/two/SKILL.md"]};
    const commands={saveLocalSkills:async ({paths})=>{
      attempts.push(paths);
      if(attempts.length===1)throw Error("技能名称冲突 example");
      return {paths,skills:[{name:"example",description:"External purpose",sourceKind:"selected",explicitOnly:true}]};
    }};
    const button = title => [...container.querySelectorAll("button")].find(b=>b.textContent===title);
    await act(async()=>root.render(React.createElement(Settings,{boot,initialTab:"skills",commands,onClose(){}})));
    assert.match(container.textContent,/\/one\/SKILL.md/);
    await act(async()=>container.querySelector('button[aria-label="移除技能来源 /two/SKILL.md"]').click());
    await act(async()=>button("保存本地技能来源").click());
    assert.match(container.textContent,/技能名称冲突 example/);
    assert.doesNotMatch(container.textContent,/\/two\/SKILL.md/);
    await act(async()=>button("保存本地技能来源").click());
    assert.deepEqual(attempts,[["/one/SKILL.md"],["/one/SKILL.md"]]);
    assert.match(container.textContent,/仅手动使用/);
    assert.match(container.textContent,/External purpose/);
  });
});

test("composer keeps add actions separate and refuses incomplete materials", async () => {
  await modalEnvironment(async ({win, root, container}) => {
    const imports=[], removes=[], sends=[];
    const props={boot:{protocol},homeReady:true,draft:"",onDraft(){},onSubmit:()=>sends.push(true),
      onImportMaterials:files=>imports.push(...files),onRemoveMaterial:item=>removes.push(item),
      onTurnOptions(){}};
    const material={key:"upload",name:"plot.png",mediaType:"image/png",byteLength:10,status:"failed",error:"图片未保存"};
    const render=items=>act(()=>root.render(React.createElement(Composer,{...props,materials:items})));
    await render([material]);
    const plus=container.querySelector('[aria-label="添加本次操作"]'),send=container.querySelector('[type="submit"]');
    await act(()=>plus.click());
    assert.equal(plus.getAttribute("aria-expanded"),"true");
    assert.match(container.textContent,/添加文件或图片/);
    assert.doesNotMatch(container.textContent,/关联目录|只分析，不修改|使用技能|插件命令/);
    await act(()=>win.document.body.dispatchEvent(new win.Event("pointerdown",{bubbles:true})));
    assert.equal(plus.getAttribute("aria-expanded"),"false");
    await act(()=>plus.click());
    const item=[...container.querySelectorAll("button")].find(button=>button.textContent==="添加文件或图片");
    item.focus();
    await act(()=>item.dispatchEvent(new win.KeyboardEvent("keydown",{key:"Escape",bubbles:true})));
    assert.equal(win.document.activeElement,plus);
    assert.equal(send.disabled,true);
    assert.match(container.textContent,/图片未保存/);
    await act(()=>container.querySelector('[aria-label="移除 plot.png"]').click());
    assert.deepEqual(removes,[material]);
    await render([{...material,status:"ready",error:undefined}]);
    assert.equal(send.disabled,false);
    await act(()=>send.click());
    assert.deepEqual(sends,[true]);
    const file=new win.File(["x"],"another.png",{type:"image/png"});
    const paste=new win.Event("paste",{bubbles:true,cancelable:true});
    Object.defineProperty(paste,"clipboardData",{value:{files:[file]}});
    await act(()=>container.querySelector("textarea").dispatchEvent(paste));
    assert.deepEqual(imports,[file]);
  });
});

test("markdown never requests a remote image until the reader chooses to load it", async () => {
  const {Markdown}=await import("../gui/src/Markdown.js");
  await modalEnvironment(async ({root,container})=>{
    await act(()=>root.render(React.createElement(Markdown,{text:"![safe](https://example.test/image.png) ![unsafe](file:///tmp/private.png)\n\n```js\nconst n = 1;\n```"})));
    assert.equal(container.querySelectorAll("img").length,0);
    assert.match(container.textContent,/example.test/);
    const button=[...container.querySelectorAll("button")].find(button=>button.textContent==="加载图片");
    await act(()=>button.click());
    assert.equal(container.querySelectorAll("img").length,1);
    assert.equal(container.querySelector("img").getAttribute("referrerpolicy"),"no-referrer");
    assert.equal(container.querySelector("img").getAttribute("src"),"https://example.test/image.png");
    assert.ok(container.querySelector('button[aria-label="复制代码"]'));
  });
});
