// Trusted adapter around the original fixed plugin engine; executes only in its offline container.
import {mkdirSync,writeFileSync,readFileSync,cpSync,lstatSync,existsSync,readdirSync} from 'node:fs';
import {join,resolve,relative,isAbsolute,dirname} from 'node:path';
import {createServer,createConnection} from 'node:net';
import {randomUUID} from 'node:crypto';
import {installProjectNativeModelBridge} from './project-native-model.js';
import {managedHelperExtension} from './plugin-helper-extension.js';
const integrationPath='/plugins/node_modules/pi-subagents/src/runs/shared/host-integration.js';
const fail=message=>{throw Object.assign(Error(message),{code:'PROJECT_NATIVE_UNSUPPORTED'});};
const clean=value=>JSON.parse(JSON.stringify(value,(_key,v)=>typeof v==='function'?undefined:v));
const pathInside=(root,path)=>{const rel=relative(root,resolve(root,path));return rel===''||!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('../');};
function materialize(root,files){mkdirSync(root,{recursive:true});for(const [path,file]of Object.entries(files)){if(!pathInside(root,path)||path.split('/').includes('.git'))fail('Invalid admitted source path');mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),Buffer.from(file.contentBase64,'base64'),{mode:file.mode==='100755'?0o755:0o644});}}
export async function createNativeWorker({rpc,sessionId,cwd='/workspace',models,agents,runnerManifest}) {
  const sdk=await import('/runtime/node_modules/@earendil-works/pi-coding-agent/dist/index.js');
  const {createAssistantMessageEventStream}=await import('/runtime/node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js');
  const integration=await import(integrationPath);
  const handles=new Map(),children=new Map(),controls=new Map(),operations=new Map(),runners=new Map();
  const closedSources=new Set(),sourceQueues=new Map();
  let closed=false;
  const request=(action,args)=>rpc(action.startsWith('native.')?action:'native.'+action,clean(args),{nativeHandle:[args.launchId,args.runnerProcessInstanceId,args.hostOperationId,args.operationId,args.parentOperationId].map(id=>handles.get(id)).find(Boolean)??runnerManifest?.nativeHandle});
  const bridge=installProjectNativeModelBridge({ModelRuntime:sdk.ModelRuntime,createStream:createAssistantMessageEventStream,rpc:request});
  const runSource=(root,fn)=>{const run=(sourceQueues.get(root)??Promise.resolve()).catch(()=>{}).then(()=>{if(closed||closedSources.has(root))fail('Native source is closed');return fn();});sourceQueues.set(root,run);return run;};
  const assertAllowed=()=>{if(closed)fail('Native owner closed');};
  const host={agentDir:'/tmp/pi',
    async admitOperation(input){assertAllowed();const accepted=await request('admitOperation',input);handles.set(input.operationId,accepted.nativeHandle);operations.set(input.operationId,{...accepted,parentSessionId:input.parentSessionId});if(accepted.files){materialize(accepted.cwd,accepted.files);delete accepted.files;}return accepted;},
    async operationReturned(input){return request('operationReturned',input);},
    async admitChild(input){assertAllowed();const admitted=await request('admitChild',input);handles.set(admitted.launchId,admitted.nativeHandle);materialize(admitted.cwd,admitted.files);delete admitted.files;
      bridge.admit({launchId:admitted.launchId,agentDir:admitted.hostAgentDir,model:admitted.modelMetadata});children.set(admitted.launchId,{...admitted,parentSessionId:input.parentSessionId});
      const childRpc=async(action,args)=>{
        if(action==='exec')return request('exec',{launchId:admitted.launchId,...args});
        return request('result',{launchId:admitted.launchId,...args});
      };
      const factory=managedHelperExtension({root:admitted.cwd,resources:'/resources',scope:admitted.scope,readOnly:admitted.readOnly,native:true,
        rpc:childRpc,runSource:fn=>runSource(admitted.cwd,fn),assertAllowed:()=>{assertAllowed();if(closedSources.has(admitted.cwd))fail('Native source finished');},
        childResults:()=>request('children',{launchId:admitted.launchId})});
      // Every source operation rechecks host authority before any local tool reads/writes.
      const guarded=pi=>{factory(new Proxy(pi,{get(target,key){if(key==='registerTool')return definition=>target.registerTool({...definition,execute:async(...args)=>{await request('tool',{launchId:admitted.launchId,tool:definition.name,args:args[1]});return definition.execute(...args);}});const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}));};
      return {...admitted,hostHooks:[{name:'cothink-project-native-tools',factory:guarded}],hostToolNames:['cothink_helper_result']};
    },
    claimStart:input=>request('claimStart',input),
    async started({control,...input}){controls.set(input.launchId,control.abort);await request('started',input);bridge.started(input);},
    async terminal(input){await request('terminal',input);controls.delete(input.launchId);bridge.close(input.launchId);},
    async finished(input){const child=children.get(input.launchId);if(child)await runSource(child.cwd,()=>closedSources.add(child.cwd));return request('finished',input);},
    async admitRunner(input){if(!/^[a-f0-9-]{36}$/.test(input.runnerProcessInstanceId??''))fail('Invalid runner instance identity');const accepted=await request('admitRunner',input);handles.set(input.runnerProcessInstanceId,accepted.nativeHandle);const manifest={...accepted.manifest,socket:'/tmp/cothink-native.sock',integrationPath};const path='/tmp/runner-'+input.runnerProcessInstanceId+'.json';writeFileSync(path,JSON.stringify(manifest),{mode:0o600,flag:'wx'});return {hostManaged:true,hostBridge:{module:'/trusted/project-native-worker.js',manifest:path}};},
    async runnerSpawned({runnerProcessInstanceId,process:child}){runners.set(runnerProcessInstanceId,child);child.once('close',(code,signal)=>{runners.delete(runnerProcessInstanceId);void request('runnerClose',{runnerProcessInstanceId,code,signal}).catch(()=>{});});await request('runnerSpawned',{runnerProcessInstanceId,pid:child.pid});},
    async sourceOutput(input,operation){await request('sourceOutput',input);return runSource(operations.get(input.operationId)?.cwd??cwd,operation);},
    validateOutput({output,parentSessionId,operationId}){const root=operations.get(operationId)?.cwd??[...children.values()].find(c=>c.sessionId===parentSessionId)?.cwd??cwd;if(!pathInside(root,output)&&!resolve(root,output).startsWith('/tmp/pi/'))fail('Native output outside creator source/artifacts');},
    async command(input){return request('command',{...input,signal:undefined});},
    resolvePlacement(){fail('Remote native placement has no PROJECT container route');},prepareResume(){fail('Native resume requires original result reconciliation');},
  };
  if(agents&&existsSync(agents)){mkdirSync('/tmp/pi',{recursive:true});cpSync(agents,'/tmp/pi/agents',{recursive:true});}
  const close=integration.registerHostIntegration({cwd,parentSessionId:sessionId,host});
  let server;
  if(!runnerManifest){
    server=createServer(socket=>{let buffer='';socket.on('data',bytes=>{buffer+=bytes;if(Buffer.byteLength(buffer)>8*1024*1024)return socket.destroy();let end;while((end=buffer.indexOf('\n'))>=0){let message;try{message=JSON.parse(buffer.slice(0,end));}catch{return socket.destroy();}buffer=buffer.slice(end+1);if(typeof message.id!=='string'||!message.nativeHandle)return socket.destroy();
      void rpc(message.action,message.args,{nativeHandle:message.nativeHandle}).then(value=>socket.write(JSON.stringify({id:message.id,value})+'\n'),error=>socket.write(JSON.stringify({id:message.id,error:{message:error.message,code:error.code}})+'\n'));
    }});});await new Promise((resolve,reject)=>{server.once('error',reject);server.listen('/tmp/cothink-native.sock',resolve);});
  }
  return {message:(action,args)=>{const context=globalThis[Symbol.for('pi-subagents:cothink-host-integration:v1')]?.operations.getStore();return context?.operationId&&handles.has(context.operationId)?request('message',{operationId:context.operationId,action,args}):rpc(action,args);},run:fn=>integration.withHostResources('/tmp/pi',fn,{headlessUI:true}),runRunner:fn=>integration.withHostResources('/tmp/pi',()=>integration.withRunnerOperation(runnerManifest,fn),{headlessUI:true}),
    async close(){closed=true;for(const abort of controls.values())await abort();for(const child of runners.values())child.kill('SIGTERM');await close();bridge.restore();server?.close();}};
}
export async function connectRunner(config){
  const manifest=JSON.parse(readFileSync(config.hostBridge.manifest,'utf8')),pending=new Map();const socket=createConnection(manifest.socket);await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});let buffer='';
  socket.on('data',bytes=>{buffer+=bytes;let end;while((end=buffer.indexOf('\n'))>=0){const message=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);const p=pending.get(message.id);pending.delete(message.id);if(p)message.error?p.reject(Object.assign(Error(message.error.message),message.error)):p.resolve(message.value);}});
  const rpc=(action,args,options={})=>new Promise((resolve,reject)=>{const id=randomUUID();pending.set(id,{resolve,reject});socket.write(JSON.stringify({id,action,args,nativeHandle:options.nativeHandle??manifest.nativeHandle})+'\n');});
  const worker=await createNativeWorker({rpc,sessionId:manifest.parentSessionId,cwd:manifest.cwd,runnerManifest:manifest});
  socket.once('close',()=>{for(const p of pending.values())p.reject(Error('Native owner disconnected'));pending.clear();void worker.close();});
  return {run:worker.runRunner,async finish(){await rpc('native.runnerDone',{runnerProcessInstanceId:manifest.runnerProcessInstanceId});socket.end();},abort:()=>worker.close()};
}
