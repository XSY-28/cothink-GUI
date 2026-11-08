// This module is loaded by the entrypoint before any user extension. The launcher
// owns process lifetime; a session's dispose callback is not a stopping proof.
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,existsSync,realpathSync,mkdirSync,writeFileSync,renameSync,openSync,fsyncSync,closeSync,accessSync,constants,readdirSync} from 'node:fs';
import {join,resolve,relative,isAbsolute,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
const root=fileURLToPath(new URL('../',import.meta.url));
const hash=value=>createHash('sha256').update(value).digest('hex');
const error=message=>Object.assign(new Error(message),{code:'PROJECT_HANDOFF_BLOCKED'});
export function verifiedHandoffLauncher(){
 if(process.platform!=='darwin')throw error('此平台尚无可信旧宿主迁移观察器，请使用新的 cothink --project 入口。');
 const dir=join(root,'vendor','project-handoff',`darwin-${process.arch}`),binary=join(dir,'watch');
 const manifest=JSON.parse(readFileSync(join(dir,'manifest.json'),'utf8'));
 if(manifest.platform!=='darwin'||manifest.arch!==process.arch||hash(readFileSync(binary))!==manifest.sha256||hash(readFileSync(join(root,'native/project-handoff-watch.c')))!==manifest.sourceSha256)throw error('旧宿主迁移观察器的平台或摘要不符；未启动迁移。');
 accessSync(binary,constants.X_OK);
 return binary;
}

export function assertNoUnknownHandoff(home,cwd){
 const directory=join(home,'pi/handoffs');if(!existsSync(directory))return;
 const target=realpathSync(cwd);
 for(const name of readdirSync(directory).filter(n=>n.endsWith('.json'))){
  let record;try{record=JSON.parse(readFileSync(join(directory,name),'utf8'));}catch{throw error('旧宿主交接记录不可读，项目启动已阻塞。');}
  if(['pending','blocked'].includes(record.status)&&realpathSync(record.cwd)===target)throw error('此项目仍有停止状态未知的旧宿主交接；原记录 '+join(directory,name)+'，不能借新进程清除未知状态。');
 }
}

let supervised=false,bootState,sequence=0;const pending=new Map();
function rpc(type,data){
 if(!supervised||!process.connected)return Promise.reject(error('当前进程没有可信启动器监督，不能自动迁移；请保留草稿并使用新的 cothink --project。'));
 const id=++sequence;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});process.send({cothinkHandoff:type,id,data},e=>{if(e){pending.delete(id);reject(e)}})});
}
export async function beforeHostExtensionImport(){
 if(!supervised)return;
 await rpc('arm'); // Unavailable proof blocks migration, not ordinary extension use.
}
export async function migrateHostSession(state){return rpc('migrate',state);}
function privateWrite(path,value){
 mkdirSync(resolve(path,'..'),{recursive:true,mode:0o700});const temp=path+'.'+randomUUID()+'.tmp';
 const fd=openSync(temp,'wx',0o600);try{writeFileSync(fd,value);fsyncSync(fd);}finally{closeSync(fd);}renameSync(temp,path);
}
function snapshotState(home,state,oldPid){
 if(!state||!Array.isArray(state.entries)||state.entries.length===0||typeof state.sessionFile!=='string'||typeof state.cwd!=='string')throw error('会话交接材料不完整。');
 const sessions=realpathSync(join(home,'pi/sessions/main')),file=join(realpathSync(dirname(state.sessionFile)),basename(state.sessionFile)),rel=relative(sessions,file);
 if(!rel||isAbsolute(rel)||rel.startsWith('..')||!file.endsWith('.jsonl'))throw error('会话交接路径不在当前数据根。');
 const head=state.entries[0];if(head.type!=='session'||typeof head.id!=='string'||head.cwd!==state.cwd)throw error('会话交接身份不一致。');
 if(state.leafId!==null&&!state.entries.some(e=>e.id===state.leafId))throw error('会话交接分支不存在。');
 const bytes=state.entries.map(e=>JSON.stringify(e)+'\n').join('');
 const previous=existsSync(file)?readFileSync(file,'utf8'):null;
 if(previous!==null){const actual=previous.trim().split('\n').map(l=>JSON.parse(l));if(JSON.stringify(actual)!==JSON.stringify(state.entries))throw error('保存的历史与迁移快照不一致；保留原文件。');}
 const id=randomUUID(),path=join(home,'pi/handoffs',id+'.json');
 const record={schemaVersion:1,id,status:'pending',oldPid,sessionFile:file,sessionId:head.id,leafId:state.leafId,cwd:state.cwd,entries:state.entries,previousSha256:previous===null?null:hash(previous),snapshotSha256:hash(bytes),createdAt:new Date().toISOString()};
 privateWrite(path,JSON.stringify(record,null,2)+'\n');return {record,path,bytes};
}
async function supervise(args){
 const home=resolve(process.env.COTHINK_HOME||join(homedir(),'.cothink'));let restore;
 while(true){
  let binary;try{binary=verifiedHandoffLauncher();}catch{}
  let unknown=!binary,armed=false,terminal,childPid,migration,armRequest,spawnError,blockedRecord,buffer='';
  const binaryArgs=binary?[process.execPath,join(root,'bin/cothink.js'),...args]:[join(root,'bin/cothink.js'),...args];
  const child=spawn(binary??process.execPath,binaryArgs,{cwd:process.cwd(),env:{...process.env,COTHINK_SUPERVISED_CHILD:'1'},stdio:binary?['inherit','inherit','inherit','ipc','pipe','pipe']:['inherit','inherit','inherit','ipc']});
  const reply=(id,result,problem)=>{if(child.connected)child.send({cothinkHandoff:'reply',id,result,error:problem})};
  child.on('error',e=>{spawnError=e;unknown=true;});
  const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
  if(binary)child.stdio[4].on('data',data=>{
   buffer+=data;let line;while((line=buffer.indexOf('\n'))>=0){const value=buffer.slice(0,line);buffer=buffer.slice(line+1);const match=/^(START|ARMED|FORK|UNKNOWN|EXIT_CLEAN|EXIT_UNKNOWN|EXIT_UNARMED) (\d+)$/.exec(value);
    if(!match){unknown=true;continue;}const [,kind,num]=match;
    if(kind==='START')childPid=Number(num);
    else if(kind==='ARMED'){armed=true;if(armRequest!==undefined){reply(armRequest,{available:!unknown});armRequest=undefined;}}
    else if(kind==='FORK'||kind==='UNKNOWN')unknown=true;
    else terminal={kind,code:Number(num)};
   }
  });
  child.on('message',message=>{
   if(!message||typeof message.cothinkHandoff!=='string')return;
   const {id,data}=message;
   try{
    if(message.cothinkHandoff==='boot'){reply(id,{restore});return;}
    if(message.cothinkHandoff==='arm'){
     if(armed||unknown){reply(id,{available:armed&&!unknown});return;}
     if(armRequest!==undefined)throw error('重复的迁移观察器启动请求。');
     armRequest=id;child.stdio[5].write('ARM\n');return;
    }
    if(message.cothinkHandoff==='migrate'){
     if(unknown||!armed||migration){
      if(!blockedRecord){blockedRecord=snapshotState(home,data,childPid??child.pid);blockedRecord.record.status='blocked';blockedRecord.record.reason='No continuous no-fork proof for the original host';privateWrite(blockedRecord.path,JSON.stringify(blockedRecord.record,null,2)+'\n');}
      throw error('旧宿主存在未登记派生动作，或缺少连续内核观察证据；草稿保留，迁移已阻塞。');
     }
     migration=snapshotState(home,data,childPid??child.pid);migration.record.oldPid=childPid;reply(id,{saved:true});return;
    }
    throw error('未知会话交接消息。');
   }catch(e){reply(id,null,e.message);}
  });
  const forward=signal=>{try{child.kill(signal)}catch{}};const int=()=>forward('SIGINT'),term=()=>forward('SIGTERM'),resize=()=>forward('SIGWINCH');process.on('SIGINT',int);process.on('SIGTERM',term);process.on('SIGWINCH',resize);
  const result=await closed;process.off('SIGINT',int);process.off('SIGTERM',term);process.off('SIGWINCH',resize);
  if(spawnError&&!childPid&&!migration){
   if(restore){process.stderr.write('旧宿主已停止，但新入口未能启动；保留精确会话交接材料，不回退普通会话。\n');return 1;}
   process.stderr.write('迁移观察器未能启动，普通会话继续；自动迁移不可用：'+spawnError.code+'\n');
   const {main}=await import('./cli.js');return main(args);
  }
  if(!migration)return result.code??1;
  try{
   if(unknown||!armed||terminal?.kind!=='EXIT_CLEAN'||terminal.code!==0||result.code!==0||result.signal)throw error('原进程退出时停止证据不完整，未启动新 PROJECT；草稿与历史保留在迁移记录。');
   const {record,path,bytes}=migration;const now=existsSync(record.sessionFile)?readFileSync(record.sessionFile):null;
   if((now===null?null:hash(now))!==record.previousSha256)throw error('旧宿主退出期间历史发生变化，未覆盖或恢复。');
   if(now===null){const fd=openSync(record.sessionFile,'wx',0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}}
   record.status='stopped';record.stoppedAt=new Date().toISOString();privateWrite(path,JSON.stringify(record,null,2)+'\n');
   restore={sessionFile:record.sessionFile,leafId:record.leafId,cwd:record.cwd,snapshotSha256:record.snapshotSha256};
   process.stderr.write('旧宿主已可信退出；正在恢复 PROJECT 草稿和历史。\n');
  }catch(e){migration.record.status='blocked';migration.record.reason=e.message;privateWrite(migration.path,JSON.stringify(migration.record,null,2)+'\n');process.stderr.write(e.message+'\n交接记录：'+migration.path+'\n');return 1;}
 }
}
export async function runEntrypoint(args=process.argv.slice(2)){
 if(process.env.COTHINK_SUPERVISED_CHILD==='1'&&process.send){
  supervised=true;delete process.env.COTHINK_SUPERVISED_CHILD;
  process.on('message',m=>{if(m?.cothinkHandoff==='reply'){const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(error(m.error)):p.resolve(m.result);}}});
  process.on('disconnect',()=>{for(const p of pending.values())p.reject(error('可信启动器连接中断；未迁移。'));pending.clear();});
  bootState=await rpc('boot');
  if(bootState.restore&&hash(readFileSync(bootState.restore.sessionFile))!==bootState.restore.snapshotSha256)throw error('迁移后的会话摘要变化，未恢复 PROJECT。');
  const {main}=await import('./cli.js');
  try{return await main(args,{projectHandoff:bootState.restore});}
  finally{if(process.connected)process.disconnect();}
 }
 // Preloads execute before this module and cannot be certified after the fact.
 if(process.stdin.isTTY&&process.stdout.isTTY&&!process.env.NODE_OPTIONS&&process.execArgv.length===0)return supervise(args);
 const {main}=await import('./cli.js');return main(args);
}
