import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
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
