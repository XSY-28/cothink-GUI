import test from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { fixture } from "./helpers/pi-fixture.js";
import { pathToFileURL, fileURLToPath } from "node:url";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
const packageRoot=resolve(process.env.COTHINK_TEST_PACKAGE_ROOT??fileURLToPath(new URL("..",import.meta.url)));
const load=path=>import(pathToFileURL(join(packageRoot,path)));
const {saveConfig}=await load("src/config.js");
const {createTeamConfig}=await load("src/teams.js");
const {startGuiServer}=await load("src/gui-server.js");

test("Team avatars use 巴巴祖 artwork when present and preserve navigation with placeholders", async t=>{
  const f=await fixture(t);
  const rosterId="7c8094cd-3476-4bfa-8f53-055d87972896";
  saveConfig(f.home,createTeamConfig({formatVersion:2,...f.models},"Avatar fixture",rosterId));
  const {createGuiController}=await load("src/gui-controller.js");
  const {SessionManager}=await load("node_modules/@earendil-works/pi-coding-agent/dist/index.js");
  const {createTask}=await load("src/task.js");
  const controller=await createGuiController({home:f.home,suggestedProject:null});
  const defaultAvatar="barbidou";
  const artworkDir=join(packageRoot,"gui/src/assets/team-avatars/assets",defaultAvatar);
  const artworkFiles=["sidebar-foreground.png","sidebar-motion-atlas.png","chat-static.png"];
  const hasArtwork=artworkFiles.every(file=>existsSync(join(artworkDir,file)));
  assert.ok(hasArtwork || artworkFiles.every(file=>!existsSync(join(artworkDir,file))),
    "the local 巴巴祖 artwork must be installed as a complete set");
  const teams=[
    {id:"7c8094cd-3476-4bfa-8f53-000000000001",name:"花园讨论",reply:"这份答复来自花园讨论 Team。"},
    {id:"7c8094cd-3476-4bfa-8f53-000000000002",name:"蓝色工具箱",reply:"这份答复来自蓝色工具箱 Team。"}
  ];
  const ordinary=join(f.cwd,"unprepared");
  mkdirSync(ordinary);
  for(const item of teams){
    const workspace=await controller.action("workspace.create",{workspaceId:item.id,name:item.name,
      project:item===teams[0]?ordinary:null,defaultRosterId:rosterId});
    item.project=workspace.project;
  }
  const h=await startGuiServer({controller,open:false});t.after(()=>h.close());
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1280,height:800}});
  const errors=[];
  page.on("pageerror",e=>errors.push(e.message));
  page.on("console",m=>{if(m.type()==="error")errors.push(m.text());});
  await page.goto(h.url);
  const nav=page.getByRole("navigation",{name:"工作导航"});
  const [a,b]=teams.map(item=>nav.getByRole("button",{name:item.name,exact:true}));
  await a.waitFor();
  assert.equal(await nav.getByText(teams[0].name,{exact:true}).isVisible(),false,"the Team name must be hidden before hover");
  for(const item of [...teams,{id:null,name:"未分组记录",reply:"这份答复不属于项目 Team。"}]){
    const manager=SessionManager.create(f.cwd,join(f.home,"pi/sessions/main"));
    manager.appendCustomEntry("cothink-project",{project:item.project??null});
    manager.appendCustomEntry("cothink-gui-workspace",{workspaceId:item.id});
    manager.appendCustomEntry("cothink-title",{title:item.name+" · 已保存答复"});
    const task=createTask({home:f.home,input:"头像历史标记 "+item.name,models:f.models,sessionId:manager.getSessionId(),singleModel:true});
    const request={id:crypto.randomUUID(),taskId:task.record.id,status:"completed",sent:false,events:[],text:item.reply};
    task.register(request);task.writeRequest(request);task.record.finalCallId=request.id;task.finish("completed");
    manager.appendCustomEntry("cothink-task",{taskId:task.record.id});
    manager.appendMessage({role:"user",content:task.record.input,timestamp:Date.now()});
    manager.appendMessage({role:"assistant",content:[{type:"text",text:request.text}],api:"openai-completions",provider:"fixture",model:"main",usage:{input:0,output:0,totalTokens:0,cost:{input:0,output:0,total:0}},stopReason:"stop",timestamp:Date.now()});
    const saved=await controller.session(manager.getSessionId());
    assert.equal(saved.workspaceId,item.id);
    if(item===teams[0]) assert.equal(saved.projectStatus?.executionReady,false);
  }
  const open=async name=>{
    await nav.getByRole("button",{name:"搜索",exact:true}).click();
    const search=page.getByRole("dialog",{name:"搜索",exact:true});
    await search.getByPlaceholder("搜索名称、对话或文件…").fill("头像历史标记 "+name);
    await search.getByRole("button",{name:name+" · 已保存答复",exact:true}).click();
    await search.waitFor({state:"hidden"});
  };
  await open(teams[0].name);
  await page.getByText(teams[0].reply,{exact:true}).waitFor();
  assert.equal(await page.getByText(/文件工作需要准备/).count(),0);
  await page.getByRole("button",{name:"对话操作："+teams[0].name+" · 已保存答复",exact:true}).click();
  await page.getByRole("dialog",{name:"对话操作"}).getByRole("button",{name:"准备文件工作"}).click();
  const preparation=page.getByRole("dialog",{name:"准备文件工作"});
  await preparation.getByText(teams[0].project,{exact:true}).waitFor();
  await page.keyboard.press("Escape");
  await preparation.waitFor({state:"hidden"});
  const footer=page.locator("article > footer");
  const action=name=>footer.getByRole("button",{name,exact:true});
  const hint=name=>footer.locator('[role="tooltip"]').filter({hasText:name});
  for(const name of ["查看过程","复制原文","从这里分支"]){
    const button=action(name), tooltip=hint(name);
    await button.locator("svg").waitFor();
    assert.equal(await button.textContent(),"");
    await tooltip.waitFor({state:"hidden"});
    await button.locator("..").hover();
    await tooltip.waitFor();
    await page.mouse.move(450,5);
    await tooltip.waitFor({state:"hidden"});
  }
  await action("查看过程").focus();
  await page.keyboard.press("Tab");
  await hint("复制原文").waitFor();
  const chat=page.locator("article > header [data-team-avatar]");
  async function checkPlaceholder(portrait) {
    await portrait.locator(":scope > span").waitFor();
    assert.equal(await portrait.locator("img, canvas").count(),0,
      "the placeholder replaces missing artwork");
  }
  async function checkReplyAvatar() {
    await chat.waitFor();
    assert.equal(await chat.getAttribute("data-team-avatar"),defaultAvatar);
    if (!hasArtwork) {
      await checkPlaceholder(chat);
      return null;
    }
    const url=await chat.locator("img").evaluate(async img=>{await img.decode();return img.currentSrc;});
    const response=await page.request.get(url);
    assert.equal(response.headers()["content-type"],"image/png");
    assert.deepEqual(await response.body(),readFileSync(join(artworkDir,"chat-static.png")));
    return url;
  }
  async function checkSidebarAvatar(trigger) {
    const portrait=trigger.locator("[data-team-avatar]");
    await portrait.waitFor();
    assert.equal(await portrait.getAttribute("data-team-avatar"),defaultAvatar);
    if (!hasArtwork) await checkPlaceholder(portrait);
  }
  const chatA=await checkReplyAvatar();
  const chatStill=await chat.screenshot();
  assert.equal(await a.getAttribute("aria-current"),"page");
  assert.equal(await a.getAttribute("title"),null,"the native tooltip must not bypass the hover delay");
  const trigger=a.locator("[data-team-avatar-trigger]");
  const canvas=trigger.locator("canvas");
  await checkSidebarAvatar(trigger);
  let idle;
  if (hasArtwork) {
    await canvas.waitFor();
    await page.waitForFunction(()=>[...document.querySelectorAll("nav canvas")].every(c=>c.getContext("2d").getImageData(128,128,1,1).data[3]>0));
    idle=await canvas.evaluate(c=>c.toDataURL());
  }
  const screenshots=resolve(process.env.COTHINK_UI_SCREENSHOTS||"work/team-avatar/browser");
  mkdirSync(screenshots,{recursive:true});
  await page.screenshot({path:join(screenshots,"avatar-idle.png")});
  await trigger.evaluate(node=>node.addEventListener("pointerenter",()=>{window.avatarHoverStart=performance.now();},{once:true}));
  await trigger.hover();
  const label=nav.getByText(teams[0].name,{exact:true});
  assert.equal(await label.isVisible(),false);
  if (hasArtwork) {
    await page.waitForFunction(idle=>{
      const canvas=document.querySelector('nav button[aria-current="page"] canvas');
      return canvas && canvas.toDataURL()!==idle;
    },idle,{timeout:1500});
    assert.equal(await label.isVisible(),false,"animation should begin while the name is still hidden");
  }
  const earlyLabel=await label.waitFor({timeout:900}).then(()=>true,error=>{
    if(error.name!=="TimeoutError")throw error;
    return false;
  });
  assert.equal(earlyLabel,false,"hovering briefly must not reveal the name");
  await label.waitFor({timeout:3500});
  const hoverTime=await page.evaluate(()=>performance.now()-window.avatarHoverStart);
  assert.ok(hoverTime>=1990 && hoverTime<2850,`Team name appeared after ${hoverTime}ms rather than about 2s`);
  if (hasArtwork) {
    const frame=await canvas.evaluate(c=>c.toDataURL());
    await page.waitForFunction(frame=>document.querySelector('nav button[aria-current="page"] canvas')?.toDataURL()!==frame,frame);
  } else {
    await checkSidebarAvatar(trigger);
  }
  assert.deepEqual(await chat.screenshot(),chatStill,"sidebar hover must not change reply avatar pixels");
  await page.screenshot({path:join(screenshots,"avatar-hover-name.png")});
  await page.mouse.move(450,5);
  await label.waitFor({state:"hidden"});
  if (hasArtwork) assert.equal(await canvas.evaluate(c=>c.toDataURL()),idle,"leaving restores the static foreground");
  await page.emulateMedia({reducedMotion:"reduce"});
  await trigger.hover();
  const triggerB=b.locator("[data-team-avatar-trigger]");
  await checkSidebarAvatar(triggerB);
  const canvasB=triggerB.locator("canvas");
  const idleB=hasArtwork?await canvasB.evaluate(c=>c.toDataURL()):null;
  await triggerB.hover();
  await nav.getByText(teams[1].name,{exact:true}).waitFor({timeout:3500});
  assert.equal(await label.isVisible(),false,"moving to another Team cancels the previous reveal");
  if (hasArtwork) assert.equal(await canvasB.evaluate(c=>c.toDataURL()),idleB,"reduced motion keeps the sidebar still but does not hide the label");
  await open(teams[1].name);
  await page.getByText(teams[1].reply,{exact:true}).waitFor();
  assert.equal(await a.getAttribute("aria-current"),null);
  assert.equal(await b.getAttribute("aria-current"),"page","opening another Team updates selection independently of its avatar");
  assert.equal(await checkReplyAvatar(),chatA,"both Teams use the same default reply avatar");
  await open("未分组记录");
  await page.getByText("这份答复不属于项目 Team。",{exact:true}).waitFor();
  assert.equal(await chat.count(),0,"ungrouped replies must not borrow the preceding Team’s avatar");
  assert.equal(f.calls.length,0);
  assert.deepEqual(errors,[]);
});
