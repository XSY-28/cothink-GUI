// PROJECT owns business authority and receipts; Pi owns the actual MCP protocol.
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,existsSync,readdirSync,lstatSync,realpathSync,cpSync} from 'node:fs';
import {join,resolve,relative,isAbsolute,dirname} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {openProjectMcp,recoverProjectMcpCommand,projectMcpServerConfig,projectMcpHttpConfig,scrubMcpOutput as scrub} from './project-mcp.js';
export {projectMcpSummary,discoverProjectMcp} from './project-mcp.js';
import {snapshotHelper,freezeHelperResult,treatHelperResult} from './plugin-work.js';
import {redact,privateDirectory} from './storage.js';
import {problem} from './task.js';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const response=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
const kinds=['read','write','start','query','cancel'];
function scrubRuntime(record,secrets) {
  // Host identities, exact approved arguments and hashes are authority, not server
  // output; changing them would detach receipts from their original operation.
  for(const key of ["protocolError","stopError","error","tools","observedTools"]) {
    if(typeof record[key]==="string")record[key]=redact(record[key],secrets);else scrub(record[key],secrets);
  }
  for(const request of record.requests??[]) {
    scrub(request.result,secrets);scrub(request.error,secrets);
    if(request.recovery)scrub(request.recovery.result,secrets);
  }
}
function sanitizedError(error,secrets=[]) {
  if(!error||typeof error!=="object")return new Error(redact(String(error),secrets));
  if(typeof error.message==="string")error.message=redact(error.message,secrets);
  if(typeof error.stack==="string")error.stack=redact(error.stack,secrets);
  if(error.cause)error.cause=sanitizedError(error.cause,secrets);
  scrub(error,secrets);return error;
}
function safeMaterial(value) {
  if(!value||typeof value!=='object')return;
  for(const [key,item]of Object.entries(value)) {
    if(/authorization|password|secret|api.?key|access.?token|refresh.?token|headers/i.test(key))throw problem('PROJECT_MCP_SECRET','MCP credentials belong in pi/mcp.json, never in plans or tool arguments');
    safeMaterial(item);
  }
}
export function validateProjectMcp(selections=[]) {
  if(!Array.isArray(selections))throw problem('PROJECT_MCP_PLAN','mcp must be a list of confirmed server contracts');
  const servers=new Set();
  return selections.map(selection=>{
    safeMaterial(selection);
    if(!selection||Object.keys(selection).some(k=>!['server','trust','tools'].includes(k))||typeof selection.server!=='string'||!selection.server.trim()||servers.has(selection.server))throw problem('PROJECT_MCP_PLAN','Each MCP server needs one unique configured name');
    servers.add(selection.server);
    if(!['explicit-service-contract','verified-server-readonly'].includes(selection.trust))throw problem('PROJECT_MCP_TRUST','Confirm the actual service contract or server-enforced readonly account');
    if(!selection.tools||Array.isArray(selection.tools)||!Object.keys(selection.tools).length)throw problem('PROJECT_MCP_PLAN','Select actual MCP tools and their operation contracts');
    for(const [name,grant]of Object.entries(selection.tools)) {
      if(!/^[\w.-]+$/.test(name)||!grant||!kinds.includes(grant.kind)||Object.keys(grant).some(k=>!['kind','target','action','round','allowedArguments','recovery','feeBoundary'].includes(k)))throw problem('PROJECT_MCP_PLAN','Invalid confirmed MCP tool contract');
      if(typeof grant.target!=='string'||!grant.target.trim())throw problem('PROJECT_MCP_PLAN','MCP grants need an explicit target');
      if(['write','start'].includes(grant.kind)&&(typeof grant.action!=='string'||!grant.action.trim()||!Number.isSafeInteger(grant.round)||grant.round<1))throw problem('PROJECT_MCP_PLAN','MCP mutations need the confirmed work effect target/action/round');
      if(['query','cancel'].includes(grant.kind)) {
        const r=grant.recovery;
        if(!r||Object.keys(r).some(k=>!['originalTool','jobArgument','sourceArgument','statusField','jobField','terminalValues'].includes(k))||!['originalTool','jobArgument','sourceArgument'].every(k=>typeof r[k]==='string'&&r[k])||!selection.tools[r.originalTool]||selection.tools[r.originalTool].kind!=='start')throw problem('PROJECT_MCP_PLAN','Recovery must name the original start tool and exact job argument binding');
        if(grant.kind==='query'&&(!r.statusField||!r.jobField||!Array.isArray(r.terminalValues)||!r.terminalValues.length||r.terminalValues.some(x=>typeof x!=='string')))throw problem('PROJECT_MCP_PLAN','Status recovery needs the exact job/status response mapping and terminal values');
      } else if(!Array.isArray(grant.allowedArguments)||!grant.allowedArguments.length||grant.allowedArguments.some(v=>!v||Array.isArray(v)||typeof v!=='object'))throw problem('PROJECT_MCP_PLAN','Select exact allowed argument objects for each MCP operation');
      if(selection.trust==='verified-server-readonly'&&!['read','query'].includes(grant.kind))throw problem('PROJECT_MCP_READONLY','The confirmed readonly service cannot grant mutations');
      if(grant.feeBoundary&&(!Number.isFinite(grant.feeBoundary.maxCost)||grant.feeBoundary.maxCost<0))throw problem('PROJECT_MCP_PLAN','Invalid MCP fee boundary');
    }
    return structuredClone(selection);
  });
}
function treeDigest(root) {
  const items=[];
  function walk(directory,prefix='') {
    for(const name of readdirSync(directory).sort()) {
      const path=join(directory,name),stat=lstatSync(path),part=prefix+name;
      if(stat.isSymbolicLink()||!stat.isDirectory()&&!stat.isFile()||stat.isFile()&&stat.nlink!==1)throw problem('PROJECT_MCP_SOURCE','MCP code contains an unsupported link or file: '+part);
      if(name==='.git'||name==='.env'||name==='auth.json')throw problem('PROJECT_MCP_SOURCE','MCP code directory includes private or repository metadata: '+part);
      if(stat.isDirectory())walk(path,part+'/');else items.push([part,stat.mode&0o111,createHash('sha256').update(readFileSync(path)).digest('hex')]);
    }
  }
  walk(root);return hash(items);
}
function configured(task,selection,index) {
  const config=projectMcpServerConfig(task.home,selection.server);
  const safe={server:selection.server,trust:selection.trust,tools:selection.tools};
  if(config.url)return projectMcpHttpConfig(config,selection);
  if(config.type&&config.type!=='stdio'||config.transport&&config.transport!=='stdio')throw problem('PROJECT_MCP_UNSUPPORTED','Command MCP requires the stdio transport');
  if(config.command!=='node'||!Array.isArray(config.args)||config.args.length!==1||typeof config.args[0]!=='string'||!isAbsolute(config.cwd??''))throw problem('PROJECT_MCP_UNSUPPORTED','Command MCP currently requires node, one JS entry and an absolute dedicated code cwd');
  const source=realpathSync(config.cwd),entryPath=realpathSync(resolve(source,config.args[0])),entry=relative(source,entryPath);
  if(!entry||entry.startsWith('..')||isAbsolute(entry)||!/[.]m?js$/.test(entry))throw problem('PROJECT_MCP_SOURCE','Node entry must belong to the selected dedicated code directory');
  const home=realpathSync(task.home),userHome=process.env.HOME&&realpathSync(process.env.HOME);
  if(source==='/'||source===userHome||home===source||!relative(source,home).startsWith('..'))throw problem('PROJECT_MCP_SOURCE','Do not mount an entire home or CoThink data root as MCP code');
  const sourceDigest=treeDigest(source),directory=join(task.home,'tasks',task.record.id+'-project-mcp','code',String(index));
  const saved=task.record.work?.mcpSources?.find(s=>s.server===selection.server);
  if(saved) {
    if(saved.source!==source||saved.sourceDigest!==sourceDigest||treeDigest(saved.directory)!==sourceDigest)throw problem('PROJECT_MCP_SOURCE','Original or frozen MCP source changed; obtain a new confirmed task');
  } else {
    if(existsSync(directory))throw problem('PROJECT_MCP_SOURCE','An unbound MCP code snapshot already exists');
    privateDirectory(dirname(directory));cpSync(source,directory,{recursive:true,dereference:false});
    if(treeDigest(directory)!==sourceDigest||treeDigest(source)!==sourceDigest)throw problem('PROJECT_MCP_SOURCE','MCP source changed during snapshot');
    ((task.record.work??={}).mcpSources??=[]).push({server:selection.server,source,directory,sourceDigest});task.save();
  }
  return {selection,directory,entry,connection:{trust:selection.trust},digest:hash({...safe,sourceDigest,entry})};
}
export async function createProjectMcpContext({task,versioning,execution,state,indexOffset=0}) {
  const selections=validateProjectMcp(task.record.project.mcp??[]),actor=state.actor,entries=selections.map((s,i)=>configured(task,s,i+indexOffset));
  let sessionId,phase,closed=false,busy=false;
  const results=()=> (task.record.tools??[]).filter(r=>r.kind==='project_mcp_result'&&r.parentActorId===actor&&!r.treatment);
  const guard=()=>{state.assertAllowed?.();if(closed||task.signal.aborted||state.signal?.aborted||task.record.status!=='running')throw problem('CANCELLED','MCP creator is no longer active');};
  const spec=entry=>({server:entry.selection.server,actor,sessionId,sourceDigest:entry.source.digest,changeId:entry.record.changeId,inputVersion:entry.record.inputVersion,
    registrationVersion:entry.record.registrationVersion,containerProofDigest:entry.record.commandIdentity?.digest,readOnly:entry.record.readOnly,scope:entry.record.scope,readScope:entry.record.readScope,localNoNetwork:!entry.source.connection.url});
  const authorize=(entry,detail)=>task.projectPolicy.admitMcp({...spec(entry),...detail,server:entry.selection.server,capability:entry.capability});
  const save=entry=>{scrubRuntime(entry.record,entry.source.secrets??[]);for(const receipt of entry.record.requests??[]){
    const calls=task.record.tools?.filter(t=>t.kind==='project_mcp_call'&&(t.requestId===receipt.id||t.originalRequestId===receipt.id)&&t.parentActorId===actor)??[];
    for(const call of calls)for(const key of ['status','sent','jobId','result','error'])if(receipt[key]!==undefined)call[key]=structuredClone(receipt[key]);
    task.projectPolicy.observeMcpRequest(receipt);
  }task.save();};
  const stop=async entry=>{try{if(entry.api){await entry.api.close();entry.api=null;}save(entry);}catch(error){throw sanitizedError(error,entry.source.secrets??[]);}};
  async function settleEntries(captureResults) {
    const outcomes=await Promise.allSettled(entries.filter(entry=>entry.api).map(async entry=>{
      const errors=[];
      if(captureResults&&entry.source.directory)try{await harvest(entry);}catch(error){errors.push(sanitizedError(error,entry.source.secrets??[]));}
      try{await stop(entry);}catch(error){errors.push(error);}
      if(errors.length)throw new AggregateError(errors,'MCP service cleanup failed: '+entry.selection.server);
    }));
    const errors=outcomes.filter(result=>result.status==='rejected').map(result=>result.reason);
    if(errors.length)throw new AggregateError(errors,'All owned MCP service stops were attempted; one or more receipts remain unresolved');
  }
  async function harvest(entry) {
    if(!entry.source.directory)return null;
    if(entry.record.status!=='frozen')await entry.api.freeze();
    const probe={cwd:entry.record.cwd,snapshot:entry.snapshot,scope:entry.record.scope,readOnly:entry.record.readOnly,stoppedAt:new Date().toISOString()};let error;
    try{freezeHelperResult(probe);}catch(e){error=e;}
    if(!error&&!probe.result.edits.length)return null;
    await stop(entry);probe.stoppedAt=entry.record.stoppedAt;
    try{freezeHelperResult(probe);}catch(e){error??=e;}
    const resultId=randomUUID(),archive=entry.record.cwd+'-results/'+resultId;privateDirectory(dirname(archive));cpSync(entry.record.cwd,archive,{recursive:true,dereference:false});
    const result={...probe,cwd:archive,resultId,name:'project_mcp_result',kind:'project_mcp_result',parentActorId:actor,changeId:entry.record.changeId,inputVersion:entry.record.inputVersion,
      server:entry.selection.server,sourceDigest:entry.source.digest,registrationVersion:entry.record.registrationVersion,operationReceiptId:entry.record.requests.at(-1)?.id,operationStatus:entry.record.requests.at(-1)?.status,status:error?'failed':'completed',resultError:error?.message};
    (task.record.tools??=[]).push(result);task.save();return result;
  }
  async function startInternal(entry) {
    guard();const current=state.binding.current;
    if(['worker-prepare','worker-conflict-resolution'].includes(phase))throw problem('PROJECT_MCP_PREPARATION','MCP actions require completed independent preparation');
    if((task.record.tools??[]).some(r=>r.kind==='project_mcp_runtime'&&r.parentActorId===actor&&r.serverName===entry.selection.server&&!r.stoppedAt&&['stop_unknown','outcome_unknown'].includes(r.status)))throw problem('OUTCOME_UNKNOWN','Original MCP process stop is unknown; do not replace it');
    if(entry.api)await stop(entry);
    if(entry.source.directory&&treeDigest(entry.source.directory)!==entry.source.codeDigest)throw problem('PROJECT_MCP_SOURCE','Frozen MCP code changed');
    const directory=join(task.home,'tasks',task.record.id+'-project-mcp',actor.replaceAll(':','-'),randomUUID());
    const snapshot=await snapshotHelper({versioning,change:current,directory});
    const record={kind:'project_mcp_runtime',name:'project_mcp_runtime',runtimeId:randomUUID(),taskId:task.record.id,serverName:entry.selection.server,parentActorId:actor,sessionId,sourceDigest:entry.source.digest,changeId:current.changeId,inputVersion:snapshot.inputVersion,
      scope:snapshot.scope,readScope:snapshot.readScope,readOnly:Boolean(current.readOnly),cwd:directory,requests:[]};
    record.snapshot=snapshot;entry.record=record;entry.snapshot=snapshot;entry.capability=task.projectPolicy.issueMcpCapability(spec(entry));(task.record.tools??=[]).push(record);task.save();
    const tools=Object.fromEntries(Object.entries(entry.selection.tools).map(([name,grant])=>[name,{...grant,cost:entry.source.directory?0:null}]));
    entry.api=await openProjectMcp({connection:{...entry.source.connection,tools,execution,codeDirectory:entry.source.directory,entry:entry.source.entry,workspace:directory,readOnly:record.readOnly},record,
      save:()=>save(entry),authorize:detail=>authorize(entry,detail),signal:AbortSignal.any([task.signal,state.signal].filter(Boolean))});
    const savedRegistration=task.record.work?.mcpRegistrations?.find(r=>r.server===entry.selection.server);
    const approved=savedRegistration?.registrationVersion??entry.registrationVersion;
    if(approved&&approved!==record.registrationVersion) {
      record.observedRegistrationVersion=record.registrationVersion;record.registrationChanged=true;record.registrationVersion=approved;
      await stop(entry);throw problem('PROJECT_MCP_SCHEMA','MCP registration changed under the old plan; obtain a new confirmed task');
    }
    if(!savedRegistration){((task.record.work??={}).mcpRegistrations??=[]).push({server:entry.selection.server,registrationVersion:record.registrationVersion});task.save();}
    entry.registrationVersion=record.registrationVersion;entry.capability=task.projectPolicy.issueMcpCapability(spec(entry));
    if(entry.source.directory){await entry.api.freeze();await harvest(entry);}
  }
  async function start(entry) {
    try{return await startInternal(entry);}catch(error){throw sanitizedError(error,entry.source.secrets??[]);}
  }
  function requireRegisteredTool(entry,tool) {
    if(!entry.record.tools.some(t=>t.name===tool))throw problem('PROJECT_MCP_TOOL','Confirmed MCP tool is not registered: '+tool);
  }
  async function ensure(entry,tool) {
    const current=state.binding.current;
    if(!entry.api||sessionId!==entry.record.sessionId||current.changeId!==entry.record.changeId||current.privateVersion!==entry.record.inputVersion||Boolean(current.readOnly)!==entry.record.readOnly||!isDeepStrictEqual(current.scope,entry.record.scope)||!isDeepStrictEqual(current.readScope,entry.record.readScope))await start(entry);
    requireRegisteredTool(entry,tool);
  }
  async function recoverOriginal(originalRequestId,action) {
    // Recovery deliberately does not call guard(): pause leaves only this original-handle authority.
    const entry=entries.find(e=>e.record?.requests.some(r=>r.id===originalRequestId));
    if(!entry?.api||entry.source.directory&&(closed||task.signal.aborted||state.signal?.aborted)) {
      const originalRuntime=task.record.tools?.find(r=>r.kind==='project_mcp_runtime'&&r.requests?.some(q=>q.id===originalRequestId));
      if(originalRuntime?.parentActorId!==actor)throw problem('PROJECT_MCP_RECOVERY','Only the original creator may recover this receipt');
      return recoverProjectMcpReceipt({home:task.home,record:task.record,projectPolicy:task.projectPolicy,originalRequestId,action,save:()=>task.save()});
    }
    const original=entry.record.requests.find(r=>r.id===originalRequestId);
    const grants=Object.entries(entry.selection.tools).filter(([,g])=>g.kind===action&&g.recovery?.originalTool===original.tool);
    if(grants.length!==1)throw problem('PROJECT_MCP_RECOVERY','No unique confirmed original-job recovery endpoint');
    const [tool,grant]=grants[0],r=grant.recovery,jobId=original.jobId??original.args?.[r.sourceArgument];
    if(typeof jobId!=='string'||!jobId)throw problem('PROJECT_MCP_RECOVERY','Original operation has no reliable saved job identity');
    const args={[r.jobArgument]:jobId},requestId=randomUUID();
    authorize(entry,{kind:action,tool,args,requestId,original});
    if(entry.source.directory)await entry.api.resume();
    const result=await entry.api.query({tool,args,requestId,originalRequestId});
    if(entry.source.directory)await entry.api.freeze();
    const body=result.structuredContent;
    if(action==='query'&&!result.isError&&body?.[r.jobField]===jobId&&r.terminalValues.includes(body?.[r.statusField])) {
      original.status='completed';original.recovery={requestId,tool,jobId,result,at:new Date().toISOString()};original.result=result;save(entry);
    }
    return {originalRequestId,status:original.status,value:result,cancelAckIsNotStop:action==='cancel'};
  }
  async function recover(originalRequestId,action) {
    if(busy)throw problem('PROJECT_MCP_PENDING','The original MCP operation still owns this service; query its saved receipt once settled');
    busy=true;
    try{return await recoverOriginal(originalRequestId,action);}
    catch(error){throw sanitizedError(error,entries.flatMap(entry=>entry.source.secrets??[]));}
    finally{try{for(const entry of entries)if(entry.api&&entry.source.directory&&entry.record.status!=="frozen")await entry.api.freeze();}finally{busy=false;}}
  }
  task.projectPolicy.registerMcpRecovery(actor,recover);
  for(const source of entries){source.source={...source};if(source.directory)source.source.codeDigest=treeDigest(source.directory);}
  return {actor,cwd:state.binding.current.workspace,get changeId(){return state.binding.current.changeId;},bindSession:async id=>{sessionId=id;},
    async projectTools() {
      guard();const definitions=[];
      // Frozen contracts define tool availability. Connect only for an actual
      // operation; ensure() verifies registration before any business call.
      for(const [index,entry]of entries.entries()) {
        for(const [tool,grant]of Object.entries(entry.selection.tools)) {
          if(['query','cancel'].includes(grant.kind))continue;
          definitions.push({name:'project_mcp_'+index+'_'+tool,label:'project_mcp_'+tool,description:'Confirmed '+entry.selection.server+' '+grant.kind+' at '+grant.target+'. Choose an existing owned work; arguments must exactly match a confirmed allowed argument object. External effects are not model calls.',
            parameters:{type:'object',properties:{workId:{type:'string'},arguments:{type:'object'}},required:['workId','arguments'],additionalProperties:false},
            execute:async(id,input)=>{
              guard();if(['worker-prepare','worker-conflict-resolution'].includes(phase))throw problem('PROJECT_MCP_PREPARATION','MCP operations require completed independent preparation');if(busy||results().length)throw problem('PROJECT_MCP_PENDING','Finish or review the existing MCP operation/result first');
              safeMaterial(input.arguments);if(!grant.allowedArguments.some(a=>isDeepStrictEqual(a,input.arguments)))throw problem('PROJECT_MCP_ARGUMENTS','Arguments do not match the confirmed target/parameter scope');
              busy=true;
              try {
                await ensure(entry,tool);if(results().length)throw problem('PROJECT_MCP_PENDING','MCP startup produced a file result; review it first');const requestId='mcp:'+id,payloadDigest=hash({tool,args:input.arguments});
                let trace=task.record.tools?.find(t=>t.kind==='project_mcp_call'&&t.requestId===requestId);
                if(trace){
                  if(trace.parentActorId!==actor||trace.sourceDigest!==entry.source.digest||trace.tool!==tool||trace.payloadDigest!==payloadDigest||trace.workId!==input.workId)throw problem('PROJECT_MCP_REPLAY','Original MCP call identity belongs to different source/actor/work/parameters');
                  return response({originalRequestId:trace.originalRequestId??requestId,status:trace.status,value:trace.value??trace.result??null,instruction:'Inspect the original task-owned MCP intent; no replay.'});
                }
                const effect=['write','start'].includes(grant.kind)?{target:grant.target,action:grant.action,round:grant.round}:null;
                const held=task.record.tools?.find(t=>t.kind==='project_mcp_call'&&['intent','pending','outcome_unknown'].includes(t.status)&&(t.workId===input.workId||effect&&isDeepStrictEqual(t.effect,effect)));
                if(held){
                  if(held.sourceDigest!==entry.source.digest||held.tool!==tool||held.payloadDigest!==payloadDigest)throw problem('PROJECT_EFFECT_HELD','Original unresolved task intent has different source/tool/parameters: '+held.requestId);
                  return response({originalRequestId:held.originalRequestId??held.requestId,status:held.status,instruction:'Original MCP intent remains occupied; no replay.'});
                }
                trace={kind:'project_mcp_call',name:'project_mcp_call',requestId,toolCallId:id,parentActorId:actor,sessionId,workId:input.workId,server:entry.selection.server,sourceDigest:entry.source.digest,runtimeId:entry.record.runtimeId,tool,args:structuredClone(input.arguments),scope:[...entry.record.scope],containerProofDigest:entry.record.commandIdentity?.digest,stageId:task.record.stages?.findLast(s=>s.sessionId===sessionId&&s.role===actor)?.id,payloadDigest,...(effect?{effect}:{}),changeId:entry.record.changeId,inputVersion:entry.record.inputVersion,status:'intent',sent:null};
                (task.record.tools??=[]).push(trace);task.save();
                let claim;
                try{claim=task.projectPolicy.claimMcpEffect({...spec(entry),capability:entry.capability,kind:grant.kind,tool,workId:input.workId,requestId,args:input.arguments,payloadDigest});}
                catch(error){trace.status='not_sent';trace.sent=false;trace.error={code:error.code,message:error.message};task.save();throw error;}
                if(claim.reused||claim.id!==requestId||claim.status!=='intent'){
                  trace.status=claim.status;trace.originalRequestId=claim.id;trace.result=claim.result;task.save();
                  return response({originalRequestId:claim.id,status:claim.status,value:claim.result??null,instruction:'Use the original receipt; no new external effect was sent.'});
                }
                if(entry.source.directory)await entry.api.resume();
                let value,error;try{value=redact(await entry.api.call({tool,args:input.arguments,effectKey:claim.effect?JSON.stringify(claim.effect):requestId,requestId}),entry.source.secrets??[]);}catch(e){error=sanitizedError(e,entry.source.secrets??[]);}
                const result=entry.api&&entry.source.directory?await harvest(entry):null;
                const receipt=entry.record.requests.find(r=>r.id===requestId);if(error) return response({originalRequestId:requestId,status:receipt?.status??'outcome_unknown',error:error.message,projectMcpResultId:result?.resultId});
                return response({originalRequestId:requestId,status:receipt.status,value,projectMcpResultId:result?.resultId,instruction:result?'Inspect then adopt/reject with project_mcp_result; public source is unchanged.':undefined});
              }finally{busy=false;}
            }});
        }
      }
      definitions.push({name:'project_mcp_recover',label:'project_mcp_recover',description:'Query or request cancellation only through the original MCP receipt and fixed original-job endpoint. Cancel ACK does not prove stop.',parameters:{type:'object',properties:{originalRequestId:{type:'string'},action:{enum:['query','cancel']}},required:['originalRequestId','action'],additionalProperties:false},execute:async(_id,args)=>response(await recover(args.originalRequestId,args.action))});
      definitions.push({name:'project_mcp_result',label:'project_mcp_result',description:'Creator inspects the complete stopped MCP file delta, then adopts/rejects through public edit; formal acceptance is separate.',parameters:{type:'object',properties:{resultId:{type:'string'},decision:{enum:['inspect','adopt','reject']},reason:{type:'string'}},required:['resultId','decision'],additionalProperties:false},execute:async(_id,args,signal)=>{
        const result=(task.record.tools??[]).find(r=>r.kind==='project_mcp_result'&&r.resultId===args.resultId&&r.parentActorId===actor);if(!result)throw problem('HELPER_PARENT','Only the actual MCP result creator may review this result');
        if(args.decision==='inspect')return response(result);guard();return response(await treatHelperResult({task,versioning,helper:result,actor,binding:state.binding,decision:args.decision,reason:args.reason,assertAllowed:guard,signal}));
      }});return definitions;
    },
    beforePrompt:async input=>{phase=input?.phase;return results().length?'Inspect/adopt/reject pending MCP file results: '+results().map(r=>r.resultId).join(','):'';},
    recover,
    async seal(){await settleEntries(true);},
    assertHandled(){if(task.projectPolicy.unresolvedMcpClaims?.(actor)?.length||(task.record.tools??[]).some(t=>t.kind==='project_mcp_call'&&t.parentActorId===actor&&['intent','pending','outcome_unknown'].includes(t.status)))throw problem('PROJECT_MCP_UNKNOWN','Original task-owned MCP intent has no decisive terminal receipt');if(busy||results().length)throw problem('PROJECT_MCP_PENDING','MCP files require creator review');for(const record of task.record.tools??[])if(record.kind==='project_mcp_runtime'&&record.parentActorId===actor&&record.requests?.some(r=>!r.originalRequestId&&['pending','outcome_unknown'].includes(r.status)))throw problem('PROJECT_MCP_UNKNOWN','External effect remains unknown; inspect the original receipt');},
    async afterShutdown(){closed=true;await settleEntries(true);return results().map(r=>r.resultId);},
    async close(){closed=true;await settleEntries(false);},
  };
}

// A recovery connection has no general call interface. Its only business operation
// is derived from the immutable original task receipt and confirmed status contract.
export async function recoverProjectMcpReceipt({home,record,projectPolicy,originalRequestId,action,save}) {
  if(!['query','cancel'].includes(action))throw problem('PROJECT_MCP_RECOVERY','Only original-job status or cancellation is admitted');
  const call=record.tools?.find(t=>t.kind==='project_mcp_call'&&t.requestId===originalRequestId);
  const runtime=record.tools?.find(r=>r.kind==='project_mcp_runtime'&&(r.requests?.some(q=>q.id===originalRequestId)||call?.runtimeId&&r.runtimeId===call.runtimeId));
  const original=runtime?.requests.find(r=>r.id===originalRequestId&&!r.originalRequestId)??(runtime&&call?{id:originalRequestId,tool:call.tool,args:call.args,status:call.status,sent:call.sent}:null);
  if(!original)throw problem('PROJECT_MCP_RECOVERY','No original task-owned MCP effect receipt');
  if(runtime.containerId) {
    const proof=runtime.commandIdentity;
    const spec={server:runtime.serverName,actor:runtime.parentActorId,sessionId:runtime.sessionId,sourceDigest:runtime.sourceDigest,changeId:runtime.changeId,inputVersion:runtime.inputVersion,
      registrationVersion:runtime.registrationVersion,readOnly:runtime.readOnly,scope:runtime.scope,readScope:runtime.readScope,localNoNetwork:true,cleanupOnly:true,containerProofDigest:proof?.digest};
    const capability=projectPolicy.issueMcpRecoveryCapability(spec,originalRequestId);
    if(['pending','intent'].includes(original.status)){original.status='outcome_unknown';for(const call of record.tools??[])if(call.kind==='project_mcp_call'&&(call.requestId===originalRequestId||call.originalRequestId===originalRequestId))call.status='outcome_unknown';projectPolicy.observeMcpRequest(original);save();}
    const authorize=detail=>projectPolicy.admitMcp({...spec,...detail,original,capability});
    const observation=await recoverProjectMcpCommand({record:runtime,save,authorize,stop:action==='cancel'});
    let resultId;
    if(observation.stoppedVerified&&!runtime.recoveryResultId) {
      if(!runtime.snapshot||runtime.snapshot.inputVersion!==runtime.inputVersion)throw problem('PROJECT_MCP_RECOVERY','Original source snapshot evidence is missing; stopped source retained without automatic import');
      if(!proof||realpathSync(runtime.cwd)!==proof.workspace)throw problem('MCP_CONTAINER_IDENTITY','Historical workspace path changed; stopped source cannot be safely archived');
      const archiveId=randomUUID(),archive=runtime.cwd+'-results/'+archiveId;privateDirectory(dirname(archive));
      cpSync(runtime.cwd,archive,{recursive:true,dereference:false});
      const result={kind:'project_mcp_result',name:'project_mcp_result',resultId:archiveId,parentActorId:runtime.parentActorId,server:runtime.serverName,sourceDigest:runtime.sourceDigest,
        changeId:runtime.changeId,inputVersion:runtime.inputVersion,cwd:archive,snapshot:runtime.snapshot,scope:runtime.scope,readOnly:runtime.readOnly,stoppedAt:runtime.stoppedAt,
        status:'completed',origin:'original-command-cgroup-cleanup',operationReceiptId:originalRequestId,operationStatus:original.status,
        businessOutcome:'unknown',stopEvidence:observation};
      try{freezeHelperResult(result);}catch(error){result.status='failed';result.resultError=error.message;}
      // The stopped original copy and complete failed/partial archive both remain available.
      (record.tools??=[]).push(result);runtime.recoveryResultId=archiveId;resultId=archiveId;save();
    } else resultId=runtime.recoveryResultId;
    return {originalRequestId,status:original.status,jobOutcome:'unknown',processObservation:observation,projectMcpResultId:resultId,
      instruction:'Original local process evidence only. Source bytes are retained; no job completion, replay or automatic import was inferred.'};
  }
  const selection=validateProjectMcp(record.project?.mcp).find(s=>s.server===runtime.serverName);
  if(!selection)throw problem('PROJECT_MCP_RECOVERY','Original server contract is missing');
  const source=configured({home,record,save},selection,0);
  if(!source.connection.url)throw problem('PROJECT_MCP_RECOVERY','Command recovery cannot restart its original process; inspect its saved cgroup stop evidence');
  if(source.digest!==runtime.sourceDigest)throw problem('PROJECT_MCP_STALE','Server, account or confirmed operation contract changed since the original receipt');
  const endpoints=Object.entries(selection.tools).filter(([,g])=>g.kind===action&&g.recovery?.originalTool===original.tool);
  if(endpoints.length!==1)throw problem('PROJECT_MCP_RECOVERY','Original receipt has no unique confirmed recovery endpoint');
  const [tool,grant]=endpoints[0],r=grant.recovery,jobId=original.jobId??original.args?.[r.sourceArgument];
  if(typeof jobId!=='string'||!jobId)throw problem('PROJECT_MCP_RECOVERY','Original receipt has no reliable saved job ID');
  const requestId=randomUUID(),args={[r.jobArgument]:jobId},spec={server:runtime.serverName,actor:runtime.parentActorId,sessionId:runtime.sessionId,sourceDigest:runtime.sourceDigest,changeId:runtime.changeId,inputVersion:runtime.inputVersion,registrationVersion:runtime.registrationVersion,readOnly:runtime.readOnly,scope:runtime.scope,readScope:runtime.readScope,localNoNetwork:false};
  const capability=projectPolicy.issueMcpRecoveryCapability(spec,originalRequestId),authorize=detail=>projectPolicy.admitMcp({...spec,...detail,...(detail.kind==='connect'?{kind:action,tool,args,requestId,original}:{}),server:runtime.serverName,capability});
  const persist=()=>{scrubRuntime(runtime,source.secrets??[]);for(const receipt of runtime.requests){const calls=record.tools?.filter(t=>t.kind==='project_mcp_call'&&(t.requestId===receipt.id||t.originalRequestId===receipt.id))??[];for(const call of calls)for(const key of ['status','sent','jobId','result','error'])if(receipt[key]!==undefined)call[key]=structuredClone(receipt[key]);projectPolicy.observeMcpRequest(receipt);}save();};
  if(runtime.registrationChanged)throw problem('PROJECT_MCP_SCHEMA','Original MCP registration was revoked after a schema change');
  const oldVersion=runtime.registrationVersion,oldTools=runtime.tools;
  let api;
  try {
    api=await openProjectMcp({connection:{...source.connection,tools:Object.fromEntries(Object.entries(selection.tools).map(([name,g])=>[name,{...g,cost:null}]))},record:runtime,save:persist,authorize});
    if(runtime.registrationVersion!==oldVersion){runtime.observedRegistrationVersion=runtime.registrationVersion;runtime.registrationVersion=oldVersion;runtime.tools=oldTools;runtime.registrationChanged=true;persist();throw problem('PROJECT_MCP_SCHEMA','Original recovery schema changed; no status tool was called');}
    const value=redact(await api.query({tool,args,requestId,originalRequestId}),source.secrets??[]),body=value.structuredContent;
    if(action==='query'&&!value.isError&&body?.[r.jobField]===jobId&&r.terminalValues.includes(body?.[r.statusField])) {
      original.status='completed';original.recovery={requestId,tool,jobId,result:value,at:new Date().toISOString()};original.result=value;persist();
    }
    return {originalRequestId,status:original.status,value,cancelAckIsNotStop:action==='cancel'};
  }catch(error){throw sanitizedError(error,source.secrets??[]);}
  finally{try{await api?.close();}catch(error){throw sanitizedError(error,source.secrets??[]);}}
}
