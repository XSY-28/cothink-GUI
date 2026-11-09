// Actual packaged Electron lifecycle tests. Run explicitly after building:
// COTHINK_DESKTOP_APP=/absolute/CoThink.app npm run test:desktop-app
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readdirSync,readFileSync,renameSync,mkdirSync,rmdirSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {_electron as electron} from 'playwright';
const appPath=process.env.COTHINK_DESKTOP_APP;
assert.ok(appPath,'COTHINK_DESKTOP_APP must name the actual isolated packaged App');
async function fixture(t) {
 const home=mkdtempSync(join(tmpdir(),'cothink-app-lifecycle-'));
 const app=await electron.launch({executablePath:join(appPath,'Contents/MacOS/CoThink'),args:[`--user-data-dir=${join(home,'chromium')}`],env:{...process.env,PATH:'/usr/bin:/bin:/usr/sbin:/sbin',NODE_OPTIONS:'',NODE_PATH:'',COTHINK_HOME:home,PI_OFFLINE:'1'},timeout:30000});
 const appProcess=app.process();
 t.after(async()=>{if(appProcess.exitCode===null && appProcess.signalCode===null){
   // Failure-fixture cleanup only: a forced kill is never counted as shutdown success.
   const exited=new Promise(resolve=>appProcess.once('exit',resolve));appProcess.kill('SIGKILL');await exited;
  }rmSync(home,{recursive:true,force:true});});
 const page=await app.firstWindow();await page.waitForURL('http://127.0.0.1:*/**');
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
test('actual App keeps native window buttons clear of the compact UI at both widths',async t=>{
 const f=await fixture(t);
 const position=await f.app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getWindowButtonPosition());
 assert.deepEqual(position,{x:18,y:21});
 const controls=await f.page.locator('.topbar button').evaluateAll(nodes=>nodes.map(node=>({drag:getComputedStyle(node).webkitAppRegion,left:node.getBoundingClientRect().left})));
 assert.ok(controls.every(control=>control.drag==='no-drag'));
 assert.equal(await f.page.getByRole('button',{name:'设置',exact:true}).count(),1);
 assert.equal(await f.page.getByRole('button',{name:'阵容',exact:true}).count(),1);
 if(process.env.COTHINK_UI_SCREENSHOTS)await f.page.screenshot({path:join(process.env.COTHINK_UI_SCREENSHOTS,'desktop-app.png')});
 await f.app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(800,600));
 const navigation=f.page.getByRole('button',{name:'切换导航',exact:true});
 await navigation.waitFor();
 assert.ok((await navigation.boundingBox()).x>=98,'collapsed toolbar clears native traffic lights');
 await navigation.click();
 await f.page.getByRole('button',{name:'搜索',exact:true}).waitFor();
 assert.equal(await f.page.getByRole('button',{name:'设置',exact:true}).count(),1);
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
