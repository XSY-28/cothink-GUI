import {
  createGuiWorkspace, importGuiWorkspaceProjects, isWorkspaceId, isWorkspaceProject,
  readGuiWorkspaces, updateGuiWorkspace, workspaceError, workspaceForProject,
} from "./gui-workspace-state.js";
import {persistNewGuiSession, assertNewGuiSessionId} from "./gui-session-persistence.js";
import {guiFiles, guiFile, guiFileDiff} from "./gui-files.js";
import {readSessionUiState, writeSessionUiState, writeSessionViewState, initializeSessionView, sessionStateError} from "./session-ui-state.js";
import {createUpdateService, formatUpdateStatus, updateInstructions} from "./updates.js";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { SessionManager, CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { readSessionTeam, resolveTeamConfig } from "./teams.js";
import {
  createModelRuntime,
  createRuntime,
  selectedResources,
  secretValues,
} from "./pi-runtime.js";
import { runTurn } from "./discussion.js";
import { cothinkExtension } from "./extensions/cothink.js";
import { readTask, readRequests, taskDisplayStatus } from "./task.js";
import {
  acquireSessionWriter,
  sessionWriterBusy,
  privateDirectory,
  redact,
  releaseNotesSeen,
  markReleaseNotesSeen,
} from "./storage.js";
import { validateModelThinking } from "./thinking.js";
import { isGenerationCommand, parseTurnInput, singleLineCommand } from "./setup.js";
import { releaseNotes } from "./presentation.js";
import {
  appendConversationEntry,
  readSessionMode,
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
} from "./conversation.js";
import { publicTeam, projectGuiTask, finalGuiText, guiResultRevision } from "./gui-projection.js";
import {
  saveGuiTeam,
  removeGuiTeam,
  saveGuiWork,
  saveGuiProvider,
  validateGuiThinking,
} from "./gui-settings.js";
import {
  inspectGuiProject,
  guiDiff,
  guiOutput,
  guiArtifact,
  revealGuiTask,
} from "./gui-work.js";

/** Local host adapter. Pi sessions and task records remain the sources of conversation and execution facts. */
export async function createGuiController({ home, cwd = process.cwd(), updateService }) {
  const directory = join(home, "pi/sessions/main");
  privateDirectory(directory);
  const holders = new Map(),
    listeners = new Set(),
    live = new Map();
  let active = null,
    closed = false,
    management = false;
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
  const updateSnapshot=()=>{const s=updates.snapshot();return {...s,message:formatUpdateStatus(s),instructions:updateInstructions(s)};};
  const checkForUpdates=()=>updates.check();
  // Disposable summaries: stat every dependency, parse only changed durable bytes.
  // No request bodies, reviewer text or second persisted conversation store.
  const taskCache = new Map(), sessionCache = new Map(), fileListCache = new Map();
  async function files(id) {
    const record=rawTask(id).record;
    const key=JSON.stringify(record.work ?? null);
    const previous=fileListCache.get(id);
    if(previous?.key===key)return previous.value;
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
      if (!cached || cached.stamp !== stamp || JSON.stringify(dependencies(cached.requestIds)) !== cached.dependencies) {
        cached = {stamp, requestIds: [], dependencies: "[]"};
        try {
          const record = readTask(home, id);
          if (!Array.isArray(record.requestIds) || record.requestIds.some(r=>typeof r !== "string" || !/^[0-9a-f-]{36}$/.test(r)) || typeof record.input !== "string" || typeof record.createdAt !== "string") throw Error("task summary");
          cached.requestIds = record.requestIds;
          cached.value = {id: record.id, sessionId: record.sessionId, submissionId: record.submissionId,
            createdAt: record.createdAt, input: record.input, status: taskDisplayStatus(record),
            singleModel: record.singleModel, hasWork: !!record.work, finalText: ""};
          try {
            cached.value.finalText = finalGuiText(record, readRequests(home, record));
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
      return {marker:readSessionWorkspace(manager), project, forkOf,
        branched: !!forkOf || !!manager.getHeader()?.parentSession};
    } catch (error) {
      return {project, associationError:error.message};
    }
  }
  function projectMembership(facts, table) {
    const {marker, project, associationError} = facts ?? {};
    const unknown = (message = "会话的 Team 归属无法确认；原记录保留。") => ({workspaceError:message});
    if (!facts || associationError) return unknown(associationError);
    if (marker === null) return project === null ? {workspaceId:null, workspaceArchived:false} : unknown();
    if (marker === undefined && project === null) return {workspaceId:null, workspaceArchived:false};
    const workspace = table && (marker === undefined ? workspaceForProject(table,project) :
      table.workspaces.find(w => w.id === marker));
    // Binding a previously unbound Team leaves its existing neutral conversations neutral.
    if (!workspace || (project !== null && !workspaceForProject({workspaces:[workspace]},project))) return unknown();
    return {workspaceId:workspace.id, workspaceArchived:workspace.archived};
  }
  function discoverWorkspaces(infos) {
    return importGuiWorkspaceProjects(home, infos.flatMap(info => {
      const branch = info.branch;
      return !info.error && branch && !branch.associationError && branch.marker === undefined && branch.project !== null
        ? [branch.project] : [];
    }));
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
    const project = await inspectGuiProject(home,path,work);
    return project.valid && !project.error && !!workspaceForProject({workspaces:[{project:path}]},project.path);
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
          } catch { cached.error = "会话历史损坏或不可用；原文件保留，请修复后重新打开。"; }
        } catch { /* Unidentifiable headers cannot become selectable IDs. */ }
        sessionCache.set(path, cached);
      }
      if (cached.info) result.push({...cached.info, branch: cached.branch, error: cached.error});
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
        if (workspaceFacts(disk).associationError) return disk;
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
  function runtime(id, holder, effective) {
    if (holder.runtime) return Promise.resolve(holder.runtime);
    if (holder.opening) return holder.opening;
    holder.opening = (async () => {
      const manager = holder.sessionManager,
        project = readSessionProject(manager),
        host = { allowWork: project !== null };
      holder.writer.release();
      holder.writer = null;
      try {
        const rt = await createRuntime({
          home,
          cwd: conversationCwd(manager, home),
          sessionManager: manager,
          modelRef: effective.main,
          uiContext:extensionUI(id),
          extensionFactories: [
            { name: "cothink", factory: cothinkExtension(host) },
          ],
          resourceOptions: {
            ...selectedResources(effective, conversationCwd(manager, home)),
            systemPrompt: readFileSync(
              new URL("../prompts/main.md", import.meta.url),
              "utf8",
            ),
            ...(project === null ? { noContextFiles: true } : {}),
          },
          ...(project === null ? { activeToolNames: [] } : {}),
        });
        rt.hostContext = (task) => {
          host.task = task;
          host.runtime = rt;
        };
        rt.effectiveConfig = effective;
        rt.singleModel = readSessionMode(manager);
        rt.needsTeam = false;
        holder.runtime = rt;
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
        const finalText = current ? finalGuiText(record,current.requests()) : record.finalText;
        return {
          taskId: record.id,
          submissionId: record.submissionId ?? null,
          input: record.input,
          status: taskDisplayStatus(record),
          hasWork: current ? !!current.record.work : !!record.hasWork,
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
      return safe({
        ...navigation, persisted: !!info,
        id,
        title: meta.title || turns[0]?.input.slice(0, 60) || "新对话",
        project: association.project ?? null,
        ...membership,
        mode: readSessionMode(manager) ? "one" : "cothink",
        team: publicTeam(readSessionTeam(manager.getBranch())),
        draft: meta.draft, editor: meta.editor, draftRevision: meta.draftRevision, branchAnchor: meta.branchAnchor,
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
      const finalText = finalGuiText(record,task.requests());
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
      const row = {id, title, project: association?.project ?? null, updatedAt: info?.modified.toISOString() ?? null,
        lastOpenedAt, persisted: !!info, readOnly: !!error || !!membership.workspaceError || !!nav.navigationError ||
          !!membership.workspaceArchived || !!nav.navigation?.archived || (!holder && sessionWriterBusy(join(home,"pi"),id)), ...membership, ...nav};
      if (needle) {
        const sources = [{text:title,taskId:null,field:"title"}, ...(!error ? turns.flatMap(t=>[
          {text:t.input,taskId:t.id,field:"input"}, {text:t.finalText,taskId:t.id,field:"finalText"}]) : [])];
        let match = sources.find(m=>m.text?.toLocaleLowerCase().includes(needle));
        if(!match&&!error) {
          for(const turn of turns) {
            try {
              const record=rawTask(turn.id).record;
              if(!record.work)continue;
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
      projectAvailable: workspace.project === null ? null : await savedProjectAvailable(workspace.project,config?.work),
    })));
    return safe({
      version: notes.version,
      extensionUI:extensionSnapshot(),
      configured: config?.formatVersion === 3,
      suggestedProject: cwd,
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
            taskId: active.taskId,
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
  async function submit(args) {
    const { sessionId, input, submissionId } = args;
    if (
      typeof submissionId !== "string" ||
      !submissionId.trim() ||
      submissionId.length > 200
    )
      throw Error("submissionId 必须是 1—200 字符。");
    const prior = taskRecords().find(
      (t) => t.sessionId === sessionId && t.submissionId === submissionId,
    );
    if (prior) return { taskId: prior.id, sessionId: prior.sessionId };
    if (taskIndex().errors.length)
      throw Error(
        "存在损坏任务记录，无法确认旧提交身份；请保留并修复记录后再提交。历史和设置仍可查看。",
      );
    if (active?.sessionId === sessionId && active.submissionId === submissionId)
      return active.ready;
    if (active || management)
      throw Error("当前任务或设置尚未结束；草稿保留，不自动排队。");
    if (
      typeof input !== "string" ||
      !input.trim() ||
      parseTurnInput(input).local
    )
      throw Error("请输入问题；模式命令请使用模式控件。");
    assertSessionUnarchived(sessionId);
    void checkForUpdates();
    let resolveReady, rejectReady;
    const ready = new Promise((yes, no) => {
      resolveReady = yes;
      rejectReady = no;
    });
    const state = {
      taskId: randomUUID(),
      sessionId,
      submissionId,
      ready,
      abort: new AbortController(),
    };
    active = state;
    state.promise = (async () => {
      try {
        const accepted = await writeSelection(async () => {
          assertSessionUnarchived(sessionId);
          const holder = await owner(sessionId,{mutating:true}),
            manager = holder.sessionManager;
          await assertWorkspaceWritable(manager,{forExecution:true});
          if (holder.runtime?.selectionError || holder.selectionError)
            throw Error(
              holder.runtime?.selectionError ?? holder.selectionError,
            );
          const config = loadConfig(home);
          if (config?.formatVersion !== 3) throw Error("请先配置具名 Team。");
          if (!readSessionTeam(manager.getBranch()))
            throw Error("此历史会话尚未绑定 Team，请明确选择。");
          const snapshot = {
            config: resolveConversationConfig(config, manager).config,
            singleModel: readSessionMode(manager),
            cwd: conversationCwd(manager, home),
            allowWork: readSessionProject(manager) !== null,
          };
          const thinking = readConversationMetadata(manager).thinking;
          if (thinking !== undefined)
            snapshot.config.main.thinkingLevel = thinking;
          // Publish the initialization promise before allowing later selection writes.
          return {
            snapshot,
            opening: runtime(sessionId, holder, snapshot.config),
          };
        });
        const { snapshot } = accepted,
          rt = await accepted.opening;
        if (closed) throw Error("宿主已关闭。");
        if (rt.selectionError) throw Error(rt.selectionError);
        const command = singleLineCommand(input);
        if (command && command[1] !== "one" && !isGenerationCommand(command[1], rt))
          throw Object.assign(Error("本地或未知命令未发送给模型，请从插件命令列表确认。"), {code: "EXTENSION_COMMAND"});
        await runTurn({
          home,
          cwd: snapshot.cwd,
          input,
          workRequest: args.workRequest,
          config: snapshot.config,
          singleModel: snapshot.singleModel,
          mainRuntime: rt,
          allowWork: snapshot.allowWork,
          id: state.taskId,
          submissionId,
          signal: state.abort.signal,
          onProgress: (event) => {
            live.set(event.task.record.id, event.task);
            resolveReady({ taskId: event.task.record.id, sessionId });
            emit();
          },
        });
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
  async function inspectWorkspaceProject(path) {
    const project = await inspectGuiProject(home,path,loadConfig(home)?.work);
    if (!project.valid || project.error) throw Error(project.error);
    return project.path;
  }
  function validateWorkspaceRoster(id) {
    if (id !== null && !loadConfig(home)?.teams?.some(team => team.id === id))
      throw Error("默认阵容不存在，请重新选择或留空。");
  }
  async function manageWorkspace(name,args) {
    const keys = name === "workspace.create" ? ["workspaceId","name","project","defaultRosterId"] :
      name === "workspace.bind" ? ["workspaceId","expectedRevision","path"] : ["workspaceId","expectedRevision","change"];
    if (!args || Object.keys(args).length !== keys.length || !keys.every(key => Object.hasOwn(args,key)) ||
        !isWorkspaceId(args.workspaceId))
      throw Error("项目 Team 参数无效。");
    return writeSelection(async () => {
      const infos = await summaries(), table = discoverWorkspaces(infos);
      const current = table.workspaces.find(w => w.id === args.workspaceId);
      let result;
      if (name === "workspace.create") {
        if (current) throw workspaceError("WORKSPACE_CONFLICT","该 Team 标识已存在；请打开已保存的 Team。",current);
        const project = args.project === null ? null : await inspectWorkspaceProject(args.project);
        validateWorkspaceRoster(args.defaultRosterId);
        result = createGuiWorkspace(home,{...args,project});
      } else {
        if (!current) throw workspaceError("WORKSPACE_UNAVAILABLE","项目 Team 不存在，请刷新。");
        if (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0)
          throw Error("项目 Team 变更版本无效。");
        if (current.revision !== args.expectedRevision)
          throw workspaceError("WORKSPACE_CONFLICT","项目 Team 已变化，请读取最新状态。",current);
        let change;
        if (name === "workspace.bind") {
          if (current.project !== null)
            throw workspaceError("WORKSPACE_CONFLICT","该 Team 已绑定目录；如需另一目录请新建 Team。",current);
          change = {project:await inspectWorkspaceProject(args.path)};
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
            validateWorkspaceRoster(change.defaultRosterId);
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
        await rt.bindUI();
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
    if (name === "task.cancel") {
      if (active?.taskId === args.taskId) {
        cancelExtensionPrompts(active.sessionId);
        active.abort.abort();
        await live.get(args.taskId)?.cancel();
      } else rawTask(args.taskId);
      emit();
      return { taskId: args.taskId };
    }
    if (name === "task.reveal")
      return revealGuiTask(rawTask(args.taskId).record);
    if (name === "project.inspect")
      return inspectGuiProject(home, args.path, loadConfig(home)?.work);
    if (["workspace.create","workspace.update","workspace.bind"].includes(name))
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
        if (Object.keys(args).some(key => !["sessionId","workspaceId","project"].includes(key)) ||
            modern && Object.hasOwn(args,"project") || modern && !isWorkspaceId(args.sessionId) ||
            args.sessionId !== undefined && !isWorkspaceId(args.sessionId) ||
            modern && args.workspaceId !== null && !isWorkspaceId(args.workspaceId)) throw Error("新对话参数无效，请刷新页面。");
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
              if (project !== null && !await savedProjectAvailable(project,loadConfig(home)?.work))
                throw workspaceError("WORKSPACE_UNAVAILABLE","Team 保存的项目目录不可用，不能新建执行对话。");
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
          const manager = SessionManager.create(project ?? neutralDirectory(home),directory,{id});
          holder = {sessionManager:manager,writer,assertOwned:writer.assertOwned};
          appendConversationEntry(holder,"cothink-project",{project});
          appendConversationEntry(holder,"cothink-gui-workspace",{workspaceId:workspace?.id ?? null});
          const config = loadConfig(home);
          // Existing workspaces never silently fall back from a missing default.
          const roster = workspace ? config?.teams?.find(t => t.id === workspace.defaultRosterId)
            : config?.teams?.find(t => t.id === config.lastUsedTeamId);
          if (roster) saveSessionTeam(holder,roster);
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
            appendConversationEntry(target,"cothink-draft",{
              text:args.text,workRequest:args.workRequest,selectionId:args.selectionId,editId:args.editId,
            });
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
      ["team.save", "team.remove", "provider.save", "settings.work"].includes(
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
          const catalogs = new Set(
            [...holders.values()]
              .map((holder) => holder.runtime?.modelRuntime)
              .filter(Boolean),
          );
          for (const catalog of catalogs) {
            const refreshed = await catalog.refresh({ allowNetwork: false });
            if (refreshed?.aborted || refreshed?.errors?.size)
              throw Error(
                "服务商已保存，但会话模型目录同步未完成；请重新打开宿主后继续。不会自动发送模型请求。",
              );
          }
        }
        if (name === "settings.work") result = saveGuiWork(home, args.work);
        emit();
        return result;
      } finally {
        management = false;
      }
    }
    throw Error("未知 action。");
  }
  async function close() {
    if (closed) return;
    closed = true;
    const command=extensionCommand;command?.abort.abort();cancelExtensionPrompts();
    try{await command?.finished;}catch{}
    unsubscribeUpdates();
    updates.close();
    if (active) {
      const state = active;
      state.abort.abort();
      await live.get(state.taskId)?.cancel();
      await state.promise;
    }
    for (const id of [...holders.keys()]) await releaseHolder(id);
    listeners.clear();
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
    bootstrap: wrap(bootstrap),
    checkForUpdates,
    session: wrap(session),
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
      if (active?.taskId === id && live.has(id)) p.usage = t.usage();
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
    close,
  };
}
