import { loadInputMaterials } from "./context.js";
import {guiTurnIntent} from "./gui-turn-options.js";
import { assertCleanProjectProcess } from "./pi-runtime.js";
import {createHash,randomUUID} from 'node:crypto';
import { realpathSync } from 'node:fs';
import {runTurn} from './discussion.js';
import {conversationTaskIds} from './conversation.js';
import {problem,readRequest,readRequests,readTask,rootUsage,taskDisplayStatus} from './task.js';
import {legacyGit} from './git-versioning.js';
import {validProjectPath,inScope,createVersioning,readProjectContext} from './versioning.js';
import { requestSeats, projectChatState } from './project.js';
import {createProcessCheck} from './process-check.js';
import { checkPlanScope, selectedExecutionScope } from "./project-file-confirmation.js";
import { digest } from "./project-collaboration-evidence.js";
import { checkWorkProject, prepareWork, validateWorkIntent } from "./project-file-proposal.js";
import { bindReadonlyRoles } from "./project-readonly-roles.js";
export { digest, recordCollaborationResult } from "./project-collaboration-evidence.js";
export { assertConfirmedProjectState, checkedProposal, confirmationState, executeConfirmed, reserveConfirmation, workConfirmationBlocker } from "./project-file-confirmation.js";
export { resolveHandoffContext } from "./project-readonly-reports.js";
export { resolveDelivery, resolveDeliveryEvidence, resolveManagerFinal, resolveOwnedTasks } from "./project-delivery.js";

export const unifiedProtocol = 1;
const owners = new WeakSet();
export function assertRootOwner(owner,rootTaskId) {
  if(!owners.has(owner)||owner.rootTask.record.id!==rootTaskId) throw problem('ROOT_OWNER','A live trusted root owner is required');
  return owner;
}
export function normalizeConstraints(input={}) {
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['readOnly','allowedSubtasks','requireDifferentModelReview','networkMode'].includes(k)))throw problem('CONSTRAINTS','Invalid turn constraints');
  const value={readOnly:false,allowedSubtasks:['review','work'],requireDifferentModelReview:false,...input};
  if(typeof value.readOnly!=='boolean'||typeof value.requireDifferentModelReview!=='boolean'||!Array.isArray(value.allowedSubtasks)||value.allowedSubtasks.some(x=>!['review','work'].includes(x)))throw problem('CONSTRAINTS','Invalid turn constraints');
  if(value.networkMode!==undefined&&!['whole-turn-offline','artifact-offline'].includes(value.networkMode))throw problem('CONSTRAINTS','Invalid network mode');
  value.allowedSubtasks=[...new Set(value.allowedSubtasks)];return value;
}
export function normalizeRootBudget(input={}) {
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['maxCalls','maxCost'].includes(k)))throw problem('ROOT_BUDGET','Invalid root budget');
  const value={maxCalls:null,maxCost:null,...input};
  if(value.maxCalls!==null&&(!Number.isSafeInteger(value.maxCalls)||value.maxCalls<0))throw problem('ROOT_BUDGET','maxCalls must be a nonnegative integer or null');
  if(value.maxCost!==null&&(typeof value.maxCost!=='number'||!Number.isFinite(value.maxCost)||value.maxCost<0))throw problem('ROOT_BUDGET','maxCost must be nonnegative or null');
  return value;
}

export function createRootOwner(task, { processCheckClock } = {}) {
  if(task.record.flow!=='unified')throw problem('ROOT_OWNER','Root flow required');
  const children=new Map([[task.record.id,task]]),executions=new Map();let stopping,stopRequested=false;
  task.record.rootRequests??=[];
  const processCheck=createProcessCheck(task,processCheckClock);
  const ordinarySeat=requestSeats(task.record.frozenConfig?.work?.maxConcurrentRequests??2),checkSeat=requestSeats(1);
  const observations=new WeakMap();
  const owner={rootTask:task,processCheck,usage:()=>rootUsage(task.home,task.record),
    executorCapabilities(){
      // Only live objects admitted by this owner count. Persisted/inherited IDs do not grant tools.
      const values=[];
      if(stopRequested||task.signal.aborted||task.ioError||task.record.status!=='running')return values;
      for(const child of children.values()){
        if(child===task||child.rootOwner!==owner||child.record.rootTaskId!==task.record.id||child.record.project?.commandId!==task.record.projectOperation?.commandId||!task.record.projectOperation?.childTaskIds.includes(child.record.id)||child.record.status!=='running'||child.signal.aborted)continue;
        for(const runtime of child.runtimes){const value=runtime.capabilities();if(value.active&&value.source?.taskId===child.record.id)values.push(value);}
      }
      return values;
    },
    registerTask(child){
      if(stopRequested||task.signal.aborted||task.record.status!=='running')throw problem('ROOT_STOPPED','Root no longer accepts owned tasks');
      if(child!==task&&(child.record.rootTaskId!==task.record.id||!child.record.project||child.record.project.commandId!==task.record.projectOperation?.commandId))throw problem('ROOT_CHILD','Child does not belong to this operation');
      if(children.has(child.record.id)&&children.get(child.record.id)!==child)throw problem('ROOT_CHILD','Duplicate live child');
      children.set(child.record.id,child);child.rootOwner=owner;
      if(child!==task){task.record.projectOperation.projectId??=child.record.project.id;const ids=task.record.projectOperation.childTaskIds;if(!ids.includes(child.record.id))ids.push(child.record.id);task.save();}
    },
    acquireRequestSeat(signal,stage){return stage.phase==="process-check"?checkSeat(signal):ordinarySeat(signal);},
    bindReadonlyObservation({task:source,stage,observation,body}){
      if(source!==task||stage.phase!=="process-check"||stage.role!=="process-check"||observations.has(stage)||
          !task.record.processCheck?.observations.includes(observation)||observation.taskId!==task.record.id||
          observation.commandId!==null||observation.stageId!==stage.id||observation.sessionId!==stage.sessionId||
          observation.snapshotDigest!==createHash("sha256").update(body).digest("hex"))
        throw problem("PROCESS_UNBOUND","Checker must own the exact root observation");
      observations.set(stage,{observation,body});
    },
    reserveRequest({requestId,taskId,sessionId,stageId,model,cause}){
      const child=children.get(taskId),request=child?.requests().find(r=>r.id===requestId);
      const stage=child?.record.stages.find(item=>item.id===stageId);
      if(!stage||(stage.sessionId??child.record.sessionId)!==sessionId||!stage.callIds.includes(requestId)||request?.stageId!==stageId)throw problem('ROOT_REQUEST','Unregistered request identity');
      if(task.record.status!=='running'||task.signal.aborted||stopRequested)throw problem('ROOT_STOPPED','Root no longer permits sending');
      if(task.record.rootRequests.some(r=>r.requestId===requestId))throw problem('ROOT_REPLAY','Original request already reserved; query its journal');
      if(stage.assignment){
        if(stage.assignment.closedAt)throw problem("ROLE_CLOSED","Read-only assignment closed before dispatch");
        if(model.provider!==stage.modelRef.provider||model.modelId!==stage.modelRef.modelId||
          model.api!==stage.assignment.route.api||model.baseUrl!==stage.assignment.route.baseUrl)
          throw problem("MODEL_UNAVAILABLE","Actual route does not match the frozen role");
      }
      if(child===task&&stage.phase==="process-check"){
        const grant=observations.get(stage);
        const last=request.context?.messages?.at(-1);
        const body=typeof last?.content==="string"?last.content:
          last?.content?.length===1&&last.content[0].type==="text"?last.content[0].text:null;
        if(!grant||grant.observation.requestId!==requestId||grant.observation.status!=="preparing"||
            model.provider!==stage.modelRef.provider||model.modelId!==stage.modelRef.modelId||
            last?.role!=="user"||body!==grant.body||request.context?.tools?.length)
          throw problem("PROCESS_UNBOUND","Checker may only send its tool-free host observation");
        cause="observe:"+grant.observation.id;
      }
      const budget=task.record.budget;
      if(budget.maxCost!==null)throw problem('ROOT_BUDGET','No enforceable per-request fee upper bound; hard cost cap prevents sending');
      processCheck.assertWorkerSend(request.role);
      if(budget.maxCalls!==null&&task.record.rootRequests.filter(r=>!r.notSent).length+processCheck.reserved(taskId,request.role)>=budget.maxCalls)throw problem('ROOT_BUDGET','Root call budget exhausted or reserved for required process checking');
      task.record.rootRequests.push({requestId,taskId,sessionId,stageId,model:{provider:model.provider,modelId:model.modelId,api:model.api},cause,status:'reserved',notSent:false});task.save();
    },
    settleRequest({requestId,taskId}){
      const claim=task.record.rootRequests.find(r=>r.requestId===requestId);if(!claim)return;
      const child=children.get(taskId);if(!child||claim.taskId!==taskId)throw problem('ROOT_REQUEST','Wrong settlement owner');
      // Read the durable original request, never trust a child's claimed usage or notSent flag.
      const request=readRequest(task.home,taskId,requestId);
      Object.assign(claim,{status:request.status,notSent:request.sent===false&&!request.transport?.projectDispatched,usage:request.usage??null});task.save();
    },
    registerExecution({commandId,cancel,settled}){
      if(stopRequested||task.signal.aborted||task.record.status!=='running')throw problem('ROOT_STOPPED','Root no longer accepts execution dependencies');
      if(commandId!==task.record.projectOperation?.commandId||executions.has(commandId)||typeof cancel!=='function'||!settled?.then)throw problem('ROOT_EXECUTION','Invalid execution registration');
      task.record.projectOperation.registered=true;task.save();executions.set(commandId,{cancel,settled});
    },
    stopAndDrain({cause}={}){
      if(stopping)return stopping;
      stopRequested=true;
      stopping=(async()=>{
        const operations=[...executions.values()];for(const op of operations)op.cancel(cause);
        const results=await Promise.allSettled([...operations.map(op=>op.settled),...[...children.values()].filter(c=>c!==task).map(c=>c.cancel())]);
        if(results.some(r=>r.status==='rejected')||[...children.values()].some(c=>c!==task&&(c.record.cancelStopError||c.record.cancelRequestedAt&&!c.record.cancelSettledAt||["running","cancelling","stop_unknown"].includes(taskDisplayStatus(c.record)))))throw problem('ROOT_STOP_UNKNOWN','Owned execution stop is unconfirmed');
      })();return stopping;
    },
  };
  owners.add(owner);task.rootOwner=owner;task.save();return owner;
}
export async function freezeReadAuthorization({home,workspace,sessionId,submissionId,editorEditId,input}) {
  if(input===undefined||input===null)return null;
  if(!input||Object.keys(input).length!==1||!Array.isArray(input.paths)||!input.paths.length||input.paths.some(p=>!validProjectPath(p,true)))throw problem('READ_AUTHORIZATION','Select valid relative read paths');
  if(!workspace?.project)throw problem('READ_AUTHORIZATION','No project directory is selected');
  const canonicalRepo=realpathSync(await legacyGit(workspace.project,['rev-parse','--show-toplevel']));
  const executionScope=selectedExecutionScope(workspace.project,canonicalRepo);
  if(input.paths.some(path=>!inScope(path,[executionScope.relativePath])))
    throw problem('READ_SCOPE',`已保存版本的读取限于仓库相对目录 ${executionScope.relativePath}。`);
  const {state}=await projectChatState(home,canonicalRepo);
  let version=state?.version;
  if(!version){
    let saved;
    try {
      saved=await createVersioning({home,project:canonicalRepo,readOnly:true});
      version=(await saved.inspect()).version;
    }catch(error){if(!["NO_PROJECT","ENOENT"].includes(error.code))throw error;}
    finally{await saved?.close();}
  }
  version??=await legacyGit(canonicalRepo,['rev-parse','--verify','HEAD^{commit}']);
  return {canonicalRepo,workspaceId:workspace.id??null,sessionId,version,projectId:state?.id??null,paths:[...new Set(input.paths)],source:{kind:'user_ui',submissionId,...(editorEditId?{editorEditId}:{})},uncommitted:false};
}
export function loadPreparedContinuation({home,manager,sourceTaskId}) {
  if(!conversationTaskIds(manager).includes(sourceTaskId))
    throw problem('PROJECT_SOURCE','原工作任务不在当前对话分支。');
  const source=readTask(home,sourceTaskId);
  const intent=source.routeIntent;
  if(source.flow!=='unified'||source.sessionId!==manager.getSessionId()||source.status!=='blocked'||
     source.projectPreparationBlocked?.code!=='PROJECT_NOT_PREPARED'||intent?.kind!=='start_work'||!intent.preparationBlocked)
    throw problem('PROJECT_SOURCE','原任务不是本分支等待目录准备的工作。');
  const requests=readRequests(home,source);
  if(requests.some(r=>['preparing','in_flight','outcome_unknown'].includes(r.status)))
    throw problem('PROJECT_PENDING','原任务存在尚未核对的模型请求。');
  if(!requests.some(r=>r.id===intent.callId&&r.status==='completed'&&r.sent&&
    r.response?.content?.some(c=>c.type==='toolCall'&&c.id===intent.toolCallId&&c.name==='start_work'&&digest(c.arguments)===intent.argsDigest)))
    throw problem('PROJECT_SOURCE','无法核实原工作选择的模型回执。');
  const budget=normalizeRootBudget(source.budget);
  const spentCalls=requests.filter(r=>r.sent).length;
  const remainingBudget={...budget,maxCalls:budget.maxCalls===null?null:Math.max(0,budget.maxCalls-spentCalls)};
  return {source,materials:loadInputMaterials(home,source.materials??[]),spentCalls,remainingBudget};
}

export function bindUnifiedActions(task,{workspace,onWork,beforeWork,cwd}) {
  task.unifiedReadContext=args=>readProjectContext(task,args);
  let admission=Promise.resolve();
  const parsedPlans=new Map();
  const diagnostics=new Map();
  let checkedPlan;
  const admit=async(kind,toolCallId,args)=>{
    if(task.record.phase!=='draft'||task.record.status!=='running')throw problem('INTENT_STAGE','Only the initial main stage may choose a route');
    const old=task.record.routeIntent;
    if(old){if(old.toolCallId===toolCallId&&old.kind===kind&&old.argsDigest===digest(args))return old;throw problem('INTENT_CONFLICT','A terminal route is already saved');}
    const call=task.requests().findLast(r=>r.phase==='draft'&&r.status==='completed'&&r.response?.content?.some(c=>c.type==='toolCall'&&c.id===toolCallId&&c.name===kind&&digest(c.arguments)===digest(args)));
    if(!call)throw problem('INTENT_SOURCE','No saved physical response for this tool call');
    if(kind!=="start_work")throw problem("INTENT_ROUTE","Unsupported conversation route");
    const argsDigest=digest(args),intent={kind,toolCallId,callId:call.id,args:structuredClone(args),argsDigest};
    try {
      if(!workspace?.project)throw problem('PROJECT_REQUIRED','Select a project directory for file work');
      if(task.record.constraints.readOnly)throw problem('READ_ONLY','This turn is read-only; file execution is not authorized');
      if(!parsedPlans.has(argsDigest)){
        try{parsedPlans.set(argsDigest,{value:validateWorkIntent(task,args)});}
        catch(error){parsedPlans.set(argsDigest,{error});}
      }
      const parsed=parsedPlans.get(argsDigest);
      if(parsed.error)throw parsed.error;
      await task.readonlyLifecycle?.beforeFileRoute(call);
      let inspected;
      try { inspected=await beforeWork?.(task); }
      catch(error){
        if(error.code!=="PROJECT_NOT_PREPARED"||args.action!=="start")throw error;
        task.record.projectPreparationBlocked={code:error.code,path:error.path??workspace.project};
        task.record.routeIntent={...intent,preparationBlocked:true};
        task.save();return task.record.routeIntent;
      }
      task.signal.throwIfAborted();
      const scope=inspected&&selectedExecutionScope(workspace.project,inspected.root,inspected.relativePath);
      if(scope&&parsed.value.previous&&parsed.value.previous.proposal.canonicalRepo!==scope.root)
        throw problem("WORK_PLAN","Saved plan does not belong to this conversation");
      if(scope)checkPlanScope(parsed.value.plan,scope);
      if(inspected?.needsPreparation){
        if(args.action!=="start")throw problem("WORK_PLAN","No formal project exists to resume or revise");
        if(!task.record.frozenConfig.work?.execution)
          throw problem("PROJECT_EXECUTION_REQUIRED","Configure the offline execution environment before preparing this conversation folder");
        await beforeWork(task,{prepare:true});
        task.signal.throwIfAborted();
      }
      checkedPlan=await checkWorkProject(task,args,parsed.value,scope);
      task.signal.throwIfAborted();
      task.record.executionScope=checkedPlan.scope;
    }catch(error){
      const code=error.code??"WORK_PLAN",key=JSON.stringify([code,error.message]);
      if(diagnostics.get(argsDigest)===key)task.stopUnifiedPlanAttempts=true;
      diagnostics.set(argsDigest,key);
      task.record.workPlanError={code,message:error.message,toolCallId,callId:call.id};
      task.save();throw error;
    }
    task.record.routeIntent=intent;task.save();return intent;
  };
  const inAdmission=action=>{
    const next=admission.then(action);
    admission=next.catch(()=>{});
    return next;
  };
  task.unifiedIntent=(...args)=>inAdmission(()=>admit(...args));
  bindReadonlyRoles(task,{admission:inAdmission,cwd});
  task.unifiedWork=()=>onWork(task,task.record.routeIntent,checkedPlan);
}
export async function runProjectTurn({home,cwd,workspace={id:null,project:null},input,frozenConfig,mainRuntime,frozenConstraints,budget,taskId,submissionId,readAuthorization,confirmedOperation,onProgress,signal,turnIntent,projectDirectoryAvailable=Boolean(workspace.project),...options}) {
  assertCleanProjectProcess({unified:true});
  const constraints=normalizeConstraints(frozenConstraints),frozenBudget=normalizeRootBudget(budget);
  turnIntent??=guiTurnIntent(input,constraints);
  if(turnIntent.blocker)throw problem(turnIntent.blockerCode??(turnIntent.fileRequired&&constraints.readOnly&&turnIntent.networkMode!=="whole-turn-offline"?"TURN_CONSTRAINTS":"NETWORK_POLICY"),turnIntent.blocker);
  if(turnIntent.networkMode)constraints.networkMode=turnIntent.networkMode;
  return runTurn({home,cwd,input,config:frozenConfig,mainRuntime,allowWork:projectDirectoryAvailable,flow:'unified',constraints,budget:frozenBudget,workspace,readAuthorization,confirmedOperation,
    id:taskId??randomUUID(),submissionId,onProgress,signal,...options,
    onTaskCreated(task){task.record.contextTaskIds=options.contextTaskIds??[];task.record.turnIntent=turnIntent;createRootOwner(task,{processCheckClock:options.processCheckClock});bindUnifiedActions(task,{workspace,cwd,onWork:options.onWork??prepareWork,beforeWork:options.beforeWork});options.onTaskCreated?.(task);},
  });
}

export {rootUsage} from './task.js';
