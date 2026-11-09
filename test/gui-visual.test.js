import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { fixture } from "./helpers/pi-fixture.js";
import { repository } from "./helpers/git-fixture.js";
import { pathToFileURL, fileURLToPath } from "node:url";
const packageRoot=resolve(process.env.COTHINK_TEST_PACKAGE_ROOT??fileURLToPath(new URL("..",import.meta.url)));
const load=path=>import(pathToFileURL(join(packageRoot,path)));
const {saveConfig}=await load("src/config.js");
const {createTeamConfig}=await load("src/teams.js");
const {startGuiServer}=await load("src/gui-server.js");
import { execution } from "./helpers/agent-sync-fixture.js";
const tool = (name, args = {}) => ({ toolCalls: [{ name, args }] });
test('compact sidebar keeps three Teams and project conversations separate without model calls', async t => {
  const f = await fixture(t);
  saveConfig(f.home, createTeamConfig({formatVersion:2,...f.models}, 'UI fixture', '7c8094cd-3476-4bfa-8f53-055d87972896'));
  const {createGuiController} = await load('src/gui-controller.js');
  const controller = await createGuiController({home:f.home,suggestedProject:null});
  const h = await startGuiServer({controller,open:false}); t.after(()=>h.close());
  const browser = await chromium.launch({headless:true}); t.after(()=>browser.close());
  const page = await browser.newPage({viewport:{width:1280,height:880}}), errors=[];
  page.on('pageerror', error=>errors.push(error.message));
  page.on('console', message=>{if(message.type()==='error')errors.push(message.text());});
  const screenshots = resolve(process.env.COTHINK_UI_SCREENSHOTS || 'work/gui/compact-ui');
  mkdirSync(screenshots,{recursive:true});
  await page.goto(h.url);
  const nav=page.locator('nav');
  await page.getByRole('button',{name:'搜索',exact:true}).waitFor();
  assert.equal(await nav.getByRole('button',{name:'新建 Team',exact:true}).count(),1);
  assert.equal(await nav.getByRole('button',{name:'设置',exact:true}).count(),1);
  const picker=page.getByRole('dialog',{name:'对话',exact:true});
  const createConversation=async()=>{
    await page.getByRole('button',{name:'对话',exact:true}).click();
    await picker.getByRole('button',{name:'新建对话',exact:true}).click();
    await picker.waitFor({state:'hidden'});
    assert.equal(await page.getByLabel('输入问题',{exact:true}).inputValue(),'');
  };
  const fillDraft=async text=>{
    const saved=page.waitForResponse(response=>{
      if (!response.url().endsWith('/api/action')) return false;
      const body=response.request().postDataJSON();
      return body?.action==='session.draft' && body.args.text===text && response.ok();
    });
    await page.getByLabel('输入问题',{exact:true}).fill(text);
    await saved;
  };
  const names=['CoThink 开发','LLM 学习与多头注意力代码的长期讨论项目','课程笔记'];
  for (const name of names) {
    await nav.getByRole('button',{name:'新建 Team',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'新建 Team',exact:true});
    await dialog.getByLabel('名称',{exact:true}).fill(name);
    await dialog.getByRole('button',{name:'创建',exact:true}).click();
    await dialog.waitFor({state:'hidden'});
    await fillDraft(name+' 第一份草稿');
    await createConversation();
    await fillDraft(name+' 第二份草稿');
  }
  const boot=await controller.bootstrap();
  const [a,b,c]=names.map(name=>boot.workspaces.find(w=>w.name===name));
  for (const workspace of [a,b,c]) {
    const {items}=await controller.sessions({workspaceId:workspace.id});
    assert.equal(items.length,2);
    const drafts=await Promise.all(items.map(async row=>(await controller.session(row.id)).draft));
    assert.deepEqual(drafts.sort(),[workspace.name+' 第一份草稿',workspace.name+' 第二份草稿'].sort());
  }
  const assertTeamOnly=async()=>{
    assert.equal(await nav.locator('[aria-label="最近对话"]').count(),0);
    assert.equal(await nav.locator('[aria-label*="中新建对话"]').count(),0);
    for (const name of names) assert.equal(await nav.getByRole('button',{name,exact:true}).count(),1);
  };
  await assertTeamOnly();
  const first=nav.getByRole('button',{name:a.name,exact:true});
  await first.click();
  const aSessions=(await controller.sessions({workspaceId:a.id})).items;
  const original=(await Promise.all(aSessions.map(row=>controller.session(row.id)))).find(row=>row.draft.endsWith('第一份草稿'));
  await controller.action('session.name',{sessionId:original.id,title:'保留的开发讨论'});
  await page.getByRole('button',{name:'对话',exact:true}).click();
  await picker.getByRole('button',{name:'保留的开发讨论',exact:true}).click();
  await picker.waitFor({state:'hidden'});
  await page.waitForFunction(expected=>document.querySelector('textarea')?.value===expected,a.name+' 第一份草稿');
  assert.equal(await page.getByLabel('输入问题',{exact:true}).inputValue(),a.name+' 第一份草稿');
  await nav.getByRole('button',{name:b.name,exact:true}).click();
  await page.waitForFunction(expected=>document.querySelector('textarea')?.value===expected,b.name+' 第二份草稿');
  await first.click();
  await page.waitForFunction(expected=>document.querySelector('textarea')?.value===expected,a.name+' 第一份草稿');
  assert.equal(await page.getByLabel('输入问题',{exact:true}).inputValue(),a.name+' 第一份草稿','Team restores the most recently viewed conversation');
  await createConversation();
  assert.equal((await controller.sessions({workspaceId:a.id})).items.length,3);
  await assertTeamOnly();
  // Global pagination, filters and cancelled searches must not leak into the project picker.
  for (let i=0;i<50;i++) {
    const other=await controller.action('session.create',{sessionId:crypto.randomUUID(),workspaceId:b.id});
    await controller.action('session.name',{sessionId:other.id,title:'其他项目讨论 '+i});
    await controller.action('session.pin',{sessionId:other.id,expectedRevision:other.navigation.revision,pinned:true});
  }
  // Persist a deterministic historical answer through the existing task/Pi APIs.
  // No provider is called: this is display/search fixture content, not a generated answer.
  const {SessionManager}=await load('node_modules/@earendil-works/pi-coding-agent/dist/index.js');
  const {createTask}=await load('src/task.js');
  const manager=SessionManager.create(f.cwd,join(f.home,'pi/sessions/main'));
  manager.appendCustomEntry('cothink-project',{project:null});
  manager.appendCustomEntry('cothink-gui-workspace',{workspaceId:b.id});
  manager.appendCustomEntry('cothink-title',{title:'注意力阅读记录'});
  const historical=createTask({home:f.home,input:'历史检索标记：为什么每个注意力头使用不同的投影？',models:f.models,sessionId:manager.getSessionId(),singleModel:true});
  const request={id:crypto.randomUUID(),taskId:historical.record.id,status:'completed',sent:false,events:[],text:Array.from({length:12},(_,i)=>`第 ${i+1} 段阅读记录：同一个词会通过不同投影形成不同表示。每个头在自己的表示空间内计算相关性，再将结果合并。这里是用于检验长中文正文、滚动和历史定位的固定夹具。`).join('\n\n')};
  historical.register(request);historical.writeRequest(request);historical.record.finalCallId=request.id;historical.finish('completed');
  manager.appendCustomEntry('cothink-task',{taskId:historical.record.id});
  manager.appendMessage({role:'user',content:historical.record.input,timestamp:Date.now()});
  manager.appendMessage({role:'assistant',content:[{type:'text',text:request.text}],api:'openai-completions',provider:'fixture',model:'main',usage:{input:0,output:0,totalTokens:0,cost:{input:0,output:0,total:0}},stopReason:'stop',timestamp:Date.now()});
  const seeded=await controller.session(manager.getSessionId());
  assert.equal(seeded.selectionError,null);
  assert.equal(seeded.workspaceId,b.id);
  assert.equal(seeded.readOnly,false);
  assert.equal((await controller.sessions({query:'历史检索标记'})).items.length,1);
  await page.getByRole('button',{name:'搜索',exact:true}).click();
  const search=page.getByRole('dialog',{name:'搜索',exact:true});
  await search.getByRole('button',{name:'加载更多',exact:true}).click();
  await search.getByLabel('包含归档',{exact:true}).check();
  await search.getByPlaceholder('搜索名称、对话或文件…').fill('不存在的讨论');
  await search.getByText('没有匹配结果。',{exact:true}).waitFor();
  const projectQuery=response=>{
    const url=new URL(response.url());
    return url.pathname==='/api/sessions' && url.searchParams.get('workspaceId')===a.id && url.searchParams.get('query')==='' && url.searchParams.get('archived')==='active';
  };
  const resetQuery=page.waitForResponse(projectQuery);
  await page.keyboard.press('Escape');
  await search.waitFor({state:'hidden'});
  await resetQuery;
  const refreshedQuery=page.waitForResponse(projectQuery);
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await refreshedQuery;
  await page.getByRole('button',{name:'对话',exact:true}).click();
  await picker.getByRole('button',{name:'保留的开发讨论',exact:true}).waitFor();
  assert.equal(await picker.getByPlaceholder('搜索此处的对话…').inputValue(),'');
  assert.equal(await picker.getByLabel('包含归档',{exact:true}).isChecked(),false);
  assert.equal(await picker.getByRole('button',{name:/其他项目讨论/}).count(),0);
  await page.keyboard.press('Escape');
  await picker.waitFor({state:'hidden'});
  await page.getByRole('button',{name:'阵容',exact:true}).click();
  await page.getByRole('dialog',{name:'阵容',exact:true}).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog',{name:'阵容',exact:true}).waitFor({state:'hidden'});
  await page.getByRole('button',{name:'搜索',exact:true}).click();
  await search.getByPlaceholder('搜索名称、对话或文件…').fill('历史检索标记');
  await search.getByRole('button',{name:'注意力阅读记录',exact:true}).click();
  await page.locator('h1').filter({hasText:b.name}).waitFor();
  await page.getByText('正在查看历史对话 · 注意力阅读记录',{exact:true}).waitFor();
  await page.locator('article').getByText(/第 1 段阅读记录/).waitFor();
  const scroller=page.locator('[class*="conversationScroll"]');
  const savedAnchor=page.waitForResponse(response=>{
    if (!response.url().endsWith('/api/action')) return false;
    const body=response.request().postDataJSON();
    return body?.action==='session.view' && body.args.sessionId===manager.getSessionId() && body.args.anchor?.offsetPx>0 && response.ok();
  });
  await scroller.evaluate(node=>{node.scrollTop=340;});
  await savedAnchor;
  const anchor=(await controller.session(manager.getSessionId())).view.anchor;
  assert.equal(anchor.taskId,historical.record.id);
  assert.ok(anchor.offsetPx>0);
  // A cursor includes view metadata: finish the explicit reading update before paging.
  const firstPage=page.waitForResponse(response=>{
    const url=new URL(response.url());
    return url.pathname==='/api/sessions' && url.searchParams.get('workspaceId')===b.id && !url.searchParams.has('cursor') && url.searchParams.get('query')==='';
  });
  await page.getByRole('button',{name:'对话',exact:true}).click();
  const listed=await (await firstPage).json();
  assert.equal(listed.items.length,50);
  assert.ok(listed.nextCursor);
  await page.waitForFunction(()=>document.querySelector('[role="dialog"][aria-label="对话"]')?.querySelectorAll('[title^="其他项目讨论"]').length===50);
  const secondPage=page.waitForResponse(response=>{
    const url=new URL(response.url());
    return url.pathname==='/api/sessions' && url.searchParams.get('workspaceId')===b.id && url.searchParams.get('cursor')===listed.nextCursor;
  });
  await picker.getByRole('button',{name:'加载更多',exact:true}).click();
  const remainder=await (await secondPage).json();
  assert.equal(remainder.nextCursor,null,JSON.stringify(remainder));
  assert.ok(remainder.items.some(row=>row.id===manager.getSessionId()));
  await picker.getByRole('button',{name:'注意力阅读记录',exact:true}).waitFor();
  assert.equal(await picker.getByRole('button',{name:'保留的开发讨论',exact:true}).count(),0);
  await page.keyboard.press('Escape');
  await picker.waitFor({state:'hidden'});
  await first.click();
  await page.locator('h1').filter({hasText:a.name}).waitFor();
  await nav.getByRole('button',{name:b.name,exact:true}).click();
  await page.locator('article').getByText(/第 1 段阅读记录/).waitFor();
  await page.waitForFunction(()=>document.querySelector('[class*="conversationScroll"]')?.scrollTop>100);
  assert.deepEqual((await controller.session(manager.getSessionId())).view.anchor,anchor);
  await page.screenshot({path:join(screenshots,'compact-desktop.png')});
  await page.setViewportSize({width:800,height:600});
  await page.getByRole('button',{name:'切换导航',exact:true}).click();
  await page.getByRole('button',{name:'搜索',exact:true}).waitFor();
  await assertTeamOnly();
  await page.screenshot({path:join(screenshots,'compact-navigation-small.png')});
  await page.keyboard.press('Escape');
  await page.waitForFunction(()=>document.querySelector('[aria-label="切换导航"]')===document.activeElement);
  assert.equal(await page.getByRole('button',{name:'切换导航',exact:true}).evaluate(node=>node===document.activeElement),true);
  await page.screenshot({path:join(screenshots,'compact-small.png')});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth > innerWidth),false);
  assert.equal(f.calls.length,0);
  assert.deepEqual(errors,[]);
});

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
    await page.getByRole("button", {name:"查看本次更新",exact:true}).waitFor();
    assert.equal(f.calls.length,0,"dismissing the notice does not generate");
    await page.getByRole("button", {name:"对话",exact:true}).click();
    await page.getByRole("dialog", {name:"对话",exact:true})
      .getByRole("button", {name:"新建对话",exact:true}).click();
    await page.getByLabel("输入问题").fill("Keep my draft");
    await page.getByRole("button", {name:"添加本次操作"}).click();
    assert.equal(await page.getByText("本次允许读取项目文件",{exact:true}).count(),0);
    await page.keyboard.press('Escape');
    assert.equal(
      await page.getByLabel("输入问题").inputValue(),
      "Keep my draft",
    );
    assert.equal(f.calls.length, 0);
    await page.getByRole("button", {name:"新建 Team",exact:true}).click();
    const create = page.getByRole("dialog", {name:"新建 Team",exact:true});
    await create.getByLabel("名称",{exact:true}).fill("Visual project");
    await create.getByLabel("项目绝对路径").fill(repo.project);
    await create.getByRole("button", {name:"只读检查目录",exact:true}).click();
    await create.getByText(/目录已核对/).waitFor();
    await create.getByRole("button", {name:"创建",exact:true}).click();
    await create.waitFor({state:"hidden"});
    assert.equal(await page.getByLabel("对话模式").count(),0);
    await page.getByLabel("输入问题").fill("制作一个蓝色矩形");
    await page.getByRole('button',{name:'添加本次操作'}).click();
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
      method:'POST',headers:{Authorization:`Bearer ${h.token}`,'Content-Type':'application/json'},
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
    await page.getByRole('button',{name:'新建 Team',exact:true}).click();
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
  await page.getByRole('alert').filter({hasText:'本地或未知命令不能作为问题提交；请在交互界面使用本地命令。未发送模型请求。'}).waitFor();
  assert.equal(await input.inputValue(),'/browser-dialog');assert.equal(f.calls.length,0);assert.deepEqual(errors,[]);
});
