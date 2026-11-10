import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { fixture } from "./helpers/pi-fixture.js";
import { git, repository } from "./helpers/git-fixture.js";
import { chooseRailCreation } from "./helpers/gui-rail.js";
import { pathToFileURL, fileURLToPath } from "node:url";
const packageRoot=resolve(process.env.COTHINK_TEST_PACKAGE_ROOT??fileURLToPath(new URL("..",import.meta.url)));
const load=path=>import(pathToFileURL(join(packageRoot,path)));
const {saveConfig}=await load("src/config.js");
const {createTeamConfig}=await load("src/teams.js");
const {startGuiServer}=await load("src/gui-server.js");

const materialPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAFElEQVR42mNklAtgYGBgYmBgQFAACEIAdYij2wsAAAAASUVORK5CYII=", "base64");
async function usabilityPage(t,host,width,height) {
  const browser=await chromium.launch({headless:true});
  t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width,height}});
  page.setDefaultTimeout(10000);
  const errors=[];
  page.on("pageerror",error=>errors.push(error.message));
  await page.goto(host.url);
  await page.getByLabel("输入问题").waitFor();
  return {page,errors};
}

async function saveTeam(page, name, path, rosterId) {
  const create=page.getByRole("dialog",{name:"新建 Team",exact:true});
  await create.getByLabel("名称",{exact:true}).fill(name);
  await create.getByText("手动输入路径",{exact:true}).click();
  await create.getByLabel("项目绝对路径").fill(path);
  await create.getByRole("button",{name:"只读检查目录",exact:true}).click();
  await create.getByText("可以使用这个文件夹。",{exact:true}).waitFor();
  await create.getByLabel("默认阵容").selectOption(rosterId);
  const child=page.waitForResponse(response=>response.ok()&&new URL(response.url()).pathname==="/api/action"&&response.request().method()==="POST"&&
    response.request().postDataJSON()?.action==="session.create");
  await create.getByRole("button",{name:"创建",exact:true}).click();
  await create.waitFor({state:"hidden"});
  return (await child).json();
}

test("desktop browser imports, previews and sends materials while keeping menus and local commands separate",async t=>{
  let imageId;
  const f=await fixture(t,(_,n)=>n>1?{text:"已使用选择的技能"}:{text:`材料夹具完成。 ![会话内图片](material:${imageId}) ![外部图片](https://images.example.test/sample.png)\n\n\`\`\`txt\ncopy sample\n\`\`\``});
  const modelPath=join(f.home,"pi","models.json"),catalog=JSON.parse(readFileSync(modelPath,"utf8"));
  for(const model of catalog.providers.fixture.models)model.input=["text","image"];
  writeFileSync(modelPath,JSON.stringify(catalog));
  saveConfig(f.home,createTeamConfig({formatVersion:2,...f.models},"材料验证阵容","7c8094cd-3476-4bfa-8f53-055d87972896"));
  let host=await startGuiServer({home:f.home,cwd:f.cwd,open:false});t.after(()=>host.close());
  const {page,errors}=await usabilityPage(t,host,1280,880);
  const button=name=>page.getByRole("button",{name,exact:true}),editor=page.getByLabel("输入问题");
  const send=button("发送"),add=button("添加本次操作");
  const importSettled=()=>page.waitForFunction(()=>document.querySelector('.composer button[aria-label="发送"]')?.disabled===false);
  const limits=page.getByRole("dialog",{name:"下一条消息的限制",exact:true});
  assert.equal(await button("本次选项").count(),0,"the input area has no permanent limits button");
  const homeMenu=button("对话操作：首页草稿");
  await homeMenu.click();
  await button("下一条消息的限制").click();
  const firstSave=page.waitForResponse(response=>new URL(response.url()).pathname==="/api/action"&&response.request().postDataJSON()?.action==="home.draft");
  await limits.getByLabel("只分析，不修改").check();
  assert.equal((await firstSave).ok(),true);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const maxCalls=limits.getByLabel("本轮最多模型请求（留空不设上限）");
  assert.equal(await maxCalls.isVisible(),true,"saving the first home draft keeps its limit editor open");
  await maxCalls.fill("2");
  await page.keyboard.press("Escape");
  assert.equal(await homeMenu.evaluate(node=>node===document.activeElement),true);
  await button("修改最多 2 次请求").click();
  assert.equal(await limits.getByLabel("只分析，不修改").isChecked(),true);
  await maxCalls.fill("1");
  await page.keyboard.press("Escape");
  assert.equal(await button("修改最多 1 次请求").evaluate(node=>node===document.activeElement),true);
  await button("移除最多 1 次请求标记").click();
  assert.equal(await editor.evaluate(node=>node===document.activeElement),true);
  assert.equal(await button("修改最多 1 次请求").count(),0);
  await button("修改只分析").waitFor();
  for(const [command,dialog] of [["/settings","设置"],["/team","阵容"],["/help","CoThink 帮助"]]){
    await editor.fill(command);await editor.press("Enter");
    await page.getByRole("dialog",{name:dialog,exact:true}).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog",{name:dialog,exact:true}).waitFor({state:"hidden"});
  }
  assert.equal(f.calls.length,0);
  await add.click();
  await button("添加文件或图片").waitFor();
  assert.equal(await page.getByText("只分析，不修改",{exact:true}).count(),0);
  assert.equal(await button("插件命令").count(),0);
  await editor.click();
  assert.equal(await add.getAttribute("aria-expanded"),"false");
  await add.click();
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(()=>document.activeElement.textContent),"添加文件或图片");
  await page.keyboard.press("Escape");
  assert.equal(await add.getAttribute("aria-expanded"),"false");
  assert.equal(await page.evaluate(()=>document.activeElement.getAttribute("aria-label")),"添加本次操作");

  const team="材料验证 Team",draft="这段首页草稿进入 Team 后仍可编辑";
  await editor.fill(draft);
  await send.click();
  const session=await saveTeam(page,team,repository(t).project,"7c8094cd-3476-4bfa-8f53-055d87972896");
  assert.equal(await editor.inputValue(),draft);
  assert.equal(f.calls.length,0,"creating the Team only carries the draft, never sends it");
  await editor.fill("");
  await page.getByRole("button",{name:/^对话操作：/}).click();
  await button("下一条消息的限制").click();
  await limits.getByLabel("只分析，不修改").check();
  await page.keyboard.press("Escape");

  const releaseUpload=Promise.withResolvers();
  let held=false;
  await page.route("**/api/materials?**",async route=>{
    if(route.request().method()==="POST"&&!held){held=true;await releaseUpload.promise;}
    await route.continue();
  });
  t.after(()=>releaseUpload.resolve());
  await add.click();
  const chooser=page.waitForEvent("filechooser");
  await button("添加文件或图片").click();
  const uploadStarted=page.waitForRequest(request=>new URL(request.url()).pathname==="/api/materials"&&request.method()==="POST");
  await (await chooser).setFiles([{name:"same.txt",mimeType:"text/plain",buffer:Buffer.from("selected text")},
    {name:"same.txt",mimeType:"text/plain",buffer:Buffer.from("drop text")}]);
  const rows=page.getByRole("list",{name:"本次材料"});
  try {
    await uploadStarted;
    await editor.fill("上传期间仍能输入");
    assert.equal(await send.isDisabled(),true);
    assert.equal(await editor.inputValue(),"上传期间仍能输入");
    await editor.fill("");
  } finally {releaseUpload.resolve();}
  await page.waitForFunction(()=>Array.from(document.querySelectorAll(".composer-materials li")).filter(node=>node.textContent.includes("已就绪")).length===2);
  assert.equal(await rows.getByText("same.txt",{exact:true}).count(),2);
  await rows.getByRole("button",{name:"预览 same.txt",exact:true}).first().click();
  await page.getByText("selected text",{exact:true}).waitFor();
  await page.keyboard.press("Escape");
  await rows.getByRole("button",{name:"移除 same.txt",exact:true}).first().click();
  await rows.getByRole("button",{name:"预览 same.txt",exact:true}).click();
  await page.getByText("drop text",{exact:true}).waitFor();
  await page.keyboard.press("Escape");

  await editor.evaluate((node,bytes)=>{
    const clipboardData=new DataTransfer();
    clipboardData.items.add(new File([new Uint8Array(bytes)],"pasted.png",{type:"image/png"}));
    node.dispatchEvent(new ClipboardEvent("paste",{clipboardData,bubbles:true,cancelable:true}));
  },[...materialPng]);
  await rows.getByRole("button",{name:"预览 pasted.png",exact:true}).waitFor();
  await importSettled();
  await editor.evaluate(node=>{
    const dataTransfer=new DataTransfer();
    dataTransfer.items.add(new File(['{"fixture":"dropped text"}'],"drop.json",{type:"application/json"}));
    node.dispatchEvent(new DragEvent("drop",{dataTransfer,bubbles:true,cancelable:true}));
  });
  await rows.getByRole("button",{name:"预览 drop.json",exact:true}).waitFor();
  await importSettled();

  await page.unroute("**/api/materials?**");
  let lostUploads=0;
  await page.route("**/api/materials?**",async route=>{
    if(route.request().method()!=="POST")return route.continue();
    lostUploads++;
    const uploaded=await route.fetch();
    assert.equal(uploaded.status(),200);
    await route.abort("failed");
  });
  await page.locator(".composer input[type=file]").setInputFiles({
    name:"unknown.txt",mimeType:"text/plain",buffer:Buffer.from("receipt was lost"),
  });
  const unknown=rows.getByRole("listitem").filter({hasText:"unknown.txt"});
  await unknown.getByRole("button",{name:"查询",exact:true}).waitFor();
  assert.equal(await send.isDisabled(),true);
  const previousOrigin=host.origin;
  await host.close();
  host=await startGuiServer({home:f.home,cwd:f.cwd,open:false});
  assert.notEqual(host.origin,previousOrigin);
  await page.goto(host.url);
  await page.getByRole("navigation",{name:"工作导航"}).getByRole("button",{name:team,exact:true}).click();
  await unknown.getByRole("button",{name:"查询",exact:true}).waitFor();
  assert.equal(await send.isDisabled(),true);
  await unknown.getByRole("button",{name:"查询",exact:true}).click();
  await unknown.getByRole("button",{name:"预览 unknown.txt",exact:true}).waitFor();
  assert.equal(lostUploads,1,"query the original upload without resending bytes");
  await unknown.getByRole("button",{name:"移除 unknown.txt",exact:true}).click();
  await unknown.waitFor({state:"detached"});
  await page.unroute("**/api/materials?**");

  await page.locator(".composer input[type=file]").setInputFiles({
    name:"broken.png",mimeType:"image/png",buffer:Buffer.from("not a PNG"),
  });
  const failed=rows.getByRole("listitem").filter({hasText:"broken.png"});
  await failed.getByText(/导入失败|等待核对/).waitFor();
  assert.equal(await send.isDisabled(),true);
  await failed.getByRole("button",{name:"移除 broken.png",exact:true}).click();
  await failed.waitFor({state:"detached"});

  await add.click();
  await button("使用技能").click();
  const skills=page.getByRole("dialog",{name:"使用技能",exact:true});
  await skills.getByLabel("搜索技能").fill("doc-maintenance");
  await skills.getByRole("button",{name:/doc-maintenance/}).click();
  await button("移除技能：doc-maintenance标记").waitFor();
  await button("移除技能：doc-maintenance标记").click();

  // The fixture reply references the actual immutable image ID from this conversation's draft.
  const response=await fetch(host.origin+"/api/session?id="+session.id,{headers:{Authorization:"Bearer "+host.token}});
  assert.equal(response.status,200);
  const saved=await response.json();
  assert.equal(saved.editor.materials.length,3);
  imageId=saved.materials.find(item=>item.name==="pasted.png")?.id;
  assert.ok(imageId);
  assert.equal(await editor.inputValue(),"");
  await page.screenshot({path:resolve("work/gui-usability-repair/T3-desktop-materials.png")});
  let network=0;
  await page.route("https://images.example.test/sample.png",async route=>{
    network++;
    assert.equal(route.request().headers().referer,undefined);
    await route.fulfill({status:200,contentType:"image/png",body:materialPng});
  });
  const submission=page.waitForRequest(request=>request.method()==="POST"&&new URL(request.url()).pathname==="/api/action"&&request.postDataJSON()?.action==="task.submit");
  await send.click();
  const {args: submitted}= (await submission).postDataJSON();
  assert.equal(submitted.sessionId,session.id);
  assert.equal(submitted.constraints.readOnly,true);
  assert.equal(submitted.budget.maxCalls,null);
  try {await page.getByText(/材料夹具完成/).waitFor();}
  catch(error){console.error("材料浏览器夹具发送后：",await page.locator("main").innerText(),"fixture calls",f.calls.length);throw error;}
  const trusted=page.getByRole("img",{name:"会话内图片"});
  await trusted.waitFor();
  assert.match(await trusted.getAttribute("src"),/^blob:/);
  assert.equal(network,0);
  await button("加载图片").click();
  await page.getByRole("img",{name:"外部图片"}).waitFor();
  await page.waitForFunction(()=>document.querySelector('img[alt="外部图片"]').complete&&document.querySelector('img[alt="外部图片"]').naturalWidth>0);
  assert.equal(network,1);
  assert.equal(f.calls.length,1);
  await page.context().grantPermissions(["clipboard-read","clipboard-write"]);
  await button("复制代码").click();
  assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),"copy sample\n");
  await button("修改只分析").waitFor({state:"detached"});
  await page.getByRole("button",{name:/^对话操作：/}).click();
  await button("下一条消息的限制").click();
  assert.equal(await limits.getByLabel("只分析，不修改").isChecked(),false);
  await limits.getByLabel("禁止派工").check();
  await page.keyboard.press("Escape");
  await button("修改禁止派工").waitFor();
  await page.getByRole("button",{name:/^对话操作：/}).click();
  await button("整理上下文…").click();
  await page.getByRole("dialog",{name:"整理上下文",exact:true}).getByText(/最多 2 次/).waitFor();
  await page.keyboard.press("Escape");
  assert.equal(f.calls.length,1,"opening or dismissing organize never dispatches");
  assert.match(JSON.stringify(f.calls[0].body),/drop text|dropped text/);
  assert.match(JSON.stringify(f.calls[0].body),/image_url/);
  assert.deepEqual(errors,[]);
  await page.screenshot({path:resolve("work/gui-usability-repair/T3-desktop-browser.png")});

  await editor.fill("查看文档检查的用途");
  await add.click();
  await button("使用技能").click();
  await skills.getByLabel("搜索技能").fill("doc-maintenance");
  await skills.getByRole("button",{name:/doc-maintenance/}).click();
  await button("移除技能：doc-maintenance标记").waitFor();
  assert.equal(await editor.inputValue(),"/skill:doc-maintenance 查看文档检查的用途");
  const followupSubmission=page.waitForRequest(request=>request.method()==="POST"&&new URL(request.url()).pathname==="/api/action"&&request.postDataJSON()?.action==="task.submit");
  await send.click();
  assert.deepEqual((await followupSubmission).postDataJSON().args.constraints.allowedSubtasks,[]);
  await page.getByText("已使用选择的技能",{exact:true}).waitFor();
  await button("修改禁止派工").waitFor({state:"detached"});
  assert.equal(f.calls.length,2);
  assert.match(JSON.stringify(f.calls[1].body.messages),/doc-maintenance/);
  assert.ok(f.calls[1].body.tools.some(tool=>tool.function.name==="read_skill"));
});

test("compact browser chooses current project bytes and a pinned saved range; navigation shows true history",async t=>{
  const fixedName="guide,notes.txt";
  const f=await fixture(t,(_,n)=>n===1?{toolCalls:[{name:"read_project_context",args:{operation:"read",paths:[fixedName]}}]}:{text:"已按实际材料完成"}),repo=repository(t);
  saveConfig(f.home,createTeamConfig({formatVersion:2,...f.models},"文件阵容","7c8094cd-3476-4bfa-8f53-055d87972896"));
  const host=await startGuiServer({home:f.home,cwd:f.cwd,open:false});t.after(()=>host.close());
  const {page,errors}=await usabilityPage(t,host,800,600);
  const button=name=>page.getByRole("button",{name,exact:true}),editor=page.getByLabel("输入问题");
  await button("切换导航").click();
  await chooseRailCreation(page, "新建 Team");
  const team="固定材料的中文长团队名字——需要在紧凑窗口仍可操作";
  const session=await saveTeam(page,team,repo.project,"7c8094cd-3476-4bfa-8f53-055d87972896");
  const child=session.project;
  assert.equal(child,join(realpathSync(repo.project),"对话-"+session.id));
  git(child,"init","-b","main");
  writeFileSync(join(child,fixedName),"base comma fixture\n");
  git(child,"status","--porcelain");
  git(child,"add","--",fixedName);
  git(child,"commit","-m","saved file with literal comma");
  const fixedVersion=git(child,"rev-parse","HEAD");
  writeFileSync(join(child,"a.txt"),"uncommitted A fixture\n");
  await editor.fill("第一段用户摘要，足以区别相同标题");
  await button("添加本次操作").click();
  await button("选择项目文件").click();
  const picker=page.getByRole("dialog",{name:"选择项目文件",exact:true});
  const row=()=>picker.getByRole("listitem").filter({hasText:"a.txt"});
  await row().getByRole("button",{name:"预览",exact:true}).click();
  await picker.getByText("uncommitted A fixture",{exact:false}).waitFor();
  await picker.getByRole("button",{name:"选择预览中的文件",exact:true}).click();
  await picker.getByRole("button",{name:"导入所选副本",exact:true}).click();
  await picker.waitFor({state:"hidden"});
  await button("预览 a.txt").waitFor();
  await button("添加本次操作").click();await button("选择项目文件").click();
  await picker.getByRole("button",{name:"读取已保存版本",exact:true}).click();
  await picker.getByText(fixedVersion.slice(0,12),{exact:true}).waitFor();
  await page.screenshot({path:resolve("work/gui-usability-repair/T3-compact-project-picker.png")});
  await picker.getByRole("listitem").filter({hasText:fixedName}).getByRole("button",{name:"选择范围",exact:true}).click();
  await picker.getByRole("button",{name:"确认读取范围",exact:true}).click();
  await picker.waitFor({state:"hidden"});
  await button(`移除读取已保存版本：${fixedName}标记`).waitFor();
  await button("发送").click();
  await page.getByText("已按实际材料完成",{exact:true}).waitFor();
  const first=JSON.stringify(f.calls[0].body);
  assert.match(first,/uncommitted A fixture/);
  assert.equal(f.calls.length,2);
  assert.match(JSON.stringify(f.calls[1].body),/base comma fixture/);
  await button("对话").click();
  const histories=page.getByRole("dialog",{name:"对话",exact:true});
  await histories.getByText("第一段用户摘要，足以区别相同标题",{exact:true}).first().waitFor();
  const dateTime=await histories.locator("time").first().getAttribute("datetime");
  assert.ok(Number.isFinite(Date.parse(dateTime)));
  await page.keyboard.press("Escape");
  await button("切换导航").click();
  const directCreation=page.waitForResponse(response=>response.ok()&&new URL(response.url()).pathname==="/api/action"&&response.request().method()==="POST"&&
    response.request().postDataJSON()?.action==="session.create");
  await chooseRailCreation(page, "新对话");
  const next=await (await directCreation).json();
  assert.equal(next.workspaceId,session.workspaceId);
  assert.equal(next.project,join(realpathSync(repo.project),"对话-"+next.id));
  assert.notEqual(next.project,child);
  await page.getByText("这次想完成什么？",{exact:true}).waitFor();
  assert.equal(await page.getByRole("dialog",{name:"新对话",exact:true}).count(),0);
  assert.equal(f.calls.length,2,"new conversation makes no model call");
  assert.deepEqual(errors,[]);
});
