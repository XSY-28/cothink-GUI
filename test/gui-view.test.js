import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
const view = await import("../gui/src/view.js").catch(() => ({}));
const api = await import("../gui/src/api.js").catch(() => ({}));
const markdown = await import("../gui/src/Markdown.js").catch(() => ({}));
test("display preferences survive reload while rejecting damaged versions and excluding host records",async()=>{
  const {readDisplayPreferences,saveDisplayPreferences,initialView}=await import("../gui/src/workspace-view.js");
  const win=new Window({url:"http://localhost"}), storage=win.localStorage;
  saveDisplayPreferences(storage,{...initialView,theme:"dark",navigation:{...initialView.navigation,expandedProjects:{"/project":false}},session:{text:"private"},team:{secret:"no"},pending:{submissionId:"unknown"}});
  const saved=storage.getItem("cothink.display");
  assert.doesNotMatch(saved,/private|secret|submissionId|session|team|pending/);
  assert.equal(readDisplayPreferences(storage).theme,"dark");
  assert.doesNotMatch(saved,/expandedProjects/);
  storage.setItem("cothink.display",'{"schemaVersion":1,"theme":"fake","expandedProjects":{"/ok":false,"/bad":"false","nonsense":true},"draft":"private"}');
  assert.equal(readDisplayPreferences(storage).navigation.expandedProjects,undefined);
  assert.equal(readDisplayPreferences(storage).theme,"light");
  for(const value of ['{broken','{"schemaVersion":99,"theme":"dark"}']){storage.setItem("cothink.display",value);assert.equal(readDisplayPreferences(storage).theme,"light");}
  storage.removeItem("cothink.display");
  storage.setItem("cothink.theme","dark");
  assert.equal(readDisplayPreferences(storage).theme,"dark");
  win.happyDOM.abort();
});

test("composer only sends unmodified Enter outside IME composition", () => {
  assert.equal(
    typeof view.shouldSubmit,
    "function",
    "composer key policy exists",
  );
  for (const event of [
    { key: "Enter", isComposing: true },
    { key: "Enter", keyCode: 229 },
    { key: "Enter", shiftKey: true },
    { key: "Enter", ctrlKey: true },
    { key: "Enter", altKey: true },
    { key: "a" },
  ])
    assert.equal(view.shouldSubmit(event), false);
  assert.equal(view.shouldSubmit({ key: "Enter" }), true);
});
test("elapsed time uses persisted start/end and keeps absent terminal timestamps unknown", () => {
  assert.equal(typeof view.elapsedLabel, "function");
  assert.equal(
    view.elapsedLabel(
      { status: "running", createdAt: "2026-10-23T00:00:00Z" },
      Date.parse("2026-10-23T00:01:05Z"),
    ),
    "1分05秒",
  );
  assert.equal(
    view.elapsedLabel({
      status: "completed",
      createdAt: "2026-10-23T00:00:00Z",
      endedAt: "2026-10-23T00:00:08Z",
    }),
    "8秒",
  );
  assert.equal(
    view.elapsedLabel({
      status: "outcome_unknown",
      createdAt: "2026-10-23T00:00:00Z",
    }),
    "用时未知",
  );
});
test("elapsed time follows root wall clock through preparation, cancellation and uncertain stops", () => {
  const createdAt="2026-11-08T00:00:00Z", endedAt="2026-11-08T00:00:18Z", cancelSettledAt="2026-11-08T00:00:25Z";
  const now=Date.parse("2026-11-08T00:00:30Z");
  for(const status of ["running","preparing","cancelling"])
    assert.equal(view.elapsedLabel({createdAt,endedAt,status},now),"30秒");
  for(const status of ["completed","failed","partial","blocked"])
    assert.equal(view.elapsedLabel({createdAt,endedAt,status},now),"18秒");
  assert.equal(view.elapsedLabel({createdAt,endedAt,cancelSettledAt,status:"cancelled"},now),"25秒");
  assert.equal(view.elapsedLabel({createdAt,endedAt,cancelSettledAt,status:"partial"},now),"25秒");
  assert.equal(view.elapsedLabel({createdAt,endedAt,status:"cancelled"},now),"用时未知");
  assert.equal(view.elapsedLabel({createdAt,endedAt,cancelSettledAt,status:"stop_unknown"},now),"用时未确认");
  for(const values of [{status:"completed"},{status:"failed",endedAt:"invalid"},{status:"completed",endedAt:"2026-11-07T23:59:59Z"}])
    assert.equal(view.elapsedLabel({createdAt,...values},now),"用时未知");
  assert.equal(view.elapsedLabel({createdAt,endedAt,status:"completed",children:[{elapsedMs:99000}]},now),"18秒");
});
test("pending confirmation uses GET only and exact durable submission identity after reload", async () => {
  assert.equal(typeof api.createApi, "function", "API client exists");
  const requests = [];
  const client = api.createApi("tab-only-token", async (url, options) => {
    requests.push({ url, options });
    return new Response(
      JSON.stringify({
        id: "s",
        turns: [
          { taskId: "wrong", submissionId: "other" },
          { taskId: "accepted", submissionId: "pending" },
        ],
      }),
    );
  });
  const pending = JSON.parse(
    JSON.stringify({ sessionId: "s", submissionId: "pending" }),
  );
  assert.equal((await client.recover(pending)).taskId, "accepted");
  assert.equal(
    await client.recover({ sessionId: "s", submissionId: "unseen" }),
    null,
  );
  assert.deepEqual(
    requests.map((r) => r.options.method),
    ["GET", "GET"],
  );
  assert.equal(
    requests[0].options.headers.Authorization,
    "Bearer tab-only-token",
  );
});
test("unknown action response never retries and remains distinguishable from a rejection", async () => {
  assert.equal(typeof api.createApi, "function");
  let calls = 0;
  const client = api.createApi("token", async () => {
    calls++;
    throw Error("connection lost");
  });
  await assert.rejects(
    client.action("task.submit", { submissionId: "one" }),
    (e) => e.unknown === true,
  );
  assert.equal(calls, 1);
  const rejected = api.createApi(
    "token",
    async () =>
      new Response(JSON.stringify({ error: "Team missing" }), { status: 400 }),
  );
  await assert.rejects(
    rejected.action("task.submit", {}),
    (e) => e.unknown === false && /Team missing/.test(e.message),
  );
});
test("both JSON actions and binary material writes advertise the current input contract", async () => {
  const writes = [];
  const client = api.createApi("token", async (url, options) => {
    writes.push([url, options.method, new Headers(options.headers).get("x-cothink-gui-input")]);
    return Response.json({});
  });
  await client.action("session.draft", {sessionId:"room",text:"Keep me"});
  await client.uploadMaterial("room","upload",new Uint8Array([1]));
  assert.deepEqual(writes, [
    ["/api/action","POST","3"],
    ["/api/materials?ownerId=room&uploadId=upload","POST","3"],
  ]);
});
test("startup token is removed from address and kept only in the current tab", () => {
  assert.equal(typeof api.consumeToken, "function");
  const win = new Window({ url: "http://127.0.0.1:9000/#token=secret" });
  assert.equal(api.consumeToken(win), "secret");
  assert.equal(win.location.hash, "");
  assert.equal(win.localStorage.length, 0);
  assert.equal(api.consumeToken(win), "secret");
});
test("untrusted Markdown keeps math and code readable while excluding HTML and image requests", () => {
  assert.equal(typeof markdown.Markdown, "function", "safe renderer exists");
  const html = renderToStaticMarkup(
    React.createElement(markdown.Markdown, {
      text: '# 标题\n\n<script>alert(1)</script>\n\n<img src="https://private/image">\n\n![secret](https://private/pixel)\n\n[bad](javascript:alert(1))\n\n```js\n<img onerror=alert(1)>\n```\n\n$x^2$',
    }),
  );
  assert.doesNotMatch(html, /<script|<img|href="javascript:/);
  assert.match(html, /&lt;img onerror/);
  assert.match(html, /katex/);
  assert.match(html, /标题/);
});
test("empty check policies never become passed and unknown revision headings retain original text", () => {
  assert.equal(typeof view.checkLabel, "function");
  assert.match(
    view.checkLabel({ status: "passed", verification: "unverified" }),
    /未验证/,
  );
  assert.match(
    view.checkLabel({ status: "passed", verification: "passed" }),
    /通过/,
  );
  assert.doesNotMatch(view.checkLabel(null), /通过/);
  assert.equal(
    view.revisionExplanation("Final\n\n## Unknown heading\nOriginal"),
    null,
  );
  assert.equal(
    view.revisionExplanation(
      "Answer\n\n## 对评审意见的处理说明\nKept this reason\n\n## Next\nMore",
    ),
    "Kept this reason",
  );
  assert.equal(
    view.revisionExplanation(
      "```\n## 对评审意见的处理说明\nnot a section\n```",
    ),
    null,
  );
});
test("draft refreshes and delayed submission acknowledgements preserve newer typing and session ownership", () => {
  assert.equal(typeof view.createDraftBook, "function");
  const book = view.createDraftBook();
  book.load("a", "saved");
  book.edit("a", "sending");
  const submitted = book.snapshot("a");
  book.edit("a", "next unsent thought");
  book.load("a", "saved");
  book.load("b", "other session");
  book.accepted(submitted);
  assert.equal(book.snapshot("a").text, "next unsent thought");
  assert.equal(book.snapshot("b").text, "other session");
  book.accepted(book.snapshot("b"));
  assert.equal(book.snapshot("b").text, "");
});

test('the observed work_starting phase has a readable Chinese label',()=>{
 assert.equal(view.phaseLabel('work_starting'),'准备项目');
});

test("complete editor acknowledgements retain later edits and isolate work selection consumption",()=>{
  const b=view.createDraftBook();
  b.load("a",{text:"saved",workRequest:{kind:"html-svg"},selectionId:"choice",editId:"saved-edit"},"d0","anchor");
  assert.equal(b.snapshot("a").workRequest.kind,"html-svg");
  b.edit("a","sending"); const sent=b.snapshot("a");
  b.edit("a","next thought");
  b.confirmed(sent,{draftRevision:"d1",branchAnchor:"new-anchor",editor:{...sent}});
  assert.equal(b.snapshot("a").text,"next thought"); assert.equal(b.snapshot("a").expectedDraftRevision,"d1");
  b.accepted(sent); assert.equal(b.snapshot("a").text,"next thought"); assert.equal(b.snapshot("a").workRequest,null);
  b.edit("a",{workRequest:{kind:"html-svg"},selectionId:"next-choice"});
  b.accepted(sent); assert.equal(b.snapshot("a").selectionId,"next-choice");
});
