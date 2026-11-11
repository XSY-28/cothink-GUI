import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from "node:fs";
import {join,resolve} from "node:path";
import {tmpdir} from "node:os";
import {pathToFileURL} from "node:url";

export async function verifyPackagedThinking(t,{appPath,launchCandidate}) {
 const backend=join(appPath,"Contents/Resources/app/backend");
 const load=path=>import(pathToFileURL(join(backend,path)));
 const project=mkdtempSync(join(tmpdir(),"cothink-packaged-thinking-"));
 t.after(()=>rmSync(project,{recursive:true,force:true}));
 let sessionId;
 const {app,page,appProcess,home}=await launchCandidate(t,async home=>{
  mkdirSync(join(home,"pi"),{recursive:true});
  writeFileSync(join(home,"pi/models.json"),JSON.stringify({providers:{fixture:{
   api:"openai-completions",baseUrl:"http://127.0.0.1:9/v1",apiKey:"fixture-only",
   models:["main","worker"].map(id=>({id,name:id,reasoning:true,input:["text"],
    cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:4096})),
  }}}));
  const [{saveConfig},{createTeamConfig},{createGuiController}]=await Promise.all([
   load("src/config.js"),load("src/teams.js"),load("src/gui-controller.js"),
  ]);
  const rosterId=randomUUID();
  saveConfig(home,createTeamConfig({formatVersion:2,main:{provider:"fixture",modelId:"main"},
   secondary:[{provider:"fixture",modelId:"worker"}]},"Packaged thinking",rosterId));
  const controller=await createGuiController({home,suggestedProject:null});
  try{
   const workspace=await controller.action("workspace.create",{workspaceId:randomUUID(),name:"思考控件验收",project,defaultRosterId:rosterId});
   const session=await controller.action("session.create",{workspaceId:workspace.id,sessionId:randomUUID()});
   sessionId=session.id;
  }finally{await controller.close();}
 });
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1280,880));
 const mutations=[];
 page.on("request",request=>{if(request.url().endsWith("/api/action"))mutations.push(request.postDataJSON());});
 const trigger=page.getByRole("button",{name:"思考强度",exact:true});
 await trigger.waitFor({state:"visible"});
 const draftSaved=page.waitForResponse(response=>response.url().endsWith("/api/action")&&response.ok()&&
  response.request().postDataJSON()?.action==="session.draft");
 await page.getByLabel("输入问题",{exact:true}).fill("打包候选中的中文草稿");
 await trigger.focus();await page.keyboard.press("ArrowDown");
 const menu=page.getByRole("menu",{name:"思考强度选项"});await menu.waitFor();
 const [thinkingBounds,sendBounds,menuBounds]=await Promise.all([
  trigger.boundingBox(),page.getByRole("button",{name:"发送",exact:true}).boundingBox(),menu.boundingBox(),
 ]);
 assert.ok(thinkingBounds.x+thinkingBounds.width<=sendBounds.x);
 assert.ok(menuBounds.y+menuBounds.height<=thinkingBounds.y);
 const selected=page.waitForResponse(response=>response.url().endsWith("/api/action")&&response.ok()&&
  response.request().postDataJSON()?.action==="session.thinking");
 await page.getByRole("menuitemradio",{name:"low",exact:true}).click();
 const receipt=await (await selected).json();
 assert.equal(receipt.id,sessionId);assert.equal(receipt.thinkingScope,"all");assert.equal(receipt.thinking,"low");
 await draftSaved;
 await page.reload();
 await page.waitForFunction(()=>document.querySelector('[aria-label="思考强度"]')?.textContent.includes("low"));
 assert.equal(await page.getByLabel("输入问题",{exact:true}).inputValue(),"打包候选中的中文草稿");
 assert.equal(mutations.filter(row=>row.action==="session.thinking").length,1);
 assert.equal(mutations.find(row=>row.action==="session.thinking").args.scope,"all");
 assert.equal(mutations.filter(row=>["task.submit","context.organize","extension.command"].includes(row.action)).length,0);
 const files=join(home,"pi/sessions/main");
 const path=readdirSync(files).filter(name=>name.endsWith(".jsonl")).map(name=>join(files,name)).find(path=>
  JSON.parse(readFileSync(path,"utf8").split("\n")[0]).id===sessionId);
 const events=readFileSync(path,"utf8").trim().split("\n").map(JSON.parse);
 assert.equal(events.findLast(row=>row.customType==="cothink-thinking").data.scope,"all");
 assert.equal(events.filter(row=>row.customType==="cothink-task").length,0);
 const evidence=resolve("work/unified-thinking");mkdirSync(evidence,{recursive:true});
 await trigger.click();await page.screenshot({path:join(evidence,"thinking-packaged.png")});await page.keyboard.press("Escape");
 const closed=app.waitForEvent("close");await app.evaluate(({app})=>app.quit());await closed;
 assert.equal(appProcess.exitCode,0);
}
