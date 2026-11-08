// A process boundary for PROJECT extensions. This transport never grants project authority;
// the owning task must authorize every operation and import files through agent-sync.
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash, randomUUID} from 'node:crypto';
import {readFileSync, readdirSync, lstatSync, realpathSync, readlinkSync,mkdirSync,cpSync} from 'node:fs';
import {join, relative, isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {problem} from './task.js';

const exec=promisify(execFile), hash=value=>createHash('sha256').update(value).digest('hex');
const maxFrame=8*1024*1024;
const schema=registration=>({...registration,tools:registration.tools.map(({name,parameters})=>({name,parameters})),commands:registration.commands.map(({name})=>({name}))});
function treeDigest(root) {
  const files=[];
  const visit=dir=>{for(const name of readdirSync(join(root,dir)).sort()) {
    const path=join(dir,name), stat=lstatSync(join(root,path));
    if(stat.isSymbolicLink()) {
      const target=readlinkSync(join(root,path)), rel=relative(root,realpathSync(join(root,path)));
      if(isAbsolute(target)||isAbsolute(rel)||rel==='..'||rel.startsWith('../'))throw problem('PROJECT_PLUGIN_SOURCE','Resource symlink escapes: '+path);
      files.push([path,'symlink',target]);continue;
    }
    if(!stat.isFile()&&!stat.isDirectory())throw problem('PROJECT_PLUGIN_SOURCE','Unsupported resource type: '+path);
    if(stat.isDirectory())visit(path);else files.push([path,stat.mode&0o777,hash(readFileSync(join(root,path)))]);
  }};
  visit('');return hash(JSON.stringify(files));
}

export async function createProjectPluginRuntime({execution,runtimeDirectory,codeDirectory,extensions,
  workspace,resources,native,readOnly=true,record,save,authorize,onOperation,signal,uiAvailable=false}) {
  if(execution?.engine!=='docker'||execution.network!=='none'||!/@sha256:[a-f0-9]{64}$|^sha256:[a-f0-9]{64}$/.test(execution.image??''))
    throw problem('PROJECT_PLUGIN_ENVIRONMENT','PROJECT plugins require an immutable offline Docker image');
  if(typeof authorize!=='function'||typeof save!=='function'||!record)
    throw problem('PROJECT_PLUGIN_AUTHORITY','An owning task and live authorization callback are required');
  if(signal?.aborted)throw problem('CANCELLED','Plugin owner already stopped');
  const runtimeRoot=realpathSync(runtimeDirectory), codeRoot=realpathSync(codeDirectory), workRoot=realpathSync(workspace);
  const pi=JSON.parse(readFileSync(join(runtimeRoot,'node_modules/@earendil-works/pi-coding-agent/package.json')));
  if(pi.version!=='1.4.0-cothink.3')throw problem('PROJECT_PLUGIN_ENVIRONMENT','Prepared runtime must use Pi 1.4.0-cothink.3');
  for(const entry of extensions??[])if(typeof entry!=='string'||isAbsolute(entry)||entry.split(/[\\/]/).includes('..')||!entry)
    throw problem('PROJECT_PLUGIN_SOURCE','Extensions must be relative to the frozen code directory');
  const sourceDigest=treeDigest(codeRoot), name='cothink-project-'+randomUUID();
  const nativeDirectory=native?workRoot+'-native':undefined;if(nativeDirectory)mkdirSync(nativeDirectory,{mode:0o700});
  const pending=new Map(),hostOperations=new Map(),nativeHandles=new Map();let sourceQueue=Promise.resolve();
  const sourceLocked=callback=>{const run=sourceQueue.catch(()=>{}).then(callback);sourceQueue=run;return run;};let buffer='',child,closed=false,registration,stopping,paused=false,protocolFault,receiveQueue=Promise.resolve();
  if(nativeDirectory)record.nativeDirectory=nativeDirectory;
  record.runtimeId=name;record.sourceDigest=sourceDigest;record.status='starting';record.requests??=[];save();
  const authority=async detail=>{
    if(protocolFault)throw protocolFault;
    if(closed||stopping||signal?.aborted)throw problem('CANCELLED','Plugin owner stopped');
    if(paused&&detail.action!=='resume')throw problem('PROJECT_PLUGIN_PAUSED','Plugin writers and callbacks are frozen');
    await authorize({...detail,runtimeId:name,sourceDigest,readOnly,registrationVersion:record.registrationVersion});
    if(protocolFault)throw protocolFault;
    if(closed||stopping||signal?.aborted)throw problem('CANCELLED','Plugin owner stopped while authorization was pending');
    if(paused&&detail.action!=='resume')throw problem('PROJECT_PLUGIN_PAUSED','Plugin was frozen while authorization was pending');
  };
  await authority({action:'load'});
  const args=['run','--name',name,'--pull','never','-i','--network','none','--read-only','--cap-drop','ALL',
    '--security-opt','no-new-privileges','--pids-limit',String(execution.limits?.pids??128),
    '--memory',String(execution.limits?.memoryBytes??536870912),'--cpus',String(execution.limits?.cpus??1),
    '--user',`${process.getuid?.()??1000}:${process.getgid?.()??1000}`,
    '--tmpfs','/tmp:rw,nosuid,nodev,size=256m','-e','HOME=/tmp/home','-e','PI_OFFLINE=1',
    '-v',join(runtimeRoot,'node_modules')+':/runtime/node_modules:ro','-v',codeRoot+':/plugins:ro','-v',workRoot+':/workspace'+(readOnly?':ro':''),
    '-v',fileURLToPath(new URL('./project-plugin-worker.js',import.meta.url))+':/runner.mjs:ro',
    '-v',fileURLToPath(new URL('.',import.meta.url))+':/trusted:ro',
    '-v',join(runtimeRoot,'node_modules')+':/node_modules:ro',
    ...(native?['-v',nativeDirectory+':/native-work',...(native.limits?['-e','PI_SUBAGENT_MAX_DEPTH='+native.limits.maxDepth,'-e','PI_SUBAGENT_MAX_SPAWNS_PER_RUN='+native.limits.maxSpawnsPerRun]:[]),'-e','PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT=/runtime/node_modules/@earendil-works/pi-coding-agent',...(native.agents?['-v',realpathSync(native.agents)+':/native-agents:ro']:[])]:[]),
    ...(resources?['-v',realpathSync(resources)+':/resources:ro']:[]),'-w','/workspace',execution.image,'node','/runner.mjs'];
  const send=message=>{const line=JSON.stringify(message);if(Buffer.byteLength(line)>maxFrame)throw problem('PROJECT_PLUGIN_PROTOCOL','Frame exceeds limit');child.stdin.write(line+'\n');};
  const rejectAll=error=>{for(const p of pending.values()){p.entry.status='outcome_unknown';p.entry.error={code:error.code,message:error.message};p.reject(error);}pending.clear();save();};
  const request=(action,args,id=randomUUID())=>{
    if(closed||stopping)return Promise.reject(problem('PROJECT_PLUGIN_STOPPED','Runtime is closed'));
    if(record.requests.some(r=>r.id===id))return Promise.reject(problem('PROJECT_PLUGIN_REPLAY','Query the original receipt; an operation cannot be replayed'));
    if(pending.size)return Promise.reject(problem('PROJECT_PLUGIN_BUSY','An earlier operation still owns this runtime'));
    const entry={id,action,payloadDigest:hash(JSON.stringify(args)),status:'pending'};
    record.requests.push(entry);save();
    return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject,entry});try{send({type:'request',id,action,args});}catch(e){pending.delete(id);entry.status='not_sent';save();reject(e);}});
  };
  async function stop() {
    if(stopping)return stopping;
    stopping=(async()=>{
      // Docker's removal of the named container confirms the whole cgroup ended,
      // including descendants and timers; the host client process is not this proof.
      try {
        for(const operation of hostOperations.values())operation.controller.abort();
        if(!record.containerStoppedAt)await exec('docker',['rm','-f',name]);
        const state=await exec('docker',['container','ls','-a','--filter','name=^/'+name+'$','--format','{{.ID}}']);
        if(state.stdout.trim())throw Error('Container is still registered');
        record.containerStoppedAt=new Date().toISOString();
        if(hostOperations.size)throw Error('Container stopped, but host operations have not confirmed termination');
        record.status='stopped';record.stoppedAt=new Date().toISOString();save();
        closed=true;rejectAll(problem('OUTCOME_UNKNOWN','Runtime stopped; unresolved effects retain their original identity'));
        child?.stdin.destroy();return {stopped:true,runtimeId:name};
      }catch(error){record.status='stop_unknown';record.stopError=error.message;save();throw problem('PROJECT_PLUGIN_STOP_UNKNOWN',error.message);}
    })();try{return await stopping;}catch(error){stopping=undefined;throw error;}
  }
  function receive(message) {
    if(protocolFault||closed||stopping)return;
    if(message.type==='operation') {
      const entry={id:message.id,action:'host',operation:message.action,payloadDigest:hash(JSON.stringify(message)),status:'pending'};
      if(typeof message.id!=='string'||record.requests.some(r=>r.id===message.id))throw problem('PROJECT_PLUGIN_PROTOCOL','Repeated host operation ID');
      record.requests.push(entry);save();
      void (async()=>{try {
        if(typeof message.parentRequestId!=='string'||!pending.has(message.parentRequestId))if(!nativeHandles.has(message.nativeHandle)||!message.action?.startsWith('native.'))throw problem('PROJECT_PLUGIN_UNBOUND','A late callback has no active owning operation');
        entry.parentRequestId=message.parentRequestId;
        const controller=new AbortController();hostOperations.set(message.id,{controller,entry});
        const cleanup=nativeHandles.has(message.nativeHandle)&&['native.cancelModel','native.terminal','native.finished','native.runnerClose','native.runnerDone','native.operationReturned'].includes(message.action);
        if(!cleanup)await authority({action:'host',operation:message.action,args:message.args});
        if(!onOperation)throw problem('PROJECT_PLUGIN_UNSUPPORTED','Host API is not connected: '+message.action);
        entry.dispatched=true;save();
        const value=await onOperation(message.action,message.args,{requestId:message.id,parentRequestId:message.parentRequestId,signal:controller.signal,nativeHandle:message.nativeHandle});
        if(['native.admitOperation','native.admitChild','native.admitRunner'].includes(message.action)&&value?.nativeHandle)nativeHandles.set(value.nativeHandle,{action:message.action,id:value.launchId??message.args.operationId??message.args.runnerProcessInstanceId});
        entry.status='completed';entry.value=value;save();if(!closed&&!stopping&&!protocolFault)send({type:'response',id:message.id,value});
      }catch(error){entry.status=entry.dispatched?'outcome_unknown':'failed';entry.error={code:error.code,message:error.message};save();if(!closed&&!protocolFault)send({type:'response',id:message.id,error:entry.error});}
      finally{hostOperations.delete(message.id);}})();
      return;
    }
    if(message.type!=='response'||typeof message.id!=='string'||!pending.has(message.id))
      throw problem('PROJECT_PLUGIN_PROTOCOL','Unexpected control frame');
    if(message.registration) {
      if(registration&&JSON.stringify(schema(registration))!==JSON.stringify(schema(message.registration)))(record.registrationHistory??=[]).push({at:new Date().toISOString(),registration});
      registration=message.registration;record.registration=registration;
      record.registrationVersion=hash(JSON.stringify({sourceDigest,registration:schema(registration)}));
    }
    const item=pending.get(message.id);pending.delete(message.id);
    item.entry.status=message.error?'failed':'completed';item.entry.value=message.value;item.entry.error=message.error;save();
    message.error?item.reject(problem(message.error.code??'PROJECT_PLUGIN_FAILURE',message.error.message)):item.resolve(message.value);
  }
  try {
    child=spawn('docker',args,{stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH,HOME:process.env.HOME}});
    child.stderr.on('data',data=>{record.stderr=((record.stderr??'')+data.toString()).slice(-65536);});
    child.on('error',error=>rejectAll(error));
    child.on('close',()=>{closed=true;if(record.status!=='stopped'){record.status='disconnected';save();}rejectAll(problem('OUTCOME_UNKNOWN','Control stream ended; Docker termination must still be verified'));});
    child.stdout.on('data',data=>{
      if(protocolFault)return;
      buffer+=data.toString();
      const fail=error=>{protocolFault=problem('PROJECT_PLUGIN_PROTOCOL',error.message);rejectAll(protocolFault);void stop().catch(()=>{});};
      if(Buffer.byteLength(buffer)>maxFrame){fail(Error('Control frame too large'));return;}
      let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
        let message;try{message=JSON.parse(line);if(!message||!['operation','response'].includes(message.type)||typeof message.id!=='string')throw Error('Invalid control frame');}
        catch(error){fail(error);return;}
        receiveQueue=receiveQueue.then(()=>receive(message)).catch(fail);
      }
    });
    const abort=()=>{void stop().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
    registration=await request('load',{extensions:extensions.map(p=>'/plugins/'+p),sessionId:randomUUID(),sourceDigest,uiAvailable,...(native?{native:{...native,agents:native.agents?'/native-agents':undefined}}:{})});
    if(treeDigest(codeRoot)!==sourceDigest)throw problem('PROJECT_PLUGIN_SOURCE','Source changed while importing extensions');
    record.registrationVersion=hash(JSON.stringify({sourceDigest,registration:schema(registration)}));record.registration=registration;record.status='ready';save();
    return {get registration(){return registration;},
      async call(tool,args,id) {
        if(record.requests.some(r=>r.id===id))throw problem('PROJECT_PLUGIN_REPLAY','Query original receipt instead of replay');
        if(paused)throw problem('PROJECT_PLUGIN_PAUSED','Writers are frozen');
        await authority({action:'tool',tool,args});
        if(treeDigest(codeRoot)!==sourceDigest)throw problem('PROJECT_PLUGIN_SOURCE','Frozen plugin bytes changed');
        return request('tool',{tool,args,registrationVersion:record.registrationVersion},id);
      },
      async command(command,args,id){if(paused)throw problem('PROJECT_PLUGIN_PAUSED','Runtime frozen');await authority({action:'command',command,args});return request('command',{command,args,registrationVersion:record.registrationVersion},id);},
      async event(event){if(paused)throw problem('PROJECT_PLUGIN_PAUSED','Runtime frozen');await authority({action:'event',event});return request('event',{event,registrationVersion:record.registrationVersion});},
      async freeze(){if(!paused){await exec('docker',['pause',name]);const {stdout}=await exec('docker',['inspect','--format','{{.State.Paused}}',name]);if(stdout.trim()!=='true')throw problem('PROJECT_PLUGIN_STOP_UNKNOWN','Writers were not frozen');paused=true;record.status='frozen';save();}if(hostOperations.size)throw problem('PROJECT_PLUGIN_HOST_PENDING','Host operations are still in flight');},
      async resume(){await authority({action:'resume'});if(!paused)return;await exec('docker',['unpause',name]);paused=false;record.status='ready';save();},
      async captureSource(source,destination,{resumeAfter=true}={}){return sourceLocked(async()=>{
        if(!/^\/native-work\/[a-f0-9-]+\/source$/.test(source)&&source!=='/workspace')throw problem('PROJECT_NATIVE_PATH','Unbound source capture');
        if(record.containerStoppedAt){const path=source==='/workspace'?workRoot:join(nativeDirectory,source.slice('/native-work/'.length));if(lstatSync(path).isSymbolicLink())throw problem('PROJECT_NATIVE_PATH','Stopped source root is linked');cpSync(path,destination,{recursive:true,dereference:false});return;}
        const wasPaused=paused;if(!wasPaused)await exec('docker',['pause',name]);
        const {stdout}=await exec('docker',['inspect','--format','{{.State.Paused}}',name]);if(stdout.trim()!=='true')throw problem('PROJECT_PLUGIN_STOP_UNKNOWN','Native source writers not frozen');
        try{await exec('docker',['cp',name+':'+source+'/.',destination]);}finally{if(!wasPaused&&resumeAfter)await exec('docker',['unpause',name]);else if(!resumeAfter){paused=true;record.status='frozen';save();}}
      });},
      async mutateSource(source,callback){return sourceLocked(async()=>{
        if(source!=='/workspace'&&!/^\/native-work\/[a-f0-9-]+\/source$/.test(source))throw problem('PROJECT_NATIVE_PATH','Unbound native source mutation');
        const path=source==='/workspace'?workRoot:join(nativeDirectory,source.slice('/native-work/'.length));if(realpathSync(path)!==path)throw problem('PROJECT_NATIVE_PATH','Native source root is linked');
        const wasPaused=paused;if(!wasPaused)await exec('docker',['pause',name]);
        const {stdout}=await exec('docker',['inspect','--format','{{.State.Paused}}',name]);if(stdout.trim()!=='true')throw problem('PROJECT_PLUGIN_STOP_UNKNOWN','Native source writers not frozen');
        try{return await callback(path);}finally{if(!wasPaused)await exec('docker',['unpause',name]);}
      });},
      query(id){return structuredClone(record.requests.find(r=>r.id===id)??null);},stop};
  }catch(error){try{await stop();}catch(stopError){error.stopError=stopError.message;}throw error;}
}
