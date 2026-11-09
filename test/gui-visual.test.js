import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { fixture } from "./helpers/pi-fixture.js";
import { repository } from "./helpers/git-fixture.js";
import { chooseRailCreation } from "./helpers/gui-rail.js";
import { pathToFileURL, fileURLToPath } from "node:url";
const packageRoot=resolve(process.env.COTHINK_TEST_PACKAGE_ROOT??fileURLToPath(new URL("..",import.meta.url)));
const load=path=>import(pathToFileURL(join(packageRoot,path)));
const {saveConfig}=await load("src/config.js");
const {createTeamConfig}=await load("src/teams.js");
const {startGuiServer}=await load("src/gui-server.js");
import { execution } from "./helpers/agent-sync-fixture.js";
const tool = (name, args = {}) => ({ toolCalls: [{ name, args }] });

test(
  "actual unified GUI preserves unbound draft, confirms formal HTML and shows authenticated final screenshots at three widths",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t, (c, n) =>
      c.body.tools?.some(x=>x.function.name==='submit_visual_review')
        ? tool('submit_visual_review',{verdict:'match',observation:'蓝色矩形',reasons:'当前视口中颜色与原题一致。'})
        : n === 1 ? tool("start_work",{action:"start",reason:"HTML delivery",plan:{goal:"制作一个蓝色矩形",scope:["index.html"],deliverables:["index.html"],checks:[{command:"node",args:["-e","require(\'fs\').accessSync(\'index.html\')"]}],workRequest:{kind:"html-svg"}}})
        : n === 2
        ? tool("write", {
            path: "index.html",
            content:
              '<meta charset="utf-8"><h1>蓝色作品</h1><svg width="240" height="100"><rect width="240" height="100" fill="blue"/></svg>',
          })
        : n === 3
          ? tool("accept_change")
          : { text: "GUI visual delivery" },
    );
    const repo = repository(t);
    const file = join(f.home, "pi/models.json"),
      catalog = JSON.parse(readFileSync(file));
    for (const m of catalog.providers.fixture.models)
      m.input = ["text", "image"];
    writeFileSync(file, JSON.stringify(catalog));
    saveConfig(
      f.home,
      createTeamConfig(
        {
          formatVersion: 2,
          ...f.models,
          piResources: {
            skills: [
              new URL("./fixtures/visual-skill/SKILL.md", import.meta.url)
                .pathname,
            ],
          },
          work: {
            checks: [],
            execution: {
              ...execution,
              image: JSON.parse(
                readFileSync(
                  new URL(
                    "../docker/visual-preview-manifest.json",
                    import.meta.url,
                  ),
                ),
              ).image,
            },
          },
        },
        "Visual fixture",
        "7c8094cd-3476-4bfa-8f53-055d87972896",
      ),
    );
    const h = await startGuiServer({
      home: f.home,
      cwd: repo.project,
      open: false,
    });
    t.after(() => h.close());
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    await page.goto(h.url);
    const dismissNotes = page.getByRole("button", { name: "暂时收起本地更新提示", exact:true });
    await dismissNotes.waitFor();
    assert.equal(await page.getByRole("dialog").count(),0,"local release notes do not interrupt startup");
    await dismissNotes.click();
    assert.equal(await page.getByText("查看本次更新").count(),0);
    assert.equal(f.calls.length,0,"dismissing the notice does not generate");
    await page.getByRole("button", {name:"对话",exact:true}).click();
    const conversationPicker=page.getByRole("dialog",{name:"对话",exact:true});
    await conversationPicker.getByRole("button",{name:"新建对话",exact:true}).click();
    // The picker makes the previous homepage inert while the new conversation is
    // being saved and opened. Playwright fill can otherwise hit the old editor.
    await conversationPicker.waitFor({state:"hidden"});
    const editor=page.getByLabel("输入问题");
    await editor.waitFor({state:"visible"});
    assert.equal(await editor.evaluate(node=>!!node.closest("[inert]")),false);
    assert.equal(await page.getByText("首次发送将建立未分组对话。",{exact:true}).count(),0);
    await editor.fill("Keep my draft");
    await page.getByRole("button", {name:"添加本次操作"}).click();
    assert.equal(await page.getByText("本次允许读取项目文件",{exact:true}).count(),0);
    await page.keyboard.press('Escape');
    assert.equal(
      await page.getByLabel("输入问题").inputValue(),
      "Keep my draft",
    );
    assert.equal(f.calls.length, 0);
    await chooseRailCreation(page, "新建 Team");
    const create = page.getByRole("dialog", {name:"新建 Team",exact:true});
    await create.getByLabel("名称",{exact:true}).fill("Visual project");
    await create.getByText("手动输入路径",{exact:true}).click();
    await create.getByLabel("项目绝对路径").fill(repo.project);
    await create.getByRole("button", {name:"只读检查目录",exact:true}).click();
    await create.getByText(/目录可以关联/).waitFor();
    await create.getByRole("button", {name:"创建",exact:true}).click();
    await create.waitFor({state:"hidden"});
    assert.equal(await page.getByLabel("对话模式").count(),0);
    await page.getByLabel("输入问题").fill("制作一个蓝色矩形");
    await page.getByRole('button',{name:'本次选项'}).click();
    await page.getByLabel('本轮最多模型请求（留空不设上限）',{exact:true}).fill('5');
    mkdirSync(resolve('work/gui/desktop-unified/d3-d4-evidence'),{recursive:true});
    await page.screenshot({path:resolve('work/gui/desktop-unified/d3-d4-evidence/turn-options.png'),fullPage:true});
    await page.keyboard.press('Escape');
    await page.getByRole("button", {name:/^发送/}).dblclick();
    await page.getByRole("button",{name:"确认上述计划并执行",exact:true}).click();
    await page
      .getByText("GUI visual delivery", { exact: false })
      .first()
      .waitFor({ timeout: 30000 });
    const deliveredFile = page.waitForResponse(response => new URL(response.url()).pathname === '/api/file' && response.ok());
    await page.getByRole("button", {name:/^index\.html/}).click();
    const deliveredResponse = await deliveredFile;
    const deliveredRef = Object.fromEntries(['taskId','version','path'].map(key => [key,new URL(deliveredResponse.url()).searchParams.get(key)]));
    const get = async path => {
      const response = await fetch(h.origin + path,{headers:{Authorization:`Bearer ${h.token}`}});
      assert.equal(response.status,200);return response.json();
    };
    const deliveredTask = await get('/api/task?id=' + deliveredRef.taskId);
    const deliveredSession = await get('/api/session?id=' + deliveredTask.sessionId);
    // Formal execution has its own same-title session; label the user conversation
    // by its durable ID so the search assertion cannot accidentally open that child.
    const renamed = await fetch(h.origin + '/api/action',{
      method:'POST',headers:{Authorization:`Bearer ${h.token}`,'Content-Type':'application/json', "X-CoThink-GUI-Input":"2"},
      body:JSON.stringify({action:'session.name',args:{sessionId:deliveredSession.id,title:'蓝色矩形交付记录'}}),
    });
    assert.equal(renamed.status,200);
    await page.getByRole("region",{name:"成果文件阅读"}).waitFor();
    await page.getByText("检查、截图与版本详情",{exact:true}).click();
    await page
      .getByText("index.html · 最终版本审查完成", { exact: true })
      .waitFor();
    await page.locator(".visual-frame img").first().waitFor();
    assert.ok(
      await page
        .locator(".visual-frame img")
        .first()
        .evaluate((i) => i.complete && i.naturalWidth > 0),
    );
    const out = resolve("work/task-fidelity/gui");
    mkdirSync(out, { recursive: true });
    for (const [width, height] of [
      [1280, 800],
      [1024, 768],
      [800, 600],
    ]) {
      await page.setViewportSize({ width, height });
      if (width === 800)
        await page
          .locator(".visual-frame img")
          .first()
          .scrollIntoViewIfNeeded();
      await page.screenshot({
        path: join(out, `${width}.png`),
        fullPage: true,
      });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
    }
    // Search the accepted artifact from a different Team through the real server.
    await page.setViewportSize({width:1280,height:880});
    await page.keyboard.press('Escape');
    await page.getByRole('region',{name:'成果文件阅读'}).waitFor({state:'hidden'});
    await chooseRailCreation(page, "新建 Team");
    const otherTeam = page.getByRole('dialog',{name:'新建 Team',exact:true});
    await otherTeam.getByLabel('名称',{exact:true}).fill('搜索起点 Team');
    await otherTeam.getByRole('button',{name:'创建',exact:true}).click();
    await otherTeam.waitFor({state:'hidden'});
    await page.locator('h1').filter({hasText:'搜索起点 Team'}).waitFor();
    const beforeSearch = f.calls.length;
    await page.getByRole('button',{name:'搜索',exact:true}).click();
    const search = page.getByRole('dialog',{name:'搜索',exact:true});
    const searchResponse = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === '/api/sessions' && url.searchParams.get('query') === 'index.html' && !url.searchParams.has('workspaceId');
    });
    await search.getByPlaceholder('搜索名称、对话或文件…').fill('index.html');
    const matches = await (await searchResponse).json();
    const match = matches.items.find(row => row.id === deliveredSession.id);
    assert.ok(match,'global file search includes the delivery conversation');
    assert.equal(match.workspaceId,deliveredSession.workspaceId);
    assert.equal(match.match.field,'file');
    assert.equal(match.match.taskId,deliveredTask.id);
    assert.deepEqual(match.match.fileRef,deliveredRef);
    const openedFile = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === '/api/file' && Object.entries(deliveredRef).every(([key,value]) => url.searchParams.get(key) === value) && response.ok();
    });
    await search.getByRole('button',{name:match.title,exact:true}).click();
    await page.locator('h1').filter({hasText:'Visual project'}).waitFor();
    const panel = page.getByRole('region',{name:'成果文件阅读'});
    await panel.getByRole('heading',{name:'index.html',exact:true}).waitFor();
    assert.equal((await openedFile).headers()['x-cothink-version'],deliveredRef.version);
    await panel.getByRole('tab',{name:'源码',exact:true}).click();
    await panel.locator('pre').filter({hasText:'<h1>蓝色作品</h1>'}).waitFor();
    await page.screenshot({path:join(out,'cross-team-file-search.png'),fullPage:true});
    await page.keyboard.press('Escape');
    await panel.waitFor({state:'hidden'});
    const projectResponse = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === '/api/sessions' && url.searchParams.get('workspaceId') === deliveredSession.workspaceId && url.searchParams.get('query') === '' && url.searchParams.get('archived') === 'active';
    });
    await page.getByRole('button',{name:'对话',exact:true}).click();
    const projectRows = await (await projectResponse).json();
    assert.ok(projectRows.items.some(row => row.id === deliveredSession.id));
    assert.ok(projectRows.items.every(row => row.workspaceId === deliveredSession.workspaceId));
    const picker = page.getByRole('dialog',{name:'对话',exact:true});
    await picker.getByRole('button',{name:match.title,exact:true}).waitFor();
    assert.equal(await picker.getByPlaceholder('搜索此处的对话…').inputValue(),'');
    assert.equal(await picker.getByLabel('包含归档',{exact:true}).isChecked(),false);
    assert.equal((await get('/api/session?id=' + deliveredSession.id)).workspaceId,deliveredSession.workspaceId);
    assert.equal(f.calls.length,beforeSearch,'file search, reading and scoped history make no model calls');
    assert.equal(f.calls.length, 5);
    assert.ok(f.calls.every((c) => c.body.model === "main"));
    assert.deepEqual(errors, []);
  },
);

test('actual browser preserves startup draft and refuses unmanaged native commands without generation', {timeout:60000}, async t=>{
  const {runPackageCommand}=await load('src/packages.js');
  const f=await fixture(t),root=join(f.home,'browser-plugin');mkdirSync(root);
  const extension=join(root,'index.js');
  writeFileSync(join(root,'package.json'),JSON.stringify({name:'browser-native',version:'1.0.0',type:'module',pi:{extensions:['index.js']}}));
  writeFileSync(extension,`export default pi=>{
    pi.registerCommand('browser-dialog',{description:'浏览器插件交互',handler:async(_a,ctx)=>{const choice=await ctx.ui.select('插件选择',['A','B']);const text=await ctx.ui.input('插件输入','请输入');const confirmed=await ctx.ui.confirm('插件确认','保存本次选择？');ctx.ui.notify('PLUGIN_DIALOG:'+JSON.stringify({choice,text,confirmed}));}});
    pi.registerCommand('choice',{handler:async(_a,ctx)=>{const answer=await ctx.ui.select('可取消选择',['X']);ctx.ui.notify(answer??'CHOICE_CANCELLED')}});
    pi.registerCommand('terminal-component',{handler:async(_a,ctx)=>ctx.ui.custom(()=>{throw Error('must not run terminal factory');})});
  };`);
  assert.equal((await runPackageCommand({home:f.home,cwd:f.cwd,command:'install',source:root})).exitCode,0);
  saveConfig(f.home,createTeamConfig({formatVersion:2,...f.models},'Plugin fixture','7c8094cd-3476-4bfa-8f53-055d87972896'));
  const h=await startGuiServer({home:f.home,cwd:f.cwd,open:false});t.after(()=>h.close());
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('status of 400'))errors.push(m.text());});
  const rejected=[];page.on('response',async response=>{if(response.status()===400)rejected.push(await response.json());});
  // A user may create a conversation before the initial host snapshot arrives.
  // Deliver that stale snapshot while holding refreshes, so configuration is
  // still unknown in the UI rather than silently racing this assertion.
  const initialBootstrap=Promise.withResolvers(), refreshedBootstrap=Promise.withResolvers();
  let bootstrapReads=0;
  await page.route('**/api/bootstrap',async route=>{
    const first=++bootstrapReads===1, response=await route.fetch();
    await (first?initialBootstrap.promise:refreshedBootstrap.promise);
    await route.fulfill({response});
  });
  await page.goto(h.url);
  const input = page.getByLabel('输入问题');
  try {
    await page.getByRole('button',{name:'对话',exact:true}).click();
    await page.getByRole('dialog',{name:'对话',exact:true})
      .getByRole('button',{name:'新建对话',exact:true}).click();
    await input.fill('插件完成后我还要编辑这份草稿');
    const initialResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/bootstrap');
    initialBootstrap.resolve();
    await (await initialResponse).finished();
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.getByRole('dialog',{name:'设置',exact:true}).count(),0,'unknown configuration must not trigger onboarding');
  } finally {
    initialBootstrap.resolve();refreshedBootstrap.resolve();
    await page.unrouteAll({behavior:'wait'});
  }
  await page.getByRole('button',{name:'添加本次操作'}).click();
  assert.equal(await page.getByRole('button',{name:'插件命令',exact:true}).count(),0,'clean unified host does not offer arbitrary native commands');
  await page.keyboard.press('Escape');
  await input.fill('/browser-dialog');await input.press('Enter');
  await page.getByRole('alert').filter({hasText:/未知本地命令/}).waitFor();
  assert.equal(await input.inputValue(),'/browser-dialog');assert.equal(f.calls.length,0);assert.deepEqual(errors,[]);
});

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
  const send=button("发送"),add=button("添加本次操作"),options=button("本次选项");
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
  await options.click();
  await page.getByLabel("只分析，不修改").check();
  await page.getByLabel("本轮最多模型请求（留空不设上限）").fill("1");
  await page.keyboard.press("Escape");
  await button("移除只分析标记").waitFor();
  await button("移除最多 1 次请求标记").click();

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
  await editor.evaluate(node=>{
    const dataTransfer=new DataTransfer();
    dataTransfer.items.add(new File(["dropped text"],"drop.md",{type:"text/markdown"}));
    node.dispatchEvent(new DragEvent("drop",{dataTransfer,bubbles:true,cancelable:true}));
  });
  await rows.getByRole("button",{name:"预览 drop.md",exact:true}).waitFor();

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

  // The fixture reply references the actual immutable image ID from the confirmed home draft.
  const response=await fetch(host.origin+"/api/bootstrap",{headers:{Authorization:"Bearer "+host.token}});
  const boot=await response.json();
  assert.equal(boot.homeDraft.editor.materials.length,3);
  const listed=boot.homeDraft.materials??boot.homeMaterials;
  if(listed)imageId=listed.find(item=>item.name==="pasted.png")?.id;
  imageId??=boot.homeDraft.editor.materials[1].id;
  assert.equal(await editor.inputValue(),"");
  await page.screenshot({path:resolve("work/gui-usability-repair/T3-desktop-materials.png")});
  let network=0;
  await page.route("https://images.example.test/sample.png",async route=>{
    network++;
    assert.equal(route.request().headers().referer,undefined);
    await route.fulfill({status:200,contentType:"image/png",body:materialPng});
  });
  await send.click();
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
  await page.getByRole("button",{name:/对话操作：/}).click();
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
  await send.click();
  await page.getByText("已使用选择的技能",{exact:true}).waitFor();
  assert.equal(f.calls.length,2);
  assert.match(JSON.stringify(f.calls[1].body.messages),/doc-maintenance/);
  assert.ok(f.calls[1].body.tools.some(tool=>tool.function.name==="read_skill"));
});

test("compact browser chooses current project bytes and a pinned saved range; navigation shows true history",async t=>{
  const f=await fixture(t,(_,n)=>n===1?{toolCalls:[{name:"read_project_context",args:{operation:"read",paths:["a.txt"]}}]}:{text:"已按实际材料完成"}),repo=repository(t);
  writeFileSync(join(repo.project,"a.txt"),"uncommitted A fixture\n");
  saveConfig(f.home,createTeamConfig({formatVersion:2,...f.models},"文件阵容","7c8094cd-3476-4bfa-8f53-055d87972896"));
  const host=await startGuiServer({home:f.home,cwd:f.cwd,open:false});t.after(()=>host.close());
  const {page,errors}=await usabilityPage(t,host,800,600);
  const button=name=>page.getByRole("button",{name,exact:true}),editor=page.getByLabel("输入问题");
  await button("切换导航").click();
  await chooseRailCreation(page, "新建 Team");
  const create=page.getByRole("dialog",{name:"新建 Team",exact:true});
  const team="固定材料的中文长团队名字——需要在紧凑窗口仍可操作";
  await create.getByLabel("名称",{exact:true}).fill(team);
  await create.getByText("手动输入路径",{exact:true}).click();
  await create.getByLabel("项目绝对路径").fill(repo.project);
  await create.getByRole("button",{name:"只读检查目录",exact:true}).click();
  await create.getByText(/目录可以关联/).waitFor();
  await create.getByRole("button",{name:"创建",exact:true}).click();
  await create.waitFor({state:"hidden"});
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
  await picker.getByText(repo.baseVersion.slice(0,12),{exact:true}).waitFor();
  await page.screenshot({path:resolve("work/gui-usability-repair/T3-compact-project-picker.png")});
  await row().getByRole("button",{name:"选择范围",exact:true}).click();
  await picker.getByRole("button",{name:"确认读取范围",exact:true}).click();
  await picker.waitFor({state:"hidden"});
  await button("移除读取已保存版本：a.txt标记").waitFor();
  await button("发送").click();
  await page.getByText("已按实际材料完成",{exact:true}).waitFor();
  const first=JSON.stringify(f.calls[0].body);
  assert.match(first,/uncommitted A fixture/);
  assert.equal(f.calls.length,2);
  assert.match(JSON.stringify(f.calls[1].body),/base A/);
  await button("对话").click();
  const histories=page.getByRole("dialog",{name:"对话",exact:true});
  await histories.getByText("第一段用户摘要，足以区别相同标题",{exact:true}).first().waitFor();
  const dateTime=await histories.locator("time").first().getAttribute("datetime");
  assert.ok(Number.isFinite(Date.parse(dateTime)));
  await page.keyboard.press("Escape");
  await button("切换导航").click();
  await chooseRailCreation(page, "新对话");
  const newChat=page.getByRole("dialog",{name:"新对话",exact:true});
  await newChat.getByText(`将在 ${team} 中新建对话。`,{exact:true}).waitFor();
  await newChat.getByRole("button",{name:"新建未分组对话",exact:true}).click();
  await newChat.waitFor({state:"hidden"});
  await page.getByRole("heading",{level:1}).getByText("未分组对话",{exact:true}).waitFor();
  assert.deepEqual(errors,[]);
});
