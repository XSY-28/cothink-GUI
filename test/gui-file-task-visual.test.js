import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { chooseRailCreation } from "./helpers/gui-rail.js";
import { fixture } from "./helpers/pi-fixture.js";

const packageRoot = resolve(process.env.COTHINK_TEST_PACKAGE_ROOT ?? fileURLToPath(new URL("..", import.meta.url)));
const load = path => import(pathToFileURL(join(packageRoot, path)));
const { saveConfig } = await load("src/config.js");
const { createTeamConfig } = await load("src/teams.js");
const { startGuiServer } = await load("src/gui-server.js");

test("file requests wait for directory preparation while ordinary chat remains usable", { timeout: 30000 }, async t => {
  const reply = Promise.withResolvers();
  const f = await fixture(t, () => reply.promise);
  t.after(() => reply.resolve({ text: "已回答普通问题。" }));
  saveConfig(f.home, createTeamConfig({ formatVersion: 2, ...f.models }, "文件任务验证阵容", "7c8094cd-3476-4bfa-8f53-055d87972896"));
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
  await create.getByText(/目录可以关联/).waitFor();
  await create.getByRole("button", { name: "创建", exact: true }).click();
  await create.waitFor({ state: "hidden" });

  const filePrompt = "给我生成一个自行车骑鹈鹕的html界面，svg图像，不允许联网";
  await editor.fill(filePrompt);
  assert.equal(await button("发送").isDisabled(), true, "the file request cannot send before directory preparation");
  await page.getByText(/目录尚未准备/).waitFor();
  await page.getByText(project, { exact: true }).waitFor();
  await editor.press("Enter");
  assert.equal(await editor.inputValue(), filePrompt);
  assert.deepEqual(submitted, []);
  assert.equal(f.calls.length, 0);
  await capture("file-task-unprepared.png");

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

  await editor.fill(filePrompt);
  await button("准备文件工作").click();
  const preparation = page.getByRole("dialog", { name: "准备文件工作", exact: true });
  await preparation.getByText(project, { exact: true }).waitFor();
  for (const name of ["盘点文件", "预览起点"]) await preparation.getByRole("button", { name, exact: true }).click();
  assert.equal(existsSync(join(project, ".git")), false);
  await preparation.getByRole("button", { name: "确认建立起点", exact: true }).click();
  await preparation.getByText(/文件工作起点已核对/).waitFor();
  assert.equal(existsSync(join(project, ".git", "HEAD")), true);
  await preparation.getByRole("button", { name: "关闭", exact: true }).click();
  assert.equal(await editor.inputValue(), filePrompt);
  await page.waitForFunction(() => document.querySelector('button[aria-label="发送"]')?.disabled === false);
  assert.deepEqual(submitted, [chatPrompt], "preparing the directory does not send the saved draft");
  assert.equal(f.calls.length, 1);
  assert.deepEqual(errors, []);
  await capture("file-task-ready.png");
});
