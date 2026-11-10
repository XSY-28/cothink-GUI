import {contextToolNames,contextDigest,contextSnapshot,contextState,readContextDisk,compactContext,contextOperationView} from './context-management.js';
import {validateEditorTurnOptions,editorTurnInput,isGuiFileTask} from "./gui-turn-options.js";
import {resolveBuiltinSkills,validateBuiltinSkills,builtinSkillNames,capabilitySnapshot} from './builtin-skills.js';
import {freezeAnswerSkills} from './context.js';
import {createGuiMaterialStore,GUI_MATERIAL_CAPABILITIES,listGuiProjectMaterials,readGuiProjectMaterial} from './gui-materials.js';
import {taskSkillDirectory} from './skill-resources.js';
import {resolvePackageResources} from './packages.js';
import {
  createGuiWorkspace, importGuiWorkspaceProjects, isWorkspaceId, isWorkspaceProject,
  readGuiWorkspaces, updateGuiWorkspace, rebindGuiWorkspace, queryGuiWorkspaceRebind, workspaceError, workspaceForProject, workspaceForSession,
} from "./gui-workspace-state.js";
import {persistNewGuiSession, assertNewGuiSessionId} from "./gui-session-persistence.js";
import {guiFiles, guiFile, guiFileDiff} from "./gui-files.js";
import {readSessionUiState, writeSessionUiState, writeSessionViewState, initializeSessionView, readHomeDraft, writeHomeDraft, sessionStateError} from "./session-ui-state.js";
import {createUpdateService, formatUpdateStatus, updateInstructions} from "./updates.js";
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync } from "node:fs";
import { join, basename, dirname, relative, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { prepareGuiProject } from "./gui-project-preparation.js";
import { randomUUID, createHash } from "node:crypto";
import { SessionManager, CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { readSessionTeam, resolveTeamConfig } from "./teams.js";
import {
  createModelRuntime,
  createRuntime,
  assertCleanProjectProcess,
  selectedResources,
  secretValues,
} from "./pi-runtime.js";
import {runProjectTurn,unifiedProtocol,normalizeConstraints,normalizeRootBudget,loadPreparedContinuation,freezeReadAuthorization,reserveConfirmation,confirmationState,executeConfirmed,resolveDelivery,rootUsage,assertRootOwner,createRootOwner} from "./project-turn.js";
import { cothinkExtension } from "./extensions/cothink.js";
import { createTask,readTask, readRequests, taskDisplayStatus } from "./task.js";
import {
  acquireSessionWriter,
  sessionWriterBusy,
  privateDirectory,
  redact,
  releaseNotesSeen,
  markReleaseNotesSeen,
  writePrivateJson,
} from "./storage.js";
import { validateModelThinking } from "./thinking.js";
import { singleLineCommand, validateModelRefs } from "./setup.js";
import { releaseNotes } from "./presentation.js";
import {
  appendConversationEntry,
  readSessionMode,
  readSessionFlow,
  normalizeConversationEditor,
  readSessionProject,
  readSessionWorkspace,
  conversationCwd,
  neutralDirectory,
  readConversationMetadata,
  saveSessionMode,
  saveSessionTeam,
  selectConversationTeam,
  resolveConversationConfig,
  rememberRecentTeam,
  conversationTaskIds,
  conversationMaterialRefs,
} from "./conversation.js";
import { publicTeam, projectGuiTask, finalGuiText, guiResultRevision } from "./gui-projection.js";
import {
  saveGuiTeam,
  removeGuiTeam,
  saveGuiWork,
  saveGuiProvider,
  validateGuiThinking,
  saveGuiBuiltinSkills,
  createGuiOAuthManager,saveGuiLocalSkills,guiExecutionConfigDigest,inspectGuiExecution,
} from "./gui-settings.js";
import {
  inspectGuiProject,
  inspectGuiDirectory,
  savedDirectoryAvailable, fileWorkStatus, requireFileWork,
  guiDiff,
  guiOutput,
  guiArtifact,
  revealGuiTask,
} from "./gui-work.js";

/** Local host adapter. Pi sessions and task records remain the sources of conversation and execution facts. */
export async function createGuiController({ home, cwd = process.cwd(), suggestedProject = cwd, installation = "browser", updateService, oauthRuntime, executionInspector=inspectGuiExecution }) {
  assertCleanProjectProcess({unified:true});
  const directory = join(home, "pi/sessions/main");
  privateDirectory(directory);
  const holders = new Map(),
    listeners = new Set(),
    live = new Map();
  let active = null,
    closed = false,
    shuttingDown = false, drainPromise, shutdownError = null,
    management = false, executionInspection=null, pendingProbeCleanup=null;
  // Serialize only selection acceptance and metadata writes, never task execution.
  let selectionWrite = Promise.resolve();
  function writeSelection(operation) {
    const result = selectionWrite.then(operation);
    selectionWrite = result.catch(() => {});
    return result;
  }
  const safe = (value) => redact(value, secretValues(home));
  const emit = () => {
    for (const listener of listeners)
      try {
        listener({ type: "invalidate" });
      } catch {
        /* A page cannot stop task execution. */
      }
  };
  const materials=createGuiMaterialStore(home), uploads=new Set();
  const refreshedOAuth=new Set();
  let authRefresh=Promise.resolve(),authRefreshError=null;
  const oauth=createGuiOAuthManager(home,{onChange:()=>{
    for(const entry of oauth.snapshot()){
      if(!entry.saved||refreshedOAuth.has(entry.operationId))continue;
      refreshedOAuth.add(entry.operationId);
      authRefresh=authRefresh.then(async()=>{
        try{
          await refreshLoadedCatalogs();
          authRefreshError=null;
        }catch(error){authRefreshError=error;}
      });
    }
    emit();
  },...(oauthRuntime?{createRuntime:oauthRuntime}:{})});
  const oauthBusy=()=>oauth.snapshot().some(entry=>["running","cancelling"].includes(entry.status));
  async function refreshLoadedCatalogs(){
    const catalogs=new Set([...holders.values()].map(holder=>holder.runtime?.modelRuntime).filter(Boolean));
    for(const catalog of catalogs){
      const refreshed=await catalog.refresh({allowNetwork:false});
      if(refreshed?.aborted||refreshed?.errors?.size)
        throw Error("认证已保存，但已打开会话的模型目录尚未同步。请重新打开宿主后继续。");
    }
  }
  const materialError=(code,message)=>Object.assign(Error(message),{code});
  const keyOf=ref=>`${ref.id}:${ref.sha256}`;
  const matchRef=(left,right)=>left.id===right.id&&(right.sha256===undefined||left.sha256===right.sha256);
  function materialSources(manager){
    const inherited=conversationMaterialRefs(manager);
    const origin=manager.getBranch().find(e=>e.type==="custom"&&e.customType==="cothink-home-origin")?.data?.draftId;
    for(const entry of manager.getBranch()){
      if(entry.type==="custom"&&entry.customType==="cothink-draft"&&origin&&entry.data?.homeDraftId===origin)
        for(const ref of normalizeConversationEditor(entry.data).materials)inherited.push({...ref,ownerId:origin});
    }
    return inherited;
  }
  function materialOnBranch(receipt,manager){
    return !manager||!receipt?.branchAnchor||manager.getBranch().some(e=>e.id===receipt.branchAnchor);
  }
  function resolveEditorMaterials(ownerId, refs, manager){
    const source=new Map((manager?materialSources(manager):[]).map(ref=>[keyOf(ref),ref.ownerId]));
    const resolved=materials.resolve({ownerId,materials:refs,ownerFor:ref=>source.get(keyOf(ref))??ownerId});
    if(resolved.some(({manifest})=>!source.has(keyOf(manifest))&&!materialOnBranch(manifest,manager)))
      throw materialError("MATERIAL_NOT_FOUND","材料上传不属于当前分支。");
    return resolved;
  }
  function materialView(ownerId,editor,manager){
    let list=[],error;
    try {list=materials.list({ownerId});}catch(e){error=e.message;}
    const selected=(editor.materials??[]).map(ref=>{
      try{return resolveEditorMaterials(ownerId,[ref],manager)[0].manifest;}
      catch(e){return {...ref,name:"材料不可用",status:"failed",error:e.message};}
    });
    const ids=new Set(selected.map(item=>item.id));
    const outstanding=list.filter(item=>materialOnBranch(item,manager)&&!ids.has(item.id)&&
      (item.status==="pending"||item.status==="ready"&&!item.acknowledged));
    return {materials:selected,materialUploads:outstanding.map(item=>item.status==="ready"?
      {...item,status:"unknown",error:"原上传已有字节，可查询原标识并恢复。"}:item),materialError:error};
  }
  async function materialOwner(ownerId,{writable=false}={}){
    if(!isWorkspaceId(ownerId))throw materialError("MATERIAL_ID","材料归属无效。");
    let draft;try{draft=readHomeDraft(home);}catch{}
    if(draft?.draftId===ownerId)return {draft,editor:normalizeConversationEditor(draft.editor)};
    let manager;
    try {manager=await reader(ownerId);}
    catch {throw materialError("MATERIAL_NOT_FOUND","材料归属不存在。");}
    if(writable){
      assertSessionUnarchived(ownerId);
      await assertWorkspaceWritable(manager);
      if(active?.origin==="context.organize"&&active.sessionId===ownerId)
        throw materialError("CONTEXT_BUSY","该对话正在整理，请稍后添加材料。");
    }
    return {manager,editor:readConversationMetadata(manager).editor};
  }
  async function materialQuery({ownerId,uploadId}){
    const {manager}=await materialOwner(ownerId);
    if(!uploadId)return materials.list({ownerId}).filter(item=>materialOnBranch(item,manager));
    const item=materials.query({ownerId,uploadId});
    return materialOnBranch(item,manager)?item:null;
  }
  async function materialRead({ownerId,id,sha256,taskId}){
    const {manager,editor}=await materialOwner(ownerId);
    let refs=editor.materials;
    if(taskId){
      if(!manager||!conversationTaskIds(manager).includes(taskId))
        throw materialError("MATERIAL_NOT_FOUND","材料来源不在当前分支。");
      const task=rawTask(taskId).record;
      refs=task.materials??[];
    }
    const ref=refs.find(item=>matchRef(item,{id,sha256}));
    if(!ref)throw materialError("MATERIAL_NOT_FOUND","当前草稿或历史消息没有这份材料。");
    return resolveEditorMaterials(ownerId,[ref],manager)[0];
  }
  async function materialUpload({ownerId,uploadId,body,signal,stop}){
    if(shuttingDown)throw materialError("HOST_SHUTTING_DOWN","宿主正在退出。");
    const abort=new AbortController(),request={abort,promise:null};
    if(stop)abort.signal.addEventListener("abort",stop,{once:true});
    uploads.add(request);
    request.promise=(async()=>{
      const {manager}=await materialOwner(ownerId,{writable:true});
      if(!materialOnBranch(materials.query({ownerId,uploadId}),manager))
        throw materialError("MATERIAL_NOT_FOUND","上传不属于当前分支。");
      return materials.publish({ownerId,uploadId,body,signal:signal?AbortSignal.any([signal,abort.signal]):abort.signal});
    })();
    try{return await request.promise;}
    finally{if(stop)abort.signal.removeEventListener("abort",stop);uploads.delete(request);emit();}
  }
  async function projectMaterialSource({ownerId,source,version}){
    const {manager}=await materialOwner(ownerId);
    const path=manager&&readSessionProject(manager);
    if(!path)throw materialError("MATERIAL_NOT_FOUND","此对话没有绑定项目目录。");
    const facts=inspectGuiDirectory(path);
    if(!savedDirectoryAvailable(path,facts))throw materialError("MATERIAL_SOURCE","所选目录不可读取或已经改变。");
    const identity=directoryIdentity(path);
    if(!identity)throw materialError("MATERIAL_SOURCE","所选目录已不可用。");
    if(source==="current")return {root:facts.canonicalPath,path,identity,source,scope:".",version:null};
    if(source!=="saved")throw materialError("MATERIAL_SOURCE","请选择当前文件副本或已保存版本。");
    const saved=await inspectGuiProject(home,path,loadConfig(home)?.work,{includeChanges:false});
    if(!saved.executionReady||!saved.version)throw materialError("MATERIAL_SOURCE","此目录没有可核验的已保存版本。");
    const grant=await freezeReadAuthorization({home,workspace:{project:path},sessionId:ownerId,input:{paths:[saved.relativePath]}});
    if(grant.canonicalRepo!==saved.root)throw materialError("MATERIAL_SOURCE","项目仓库在选择时发生改变。");
    if(version!==undefined&&grant.version!==version)throw materialError("READ_VERSION","已保存版本改变，请重新浏览并选择。");
    return {root:grant.canonicalRepo,path,identity,source,scope:saved.relativePath,version:grant.version};
  }
  async function listProjectMaterials(args){
    return listGuiProjectMaterials(await projectMaterialSource(args),args);
  }
  async function readProjectMaterial(args,source){
    return readGuiProjectMaterial(source??await projectMaterialSource(args),args.path);
  }
  async function importProjectMaterials(args){
    if(args.source!=="current"||!Array.isArray(args.paths)||!args.paths.length||args.paths.length>GUI_MATERIAL_CAPABILITIES.maxCount)
      throw materialError("MATERIAL_LIMIT","请选择不超过单条上限的当前文件副本。");
    const {manager}=await materialOwner(args.ownerId,{writable:true});
    const source=await projectMaterialSource(args);
    const verified=await Promise.all(args.paths.map(async row=>{
      const result=await readProjectMaterial({...args,path:row.path},source);
      if(row.sha256!==result.sha256||row.sourceToken!==result.sourceToken)
        throw materialError("MATERIAL_CONFLICT","文件或目录在预览后已变化，请重新预览。");
      return {...result,name:basename(row.path),uploadId:row.uploadId};
    }));
    if(verified.reduce((sum,row)=>sum+row.bytes.length,0)>GUI_MATERIAL_CAPABILITIES.totalBytes)
      throw materialError("MATERIAL_LIMIT","选择超出材料总字节上限。");
    const ready=[];
    for(const row of verified){
      const intent={ownerId:args.ownerId,uploadId:row.uploadId,name:row.name,mediaType:row.mediaType,byteLength:row.bytes.length,sha256:row.sha256,branchAnchor:manager.getLeafId()};
      materials.begin(intent);
      ready.push(await materialUpload({ownerId:args.ownerId,uploadId:row.uploadId,body:row.bytes}));
    }
    return ready;
  }
  const extensionPrompts=new Map(),extensionNotifications=[],extensionStatuses=new Map();
  let extensionCommand;
  const uiError=method=>Object.assign(new Error(`EXTENSION_UI_UNSUPPORTED: ${method} requires the cothink terminal entry; native terminal components have no GUI mapping.`),{code:"EXTENSION_UI_UNSUPPORTED"});
  function cancelExtensionPrompts(sessionId) {for(const prompt of extensionPrompts.values())if(!sessionId||prompt.sessionId===sessionId)prompt.finish(undefined,true);}
  function extensionUI(sessionId) {
    const request=(kind,title,detail,opts={})=>new Promise((resolve,reject)=>{
      if(closed)return reject(Error("宿主已关闭。"));
      if(typeof title!=="string" || (kind==="select"&&(!Array.isArray(detail)||detail.some(v=>typeof v!=="string"))))return reject(Error("插件提示参数无效。"));
      const id=randomUUID(),signal=opts.signal??(active?.sessionId===sessionId?active.abort.signal:extensionCommand?.sessionId===sessionId?extensionCommand.abort.signal:undefined);
      let timer;
      const prompt={id,sessionId,kind,title,...(kind==="select"?{options:detail}:kind==="confirm"?{message:detail}:{placeholder:detail??""}),
        ...(opts.timeout?{expiresAt:Date.now()+opts.timeout}:{}),
        finish(value,cancelled=false){clearTimeout(timer);signal?.removeEventListener("abort",abort);extensionPrompts.delete(id);resolve(cancelled?(kind==="confirm"?false:undefined):value);emit();}};
      const abort=()=>prompt.finish(undefined,true);
      if(signal?.aborted)return abort();
      extensionPrompts.set(id,prompt);signal?.addEventListener("abort",abort,{once:true});
      if(opts.timeout)timer=setTimeout(abort,opts.timeout);
      emit();
    });
    const ui={
      select:(title,options,opts)=>request("select",title,options,opts),
      input:(title,placeholder,opts)=>request("input",title,placeholder,opts),
      confirm:(title,message,opts)=>request("confirm",title,message,opts),
      notify(message,type="info"){extensionNotifications.push({id:randomUUID(),sessionId,message:String(message),type});if(extensionNotifications.length>32)extensionNotifications.shift();emit();},
      setStatus(key,text){const id=sessionId+":"+key;if(text===undefined)extensionStatuses.delete(id);else extensionStatuses.set(id,{sessionId,key,text:String(text)});emit();},
      setWorkingMessage(text){this.setStatus("working",text);},
    };
    for(const method of ["onTerminalInput","setWorkingVisible","setWorkingIndicator","setHiddenThinkingLabel","setWidget","setFooter","setHeader","setTitle","custom","pasteToEditor","setEditorText","getEditorText","editor","addAutocompleteProvider","setEditorComponent","getEditorComponent","getAllThemes","getTheme","setTheme","getToolsExpanded","setToolsExpanded"])ui[method]=()=>{throw uiError(method);};
    ui.setWidget=(key,content)=>{
      if(content===undefined)return ui.setStatus("widget:"+key,undefined);
      if(Array.isArray(content)&&content.every(line=>typeof line==="string"))return ui.setStatus("widget:"+key,content.join("\n"));
      ui.notify(`EXTENSION_UI_UNSUPPORTED: setWidget(${key}) uses a native terminal component; it was not rendered. Use cothink in the terminal for this decoration.`,"warning");
    };
    for(const method of ["setFooter","setHeader"])ui[method]=factory=>{if(factory)ui.notify(`EXTENSION_UI_UNSUPPORTED: ${method} is a terminal decoration and was not rendered.`,"warning");};
    ui.theme={fg:()=>{throw uiError("theme.fg");},bg:()=>{throw uiError("theme.bg");}};
    return ui;
  }
  const extensionSnapshot=()=>({prompts:[...extensionPrompts.values()].map(({finish,...p})=>p),notifications:extensionNotifications,statuses:[...extensionStatuses.values()],command:extensionCommand?{sessionId:extensionCommand.sessionId}:null});
  async function extensionRuntime(sessionId) {
    assertSessionUnarchived(sessionId);
    const holder=await owner(sessionId,{mutating:true}),config=loadConfig(home);
    await assertWorkspaceWritable(holder.sessionManager,{forExecution:true});
    if(config?.formatVersion!==3)throw Error("请先配置具名 Team。");
    return runtime(sessionId,holder,resolveConversationConfig(config,holder.sessionManager).config);
  }
  const updates=updateService ?? createUpdateService({home});
  const unsubscribeUpdates=updates.subscribe(()=>{if(!closed) emit();});
  const updateSnapshot=()=>{if(installation === "desktop") return {channel:"desktop-local",status:"local",automatic:false,message:"桌面本地候选；更新渠道尚未启用。",instructions:[],currentVersion:releaseNotes().version};const s=updates.snapshot();return {...s,message:formatUpdateStatus(s),instructions:updateInstructions(s)};};
  const checkForUpdates=()=>installation === "desktop" ? Promise.resolve(updateSnapshot()) : updates.check();
  // Disposable summaries: stat every dependency, parse only changed durable bytes.
  // No request bodies, reviewer text or second persisted conversation store.
  const taskCache = new Map(), sessionCache = new Map(), fileListCache = new Map();
  async function files(id) {
    const record=rawTask(id).record;
    const key=JSON.stringify(record.work ?? null);
    const previous=fileListCache.get(id);
    if(!record.deliveryRef&&previous?.key===key)return previous.value;
    const value=await guiFiles(home,record);
    fileListCache.set(id,{key,value});
    return value;
  }
  const signature = path => {
    try { const s = statSync(path); return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`; }
    catch (e) { return e.code === "ENOENT" ? "missing" : "unreadable"; }
  };
  function taskIndex() {
    let files;
    try { files = readdirSync(join(home, "tasks")).filter(n => n.endsWith(".json")); }
    catch (e) { if (e.code === "ENOENT") return {records: [], errors: []}; throw e; }
    const records = [], errors = [];
    for (const name of files) {
      const id = name.slice(0, -5), path = join(home, "tasks", name);
      let cached = taskCache.get(id);
      const stamp = signature(path);
      const dependencies = ids => ids.map(r => [r, signature(join(home, "requests", r + ".json")),
        signature(join(home, "requests", r + ".events.jsonl"))]);
      if (!cached || cached.value?.flow==="unified" || cached.stamp !== stamp || JSON.stringify(dependencies(cached.requestIds)) !== cached.dependencies) {
        cached = {stamp, requestIds: [], dependencies: "[]"};
        try {
          const record = readTask(home, id);
          if (!Array.isArray(record.requestIds) || record.requestIds.some(r=>typeof r !== "string" || !/^[0-9a-f-]{36}$/.test(r)) || typeof record.input !== "string" || typeof record.createdAt !== "string") throw Error("task summary");
          cached.requestIds = record.requestIds;
          cached.value = {id: record.id, sessionId: record.sessionId, submissionId: record.submissionId,
            createdAt: record.createdAt, cancelSettledAt: record.cancelSettledAt ?? null, input: record.input, status: taskDisplayStatus(record),
            origin:record.origin,sourceLeaf:record.sourceLeaf,sourceSnapshot:record.sourceSnapshot,contextResult:record.contextResult,singleModel: record.singleModel, flow:record.flow, proposal:record.proposal,proposalRef:record.proposalRef,confirmationIntent:record.confirmationIntent,projectPreparationBlocked:record.projectPreparationBlocked,continuationSource:record.continuationSource,materials:record.materials,inputDigest:record.inputDigest,hasWork: !!record.work||!!record.deliveryRef||!!record.projectOperation?.childTaskIds?.length, finalText: ""};
          try {
            cached.value.finalText = finalGuiText(record, readRequests(home, record),home);
            cached.value.resultRevision = guiResultRevision(record,cached.value.finalText);
            cached.value.endedAt = record.endedAt ?? null;
          } catch { cached.value.historyError = "任务请求记录损坏、缺失或不可用；原文件保留。"; }
        } catch { cached.error = "任务记录损坏或版本不支持；原文件保留，未知提交不自动重发。"; }
        cached.dependencies = JSON.stringify(dependencies(cached.requestIds));
        taskCache.set(id, cached);
      }
      if (cached.error) errors.push({taskId: id, error: cached.error});
      else records.push(cached.value);
    }
    for (const id of taskCache.keys()) if (!files.includes(id + ".json")) taskCache.delete(id);
    records.sort((a,b) => b.createdAt.localeCompare(a.createdAt));
    return {records, errors};
  }
  const taskRecords = () => taskIndex().records;
  function workspaceFacts(manager) {
    let project;
    try {
      project = readSessionProject(manager);
      if (project !== null && !isWorkspaceProject(project))
        return {associationError:"会话的项目路径无法确认；原记录保留。"};
      const forkOf = manager.getBranch().findLast(entry =>
        entry.type === "custom" && entry.customType === "cothink-fork")?.data ?? null;
      return {sessionId:manager.getSessionId(),marker:readSessionWorkspace(manager), project, forkOf,
        branched: !!forkOf || !!manager.getHeader()?.parentSession};
    } catch (error) {
      return {project, associationError:error.message};
    }
  }
  function projectMembership(facts, table) {
    const {marker, project, associationError, sessionId} = facts ?? {};
    const unknown = (message = "会话的 Team 归属无法确认；原记录保留。") => ({workspaceError:message});
    if (!facts || associationError) return unknown(associationError);
    if (marker === null) return project === null ? {workspaceId:null, workspaceArchived:false} : unknown();
    if (marker === undefined && project === null) return {workspaceId:null, workspaceArchived:false};
    const workspace = table && workspaceForSession(table,sessionId,project,marker);
    if (!workspace) return unknown();
    return {workspaceId:workspace.id, workspaceArchived:workspace.archived};
  }
  function branchFacts(manager) {
    const entries = manager.getEntries();
    const seen = new Set(), parents = new Set();
    for (const {id,parentId} of entries) {
      if (typeof id !== "string" || seen.has(id) || (parentId !== null && !seen.has(parentId)))
        throw Error("会话分支关系损坏。");
      seen.add(id);
      if (parentId !== null) parents.add(parentId);
    }
    const leaves = entries.filter(entry=>!parents.has(entry.id)).map(entry=>entry.id);
    if (!leaves.length) return [workspaceFacts(manager)];
    return leaves.map(id=>workspaceFacts({
      getBranch:()=>manager.getBranch(id), getCwd:()=>manager.getCwd(),
      getHeader:()=>manager.getHeader(), getSessionId:()=>manager.getSessionId(),
    }));
  }
  function discoverWorkspaces(infos) {
    return importGuiWorkspaceProjects(home, infos.flatMap(info =>
      info.error ? [] : (info.branches ?? []).flatMap(branch =>
        !branch.associationError && branch.marker === undefined && branch.project !== null
          ? [{sessionId:info.id,project:branch.project}] : [])));
  }
  function assertSessionUnarchived(id) {
    if (readSessionUiState(home,id).archived)
      throw sessionStateError("SESSION_STATE_UNAVAILABLE","对话已归档，请先恢复；已保存内容保留。");
  }
  async function assertWorkspaceWritable(manager,{forExecution = false} = {}) {
    const facts = workspaceFacts(manager);
    // A valid generic association does not depend on the workspace directory.
    const independent = projectMembership(facts);
    if (independent.workspaceId === null) return independent;
    if (facts.associationError || facts.marker === null)
      throw workspaceError("WORKSPACE_UNAVAILABLE", independent.workspaceError);
    const table = discoverWorkspaces(await summaries());
    const membership = projectMembership(facts,table);
    if (membership.workspaceError)
      throw workspaceError("WORKSPACE_UNAVAILABLE", membership.workspaceError);
    if (membership.workspaceArchived)
      throw workspaceError("WORKSPACE_ARCHIVED", "此 Team 已归档，请先恢复。");
    if (forExecution && facts.project !== null && !await savedProjectAvailable(facts.project,loadConfig(home)?.work))
      throw workspaceError("WORKSPACE_UNAVAILABLE", "此对话保存的项目目录已不可用或指向其他仓库，历史仍可阅读。");
    const latest = projectMembership(facts,readGuiWorkspaces(home));
    if (latest.workspaceError) throw workspaceError("WORKSPACE_UNAVAILABLE",latest.workspaceError);
    if (latest.workspaceArchived) throw workspaceError("WORKSPACE_ARCHIVED","此 Team 已归档，请先恢复。");
    return membership;
  }
  async function savedProjectAvailable(path,work) {
    const project = await inspectGuiProject(home,path,work,{includeChanges:false});
    return project.executionReady && savedDirectoryAvailable(path,project);
  }
  async function summaries() {
    const files = readdirSync(directory).filter(n => n.endsWith(".jsonl"));
    const result = [];
    for (const name of files) {
      const path = join(directory, name), stamp = signature(path);
      let cached = sessionCache.get(path);
      if (!cached || cached.stamp !== stamp) {
        cached = {stamp, legacySeenResults:cached?.legacySeenResults};
        try {
          // Discover the header even when a later line is damaged; never silently hide it.
          const raw = readFileSync(path, "utf8"), header = JSON.parse(raw.split("\n").find(Boolean));
          if (header.type !== "session" || !/^[0-9a-f-]{36}$/.test(header.id)) throw Error("header");
          cached.info = {id: header.id, cwd: header.cwd, path, modified: statSync(path).mtime};
          try {
            const entries = raw.split("\n").filter(Boolean).map(line => JSON.parse(line));
            const manager = SessionManager.inMemory(header.cwd, undefined, entries);
            cached.branch = {meta: readConversationMetadata(manager), ...workspaceFacts(manager),
              ids: conversationTaskIds(manager)};
            readSessionMode(manager); readSessionTeam(manager.getBranch());
            try { cached.branches=branchFacts(manager); } catch { /* A damaged sibling prevents rebind, not a valid branch read. */ }
          } catch { cached.error = "会话历史损坏或不可用；原文件保留，请修复后重新打开。"; }
        } catch { /* Unidentifiable headers cannot become selectable IDs. */ }
        sessionCache.set(path, cached);
      }
      if (cached.info) result.push({...cached.info, stamp:cached.stamp, branch: cached.branch, branches:cached.branches, error: cached.error});
    }
    for (const path of sessionCache.keys()) if (!files.some(n => join(directory,n) === path)) sessionCache.delete(path);
    return result;
  }
  function sessionEntries(path) {
    const entries = readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
    if (entries[0]?.type !== "session" || !isWorkspaceId(entries[0].id) ||
        entries.slice(1).some(entry => entry.type === "session")) throw Error("会话头部损坏。");
    return entries;
  }
  async function reader(id,summary) {
    if (holders.has(id)) {
      const manager = holders.get(id).sessionManager;
      // New GUI empty sessions are durable too. Never let a cached holder hide
      // damage to their header or initial selection records.
      if (holders.get(id).persisted || existsSync(manager.getSessionFile())) {
        const entries = sessionEntries(manager.getSessionFile());
        if (entries[0].id !== id) throw Error("会话身份不匹配。");
        const disk = SessionManager.inMemory(manager.getCwd(),undefined,entries);
        readConversationMetadata(disk);
        readSessionMode(disk); readSessionTeam(disk.getBranch());
        // Association damage blocks writes without hiding otherwise readable turns.
        if (workspaceFacts(disk).associationError || holders.get(id).selectionError || holders.get(id).runtime?.selectionError) return disk;
      }
      return manager;
    }
    const info = summary ?? (await summaries()).find((s) => s.id === id);
    if (!info) throw Error("会话不存在，请刷新历史。");
    const entries = sessionEntries(info.path);
    return SessionManager.inMemory(info.cwd, undefined, entries);
  }
  async function owner(id,{mutating = false} = {}) {
    // Pi's writable reader tolerates malformed lines. Validate our strict history
    // projection before acquiring a writer so damaged facts cannot be skipped.
    const readable = await session(id);
    if (readable.selectionError) throw Error(readable.selectionError);
    for(const r of taskRecords().filter(r=>r.sessionId===id&&r.origin==='context.organize'&&r.id!==active?.taskId&&(r.status==='outcome_unknown'&&!r.contextResult||r.contextResult?.uncertain))){
      const recovered=await readContextOperation(r.id);
      if(!recovered.applied)throw sessionStateError('CONTEXT_STORAGE','旧整理结果未确认；只读查询原操作，禁止继续生成。');
    }
    if (readable.workspaceError) throw workspaceError("WORKSPACE_UNAVAILABLE", readable.workspaceError);
    if (mutating && readable.workspaceArchived)
      throw workspaceError("WORKSPACE_ARCHIVED","此 Team 已归档，请先恢复。");
    let holder = holders.get(id);
    if (holder) {
      if (holder.opening) await holder.opening;
      holder.assertOwned();
      return holder;
    }
    const info = (await summaries()).find((s) => s.id === id);
    if (!info) throw Error("会话不存在，请刷新历史。");
    const writer = acquireSessionWriter(join(home, "pi"), id);
    try {
      const manager = SessionManager.open(info.path);
      holder = {
        sessionManager: manager,
        persisted: true,
        writer,
        assertOwned: writer.assertOwned,
      };
      holders.set(id, holder);
      return holder;
    } catch (e) {
      writer.release();
      throw e;
    }
  }
  function chatResources(manager,config) {
    const project=readSessionProject(manager), cwd=neutralDirectory(home);
    const directory=project===null?null:inspectGuiDirectory(project);
    const projectAvailable=project!==null&&savedDirectoryAvailable(project,directory);
    const resourceCwd=projectAvailable?directory.canonicalPath:cwd;
    const options=project!==null&&!projectAvailable&&config?.piResources ? {...config,piResources:
      Object.fromEntries(Object.entries(config.piResources).map(([kind,paths])=>[kind,kind==="tools"?paths:paths.filter(path=>{
        if(!isAbsolute(path))return false;
        const rel=relative(project,path);
        return isAbsolute(rel)||rel===".."||rel.startsWith("../")||rel.startsWith("..\\");
      })]))} : config;
    return {cwd,resourceCwd,projectAvailable:!!projectAvailable,options:selectedResources(options??{},resourceCwd)};
  }
  async function runtime(id, holder, effective) {
    const manager = holder.sessionManager, resources=chatResources(manager,effective);
    const project=readSessionProject(manager);
    const workReady=resources.projectAvailable&&project!==null&&(await fileWorkStatus(home,project)).executionReady;
    if (holder.runtime?.packageSnapshot.project===resources.resourceCwd && holder.runtimeWorkReady===workReady) return holder.runtime;
    if (holder.opening) return holder.opening;
    holder.opening = (async () => {
      if(holder.runtime){
        await holder.runtime.dispose();
        holder.runtime=null;
        holder.writer=acquireSessionWriter(join(home,"pi"),id);
        holder.assertOwned=holder.writer.assertOwned;
      }
      const host = { allowWork:workReady,flow:"unified" };
      holder.writer.release();
      holder.writer = null;
      try {
        const rt = await createRuntime({
          home,
          cwd: resources.cwd,
          packageCwd:resources.resourceCwd,
          sessionManager: manager,
          modelRef: effective.main,
          projectManaged:true,
          contextAccess:true,
          uiContext:extensionUI(id),
          extensionFactories: [
            { name: "cothink", factory: cothinkExtension(host) },
          ],
          resourceOptions: {
            ...resources.options,
            systemPrompt: readFileSync(
              new URL("../prompts/main.md", import.meta.url),
              "utf8",
            ),
            noContextFiles:true,
          },

        });
        rt.hostContext = (task) => {
          host.task = task;
          host.runtime = rt;
        };
        rt.effectiveConfig = effective;
        rt.singleModel = readSessionMode(manager);
        rt.needsTeam = false;
        holder.runtime = rt;
        holder.runtimeWorkReady = workReady;
        holder.assertOwned = rt.assertOwned;
        return rt;
      } catch (e) {
        holders.delete(id);
        throw e;
      }
    })();
    const opening = holder.opening;
    void opening
      .finally(() => {
        holder.opening = null;
      })
      .catch(() => {});
    return opening;
  }
  function rawTask(id) {
    return (
      (active?.taskId === id ? live.get(id) : null) ?? {
        record: readTask(home, id),
        requests() {
          return readRequests(home, this.record);
        },
      }
    );
  }
  const eligibleResults = turns => Object.fromEntries(turns.filter(turn =>
    turn.resultRevision && turn.endedAt && turn.status !== "stop_unknown" && turn.id !== active?.taskId)
    .map(turn => [turn.id,turn.resultRevision]));

  function readingView(navigation,facts,info,turns) {
    if (navigation.navigation?.view)
      return {view:navigation.navigation.view,viewError:null};
    const cache = info && sessionCache.get(info.path);
    const legacy = facts && facts.marker === undefined && !facts.branched && !facts.associationError;
    if (cache && legacy && cache.legacySeenResults === undefined)
      cache.legacySeenResults = eligibleResults(turns);
    const seenResults = legacy && cache?.legacySeenResults
      ? Object.fromEntries(turns.filter(turn => Object.hasOwn(cache.legacySeenResults,turn.id))
        .map(turn => [turn.id,cache.legacySeenResults[turn.id]]))
      : {};
    const viewError = navigation.navigationError ?? (facts?.branched
      ? "分支的原阅读位置未恢复；从空已读记录继续。"
      : "阅读位置暂未保存。");
    return {view:{initialized:false,lastOpenedAt:null,anchor:null,seenResults},viewError};
  }

  async function session(id,{recoverNewView = true} = {}) {
    let records;
    // ID-only associations survive branch navigation without exposing sibling content.
    const submissions = () => (records ?? taskRecords())
      .filter((t) => t.sessionId === id)
      .filter((t) => t.submissionId)
      .map((t) => ({ taskId: t.id, submissionId: t.submissionId }));
    try {
      const infos = await summaries();
      const info = infos.find(item => item.id === id);
      const manager = await reader(id,info);
      const meta = readConversationMetadata(manager);
      const ids = conversationTaskIds(manager);
      const branch = manager.getBranch();
      records = taskRecords();
      // An accepted task can be observed before Pi appends its first branch marker.
      if (active?.sessionId === id && live.has(active.taskId) && !ids.includes(active.taskId))
        ids.push(active.taskId);
      const turns = ids.map((taskId) => {
        const current = active?.taskId === taskId ? live.get(taskId) : null,
          record = current?.record ?? records.find((t) => t.id === taskId);
        if (!record || record.historyError) throw Error("分支引用的任务记录缺失或损坏。");
        const finalText = current ? finalGuiText(record,current.requests(),home) : record.finalText;
        return {
          taskId: record.id,
          flow:record.flow,proposal:record.proposal,proposalRef:record.proposalRef,confirmationIntent:record.confirmationIntent,
          projectPreparationBlocked:record.projectPreparationBlocked??null,continuationSource:record.continuationSource??null,
          createdAt: record.createdAt ?? null,
          endedAt: record.endedAt ?? null,
          cancelSettledAt: record.cancelSettledAt ?? null,
          submissionId: record.submissionId ?? null,
          input: record.input,
          materials:(record.materials??[]).map(({ownerId,...ref})=>ref),
          status: taskDisplayStatus(record),
          hasWork: current ? !!current.record.work||!!current.record.deliveryRef : !!record.hasWork,
          mode: record.singleModel ? "one" : "cothink",
          finalText,
          resultRevision: current ? guiResultRevision(record,finalText) : record.resultRevision,
          canFork: record.status === "completed" && !!finalText && branch.some(entry =>
            entry.type === "custom_message" && entry.customType === "cothink-task-status" && entry.details?.taskId === taskId),
        };
      });
      const selectionError = holders.get(id)?.runtime?.selectionError ??
        holders.get(id)?.selectionError ?? null;
      const readOnly = !!selectionError ||
        (!holders.has(id) && sessionWriterBusy(join(home, "pi"), id));
      const facts = workspaceFacts(manager);
      let viewFailure;
      if (recoverNewView && facts.marker !== undefined && !facts.associationError && !facts.branched) {
        try { initializeSessionView(home,{sessionId:id,seenResults:{},onlyIfMissing:true}); }
        catch(error) { viewFailure = "阅读状态暂未保存：" + error.message; }
      }
      const navigation = navigationFor(id);
      let table;
      try { table = discoverWorkspaces(infos); } catch { /* A damaged table cannot make history unreadable. */ }
      const association = facts.associationError ? facts : info?.branch ?? facts;
      const membership = projectMembership(association,table);
      const reading = readingView(navigation,association,info,ids.map(taskId => records.find(r=>r.id===taskId)).filter(Boolean));
      if (viewFailure) reading.viewError = viewFailure;
      if (reading.view.anchor && !turns.some(turn => turn.taskId === reading.view.anchor.taskId &&
          (reading.view.anchor.part === "input" || turn.resultRevision))) {
        const last = turns.at(-1);
        reading.view = {...reading.view,anchor:last
          ? {taskId:last.taskId,part:last.resultRevision ? "result" : "input",offsetPx:0} : null};
        reading.viewError = "原阅读位置已不可用，已定位到最近保存的消息。";
      }
      const projectStatus=association.project ? await fileWorkStatus(home,association.project) : null;
      return safe({
        ...navigation, persisted: !!info,
        id,
        title: meta.title || turns[0]?.input.slice(0, 60) || "新对话",
        project: association.project ?? null,
        projectDirectoryAvailable: association.project ? savedDirectoryAvailable(association.project) : null,
        projectStatus,
        pluginCommands:(holders.get(id)?.runtime?.commands()??[]).filter(c=>!c.source?.includes?.("inline:cothink")).map(c=>({name:c.name,description:c.description??""})),
        ...membership,
        mode: readSessionMode(manager) ? "one" : "cothink",
        team: publicTeam(readSessionTeam(manager.getBranch())),
        rosterRequired: readSessionTeam(branch) ? null :
          branch.findLast(e=>e.type==="custom"&&e.customType==="cothink-roster-required")?.data?.reason ?? null,
        context:contextState(manager),contextOrganizing:active?.origin==='context.organize'&&active.sessionId===id,
        contextOperationIds:records.filter(r=>r.origin==='context.organize'&&r.sessionId===id&&branch.some(e=>e.id===r.sourceLeaf)).map(r=>r.id),
        ...materialView(id,meta.editor,manager),draft: meta.draft, editor: meta.editor, draftRevision: meta.draftRevision, branchAnchor: meta.branchAnchor,
        ...reading, viewRevision: navigation.navigation?.viewRevision ?? 0,
        forkOf: facts.forkOf,
        thinking: meta.thinking ?? null,
        turns,
        submissions: submissions(),
        readOnly: readOnly || !!membership.workspaceError || !!navigation.navigationError ||
          !!membership.workspaceArchived || !!navigation.navigation?.archived,
        selectionError,
      });
    } catch {
      const info = (await summaries()).find((s) => s.id === id);
      if (!info && !holders.has(id)) throw Error("会话不存在，请刷新历史。");
      // Retain a cached, previously accepted mode only as a read-only selection.
      let mode = "cothink";
      try {
        const cached = holders.get(id)?.sessionManager;
        if (cached && readSessionMode(cached)) mode = "one";
      } catch { /* Corrupt selections carry no usable default for generation. */ }
      return safe({
        ...navigationFor(id), persisted: !!info,
        id, title: "历史不可用", project: null, mode, team: null,
        thinking: null, draft: "", turns: [], submissions: submissions(), readOnly: true,
        selectionError: "会话历史或任务请求记录损坏、缺失或不可用；原文件保留，请修复后重新打开。禁止继续生成，未知提交不会重发。",
      });
    }
  }
  function navigationFor(id) {
    try { return {navigation: readSessionUiState(home,id), navigationError: null}; }
    catch (error) { return {navigation: null, navigationError: error.message}; }
  }
  async function sessions({query = "", project, workspaceId, archived = "active", cursor, limit = 50} = {}) {
    if (typeof query !== "string" || query.length > 200 || !["active", "archived", "all"].includes(archived) ||
      !Number.isInteger(limit) || limit < 1 || limit > 100 || (project !== undefined && project !== null && typeof project !== "string") ||
      (workspaceId !== undefined && workspaceId !== null && !isWorkspaceId(workspaceId)))
      throw Error("会话查询参数无效。");
    const infos = await summaries(), index = taskIndex(), errors = [...index.errors];
    let table;
    const workspaceErrors = [];
    try { table = discoverWorkspaces(infos); }
    catch (error) { workspaceErrors.push({code:error.code, error:error.message}); }
    const byTask = new Map(index.records.map(r => [r.id,r]));
    if (active && live.has(active.taskId)) {
      const task = live.get(active.taskId), record = task.record;
      const finalText = finalGuiText(record,task.requests(),home);
      byTask.set(record.id,{...record,status:taskDisplayStatus(record),finalText,
        resultRevision:guiResultRevision(record,finalText)});
    }
    const rows = [], workspaceRows = new Map();
    const needle = query.trim().toLocaleLowerCase();
    const prompts = new Set([...extensionPrompts.values()].map(prompt => prompt.sessionId));
    const attentionRank = {running:1,unread:2,needs_attention:3};
    for (const id of new Set([...infos.map(i=>i.id), ...holders.keys()])) {
      const info = infos.find(i=>i.id===id), holder = holders.get(id);
      let branch = info?.branch, error = info?.error;
      if (holder?.persisted && !info) error = "保存的会话不可用；请修复后重新打开。";
      if (holder && !error) {
        const manager = holder.sessionManager;
        try { branch = {meta: readConversationMetadata(manager), ...workspaceFacts(manager), ids: conversationTaskIds(manager)}; }
        catch { error = "会话选择不可用，请重新打开。"; }
      }
      const ids = [...(branch?.ids ?? [])];
      if (active?.sessionId === id && live.has(active.taskId) && !ids.includes(active.taskId)) ids.push(active.taskId);
      const turns = ids.map(t => byTask.get(t)).filter(Boolean);
      const branchBlocked = turns.length !== ids.length || turns.some(t=>t.historyError);
      if (branchBlocked) error ??= "分支任务或请求记录损坏、缺失或不可用；原文件保留。";
      const selectionError = holder?.runtime?.selectionError ?? holder?.selectionError;
      error ??= selectionError;
      // Keep live turns from the holder, but never let its cached marker hide disk damage.
      const association = info?.branch ?? branch;
      const nav = navigationFor(id), membership = projectMembership(association,table);
      const reading = readingView(nav,error ? null : association,info,turns);
      const lastOpenedAt = reading.view.lastOpenedAt;
      if (membership.workspaceId && !nav.navigation?.archived) {
        const workspace = workspaceRows.get(membership.workspaceId) ??
          {recentSessionId:null,lastOpenedAt:null,attention:null,attentionAt:""};
        workspaceRows.set(membership.workspaceId,workspace);
        if (!error && !nav.navigationError &&
            (!workspace.recentSessionId || (lastOpenedAt ?? "") > (workspace.lastOpenedAt ?? "") ||
              lastOpenedAt === workspace.lastOpenedAt && id < workspace.recentSessionId)) {
          workspace.recentSessionId = id;
          workspace.lastOpenedAt = lastOpenedAt;
        }
        const unread = !error && !nav.navigationError && turns.findLast(turn =>
          turn.resultRevision && turn.resultRevision !== reading.view.seenResults[turn.id]);
        const activeHere = active?.sessionId === id;
        const kind = prompts.has(id) || selectionError || branchBlocked || nav.navigationError ? "needs_attention"
          : unread ? "unread" : activeHere || extensionCommand?.sessionId === id ? "running" : null;
        const attentionAt = (kind === "unread" ? unread.endedAt ?? unread.createdAt : lastOpenedAt) ?? "";
        if (!membership.workspaceArchived && kind && (!workspace.attention || attentionRank[kind] > attentionRank[workspace.attention.kind] ||
            kind === workspace.attention.kind && (attentionAt > workspace.attentionAt ||
              attentionAt === workspace.attentionAt && id < workspace.attention.sessionId))) {
          workspace.attention = {kind,sessionId:id,taskId:kind === "unread" ? unread.id
            : activeHere && live.has(active.taskId) ? active.taskId : null};
          workspace.attentionAt = attentionAt;
        }
      }
      if (membership.workspaceError && !error && !workspaceErrors.some(problem => !problem.sessionId))
        workspaceErrors.push({sessionId:id,code:"WORKSPACE_UNAVAILABLE",error:membership.workspaceError});
      if (error || nav.navigationError) errors.push({sessionId:id,error:error || nav.navigationError});
      const title = error ? "历史不可用" : branch?.meta.title || turns[0]?.input.slice(0,60) || "新对话";
      const summary=(turns.find(turn=>turn.input?.trim())?.input.trim().split(/\n\s*\n/)[0]??"").replace(/\s+/g," ").slice(0,140);
      const hasDraft=!!(branch?.meta.editor.text?.trim()||branch?.meta.editor.materials.length);
      const row = {id, title, summary,hasDraft,running:active?.sessionId===id, project: association?.project ?? null, updatedAt: info?.modified.toISOString() ?? null,
        lastOpenedAt, persisted: !!info, readOnly: !!error || !!membership.workspaceError || !!nav.navigationError ||
          !!membership.workspaceArchived || !!nav.navigation?.archived || (!holder && sessionWriterBusy(join(home,"pi"),id)), ...membership, ...nav};
      if (needle) {
        const sources = [{text:title,taskId:null,field:"title"}, ...(!error ? turns.flatMap(t=>[
          {text:t.input,taskId:t.id,field:"input"}, {text:t.finalText,taskId:t.id,field:"finalText"}]) : [])];
        let match = sources.find(m=>m.text?.toLocaleLowerCase().includes(needle));
        if((!match || match.field==="finalText" && turns.find(t=>t.id===match.taskId)?.proposalRef)&&!error) {
          for(const turn of turns) {
            try {
              const record=rawTask(turn.id).record;
              if(!record.work&&!record.deliveryRef&&!record.projectOperation?.childTaskIds?.length)continue;
              const list=await files(turn.id), item=list.items.find(f=>f.name.toLocaleLowerCase().includes(needle));
              if(item){match={text:item.name,taskId:turn.id,field:"file",fileRef:item.ref};break;}
            } catch(e) {errors.push({taskId:turn.id,error:e.message});}
          }
        }
        if (!match) continue;
        const at = match.text.toLocaleLowerCase().indexOf(needle);
        row.match = {taskId:match.taskId, field:match.field, ...(match.fileRef?{fileRef:match.fileRef}:{}), snippet:match.text.slice(Math.max(0,at-45),at+needle.length+95)};
      }
      rows.push(row);
    }
    const projects = [...new Set(infos.map(i=>i.branch?.project).filter(Boolean).concat([...holders.values()].map(h=>workspaceFacts(h.sessionManager).project).filter(Boolean)))];
    const archiveMatches = value => archived === "all" || (archived === "archived") === !!value;
    const filtered = rows.filter(r => (project === undefined || r.project === project) &&
      (workspaceId === undefined || r.workspaceId === workspaceId) &&
      archiveMatches(r.navigation?.archived || r.workspaceArchived));
    filtered.sort((a,b) => Number(!!b.navigation?.pinned)-Number(!!a.navigation?.pinned) ||
      (b.lastOpenedAt ?? "").localeCompare(a.lastOpenedAt ?? "") ||
      (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.id.localeCompare(b.id));
    const workspaces = table ? table.workspaces.map(item => {
      const facts = workspaceRows.get(item.id);
      return {...item,recentSessionId:facts?.recentSessionId ?? null,lastOpenedAt:facts?.lastOpenedAt ?? null,
        attention:facts?.attention ?? null};
    }).sort((a,b) => (b.lastOpenedAt ?? "").localeCompare(a.lastOpenedAt ?? "") || a.id.localeCompare(b.id)) : null;
    const workspaceMatches = needle ? (workspaces ?? []).filter(item =>
      (workspaceId === undefined || workspaceId === item.id) && (project === undefined || project === item.project) &&
      archiveMatches(item.archived) && item.name.toLocaleLowerCase().includes(needle)).map(item => item.id) : [];
    const fingerprint = createHash("sha256").update(JSON.stringify([query,project,workspaceId,archived,filtered])).digest("hex");
    let offset = 0;
    if (cursor) {
      let value;
      try { value = JSON.parse(Buffer.from(cursor,"base64url").toString()); } catch { /* rejected below */ }
      if (!value || value.fingerprint !== fingerprint || !Number.isSafeInteger(value.offset) || value.offset < 0)
        throw sessionStateError("CURSOR_EXPIRED", "会话列表已变化，请重新读取第一页。");
      offset = value.offset;
    }
    const items = filtered.slice(offset,offset+limit), next = offset+items.length;
    return {items, nextCursor: next < filtered.length ? Buffer.from(JSON.stringify({fingerprint,offset:next})).toString("base64url") : null, errors, projects, workspaces, workspaceMatches, workspaceErrors};
  }
  async function releaseHolder(id) {
    const holder = holders.get(id);
    if (!holder) return;
    if (holder.opening) await holder.opening;
    await holder.runtime?.dispose();
    holder.writer?.release();
    holders.delete(id);
  }
  function homeDraftSnapshot() {
    try {
      const row=readHomeDraft(home);
      if(!row)return {homeDraft:null};
      const editor=normalizeConversationEditor(row.editor);
      return {homeDraft:{...row,editor,...materialView(row.draftId,editor)}};

    }
    catch (error) { return {homeDraftError:error.message}; }
  }
  async function sessionCreation(id) {
    if (!isWorkspaceId(id)) throw sessionStateError("INVALID_ID","无效会话 ID。");
    try {
      const saved=await session(id);
      return {status:saved.persisted && !saved.selectionError ? "confirmed" : "unknown",session:saved};
    } catch {
      try {
        assertNewGuiSessionId(directory,id);
        if (!holders.has(id) && !sessionWriterBusy(join(home,"pi"),id)) return {status:"absent"};
      } catch { /* A broken or busy publication must not be reported absent. */ }
      return {status:"unknown"};
    }
  }
  function saveGuiDraft(holder, editor, homeDraftId) {
    if(readSessionFlow(holder.sessionManager)!=="unified")
      appendConversationEntry(holder,"cothink-flow",{flow:"unified",version:unifiedProtocol});
    appendConversationEntry(holder,"cothink-draft",{...editor,...(homeDraftId?{homeDraftId}:{})});
  }
  function mutateHome(name,args) {
    return writeSelection(async()=>{
      const {draftId,expectedRevision,sessionId,workspaceId}=args;
      if(!isWorkspaceId(draftId)||!(expectedRevision===null||Number.isSafeInteger(expectedRevision)&&expectedRevision>0))
        throw sessionStateError("DRAFT_CONFLICT","首页草稿身份或版本无效。");
      if(name!=="home.draft"&&!isWorkspaceId(sessionId)) throw Error("待创建会话 ID 无效。");
      if(name==="home.transfer"){
        assertSessionUnarchived(sessionId);
        const holder=await owner(sessionId,{mutating:true}), manager=holder.sessionManager;
        await assertWorkspaceWritable(manager);
        writeHomeDraft(home,args,prior=>{
          if(prior?.pendingCreateSessionId!==sessionId ||
            manager.getBranch().find(e=>e.type==="custom"&&e.customType==="cothink-home-origin")?.data?.draftId!==draftId ||
            readSessionWorkspace(manager)!==prior.targetWorkspaceId)
            throw sessionStateError("DRAFT_CONFLICT","首页保存稿与已创建会话的身份不一致。");
          const editor=normalizeConversationEditor(prior.editor);
          if(materials.list({ownerId:draftId}).some(item=>item.status==="pending"))
            throw materialError("MATERIAL_PENDING","首页还有未完成的上传，请完成或取消后再转移。");
          resolveEditorMaterials(draftId,editor.materials);
          const last=manager.getBranch().findLast(e=>e.type==="custom"&&e.customType==="cothink-draft");
          if(last?.data?.editId!==editor.editId){
            if(last && last.data?.homeDraftId!==draftId)
              throw sessionStateError("DRAFT_CONFLICT","新会话草稿已在其他页面编辑，首页保存稿保留。");
            saveGuiDraft(holder.runtime??holder,editor,draftId);
          }
          // Reopen persisted bytes before removing the only independent copy.
          const disk=readContextDisk(manager.getSessionFile(),sessionId);
          if(contextDigest(readConversationMetadata(disk).editor)!==contextDigest(editor))
            throw sessionStateError("DRAFT_CONFLICT","首页转移尚未保存确认，原稿保留。");
          return null;
        });
        emit();
        return session(sessionId);
      }
      let selectedMaterials=[];
    const result=writeHomeDraft(home,args,prior=>{
        const pending=prior?.pendingCreateSessionId??null;
        const target=prior?.targetWorkspaceId??null;
        if(name==="home.draft"){
          if(args.editor?.editorVersion!==2 || !isWorkspaceId(args.editor.editId))
            throw sessionStateError("DRAFT_CONFLICT","首页需要完整编辑稿。");
          const editor=normalizeConversationEditor(args.editor);
          selectedMaterials=resolveEditorMaterials(draftId,editor.materials);
          if(editor.turnOptions?.readAllowed)throw Error("请进入实际会话后选择项目读取范围。");
          return {editor,pendingCreateSessionId:pending,targetWorkspaceId:target};
        }
        if(!prior)throw sessionStateError("DRAFT_CONFLICT","首页保存稿不存在。");
        if(name==="home.reserve"){
          if(pending!==null || workspaceId!==null) throw sessionStateError("DRAFT_CONFLICT","首页已有待确认创建或目标无效。");
          return {editor:prior.editor,pendingCreateSessionId:sessionId,targetWorkspaceId:workspaceId};
        }
        if(pending!==sessionId) throw sessionStateError("DRAFT_CONFLICT","首页待创建标识已改变。");
        assertNewGuiSessionId(directory,sessionId);
        if(holders.has(sessionId)||sessionWriterBusy(join(home,"pi"),sessionId))
          throw sessionStateError("DRAFT_CONFLICT","原创建仍在核对，首页保存稿保留。");
        return {editor:prior.editor,pendingCreateSessionId:null,targetWorkspaceId:null};
      });
      for(const {manifest} of selectedMaterials)materials.acknowledge(manifest);
      emit();
      return result;
    });
  }
  async function bootstrap() {
    const config = loadConfig(home),
      catalog = await createModelRuntime(home),
      notes = releaseNotes();
    try {
      notes.unread = !releaseNotesSeen(home, notes.version);
    } catch {
      notes.unread = true;
      notes.error = "更新摘要显示状态损坏，原文件已保留；无法保存已读状态。";
    }
    const page = await sessions();
    const historyErrors = page.errors;
    const workspaces = page.workspaces === null ? null : await Promise.all(page.workspaces.map(async workspace => ({
      ...workspace,
      projectAvailable: workspace.project === null ? null : savedDirectoryAvailable(workspace.project),
    })));
    return safe({
      version: notes.version,
      protocol:{unified:unifiedProtocol,capabilities:1,guiInput:2},
      ...homeDraftSnapshot(),
      materialCapabilities:GUI_MATERIAL_CAPABILITIES,oauthOperations:oauth.snapshot(),localSkillPaths:config?.piResources?.skills??[],executionConfigDigest:guiExecutionConfigDigest(config?.work),
      builtinSkills:{disabled:validateBuiltinSkills(config),names:builtinSkillNames},
      extensionUI:extensionSnapshot(),
      configured: config?.formatVersion === 3,
      suggestedProject,
      installation,
      shutdown: shutdownState(),
      teams: (config?.teams ?? []).map(publicTeam),
      currentTeamId: config?.lastUsedTeamId ?? null,
      providers: catalog.getProviders().map((p) => ({
        id: p.id,
        name: p.name ?? p.id,
        configured: catalog.hasConfiguredAuth(p.id),
        authKind: !catalog.hasConfiguredAuth(p.id) ? null
          : catalog.isUsingOAuth(p.id) ? "oauth"
          : catalog.getProviderAuthStatus(p.id)?.source === "environment" ? "environment"
          : p.auth?.apiKey ? "api_key" : "configured",
        oauth: !!p.auth?.oauth?.login,
        apiKey: !!p.auth?.apiKey?.login,
      })),
      models: await Promise.all(
        catalog
          .getModels()
          .filter((m) => !m.type || m.type === "chat")
          .map(async (m) => ({
            provider: m.provider,
            modelId: m.id,
            name: m.name ?? m.id,
            reasoning: !!m.reasoning,
            thinkingLevels: await validateModelThinking(m),
            api: m.api,
            contextWindow: m.contextWindow,
            maxTokens: m.maxTokens,
          })),
      ),
      sessions: page.items,
      sessionsCursor: page.nextCursor,
      projects: page.projects,
      workspaces,
      workspaceErrors: page.workspaceErrors,
      active: active
        ? {
            origin:active.origin??null,taskId: active.taskId,
            sessionId: active.sessionId,
            status: live.has(active.taskId) ? taskDisplayStatus(live.get(active.taskId).record) : "preparing",
          }
        : null,
      work: config?.work ?? {},
      releaseNotes: notes,
      updates: updateSnapshot(),
      historyErrors,
    });
  }
  async function getSessionCapabilities(sessionId,draftId) {
    if(sessionId&&draftId)throw Error("请选择一个编辑器归属。");
    if(draftId&&readHomeDraft(home)?.draftId!==draftId)throw materialError("MATERIAL_NOT_FOUND","首页草稿不存在。");
    const manager=sessionId?await reader(sessionId):null,config=loadConfig(home),project=manager?readSessionProject(manager):null;
    const running=sessionId&&active?.sessionId===sessionId?live.get(active.taskId):null;
    if(running){const runtime=[...running.runtimes].find(r=>r.sessionManager.getSessionId()===sessionId);
      const coordinator=runtime?runtime.capabilities():capabilitySnapshot({skills:taskSkillDirectory(running),phase:running.record.phase,hasProject:!!project,readOnly:true,executionConfigured:!!running.record.frozenConfig?.work?.execution});
      if(running.record.projectOperation)return {...coordinator,scope:'coordinator',executors:assertRootOwner(running.rootOwner,running.record.id).executorCapabilities()};
      return coordinator;}
    const builtins=resolveBuiltinSkills(config),diagnostics=[...builtins.diagnostics];let skills=[];
    const resources=manager?chatResources(manager,config):{
      resourceCwd:neutralDirectory(home),options:selectedResources(config??{},neutralDirectory(home)),projectAvailable:false,
    };
    if(project && !resources.projectAvailable)diagnostics.push({code:"PROJECT_DIRECTORY_UNAVAILABLE",message:"保存的目录不可用；本次仅提供个人和内置资源。"});
    try {const cwd=resources.resourceCwd,manual=resources.options,packages=await resolvePackageResources({home,cwd,manual:{skills:manual.additionalSkillPaths,prompts:manual.additionalPromptTemplatePaths,themes:manual.additionalThemePaths}});
      skills=freezeAnswerSkills({cwd,home,paths:[...builtins.skills.map(s=>s.path),...manual.additionalSkillPaths,...packages.skills],project:true,includeRestricted:true}).map(s=>({...s,sourceKind:builtins.skills.some(b=>b.path===s.path)?'builtin':'selected'}));
    }catch {diagnostics.push({code:'SKILL_DISCOVERY',message:'选定技能存在缺失、同名冲突或包状态错误；新任务会在请求前拒绝，请核对资源选择。'});}
    return capabilitySnapshot({skills,tools:[...contextToolNames,'read_skill','get_capabilities','request_review','start_work',...(resources.projectAvailable?['read_project_context']:[])],hasProject:!!project,executionConfigured:!!config?.work?.execution,diagnostics,context:manager?contextState(manager):null});
  }
  async function readContextOperation(operationId) {
    const task=rawTask(operationId),record=task.record;
    if(record.origin!=='context.organize')throw sessionStateError('CONTEXT_IDENTITY','此 ID 不属于上下文整理。');
    const requests=task.requests();
    const file=record.stages.find(stage=>stage.sessionId===record.sessionId)?.sessionFile;
    try {
      if(!file||join(directory,basename(file))!==file)throw Error('整理来源文件不可核对。');
      return contextOperationView(record,requests,readContextDisk(file,record.sessionId));
    }catch(error){return {operationId,taskId:operationId,sessionId:record.sessionId,status:['running','cancelled','failed'].includes(record.status)?taskDisplayStatus(record):'outcome_unknown',applied:false,error:error.message,requests:requests.map(r=>({id:r.id,phase:r.phase,status:r.status,sent:r.sent,usage:r.usage??null})),budget:record.budget};}
  }
  async function organizeContext(args) {
    if(!args||Object.keys(args).some(k=>!['sessionId','operationId','sourceLeaf','budget','protocolVersion'].includes(k))||args.protocolVersion!==unifiedProtocol||!isWorkspaceId(args.sessionId)||!isWorkspaceId(args.operationId)||typeof args.sourceLeaf!=='string')throw sessionStateError('CONTEXT_IDENTITY','整理身份或协议无效。');
    const {sessionId,operationId,sourceLeaf}=args,budget=normalizeRootBudget(args.budget);
    const inputDigest=contextDigest({origin:'context.organize',sessionId,sourceLeaf,budget});
    if(existsSync(join(home,'tasks',operationId+'.json'))){const prior=readTask(home,operationId);if(prior.origin!=='context.organize'||prior.sessionId!==sessionId||prior.sourceLeaf!==sourceLeaf||contextDigest(prior.budget)!==contextDigest(budget)||prior.inputDigest!==inputDigest)throw sessionStateError('CONTEXT_IDENTITY','同一整理 ID 的身份或预算不同。');return readContextOperation(operationId);}
    if(active?.taskId===operationId){if(active.inputDigest!==inputDigest)throw sessionStateError('CONTEXT_IDENTITY','整理身份不一致。');return active.ready;}
    if(active||management||extensionCommand)throw sessionStateError('SESSION_BUSY','当前任务尚未结束；不会排队整理。');
    let resolveReady,rejectReady;const ready=new Promise((a,b)=>{resolveReady=a;rejectReady=b;});
    const state={origin:'context.organize',taskId:operationId,sessionId,inputDigest,ready,abort:new AbortController()};active=state;
    state.promise=(async()=>{
      let task,rt,holder,abort;
      try {
        const prep=await writeSelection(async()=>{
          assertSessionUnarchived(sessionId);holder=await owner(sessionId,{mutating:true});const manager=holder.sessionManager;
          const membership=await assertWorkspaceWritable(manager);
          if(manager.getLeafId()!==sourceLeaf)throw sessionStateError('CONTEXT_SOURCE_CHANGED','整理前分支已变化，请刷新；草稿保留。');
          const disk=readContextDisk(manager.getSessionFile(),sessionId);
          if(contextDigest(disk.getEntries())!==contextDigest(manager.getEntries()))throw sessionStateError('CONTEXT_STORAGE','内存与磁盘历史不一致。');
          const config=loadConfig(home);if(config?.formatVersion!==3||!readSessionTeam(manager.getBranch()))throw Error('请先绑定阵容。');
          const effective=resolveConversationConfig(config,manager).config,thinking=readConversationMetadata(manager).thinking;
          if(thinking!==undefined)effective.main.thinkingLevel=thinking;
          return {effective,workspace:{id:membership.workspaceId??null,project:readSessionProject(manager)},before:structuredClone(manager.getEntries()),opening:runtime(sessionId,holder,effective)};
        });
        rt=await prep.opening;
        if(state.abort.signal.aborted||closed||shuttingDown)throw Error('整理已取消，未发送。');
        rt.assertOwned();if(!rt.session.isIdle)throw sessionStateError('SESSION_BUSY','运行端尚未空闲，不能整理。');
        const manager=rt.sessionManager,after=manager.getEntries();
        // SDK initialization may restore only its missing model/thinking metadata.
        if(contextDigest(after.slice(0,prep.before.length))!==contextDigest(prep.before)||after.slice(prep.before.length).some(e=>!['model_change','thinking_level_change'].includes(e.type)))throw sessionStateError('CONTEXT_SOURCE_CHANGED','运行端准备期间来源变化。');
        await rt.selectModel(prep.effective.main);
        if(state.abort.signal.aborted||closed||shuttingDown)throw Error('整理已取消，未发送。');
        rt.assertOwned();
        if(contextDigest(manager.getEntries().slice(0,prep.before.length))!==contextDigest(prep.before)||manager.getEntries().slice(prep.before.length).some(e=>e.type==='model_change'&&(e.provider!==prep.effective.main.provider||e.modelId!==prep.effective.main.modelId)||e.type==='thinking_level_change'&&e.thinkingLevel!==rt.session.thinkingLevel||!['model_change','thinking_level_change'].includes(e.type)))throw sessionStateError('CONTEXT_SOURCE_CHANGED','准备期间出现非宿主选择变更。');
        if(contextDigest(readContextDisk(manager.getSessionFile(),sessionId).getEntries())!==contextDigest(manager.getEntries()))throw sessionStateError('CONTEXT_STORAGE','准备后的历史未完整落盘。');
        task=createTask({home,secrets:secretValues(home),id:operationId,input:'整理上下文',origin:'context.organize',sourceLeaf,inputDigest,sourceSnapshot:contextSnapshot(manager),sessionId,branchId:manager.getLeafId(),models:{main:prep.effective.main,secondary:[]},team:prep.effective.team,flow:'unified',constraints:normalizeConstraints({readOnly:true,allowedSubtasks:[]}),budget,frozenConfig:prep.effective,workspace:prep.workspace});
        createRootOwner(task);live.set(operationId,task);
        const quarantine=error=>{holder.selectionError=rt.selectionError='上下文写入未确认，运行端已隔离；请查询原操作：'+error.message;};
        abort=()=>{void task.cancel();};state.abort.signal.addEventListener('abort',abort,{once:true});
        const running=compactContext({task,runtime:rt,quarantine,onChange:emit});
        resolveReady({operationId,taskId:operationId,sessionId,status:'running'});emit();
        await running;if(task.cancelPromise)await task.cancelPromise;
      }catch(error){if(task&&task.record.status==='running')task.finish('failed',error.message);rejectReady(error);}
      finally{state.abort.signal.removeEventListener('abort',abort);if(active===state)active=null;emit();}
    })();
    return ready;
  }
  async function submit(args,confirmation,continuation) {
    if(!confirmation && (args.protocolVersion!==unifiedProtocol||Object.keys(args).some(k=>!["sessionId","input","submissionId","protocolVersion","constraints","readAuthorization","budget","editorEditId","materials"].includes(k))))throw Error("统一会话协议不匹配，请重新打开新版界面。");
    const constraints=normalizeConstraints(confirmation?.source.proposal.constraints??continuation?.source.constraints??args.constraints);
    const budget=normalizeRootBudget(confirmation?.reservation.budgetSource.remaining??continuation?.remainingBudget??args.budget);
    const { sessionId, input, submissionId } = args;
    const refs=normalizeConversationEditor({materials:args.materials}).materials.map(({id,sha256})=>({id,sha256}));
    const inputDigest=contextDigest({input,editorEditId:args.editorEditId??null,refs,constraints,budget,readAuthorization:args.readAuthorization??null,
      continuation:continuation?.source.id??null,confirmation:confirmation?.source.id??null});
    if (
      typeof submissionId !== "string" ||
      !submissionId.trim() ||
      submissionId.length > 200
    )
      throw Error("submissionId 必须是 1—200 字符。");
    const prior = taskRecords().find(
      (t) => t.sessionId === sessionId && t.submissionId === submissionId,
    );
    if (prior) {
      if(prior.inputDigest?prior.inputDigest!==inputDigest:
        prior.input!==input||refs.length||continuation&&prior.continuationSource?.taskId!==continuation.source.id)
        throw materialError("SUBMISSION_CONFLICT","同一提交标识已经绑定不同内容。");
      return { taskId: prior.id, sessionId: prior.sessionId };
    }
    if (taskIndex().errors.length)
      throw Error(
        "存在损坏任务记录，无法确认旧提交身份；请保留并修复记录后再提交。历史和设置仍可查看。",
      );
    if (active?.sessionId === sessionId && active.submissionId === submissionId) {
      if(active.inputDigest!==inputDigest)throw materialError("SUBMISSION_CONFLICT","同一提交标识已经绑定不同内容。");
      return active.ready;
    }
    if (continuation && taskRecords().some(task=>task.continuationSource?.taskId===continuation.source.id))
      throw Object.assign(Error("原工作已有续作，请核对该次提交。"),{code:"PROJECT_CONTINUATION_EXISTS"});
    if (active || management || oauthBusy())
      throw Error("当前任务或设置尚未结束；草稿保留，不自动排队。");
    if(typeof input!=="string")throw Error("请输入问题或添加至少一份就绪材料。");
    const slash=singleLineCommand(input);
    if(slash&&!slash[1].startsWith("skill:"))
      throw materialError("COMMAND_UNAVAILABLE",["one","cothink","project"].includes(slash[1])?"统一会话已移除旧模式命令。":"本地或未知命令不能作为模型问题发送。");
    assertSessionUnarchived(sessionId);
    void checkForUpdates();
    let resolveReady, rejectReady;
    const ready = new Promise((yes, no) => {
      resolveReady = yes;
      rejectReady = no;
    });
    const state = {
      taskId: confirmation?.reservation.taskId??randomUUID(),
      sessionId,
      submissionId,
      inputDigest,
      ready,
      abort: new AbortController(),
    };
    active = state;
    state.promise = (async () => {
      try {
        const accepted = await writeSelection(async () => {
          await authRefresh;
          if(authRefreshError)throw authRefreshError;
          assertSessionUnarchived(sessionId);
          const holder = await owner(sessionId,{mutating:true}),
            manager = holder.sessionManager;
          const membership=await assertWorkspaceWritable(manager,{forExecution:!!confirmation||!!args.readAuthorization});
          if (continuation) {
            loadPreparedContinuation({home,manager,sourceTaskId:continuation.source.id});
            if (readSessionProject(manager)!==continuation.source.workspace.project ||
                (membership.workspaceId??null)!==(continuation.source.workspace.id??null))
              throw Error("原工作任务的目录或 Team 已变化。");
            await requireFileWork(home,readSessionProject(manager),continuation.source.workspace.directoryIdentity??undefined);
          }
          if (holder.runtime?.selectionError || holder.selectionError)
            throw Error(
              holder.runtime?.selectionError ?? holder.selectionError,
            );
          const config = loadConfig(home);
          if (config?.formatVersion !== 3) throw Error("请先配置具名 Team。");
          if (!readSessionTeam(manager.getBranch()))
            throw Error("此历史会话尚未绑定 Team，请明确选择。");
          const editor=readConversationMetadata(manager).editor;
          let frozenMaterials=continuation?.materials??[];
          if(!confirmation&&!continuation){
            if(materials.list({ownerId:sessionId}).some(item=>item.status==="pending"&&materialOnBranch(item,manager)))
              throw materialError("MATERIAL_PENDING","仍有材料上传待确认，请完成或取消。");
            if(editor.materials.length||refs.length){
              if(args.editorEditId===undefined||contextDigest(editor.materials.map(({id,sha256})=>({id,sha256})))!==contextDigest(refs))
                throw sessionStateError("DRAFT_CONFLICT","提交材料与已保存草稿不一致。");
              frozenMaterials=resolveEditorMaterials(sessionId,editor.materials,manager);
            }
          }
          if(!confirmation && !continuation && args.editorEditId!==undefined){
            if(editor.editId!==args.editorEditId||editor.text!==input)throw sessionStateError('DRAFT_CONFLICT','提交的完整草稿已变化，请重新核对；未发送。');
            if(editor.turnOptions?.readAllowed&&!editor.turnOptions.readVersion)throw materialError("READ_VERSION","原草稿缺少当时选择的固定版本，请重新选择项目文件。");
            const expected=editorTurnInput(editor.turnOptions,{project:readSessionProject(manager),workspaceId:membership.workspaceId??null});
            if(JSON.stringify(expected.constraints)!==JSON.stringify(constraints)||JSON.stringify(normalizeRootBudget(expected.budget))!==JSON.stringify(budget)||JSON.stringify(expected.readAuthorization??null)!==JSON.stringify(args.readAuthorization??null))throw sessionStateError('DRAFT_CONFLICT','提交选项与已保存草稿不一致；未发送。');
          }
          if(!input.trim()&&!frozenMaterials.length)throw Error("请输入问题或添加至少一份就绪材料。");
          const snapshot = {
            config: confirmation?.source.frozenConfig??resolveConversationConfig(config, manager).config,
            workspace:{id:membership.workspaceId??null,project:readSessionProject(manager)},
            contextTaskIds:conversationTaskIds(manager),
            singleModel: readSessionMode(manager),
            materials:frozenMaterials,
            cwd: neutralDirectory(home),
          };
          const resources=chatResources(manager,snapshot.config);
          snapshot.guiResourceOptions=resources.options;
          snapshot.projectDirectoryAvailable=resources.projectAvailable;
          snapshot.workspace.directoryIdentity=resources.projectAvailable?directoryIdentity(snapshot.workspace.project):null;
          if (!confirmation && !continuation && isGuiFileTask(input, {
            readOnly: constraints.readOnly,
            fileWork: args.editorEditId !== undefined && (editor.turnOptions?.fileWork || !!editor.workRequest),
          })) {
            const {project,directoryIdentity:identity}=snapshot.workspace;
            if (!project) throw workspaceError("PROJECT_NOT_PREPARED", "此对话尚未关联项目目录；文件任务未发送。");
            try {
              await requireFileWork(home,project,identity);
            } catch (error) {
              if (error.code !== "PROJECT_NOT_PREPARED") throw error;
              throw workspaceError(error.code, `文件任务未发送。当前目录 ${project}：${error.message}`);
            }
          }
          const thinking = readConversationMetadata(manager).thinking;
          if (!confirmation && thinking !== undefined)
            snapshot.config.main.thinkingLevel = thinking;
          const requestedRead=args.readAuthorization;
          snapshot.readAuthorization=confirmation?null:await freezeReadAuthorization({home,workspace:snapshot.workspace,sessionId,submissionId,editorEditId:args.editorEditId,input:requestedRead?.version?{paths:requestedRead.paths}:requestedRead});
          if(requestedRead?.version&&snapshot.readAuthorization?.version!==requestedRead.version)
            throw materialError("READ_VERSION","保存的项目版本已改变，请重新浏览和选择。");
          if(!manager.getBranch().some(e=>e.type==="custom"&&e.customType==="cothink-flow"&&e.data?.flow==="unified"))appendConversationEntry(holder,"cothink-flow",{flow:"unified",version:unifiedProtocol});
          // Publish the initialization promise before allowing later selection writes.
          return {
            snapshot,
            opening: runtime(sessionId, holder, snapshot.config),
          };
        });
        const { snapshot } = accepted,
          rt = await accepted.opening;
        if (closed || shuttingDown || state.abort.signal.aborted) throw Error("宿主正在关闭，任务未发送。");
        if (rt.selectionError) throw Error(rt.selectionError);
        // runTurn validates commands against the selected, frozen unified skill catalog.
        // The legacy SDK loader does not include the host's enabled builtin skills.
        const result=await runProjectTurn({
          home,
          cwd: snapshot.cwd,
          input,
          frozenConfig: snapshot.config,
          frozenConstraints:constraints,budget,workspace:snapshot.workspace,readAuthorization:snapshot.readAuthorization,contextTaskIds:snapshot.contextTaskIds,
          ...(confirmation?{frozenSkillSource:confirmation.source,frozenPackageSnapshot:confirmation.source.packageSnapshot,confirmedOperation:{...confirmation,execute:task=>executeConfirmed(task,confirmation.source,confirmation.reservation)}}:{}),
          mainRuntime: rt,
          guiResourceOptions:snapshot.guiResourceOptions,
          beforeWork:()=>requireFileWork(home,snapshot.workspace.project,snapshot.workspace.directoryIdentity),
          materials:snapshot.materials,
          ...(continuation?{continuationSource:{taskId:continuation.source.id}}:{}),
          taskId: state.taskId,
          submissionId,editorEditId:args.editorEditId,
          signal: state.abort.signal,
          onTaskCreated:task=>{task.record.inputDigest=inputDigest;task.save();if(confirmation){const sourceTask=live.get(confirmation.source.id);const source=sourceTask?.record??confirmation.source;source.confirmationIntent.status="consumed";source.confirmationIntent.consumedByTaskId=task.record.id;if(sourceTask)sourceTask.save();else writePrivateJson(join(home,"tasks",source.id+".json"),source,rt.assertOwned);taskCache.delete(source.id);}},
          onProgress: (event) => {
            live.set(event.task.record.id, event.task);
            resolveReady({ taskId: event.task.record.id, sessionId });
            emit();
          },
        });
        // Preparation may durably fail before the first progress callback.
        // Reconcile its original ID as a failed task instead of leaving the UI waiting.
        if(!live.has(state.taskId)){
          const saved=readTask(home,state.taskId);
          if(result?.record?.id!==state.taskId||saved.sessionId!==sessionId||saved.submissionId!==submissionId)
            throw Error("原提交身份无法核对，请读取已保存记录。");
          resolveReady({taskId:saved.id,sessionId,status:saved.status});
        }
      } catch (error) {
        rejectReady(error);
      } finally {
        if (active === state) active = null;
        cancelExtensionPrompts(sessionId);
        clearInterval(state.timer);
        emit();
      }
    })();
    state.timer = setInterval(emit, 250);
    state.timer.unref();
    return ready;
  }
  async function confirmWork(args) {
    if(!args||Object.keys(args).some(k=>!["sessionId","submissionId","proposalRef","protocolVersion"].includes(k))||args.protocolVersion!==unifiedProtocol||typeof args.submissionId!=="string"||!args.submissionId||args.submissionId.length>200)throw Error("确认参数或协议无效。");
    const prepared=await writeSelection(async()=>{
      const holder=await owner(args.sessionId,{mutating:true});
      const membership=await assertWorkspaceWritable(holder.sessionManager,{forExecution:true});
      const id=args.proposalRef?.sourceTaskId;
      if(!conversationTaskIds(holder.sessionManager).includes(id))throw Error("提议不属于当前可见分支。");
      const sourceTask=live.get(id),source=sourceTask?.record??readTask(home,id);
      if (source.workspace?.directoryIdentity!==undefined)
        await requireFileWork(home,source.workspace.project,source.workspace.directoryIdentity);
      const save=()=>{holder.assertOwned();if(sourceTask)sourceTask.save();else writePrivateJson(join(home,"tasks",id+".json"),source,holder.assertOwned);taskCache.delete(id);};
      const reservation=await reserveConfirmation({home,source,proposalRef:args.proposalRef,sessionId:args.sessionId,workspaceId:membership.workspaceId??null,submissionId:args.submissionId,save});
      const found=await confirmationState({home,source,reservation});
      return {source,reservation,found};
    });
    if(prepared.found.task)return {taskId:prepared.found.task.id,sessionId:args.sessionId};
    return submit({sessionId:args.sessionId,input:prepared.source.input,submissionId:prepared.reservation.submissionId},prepared);
  }
  function inspectWorkspaceProject(path) {
    const project = inspectGuiDirectory(path);
    if (!project.directoryAvailable) throw Error(project.reason);
    return project.canonicalPath;
  }
  function directoryIdentity(path) {
    try {const s=statSync(path,{bigint:true});return [String(s.dev),String(s.ino)];}
    catch {return null;}
  }
  async function continuePrepared(args) {
    if (!args || Object.keys(args).length!==4 || !isWorkspaceId(args.sessionId) || !isWorkspaceId(args.sourceTaskId) ||
        !isWorkspaceId(args.submissionId) || args.protocolVersion!==unifiedProtocol) throw Error("工作续作参数无效。");
    const manager=await reader(args.sessionId);
    const continuation=loadPreparedContinuation({home,manager,sourceTaskId:args.sourceTaskId});
    if (continuation.remainingBudget.maxCost!==null)
      throw Error("原工作费用上限无法核实剩余金额，续作尚未发送。");
    if (continuation.remainingBudget.maxCalls===0)
      throw Error("原任务的调用额度已经用完。");
    return submit({sessionId:args.sessionId,input:continuation.source.input,submissionId:args.submissionId,
      protocolVersion:unifiedProtocol},null,continuation);
  }

  async function usableRoster(id,config=loadConfig(home),getCatalog=()=>createModelRuntime(home)) {
    const roster=config?.teams?.find(t=>t.id===id);
    if(!roster)return null;
    try {
      const catalog=await getCatalog(),refs=resolveTeamConfig(config,roster);
      for(const ref of [refs.main,...refs.secondary])
        await validateModelRefs({...refs,main:ref,secondary:[]},catalog,{singleModel:true});
      return roster;
    }catch{return null;}
  }
  async function validateWorkspaceRoster(id) {
    if(id!==null && !await usableRoster(id))
      throw Error("默认阵容不存在或包含不可用的模型，请重新选择或留空。");
  }
  function directoryFiles() {
    return readdirSync(directory).filter(name=>name.endsWith(".jsonl")).sort().map(name=>join(directory,name));
  }
  function freezeWorkspaceHistory(infos, table, current, nextPath) {
    const files=directoryFiles(), found=new Map(infos.map(info=>[info.path,info]));
    const related=new Set(), legacyBindings=[];
    const directoryStamp=nextPath===null?null:signature(nextPath);
    const snapshot=files.map(path=>{
      const info=found.get(path);
      if (!info || signature(path)!==info.stamp || info.error || !info.branches || info.branches.some(branch=>branch.associationError))
        throw workspaceError("WORKSPACE_CONFLICT","有旧会话的分支归属无法核对，目录未变更。",current);
      for (const branch of info.branches) {
        if (projectMembership(branch,table).workspaceId===current.id ||
            nextPath!==null && branch.project===nextPath) related.add(info.id);
        if (branch.marker===undefined && branch.project!==null)
          legacyBindings.push({sessionId:info.id,project:branch.project});
      }
      return [path,info.stamp];
    });
    const verify=()=>{
      if (JSON.stringify(directoryFiles())!==JSON.stringify(files) ||
          snapshot.some(([path,stamp])=>signature(path)!==stamp))
        throw workspaceError("WORKSPACE_CONFLICT","旧会话在核对期间变化，目录未变更。",current);
      if ([active?.sessionId,extensionCommand?.sessionId].some(id=>related.has(id)))
        throw workspaceError("WORKSPACE_CONFLICT","此 Team 正在运行任务或插件命令。",current);
      if ([...related].some(id=>!holders.has(id)&&sessionWriterBusy(join(home,"pi"),id)))
        throw workspaceError("WORKSPACE_CONFLICT","此 Team 的对话正被另一窗口占用，请先关闭该窗口。",current);
      if (nextPath!==null && (inspectWorkspaceProject(nextPath)!==nextPath || signature(nextPath)!==directoryStamp))
        throw workspaceError("WORKSPACE_CONFLICT","新目录在核对期间改变。",current);
    };
    return {legacyBindings,verify};
  }
  function browseProjectFolders(input) {
    const path=inspectWorkspaceProject(input??homedir());
    const folders=readdirSync(path,{withFileTypes:true}).filter(entry=>entry.isDirectory()&&!entry.name.startsWith("."))
      .map(entry=>({name:entry.name,path:join(path,entry.name)})).sort((a,b)=>a.name.localeCompare(b.name));
    return {path,parent:dirname(path)===path?null:dirname(path),folders};
  }
  function makeProjectFolder(args) {
    const {parent,name}=args;
    if (typeof parent!=="string" || typeof name!=="string" || !name.trim() || name!==name.trim() ||
        name==="." || name===".." || /[\x00-\x1f\x7f\\/:]/.test(name) || /[. ]$/.test(name))
      throw Error("请输入一个新文件夹名称。");
    const canonical=inspectWorkspaceProject(parent);
    if (canonical!==parent) throw Error("父目录已改变，请重新浏览。");
    const path=join(parent,name);
    mkdirSync(path);
    return {path:inspectWorkspaceProject(path)};
  }
  async function manageWorkspace(name,args) {
    const keys = name === "workspace.create" ? ["workspaceId","name","project","defaultRosterId"] :
      name === "workspace.rebind" ? ["workspaceId","expectedRevision","path","operationId"] :
      name === "workspace.bind" ? ["workspaceId","expectedRevision","path"] : ["workspaceId","expectedRevision","change"];
    if (!args || Object.keys(args).length !== keys.length || !keys.every(key => Object.hasOwn(args,key)) ||
        !isWorkspaceId(args.workspaceId))
      throw Error("项目 Team 参数无效。");
    return writeSelection(async () => {
      const infos = await summaries();
      const table = ["workspace.rebind","workspace.bind"].includes(name) ? readGuiWorkspaces(home) : discoverWorkspaces(infos);
      const current = table.workspaces.find(w => w.id === args.workspaceId);
      let result;
      if (name === "workspace.create") {
        if (current) throw workspaceError("WORKSPACE_CONFLICT","该 Team 标识已存在；请打开已保存的 Team。",current);
        const project = args.project === null ? null : await inspectWorkspaceProject(args.project);
        await validateWorkspaceRoster(args.defaultRosterId);
        result = createGuiWorkspace(home,{...args,project});
      } else {
        if (!current) throw workspaceError("WORKSPACE_UNAVAILABLE","项目 Team 不存在，请刷新。");
        if (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0)
          throw Error("项目 Team 变更版本无效。");
        if (name === "workspace.rebind" && current.mutationId===args.operationId && current.revision===args.expectedRevision+1 && current.project===args.path) return current;
        if (current.revision !== args.expectedRevision)
          throw workspaceError("WORKSPACE_CONFLICT","项目 Team 已变化，请读取最新状态。",current);
        let change;
        if (name === "workspace.bind" || name === "workspace.rebind") {
          if (name === "workspace.bind" && current.project!==null)
            throw workspaceError("WORKSPACE_CONFLICT","请通过新版目录变更入口更换目录。",current);
          const path=args.path===null&&name==="workspace.rebind"?null:inspectWorkspaceProject(args.path);
          const frozen=freezeWorkspaceHistory(infos,table,current,path);
          const result=rebindGuiWorkspace(home,{workspaceId:args.workspaceId,expectedRevision:args.expectedRevision,
            path,operationId:args.operationId??randomUUID(),legacyBindings:frozen.legacyBindings},frozen.verify);
          emit();
          return result;
        } else {
          change = args.change;
          if (!change || typeof change !== "object" || Array.isArray(change) ||
              Object.keys(change).length !== 1 || !["name","defaultRosterId","archived"].some(key => Object.hasOwn(change,key)))
            throw Error("项目 Team 每次只接受名称、默认阵容或归档状态的一项变更。");
          if (Object.hasOwn(change,"defaultRosterId")) {
            if (active || management)
              throw workspaceError("WORKSPACE_CONFLICT","当前任务或设置尚未结束；默认阵容未保存。",current);
            if (current.archived)
              throw workspaceError("WORKSPACE_ARCHIVED","此 Team 已归档，请先恢复再调整默认阵容。",current);
            await validateWorkspaceRoster(change.defaultRosterId);
          }
          if (change.archived === true) {
            const inWorkspace = facts => projectMembership(facts,table).workspaceId === current.id;
            if ([active?.sessionId,extensionCommand?.sessionId].some(id => id && inWorkspace(
              holders.has(id) ? workspaceFacts(holders.get(id).sessionManager) : infos.find(i => i.id === id)?.branch)))
              throw workspaceError("WORKSPACE_CONFLICT","此 Team 正在执行任务或插件命令，请等待或停止后再归档。",current);
            if (infos.some(info => inWorkspace(info.branch) && !holders.has(info.id) && sessionWriterBusy(join(home,"pi"),info.id)))
              throw workspaceError("WORKSPACE_CONFLICT","此 Team 的对话正被另一窗口占用，请先关闭该窗口。",current);
          }
        }
        result = updateGuiWorkspace(home,{workspaceId:args.workspaceId,expectedRevision:args.expectedRevision,change});
      }
      emit();
      return result;
    });
  }
  async function action(name, args = {}) {
    if (closed) throw Error("宿主已关闭。");
    if (shuttingDown && !["home.draft", "session.draft", "session.view", "task.cancel"].includes(name))
      throw Object.assign(Error("宿主正在退出；新操作已冻结，历史和草稿保存仍可用。"),{code:"HOST_SHUTTING_DOWN"});
    if(active?.origin==='context.organize'&&active.sessionId===(args.sessionId??args.id)&&name.startsWith('session.')&&!['session.view','session.pin'].includes(name))throw sessionStateError('CONTEXT_BUSY','正在整理此对话；本机编辑稿保留，持久修改暂缓。');
    if(["home.draft","home.reserve","home.transfer","home.clearReservation"].includes(name)) return mutateHome(name,args);
    if(name==='context.organize')return organizeContext(args);
    if(name==="material.begin"||name==="material.cancel")return writeSelection(async()=>{
      const {manager}=await materialOwner(args.ownerId,{writable:true});
      const existing=materials.query(args);
      if(!materialOnBranch(existing,manager))throw materialError("MATERIAL_NOT_FOUND","上传不属于当前分支。");
      const value=name==="material.begin"?materials.begin({...args,branchAnchor:existing?existing.branchAnchor:manager?.getLeafId()}):materials.cancel(args);
      if(name==="material.cancel"&&value.status==="ready")materials.acknowledge(args);
      emit();return value;
    });
    if(name==="project.materials")return listProjectMaterials(args);
    if(name==="project.material.import")return importProjectMaterials(args);
    if(name==="oauth.start"){
      if(active||management)throw Error("当前任务或设置尚未结束，请先等待。");
      return oauth.start(args.providerId);
    }
    if(name==="oauth.query")return oauth.lookup(args.operationId);
    if(name==="oauth.respond")return oauth.respond(args.operationId,args.promptId,args.value);
    if(name==="oauth.cancel")return oauth.cancel(args.operationId);
    if(name==="oauth.open"){
      const url=oauth.authorizationUrl(args.operationId);
      if(!url)throw Error("授权链接已经失效。");
      return {url};
    }
    if(name==="settings.inspectExecution"){
      if(active||management)throw Error("当前任务或设置尚未结束，请先等待。");
      const probe=args.probe===true;
      if(probe&&pendingProbeCleanup)throw Error("上次执行探针的清理尚未核实，请关闭时重新核对。");
      management=true;
      executionInspection=Promise.resolve().then(()=>executionInspector(home,{
        probe,onCleanupPending:retry=>{pendingProbeCleanup={retry};},
      })).then(result=>{
        if(result?.probe?.code==="PROBE_CLEANUP")pendingProbeCleanup??={};
        return result;
      }).finally(()=>{
        executionInspection=null;
        management=false;
        emit();
      });
      emit();
      return executionInspection;
    }
    if(name==="extension.respond") {
      const prompt=extensionPrompts.get(args.promptId);
      if(!prompt||prompt.sessionId!==args.sessionId)throw Error("插件提示已结束或不属于此会话。");
      if(!args.cancelled && ((prompt.kind==="select"&&!prompt.options.includes(args.value))||(prompt.kind==="input"&&typeof args.value!=="string")||(prompt.kind==="confirm"&&typeof args.value!=="boolean")))throw Error("插件提示回复无效。");
      prompt.finish(args.value,args.cancelled===true);return {answered:true};
    }
    if (["extension.commands", "extension.command", "extension.reload"].includes(name)) {
      if (active || management) throw Error("当前任务或设置尚未结束；插件操作不自动排队。");
      const {sessionId, input} = args;
      management = true;
      const command = {sessionId, abort: new AbortController()};
      extensionCommand = command;
      emit();
      command.finished = (async () => {
        // Serialize holder acquisition with close/archive/fork. Do not hold the
        // selection queue while a plugin waits for the user's response.
        const rt = await writeSelection(() => extensionRuntime(sessionId));
        if(shuttingDown || command.abort.signal.aborted) throw Error("宿主正在退出；插件操作未执行。");
        await rt.bindUI();
        if(shuttingDown || command.abort.signal.aborted) throw Error("宿主正在退出；插件操作未执行。");
        if (name === "extension.commands") {
          return rt.commands().filter(c => !c.source?.includes?.("inline:cothink"))
            .map(c => ({name: c.name, description: c.description ?? ""}));
        }
        if (name === "extension.reload") {
          for (const [key, status] of extensionStatuses)
            if (status.sessionId === sessionId) extensionStatuses.delete(key);
          await rt.session.reload();
        } else {
          if (typeof input !== "string" || !/^\/[^\s]+(?:[ \t][^\n]*)?$/.test(input))
            throw Error("请输入单条插件命令。");
          await rt.dispatchCommand(input);
        }
        return {completed: true};
      })();
      try { return await command.finished; }
      finally {
        cancelExtensionPrompts(sessionId);
        extensionCommand = null;
        management = false;
        emit();
      }
    }
    if (name === "updates.check" || name === "updates.configure") {
      if (installation === "desktop") return updateSnapshot();
      const allowed=name === "updates.check" ? ["manual"] : ["automatic"];
      if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some(key=>!allowed.includes(key))) throw Error("更新操作参数无效。");
      if (name === "updates.configure") {
        if(typeof args.automatic !== "boolean") throw Error("自动检查设置必须是布尔值。");
        updates.setAutomatic(args.automatic);
      } else {
        if(args.manual !== undefined && typeof args.manual !== "boolean") throw Error("检查方式必须是布尔值。");
        await updates.check({manual:args.manual ?? true});
      }
      return updateSnapshot();
    }
    if (name === "releaseNotes.ack") {
      const { version } = releaseNotes();
      if (args.version !== version)
        throw Error("只能确认当前安装版本的更新摘要。");
      markReleaseNotesSeen(home, version);
      emit();
      return { version, unread: false };
    }
    if (name === "task.submit") return submit(args);
    if (name === "task.confirmWork") return confirmWork(args);
    if (name === "task.continuePrepared") return continuePrepared(args);
    if (name === "session.mode") throw Error("统一会话已移除模式切换；旧 CLI 会话保留原模式。");
    if (name === "task.cancel") {
      if (active?.taskId === args.taskId) {
        cancelExtensionPrompts(active.sessionId);
        active.abort.abort();
        await live.get(args.taskId)?.cancel();
        if(active?.origin==='context.organize')await active.promise;
      } else rawTask(args.taskId);
      emit();
      return { taskId: args.taskId };
    }
    if (name === "task.reveal")
      return revealGuiTask(rawTask(args.taskId).record);
    if (name === "project.inspect") {
      if (args.purpose==="directory") {
        const basic=inspectGuiDirectory(args.path);
        return {...basic,path:basic.canonicalPath,valid:basic.directoryAvailable,executionReady:null,error:basic.reason};
      }
      if (args.purpose!==undefined && args.purpose!=="execution") throw Error("目录检查用途无效。");
      return inspectGuiProject(home,args.path,loadConfig(home)?.work);
    }
    if (name === "project.browse") return browseProjectFolders(args.path);
    if (name === "project.mkdir") return makeProjectFolder(args);
    if (name === "project.prepare") {
      const prepared=await prepareGuiProject(home,args);
      if (["confirm","finish"].includes(args.action)) emit();
      return prepared;
    }
    if (name === "workspace.rebind.query") return queryGuiWorkspaceRebind(home,args);
    if (["workspace.create","workspace.update","workspace.bind","workspace.rebind"].includes(name))
      return manageWorkspace(name,args);
    if (name === "session.view") {
      const {sessionId,expectedViewRevision,opened,anchor,seen} = args;
      const fields = ["sessionId","expectedViewRevision","opened","anchor","seen"];
      if (Object.keys(args).some(key => !fields.includes(key)) || !isWorkspaceId(sessionId) ||
          !Number.isSafeInteger(expectedViewRevision) || expectedViewRevision < 0 ||
          opened !== undefined && opened !== true || opened === undefined && anchor === undefined && seen === undefined ||
          anchor != null && (Object.keys(anchor).length !== 3 || !isWorkspaceId(anchor.taskId) ||
            !["input","result"].includes(anchor.part) || !Number.isFinite(anchor.offsetPx) || anchor.offsetPx < 0 || anchor.offsetPx > 2048) ||
          seen !== undefined && (!seen || Object.keys(seen).length !== 2 || !isWorkspaceId(seen.taskId) ||
            typeof seen.resultRevision !== "string" || !/^[a-f0-9]{64}$/.test(seen.resultRevision)))
        throw Error("阅读状态参数无效。");
      const readable = await session(sessionId,{recoverNewView:false});
      if (readable.navigationError || !readable.view)
        throw sessionStateError("SESSION_STATE_UNAVAILABLE",readable.navigationError ?? readable.selectionError);
      if (anchor && !readable.turns.some(turn => turn.taskId === anchor.taskId &&
          (anchor.part === "input" || turn.resultRevision)))
        throw sessionStateError("VIEW_CONFLICT","阅读位置已不在当前分支，请刷新后重新定位。");
      if (seen && !readable.turns.some(turn => turn.taskId === seen.taskId && turn.resultRevision === seen.resultRevision))
        throw sessionStateError("VIEW_CONFLICT","所见结果已变化，请刷新后阅读当前版本。");
      const saved = writeSessionViewState(home,{sessionId,expectedViewRevision,opened,anchor,seen,
        baseline:readable.view.initialized ? {} : readable.view.seenResults});
      emit();
      return {sessionId,viewRevision:saved.viewRevision,view:saved.view};
    }
    if (["session.archive", "session.pin", "session.close"].includes(name)) {
      return writeSelection(async () => {
        const id = args.sessionId;
        if ((name !== "session.pin") && (active?.sessionId === id || extensionCommand?.sessionId === id))
          throw sessionStateError("SESSION_BUSY", "此对话正在执行任务，请等待或明确停止后再操作。");
        const readable = await session(id);
        if (readable.selectionError) throw sessionStateError("SESSION_STATE_UNAVAILABLE", readable.selectionError);
        if (name === "session.close") {
          if (readable.persisted || taskIndex().errors.length || taskRecords().some(t=>t.sessionId===id))
            throw sessionStateError("SESSION_STATE_UNAVAILABLE", "已有历史的对话请归档，不能关闭空白页。");
          if (readable.draft?.trim()) throw sessionStateError("SESSION_NOT_PERSISTED", "未发送草稿仍在，请先保留或清空草稿再关闭空白页。");
        } else if (!readable.persisted)
          throw sessionStateError("SESSION_NOT_PERSISTED", "此页尚无持久历史，不能归档或置顶；草稿保留，空白页可直接关闭。");
        let holder;
        try { holder = await owner(id); }
        catch (e) { if (sessionWriterBusy(join(home,"pi"),id) && !holders.has(id)) throw sessionStateError("SESSION_BUSY","此对话正被另一窗口占用，请先关闭该窗口。"); throw e; }
        holder.assertOwned();
        if (name !== "session.pin" && (active?.sessionId === id || extensionCommand?.sessionId === id)) throw sessionStateError("SESSION_BUSY", "此对话正在执行任务，请结束后再操作。");
        if (name === "session.close") { await releaseHolder(id); emit(); return {sessionId:id,closed:true}; }
        const field = name === "session.archive" ? "archived" : "pinned";
        const navigation = writeSessionUiState(home,{sessionId:id, expectedRevision:args.expectedRevision,[field]:args[field]},holder.assertOwned);
        let releaseError = null;
        if (navigation.archived) {
          try { await releaseHolder(id); } catch (e) { releaseError = "归档已保存，但释放占用未完成：" + e.message; }
        }
        emit();
        return {sessionId:id,navigation,releaseError};
      });
    }
    if (name === "session.fork") {
      if (!args || typeof args !== "object" || Array.isArray(args) ||
          Object.keys(args).some(key => !["sessionId", "taskId"].includes(key)) ||
          ![args.sessionId, args.taskId].every(id => typeof id === "string" && /^[0-9a-f-]{36}$/.test(id)))
        throw Error("分支参数无效。");
      return writeSelection(async () => {
        const {sessionId, taskId} = args;
        const assertIdle = () => {
          if (active?.sessionId === sessionId || extensionCommand?.sessionId === sessionId)
            throw sessionStateError("SESSION_BUSY", "此对话正在执行任务，请等待或明确停止后再新建分支。");
        };
        assertIdle();
        assertSessionUnarchived(sessionId);
        const readable = await session(sessionId);
        if (readable.selectionError || readable.navigationError)
          throw Error(readable.selectionError || readable.navigationError);
        const turn = readable.turns.find(turn => turn.taskId === taskId);
        if (!turn) throw Error("这条回复不属于当前会话分支。");
        if (!turn.canFork) throw Error("只能从已完成且保存完整的回复新建分支。");
        const sourceInfo = (await summaries()).find(info => info.id === sessionId);
        if (!sourceInfo || sessionEntries(sourceInfo.path)[0]?.version !== CURRENT_SESSION_VERSION)
          throw Error("此会话的 Pi 历史版本需要先明确迁移，当前分支操作不会改写原记录。");
        let source;
        try { source = await owner(sessionId,{mutating:true}); }
        catch (error) {
          if (!holders.has(sessionId) && sessionWriterBusy(join(home, "pi"), sessionId))
            throw sessionStateError("SESSION_BUSY", "此对话正被另一窗口占用，请先关闭该窗口。");
          throw error;
        }
        await assertWorkspaceWritable(source.sessionManager);
        assertIdle();
        source.assertOwned();
        const branch = source.sessionManager.getBranch();
        const endpoint = branch.findLast(entry => entry.type === "custom_message" &&
          entry.customType === "cothink-task-status" && entry.details?.taskId === taskId);
        if (!endpoint) throw Error("回复终点记录缺失，请修复历史后再新建分支。");
        // A separate Pi reader extracts the selected root-to-reply path into a new
        // session file. Never change the live source's leaf or copy its later turns.
        const manager = SessionManager.open(source.sessionManager.getSessionFile());
        const inherited = SessionManager.inMemory(manager.getCwd(),undefined,
          [manager.getHeader(),...branch.slice(0,branch.indexOf(endpoint)+1)]);
        const membership = await assertWorkspaceWritable(inherited);
        assertIdle();
        source.assertOwned();
        manager.createBranchedSession(endpoint.id);
        const id = manager.getSessionId(), writer = acquireSessionWriter(join(home, "pi"), id);
        const holder = {sessionManager:manager, persisted:true, writer, assertOwned:writer.assertOwned};
        holders.set(id, holder);
        try {
          appendConversationEntry(holder, "cothink-fork", {sessionId, taskId});
          if (readSessionWorkspace(manager) === undefined)
            appendConversationEntry(holder,"cothink-gui-workspace",{workspaceId:membership.workspaceId});
          appendConversationEntry(holder, "cothink-title", {title:`${readable.title} · 分支`});
          // Historical drafts are not messages, and belong to the source editor.
          appendConversationEntry(holder, "cothink-draft", {text:""});
          const ids = new Set(conversationTaskIds(manager));
          try {
            initializeSessionView(home,{sessionId:id,seenResults:eligibleResults(taskRecords().filter(record => ids.has(record.id)))});
          } catch { /* The saved fork has an identifiable empty-baseline fallback. */ }
          emit();
          return await session(id);
        } catch (error) {
          await releaseHolder(id);
          emit(); // Preserve any written branch for inspection, never retry it.
          throw error;
        }
      });
    }
    if (name === "session.create") {
      return writeSelection(async () => {
        const modern = Object.hasOwn(args,"workspaceId");
        if (Object.keys(args).some(key => !["sessionId","workspaceId","project","sourceSessionId","sourceLeafId","homeDraftId"].includes(key)) ||
            modern && Object.hasOwn(args,"project") || modern && !isWorkspaceId(args.sessionId) ||
            args.sessionId !== undefined && !isWorkspaceId(args.sessionId) ||
            modern && args.workspaceId !== null && !isWorkspaceId(args.workspaceId) ||
            (args.sourceSessionId!==undefined || args.sourceLeafId!==undefined) &&
              (!modern || !isWorkspaceId(args.sourceSessionId) || typeof args.sourceLeafId!=="string") ||
            args.homeDraftId!==undefined && (!modern || !isWorkspaceId(args.homeDraftId) || args.sourceSessionId!==undefined)) throw Error("新对话参数无效，请刷新页面。");
        const id = args.sessionId ?? randomUUID();
        if (holders.has(id)) throw sessionStateError("SESSION_STATE_CONFLICT","会话 ID 已存在，请读取原 ID；本次未创建。");
        const writer = acquireSessionWriter(join(home,"pi"),id);
        let holder;
        try {
          assertNewGuiSessionId(directory,id);
          let workspace = null, project = null;
          if (modern) {
            if (args.workspaceId !== null) {
              const table = discoverWorkspaces(await summaries());
              workspace = table.workspaces.find(w => w.id === args.workspaceId);
              if (!workspace) throw workspaceError("WORKSPACE_UNAVAILABLE","Team 不存在，请刷新列表。");
              project = workspace.project;
            }
          } else {
            project = args.project == null ? null : await inspectWorkspaceProject(args.project);
            if (project !== null) {
              const table=discoverWorkspaces(await summaries());
              workspace=workspaceForProject(table,project);
              if (!workspace) {
                const config=loadConfig(home), recent=config?.teams?.find(t=>t.id===config.lastUsedTeamId);
                workspace=createGuiWorkspace(home,{workspaceId:randomUUID(),name:[...(basename(project).trim() || project)].slice(0,80).join(""),
                  project,defaultRosterId:recent?.id ?? null});
              }
            }
          }
          if (workspace?.archived) throw workspaceError("WORKSPACE_ARCHIVED","此 Team 已归档，请先恢复。",workspace);
          const manager = SessionManager.create(neutralDirectory(home),directory,{id});
          holder = {sessionManager:manager,writer,assertOwned:writer.assertOwned};
          appendConversationEntry(holder,"cothink-project",{project});
          appendConversationEntry(holder,"cothink-gui-workspace",{workspaceId:workspace?.id ?? null});
          appendConversationEntry(holder,"cothink-flow",{flow:"unified",version:unifiedProtocol});
          if(args.homeDraftId){
            const homeDraft=readHomeDraft(home);
            if(homeDraft?.draftId!==args.homeDraftId||homeDraft.pendingCreateSessionId!==id||homeDraft.targetWorkspaceId!==args.workspaceId)
              throw sessionStateError("DRAFT_CONFLICT","首页待创建身份已改变。");
            appendConversationEntry(holder,"cothink-home-origin",{draftId:args.homeDraftId});
          }
          const config = loadConfig(home);
          let catalog;
          const rosterFor=id=>usableRoster(id,config,()=>catalog??=createModelRuntime(home));
          let roster, reason;
          const defaultId=workspace?.defaultRosterId;
          if(defaultId!=null){
            roster=await rosterFor(defaultId);
            if(!roster)reason="原默认阵容已不可用，请选择现有阵容。";
          } else if(args.sourceSessionId) {
            try {
              const source=await reader(args.sourceSessionId);
              const info=(await summaries()).find(row=>row.id===args.sourceSessionId);
              if(!info)throw Error("来源未保存");
              const disk=readContextDisk(info.path,args.sourceSessionId);
              if(source.getLeafId()!==args.sourceLeafId || disk.getLeafId()!==args.sourceLeafId) throw Error("来源分支已变化");
              const saved=readSessionTeam(disk.getBranch());
              if(saved){
                const current=await rosterFor(saved.id);
                if(!current || contextDigest(current)!==contextDigest(saved)) throw Error("来源阵容已变化");
                roster=saved;
              }
            } catch {
              reason="来源对话的分支或阵容已变化，请明确选择阵容。";
            }
          }
          if(!roster&&!reason)roster=await rosterFor(config?.lastUsedTeamId);
          if (roster) saveSessionTeam(holder,roster);
          else appendConversationEntry(holder,"cothink-roster-required",{reason:reason??"没有可用阵容，请选择或新建阵容。"});
          holder.sessionManager = persistNewGuiSession({manager,directory,assertOwned:()=>{
            writer.assertOwned();
            if (workspace) {
              const latest=readGuiWorkspaces(home).workspaces.find(w=>w.id===workspace.id);
              if (!latest || latest.revision !== workspace.revision || latest.archived)
                throw workspaceError("WORKSPACE_CONFLICT","Team 已变化，请重新读取后创建对话。",latest);
            }
          }});
          holder.persisted=true;
          holders.set(id,holder);
          // View failure is reported separately by session(); Pi success survives.
          emit();
          return await session(id);
        } catch(error) {
          if (holders.get(id) === holder) holders.delete(id);
          writer.release();
          emit();
          throw error;
        }
      });
    }
    if (
      [
        "session.name",
        "session.draft",
        "session.mode",
        "session.team",
        "session.thinking",
      ].includes(name)
    ) {
      const switchingTeam = name === "session.team";
      if (switchingTeam) {
        if (active || management)
          throw Error("当前任务或设置尚未结束，请先取消或等待。");
        management = true;
      }
      try {
        return await writeSelection(async () => {
          assertSessionUnarchived(args.sessionId);
          const holder = await owner(args.sessionId,{mutating:true}),
            target = holder.runtime ?? holder;
          await assertWorkspaceWritable(holder.sessionManager);
          assertSessionUnarchived(args.sessionId);
          if (name === "session.name") {
            if (
              typeof args.title !== "string" ||
              !args.title.trim() ||
              args.title.length > 200
            )
              throw Error("标题需要 1—200 字符。");
            appendConversationEntry(target, "cothink-title", {
              title: args.title.trim(),
            });
          }
          if (name === "session.draft") {
            const required=["expectedDraftRevision","branchAnchor","editId","text","workRequest","selectionId"];
            if (required.some(key=>!Object.hasOwn(args,key)) || typeof args.text !== "string" || !isWorkspaceId(args.editId) ||
                !(args.expectedDraftRevision === null || typeof args.expectedDraftRevision === "string") ||
                !(args.branchAnchor === null || typeof args.branchAnchor === "string") ||
                (args.workRequest === null ? args.selectionId !== null :
                  !args.workRequest || args.workRequest.kind !== "html-svg" || Object.keys(args.workRequest).length !== 1 || !isWorkspaceId(args.selectionId)))
              throw sessionStateError("DRAFT_CONFLICT","草稿版本或完整编辑快照缺失，请刷新后核对；本机草稿保留。");
            const manager=holder.sessionManager, meta=readConversationMetadata(manager), branch=manager.getBranch();
            if ((args.branchAnchor === null ? branch.length !== 0 : !branch.some(e=>e.id===args.branchAnchor)) ||
                meta.draftRevision !== args.expectedDraftRevision)
              throw sessionStateError("DRAFT_CONFLICT","草稿或所见分支已变化；本机草稿保留，请读取保存稿后明确选择。");
            if(meta.editor.turnOptions!==undefined && !Object.hasOwn(args,'turnOptions'))throw sessionStateError('DRAFT_CONFLICT','完整草稿必须保留本条约束与预算选项。');
            const turnOptions=validateEditorTurnOptions(args.turnOptions);
            if(turnOptions?.readAllowed){
              const membership=await assertWorkspaceWritable(manager);
              if(turnOptions.readProject!==readSessionProject(manager)||turnOptions.readWorkspaceId!==(membership.workspaceId??null))throw sessionStateError('DRAFT_CONFLICT','读取选择属于其他目录或 Team，请重新确认。');
            }
            if(meta.editor.materials.length&&!Object.hasOwn(args,"materials"))
              throw sessionStateError("DRAFT_CONFLICT","完整草稿必须保留材料；本次未覆盖。");
            const editor=normalizeConversationEditor({
              editorVersion:args.editorVersion??2,materials:args.materials,
              ...(Object.hasOwn(args,'turnOptions')?{turnOptions}:{}),
              text:args.text,workRequest:args.workRequest,selectionId:args.selectionId,editId:args.editId,
            });
            const resolved=resolveEditorMaterials(args.sessionId,editor.materials,manager);
            saveGuiDraft(target,editor);
            for(const {manifest} of resolved)materials.acknowledge(manifest);
          }
          if (name === "session.mode") {
            if (!["one", "cothink"].includes(args.mode))
              throw Error("模式无效");
            saveSessionMode(target, args.mode === "one");
          }
          if (name === "session.team") {
            const config = loadConfig(home),
              team = config?.teams?.find((t) => t.id === args.teamId);
            if (!team) throw Error("Team 不存在。");
            if (holder.runtime)
              await selectConversationTeam({
                home,
                owner: holder.runtime,
                team,
              });
            else {
              saveSessionTeam(target, team);
              rememberRecentTeam(home, team);
            }
          }
          if (name === "session.thinking") {
            const team = readSessionTeam(holder.sessionManager.getBranch());
            if (!team) throw Error("请先绑定 Team。");
            await validateGuiThinking(home, team, args.level);
            appendConversationEntry(target, "cothink-thinking", {
              level: args.level,
            });
          }
          emit();
          const saved=await session(args.sessionId);
          return name === "session.draft" ? {...saved,sessionId:args.sessionId} : saved;
        });
      } finally {
        if (switchingTeam) management = false;
      }
    }

    if (
      ["team.save", "team.remove", "provider.save", "settings.work", "settings.builtinSkills", "settings.localSkills"].includes(
        name,
      )
    ) {
      if (active || management)
        throw Error("当前任务或设置尚未结束，请先取消或等待。");
      management = true;
      try {
        let result;
        if (name === "team.save")
          result = publicTeam(await saveGuiTeam(home, args));
        if (name === "team.remove") {
          const manager = await reader(args.sessionId);
          removeGuiTeam(
            home,
            args.teamId,
            readSessionTeam(manager.getBranch()),
          );
          result = { removed: true };
        }
        if (name === "provider.save") {
          result = await saveGuiProvider(home, args);
          await refreshLoadedCatalogs();
          authRefreshError=null;
        }
        if (name === "settings.work") result = saveGuiWork(home, args.work);
        if (name === "settings.localSkills") result = await saveGuiLocalSkills(home,args.paths,{cwd:neutralDirectory(home)});
        if (name === "settings.builtinSkills") {
          if(Object.keys(args).some(k=>k!=='builtinSkills'))throw Error('内置技能设置参数无效。');
          result=saveGuiBuiltinSkills(home,args.builtinSkills);
        }
        emit();
        return result;
      } finally {
        management = false;
      }
    }
    throw Error("未知 action。");
  }
  function shutdownState() {
    const taskRefs = [...live.values()].filter(task => {
      const status=taskDisplayStatus(task.record);
      return task.recovery || ["running","preparing","cancelling","stop_unknown"].includes(status);
    }).map(task=>task.record.id);
    if(active && !taskRefs.includes(active.taskId)) taskRefs.push(active.taskId);
    const authPending=oauthBusy();
    return {requested:shuttingDown, settled:shuttingDown && !drainPromise && !shutdownError && !management &&
      !authPending && !executionInspection && !pendingProbeCleanup && !extensionCommand && !uploads.size && !taskRefs.length,
      reason:shutdownError || (taskRefs.length ? "任务停止尚未确认，请核对已保存状态。" :
        authPending ? "认证操作仍在收尾。" : executionInspection ? "执行检查仍在收尾。" :
        pendingProbeCleanup ? "执行探针清理尚未确认。" : management ? "设置仍在保存。" : null), taskRefs};
  }
  function beginShutdown() {
    shuttingDown = true;
    if (drainPromise) return drainPromise.then(shutdownState);
    shutdownError = null;
    const state=active, command=extensionCommand;
    state?.abort.abort(); command?.abort.abort(); cancelExtensionPrompts();
    const settingsDrain=Promise.allSettled([oauth.close(),executionInspection]);
    for(const request of uploads)request.abort.abort();
    drainPromise=(async()=>{
      try {
        // Stop owned executions before releasing their writers or HTTP observers.
        await live.get(state?.taskId)?.cancel();
        await state?.promise;
        try { await command?.finished; } catch { /* Its original error remains in task/runtime state. */ }
        await Promise.allSettled([...uploads].map(request=>request.promise));
        const [auth]=await settingsDrain;
        // OAuth completion can enqueue a refresh when it publishes the final
        // credential state, including a write confirmed during cancellation.
        await authRefresh;
        await selectionWrite;
        if(auth.status==="rejected")throw auth.reason;
        if(pendingProbeCleanup){
          if(!pendingProbeCleanup.retry)throw Error("执行探针清理尚未确认。");
          await pendingProbeCleanup.retry();
          pendingProbeCleanup=null;
        }
      } catch(error) { shutdownError=safe(error.message); }
    })().finally(()=>{drainPromise=null;emit();});
    emit();
    return drainPromise.then(shutdownState);
  }
  async function close() {
    if (closed) return;
    const state=await beginShutdown();
    if (!state.settled) throw Object.assign(Error(state.reason || "宿主停止尚未确认。"),{code:"SHUTDOWN_UNSETTLED"});
    // A failed dispose keeps the remaining holders and read API available.
    try { for (const id of [...holders.keys()]) await releaseHolder(id); }
    catch(error) {shutdownError=safe(error.message);emit();throw error;}
    closed = true;
    unsubscribeUpdates(); updates.close(); listeners.clear();
  }
  const wrap =
    (fn) =>
    async (...args) => {
      try {
        return safe(await fn(...args));
      } catch (error) {
        const secrets = [
          ...secretValues(home),
          ...(args[1]?.apiKey ? [args[1].apiKey] : []),
        ];
        throw Object.assign(new Error(redact(error.message, secrets)), {
          code: error.code,
          ...(error.workspace && {workspace:redact(error.workspace,secrets)}),
        });
      }
    };
  return {
    organizeContext:wrap(organizeContext),
    readContextOperation:wrap(readContextOperation),
    bootstrap: wrap(bootstrap),
    getSessionCapabilities:wrap(getSessionCapabilities),
    materialQuery:wrap(materialQuery),materialUpload:wrap(materialUpload),
    projectMaterialPreview:async args=>{
      try {const result=await readProjectMaterial(args);return result;}
      catch(error){throw Object.assign(Error(safe(error.message)),{code:error.code});}
    },
    materialRead:async args=>{
      try {const {manifest,bytes}=await materialRead(args);return {manifest:safe(manifest),bytes};}
      catch(error){throw Object.assign(Error(safe(error.message)),{code:error.code});}
    },
    checkForUpdates,
    session: wrap(session),
    sessionCreation: wrap(sessionCreation),
    sessions: wrap(sessions),
    task: wrap(async (id) => {
      const t = rawTask(id);
      const files = [
        ...new Set(
          t.record.stages.map((stage) => stage.sessionFile).filter(Boolean),
        ),
      ];
      const entries = files.flatMap((path) => {
        try {
          return readFileSync(path, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line));
        } catch {
          return [];
        }
      });
      const p = projectGuiTask(t.record, t.requests(), entries);
      p.finalText=finalGuiText(t.record,t.requests(),home);p.proposal=t.record.proposal;p.proposalRef=t.record.proposalRef;p.flow=t.record.flow;
      if(t.record.flow==='unified'){
        const delivered=t.record.deliveryRef?resolveDelivery(home,t.record):[];
        const ids=[...new Set([...(t.record.projectOperation?.childTaskIds??[]),...delivered.map(x=>x.record.id)])];
        p.executionTasks=ids.map(childId=>{
          const child=readTask(home,childId),inherited=delivered.some(x=>x.record.id===childId&&x.relation==='inherited');
          if(!inherited&&(child.rootTaskId!==t.record.id||child.project?.commandId!==t.record.projectOperation.commandId))throw Error('执行来源归属不符');
          const childEntries=[...new Set(child.stages.map(s=>s.sessionFile).filter(Boolean))].flatMap(path=>{try{return readFileSync(path,'utf8').split('\n').filter(Boolean).map(JSON.parse);}catch{return [];}});
          return {...projectGuiTask(child,readRequests(home,child),childEntries),relation:inherited?'inherited':'owned',rootTaskId:child.rootTaskId,stepId:child.project.stepId};
        });
      }

      if(t.record.flow==="unified")p.usage=rootUsage(home,t.record);
      if (t.record.flow!=="unified" && active?.taskId === id && live.has(id)) p.usage = t.usage();
      return p;
    }),
    action: wrap(action),
    diff: wrap((id) => guiDiff(home, rawTask(id).record)),
    files: wrap(files),
    fileDiff: wrap(ref => guiFileDiff(home,rawTask(ref.taskId).record,ref)),
    file: async (ref,options) => {
      try { const result=await guiFile(home,rawTask(ref.taskId).record,ref,options);
        const {bytes,...metadata}=result; return {...safe(metadata),bytes};
      } catch(error) {throw Object.assign(Error(safe(error.message)),{code:error.code});}
    },
    output: wrap((id, ref, offset, limit) =>
      guiOutput(home, rawTask(id).record, ref, offset, limit),
    ),
    artifact: async (id,ref,index) => {
      try { return guiArtifact(home,rawTask(id).record,ref,index); }
      catch(error) { throw Error(safe(error.message)); }
    },
    patch: wrap(async (id) => (await guiDiff(home, rawTask(id).record)).text),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    beginShutdown: wrap(beginShutdown),
    shutdownState,
    close,
  };
}
