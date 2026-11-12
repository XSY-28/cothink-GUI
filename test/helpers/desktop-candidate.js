import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {fixture as modelFixture} from './pi-fixture.js';
import {_electron as electron} from 'playwright';
export const appPath=process.env.COTHINK_DESKTOP_APP;
assert.ok(appPath,'COTHINK_DESKTOP_APP must name the actual isolated packaged App');
export async function launchCandidate(t, seed, home=mkdtempSync(join(tmpdir(),'cothink-app-lifecycle-'))) {
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


export async function verifyPackagedExecution(t) {
 const backend=join(appPath,'Contents/Resources/app/backend');
 const load=path=>import(pathToFileURL(join(backend,path)));
 const content='Desktop managed fixture\n',finalText='桌面托管文件已完成。';
 const plan={goal:'Deliver desktop.txt',scope:['desktop.txt'],deliverables:['desktop.txt'],checks:[
  {command:'node',args:['-e',`if(require('node:fs').readFileSync('desktop.txt','utf8')!==${JSON.stringify(content)})process.exit(1)`]},
 ]};
 const replies=[
  {toolCalls:[{name:'start_work',args:{action:'start',reason:'managed desktop file',plan}}]},
  {toolCalls:[{name:'write',args:{path:'desktop.txt',content}}]},
  {toolCalls:[{name:'accept_change',args:{}}]},
  {text:finalText},
 ];
 const f=await modelFixture(t,(_,n)=>replies[n-1]??{text:finalText});
 const project=mkdtempSync(join(tmpdir(),'cothink-desktop-execution-'));
 t.after(()=>rmSync(project,{recursive:true,force:true}));
 let conversationPath;
 const execution=JSON.parse(readFileSync(new URL('../../packages/agent-sync/execution-manifest.json',import.meta.url))).execution;
 const {app,page,appProcess,home}=await launchCandidate(t,async home=>{
  const [{saveConfig},{createTeamConfig},{createGuiController}]=await Promise.all([
   load('src/config.js'),load('src/teams.js'),load('src/gui-controller.js'),
  ]);
  const rosterId=randomUUID();
  saveConfig(home,createTeamConfig({formatVersion:2,...f.models,work:{execution}},'Desktop execution fixture',rosterId));
  const controller=await createGuiController({home,suggestedProject:null});
  try {
   const workspace=await controller.action('workspace.create',{workspaceId:randomUUID(),name:'桌面文件验证',project,defaultRosterId:rosterId});
   const session=await controller.action('session.create',{workspaceId:workspace.id,sessionId:randomUUID()});
   conversationPath=session.project;
   assert.equal(existsSync(join(conversationPath,'.git')),false,'fixture seeding must leave Git initialization to the actual App');
  } finally { await controller.close(); }
 },f.home);
 const configBefore=readFileSync(join(home,'config.json'));
 try {
  await page.getByRole('button',{name:'设置',exact:true}).click();
  await page.getByRole('button',{name:'项目执行',exact:true}).click();
  const received=page.waitForResponse(response=>response.url().endsWith('/api/action')&&
   response.request().postDataJSON()?.action==='settings.inspectExecution');
  await page.getByRole('button',{name:'检查执行环境',exact:true}).click();
  const result=await(await received).json();
  assert.equal(result.diagnostic.status,'passed',JSON.stringify(result));
  assert.equal(result.probe.status,'passed',JSON.stringify(result));
  assert.ok(configBefore.equals(readFileSync(join(home,'config.json'))),'execution inspection must preserve fixture configuration');
  assert.equal(f.calls.length,0,'local execution inspection must send no model request');
  await page.getByRole('button',{name:'关闭设置',exact:true}).click();
  await page.getByLabel('输入问题',{exact:true}).fill('请创建 desktop.txt 文件，内容为 Desktop managed fixture 并换行。');
  await page.getByRole('button',{name:'发送',exact:true}).click();
  await page.getByRole('button',{name:'确认上述计划并执行',exact:true}).click();
  const outcome=page.getByRole('article').filter({hasText:finalText});
  await outcome.getByRole('button',{name:/desktop\.txt/}).click({timeout:30000});
  const files=page.getByRole('region',{name:'成果文件阅读'});
  await files.getByText('已放入对话文件夹。',{exact:true}).waitFor();
  await files.getByText('Desktop managed fixture',{exact:true}).waitFor();
  assert.equal(readFileSync(join(conversationPath,'desktop.txt'),'utf8'),content);
  assert.equal(existsSync(join(conversationPath,'.git')),true,'actual App file work must prepare its own Git repository');
  assert.equal(existsSync(join(project,'.git')),false,'Team parent must stay outside the conversation Git repository');
  assert.equal(f.calls.length,4,'one plan plus managed write, acceptance and final explanation');
 } finally {
  const closed=app.waitForEvent('close');await app.evaluate(({app})=>app.quit());await closed;
  assert.equal(appProcess.exitCode,0);
 }
}
