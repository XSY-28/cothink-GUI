import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { fixture } from "./helpers/pi-fixture.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { chooseRailCreation } from "./helpers/gui-rail.js";
import { createTeamConfig, load, saveConfig, startGuiServer } from "./gui-navigation.fixture.js";

for (const [scenario, title] of [
  ["blank","first Team guides an empty installation to its first reply with one key"],
  ["reuse","first Team repairs the credentials of a saved roster and keeps the home draft"],
  ["conflict","first Team preserves a competing default and can still send with its chosen roster"],
  ["rejected","first Team keeps the first rejected question and offers model settings without resending"],
]) test(
  title,
  async t => {
    const f=await fixture(t,()=>scenario==="rejected" ? {error:401} : {text:"这是一条已收到的本机回复。"});
    const conflict=scenario==="conflict";
    const reuseRoster=conflict || scenario==="reuse";
    const rosterId="7c8094cd-3476-4bfa-8f53-055d87972896";
    const otherId="e556f66a-fe82-4e0b-94c1-38f76283371e";
    if(reuseRoster){
      const config=createTeamConfig({formatVersion:2,main:f.models.main,secondary:[f.models.secondary[0]]},"已有阵容",rosterId);
      if(conflict)config.teams.push({id:otherId,name:"另一个窗口的阵容",main:f.models.secondary[0],secondary:[f.models.main]});
      saveConfig(f.home,config);
    }
    const catalogPath=join(f.home,"pi","models.json");
    const catalog=JSON.parse(readFileSync(catalogPath,"utf8"));
    delete catalog.providers.fixture.apiKey;
    writeFileSync(catalogPath,JSON.stringify(catalog));
    const {createGuiController}=await load("src/gui-controller.js");
    const controller=await createGuiController({home:f.home,suggestedProject:null});
    const host=await startGuiServer({controller,open:false});t.after(()=>host.close());
    const folder=mkdtempSync(join(tmpdir(),"cothink-onboarding-"));
    t.after(()=>rmSync(folder,{recursive:true,force:true}));
    const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
    const page=await browser.newPage(scenario==="reuse" ? {viewport:{width:390,height:760}} : {});
    page.setDefaultTimeout(5000);
    await page.goto(host.url);
    const editor=page.getByLabel("输入问题",{exact:true});
    const draft="这句话来自首页草稿。";
    if(scenario==="reuse"){
      await editor.fill(draft);
      await page.getByRole("button",{name:"发送",exact:true}).click();
    } else await page.getByRole("button",{name:"创建我的第一个 Team",exact:true}).click();
    const project=page.getByRole("dialog",{name:"新建 Team",exact:true});
    assert.equal(await project.getByLabel("默认阵容").count(),0);
    await project.getByText("手动输入路径",{exact:true}).click();
    await project.getByLabel("项目绝对路径",{exact:true}).fill(folder);
    await project.getByRole("button",{name:"只读检查目录",exact:true}).click();
    await project.getByRole("button",{name:"创建",exact:true}).click();

    const panel=page.getByRole("dialog",{name:"配置阵容",exact:true});
    if(scenario==="rejected"){
      await panel.getByRole("button",{name:"打开模型与认证设置",exact:true}).click();
      const settings=page.getByRole("dialog",{name:"设置",exact:true});
      await settings.getByRole("button",{name:"关闭设置",exact:true}).click();
    }
    if(reuseRoster)await panel.getByRole("button",{name:"选择 已有阵容",exact:true}).click();
    else {
      await panel.getByLabel("主模型",{exact:true}).selectOption('["fixture","main"]');
      await panel.getByLabel("副模型 1",{exact:true}).selectOption('["fixture","r1"]');
    }
    const start=panel.getByRole("button",{name:"开始对话",exact:true});
    const key=panel.getByLabel("fixture API key",{exact:true});
    assert.equal(await key.count(),1);
    assert.equal(await start.isEnabled(),false);
    await key.fill("local-onboarding-key");
    await panel.getByRole("button",{name:"保存 fixture 认证",exact:true}).click();
    if(conflict)await page.route("**/api/action",async route=>{
      const body=route.request().postDataJSON();
      if(body?.action==="workspace.update")await controller.action(body.action,{
        ...body.args,change:{defaultRosterId:otherId},
      });
      await route.continue();
    });
    let lostBinding=0;
    if(scenario==="reuse")await page.route("**/api/action",async route=>{
      if(route.request().postDataJSON()?.action!=="session.team")return route.continue();
      const receipt=await route.fetch();
      assert.equal(receipt.status(),200);
      ++lostBinding;
      await route.abort();
    });
    await start.click();
    if(conflict){
      await panel.getByText("当前对话已可用。此 Team 已有另一个默认阵容，已保留。",{exact:true}).waitFor();
      assert.equal(await panel.getByRole("button",{name:"重新保存默认阵容",exact:true}).count(),0);
      await panel.getByRole("button",{name:"返回对话",exact:true}).click();
    }
    await panel.waitFor({state:"hidden"});
    await page.waitForFunction(()=>document.activeElement?.id==="message-input");

    const {workspaces,teams}=await controller.bootstrap();
    assert.equal(workspaces.length,1);
    assert.equal(teams.length,conflict ? 2 : 1);
    const [workspace]=workspaces;
    const roster=reuseRoster ? teams.find(row=>row.id===rosterId) : teams[0];
    const {items}=await controller.sessions({workspaceId:workspace.id});
    assert.equal(items.length,1);
    const [room]=items;
    assert.equal(workspace.defaultRosterId,conflict ? otherId : roster.id);
    assert.equal((await controller.session(room.id)).team.id,roster.id);
    assert.equal(f.calls.length,0);
    if(scenario==="reuse"){
      assert.equal(lostBinding,1);
      assert.equal(await editor.inputValue(),draft);
      return;
    }
    await editor.fill("请回复一句问候。");
    await page.getByRole("button",{name:"发送",exact:true}).click();
    if(scenario==="rejected"){
      await page.getByText("请回复一句问候。",{exact:true}).waitFor();
      await page.getByText("fixture / main",{exact:true}).waitFor();
      await page.getByRole("button",{name:"检查模型与认证",exact:true}).click();
      await page.getByRole("dialog",{name:"设置",exact:true}).getByText("已有认证直接复用。",{exact:false}).waitFor();
      assert.equal(f.calls.length,1);
      return;
    }
    await page.getByText("这是一条已收到的本机回复。",{exact:true}).waitFor();
    assert.equal(f.calls.length,1);
    assert.equal(f.calls[0].body.model,"main");
    const next=await controller.action("session.create",{sessionId:crypto.randomUUID(),workspaceId:workspace.id});
    assert.equal(next.team.id,conflict ? otherId : roster.id);
  }
);

test("first Team recovers a lost create response with the complete home draft and never sends it", async t => {
  const f=await fixture(t);
  saveConfig(f.home,createTeamConfig({formatVersion:2,...f.models},"UI fixture","7c8094cd-3476-4bfa-8f53-055d87972896"));
  const {createGuiController}=await load("src/gui-controller.js");
  const controller=await createGuiController({home:f.home,suggestedProject:null});
  const host=await startGuiServer({controller,open:false}); t.after(()=>host.close());
  const folder=mkdtempSync(join(tmpdir(),"cothink-first-team-"));
  t.after(()=>rmSync(folder,{recursive:true,force:true}));
  const browser=await chromium.launch({headless:true}); t.after(()=>browser.close());
  const page=await browser.newPage();
  page.setDefaultTimeout(5000);
  const text="核对首页附件，先不发送。";
  await page.goto(host.url);
  const editor=page.getByLabel("输入问题",{exact:true});
  await editor.fill(text);
  const draft=await (async()=>{
    for(let i=0;i<30;i++){
      const row=(await controller.bootstrap()).homeDraft;
      if(row?.editor.text===text)return row;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert.fail("The home editor did not save");
  })();
  const turnOptions={id:crypto.randomUUID(),readOnly:true,delegate:false,maxCalls:"2"};
  const chosen=await controller.action("home.draft",{draftId:draft.draftId,expectedRevision:draft.revision,
    editor:{...draft.editor,editId:crypto.randomUUID(),turnOptions}});
  await page.reload();
  await page.waitForFunction(expected=>document.querySelector("textarea")?.value===expected,text);
  await chooseRailCreation(page,"新建 Team");
  const dialog=page.getByRole("dialog",{name:"新建 Team",exact:true});
  await dialog.getByLabel("名称",{exact:true}).fill("首次草稿交接");
  await dialog.getByText("手动输入路径",{exact:true}).click();
  await dialog.getByLabel("项目绝对路径",{exact:true}).fill(folder);
  await dialog.getByRole("button",{name:"只读检查目录",exact:true}).click();
  let lost=0;
  await page.route("**/api/action",async route=>{
    if (route.request().postDataJSON()?.action!=="session.create") return route.continue();
    const saved=await route.fetch();
    assert.equal(saved.status(),200);
    ++lost;
    await route.abort();
  });
  await dialog.getByRole("button",{name:"创建",exact:true}).click();
  await dialog.waitFor({state:"hidden"});
  assert.equal(lost,1);
  const unsettled=await controller.bootstrap();
  assert.equal(unsettled.homeDraft.editor.editId,chosen.editor.editId);
  assert.equal(f.calls.length,0);
  await page.reload();
  assert.equal(await page.getByRole("dialog").count(),0);
  await page.getByRole("button",{name:"查询原会话",exact:true}).click();
  await page.getByRole("button",{name:"查询原会话",exact:true}).waitFor({state:"hidden"});
  const state=await controller.bootstrap();
  const workspace=state.workspaces.find(row=>row.name==="首次草稿交接");
  const {items:[room]}=await controller.sessions({workspaceId:workspace.id});
  assert.equal(room?.id,unsettled.homeDraft.pendingCreateSessionId);
  assert.equal(lost,1);
  const opened=await controller.session(room.id);
  assert.equal(opened.team,null);
  assert.equal(await page.getByRole("button",{name:"发送",exact:true}).isEnabled(),false);
  await page.getByRole("button",{name:"选择阵容",exact:true}).click();
  const selected=page.waitForResponse(response=>response.ok()&&response.url().endsWith("/api/action")&&
    response.request().postDataJSON()?.action==="session.team");
  await page.getByRole("dialog",{name:"阵容",exact:true}).getByRole("button",{name:"使用 UI fixture",exact:true}).click();
  await selected;
  assert.equal((await controller.session(room.id)).team?.name,"UI fixture");
  assert.deepEqual(opened.editor,chosen.editor);
  assert.equal(await editor.inputValue(),text);
  assert.equal(state.homeDraft,null);
  assert.equal(f.calls.length,0);
});
