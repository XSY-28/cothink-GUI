import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { fixture } from "./helpers/pi-fixture.js";
import { mkdtempSync, rmSync } from "node:fs";
import { chooseRailCreation } from "./helpers/gui-rail.js";
import { createTeamConfig, load, saveConfig, startGuiServer } from "./gui-navigation.fixture.js";

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
