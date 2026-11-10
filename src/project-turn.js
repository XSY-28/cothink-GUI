import {loadInputMaterials} from "./context.js";
import {guiNetworkBlocker,guiNetworkChoice,isGuiFileTask} from "./gui-turn-options.js";
import {assertCleanProjectProcess} from "./pi-runtime.js";
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,existsSync,realpathSync} from 'node:fs';
import {join,relative,sep} from 'node:path';
import {runTurn} from './discussion.js';
import {conversationTaskIds} from './conversation.js';
import {problem,readRequest,readRequests,readTask,rootUsage,taskDisplayStatus} from './task.js';
import {legacyGit} from './git-versioning.js';
import {validProjectPath,inScope,createVersioning,readProjectContext} from './versioning.js';
import {projectChatState,validateChatPlan,assertProjectReviewRequirement} from './project.js';

export const unifiedProtocol = 1;
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
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
export function createRootOwner(task) {
  if(task.record.flow!=='unified')throw problem('ROOT_OWNER','Root flow required');
  const children=new Map([[task.record.id,task]]),executions=new Map();let stopping,stopRequested=false;
  task.record.rootRequests??=[];
  const owner={rootTask:task,usage:()=>rootUsage(task.home,task.record),
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
    reserveRequest({requestId,taskId,sessionId,stageId,model,cause}){
      const child=children.get(taskId),request=child?.requests().find(r=>r.id===requestId);
      if(!child||(child.record.stages.find(s=>s.id===stageId)?.sessionId??child.record.sessionId)!==sessionId||!child.record.stages.some(s=>s.id===stageId&&s.callIds.includes(requestId))||request?.stageId!==stageId)throw problem('ROOT_REQUEST','Unregistered request identity');
      if(task.record.status!=='running'||task.signal.aborted||stopRequested)throw problem('ROOT_STOPPED','Root no longer permits sending');
      if(task.record.rootRequests.some(r=>r.requestId===requestId))throw problem('ROOT_REPLAY','Original request already reserved; query its journal');
      const budget=task.record.budget;
      if(budget.maxCost!==null)throw problem('ROOT_BUDGET','No enforceable per-request fee upper bound; hard cost cap prevents sending');
      if(budget.maxCalls!==null&&task.record.rootRequests.filter(r=>!r.notSent).length>=budget.maxCalls)throw problem('ROOT_BUDGET','Root call budget exhausted');
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
function selectedExecutionScope(selectedPath, root, reportedPath) {
  const path=realpathSync(selectedPath),canonicalRoot=realpathSync(root);
  const relativePath=relative(canonicalRoot,path).split(sep).join('/')||'.';
  if(!validProjectPath(relativePath,true)||(reportedPath!==undefined&&reportedPath!==relativePath))
    throw problem('PROJECT_SCOPE','所选目录与已核实的仓库范围不一致。');
  return {path,root:canonicalRoot,relativePath};
}
function checkPlanScope(plan, scope) {
  if(!plan||!scope||scope.relativePath==='.')return;
  const within=paths=>paths===undefined||(Array.isArray(paths)&&paths.every(path=>
    validProjectPath(path,true)&&inScope(path,[scope.relativePath])));
  const units=[plan,...(Array.isArray(plan.steps)?plan.steps:[])];
  for(const unit of units){
    const nested=[...(Array.isArray(unit?.works)?unit.works:[]),...(Array.isArray(unit?.subworks)?unit.subworks:[])];
    if([unit,...nested].some(value=>!value||!within(value.scope)||!within(value.readScope)||!within(value.deliverables)))
      throw problem('PROJECT_SCOPE',`文件工作限于仓库相对目录 ${scope.relativePath}。请提供该目录内的范围和交付路径。`);
  }
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
export function bindUnifiedActions(task,{workspace,onWork,beforeWork}) {
  task.unifiedReadContext=args=>readProjectContext(task,args);
  let admission=Promise.resolve();
  const admit=async(kind,toolCallId,args)=>{
    if(task.record.phase!=='draft'||task.record.status!=='running')throw problem('INTENT_STAGE','Only the initial main stage may choose a route');
    const old=task.record.routeIntent;
    if(old){if(old.toolCallId===toolCallId&&old.kind===kind&&old.argsDigest===digest(args))return old;throw problem('INTENT_CONFLICT','A terminal route is already saved');}
    const call=task.requests().findLast(r=>r.phase==='draft'&&r.status==='completed'&&r.response?.content?.some(c=>c.type==='toolCall'&&c.id===toolCallId&&c.name===kind&&digest(c.arguments)===digest(args)));
    if(!call)throw problem('INTENT_SOURCE','No saved physical response for this tool call');
    if(kind==='request_review'){
      if(!task.record.constraints.allowedSubtasks.includes('review')||!args.draft?.trim())throw problem('REVIEW_REQUIRED','Review is disallowed or has no draft');
    }else{
      if(!workspace?.project)throw problem('PROJECT_REQUIRED','Select a project directory for file work');
      if(task.record.constraints.readOnly)throw problem('READ_ONLY','This turn is read-only; file execution is not authorized');
      if(beforeWork){
        try {
          const inspected=await beforeWork(task);
          task.signal.throwIfAborted();
          if(!inspected||typeof inspected.root!=='string'||typeof inspected.relativePath!=='string')
            throw problem('PROJECT_SCOPE','目录准备没有返回可核验的仓库范围。');
          task.record.executionScope=selectedExecutionScope(workspace.project,inspected.root,inspected.relativePath);
        }
        catch(error){
          if(error.code!=='PROJECT_NOT_PREPARED')throw error;
          task.record.projectPreparationBlocked={code:error.code,path:error.path??workspace.project};
          const blocked={kind,toolCallId,callId:call.id,args:structuredClone(args),argsDigest:digest(args),preparationBlocked:true};
          task.record.routeIntent=blocked;task.save();return blocked;
        }
      }
      if(!['start','resume','revise'].includes(args.action)||Boolean(args.plan)===Boolean(args.planRef))throw problem('WORK_PLAN','Provide exactly one complete plan or saved plan reference');
      if(args.action==='resume'&&!args.planRef)throw problem('WORK_PLAN','Resume requires the saved proposal reference');
      if(args.plan){
        if(Object.hasOwn(args.plan,'repo'))throw problem('WORK_PLAN','Model plans cannot choose a repository');
        checkPlanScope(args.plan,task.record.executionScope);
        validateChatPlan(args.plan);
      }
      if(task.record.constraints.requireDifferentModelReview&&!task.record.constraints.allowedSubtasks.includes('review'))throw problem('REVIEW_REQUIRED','Required independent review conflicts with forbidden review delegation');
    }
    const intent={kind,toolCallId,callId:call.id,args:structuredClone(args),argsDigest:digest(args)};
    task.record.routeIntent=intent;task.save();return intent;
  };
  task.unifiedIntent=(...args)=>{
    const next=admission.then(()=>admit(...args));
    admission=next.catch(()=>{});
    return next;
  };
  task.unifiedWork=()=>onWork(task,task.record.routeIntent);
}
export async function runProjectTurn({home,cwd,workspace={id:null,project:null},input,frozenConfig,mainRuntime,frozenConstraints,budget,taskId,submissionId,readAuthorization,confirmedOperation,onProgress,signal,...options}) {
  assertCleanProjectProcess({unified:true});
  const constraints=normalizeConstraints(frozenConstraints),frozenBudget=normalizeRootBudget(budget);
  if (!constraints.networkMode && isGuiFileTask(input,constraints) &&
      ["choose","artifact-offline"].includes(guiNetworkChoice(input,constraints))) constraints.networkMode="artifact-offline";
  return runTurn({home,cwd,input,config:frozenConfig,mainRuntime,allowWork:Boolean(workspace.project),flow:'unified',constraints,budget:frozenBudget,workspace,readAuthorization,confirmedOperation,
    id:taskId??randomUUID(),submissionId,onProgress,signal,...options,
    onTaskCreated(task){task.record.contextTaskIds=options.contextTaskIds??[];createRootOwner(task);bindUnifiedActions(task,{workspace,onWork:options.onWork??prepareWork,beforeWork:options.beforeWork});options.onTaskCreated?.(task);},
  });
}
async function prepareWork(task,intent) {
  // Formal execution and confirmation are connected below; proposal is immutable after saving.
  const admittedScope=task.record.executionScope;
  const {state,repo}=await projectChatState(task.home,admittedScope?.root??task.record.workspace.project);
  if(admittedScope&&repo!==admittedScope.root)throw problem('PROJECT_SCOPE','目录的实际仓库已改变，请重新选择。');
  const scope=selectedExecutionScope(task.record.workspace.project,repo,admittedScope?.relativePath);
  if(state)checkPlanScope({...state,readScope:state.readScope??['.']},scope);
  const args=intent.args;
  // Keep the actual earlier operation inputs even when their surrounding history
  // has been compacted. Do not re-expand the earlier snapshots' material arrays.
  const inherited=new Map();
  const attachmentRefs=new Map((task.record.handoffContext.attachmentRefs??[]).map(ref=>[ref.id,ref]));
  for(const attempt of state?.steps.flatMap(step=>step.attempts)??[]){
    if(!attempt.rootTaskId||!attempt.contextRef)continue;
    const context=resolveHandoffContext(task.home,attempt.rootTaskId,attempt.contextRef,{commandId:attempt.commandId});
    for(const ref of context.attachmentRefs??[])if(!attachmentRefs.has(ref.id))attachmentRefs.set(ref.id,ref);
    for(const item of [...(context.inheritedInputs??[]),{input:context.input,sourceTaskId:context.sourceTaskId,sessionId:context.sessionId,rootTaskId:attempt.rootTaskId,commandId:attempt.commandId,contextRef:attempt.contextRef,source:'Earlier confirmed operation user input; preserve constraints, current confirmed plan defines execution authority'}])inherited.set(item.sourceTaskId,item);
  }
  task.record.handoffContext.inheritedInputs=[...inherited.values()];
  if(attachmentRefs.size)task.record.handoffContext.attachmentRefs=[...attachmentRefs.values()];
  let plan=args.plan,authorityRoot;
  if(args.planRef){
    const ref=args.planRef;
    if(ref.field!=='proposal'||typeof ref.taskId!=='string')throw problem('WORK_PLAN','Expected saved proposal reference');
    const previous=readTask(task.home,ref.taskId);
    if(!task.record.contextTaskIds?.includes(previous.id)||previous.workspace?.id!==task.record.workspace.id||digest(previous.proposal)!==ref.sha256||previous.proposal?.canonicalRepo!==repo)throw problem('WORK_PLAN','Saved plan does not belong to this conversation');
    plan=previous.proposal.plan;
    authorityRoot=previous.executionBinding?previous:previous.confirmationIntent?.consumedByTaskId?readTask(task.home,previous.confirmationIntent.consumedByTaskId):null;
  }
  if(args.action==='start'&&state)throw problem('WORK_PLAN','Project already exists; use its saved resume/revise intent');
  if(args.action!=='start'&&!state)throw problem('WORK_PLAN','No formal project exists to resume or revise');
  if(args.action==='resume' && (!authorityRoot || authorityRoot.projectOperation?.revision!==state.revision))throw problem('WORK_PLAN','Saved resume authority does not describe the current project revision');
  if(args.action==='resume')assertProjectReviewRequirement(state,task.record.constraints);
  if(task.record.constraints.requireDifferentModelReview)plan={...plan,independentReview:true};
  if(args.action==='revise'){
    plan={...plan,readScope:plan.readScope??plan.scope};
    const {validateProjectRevision}=await import('./project.js');validateProjectRevision(state,plan);
  }
  plan={...plan,readScope:plan.readScope??plan.scope};
  if(!Array.isArray(plan.readScope)||!plan.readScope.length||plan.readScope.some(path=>!validProjectPath(path,true)))throw problem("WORK_PLAN","Invalid explicit plan read scope");
  checkPlanScope(plan,scope);
  const needsReview=plan.independentReview||(plan.steps??[plan]).some(step=>step.independentReview||step.works?.some(work=>work.independentReview));
  if(needsReview&&!task.record.constraints.allowedSubtasks.includes("review"))throw problem("REVIEW_REQUIRED","Plan review requirement conflicts with forbidden review delegation");
  validateChatPlan(plan);
  task.record.proposal={action:args.action,plan,constraints:task.record.constraints,canonicalRepo:repo,...(scope?{executionScope:scope}:{}),version:state?.version??await legacyGit(repo,['rev-parse','--verify','HEAD^{commit}']),projectId:state?.id??null,expectedRevision:state?.revision??null,toolCallId:intent.toolCallId,workspaceId:task.record.workspace.id??null,sessionId:task.record.sessionId,budget:task.record.budget,contextDigest:digest(task.record.handoffContext),packageDigest:digest(task.record.packageSnapshot),budgetAtProposal:{spentCalls:task.record.rootRequests.filter(r=>!r.notSent).length,remainingCalls:task.record.budget.maxCalls===null?null:Math.max(0,task.record.budget.maxCalls-task.record.rootRequests.filter(r=>!r.notSent).length)},source:{taskId:task.record.id,callId:intent.callId}};
  if(args.action==="resume"&&completedDelivery(state))task.record.proposal.reuseCompletedDelivery=true;
  task.record.proposalRef={sourceTaskId:task.record.id,toolCallId:intent.toolCallId,planDigest:digest(task.record.proposal),workspace:task.record.workspace.id??null,revision:state?.revision??null};
  if(args.action==='resume' && state.status!=='paused' && !authorityRoot?.cancelRequestedAt && authorityRoot?.sessionId===task.record.sessionId && authorityRoot.executionBinding?.projectId===state.id && authorityRoot.executionBinding.canonicalRepo===repo && state.entryPolicy==='unified' && !workConfirmationBlocker(task.record)){
    const authorizationSource={kind:'existing_project',taskId:authorityRoot.id,projectId:state.id,revision:state.revision};
    const reservation={commandId:randomUUID(),proposalRef:task.record.proposalRef,budgetSource:{sourceTaskId:task.record.id,consumed:task.record.proposal.budgetAtProposal.spentCalls,remaining:task.record.budget},authorizationSource};
    delete task.record.proposalRef;task.save();return executeConfirmed(task,task.record,reservation);
  }
  task.save();task.finish('blocked','具体工作提议已保存，请核对计划后确认执行。');return task;
}

function completedDelivery(state) {
  return state?.status==="completed"&&!!state.delivery&&
    state.delivery.version===state.version&&state.delivery.revision===state.revision;
}

export function assertConfirmedProjectState(proposal,{repo,version,state,expectedRevision}) {
  if(proposal.canonicalRepo!==repo||proposal.version!==version||(state?.revision??null)!==(expectedRevision??null))
    throw problem("PROPOSAL_STALE","Confirmed project version/revision changed before dispatch");
  if(proposal.reuseCompletedDelivery&&!completedDelivery(state))
    throw problem("PROPOSAL_STALE","已交付状态已变化，无法只沿用已有成果。请重新核对。");
}

export function workConfirmationBlocker(source) {
  const {proposal,frozenConfig}=source;
  if(!proposal)return null;
  const network=guiNetworkBlocker(source.input??"",proposal.constraints);
  if(network)return network;
  if(proposal.reuseCompletedDelivery)return null;
  if(proposal.budgetAtProposal?.remainingCalls===0)
    return "本轮模型请求额度已用完，请调整额度后重新发起计划。";
  if(frozenConfig&&!frozenConfig.work?.execution)
    return "提议生成时未配置项目执行环境。请完成设置后重新发起计划。";
  return null;
}

export function checkedProposal(home,source,ref,{sessionId,workspaceId}) {
  if(!source.handoffContext||source.proposal?.contextDigest!==digest(source.handoffContext))throw problem('PROPOSAL_SOURCE','Frozen handoff context changed');
  if(source.proposal?.packageDigest!==digest(source.packageSnapshot))throw problem('PROPOSAL_SOURCE','Frozen package provenance changed');
  if(source.flow!=='unified'||source.sessionId!==sessionId||source.workspace?.id!==workspaceId||!source.proposal||digest(source.proposal)!==ref.planDigest||digest(source.proposalRef)!==digest(ref)||ref.sourceTaskId!==source.id)throw problem('PROPOSAL_SOURCE','Proposal identity, branch or immutable bytes changed');
  if(['running','outcome_unknown'].includes(source.status)||source.cancelRequestedAt&&!source.cancelSettledAt)throw problem('PROPOSAL_PENDING','Source root is not settled');
  for(const claim of source.rootRequests??[]){const r=readRequest(home,claim.taskId,claim.requestId);if(r.status==='outcome_unknown'||r.sent&&r.usage==null&&source.budget.maxCost!==null)throw problem('PROPOSAL_PENDING','Source request outcome or required cost is unknown');}
  return source.proposal;
}
export async function reserveConfirmation({home,source,proposalRef,sessionId,workspaceId,submissionId,save}) {
  const proposal=checkedProposal(home,source,proposalRef,{sessionId,workspaceId});
  if(source.confirmationIntent)return source.confirmationIntent;
  const blocker=workConfirmationBlocker(source);
  if(blocker)throw problem('PROPOSAL_BLOCKED',blocker);
  const {repo,state}=await projectChatState(home,proposal.canonicalRepo);
  if(proposal.executionScope){
    selectedExecutionScope(proposal.executionScope.path,repo,proposal.executionScope.relativePath);
    checkPlanScope(proposal.plan,proposal.executionScope);
    if(state)checkPlanScope({...state,readScope:state.readScope??['.']},proposal.executionScope);
  }
  const currentVersion=state?.version??await legacyGit(repo,['rev-parse','--verify','HEAD^{commit}']);
  assertConfirmedProjectState(proposal,{repo,version:currentVersion,state,expectedRevision:proposal.expectedRevision});
  const consumed=(source.rootRequests??[]).filter(r=>!r.notSent).length;
  const remaining={...source.budget,maxCalls:source.budget.maxCalls===null?null:Math.max(0,source.budget.maxCalls-consumed)};
  if(remaining.maxCalls===0&&!proposal.reuseCompletedDelivery)throw problem('PROPOSAL_BLOCKED','本轮模型请求额度已用完，请调整额度后重新发起计划。');
  const reservation={taskId:randomUUID(),commandId:randomUUID(),submissionId,proposalRef:structuredClone(proposalRef),budgetSource:{sourceTaskId:source.id,consumed,budget:source.budget,remaining},status:'reserved'};
  source.confirmationIntent=reservation;save();return reservation;
}
export async function confirmationState({home,source,reservation}) {
  const {queryProjectOperation}=await import('./project.js');
  const taskFile=join(home,'tasks',reservation.taskId+'.json');
  const op=await queryProjectOperation({home,cwd:source.proposal.canonicalRepo,commandId:reservation.commandId});
  if(existsSync(taskFile)){
    const task=readTask(home,reservation.taskId);
    if(task.sessionId!==source.sessionId||task.submissionId!==reservation.submissionId||task.confirmationSource?.sourceTaskId!==source.id||task.confirmationSource?.planDigest!==reservation.proposalRef.planDigest)throw problem('CONFIRMATION_ID','Reserved root does not match its original proposal');
    return {task,mayCreate:false};
  }
  if(op.exists||op.state?.steps.some(s=>s.attempts.some(a=>a.rootTaskId===reservation.taskId))||op.state?.callIntents?.some(c=>c.rootTaskId===reservation.taskId))throw problem('CONFIRMATION_UNKNOWN','Command or child evidence exists without its reserved root; no replay');
  return {task:null,mayCreate:true};
}
export async function executeConfirmed(task,source,reservation) {
  task.signal.throwIfAborted();
  if(task.record.status!=='running')throw problem('ROOT_STOPPED','Root ended before confirmed execution');
  const {runProjectOperation}=await import('./project.js');
  task.signal.throwIfAborted();
  if(task.record.status!=='running')throw problem('ROOT_STOPPED','Root ended during confirmed execution admission');
  const p=source.proposal;
  if(p.executionScope){
    selectedExecutionScope(p.executionScope.path,p.canonicalRepo,p.executionScope.relativePath);
    checkPlanScope(p.plan,p.executionScope);
  }
  if(reservation.authorizationSource)task.record.operationAuthorization=reservation.authorizationSource;
  else task.record.confirmationSource=reservation.proposalRef;
  task.record.budgetSource=reservation.budgetSource;
  task.record.phase='project';
  if(!source.handoffContext||p.contextDigest!==digest(source.handoffContext)||source.handoffContext?.input!==source.input||source.handoffContext?.sourceTaskId!==source.id||source.handoffContext?.sessionId!==source.sessionId)throw problem('CONTEXT_SOURCE','Frozen proposal context changed or is missing');
  loadInputMaterials(task.home,source.handoffContext.attachmentRefs??[]);
  task.record.handoffContext=structuredClone(source.handoffContext);
  task.record.proposal=structuredClone(p);
  task.record.projectOperation={action:p.action,commandId:reservation.commandId,projectId:p.projectId,expectedRevision:p.expectedRevision,
    planRef:{taskId:task.record.id,field:'proposal',sha256:digest(p)},planDigest:digest(p),
    frozenConfigRef:{taskId:task.record.id,field:'frozenConfig',sha256:digest(task.record.frozenConfig)},
    contextRef:{taskId:task.record.id,field:'handoffContext',sha256:digest(task.record.handoffContext)},status:'intent',childTaskIds:[]};
  task.save();
  const control=new AbortController();let resolveSettled;
  const settled=new Promise(resolve=>{resolveSettled=resolve;});
  task.rootOwner.registerExecution({commandId:reservation.commandId,cancel:()=>control.abort(),settled});
  try {
    const result=await runProjectOperation({home:task.home,cwd:p.canonicalRepo,action:p.action,commandId:reservation.commandId,rootTaskId:task.record.id,expectedRevision:p.expectedRevision??undefined,providedPlan:p.action==='resume'?undefined:p.plan,
      frozenConfig:task.record.frozenConfig,contextRef:task.record.projectOperation.contextRef,rootOwner:task.rootOwner,signal:AbortSignal.any([task.signal,control.signal])});
    task.record.executionBinding=result.executionBinding;
    task.record.projectOperation.projectId=result.state.id;
    task.record.projectOperation.status=result.state.status;
    task.record.projectOperation.revision=result.state.revision;
    if(result.state.delivery){
      const sources=result.state.steps.filter(s=>s.status==='completed').map(step=>{
        const a=step.attempts.at(-1),child=readTask(task.home,a.taskId);
        return {taskId:a.taskId,callId:child.finalCallId,relation:a.rootTaskId===task.record.id?'owned':'inherited'};
      });
      task.record.deliveryRef={projectId:result.state.id,commandId:reservation.commandId,revision:result.state.revision,sources,version:result.state.delivery.version,
        checksRef:result.state.delivery.requestIds.map(requestId=>({projectId:result.state.id,revision:result.state.revision,requestId,version:result.state.delivery.version}))};
      resolveDelivery(task.home,task.record);
      if (task.record.workspace.managedDirectory) {
        task.save();
        try {
          const {placeConversationDelivery}=await import("./gui-work.js");
          await placeConversationDelivery(task.home,task.record.workspace,result.state.delivery.version);
        } catch (error) {
          task.finish("partial","成果已保存，但未能放入对话文件夹："+error.message);
          return task;
        }
      }
    }
    task.save();
    if(task.signal.aborted){return task;}
    task.finish(result.state.status==='completed'?'completed':result.state.steps.some(step=>step.status==='unknown')?'outcome_unknown':result.state.status==='paused'?'blocked':'partial',result.state.error??null);return task;
  }finally{resolveSettled();}
}
export function resolveDelivery(home,record) {
  const ref=record.deliveryRef;if(!ref)return [];
  const state=JSON.parse(readFileSync(join(home,'project-delivery',ref.projectId,'state.json'),'utf8'));
  const command=state.commands?.[ref.commandId],delivery=state.deliveries?.[ref.revision]??state.delivery;
  if(record.flow!=='unified'||state.id!==ref.projectId||state.repo!==record.executionBinding?.canonicalRepo||record.projectOperation?.commandId!==ref.commandId||command?.rootTaskId!==record.id||delivery?.version!==ref.version||delivery?.revision!==ref.revision)throw problem('DELIVERY_SOURCE','Saved delivery identity, revision or version does not match');
  const checkIds=delivery.requestIds;
  if(!checkIds?.length||digest(ref.checksRef)!==digest(checkIds.map(requestId=>({projectId:state.id,revision:ref.revision,requestId,version:ref.version}))))throw problem('DELIVERY_CHECK','Delivery checks reference changed');
  for(const id of checkIds){const fact=state.finalChecks?.find(c=>c.requestId===id)?.check??state.steps.flatMap(s=>s.attempts.map(a=>a.check)).find(c=>c?.requestId===id);if(fact?.version!==ref.version||fact.verification!=='passed')throw problem('DELIVERY_CHECK','Missing passed checks at delivered version');}
  return ref.sources.map(source=>{
    const step=state.steps.find(s=>s.attempts.some(a=>a.taskId===source.taskId&&a.status==='completed')),a=step?.attempts.find(a=>a.taskId===source.taskId),child=readTask(home,source.taskId);
    if(!delivery.taskIds?.includes(source.taskId))throw problem('DELIVERY_SOURCE','Source was not part of this saved delivery');
    if(!a||child.project?.id!==state.id||child.project?.stepId!==step.id||child.rootTaskId!==a.rootTaskId||child.finalCallId!==source.callId||child.status!=='completed')throw problem('DELIVERY_SOURCE','Child result lacks completed project provenance');
    if(source.relation==='owned'?(a.rootTaskId!==record.id||a.commandId!==ref.commandId||!record.projectOperation.childTaskIds.includes(a.taskId)):(source.relation!=='inherited'||a.rootTaskId===record.id))throw problem('DELIVERY_SOURCE','Wrong owned/inherited relation');
    const call=readRequest(home,child.id,source.callId);if(call.status!=='completed')throw problem('DELIVERY_SOURCE','Final physical request is not complete');
    return {record:child,call,stepId:step.id,relation:source.relation};
  });
}

export {rootUsage} from './task.js';

export function resolveOwnedTasks(home,record) {
  const operation=record.projectOperation;if(!operation?.childTaskIds?.length)return [];
  const state=JSON.parse(readFileSync(join(home,'project-delivery',operation.projectId,'state.json'),'utf8'));
  if(state.commands?.[operation.commandId]?.rootTaskId!==record.id||state.repo!==record.proposal?.canonicalRepo)throw problem('ROOT_CHILD','Unverified project operation owner');
  return operation.childTaskIds.map(id=>{
    const child=readTask(home,id),attempt=state.steps.flatMap(s=>s.attempts).find(a=>a.taskId===id);
    if(!attempt||attempt.rootTaskId!==record.id||attempt.commandId!==operation.commandId||child.rootTaskId!==record.id||child.project?.commandId!==operation.commandId||child.project?.id!==state.id)throw problem('ROOT_CHILD','Unverified owned execution');
    return child;
  });
}

/** SavedRef is host data, never a path; verify persisted ownership before consuming bytes. */
export function resolveHandoffContext(home,rootTaskId,contextRef,{commandId}={}) {
  const root=readTask(home,rootTaskId),op=root.projectOperation;
  if(!contextRef||Object.keys(contextRef).sort().join(',')!=='field,sha256,taskId'||contextRef.taskId!==rootTaskId||contextRef.field!=='handoffContext'||root.flow!=='unified'||!root.handoffContext||!op||op.commandId!==commandId||digest(op.contextRef)!==digest(contextRef)||digest(root.handoffContext)!==contextRef.sha256||root.proposal?.contextDigest!==contextRef.sha256||root.proposal?.workspaceId!==root.workspace?.id||root.proposal?.sessionId!==root.handoffContext?.sessionId)throw problem('CONTEXT_SOURCE','Saved handoff reference or operation owner changed');
  const value=root.handoffContext,source=readTask(home,value.sourceTaskId);
  if(!source.handoffContext||value.sessionId!==source.sessionId||value.input!==source.input||digest(source.handoffContext)!==contextRef.sha256||source.workspace?.id!==root.workspace?.id||source.proposal?.canonicalRepo!==root.proposal?.canonicalRepo||source.proposal?.contextDigest!==contextRef.sha256)throw problem('CONTEXT_SOURCE','Saved handoff source provenance changed');
  return structuredClone(value);
}
