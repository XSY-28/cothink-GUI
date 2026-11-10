import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
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

test("a Team file request uses its own folder without a setup or network-choice step", { timeout: 30000 }, async t => {
  const reply = Promise.withResolvers();
  const plan = { goal:"Verify the proposal display", scope:["__init__.py"], deliverables:["__init__.py"],
    checks:[{command:"node",args:["-e","process.exit(0)"]}] };
  const f = await fixture(t, (_,n) => n === 1 ? reply.promise :
    {toolCalls:[{name:"start_work",args:{action:"start",reason:"fixture",plan}}]});
  t.after(() => reply.resolve({ text: "已回答普通问题。" }));
  saveConfig(f.home, createTeamConfig({ formatVersion: 2, ...f.models, work:{execution} }, "文件任务验证阵容", "7c8094cd-3476-4bfa-8f53-055d87972896"));
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
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/action") return;
    const payload = request.postDataJSON();
    if (payload?.action === "task.submit") submitted.push(payload.args.input);
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
  assert.deepEqual(errors, []);
});
