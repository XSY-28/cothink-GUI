import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

export async function verifyPackagedTeamPortraits(t,{appPath,launchCandidate}) {
 const backend=join(appPath,'Contents/Resources/app/backend');
 const artworkDir=join(backend,'gui/src/assets/team-avatars/assets/barbidou');
 const artwork=['chat-static.png','sidebar-foreground.png','sidebar-motion-atlas.png'].map(name=>existsSync(join(artworkDir,name)));
 const hasArtwork=artwork[0];
 assert.ok(artwork.every(present=>present===hasArtwork),'the optional Barbidou artwork is packaged as a complete set');
 const load=path=>import(pathToFileURL(join(backend,path)));
 const teamName='头像验收 Team';
 const replyText='这是一条预先保存的桌面头像验收回复。';
 const {app,page,appProcess}=await launchCandidate(t,async home=>{
  const [{createGuiWorkspace},{createTask},{SessionManager}]=await Promise.all([
   load('src/gui-workspace-state.js'),
   load('src/task.js'),
   load('node_modules/@earendil-works/pi-coding-agent/dist/index.js'),
  ]);
  const workspaceId='7c8094cd-3476-4bfa-8f53-000000000001';
  createGuiWorkspace(home,{workspaceId,name:teamName,project:null,defaultRosterId:null});
  const manager=SessionManager.create(home,join(home,'pi/sessions/main'));
  manager.appendCustomEntry('cothink-project',{project:null});
  manager.appendCustomEntry('cothink-gui-workspace',{workspaceId});
  manager.appendCustomEntry('cothink-title',{title:'头像验收对话'});
  // Seed saved request and history through the same APIs as the Chromium fixture.
  const input='请验证已保存的 Team 回复。';
  const models={main:{provider:'fixture',modelId:'main'},secondary:[]};
  const task=createTask({home,input,models,sessionId:manager.getSessionId(),singleModel:true});
  const request={id:randomUUID(),taskId:task.record.id,status:'completed',sent:false,events:[],text:replyText};
  task.register(request);
  task.writeRequest(request);
  task.record.finalCallId=request.id;
  task.finish('completed');
  manager.appendCustomEntry('cothink-task',{taskId:task.record.id});
  manager.appendMessage({role:'user',content:input,timestamp:Date.now()});
  manager.appendMessage({role:'assistant',content:[{type:'text',text:replyText}],api:'openai-completions',provider:'fixture',model:'main',usage:{input:0,output:0,totalTokens:0,cost:{input:0,output:0,total:0}},stopReason:'stop',timestamp:Date.now()});
 });
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1280,880));
 const rail=page.getByRole('navigation',{name:'工作导航'});
 const team=rail.getByRole('button',{name:teamName,exact:true});
 await team.waitFor({state:'visible'});
 const name=rail.getByText(teamName,{exact:true});
 assert.equal(await name.isVisible(),false,'Team name is hidden before hover');
 await team.click();
 await page.getByText(replyText,{exact:true}).waitFor();
 await page.getByText(replyText,{exact:true}).hover();
 assert.equal(await name.isVisible(),false,'selection does not reveal the Team name');

 const replyBadge=page.locator('[data-reading-part="result"] header [data-team-avatar]');
 const replyAvatar=replyBadge.locator('img');
 assert.equal(await replyBadge.getAttribute('data-team-avatar'),'barbidou');
 if(hasArtwork){
  const replyImage=await replyAvatar.evaluate(async image=>{
   await image.decode();
   return {src:image.currentSrc,width:image.naturalWidth,height:image.naturalHeight,radius:getComputedStyle(image).borderRadius};
  });
  assert.equal(new URL(replyImage.src).origin,new URL(page.url()).origin);
  assert.equal(replyImage.width,128);
  assert.equal(replyImage.height,128);
  assert.equal(replyImage.radius,'50%');
  const imageResponse=await page.request.get(replyImage.src);
  assert.equal(imageResponse.status(),200);
  assert.equal(imageResponse.headers()['content-type'],'image/png');
  assert.deepEqual(await imageResponse.body(),readFileSync(join(artworkDir,'chat-static.png')));
 } else {
  await replyBadge.locator(':scope > span').waitFor({state:'visible'});
  assert.equal(await replyAvatar.count(),0,'the reply uses a visible placeholder without an image request');
 }
 const staticReply=await replyBadge.screenshot();

 // Real native pointer movement can interrupt an automated macOS hover.
 // Keep real pointer/paint checks, then advance the renderer clock for dwell.
 await page.clock.install();
 const trigger=team.locator('[data-team-avatar-trigger]');
 const canvas=trigger.locator('canvas');
 const sidebarBadge=trigger.locator('[data-team-avatar]');
 assert.equal(await sidebarBadge.getAttribute('data-team-avatar'),'barbidou');
 const sidebarPlaceholder=sidebarBadge.locator(':scope > span');
 const hoverDiagnostics=await trigger.evaluateHandle(element=>{
  const trace=[];
  function record(event) {
   trace.push({event:event.type,at:performance.now(),x:event.clientX,y:event.clientY,related:event.relatedTarget?.tagName,
    focused:document.hasFocus(),hidden:document.hidden,inert:!!element.closest('[inert]')});
  }
  for(const type of ['pointerenter','pointerleave','pointercancel'])element.addEventListener(type,record);
  for(const type of ['blur','focus','resize'])window.addEventListener(type,record);
  document.addEventListener('visibilitychange',record);
  document.addEventListener('scroll',record,true);
  return trace;
 });
 let canvasHandle,idle;
 if(hasArtwork){
  canvasHandle=await canvas.elementHandle();
  idle=await page.waitForFunction(canvas=>{
   const context=canvas.getContext('2d');
   const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;
   if(pixels.some((value,index)=>index%4===3&&value>0))return canvas.toDataURL();
  },canvasHandle).then(result=>result.jsonValue());
 } else {
  await sidebarPlaceholder.waitFor({state:'visible'});
  assert.equal(await sidebarBadge.locator('img, canvas').count(),0,'the Team displays its placeholder without broken artwork');
 }
 await trigger.evaluate(element=>{
  element.addEventListener('pointerenter',()=>{element.avatarTestHoverStarted=performance.now();},{once:true});
 });
 await trigger.hover();
 const hoverStart=await trigger.evaluate(element=>element.avatarTestHoverStarted);
 assert.equal(typeof hoverStart,'number','pointer reached the avatar hit area');
 assert.equal(await name.isVisible(),false,'the name stays hidden when the pointer arrives');
 if(hasArtwork){
  const firstMotion=await page.waitForFunction(({canvas,idle})=>{
   const pixels=canvas.toDataURL();
   return pixels!==idle&&pixels;
  },{canvas:canvasHandle,idle}).then(result=>result.jsonValue());
  await page.waitForFunction(({canvas,idle,firstMotion})=>{
   const pixels=canvas.toDataURL();
   return pixels!==idle&&pixels!==firstMotion;
  },{canvas:canvasHandle,idle,firstMotion});
 }
 const elapsed=await trigger.evaluate(element=>performance.now()-element.avatarTestHoverStarted);
 await page.clock.fastForward(Math.max(0,Math.floor(1750-elapsed)));
 assert.equal(await name.isVisible(),false,'the name is still hidden before the 2-second threshold');
 await page.clock.fastForward(350);
 try {
  await name.waitFor({state:'visible',timeout:5000});
 } catch (error) {
  throw new Error('Desktop hover did not reveal the name: '+JSON.stringify(await hoverDiagnostics.jsonValue()),{cause:error});
 }
 const shownAt=await name.evaluate(()=>performance.now());
 assert.ok(shownAt-hoverStart>=1950,'the visible name waits for the 2-second hover dwell');
 assert.deepEqual(await replyBadge.screenshot(),staticReply,'the reply portrait stays static while hovering over the sidebar');
 await replyBadge.hover();
 assert.equal(await name.isVisible(),false,'moving away hides the Team name');
 if(hasArtwork){
  assert.equal(await canvas.evaluate(canvas=>canvas.toDataURL()),idle,'moving away restores the idle portrait');
 } else {
  assert.equal(await sidebarPlaceholder.isVisible(),true,'the placeholder remains visible after the hover ends');
  assert.equal(await sidebarBadge.locator('img, canvas').count(),0,'hovering does not start artwork without assets');
 }
 assert.deepEqual(await replyBadge.screenshot(),staticReply,'hovering over the reply portrait does not animate it');
 const closed=app.waitForEvent('close');
 await app.evaluate(({app})=>app.quit());
 await closed;
 assert.equal(appProcess.exitCode,0);
}
