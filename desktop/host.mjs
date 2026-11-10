// Only built-ins may be imported before startup admission. Unified GUI runtimes
// retain this clean host; native plugins execute in the managed PROJECT runtime.
import {readFileSync, existsSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const here=fileURLToPath(new URL('.',import.meta.url));
const nonce=process.env.COTHINK_DESKTOP_NONCE;
function send(message) { if(process.connected) process.send(message,()=>{}); }
function startupError(code) {send({type:'startupError',nonce,code});process.exitCode=1;if(process.connected)process.disconnect();}
if (!process.send || !/^[\da-f-]{36}$/i.test(nonce ?? '') || process.env.NODE_OPTIONS || process.env.NODE_PATH || process.execArgv.length) {
  startupError('UNTRUSTED_STARTUP');
} else {
  let host, orphaned=false, shutdown, shutdownId, finalStop, stopped=false;
  const buildPath=join(here,'build.json');
  const packaged=existsSync(buildPath);
  const backend=packaged ? join(here,'backend') : resolve(here,'..');
  const build=packaged ? JSON.parse(readFileSync(buildPath)) : {
    buildId:createHash('sha256').update(readFileSync(join(here,'runtime-manifest.json'))).digest('hex'),protocolVersion:1,
    backendVersion:JSON.parse(readFileSync(join(backend,'package.json'))).version,
  };
  async function stop(requestId,finalize=true) {
    if(stopped || (shutdownId && requestId !== shutdownId)) return;
    shutdownId=requestId;
    if(!host) {orphaned=true;return;}
    send({type:'shutdownState',requestId,settled:false,reason:'正在停止所属任务并保存。',taskRefs:host.shutdownState().taskRefs ?? []});
    if(finalStop)return finalStop;
    if(!finalize)return drain(requestId,false);
    finalStop=drain(requestId,true).finally(()=>{finalStop=null;});
    return finalStop;
  }
  async function drain(requestId,finalize) {
    shutdown ??= host.beginShutdown().finally(()=>{shutdown=null;});
    const state=await shutdown;
    if(!state.settled) {send({type:'shutdownState',requestId,...state});return;}
    if(!finalize) {send({type:'shutdownState',requestId,...state});return;}
    try {
      await host.close();stopped=true;send({type:'stopped',requestId,settled:true});
      if(process.connected)process.disconnect();
      process.exitCode=0;
    } catch {
      send({type:'shutdownState',requestId,settled:false,reason:'停止或持久保存未确认；请保留窗口核对。',taskRefs:host.shutdownState().taskRefs});
    }
  }
  const orphan=()=>{orphaned=true;void stop(shutdownId ?? 'parent-disconnected');};
  process.on('disconnect',orphan);
  process.on('SIGTERM',orphan);process.on('SIGINT',orphan);
  process.on('message',message=>{
    if(message?.type !== 'prepareShutdown' || !/^[\da-f-]{36}$/i.test(message.requestId ?? '') ||
       Object.keys(message).some(k=>!['type','requestId','finalize'].includes(k)) ||
       message.finalize !== undefined && typeof message.finalize !== 'boolean') return;
    void stop(message.requestId,message.finalize !== false);
  });
  try {
    const home=resolve(process.env.COTHINK_HOME || join(homedir(),'.cothink'));
    const {neutralDirectory}=await import(pathToFileURL(join(backend,'src/conversation.js')));
    const {startGuiServer}=await import(pathToFileURL(join(backend,'src/gui-server.js')));
    host=await startGuiServer({home,cwd:neutralDirectory(home),port:0,open:false,suggestedProject:null,installation:'desktop',assetDirectory:join(backend,'gui/dist')});
    if(orphaned || !process.connected) await stop(shutdownId ?? 'parent-disconnected');
    else send({type:'ready',nonce,origin:host.origin,token:host.token,backendVersion:build.backendVersion,protocolVersion:build.protocolVersion,buildId:build.buildId});
  } catch {startupError('HOST_START_FAILED');}
}
