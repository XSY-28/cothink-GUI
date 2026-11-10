// Actual packaged Electron interaction and lifecycle tests. Run explicitly after building:
// COTHINK_DESKTOP_APP=/absolute/CoThink.app npm run test:desktop-app
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdtempSync,readdirSync,readFileSync,renameSync,mkdirSync,rmdirSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {_electron as electron} from 'playwright';
import {verifyPackagedTeamPortraits} from './helpers/desktop-team-portrait.js';
const appPath=process.env.COTHINK_DESKTOP_APP;
assert.ok(appPath,'COTHINK_DESKTOP_APP must name the actual isolated packaged App');
async function launchCandidate(t, seed) {
 const home=mkdtempSync(join(tmpdir(),'cothink-app-lifecycle-'));
 let app;
 try {
  await seed?.(home);
  app=await electron.launch({executablePath:join(appPath,'Contents/MacOS/CoThink'),args:[`--user-data-dir=${join(home,'chromium')}`],env:{...process.env,PATH:'/usr/bin:/bin:/usr/sbin:/sbin',NODE_OPTIONS:'',NODE_PATH:'',COTHINK_HOME:home,PI_OFFLINE:'1'},timeout:30000});
 } catch (error) {
  rmSync(home,{recursive:true,force:true});
  throw error;
 }
 const appProcess=app.process();
 t.after(async()=>{if(appProcess.exitCode===null && appProcess.signalCode===null){
   // Failure-fixture cleanup only: a forced kill is never counted as shutdown success.
   const exited=new Promise(resolve=>appProcess.once('exit',resolve));appProcess.kill('SIGKILL');await exited;
  }rmSync(home,{recursive:true,force:true});});
 const page=await app.firstWindow();await page.waitForURL('http://127.0.0.1:*/**');
 return {home,app,page,appProcess};
}
async function fixture(t) {
 const {home,app,page,appProcess}=await launchCandidate(t);
 await page.getByRole('navigation',{name:'工作导航'}).getByRole('button',{name:'新建',exact:true}).click();
 await page.getByRole('button',{name:'新建 Team',exact:true}).click();
 const creating=page.getByRole('dialog',{name:'新建 Team',exact:true});
 await creating.getByLabel('名称',{exact:true}).fill('Lifecycle');
 const actionReceipt=(name,matches=()=>true)=>page.waitForResponse(response=>{
  if(!response.url().endsWith('/api/action')||!response.ok())return false;
  const body=response.request().postDataJSON();
  return body?.action===name&&matches(body.args);
 });
 const created=actionReceipt('session.create');
 await creating.getByRole('button',{name:'创建',exact:true}).click();
 await creating.waitFor({state:'hidden'});
 const createdSession=await (await created).json();
 const editor=page.getByLabel('输入问题',{exact:true});
 await editor.waitFor({state:'visible'});
 assert.equal(await editor.evaluate(node=>!!node.closest('[inert]')),false);
 assert.equal(await page.getByText('首次发送将建立未分组对话。',{exact:true}).count(),0);
 const saved=actionReceipt('session.draft',args=>args.sessionId===createdSession.id&&args.text==='original saved draft');
 await editor.click();
 await editor.pressSequentially('original saved draft');
 assert.equal(await editor.inputValue(),'original saved draft');
 const receipt=await (await saved).json();
 assert.equal(receipt.editor.text,'original saved draft');
 // Use the actual spawned child and preserve its real message payload. Only
 // delay phase-one delivery, making the review's message-order window deterministic.
 await app.evaluate(({dialog})=>{
  globalThis.desktopTest={dialogs:[],held:[],defer:true};
  dialog.showMessageBox=async(...args)=>{desktopTest.dialogs.push(args.at(-1).message);return {response:0};};
  const child=process._getActiveHandles().find(h=>h.constructor?.name==='ChildProcess'&&h.connected);
  if(!child)throw Error('owned child missing');desktopTest.child=child;
  const emit=child.emit;
  desktopTest.deliver=()=>{desktopTest.defer=false;for(const m of desktopTest.held.splice(0))emit.call(child,'message',m);};
  child.emit=function(event,...args){if(event==='message'&&args[0]?.type==='shutdownState'&&args[0].settled&&desktopTest.defer){desktopTest.held.push(args[0]);return true;}return emit.call(this,event,...args);};
 });
 const sessions=join(home,'pi/sessions/main');
 const sessionFile=readdirSync(sessions).filter(name=>name.endsWith('.jsonl')).map(name=>join(sessions,name)).find(path=>
  JSON.parse(readFileSync(path,'utf8').split('\n')[0]).id===createdSession.id);
 assert.ok(sessionFile,'draft receipt identifies the new persisted session');
 const draft=readFileSync(sessionFile,'utf8').trim().split('\n').map(JSON.parse).findLast(row=>row.customType==='cothink-draft');
 assert.equal(draft?.data.text,'original saved draft');
 assert.equal(draft?.data.editId,receipt.editor.editId);
 return {home,app,page,sessionFile,appProcess};
}
async function pendingQuit(f) {
 await f.app.evaluate(({app})=>app.quit());
 for(let n=0;n<100;n++){if(await f.app.evaluate(()=>desktopTest.held.length))return;await new Promise(r=>setTimeout(r,10));}
 throw Error('phase-one receipt not observed');
}
test('packaged Team portraits reveal the name only after hover dwell',async t=>{
 await verifyPackagedTeamPortraits(t,{appPath,launchCandidate});
});

async function preservePasteboard(testText, run) {
 // Keep every representation in memory, including images and Finder items.
 // Restore only if our unique fixture text is still on the pasteboard.
 const helper = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `
  ObjC.import('AppKit');
  function run(argv) {
   const pasteboard = $.NSPasteboard.generalPasteboard;
   const saved = $.NSMutableArray.alloc.init;
   for (const original of pasteboard.pasteboardItems.js || []) {
    const item = $.NSPasteboardItem.alloc.init;
    for (const type of original.types.js) {
     if (!item.setDataForType(original.dataForType(type), type))
      throw Error('Cannot preserve this pasteboard representation');
    }
    saved.addObject(item);
   }
   $.NSFileHandle.fileHandleWithStandardOutput.writeData($('ready\\n').dataUsingEncoding($.NSUTF8StringEncoding));
   $.NSFileHandle.fileHandleWithStandardInput.readDataOfLength(1);
   if (ObjC.unwrap(pasteboard.stringForType($.NSPasteboardTypeString)) === argv[0]) {
    pasteboard.clearContents;
    if (saved.count && !pasteboard.writeObjects(saved)) throw Error('Could not restore the pasteboard');
   }
  }
 `, testText], {stdio:['pipe','pipe','inherit']});
 const exited = once(helper, 'exit');
 await Promise.race([
  once(helper.stdout, 'data'),
  exited.then(([code]) => { throw Error(`Pasteboard preservation could not start (${code})`); }),
 ]);
 try {
  await run();
 } finally {
  helper.stdin.end();
  assert.deepEqual(await exited, [0, null], 'the original pasteboard was preserved');
 }
}

test('packaged copy buttons write original text to the system clipboard', {timeout:30000}, async t=>{
 const backend = join(appPath, 'Contents/Resources/app/backend');
 const load = path => import(pathToFileURL(join(backend, path)));
 const input = `用户消息：保留空格  😀\n第二行 ${randomUUID()}`;
 const code = `const 消息 = "保留空格  😀";\n// ${randomUUID()}\n`;
 const reply = '助手回复：保留原文\n\n**第二段**\n\n```js\n' + code + '```';
 const teamName = '剪贴板验收';
 const {app,page} = await launchCandidate(t, async home=>{
  const [{createGuiWorkspace},{createTask},{SessionManager}] = await Promise.all([
   load('src/gui-workspace-state.js'),
   load('src/task.js'),
   load('node_modules/@earendil-works/pi-coding-agent/dist/index.js'),
  ]);
  const workspaceId = randomUUID();
  createGuiWorkspace(home, {workspaceId, name:teamName, project:null, defaultRosterId:null});
  const manager = SessionManager.create(home, join(home,'pi/sessions/main'));
  manager.appendCustomEntry('cothink-project', {project:null});
  manager.appendCustomEntry('cothink-gui-workspace', {workspaceId});
  const models = {main:{provider:'fixture',modelId:'main'},secondary:[]};
  const task = createTask({home,input,models,sessionId:manager.getSessionId(),singleModel:true});
  const request = {id:randomUUID(),taskId:task.record.id,status:'completed',sent:false,events:[],text:reply};
  task.register(request);
  task.writeRequest(request);
  task.record.finalCallId = request.id;
  task.finish('completed');
  manager.appendCustomEntry('cothink-task', {taskId:task.record.id});
  manager.appendMessage({role:'user',content:input,timestamp:Date.now()});
  manager.appendMessage({
   role:'assistant',content:[{type:'text',text:reply}],api:'openai-completions',provider:'fixture',model:'main',
   usage:{input:0,output:0,totalTokens:0,cost:{input:0,output:0,total:0}},stopReason:'stop',timestamp:Date.now(),
  });
 });
 await page.getByRole('navigation', {name:'工作导航'}).getByRole('button', {name:teamName, exact:true}).click();
 await page.locator('[data-reading-part="input"]').getByText('用户消息：保留空格').hover();
 const messages = '未能访问系统剪贴板，请手动选中文字复制。';
 const cases = [
  ['复制消息', input, '已复制原文', messages],
  ['复制原文', reply, '已复制原文', messages],
  ['复制代码', code, '已复制', '复制失败，请手动选中'],
 ];
 for (const [name,text,success,failure] of cases) {
  const copied = page.getByText(success, {exact:true});
  const failed = page.getByText(failure, {exact:true});
  await preservePasteboard(text, async ()=>{
   await page.getByRole('button', {name,exact:true}).click();
   assert.equal(await copied.or(failed).textContent({timeout:4000}), success);
   const matches = await app.evaluate(({clipboard}, expected)=>clipboard.readText() === expected, text);
   assert.equal(matches, true, `${name} preserves Unicode, whitespace and line breaks in the native clipboard`);
  });
  if (name === '复制消息') await copied.waitFor({state:'hidden',timeout:6000});
 }
 const closed = app.waitForEvent('close');
 await app.evaluate(({app})=>app.quit());
 await closed;
});

test('actual App keeps native window buttons clear of the compact UI at both widths',async t=>{
 const f=await fixture(t);
 const rail=f.page.getByRole('navigation',{name:'工作导航'});
 const assertRail=async()=>{
  const railBox=await rail.boundingBox();
  assert.ok(railBox && Math.abs(railBox.x)<=2 && railBox.width<=96,'Team rail is narrow and aligned to the left edge');
  const boxes=[];
  for(const name of ['新建','搜索','设置']){
   const button=rail.getByRole('button',{name,exact:true});
   assert.equal(await button.count(),1);
   assert.equal((await button.innerText()).trim(),'','the navigation action is icon-only');
   const box=await button.boundingBox();
   const icon=await button.locator('svg').boundingBox();
   assert.ok(box && icon && icon.width>=20 && icon.height>=20,'the navigation action has a larger visible icon');
   boxes.push(box);
  }
  const column=boxes[0].x+boxes[0].width/2;
  assert.ok(boxes.every(box=>Math.abs(box.x+box.width/2-column)<=2),'navigation actions share one column');
  assert.ok(boxes.every((box,index)=>!index || box.y>=boxes[index-1].y+boxes[index-1].height),'navigation actions are stacked vertically');
  const bottomGap=railBox.y+railBox.height-boxes[2].y-boxes[2].height;
  assert.ok(bottomGap>=0 && bottomGap<=36,'navigation actions sit at the bottom of the rail');
  const avatar=await rail.getByRole('button',{name:'Lifecycle',exact:true}).locator('[data-team-avatar-trigger]').boundingBox();
  assert.ok(avatar && avatar.width>=40 && avatar.height>=40,'Team avatars are larger in the narrow rail');
 };
 const position=await f.app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getWindowButtonPosition());
 assert.deepEqual(position,{x:18,y:21});
 const controls=await f.page.locator('.topbar button').evaluateAll(nodes=>nodes.map(node=>({drag:getComputedStyle(node).webkitAppRegion,left:node.getBoundingClientRect().left})));
 assert.ok(controls.every(control=>control.drag==='no-drag'));
 await assertRail();
 assert.equal(await f.page.getByRole('button',{name:'阵容',exact:true}).count(),1);
 if(process.env.COTHINK_UI_SCREENSHOTS)await f.page.screenshot({path:join(process.env.COTHINK_UI_SCREENSHOTS,'desktop-app.png')});
 await f.app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(800,600));
 const navigation=f.page.getByRole('button',{name:'切换导航',exact:true});
 await navigation.waitFor();
 assert.ok((await navigation.boundingBox()).x>=98,'collapsed toolbar clears native traffic lights');
 await navigation.click();
 await f.page.getByRole('button',{name:'搜索',exact:true}).waitFor();
 await assertRail();
 if(process.env.COTHINK_UI_SCREENSHOTS)await f.page.screenshot({path:join(process.env.COTHINK_UI_SCREENSHOTS,'desktop-app-small.png')});
 await f.page.getByRole('button',{name:'关闭导航',exact:true}).click({position:{x:750,y:300}});
 await f.app.evaluate(()=>desktopTest.deliver());
 const closed=f.app.waitForEvent('close');await f.app.evaluate(({app})=>app.quit());await closed;
});
test('actual App final flush saves edits made while drain acknowledgement is pending',async t=>{
 const f=await fixture(t);await pendingQuit(f);
 // Old shell already acknowledged the first flush here; new shell waits.
 await f.page.waitForTimeout(100);
 await f.page.getByLabel('输入问题',{exact:true}).fill('latest before final drain');
 await f.app.evaluate(()=>{
  const child=desktopTest.child,send=child.send;
  child.send=function(message,...args){
   if(message?.type==='prepareShutdown'&&message.finalize===true){desktopTest.finalize=()=>send.call(child,message,...args);return true;}
   return send.call(this,message,...args);
  };
  desktopTest.deliver();
 });
 for(let n=0;n<100 && !(await f.app.evaluate(()=>!!desktopTest.finalize));n++)await new Promise(r=>setTimeout(r,10));
 assert.equal(await f.page.evaluate(()=>document.body.inert),true,'final acknowledgement must freeze all draft controls');
 await f.page.keyboard.type('must not append after acknowledgement');
 assert.equal(await f.page.getByLabel('输入问题',{exact:true}).inputValue(),'latest before final drain');
 const closed=f.app.waitForEvent('close');await f.app.evaluate(()=>desktopTest.finalize());await closed;
 assert.match(readFileSync(f.sessionFile,'utf8'),/latest before final drain/);
});
test('actual App stays readable and editable when the final draft append fails',async t=>{
 const f=await fixture(t);await pendingQuit(f);await f.page.waitForTimeout(100);
 await f.page.getByLabel('输入问题',{exact:true}).fill('latest cannot be saved');
 renameSync(f.sessionFile,f.sessionFile+'.original');mkdirSync(f.sessionFile);
 t.after(()=>{try{rmdirSync(f.sessionFile);renameSync(f.sessionFile+'.original',f.sessionFile);}catch{}});
 await f.app.evaluate(()=>desktopTest.deliver());
 for(let n=0;n<500 && !(await f.app.evaluate(()=>desktopTest.dialogs.length));n++)await new Promise(r=>setTimeout(r,10));
 assert.match(readFileSync(f.sessionFile+'.original','utf8'),/original saved draft/);
 assert.doesNotMatch(readFileSync(f.sessionFile+'.original','utf8'),/latest cannot be saved/);
 assert.equal(f.appProcess.exitCode,null);
 const state=await f.app.evaluate(({BrowserWindow})=>({visible:BrowserWindow.getAllWindows()[0].isVisible(),dialogs:desktopTest.dialogs}));
 assert.equal(state.visible,true);assert.match(state.dialogs.join(' '),/草稿尚未保存/);
 assert.equal(await f.page.evaluate(()=>document.body.inert),false);
 assert.equal(await f.page.getByLabel('输入问题',{exact:true}).inputValue(),'latest cannot be saved');
 // Restore the original fixture file; leave the app's uncertain in-memory state
 // to its existing recovery behavior, never declare a failed save successful.
 rmdirSync(f.sessionFile);renameSync(f.sessionFile+'.original',f.sessionFile);
 await f.app.evaluate(()=>desktopTest.child.kill('SIGKILL'));
 await f.page.waitForTimeout(100);
});
test('actual App retains its review window if the child dies after phase one but before stopped receipt',async t=>{
 const f=await fixture(t);await pendingQuit(f);
 await f.app.evaluate(()=>{
  const child=desktopTest.child,send=child.send;
  child.send=function(message,...args){
   if(message?.type==='prepareShutdown'&&message.finalize===true){child.kill('SIGKILL');return true;}
   return send.call(this,message,...args);
  };
  desktopTest.deliver();
 });
 for(let n=0;n<100;n++){
  const dialogs=await f.app.evaluate(()=>desktopTest.dialogs);
  if(dialogs.some(s=>s.includes('未收到最终停止确认')))break;
  await new Promise(r=>setTimeout(r,10));
 }
 assert.equal(f.appProcess.exitCode,null);
 const state=await f.app.evaluate(({BrowserWindow})=>({visible:BrowserWindow.getAllWindows()[0].isVisible(),dialogs:desktopTest.dialogs}));
 assert.equal(state.visible,true);assert.match(state.dialogs.join(' '),/SIGKILL.*未收到最终停止确认/);
 assert.equal(await f.page.evaluate(()=>document.body.inert),false);
 const closed=f.app.waitForEvent('close',{timeout:3000});
 await f.app.evaluate(({Menu})=>Menu.getApplicationMenu().items.find(i=>i.label==='CoThink').submenu.items.find(i=>i.label==='退出 CoThink').click());
 await closed;
 assert.equal(f.appProcess.exitCode,0,'explicit user Quit must terminate normally after inspecting an unconfirmed child stop');
 assert.equal(f.appProcess.signalCode,null);
});
test('actual renderer crash keeps the host and reopens only the saved draft after explicit reload',async t=>{
 const f=await fixture(t);
 await f.app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
 for(let n=0;n<100 && !(await f.app.evaluate(()=>desktopTest.dialogs.length));n++)await new Promise(r=>setTimeout(r,10));
 assert.match((await f.app.evaluate(()=>desktopTest.dialogs)).join(' '),/页面进程已停止/);
 const recovered=await f.app.evaluate(async({Menu,dialog,BrowserWindow})=>{
  dialog.showMessageBox=async()=>({response:1});
  const wc=BrowserWindow.getAllWindows()[0].webContents;
  const loaded=new Promise(resolve=>wc.once('did-finish-load',resolve));
  await Menu.getApplicationMenu().items.find(i=>i.label==='窗口').submenu.items.find(i=>i.label==='重新打开已保存页面').click();
  await loaded;
  return wc.executeJavaScript(`new Promise(resolve=>{let n=0;const poll=setInterval(()=>{const value=document.querySelector('#message-input')?.value;if(value||++n>100){clearInterval(poll);resolve(value);}},20);})`);
 });
 assert.equal(recovered,'original saved draft');
 const closed=f.app.waitForEvent('close');await f.app.evaluate(({app})=>{desktopTest.defer=false;app.quit();});await closed;
});
