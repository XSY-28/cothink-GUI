import test from "node:test";
import assert from "node:assert/strict";
import {join,resolve} from "node:path";
import {mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {chromium} from "playwright";
import {fixture} from "./helpers/pi-fixture.js";
import {fixtureConversation} from "./helpers/gui-controller-fixture.js";
import {createTeamConfig,saveConfig,load,startGuiServer} from "./gui-navigation.fixture.js";

test("thinking menu stays left of send and above the composer in both themes and narrow windows",async t=>{
 const f=await fixture(t);
 const catalog=join(f.home,"pi/models.json"),configuration=JSON.parse(readFileSync(catalog,"utf8"));
 for(const model of configuration.providers.fixture.models)model.reasoning=true;
 writeFileSync(catalog,JSON.stringify(configuration));
 saveConfig(f.home,createTeamConfig({formatVersion:2,...f.models},"Thinking fixture","7c8094cd-3476-4bfa-8f53-055d87972896"));
 const {createGuiController}=await load("src/gui-controller.js");
 const controller=await createGuiController({home:f.home,suggestedProject:null});
 const session=await fixtureConversation(t,controller);
 const host=await startGuiServer({controller,open:false});t.after(()=>host.close());
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1280,height:880}}),errors=[];
 page.on("pageerror",error=>errors.push(error.message));
 await page.goto(host.url);
 await page.getByRole("button",{name:"思考强度",exact:true}).waitFor();
 const trigger=page.getByRole("button",{name:"思考强度",exact:true}),send=page.getByRole("button",{name:"发送",exact:true});
 const editor=page.getByLabel("输入问题",{exact:true});
 await editor.fill("较长的中文草稿与多行输入。".repeat(140));
 await trigger.focus();await page.keyboard.press("ArrowDown");
 await page.getByRole("menu",{name:"思考强度选项"}).waitFor();
 await page.keyboard.press("ArrowDown");await page.keyboard.press("Escape");
 assert.equal(await trigger.evaluate(node=>node===document.activeElement),true);
 assert.match(await trigger.textContent(),/high/,'blank conversation defaults high');
 for(const level of ["low","high","max"]){
  const changed=page.waitForResponse(response=>response.url().endsWith("/api/action")&&response.request().postDataJSON()?.action==="session.thinking"&&response.ok());
  await trigger.click();
  assert.deepEqual(await page.getByRole("menuitemradio").allTextContents(),["low","high","max"]);
  await page.getByRole("menuitemradio",{name:level,exact:true}).focus();await page.keyboard.press("Enter");
  const receipt=await(await changed).json();assert.equal(receipt.thinking,level);assert.equal(receipt.thinkingScope,"all");
  await page.waitForFunction(level=>document.querySelector('[aria-label="思考强度"]')?.textContent.includes(level),level);
  assert.equal((await controller.session(session.id)).thinking,level);
 }
 await page.reload();await page.waitForFunction(()=>document.querySelector('[aria-label="思考强度"]')?.textContent.includes("max"));
 const directory=resolve("work/unified-thinking-three-levels");mkdirSync(directory,{recursive:true});
 for(const theme of ["light","dark"]){
  await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;},theme);
  for(const viewport of [{width:1280,height:880},{width:460,height:650}]){
   await page.setViewportSize(viewport);await trigger.click();
   const menu=page.getByRole("menu",{name:"思考强度选项"});await menu.waitFor();
   const [button,arrow,panel]=await Promise.all([trigger.boundingBox(),send.boundingBox(),menu.boundingBox()]);
   assert.ok(button.x+button.width<=arrow.x,"the thinking control is immediately left of send");
   assert.ok(panel.y+panel.height<=button.y,"the menu opens upward");
   assert.ok(panel.x>=0&&panel.x+panel.width<=viewport.width,"the whole menu stays inside the viewport");
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   await page.screenshot({path:join(directory,`thinking-${theme}-${viewport.width}.png`)});
   await page.keyboard.press("Escape");
  }
 }
 assert.equal(f.calls.length,0,"opening and changing thinking settings sends no model requests");
 assert.deepEqual(errors,[]);
});
