import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createApi } from "../gui/src/api.js";
import { editorTurnInput } from "../src/gui-turn-options.js";
import { controller, finished, fixtureConversation, load } from "./helpers/gui-controller-fixture.js";
import { fixture } from "./helpers/pi-fixture.js";

const { startGuiServer } = await load("src/gui-server.js");
const editor = page => page.getByRole("textbox", { name: "输入问题" });
const action = (request, name) => request.url().endsWith("/api/action") &&
  request.method() === "POST" && request.postDataJSON()?.action === name;

async function setup(t, reply, initialDraft) {
  const model = await fixture(t, reply);
  const c = await controller(t, model);
  const room = await fixtureConversation(t, c);
  await c.action("session.name", { sessionId: room.id, title: "草稿恢复验收" });
  if (initialDraft) {
    const saved = await c.session(room.id);
    await c.action("session.draft", {sessionId:room.id,editId:crypto.randomUUID(),workRequest:null,selectionId:null,
      expectedDraftRevision:saved.draftRevision,branchAnchor:saved.branchAnchor,...initialDraft});
  }
  const host = await startGuiServer({ controller: c, open: false });
  let hostOpen = true;
  const close = async () => { if (hostOpen) { hostOpen = false; await host.close(); } };
  t.after(close);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const visit = async (page, url = host.url) => {
    await page.goto(url);
    await page.locator("h1").getByText("草稿恢复验收", { exact: true }).waitFor();
  };
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  await visit(page);
  return { model, c, room, host, close, browser, page, visit };
}

async function save(page, text) {
  const saved = page.waitForResponse(r => action(r.request(), "session.draft") && r.ok());
  await editor(page).fill(text);
  await saved;
}

test("an old review draft waits for acceptance and submits with its existing hard limits", async t => {
  const message = "这条旧草稿还没有提交。";
  const {page,model} = await setup(t,undefined,{text:message,turnOptions:{
    id:crypto.randomUUID(),review:true,delegate:"review-only",readOnly:true,maxCalls:"1",
  }});
  const send = page.getByRole("button",{name:"发送",exact:true});
  const accept = page.getByRole("button",{name:"采用现行规则",exact:true});
  assert.equal(await editor(page).inputValue(),message);
  assert.equal(await send.isDisabled(),true);
  await accept.waitFor();
  await editor(page).press("Enter");
  assert.equal(model.calls.length,0);
  const saved = page.waitForResponse(r=>action(r.request(),"session.draft") && r.ok());
  await accept.click();
  const body = await (await saved).json();
  assert.equal(body.editor.text,message);
  assert.equal(body.editor.turnOptions.delegate,false);
  assert.equal(body.editor.turnOptions.readOnly,true);
  assert.equal(body.editor.turnOptions.maxCalls,"1");
  assert.equal(body.editor.turnOptions.review,false);
  await page.reload();
  await editor(page).waitFor();
  assert.equal(await accept.count(),0,"the acknowledgement survives reload");
  const sent = page.waitForRequest(r=>action(r,"task.submit"));
  await send.click();
  const args=(await sent).postDataJSON().args;
  assert.equal(args.editorEditId,body.editor.editId);
  assert.equal(args.protocolVersion,1);
  assert.deepEqual(args.constraints,{readOnly:true,allowedSubtasks:[]});
  assert.deepEqual(args.budget,{maxCalls:1});
  await page.getByText("fixture answer",{exact:true}).waitFor();
  assert.equal(model.calls.length,1);
});

test("a received submission is recovered on a different desktop origin", async t => {
  const { model, host, close, page, visit } = await setup(t);
  const message = "提交确认丢失后仍应识别已发送草稿。";
  await page.route("**/api/action", async route => {
    if (!action(route.request(), "task.submit")) return route.continue();
    const response = await route.fetch();
    assert.equal(response.ok(), true);
    await route.abort("connectionreset");
  });
  await editor(page).fill(message);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.getByText(/提交确认丢失/).waitFor();
  await page.getByText("fixture answer", { exact: true }).waitFor();
  assert.equal(model.calls.length, 1);
  await page.unroute("**/api/action");
  await close();
  const restarted = await startGuiServer({ home: model.home, cwd: model.cwd,
    open: false, installation: "desktop", suggestedProject: null });
  t.after(() => restarted.close());
  assert.notEqual(host.origin, restarted.origin);
  await visit(page, restarted.url);
  await page.getByText("fixture answer", { exact: true }).waitFor();
  assert.equal(await editor(page).inputValue(), "", "the already accepted editor must not remain sendable");
  assert.equal(await page.getByRole("button", { name: "发送", exact: true }).isEnabled(), false);
  assert.equal(model.calls.length, 1);
});

test("a different submission ID cannot send the same saved editor twice", async t => {
  const model = await fixture(t), c = await controller(t, model);
  const room = await fixtureConversation(t, c);
  const input="同一个已保存的编辑快照只发送一次。", editorEditId=crypto.randomUUID();
  await c.action("session.draft", {sessionId:room.id,text:input,editId:editorEditId,
    expectedDraftRevision:room.draftRevision,branchAnchor:room.branchAnchor,workRequest:null,selectionId:null});
  const submit={sessionId:room.id,input,editorEditId,protocolVersion:1,submissionId:crypto.randomUUID(),...editorTurnInput(null)};
  const original=await c.action("task.submit",submit);
  await finished(c,original.taskId);
  const retry={...submit,submissionId:crypto.randomUUID()};
  assert.deepEqual(await c.action("task.submit",retry),original);
  const host=await startGuiServer({controller:c,open:false});
  t.after(()=>host.close());
  const api=createApi(host.token,(path,options)=>fetch(host.origin+path,options));
  const association={sessionId:room.id,submissionId:retry.submissionId,editorSnapshot:{editId:editorEditId}};
  assert.equal((await api.recover(association))?.taskId,original.taskId);
  assert.equal(await api.recover({...association,editorSnapshot:{editId:crypto.randomUUID()}}),null);
  assert.equal(await api.recover({...association,kind:"prepared-continuation"}),null);
  assert.equal(model.calls.length,1);
});

test("a lost request without an accepted record retains the draft without replaying it", async t => {
  const { model, host, close, page, visit } = await setup(t);
  const message = "确认前未到达宿主的草稿应保留。";
  await page.route("**/api/action", route => action(route.request(), "task.submit")
    ? route.abort("connectionreset") : route.continue());
  await editor(page).fill(message);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.getByText(/提交确认丢失/).waitFor();
  await page.unroute("**/api/action");
  await close();
  const restarted = await startGuiServer({home:model.home,cwd:model.cwd,open:false,installation:"desktop",suggestedProject:null});
  t.after(() => restarted.close());
  assert.notEqual(host.origin, restarted.origin);
  await visit(page,restarted.url);
  assert.equal(await editor(page).inputValue(),message);
  assert.equal(model.calls.length,0);
});

test("a normal browser reload restores the latest unsaved edit in the same tab", async t => {
  const { page, model } = await setup(t);
  await save(page, "已保存的旧草稿");
  // Hold the latest write off the server. The browser reload interrupts it.
  await page.route("**/api/action", async route => {
    if (action(route.request(), "session.draft")) return route.abort();
    return route.continue();
  });
  await editor(page).fill("这段最新输入不能在刷新时消失");
  await page.reload();
  await page.locator("h1").getByText("草稿恢复验收", { exact: true }).waitFor();
  assert.equal(await editor(page).inputValue(), "这段最新输入不能在刷新时消失");
  assert.equal(model.calls.length, 0);
});

test("a clean editor adopts a newer saved draft in another tab", async t => {
  const { page, browser, visit, model } = await setup(t);
  const other = await browser.newPage();
  await visit(other);
  const observed = page.waitForResponse(async r => r.url().includes("/api/session?") && r.ok() &&
    (await r.json()).editor?.text === "另一个页面保存的草稿");
  await save(other, "另一个页面保存的草稿");
  await observed;
  await page.waitForFunction(() => document.querySelector("textarea")?.value === "另一个页面保存的草稿",
    null, { timeout: 2000 });
  assert.equal(model.calls.length, 0);
});

test("a missing stop acknowledgement can be checked without resending the stop", async t => {
  const requestStarted = Promise.withResolvers(), answer = Promise.withResolvers();
  const { page, model } = await setup(t, () => { requestStarted.resolve(); return answer.promise; });
  try {
  let stops = 0, original;
  await page.route("**/api/action", async route => {
    if (!action(route.request(), "task.cancel")) return route.continue();
    ++stops;
    if (stops === 1) {
      original = route.request().postDataJSON().args.taskId;
      return route.abort("connectionreset");
    }
    assert.equal(route.request().postDataJSON().args.taskId, original);
    return route.continue();
  });
  await editor(page).fill("这条会话用于核对停止结果。");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await requestStarted.promise;
  const stop = page.getByRole("button", { name: "停止", exact: true });
  await stop.click();
  await page.getByRole("button", { name: "核对停止", exact: true }).click();
  await stop.waitFor();
  assert.equal(stops, 1, "checking is read-only");
  await stop.click();
  await page.getByText(/已停止。已完成的内容保留/).waitFor();
  assert.equal(stops, 2);
  assert.equal(model.calls.length, 1);
  } finally { answer.resolve({text:"fixture released"}); }
});
