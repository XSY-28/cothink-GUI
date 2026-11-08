// Host authority and immutable results for the original container-native plugin.
// No plugin functions, credentials or provider clients cross this boundary.
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync,rmSync,chmodSync} from 'node:fs';
import {join,dirname,relative,isAbsolute,posix} from 'node:path';
import {createRequestPolicy} from './request-policy.js';
import {collectBufferedNativeStream,projectModelMetadata} from './project-native-model.js';
import {problem} from './task.js';
import {taskSkillDirectory,readTaskSkillResource,verifyTaskSkillResources} from './skill-resources.js';
import {resolveModelThinking} from './thinking.js';
const stamp=()=>new Date().toISOString();
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export function createProjectNativeHost({task,entry,state,actor,getSessionId,getRuntime,guard,grant,scan,freezeHelperResult,treatHelperResult,versioning,nativeScheduler:scheduling,execution,runResourceCommand}){
  const children=new Map(),operations=new Map(),runners=new Map(),sessions=new Map(),streams=new Map(),requests=new Set();
  // Operation IDs belong to one runtime. Separate host archive namespaces keep
  // two employees (or rebuilt runtimes) from overwriting each other's evidence.
  const root=join(task.home,'tasks',task.record.id+'-project-native',randomUUID());mkdirSync(root,{recursive:true});
  const policy=task.projectPolicy;
  const view=h=>({helperId:h.helperId,parentActorId:h.parentActorId,status:h.status,text:h.text??null,resultError:h.resultError??null,result:h.result??null,treatment:h.treatment??null});
  const ownerOf=input=>{if(input.parentSessionId===getSessionId())return {actor,cwd:'/workspace',depth:0};const parent=[...children.values()].find(h=>h.native.sessionId===input.parentSessionId);if(!parent||parent.stoppedAt)throw problem('HELPER_PARENT','Native creator is not a live child of this runtime');return {actor:parent.helperId,cwd:parent.native.containerSource,depth:parent.depth,helper:parent};};
  const check=h=>{guard();if(h&&(!children.has(h.helperId)||h.stoppedAt))throw problem('PROJECT_NATIVE_STALE','Native helper is closed');policy.admit('plugin',{...grant(entry),capability:entry.capability,operation:'host'});};
  async function capture(source,id,options){if(typeof id!=='string'||!/^[-a-z0-9]{1,100}$/.test(id))throw problem('PROJECT_NATIVE_PATH','Invalid source archive identity');const directory=join(root,id),rel=relative(root,directory);if(!rel||isAbsolute(rel)||rel==='..'||rel.startsWith('../'))throw problem('PROJECT_NATIVE_PATH','Archive escaped task directory');mkdirSync(directory,{recursive:true});await entry.runtime.captureSource(source,directory,options);const files=scan(directory);return {directory,files};}
  const records=()=>[...children.values(),...[...operations.values()].filter(o=>o.nativeBackground)];
  const pending=()=>records().filter(h=>!h.treatment);
  const cleanupActions=new Set(['cancelModel','terminal','finished','runnerClose','runnerDone','operationReturned']);
  const byHandle=handle=>[...children.values(),...operations.values(),...runners.values()].find(h=>h.nativeHandle===handle);
  async function isolatedCommand({source,scope,readOnly,helperId},command,metadata,assertAllowed,output){
    assertAllowed();if(readOnly)throw problem('SCOPE','Read-only native owner cannot execute source commands');
    verifyTaskSkillResources(task);const captured=await capture(source,'shell-'+randomUUID());const record={name:'project_native_shell',kind:'native_host_command',helperId,parentActorId:actor,cwd:captured.directory,scope,readOnly,snapshot:{files:captured.files},status:'running'};
      (task.record.tools??=[]).push(record);task.save();
      if(typeof command!=='string'||!command.trim())throw problem('PROJECT_NATIVE_UNSUPPORTED','Native command must be nonempty text');
      const fact=await runResourceCommand({task,execution,record,command,resources:task.skillResourceRoot,signal:AbortSignal.any([task.signal,metadata.signal].filter(Boolean)),handles:new Map()});
      scan(record.cwd);if(output){if(typeof output!=='string'||/[\\\0]/.test(output)||output.startsWith('/')||output.split('/').some(p=>!p||p==='.'||p==='..'||p.toLowerCase()==='.git'))throw problem('SCOPE','Invalid native command output path');const file=join(record.cwd,output);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,(fact.stdout??'')+(fact.stderr??''));}
      record.stoppedAt=stamp();record.status=fact.exitCode===0?'completed':'failed';
      try{freezeHelperResult(record);}catch(error){record.resultError={code:error.code,message:error.message};task.save();throw error;}
      assertAllowed();await entry.runtime.mutateSource(source,path=>{
        const actual=scan(path);if(JSON.stringify(actual)!==JSON.stringify(captured.files))throw problem('STALE_PRIVATE','Native source changed while isolated shell ran; retained output was not imported');
        assertAllowed();for(const edit of record.result.edits){const file=join(path,edit.path);if(edit.contentBase64===null)rmSync(file,{force:true});else{mkdirSync(dirname(file),{recursive:true});writeFileSync(file,Buffer.from(edit.contentBase64,'base64'));chmodSync(file,edit.mode==='100755'?0o755:0o644);}}
      });record.importedAt=stamp();task.save();return fact;
  }
  async function operation(action,input,metadata){
    action=action.replace(/^native\./,'');
    if(metadata.nativeHandle){const original=byHandle(metadata.nativeHandle);if(!original)throw problem('PROJECT_NATIVE_UNBOUND','Native lifetime handle is unknown');
      const target=input.launchId??input.runnerProcessInstanceId??input.operationId??input.hostOperationId;
      if(input.parentSessionId&&input.parentSessionId!==(original.native?.sessionId??original.creatorSessionId))throw problem('HELPER_PARENT','Lifetime handle cannot impersonate another creator session');
      if(target&&target!==original.helperId&&target!==original.operationId&&target!==original.runnerProcessInstanceId&& !['admitChild','admitOperation','admitRunner','sourceOutput','command'].includes(action))throw problem('PROJECT_NATIVE_UNBOUND','Lifetime handle cannot control another launch');
    }
    let cleanup;
    if(cleanupActions.has(action)){const h=input.launchId&&children.get(input.launchId);cleanup=h?policy.admitNativeCleanup(h.capability,{operation:action}):policy.checkOriginalPluginCapability(entry.capability,{operation:action});}
    else check();
    if(action==='message'){const o=operations.get(input.operationId);if(!o||o.parentActorId!==actor||!['sendMessage','sendUserMessage'].includes(input.action))throw problem('PROJECT_NATIVE_UNBOUND','Notification has no original creator operation');return {operationId:o.operationId,source:entry.source.selection};}
    if(action==='admitOperation'){
      const creator=ownerOf(input),p=input.nativeParams??{};
      if(input.cwd!==creator.cwd&&!operations.has(input.parentOperationId))throw problem('HELPER_PARENT','Native cwd differs from creator');
      if(p.machine||p.worktree||p.baseRef||p.merge||p.accept||p.resume||p.action==='resume')throw problem('PROJECT_NATIVE_UNSUPPORTED','Remote, Git placement and resume lack a PROJECT route');
      if(p.gate||p.acceptance?.verify?.length)throw problem('PROJECT_NATIVE_UNSUPPORTED','Native verifier must use existing project checks');
      if(p.action&&!['status','stop','validate'].includes(p.action))throw problem('PROJECT_NATIVE_UNSUPPORTED','Unadapted native management action');
      if(['status','stop'].includes(p.action)&&!records().some(h=>h.parentActorId===creator.actor&&(h.native?.runId===p.id||h.nativeRunId===p.id)))throw problem('HELPER_PARENT','Native management target is not owned by this creator');
      const id=input.operationId;if(!uuid(id)||operations.has(id))throw problem('PROJECT_NATIVE_REPLAY','Original native operation already exists');
      const inherited=operations.get(input.parentOperationId),source=inherited?.parentActorId===creator.actor?inherited.containerSource:creator.cwd;
      const captured=await capture(source,'operation-'+id),snapshot={...structuredClone(entry.snapshot),files:captured.files,publicBaseline:{inputVersion:entry.snapshot.inputVersion,observations:entry.snapshot.observations}};
      const background=Boolean(input.nativeParams&&!p.action&&p.async!==false);
      const h={name:'project_native_operation',kind:'native_plugin_operation',helperId:id,operationId:id,toolCallId:input.toolCallId,creatorSessionId:input.parentSessionId,parentActorId:creator.actor,...(creator.helper?{parentHelperId:creator.helper.helperId}:{}),
        nativeHandle:randomUUID(),nativeBackground:background,nativeRunId:input.runId??null,containerSource:background?'/native-work/'+id+'/source':source,
        cwd:captured.directory,snapshot,scope:snapshot.scope,readScope:snapshot.readScope,readOnly:entry.readOnly,changeId:entry.changeId,inputVersion:snapshot.inputVersion,status:'admitted'};
      operations.set(id,h);(task.record.tools??=[]).push(h);task.save();
      if(creator.helper)scheduling?.release('helper:'+creator.helper.helperId);
      return {hostManaged:true,nativeHandle:h.nativeHandle,cwd:h.containerSource,...(background?{files:captured.files}:{})};
    }
    if(action==='operationReturned'){
      const h=operations.get(input.operationId);if(!h)throw problem('PROJECT_NATIVE_UNBOUND','Unknown returned operation');h.returnedAt=stamp();
      if(!h.nativeBackground)h.status='completed';
      if(cleanup?.projectActive!==false&&h.parentHelperId&&!children.get(h.parentHelperId)?.stoppedAt)await scheduling?.acquire('helper:'+h.parentHelperId,task.signal);
      task.save();return {recorded:true};
    }
    if(action==='admitChild'){
      const creator=ownerOf(input);if(creator.depth>=(task.record.work.helperLimits?.maxDepth??2))throw problem('PLUGIN_DEPTH','Native inherited maximum depth reached');
      if(input.machine||input.mcpDirectTools?.length||input.builtinMcpTools?.length||input.nativeAcceptance?.verify?.length)throw problem('PROJECT_NATIVE_UNSUPPORTED','Native remote/MCP/verifier route has no matching PROJECT adapter');
      const selected=input.model?.replace(/:(off|minimal|low|medium|high|xhigh|max)$/,'');
      const modelRef=[task.record.models.main,...(task.record.models.secondary??[])].find(m=>m.provider+'/'+m.modelId===selected);
      const host=getRuntime(),model=modelRef&&host?.modelRuntime.getModel(modelRef.provider,modelRef.modelId);if(!model)throw problem('PLUGIN_MODEL_UNBOUND','Child must select a frozen Team model');
      const effectiveThinking=await resolveModelThinking(model,modelRef.thinkingLevel);
      const basis=operations.get(input.hostOperationId);if(!basis||basis.stoppedAt||basis.parentActorId!==creator.actor)throw problem('PROJECT_NATIVE_UNBOUND','Child requires its creator original operation');
      const launchId=randomUUID(),captured=await capture(basis.containerSource,launchId+'-input');
      const snapshot={...structuredClone(basis.snapshot),files:captured.files};
      const h={helperId:launchId,parentActorId:creator.actor,...(creator.helper?{parentHelperId:creator.helper.helperId}:{}),depth:creator.depth+1,name:input.childAgentName??input.runtime?.agent,
        nativeHandle:randomUUID(),model:structuredClone(modelRef),changeId:entry.changeId,inputVersion:snapshot.inputVersion,snapshot,scope:snapshot.scope,readScope:snapshot.readScope,readOnly:entry.readOnly,
        cwd:captured.directory,status:'queued',usage:null,usageSource:'Host request journal only; plugin usage is observational',createdAt:stamp(),native:{projectManaged:true,thinking:effectiveThinking,agent:input.childAgentName??input.runtime?.agent,runId:input.runId??input.runtime?.runId,operationId:input.hostOperationId,containerSource:'/native-work/'+launchId+'/source',model:selected}};
      (task.record.work.helpers??=[]).push(h);children.set(launchId,h);
      const spec={task,...grant(entry),pluginCapability:entry.capability,launchId,creatorRole:actor,creatorSessionId:getSessionId(),parentHelperId:h.parentHelperId??null,...(h.parentHelperId?{parentCapability:children.get(h.parentHelperId).capability}:{}),modelRef:h.model};
      delete spec.sessionId;h.capability=policy.issueNativeHelper(spec);task.save();
      return {launchId,nativeHandle:h.nativeHandle,cwd:h.native.containerSource,files:captured.files,model:selected,thinking:effectiveThinking,modelMetadata:cleanModel(model),scope:h.scope,readOnly:h.readOnly,
        hostAgentDir:'/native-work/'+launchId+'/pi',sessionDir:'/native-work/'+launchId+'/sessions',hostSettings:{retry:{enabled:false,provider:{maxRetries:0,timeoutMs:0}},compaction:{enabled:false},cacheWarming:'off',httpIdleTimeoutMs:0},
        projectTrusted:false,inheritGlobalContext:false,inheritProjectContext:false,inheritSkills:false,
        systemPrompt:(input.systemPrompt??'')+'\n\nYou are helper '+launchId+', created by '+creator.actor+'. Follow the original user task and reply in the user language. Your source is an independent copy. Frozen skill files are under /resources. Files require explicit creator review.\nFrozen skill directory: '+JSON.stringify(taskSkillDirectory(task).map(({name,description,executionPath,hash})=>({name,description,path:executionPath,hash})))+'\nOriginal user task:\n'+task.record.input};
    }
    if(action==='admitRunner'){
      const creator=ownerOf(input),o=operations.get(input.hostOperationId);if(!o?.nativeBackground||o.parentActorId!==creator.actor||o.runnerProcessInstanceId)throw problem('PROJECT_NATIVE_REPLAY','Runner needs an unused admitted background operation');
      const id=input.runnerProcessInstanceId;if(!uuid(id)||runners.has(id))throw problem('PROJECT_NATIVE_REPLAY','Runner instance already used');
      const r={runnerProcessInstanceId:id,operationId:o.operationId,nativeHandle:randomUUID(),creatorSessionId:input.parentSessionId,parentActorId:creator.actor,status:'admitted'};runners.set(id,r);o.runnerProcessInstanceId=id;o.nativeRunId=input.id;o.status='starting';task.save();
      return {nativeHandle:r.nativeHandle,manifest:{nativeHandle:r.nativeHandle,cwd:o.containerSource,parentSessionId:input.parentSessionId,operationId:o.operationId,runnerProcessInstanceId:id}};
    }
    if(action==='runnerSpawned'||action==='runnerClose'||action==='runnerDone'){
      const r=runners.get(input.runnerProcessInstanceId);if(!r)throw problem('PROJECT_NATIVE_UNBOUND','Unknown runner');const o=operations.get(r.operationId);
      if(action==='runnerSpawned'){if(r.pid)throw problem('PROJECT_NATIVE_REPLAY','Runner process already bound');r.pid=input.pid;r.status='running';o.status='running';}
      if(action==='runnerDone')r.executionCompletedAt=stamp();
      if(action==='runnerClose'){if(r.closedAt){if(r.exitCode===input.code&&r.exitSignal===input.signal)return {recorded:true,reused:true};throw problem('PROJECT_NATIVE_REPLAY','Runner close receipt differs from original');}r.exitCode=input.code;r.exitSignal=input.signal;r.closedAt=stamp();r.status=input.code===0?'completed':'failed';const captured=await capture(o.containerSource,'runner-result-'+o.operationId,{resumeAfter:cleanup?.projectActive!==false});o.cwd=captured.directory;o.stoppedAt=stamp();o.status=r.status;try{freezeHelperResult(o,records());}catch(e){o.resultError={code:e.code,message:e.message};}if(!o.resultError&&!o.result.edits.length)o.treatment={decision:'rejected',reason:'Native controller produced no source delta',at:stamp()};}
      task.save();return {recorded:true};
    }
    const h=input.launchId&&children.get(input.launchId);
    if(action==='sourceOutput'){ownerOf(input);return {authorized:true};}
    if(action==='command'){
      const creator=ownerOf(input),o=operations.get(input.operationId),source=o?.containerSource??creator.cwd;
      if(input.cwd!==source)throw problem('SCOPE','Native command source differs from its creator');
      const scope=creator.helper?.scope??entry.snapshot.scope,readOnly=creator.helper?.readOnly??entry.readOnly;
      const assertAllowed=()=>{check(creator.helper);if(creator.helper)policy.admitNativeHelper(creator.helper.capability,{operation:'shell',scope});else policy.admit('shell',{actor,scope});};
      const started=Date.now(),fact=await isolatedCommand({source,scope,readOnly,helperId:creator.helper?.helperId},input.params.command,metadata,assertAllowed,input.params.output);
      return {key:input.key,kind:'command',ok:fact.exitCode===0,state:fact.exitCode===0?'passed':'failed',exitCode:fact.exitCode,stdout:fact.stdout,stderr:fact.stderr,durationMs:Date.now()-started,...(input.params.output?{outputPath:source+'/'+input.params.output}:{})};
    }
    if(!h)throw problem('PROJECT_NATIVE_UNBOUND','Unknown admitted helper');
    if(action==='claimStart'){check(h);if(h.native.startClaim)throw problem('NATIVE_START_CLAIMED','Original launch already consumed');h.native.startClaim={at:stamp()};h.status='starting';task.save();await scheduling?.acquire('helper:'+h.helperId,task.signal);check(h);policy.admitNativeHelper(h.capability,{operation:'start'});return {claimed:true};}
    if(action==='started'){
      check(h);if(!h.native.startClaim||h.native.sessionId||input.model!==h.native.model||input.baseUrl!=='http://cothink.invalid/v1')throw problem('PROJECT_NATIVE_UNBOUND','Native SDK session does not match the launch');
      const stage=task.beginPhase('project-native-helper','helper:'+h.helperId,h.model);Object.assign(stage,{sessionId:input.sessionId,nativeLaunchId:h.helperId,creatorRole:actor});
      h.stage=stage;h.native.sessionId=input.sessionId;h.native.sessionFile=input.sessionFile;h.status='running';sessions.set(input.sessionId,h);
      policy.bindNativeHelperSession(h.capability,{task,sessionId:input.sessionId,stage});task.save();return {bound:true};
    }
    if(action==='model'){
      check(h);if(h.native.sessionId!==input.sessionId||!h.stage||requests.has(input.nativeRequestId))throw problem('PROJECT_NATIVE_REPLAY','Model request must use a started original native session once');
      const host=getRuntime(),model=host.modelRuntime.getModel(h.model.provider,h.model.modelId);
      if(input.model.provider!==model.provider||input.model.id!==model.id||input.model.api!==model.api)throw problem('PLUGIN_MODEL_UNBOUND','Native selected endpoint/model changed');
      requests.add(input.nativeRequestId);const controller=new AbortController();streams.set(input.nativeRequestId,{controller,helperId:h.helperId});
      const binding={task,stage:h.stage,modelRef:h.model,maxOutputTokens:host.getBinding()?.maxOutputTokens??h.model.maxOutputTokens??null,assertOwned:()=>{check(h);policy.admitNativeHelper(h.capability,{operation:'model'});}};
      const streamPolicy=createRequestPolicy({getBinding:()=>binding,getSecrets:host.getSecrets});
      try{const source=streamPolicy.stream(model,input.context,{signal:AbortSignal.any([controller.signal,metadata.signal,task.signal].filter(Boolean)),reasoning:h.native.thinking==='off'?undefined:h.native.thinking,maxTokens:binding.maxOutputTokens},host.rawNativeStreams[input.method==='stream'?'stream':'streamSimple']);
        return await collectBufferedNativeStream(source);
      }finally{streams.delete(input.nativeRequestId);}
    }
    if(action==='cancelModel'){const original=streams.get(input.nativeRequestId);if(original?.helperId!==h.helperId)throw problem('PROJECT_NATIVE_UNBOUND','Cancellation must name the original helper request');original.controller.abort();return {requested:true,terminalKnown:false};}
    if(action==='exec'){const assertAllowed=()=>{check(h);policy.admitNativeHelper(h.capability,{operation:'shell',scope:h.scope});};return isolatedCommand({source:h.native.containerSource,scope:h.scope,readOnly:h.readOnly,helperId:h.helperId},input.command,metadata,assertAllowed);}
    if(action==='tool'){check(h);if(input.tool==='read'&&input.args?.path?.startsWith('/resources/')){const resource=readTaskSkillResource(task,input.args.path);if(!resource)throw problem('SKILL_RESOURCE','Path is not in the frozen task resource manifest');(task.record.tools??=[]).push({kind:'skill_resource_read',name:'read',actor:'helper:'+h.helperId,stageId:h.stage?.id,resourceName:resource.record.name,sourcePath:join(resource.record.sourceDirectory,resource.relativePath),resourceHash:resource.hash,skillHash:resource.record.hash,path:input.args.path,status:'completed'});task.save();}if(!h.native.sessionId)throw problem('PROJECT_NATIVE_UNBOUND','Helper has no live session');const writing=['write','edit'].includes(input.tool);let scope=h.scope;
      if(writing){const requested=input.args?.path;if(typeof requested!=='string'||/[\\\0]/.test(requested))throw problem('SCOPE','Native write requires a safe source path');const canonical=posix.relative(h.native.containerSource,posix.resolve(h.native.containerSource,requested));if(!canonical||posix.isAbsolute(canonical)||canonical==='..'||canonical.startsWith('../')||canonical.split('/').some(part=>part.toLowerCase()==='.git'))throw problem('SCOPE','Native write path is outside its own source copy');scope=[canonical];}
      policy.admitNativeHelper(h.capability,{operation:writing?'write':input.tool==='bash'?'shell':'read',scope});return {authorized:true};}
    if(action==='children')return records().filter(child=>child.parentActorId===h.helperId).map(view);
    if(action==='result')return result(h.helperId,input);
    if(action==='terminal'){if(h.shutdownEvidence){if(JSON.stringify(h.shutdownEvidence)===JSON.stringify(input))return {recorded:true,reused:true};throw problem('PROJECT_NATIVE_REPLAY','Terminal receipt already has different facts');}if(h.native.sessionId!==input.sessionId&&input.sessionId)throw problem('PROJECT_NATIVE_UNBOUND','Terminal session differs from original launch');h.shutdownEvidence=input;task.save();return {recorded:true};}
    if(action==='finished'){
      if(h.native.finishedReceipt){if(JSON.stringify(h.native.finishedReceipt)===JSON.stringify(input))return {recorded:true,reused:true,stopped:Boolean(h.stoppedAt)};throw problem('PROJECT_NATIVE_REPLAY','Original result receipt already exists');}
      h.native.finishedReceipt=input;task.save();
      h.native.result=input.result;h.pluginReportedUsage=input.result.usage;h.text=input.result.text;
      try{if(!input.sdkTerminalObserved||!h.shutdownEvidence?.disposed||!h.shutdownEvidence?.shutdownCompleted){h.status='outcome_unknown';return {recorded:true,stopped:false};}
        const captured=await capture(h.native.containerSource,h.helperId+'-result',{resumeAfter:cleanup?.projectActive!==false});h.cwd=captured.directory;h.stoppedAt=stamp();h.status=input.result.exitCode===0&&!input.result.error?'completed':'failed';h.stage.status=h.status;
        try{freezeHelperResult(h,records());}catch(e){h.resultError={code:e.code,message:e.message};}return {recorded:true,stopped:true};
      }finally{policy.closeNativeHelper(h.capability);scheduling?.release('helper:'+h.helperId);task.save();}
    }
    throw problem('PROJECT_NATIVE_UNSUPPORTED','Unadapted native action: '+action);
  }
  async function result(parent,args){const h=records().find(h=>h.helperId===args.helperId&&h.parentActorId===parent);if(!h)throw problem('HELPER_PARENT','Only the actual creator can inspect or adopt');if(args.decision==='inspect')return view(h);
    if(records().some(child=>child.parentHelperId===h.helperId&&!child.treatment))throw problem('HELPERS_PENDING','Treat nested child results first');
    if(parent!==actor){const creator=children.get(parent);check(creator);if(!h.stoppedAt||!['completed','failed','cancelled'].includes(h.status)||h.treatment||!args.reason?.trim())throw problem('HELPER_RESULT','Nested result is not reviewable');
      if(args.decision==='reject'){h.treatment={decision:'rejected',reason:args.reason,at:stamp()};task.save();return h.treatment;}
      if(args.decision!=='adopt')throw problem('HELPER_REVIEW','Expected inspect/adopt/reject');if(h.status!=='completed'||!h.result||h.resultError)throw problem('HELPER_RESULT','Failed/invalid nested result cannot be adopted');
      await entry.runtime.mutateSource(creator.native.containerSource,path=>{
        check(creator);policy.admitNativeHelper(creator.capability,{operation:'write',scope:h.result.edits.map(e=>e.path)});const files=scan(path);
        for(const edit of h.result.edits)if((files[edit.path]?.contentHash??null)!==edit.oldHash)throw problem('STALE_PRIVATE','Creator overlay changed since child snapshot');
        for(const edit of h.result.edits){const file=join(path,edit.path);if(edit.contentBase64===null)rmSync(file,{force:true});else{mkdirSync(dirname(file),{recursive:true});writeFileSync(file,Buffer.from(edit.contentBase64,'base64'));chmodSync(file,edit.mode==='100755'?0o755:0o644);}}
      });h.treatment={decision:'adopted',reason:args.reason,destinationHelperId:parent,at:stamp()};task.save();return {treatment:h.treatment};
    }
    return treatHelperResult({task,versioning,helper:h,actor,binding:state.binding,decision:args.decision,reason:args.reason,assertAllowed:guard});
  }
  return {operation,result,
    async observeToolResult(value){
      const details=value.details;
      if(details?.mode==='workflow'&&details.asyncId){const o=[...operations.values()].find(o=>o.toolCallId===details.toolCallId);if(!o||o.nativeRunId&&o.nativeRunId!==details.runId)throw problem('PROJECT_NATIVE_UNBOUND','Workflow result has no original operation');o.nativeRunId=details.runId;task.save();}
      for(const completed of details?.completions??[]){
        const o=[...operations.values()].find(o=>o.nativeRunId===completed.runId&&!o.runnerProcessInstanceId);if(!o||o.stoppedAt)continue;
        const inventory=completed.workflowChildren;if(!inventory?.inventoryComplete||!['completed','failed','cancelled'].includes(inventory.workflowState))continue;
        const descendants=inventory.children.map(child=>[...children.values()].find(h=>h.native.runId===child.runId));
        if(descendants.some(h=>!h?.stoppedAt)||[...runners.values()].some(r=>!r.closedAt))throw problem('HELPERS_PENDING','Native workflow receipt precedes its actual child/runner terminal');
        const captured=await capture(o.containerSource,'workflow-result-'+o.operationId);o.cwd=captured.directory;o.stoppedAt=stamp();o.status=completed.success?'completed':'failed';o.originalCompletion=completed;
        try{freezeHelperResult(o,records());}catch(error){o.resultError={code:error.code,message:error.message};}
        if(!o.resultError&&!o.result.edits.length)o.treatment={decision:'rejected',reason:'Original completed workflow controller has no source delta',at:stamp()};task.save();
      }
    },owns:helperId=>records().some(h=>h.helperId===helperId&&h.parentActorId===actor),pending:()=>pending().map(view),hasActive:()=>records().some(h=>!h.stoppedAt&&(h.native||h.nativeBackground)),
    assertHandled(){if(pending().length)throw problem('HELPERS_PENDING','Native helper results require creator review: '+pending().map(h=>h.helperId).join(','));},
    async stopped(){
      for(const item of streams.values())item.controller.abort();
      const interrupted=records().filter(h=>!h.stoppedAt);for(const h of interrupted){h.status='outcome_unknown';h.stopError='Local cgroup stopped without a complete original native terminal/result receipt; model effect may remain unknown';h.stoppedAt=entry.record.containerStoppedAt;}
      for(const h of children.values()){scheduling?.release('helper:'+h.helperId);policy.closeNativeHelper(h.capability);}
      for(const h of interrupted){try{const captured=await capture(h.native?.containerSource??h.containerSource,'interrupted-'+h.helperId);h.cwd=captured.directory;freezeHelperResult(h,records());h.partialResult=true;}catch(error){h.resultError={code:error.code,message:error.message};}}task.save();
    }};
}
const cleanModel=projectModelMetadata;
