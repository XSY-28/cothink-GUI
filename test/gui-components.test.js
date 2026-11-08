import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { Window } from "happy-dom";
import { Composer } from "../gui/src/Composer.js";
import { build } from "vite";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const bundleDirectory = resolve("work/gui/component-build");
const previousNodeEnv = process.env.NODE_ENV;
await build({
  configFile: false,
  logLevel: "silent",
  build: {
    lib: {
      entry: resolve("test/helpers/gui-components.jsx"),
      formats: ["es"],
      fileName: "components",
    },
    outDir: bundleDirectory,
    emptyOutDir: true,
    minify: false,
    rolldownOptions: { external: ["react", "react/jsx-runtime"] },
  },
});
if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
else process.env.NODE_ENV = previousNodeEnv;
const componentUrl = pathToFileURL(
  resolve(bundleDirectory, "components.js"),
).href;

async function modalEnvironment(run) {
  const win = new Window({ url: "http://localhost/" }),
    prior = {};
  Object.defineProperty(win.document, "compatMode", { value: "CSS1Compat" });
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Event",
    "KeyboardEvent",
    "DOMParser",
  ]) {
    prior[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: win[key],
    });
  }
  // happy-dom has no layout: model only the browser's rendered-box boundary.
  // Disabled fieldset semantics, focus, events and our trap remain actual DOM behavior.
  win.HTMLElement.prototype.getClientRects = function () {
    if (this.closest("[hidden]")) return [];
    for (let node = this; node; node = node.parentElement) {
      if (win.getComputedStyle(node).display === "none") return [];
      if (
        node.tagName === "DETAILS" &&
        !node.open &&
        !node.querySelector("summary")?.contains(this)
      )
        return [];
    }
    return [{ width: 20, height: 20 }];
  };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const components = await import(componentUrl),
    { createRoot } = await import("react-dom/client");
  const container = win.document.createElement("div");
  win.document.body.append(container);
  const root = createRoot(container);
  try {
    await run({ win, container, root, ...components });
  } finally {
    await act(() => root.unmount());
    win.happyDOM.abort();
    for (const [key, descriptor] of Object.entries(prior)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
}

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
        boot: {
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
    await act(() =>
      root.render(
        React.createElement(
          Modal,
          { title: "Focus", onClose: () => {} },
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
  });
});

test("composer blocks IME confirmation, keeps drafts editable during a run and leaves roster to the header", async () => {
  const win = new Window({ url: "http://localhost/" }),
    prior = {};
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Event",
    "KeyboardEvent",
    "CompositionEvent",
  ]) {
    prior[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: win[key],
    });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import("react-dom/client");
  const container = win.document.createElement("div");
  win.document.body.append(container);
  const root = createRoot(container),
    sent = [];
  const team = {
    id: "t",
    name: "Fixture",
    main: { provider: "p", modelId: "main" },
    secondary: [],
  };
  const base = {
    session: { id: "s", mode: "cothink", team },
    boot: {
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
  try {
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
    await act(()=>root.render(React.createElement(Composer,{...base,boot:{...base.boot,models:[]}})));
    await act(()=>container.querySelector('[aria-label="添加本次操作"]').click());
    assert.match(container.textContent,/模型目录不可用，输出额度要求未知/);
    assert.doesNotMatch(container.textContent,/未设本地输出上限/);
    await act(()=>container.querySelector('[aria-label="添加本次操作"]').click());

    await act(() =>
      root.render(React.createElement(Composer, { ...base, busy: true })),
    );
    assert.equal(container.querySelector("textarea").disabled, false);
    assert.equal(container.querySelector('[type="submit"]').disabled, true);
    assert.match(container.textContent, /下一条模式/);
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
  const boot = {
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
  const openHistory = async title => {
    await showHistory();
    await act(()=>container.querySelector(`[title="${title}"]`).click());
    await settle();
  };
  try {
    await act(async () => {
      root.render(React.createElement(App));
    });
    await settle();
    assert.equal(container.querySelector("textarea").value, "saved a");
    assert.equal(container.querySelector('[role="dialog"]'),null,"unread release notes never interrupt startup");
    assert.match(container.querySelector('[aria-label="Team 导航"]').textContent,/更新记录未读/);
    assert.doesNotMatch(container.querySelector('[aria-label="Team 导航"]').textContent,/有新版本/);
    await act(()=>container.querySelector('[aria-label="暂时收起本地更新提示"]').click());
    assert.equal(actions.some(a=>a.action==="releaseNotes.ack"),false,"dismissing a notice is not acknowledgement");
    await act(()=>[...container.querySelectorAll('button')].find(b=>b.textContent.includes('查看本次更新')).click());
    assert.deepEqual([...container.querySelectorAll('.settings-nav button')].map(n=>n.textContent),['已归档','模型与认证','项目执行','偏好与更新']);
    assert.equal(actions.some(a=>a.action==="releaseNotes.ack"),false,"opening notes is not acknowledgement");
    await act(()=>[...container.querySelectorAll('button')].find(b=>b.textContent==='我已看过此版本更新').click());
    await settle();
    assert.equal(actions.filter(a=>a.action==="releaseNotes.ack").length,1);
    assert.equal(actions.find(a=>a.action==="releaseNotes.ack").args.version,'fixture');
    await act(()=>container.querySelector('[aria-label="关闭设置"]').click());
    assert.equal(container.querySelector('[title="Active chat"]'),null,"conversation rows start collapsed");
    assert.equal([...container.querySelectorAll("header.topbar button")].filter(n=>n.textContent === "阵容").length,1);
    await showHistory();
    const runningMenu=container.querySelector('[title="Active chat"]').parentElement.querySelector('details');
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
    assert.match(container.querySelector("h1").textContent,/通用对话/);
    assert.equal(container.querySelector("textarea").value, "saved b");

    // Opening and unmounting the reader keeps A's draft and sends nothing.
    await openHistory("Active chat");
    assert.equal(container.querySelector(".detail-wrapper"), null);
    await act(() => [...container.querySelectorAll("button")].find(b=>b.textContent.includes("查看过程")).click());
    await settle();
    assert.ok(container.querySelector(".detail-wrapper"));
    await act(() => [...container.querySelectorAll("button")].find(n => n.textContent === "← 返回对话").click());
    assert.equal(container.querySelector(".detail-wrapper"), null);
    assert.equal(container.querySelector("textarea").value, "new unsent a");
    assert.equal(actions.some(a => a.action === "task.submit"), false);

    // An uncertain A submission remains associated with A while B stays selected.
    await act(() => container.querySelector("form.composer").dispatchEvent(new win.Event("submit", {bubbles:true,cancelable:true})));
    await settle();
    assert.equal(actions.filter(a => a.action === "task.submit").length, 1);
    await openHistory("History chat");
    await act(() => rejectSubmission(Error("lost response")));
    await settle();
    assert.match(container.querySelector("h1").textContent,/通用对话/);
    assert.equal(container.querySelector("textarea").value, "saved b");
    assert.equal(JSON.parse(win.sessionStorage.getItem("cothink.pending")).sessionId, "a");
    assert.match(container.textContent, /提交确认丢失/);
    await act(() => container.querySelector("form.composer").dispatchEvent(new win.Event("submit", {bubbles:true,cancelable:true})));
    assert.equal(actions.filter(a => a.action === "task.submit").length, 1);
    await act(()=>[...container.querySelectorAll("button")].find(b=>b.textContent==="保留草稿并放弃关联").click());
    const archiveRow = async title => {
      await showHistory();
      const row=container.querySelector(`[title="${title}"]`).parentElement;
      await act(()=>row.querySelector("summary").click());
      await act(()=>[...row.querySelectorAll("button")].find(b=>b.textContent==="归档对话").click());
      await settle();
    };
    await archiveRow("History chat");
    assert.match(container.querySelector("h1").textContent,/通用对话/);
    assert.equal(container.querySelector("textarea").value,"new unsent a");
    await archiveRow("Active chat");
    assert.match(container.querySelector("h1").textContent,/通用对话/);
    assert.equal(actions.some(a=>a.action==="session.create"),false,"archiving the last visible row never creates an empty history");
    await act(()=>container.querySelector('[role="dialog"][aria-label="对话"] button[aria-label^="关闭"]').click());
    await act(()=>[...container.querySelectorAll("nav button")].find(b=>b.textContent.includes("设置")).click());
    await act(()=>[...container.querySelectorAll("button")].find(b=>b.textContent==="已归档").click());
    await settle();
    const archivedRow=container.querySelector('[title="History chat"]').parentElement;
    await act(()=>archivedRow.querySelector("summary").click());
    await act(()=>[...archivedRow.querySelectorAll("button")].find(b=>b.textContent==="恢复对话").click());
    await settle();
    assert.match(container.querySelector("h1").textContent,/通用对话/,"restoring in settings does not change Team");
    assert.equal(container.querySelector("textarea").disabled,true,"restoring in settings does not select a conversation");
    await act(()=>container.querySelector('[aria-label="关闭设置"]').click());
    await settle();
    await showHistory();
    loseNextPin=true;
    const restoredRow=container.querySelector('[title="History chat"]').parentElement;
    await act(()=>restoredRow.querySelector("summary").click());
    await act(()=>[...restoredRow.querySelectorAll("button")].find(b=>b.textContent==="置顶").click());
    await settle();
    assert.equal(actions.filter(a=>a.action==="session.pin").length,1,"lost navigation response is never resent");
    assert.match(container.textContent,/已置顶/);
    assert.equal(actions.filter(a=>a.action==="task.submit").length,1);
    await act(()=>container.querySelector('[role="dialog"][aria-label="对话"] button[aria-label^="关闭"]').click());
    // A delayed archive read must not dismiss a newer roster editor.
    await act(()=>[...container.querySelectorAll("nav button")].find(b=>b.textContent.includes("设置")).click());
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

test('update settings keep controls disabled during a check and show a save failure without claiming success', async () => {
  await modalEnvironment(async ({container,root,Settings})=>{
    const {createUpdateService,formatUpdateStatus,updateInstructions}=await import('../src/updates.js');
    const {mkdtempSync,rmSync}=await import('node:fs');const {join}=await import('node:path');const {tmpdir}=await import('node:os');
    const home=mkdtempSync(join(tmpdir(),'gui-update-settings-'));
    const service=createUpdateService({home,currentVersion:'1.0.0',env:{},fetchImpl:async()=>new Response(JSON.stringify({name:'cothink-v2',version:'2.0.0'}))});
    await service.check({manual:true});const s=service.snapshot();
    const boot={configured:true,teams:[],models:[],providers:[],work:{},version:'1.0.0',releaseNotes:{full:'local'},updates:{...s,message:formatUpdateStatus(s),instructions:updateInstructions(s)}};
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


test("Option+M toggles composer mode without typing or sending, including during work", async () => {
  await modalEnvironment(async ({win, container, root}) => {
    const changes = [], drafts = [], submissions = [];
    const base = {
      session: {id: "s", mode: "cothink"}, boot: {models: [], teams: []},
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
    assert.equal((await press()).defaultPrevented, true);
    assert.deepEqual(changes, [["session.mode", {mode: "one"}]]);
    await render({busy: true, session: {...base.session, mode: "one"}});
    await press();
    assert.deepEqual(changes.at(-1), ["session.mode", {mode: "cothink"}]);
    for (const event of [{repeat: true}, {isComposing: true}, {keyCode: 229},
      {ctrlKey: true}, {metaKey: true}, {shiftKey: true}, {altKey: false}]) await press(event);
    assert.equal(changes.length, 2);
    for (const props of [{session: {...base.session, readOnly: true}},
      {session: {...base.session, selectionError: "write failed"}}, {submitting: true}, {pending: true}]) {
      await render(props); await press();
    }
    assert.equal(changes.length, 2);
    assert.equal(container.querySelector("textarea").value, "keep this draft");
    assert.deepEqual(drafts, []);
    assert.deepEqual(submissions, []);
  });
});


test("archived settings search and restore stay in settings while viewing selects the matched message",async()=>{
  await modalEnvironment(async({root,container,Settings,win})=>{
    const boot={configured:true,teams:[],models:[],providers:[],work:{},version:"fixture",releaseNotes:{full:"local"}};
    let archived=true; const requests=[], changes=[], opens=[];
    const row={id:"archived",title:"Saved answer",project:null,persisted:true,navigation:{revision:3,archived:true,pinned:false},match:{snippet:"needle answer",taskId:"old-task",field:"finalText"}};
    const commands={
      querySessions:async args=>{requests.push(args);return {items:archived ? [row] : [],nextCursor:null};},
      setSessionNavigation:async args=>{changes.push(args);archived=false;},
      openSession:(...args)=>opens.push(args),
    };
    await act(async()=>root.render(React.createElement(Settings,{boot,commands,initialTab:"archives",onClose(){},api:{},onRefresh(){}})));
    assert.match(container.textContent,/needle answer/);
    const menu=container.querySelector('[title="Saved answer"]').parentElement.querySelector('details');
    await act(()=>menu.querySelector('summary').click());
    await act(()=>menu.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})));
    assert.equal(menu.open,false);
    assert.ok(container.querySelector('[role="dialog"]'),"Escape in a row menu leaves settings open");
    assert.equal(win.document.activeElement,menu.querySelector('summary'));
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
    await act(()=>root.render(React.createElement(Composer,{session:{id:"a",navigation:{archived:true},mode:"one",team:{id:"t",main:{provider:"p",modelId:"m"},secondary:[]}},boot:{models:[],teams:[]},draft:"keep unsent",onDraft(){},onSubmit(){sends++;},onChange(){},onSettings(){}})));
    assert.equal(container.querySelector('textarea').disabled,true);
    assert.equal(container.querySelector('textarea').value,"keep unsent");
    assert.match(container.textContent,/已归档/); assert.doesNotMatch(container.textContent,/被其他入口占用/);
    await act(()=>container.querySelector('form').dispatchEvent(new win.Event("submit",{bubbles:true,cancelable:true})));
    assert.equal(sends,0);
  });
});


test("the latest project, conversation or new-chat click wins delayed navigation without exposing the previous draft",async()=>{
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
        if(kind === "bootstrap")return {teams:[],models:[],providers:[],sessions:[records.a],work:{},active:null};
        if(kind === "session")return records[args.id];
        if(kind === "sessions")return {items:Object.values(records).filter(s=>!args.project || s.project===args.project),nextCursor:null};
      },
      action:async(name,args)=>{
        if(name === "session.fork"){const wait=deferred();forks.push({wait,args});return wait.promise;}
        if(name !== "session.create")return {};
        const wait=deferred();creates.push({wait,project:args.project});return wait.promise;
      },
    };
    function Harness(){
      const {state,commands}=useGuiWorkspace(api);
      const run=p=>p.catch(e=>commands.setError(e.message));
      return React.createElement("div",null,
        ...["a","b","c"].map(id=>React.createElement("button",{key:id,onClick:()=>run(commands.openSession(id))},"open "+id)),
        React.createElement("button",{onClick:()=>run(commands.selectProject("/b"))},"project B"),
        React.createElement("button",{onClick:()=>run(commands.createSession({project:"/a"}))},"new A"),
        React.createElement("button",{onClick:()=>run(commands.createSession({project:"/b"}))},"new B"),
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
      await click("new A"); await click("new A");
      assert.equal(creates.length,1,"repeat activation in one Team must not allocate another session");
      await click("new B");
      assert.equal(container.querySelector("textarea").disabled,true);
      records.nb={id:"nb",workspaceId:"team-nb",project:"/b",draft:"new B draft",turns:[]};records.na={id:"na",workspaceId:"team-na",project:"/a",draft:"new A draft",turns:[]};
      await act(async()=>creates[1].wait.resolve(records.nb));
      await act(async()=>creates[0].wait.resolve(records.na));
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
    const thinking=container.querySelector('[aria-label="此对话的思考设置"]');
    await act(()=>{
      thinking.value="low";
      thinking.dispatchEvent(new win.Event("change",{bubbles:true}));
    });
    assert.equal(thinking.disabled,true);
    assert.deepEqual(changes,[],"busy roster must not send a thinking mutation");
    await render(false);
    const click=text=>act(async()=>{const button=[...container.querySelectorAll("button")].find(b=>b.textContent===text);button.focus();button.click();});
    assert.match(container.textContent,/实际思考：high（对话设置，覆盖阵容中的 low）/);
    await click("使用已保存参数");
    assert.deepEqual(switches,[{sessionId:"session",teamId:"old"}],"an older effective snapshot can explicitly return to its saved Team without creating another Team");
    await act(async()=>{const select=container.querySelector('[aria-label="此对话的思考设置"]');select.value="";select.dispatchEvent(new win.Event("change",{bubbles:true}));});
    assert.deepEqual(changes,[["session.thinking",{},"session"]]);
    await click("基于当前阵容调整");
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
    const team={id:"old",name:"Original",main:{provider:"p",modelId:"a"},secondary:[{provider:"p",modelId:"b"}]};
    let saves=0, reads=0, switches=0;
    const props={session:{id:"s",team},teams:[team],models:["a","b"].map(modelId=>({provider:"p",modelId,name:modelId,thinkingLevels:["off"]})),providers:[{id:"p",configured:true}],
      commands:{saveTeam:async()=>{saves++;throw Object.assign(Error("lost reply"),{unknown:true});},refreshTeams:async()=>{reads++;return {providers:[]};},refresh:async()=>{},selectTeam:async()=>switches++},onClose(){}};
    const click=text=>act(async()=>[...container.querySelectorAll("button")].find(b=>b.textContent===text).click());
    await act(()=>root.render(React.createElement(TeamPanel,props)));
    await click("基于当前阵容调整");
    await act(()=>{const input=container.querySelector('[aria-label="新阵容名称"]');Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype,"value").set.call(input,"Maybe saved");input.dispatchEvent(new win.Event("input",{bubbles:true}));});
    await act(async()=>container.querySelector("form").dispatchEvent(new win.Event("submit",{bubbles:true,cancelable:true})));
    assert.equal(saves,1);assert.equal(reads,1);
    const observed={...team,id:"observed",name:"Maybe saved",main:{...team.main,maxOutputTokens:999}};
    await act(()=>root.render(React.createElement(TeamPanel,{...props,teams:[team,observed]})));
    await click("读取阵容列表核对");
    assert.equal(saves,1);assert.equal(switches,0);assert.equal(reads,2);
    assert.match(container.textContent,/999 tokens/);
    assert.equal(container.querySelector('[aria-label="新阵容名称"]').value,"Maybe saved");
    assert.equal([...container.querySelectorAll("button")].find(b=>b.textContent==="仅保存新阵容").disabled,true);
    await click("取消编辑");assert.match(container.textContent,/保存结果仍未知/);
  });
});

test("Team authentication stays in the editing flow and cancel retains confirmed provider saves",async()=>{
  await modalEnvironment(async({root,container,win,TeamPanel})=>{
    const team={id:"old",name:"Original",main:{provider:"p",modelId:"a"},secondary:[{provider:"p",modelId:"b"}]};
    const auth=[],saves=[];
    const props={session:{id:"s",team},teams:[team],models:["a","b"].map(modelId=>({provider:"p",modelId,name:modelId,thinkingLevels:["off"]})),providers:[{id:"p",name:"Provider P",apiKey:true,configured:false}],
      commands:{saveProvider:async value=>auth.push(value),saveTeam:async value=>saves.push(value),refresh:async()=>{}},onClose(){}};
    const click=text=>act(async()=>[...container.querySelectorAll("button")].find(b=>b.textContent===text).click());
    await act(()=>root.render(React.createElement(TeamPanel,props)));
    await click("基于当前阵容调整");
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

test("workspace handles /team locally while busy and freezes one HTML submission per conversation until recovery",async()=>{
  await modalEnvironment(async({root,win,useGuiWorkspace})=>{
    const previous=Object.getOwnPropertyDescriptor(globalThis,"sessionStorage");
    Object.defineProperty(globalThis,"sessionStorage",{configurable:true,value:win.sessionStorage});
    const records={a:{id:"a",project:"/a",draft:"",turns:[],team:null},b:{id:"b",project:"/b",draft:"",turns:[],team:null}};
    let active={sessionId:"other",taskId:"running"}, unknown=false, found=false, workspace, taskStatus="completed";
    const submits=[],actions=[],taskReads=[];
    const api={subscribe:()=>()=>{},read:async(kind,args={})=>{
      if(kind==="bootstrap")return {teams:[],models:[],providers:[],sessions:Object.values(records),work:{},active};
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
      assert.ok(taskReads.includes("registered"),"actual progress is read once the active task is registered");
      active={sessionId:"a",taskId:"reserved",status:"running"};
      await act(async()=>workspace.commands.refresh());
      assert.match(workspace.state.errors[0],/ENOENT/,"missing records reported as readable still surface the real error");
      await act(()=>workspace.commands.setError(""));
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
      assert.equal(submits.length,2);assert.deepEqual(submits[1].workRequest,{kind:"html-svg"});
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

test("project inspection keeps a newer path when an older read completes and foregrounds actual execution limits",async()=>{
  await modalEnvironment(async({root,container,win,ProjectDialog})=>{
    const waits=[],opened=[];
    const commands={inspectProject:path=>new Promise(resolve=>waits.push({path,resolve})),
      bindWorkspace:async (workspace,path)=>{opened.push(path);return {...workspace,project:path};}};
    await act(()=>root.render(React.createElement(ProjectDialog,{commands,workspace:{id:"team",name:"Existing",revision:1},onSaved(){},onClose(){}})));
    const enter = async path => {
      await act(()=>{const input=container.querySelector('input');Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype,'value').set.call(input,path);input.dispatchEvent(new win.Event('input',{bubbles:true}));});
      await act(()=>[...container.querySelectorAll("button")].find(b=>b.textContent==="只读检查目录").click());
    };
    await enter("/old");
    await enter("/new");
    const value=path=>({path,valid:true,dirty:true,head:'head',version:'version',checks:[{command:'npm',args:['test']}],execution:null});
    await act(()=>waits[0].resolve(value('/old')));
    assert.equal(container.querySelector('.project-inspection'),null,'stale result must not offer the wrong project');
    await act(()=>waits[1].resolve(value('/new')));
    assert.match(container.textContent,/未提交修改/);
    assert.match(container.textContent,/未配置执行环境/);
    assert.match(container.textContent,/尚未运行/);
    assert.equal(container.querySelector('.project-inspection details').open,false);
    await act(()=>container.querySelector('form').dispatchEvent(new win.Event('submit',{bubbles:true,cancelable:true})));
    assert.deepEqual(opened,['/new']);
  });
});


test("Team creation form needs only a name even without a directory or roster",async()=>{
  await modalEnvironment(async({root,container,win,ProjectDialog})=>{
    const requests=[],saved=[];
    const commands={createWorkspace:async args=>{requests.push(args);return {id:"new",...args};}};
    await act(()=>root.render(React.createElement(ProjectDialog,{commands,onSaved:value=>saved.push(value),onClose(){}})));
    assert.match(container.textContent,/暂无默认阵容/);
    await act(()=>{const input=container.querySelector("input");Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype,"value").set.call(input,"课程笔记");input.dispatchEvent(new win.Event("input",{bubbles:true}));});
    await act(()=>container.querySelector("form").dispatchEvent(new win.Event("submit",{bubbles:true,cancelable:true})));
    assert.deepEqual(requests,[{name:"课程笔记",project:null,defaultRosterId:null}]);
    assert.equal(saved[0].id,"new");
  });
});


test("reply branch action targets its own completed reply and compact composer omits permanent hints",async()=>{
 await modalEnvironment(async({root,container,win,Conversation})=>{
  const forks=[],team={id:"t",name:"T",main:{provider:"p",modelId:"m"},secondary:[{provider:"p",modelId:"r"}]};
  const state={bootstrap:{teams:[team],models:[],sessions:[],active:null},session:{id:"a",title:"Title",project:null,team,turns:[{taskId:"first",input:"question",finalText:"answer",status:"completed",canFork:true}]},task:null,draft:"draft",ready:true,errors:[]};
  const props={state,commands:{setDraft(){},setError(){},openSession(){},refresh(){},abandonSubmission(){}},onFork:id=>{forks.push(id);},onSettings(){},onToggleNavigation(){},onCopy(){}};
  await act(()=>root.render(React.createElement(Conversation,props)));
  assert.equal(container.querySelector('[aria-label="重命名对话"]'),null);
  assert.doesNotMatch(container.textContent,/Enter 发送 · Shift\+Enter|问答 3 次 \/ 工作不限/);
  await act(async()=>[...container.querySelectorAll('button')].find(b=>b.textContent==='从这里分支').click());
  assert.deepEqual(forks,['first']);
  await act(()=>root.render(React.createElement(Conversation,{...props,state:{...state,session:{...state.session,turns:[{...state.session.turns[0],canFork:false,status:'running'}]}}})));
  assert.equal([...container.querySelectorAll('button')].find(b=>b.textContent==='从这里分支').disabled,true);
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
      if(kind==="bootstrap")return {teams:[],models:[],providers:[],sessions:Object.values(records),work:{},active:null};
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
    const make=id=>({id,project:"/"+id,turns:[],draft:"",editor:{text:"",workRequest:null,selectionId:null,editId:null},draftRevision:null,branchAnchor:"root-"+id});
    const records={a:make("a"),b:make("b")}, saves=[],submits=[];
    let workspace,releaseTask,taskReadStarted;
    const entered=new Promise(resolve=>{taskReadStarted=resolve;});
    const api={subscribe:()=>()=>{},read:async(kind,args={})=>{
      if(kind==="bootstrap")return {teams:[],models:[],providers:[],sessions:Object.values(records),work:{},active:null};
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
      assert.deepEqual(submits[0].workRequest,{kind:"html-svg"}); assert.equal(newest.workRequest,null);
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
      if(kind==="bootstrap")return {teams:[],models:[],providers:[],sessions:Object.values(records),work:{},active:null};
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

test("roster default failure preserves the confirmed switch and retries only the default",async()=>{
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
    await act(()=>root.render(React.createElement(TeamPanel,{session:{id:"s",team:first},workspace:group,teams:[first,next],commands,onClose(){}})));
    const click=label=>act(async()=>{
      const button=[...container.querySelectorAll("button")].find(b=>(b.getAttribute("aria-label")||b.textContent)===label);
      assert.ok(button,label);
      button.click();
    });
    const combined=[...container.querySelectorAll("button")].find(button=>
      button.getAttribute("aria-label")==="使用新阵容，并用于此 Team 的新对话");
    assert.equal(combined?.textContent,"使用并设为新对话默认");
    await click("使用新阵容，并用于此 Team 的新对话");
    assert.equal(current.id,next.id);
    assert.equal(saved.defaultRosterId,first.id);
    assert.match(container.textContent,/当前对话已使用「新阵容」.*默认阵容未保存/);
    await click("重新保存默认阵容");
    assert.equal(saved.defaultRosterId,next.id);
    assert.deepEqual(calls,[["switch","two"],["default",1],["default",2]]);
  });
});

test("lost stop acknowledgement remains pending on the original task until the host reports its end",async()=>{
  await modalEnvironment(async({root,win,useGuiWorkspace})=>{
    const previous=Object.getOwnPropertyDescriptor(globalThis,"sessionStorage");
    Object.defineProperty(globalThis,"sessionStorage",{configurable:true,value:win.sessionStorage});
    let active={taskId:"running",sessionId:"a"}, workspace;
    const stops=[];
    const api={subscribe:()=>()=>{},read:async kind=>{
      if(kind==="bootstrap")return {teams:[],models:[],providers:[],sessions:[],work:{},active};
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
        return {teams:[],models:[],providers:[],sessions:[],workspaces:[before],work:{},active:null};
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

test("damaged Pi affiliation keeps history readable and requires an explicit context for creation", async t => {
  const {fixture}=await import("./helpers/pi-fixture.js");
  const {createGuiController}=await import("../src/gui-controller.js");
  const {saveConfig}=await import("../src/config.js");
  const {createTeamConfig}=await import("../src/teams.js");
  const {readFileSync,readdirSync,writeFileSync}=await import("node:fs");
  const {join}=await import("node:path");
  const f=await fixture(t,()=>({text:"保存的答复"}));
  saveConfig(f.home,createTeamConfig({formatVersion:2,...f.models},"Fixture",crypto.randomUUID()));
  const controller=await createGuiController({home:f.home,cwd:f.cwd});
  t.after(()=>controller.close());
  const generic=await controller.action("session.create",{sessionId:crypto.randomUUID(),workspaceId:null});
  const damaged=await controller.action("session.create",{sessionId:crypto.randomUUID(),workspaceId:null});
  await controller.action("session.mode",{sessionId:damaged.id,mode:"one"});
  await controller.action("session.name",{sessionId:damaged.id,title:"归属异常夹具"});
  const {taskId}=await controller.action("task.submit",{sessionId:damaged.id,input:"保存的问题",submissionId:"unknown-affiliation"});
  for (let i=0;i<200 && (await controller.task(taskId)).status==="running";i++)
    await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal((await controller.task(taskId)).status,"completed");
  const {draftRevision,branchAnchor}=await controller.session(damaged.id);
  await controller.action("session.draft",{sessionId:damaged.id,text:"保存的草稿",expectedDraftRevision:draftRevision,
    branchAnchor,editId:crypto.randomUUID(),workRequest:null,selectionId:null});
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
        const genericEntry=[...container.querySelectorAll("nav button")].find(button=>button.textContent==="通用对话");
        assert.equal(genericEntry.hasAttribute("aria-current"),false);
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
        for (let i=0;i<50 && gui.state.navigationLoading;i++) await act(async()=>new Promise(resolve=>setTimeout(resolve,10)));
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

        await act(async()=>genericEntry.click());
        for (let i=0;i<50 && gui.state.session?.id!==generic.id;i++) await act(async()=>new Promise(resolve=>setTimeout(resolve,10)));
        assert.equal(gui.state.workspaceId,null);
        assert.equal(genericEntry.getAttribute("aria-current"),"page");
        assert.equal(gui.state.session.id,generic.id);
        await act(async()=>gui.commands.searchSessions({scope:"project",query:""}));
        for (let i=0;i<50 && gui.state.navigationLoading;i++) await act(async()=>new Promise(resolve=>setTimeout(resolve,10)));
        assert.deepEqual(gui.state.sessions.map(row=>row.id),[generic.id]);
        await act(async()=>gui.commands.createSession({workspaceId:null}));
        assert.equal(creates.length,1);
        assert.equal(creates[0].workspaceId,null);
        assert.equal(gui.state.session.workspaceId,null);
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
