import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { chooseRailCreation } from "./helpers/gui-rail.js";
import { fixture } from "./helpers/pi-fixture.js";
import { execution } from "./helpers/agent-sync-fixture.js";

const packageRoot = resolve(process.env.COTHINK_TEST_PACKAGE_ROOT ?? fileURLToPath(new URL("..", import.meta.url)));
const load = path => import(pathToFileURL(join(packageRoot, path)));
const { saveConfig } = await load("src/config.js");
const { createTeamConfig } = await load("src/teams.js");
const { startGuiServer } = await load("src/gui-server.js");

test("a Team file request uses its own folder and opens the checked, accepted HTML", { timeout: 45000 }, async t => {
  const reply = Promise.withResolvers();
  const plan = { goal:"Verify the proposal display", scope:["__init__.py"], deliverables:["__init__.py"],
    checks:[{command:"node",args:["-e","require('node:fs').accessSync('__init__.py')"]}] };
  const title = "自行车骑鹈鹕";
  const figureLabel = "自行车骑在鹈鹕背上";
  const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>${title}</title></head>
<body><h1>${title}</h1>
<svg viewBox="0 0 320 242" role="img" aria-label="${figureLabel}" style="display:block;width:100%;height:auto">
  <rect width="320" height="242" fill="#edf6fa"/>
  <g id="pelican" stroke="#314154" stroke-width="2">
    <path d="M111 186 L105 212 H84 M147 188 L148 212 H128" fill="none" stroke="#dd792e" stroke-width="5" stroke-linecap="round"/>
    <path d="M31 148 Q58 157 72 143 C106 120 152 124 174 144 C181 134 184 113 200 105 C212 99 228 102 236 114 L237 139 C223 138 216 149 208 165 C186 210 111 217 73 184 Z" fill="#fffdf7"/>
    <path d="M84 153 Q118 137 166 157 Q146 191 107 181 Z" fill="#d4e6ec"/>
    <path d="M234 115 L298 133 L235 143 Q222 140 223 129 Z" fill="#ed953e"/>
    <path d="M229 132 Q267 136 290 134" fill="none" stroke="#a44d2b"/>
    <circle cx="216" cy="116" r="3" fill="#202c3a"/>
  </g>
  <g id="bicycle" fill="none" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="88" cy="103" r="25" stroke="#20364a" stroke-width="5"/>
    <circle cx="168" cy="103" r="25" stroke="#20364a" stroke-width="5"/>
    <path d="M88 103 L106 73 L139 103 Z M106 73 H153 L139 103 M168 103 L147 58 L161 53" stroke="#c43743" stroke-width="5"/>
    <path d="M106 73 L100 62 H113 M145 57 H159" stroke="#20364a" stroke-width="5"/>
    <circle cx="139" cy="103" r="6" stroke="#20364a" stroke-width="3"/>
  </g>
</svg></body></html>`;
  const delivery = {goal:"Deliver offline HTML and inline SVG",scope:["index.html"],deliverables:["index.html"],
    checks:[{command:"node",args:["-e",`const h=require('node:fs').readFileSync('index.html','utf8'); if (!h.includes('<title>${title}</title>') || !h.includes('id="pelican"') || !h.includes('id="bicycle"')) process.exit(1)`]}]};
  const replies = [
    reply.promise,
    {toolCalls:[{name:"start_work",args:{action:"start",reason:"fixture",plan}}]},
    {toolCalls:[{name:"start_work",args:{action:"start",reason:"publish HTML",plan:delivery}}]},
    {toolCalls:[{name:"write",args:{path:"index.html",content:html}}]},
    {toolCalls:[{name:"accept_change",args:{}}]},
    {text:"已保存可离线打开的页面。"},
  ];
  const f = await fixture(t, (_,n) => replies[n-1]??{text:"意外的额外调用"});
  t.after(() => reply.resolve({ text: "已回答普通问题。" }));
  const rosterId = "7c8094cd-3476-4bfa-8f53-055d87972896";
  saveConfig(f.home, createTeamConfig({ formatVersion: 2, ...f.models, work:{execution} }, "文件任务验证阵容", rosterId));
  const projectPath = mkdtempSync(join(tmpdir(), "cothink-file-task-"));
  t.after(() => rmSync(projectPath, { recursive: true, force: true }));
  const project = realpathSync(projectPath);
  const host = await startGuiServer({ home: f.home, cwd: f.cwd, installation: "desktop", open: false });
  t.after(() => host.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  page.setDefaultTimeout(5000);
  const submitted = [];
  const submissionIds = [];
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/action") return;
    const payload = request.postDataJSON();
    if (payload?.action === "task.submit") {
      submitted.push(payload.args.input);
      submissionIds.push(payload.args.submissionId);
    }
  });
  const button = name => page.getByRole("button", { name, exact: true });
  const editor = page.getByLabel("输入问题", { exact: true });
  const capture = async filename => {
    const directory = process.env.COTHINK_UI_SCREENSHOTS;
    if (!directory) return;
    mkdirSync(directory, { recursive: true });
    await page.screenshot({ path: join(directory, filename) });
  };

  await page.goto(host.url);
  await editor.waitFor();
  await chooseRailCreation(page, "新建 Team");
  const create = page.getByRole("dialog", { name: "新建 Team", exact: true });
  await create.getByLabel("名称", { exact: true }).fill("文件任务项目");
  await create.getByText("手动输入路径", { exact: true }).click();
  await create.getByLabel("项目绝对路径", { exact: true }).fill(project);
  await create.getByRole("button", { name: "只读检查目录", exact: true }).click();
  await create.getByText("可以使用这个文件夹。",{exact:true}).waitFor();
  await create.getByRole("combobox",{name:"默认阵容",exact:true}).selectOption(rosterId);
  await create.getByRole("button", { name: "创建", exact: true }).click();
  await create.waitFor({ state: "hidden" });
  await page.getByRole("heading",{name:"这次想完成什么？",exact:true}).waitFor();
  const folders=readdirSync(project,{withFileTypes:true}).filter(entry=>entry.isDirectory());
  assert.equal(folders.length,1,"creating the Team also creates its first conversation folder");
  const conversationFolder=join(project,folders[0].name);
  const childHead=join(conversationFolder,".git","HEAD");
  assert.equal(existsSync(childHead),false,"a new chat needs no Git initialization");
  assert.deepEqual(submitted, []);
  assert.equal(f.calls.length, 0);

  const chatPrompt = "HTML 和 SVG 有什么区别？\n用一个简短例子。";
  await editor.fill(chatPrompt);
  await button("发送").click();
  const input = page.locator('[data-reading-part="input"]').filter({ hasText: "HTML 和 SVG 有什么区别？" });
  await input.waitFor();
  try {
    const answer = page.getByRole("article").filter({ hasText: "进行中" });
    await answer.getByRole("button", { name: "停止", exact: true }).waitFor();
    assert.doesNotMatch(await answer.innerText(), /正在生成|生成中|正在梳理问题|主模型|已发\s*\d+\s*次调用|调用数尚未汇总|完整交付将在结束后显示/);
    await capture("chat-quiet-progress.png");
  } finally {
    reply.resolve({ text: "已回答普通问题。" });
  }
  await page.getByText("已回答普通问题。", { exact: true }).waitFor();
  assert.deepEqual(submitted, [chatPrompt]);
  assert.equal(f.calls.length, 1);
  assert.equal(existsSync(childHead),false,"ordinary chat does not initialize the project");
  const chatReply = page.getByRole("article").filter({hasText:"已回答普通问题。"});
  await chatReply.getByRole("button",{name:"查看过程"}).click();
  const processView = page.getByRole("complementary",{name:"本轮协作"});
  await processView.getByText(/主模型经理 · 已完成/).click();
  await processView.getByText(/主模型回复 · 已完成 · fixture \/ main/).waitFor();
  assert.equal(await processView.getByText(/主答初稿|过程检查 ·/).count(),0);
  await processView.getByRole("button",{name:"收起本轮协作"}).click();

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const copy = input.getByRole("button", { name: "复制消息", exact: true });
  const copyHandle = await copy.elementHandle();
  const copyVisible = button => {
    for (let node = button; node && !node.hasAttribute("data-reading-part"); node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.visibility !== "visible" || style.display === "none" || Number(style.opacity) < 0.95) return false;
    }
    return true;
  };
  assert.equal(await page.evaluate(copyVisible, copyHandle), false, "the copy icon stays hidden away from the user message");
  await input.getByText(/HTML 和 SVG 有什么区别/).hover();
  await page.waitForFunction(copyVisible, copyHandle);
  await capture("chat-copy-user-message.png");
  await copy.click();
  await page.waitForFunction(async expected => (await navigator.clipboard.readText()) === expected, chatPrompt);

  const wholeTurn = "请全程不联网，帮我生成 index.html。";
  await editor.fill(wholeTurn);
  await button("发送").click();
  await page.getByText(/整轮离线.*未发送模型请求/).waitFor();
  assert.equal(await editor.inputValue(),wholeTurn);
  assert.equal(f.calls.length,1,"explicit whole-turn offline sends no model request");
  assert.equal(existsSync(childHead),false,"the rejected request does not initialize Git");

  const filePrompt = "给我生成一个自行车骑鹈鹕的html界面，svg图像，不允许联网";
  await editor.fill(filePrompt);
  await page.getByText(/整轮离线.*未发送模型请求/).waitFor({state:"hidden"});
  assert.equal(await button("发送").isEnabled(),true);
  assert.equal(await button("准备文件工作").count(),0);
  assert.equal(await button("只要求成品离线").count(),0);
  assert.equal(await page.getByText(/目录尚未准备|目录已准备|这次需要整轮离线/).count(),0);
  await capture("file-task-ready.png");

  await page.getByRole("button",{name:/^对话操作：/}).click();
  await button("下一条消息的限制").click();
  await page.getByLabel("本轮最多模型请求（留空不设上限）",{exact:true}).fill("1");
  await page.keyboard.press("Escape");
  await button("发送").click();
  const confirmation=button("确认上述计划并执行");
  await confirmation.waitFor();
  const proposal=page.locator("article pre").filter({hasText:"待确认工作提议"});
  assert.match(await proposal.textContent(), /"__init__\.py"/);
  assert.equal(await confirmation.isDisabled(),true,"planning spent the last allowed request");
  await page.getByText(/本轮模型请求额度已用完/).waitFor();
  assert.equal(f.calls.length,2);
  const modelInput=JSON.stringify(f.calls[1].body.messages);
  assert.ok(modelInput.includes(filePrompt));
  assert.match(modelInput,/artifact-offline/);
  assert.deepEqual(submitted,[chatPrompt,wholeTurn,filePrompt]);
  assert.equal(existsSync(childHead),true,"the first file task prepares only its conversation folder");
  assert.equal(existsSync(join(project,".git")),false,"the Team folder is not initialized");

  await editor.fill(filePrompt);
  await button("发送").click();
  const readyProposal=page.getByRole("article").filter({hasText:'"index.html"'});
  await readyProposal.getByRole("button",{name:"确认上述计划并执行"}).click();
  const outcome=page.getByRole("article").filter({hasText:"已保存可离线打开的页面。"});
  await outcome.getByRole("button",{name:/index\.html/}).click({timeout:25000});
  const files=page.getByRole("region",{name:"成果文件阅读"});
  await files.getByRole("button",{name:"打开成果目录"}).waitFor();
  await files.getByText("已放入对话文件夹。",{exact:true}).waitFor();
  const frame=files.frameLocator('iframe[title="静态预览 index.html"]');
  await frame.getByRole("heading",{name:title,exact:true}).waitFor();
  await frame.getByRole("img",{name:figureLabel,exact:true}).waitFor();
  assert.equal(await files.locator('iframe').getAttribute("sandbox"),"");
  const [file]=await Promise.all([page.waitForEvent("download"),files.getByRole("button",{name:"下载原文件"}).click()]);
  assert.equal(readFileSync(await file.path(),"utf8"),html);
  const [patch]=await Promise.all([page.waitForEvent("download"),files.getByRole("button",{name:"下载完整补丁"}).click()]);
  assert.match(readFileSync(await patch.path(),"utf8"),/diff --git a\/index\.html b\/index\.html/);
  assert.equal(readFileSync(join(conversationFolder,"index.html"),"utf8"),html);
  assert.equal(f.calls.length,6,"the fixture uses one planning call and no ordinary HTML visual-review call");
  assert.deepEqual(submitted,[chatPrompt,wholeTurn,filePrompt,filePrompt]);
  assert.notEqual(submissionIds.at(-1),submissionIds.at(-2),"the same request with a fresh budget is a new submission");
  for (const call of f.calls.slice(2,4)) assert.ok(JSON.stringify(call.body.messages).includes(filePrompt));
  await capture("file-task-accepted.png");
  const offline=await browser.newContext({offline:true});
  try {
    const original=await offline.newPage();
    await original.goto(pathToFileURL(join(conversationFolder,"index.html")).href);
    assert.equal(await original.title(),title);
    await original.getByRole("img",{name:figureLabel,exact:true}).waitFor();
  } finally { await offline.close(); }
  assert.deepEqual(errors, []);
});
