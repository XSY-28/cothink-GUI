// Installed only in a controlled native-plugin process, before package import.
// The original pi-subagents SDK session/agent loop remains intact. Physical model
// work is delegated as canonical Pi stream data to the already-authorized host.
import {mkdirSync,writeFileSync,existsSync,realpathSync} from 'node:fs';
import {join,resolve,dirname,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
const fail=(code,message)=>Object.assign(new Error(message),{code});
const canonicalFile=path=>{try{return join(realpathSync(dirname(resolve(path??''))),basename(path??''));}catch{return resolve(path??'');}};
export function projectModelMetadata(model){return model?{...Object.fromEntries(['provider','id','name','api','reasoning','input','contextWindow','maxTokens','cost','thinkingLevelMap'].filter(k=>model[k]!==undefined).map(k=>[k,model[k]])),baseUrl:'http://cothink.invalid/v1'}:model;}

// This bridge is buffered, so repeated mutable partial snapshots provide no live
// progress and can multiply a modest response past the RPC frame limit. Preserve
// the actual initial and terminal SDK events; the host journal retains progress.
export async function collectBufferedNativeStream(source) {
  let start,terminal;
  for await(const event of source){if(event.type==='start'&&!start)start=structuredClone(event);if(event.type==='done'||event.type==='error')terminal=event;}
  if(!terminal)throw fail('PROJECT_NATIVE_PROTOCOL','Host model stream ended without a terminal event');
  return {events:[...(start?[start]:[]),terminal]};
}

export function installProjectNativeModelBridge({ModelRuntime,createStream,rpc}) {
  const original=ModelRuntime.create,byAuth=new Map(),byLaunch=new Map();
  if(typeof original!=='function'||typeof createStream!=='function'||typeof rpc!=='function')throw Error('Native bridge requires the actual SDK and host RPC');
  const wrapper=async options=>{
    const binding=byAuth.get(canonicalFile(options?.authPath));
    if(!binding||binding.closed||binding.runtimeClaimed)throw fail('PROJECT_NATIVE_UNBOUND','Native model runtime has no unused host-admitted launch');
    if(canonicalFile(options?.modelsPath)!==join(binding.agentDir,'models.json'))throw fail('PROJECT_NATIVE_UNBOUND','Model metadata differs from the admitted launch');
    binding.runtimeClaimed=true;
    const runtime=await original.call(ModelRuntime,{...options,allowModelNetwork:false});
    for(const method of ['stream','streamSimple'])runtime[method]=(model,context,options={})=>{
      const output=createStream(),id=randomUUID();
      const errorMessage=error=>({role:'assistant',api:binding.model.api,provider:binding.model.provider,model:binding.model.id,
        content:[],stopReason:options.signal?.aborted?'aborted':'error',errorMessage:error.message,timestamp:Date.now(),
        // SDK error shape only; the host journal owns actual/unknown usage and billing.
        usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
      const cancel=()=>{void rpc('native.cancelModel',{launchId:binding.launchId,sessionId:binding.sessionId,nativeRequestId:id}).catch(()=>{});};
      queueMicrotask(async()=>{
        try {
          if(binding.closed||!binding.sessionId||model.provider!==binding.model.provider||model.id!==binding.model.id||model.api!==binding.model.api)
            throw fail('PROJECT_NATIVE_UNBOUND','Native stream does not match its started session and frozen model');
          if(options.signal?.aborted)throw fail('CANCELLED','Native stream cancelled before dispatch');
          options.signal?.addEventListener('abort',cancel,{once:true});binding.streams.add(id);
          const result=await rpc('native.model',{launchId:binding.launchId,sessionId:binding.sessionId,nativeRequestId:id,method,
            model:{provider:model.provider,id:model.id,api:model.api},context,
            options:Object.fromEntries(['reasoning','thinkingLevel','maxTokens','temperature','topP'].filter(k=>options[k]!==undefined).map(k=>[k,options[k]]))},
            {signal:options.signal});
          if(!Array.isArray(result?.events)||!result.events.some(e=>e.type==='done'||e.type==='error'))throw fail('PROJECT_NATIVE_PROTOCOL','Host model stream has no terminal event');
          for(const event of result.events)output.push(event);
          output.end();
        }catch(error){output.push({type:'error',reason:options.signal?.aborted?'aborted':'error',error:errorMessage(error)});output.end();}
        finally{binding.streams.delete(id);options.signal?.removeEventListener('abort',cancel);}
      });
      return output;
    };
    return runtime;
  };
  ModelRuntime.create=wrapper;
  return {
    admit({launchId,agentDir,model}) {
      if(typeof launchId!=='string'||!launchId||byLaunch.has(launchId)||!model?.provider||!model.id||!model.api)throw fail('PROJECT_NATIVE_UNBOUND','Unique launch and frozen model metadata required');
      mkdirSync(agentDir,{recursive:true,mode:0o700});agentDir=realpathSync(agentDir);const authPath=join(agentDir,'auth.json');
      if(byAuth.has(authPath)||existsSync(authPath))throw fail('PROJECT_NATIVE_CREDENTIALS','Admitted native runtime must not contain raw authentication');
      const safeModel={id:model.id,name:model.name??model.id,api:model.api,reasoning:!!model.reasoning,input:model.input??['text'],
        contextWindow:model.contextWindow,maxTokens:model.maxTokens,...(model.thinkingLevelMap?{thinkingLevelMap:model.thinkingLevelMap}:{}),
        cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
      writeFileSync(join(agentDir,'models.json'),JSON.stringify({providers:{[model.provider]:{api:model.api,baseUrl:'http://cothink.invalid/v1',apiKey:'COTHINK_NO_CREDENTIALS',models:[safeModel]}}}),{flag:'wx',mode:0o600});
      const binding={launchId,agentDir,model:{...model},streams:new Set(),closed:false,runtimeClaimed:false};byAuth.set(authPath,binding);byLaunch.set(launchId,binding);
      return {hostAgentDir:agentDir,model:model.provider+'/'+model.id};
    },
    started({launchId,sessionId}) {
      const binding=byLaunch.get(launchId);
      if(!binding||binding.closed||!binding.runtimeClaimed||typeof sessionId!=='string'||!sessionId||binding.sessionId&&binding.sessionId!==sessionId)
        throw fail('PROJECT_NATIVE_UNBOUND','Started receipt does not match the admitted native SDK runtime');
      binding.sessionId=sessionId;
    },
    close(launchId){const binding=byLaunch.get(launchId);if(!binding)return;binding.closed=true;for(const id of binding.streams)void rpc('native.cancelModel',{launchId,sessionId:binding.sessionId,nativeRequestId:id}).catch(()=>{});},
    restore(){for(const id of byLaunch.keys())this.close(id);if(ModelRuntime.create===wrapper)ModelRuntime.create=original;},
  };
}
