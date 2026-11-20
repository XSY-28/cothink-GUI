import {createGuiFileCommands} from "./features/files/fileCommands.js";
import {useEditorPersistence} from "./useEditorPersistence.js";
import {defaultTurnOptions,editorTurnInput,GUI_INPUT_VERSION,retiredReviewOption} from "../../src/gui-turn-options.js";
import {materialType} from "../../src/gui-material-types.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { readingFactSaved, mergeReadingView, createDraftBook, readPending, readCreations, writeGuiStorage } from "./view.js";
import { saveWorkspaceChange } from "./api.js";
import { useSessionSearch } from "./features/navigation/useSessionSearch.js";

const HOME = "@home";
const inputVersion = Number(GUI_INPUT_VERSION);
const emptyBootstrap = { teams: [], models: [], providers: [], sessions: [], work: {}, active: null };
/** One owner for host snapshots, draft persistence and once-only mutations.
 * Display choices and feature-local forms intentionally live outside this hook.
 */
export function useGuiWorkspace(api) {
  const [bootstrap, setBootstrap] = useState(emptyBootstrap);
  const [ready, setReady] = useState(false);
  const [workspaceId, setWorkspaceId] = useState(null);
  const workspaceRef = useRef(null), editorWorkspaces = useRef(new Map());
  const [currentProject, setCurrentProject] = useState(null);
  const [navigationNotice, setNavigationNotice] = useState(null);
  const projectRef = useRef(null), recentByProject = useRef(new Map());
  const [session, setSession] = useState(null);
  const [selectedSessionId, setSelectedSessionId] = useState(null);
  const [readingPosition,setReadingPosition] = useState(null);
  const [readingError,setReadingError] = useState(null);
  const views = useRef(new Map()), viewQueue = useRef(Promise.resolve());
  const creatingSessions = useRef(new Set()), unknownCreations=useRef(null);
  unknownCreations.current ??= readCreations();
  function rememberCreation(scope,row){
    if(row)unknownCreations.current.set(scope,row);
    else unknownCreations.current.delete(scope);
    try{sessionStorage.setItem("cothink.creations",JSON.stringify([...unknownCreations.current]));}catch{}
  }
  const creationIntent=useRef(null), home=useRef(null);
  const [creating,setCreating]=useState(null), [creationNotice,setCreationNotice]=useState(()=>[...unknownCreations.current.values()].at(-1)??null);
  const [homeDraft,setHomeDraft]=useState(null);
  function setHome(row) {home.current=row;setHomeDraft(row);}
  const homeEditorId=id=>id || HOME;
  const [task, setTask] = useState(null);
  const [tasksById, setTasksById] = useState({});
  const [draft, setDraftText] = useState("");
  const [workChoices, setWorkChoices] = useState({});
  const [materialRows,setMaterialRows]=useState({});
  const pendingUploads=useRef(new Map()),materialBatches=useRef(new Set()),removedUploads=useRef(new Set());
  function putMaterialRow(editorId,row){
    setMaterialRows(prior=>({...prior,[editorId]:{...prior[editorId],[row.uploadId??row.id]:row}}));
  }
  function forgetMaterialRow(editorId,key){
    setMaterialRows(prior=>{
      const rows={...prior[editorId]};delete rows[key];return {...prior,[editorId]:rows};
    });
  }
  const [draftConflicts,setDraftConflicts] = useState({});
  const conflicts = useRef(new Map());
  function syncEditor(sessionId) {
    const snapshot=book.current.snapshot(sessionId);
    setWorkChoices(previous=>({...previous,[sessionId]:{request:snapshot.workRequest??null,id:snapshot.selectionId,turnOptions:snapshot.turnOptions??null}}));
    if (homeEditorId(selected.current) === sessionId && (sessionId!==HOME || workspaceRef.current===null)) setDraftText(snapshot.text || "");
  }
  function setWorkRequest(sessionId, request) {
    sessionId=homeEditorId(sessionId);
    if (pendingRef.current?.sessionId === sessionId || submissionBusy.current) return;
    book.current.edit(sessionId,{workRequest:request ?? null,selectionId:request ? crypto.randomUUID() : null});
    syncEditor(sessionId); scheduleDraft(sessionId);
  }
  function setTurnOptions(sessionId,change) {
    sessionId=homeEditorId(sessionId);
    if(homeEditorId(selected.current)!==sessionId||sessionId!==HOME&&session?.id!==sessionId||pendingRef.current?.sessionId===sessionId||submissionBusy.current||sessionId===HOME&&change.readAllowed)return;
    const prior=book.current.snapshot(sessionId).turnOptions??defaultTurnOptions();
    const next={...prior,...change,id:crypto.randomUUID()};
    if(change.readAllowed===true){next.readProject=session.project;next.readWorkspaceId=session.workspaceId??null;}
    if(!next.readAllowed){next.readProject=null;next.readWorkspaceId=null;next.readVersion=null;}
    if(change.readPaths!==undefined&&change.readVersion===undefined)next.readVersion=null;
    book.current.edit(sessionId,{turnOptions:next});syncEditor(sessionId);scheduleDraft(sessionId);
  }
  function reconcileReadSelection(value){
    const options=book.current.snapshot(value.id).turnOptions;
    if(options?.readAllowed&&(options.readProject!==value.project||options.readWorkspaceId!==(value.workspaceId??null))){
      book.current.edit(value.id,{turnOptions:{...options,id:crypto.randomUUID(),readAllowed:false,readProject:null,readWorkspaceId:null}});
      syncEditor(value.id);scheduleDraft(value.id);setError('项目归属已变化，本次文件读取选择已清除；请重新确认。');
    }
  }
  function consumeSnapshot(association) {
    // Only the submitted editor may clear text; a newer choice has its own ID.
    if (association.editorSnapshot) book.current.accepted(association.editorSnapshot);
    syncEditor(association.sessionId);
  }
  const [pending, setPending] = useState(readPending);
  const [pendingStatus, setPendingStatus] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [stopStatus,setStopStatus] = useState(null), stoppingTask = useRef(null);
  const [connection, setConnection] = useState("connecting");
  const [error, updateError] = useState("");
  // Clear a recovered association's error only if no later error replaced it.
  const errorRevision = useRef(0), submissionError = useRef(null);
  function setError(message) {
    ++errorRevision.current;
    updateError(message);
  }
  const selected = useRef(null), selectedTask = useRef(null);
  const book = useRef(createDraftBook(true)), draftTimers = useRef(new Map());
  const draftQueue = useRef(Promise.resolve()), submissionBusy = useRef(false);
  const pendingRef = useRef(pending), mounted = useRef(true), organizingSession = useRef(null);
  const {sessions,nextCursor,navigationQuery,workspaceMatches,navigationLoading,navigationError,listQuery,listRequest,
    seedSessionList,querySessions,loadSessions,searchSessions} = useSessionSearch(api,workspaceRef,mounted);
  const refreshing = useRef(false), refreshAgain = useRef(false);
  const selectionRequest = useRef(0), taskRequest = useRef(0);

  const bootstrapReads=useRef({issued:0,applied:0,observations:new WeakMap()});
  async function readBootstrap(){
    const reads=bootstrapReads.current,stamp=++reads.issued;
    const value=await api.read("bootstrap");
    if(value&&typeof value==="object")reads.observations.set(value,stamp);
    return value;
  }
  function acceptBootstrap(value) {
    const reads=bootstrapReads.current,stamp=reads.observations.get(value)??reads.issued;
    if(stamp<reads.applied)return;
    reads.applied=stamp;
    if(home.current&&value.homeDraft?.draftId===home.current.draftId&&value.homeDraft.revision===home.current.revision)
      setHome(value.homeDraft);
    if(value.active?.origin==='context.organize')organizingSession.current=value.active.sessionId;
    else if(organizingSession.current&&!submissionBusy.current&&pendingRef.current?.kind!=='context'){
      const id=organizingSession.current;
      void api.read('session',{id}).then(saved=>{
        if(organizingSession.current!==id||saved.contextOrganizing)return;
        organizingSession.current=null;
        const snapshot=book.current.snapshot(id);
        if(snapshot.expectedDraftRevision===saved.draftRevision&&!saved.readOnly){book.current.rebase(id,saved);void flushDraft(id).catch(()=>{});}
      }).catch(()=>{});
    }
    setBootstrap(current => {
      if (!Array.isArray(value.workspaces) || !Array.isArray(current.workspaces)) return value;
      const prior = new Map(current.workspaces.map(row=>[row.id,row]));
      return {...value,workspaces:value.workspaces.map(row=>{
        const newer=prior.get(row.id);
        return newer?.revision > row.revision ? newer : row;
      })};
    });
  }
  function storePending(value) {
    pendingRef.current = value;
    setPending(value);
    writeGuiStorage("cothink.pending",value);
  }
  function markDraftConflict(sessionId, saved) {
    conflicts.current.set(sessionId,saved);
    if (mounted.current) setDraftConflicts(previous=>({...previous,[sessionId]:true}));
  }
  async function markHomeDraftConflict() {
    const observed=await readBootstrap().catch(()=>null);
    // Keep the local editor and its revision until the user resolves the conflict.
    markDraftConflict(HOME,observed);
  }
  const {saveDraft,saveThinking,recoverThinkingSettings,thinkingSaves,thinkingPending}=useEditorPersistence({
    api,book,draftQueue,organizingSession,conflicts,home,setHome,readBootstrap,markDraftConflict,mounted,setError,
    onSessionSaved:(value,id)=>{if(selected.current===id)setSession(rememberView(value));},
  });
  function scheduleDraft(sessionId) {
    if(organizingSession.current===sessionId)return;
    clearTimeout(draftTimers.current.get(sessionId));
    const snapshot=book.current.snapshot(sessionId);
    draftTimers.current.set(sessionId,setTimeout(()=>{
      draftTimers.current.delete(sessionId); void saveDraft(snapshot).catch(()=>{});
    },650));
  }
  function reconcileEditor(id, saved, observed) {
    const result=book.current.reconcile(id,saved,observed,!submissionBusy.current&&!pendingRef.current);
    if (!result) return;
    if (result.accepted) setPendingStatus("已从保存记录恢复上次提交。");
    syncEditor(id);
    if (result.conflict) markDraftConflict(id,saved);
    else if (result.save) scheduleDraft(id);
  }
  async function flushDraft(sessionId) {
    if (!sessionId) return;
    clearTimeout(draftTimers.current.get(sessionId)); draftTimers.current.delete(sessionId);
    await draftQueue.current.catch(()=>{});
    return saveDraft(book.current.snapshot(sessionId));
  }
  async function flushAllDrafts() {
    for(const timer of draftTimers.current.values()) clearTimeout(timer);
    draftTimers.current.clear();
    await draftQueue.current.catch(()=>{});
    for(const snapshot of book.current.pending()) await saveDraft(snapshot);
    if(book.current.pending().length) throw Error("草稿在保存期间发生变化，请再次关闭以保存最新输入。");
  }
  async function resolveDraft(sessionId, choice) {
    sessionId=homeEditorId(sessionId);
    clearTimeout(draftTimers.current.get(sessionId)); draftTimers.current.delete(sessionId);
    await draftQueue.current.catch(()=>{});
    const isHome=sessionId===HOME;
    let saved;
    if(isHome){
      const fresh=await readBootstrap();
      if(fresh.homeDraftError)throw Error(fresh.homeDraftError);
      setHome(fresh.homeDraft??null);
      saved={editor:fresh.homeDraft?.editor,draftRevision:fresh.homeDraft?.revision??null,branchAnchor:null};
    }else saved=await api.read("session",{id:sessionId});
    if (saved.selectionError || saved.readOnly) throw Error(saved.selectionError || "会话只读，本机草稿保留。");
    if (choice === "saved") book.current.restore(sessionId,saved);
    else if (choice === "local") { book.current.rebase(sessionId,saved); book.current.edit(sessionId,{}); }
    else throw Error("草稿选择无效。");
    conflicts.current.delete(sessionId);
    setDraftConflicts(previous=>({...previous,[sessionId]:false}));
    syncEditor(sessionId);
    if (choice === "local") await saveDraft(book.current.snapshot(sessionId));
  }
  function setDraft(sessionId, text) {
    sessionId=homeEditorId(sessionId);
    const priorError=submissionError.current;
    if (priorError?.clearOnEdit && priorError.sessionId===sessionId &&
        priorError.errorRevision===errorRevision.current && book.current.snapshot(sessionId).text!==text) {
      submissionError.current=null;
      setError("");
    }
    book.current.edit(sessionId, text);
    syncEditor(sessionId); scheduleDraft(sessionId);
  }
  function insertCommand(sessionId,command) {
    const current=book.current.snapshot(homeEditorId(sessionId)).text || "";
    setDraft(sessionId,current ? `${current}\n${command}` : command);
  }
  const selectTask = useCallback(async (taskId, sessionId = selected.current) => {
    if (sessionId !== selected.current) return null;
    const request = ++taskRequest.current;
    selectedTask.current = taskId;
    // Re-reading the same task must not disable the button that opened its reader.
    setTask(current => current?.id === taskId ? current : null);
    if (!taskId) return null;
    try {
      const value = await api.read("task", {id: taskId});
      if (!mounted.current || selected.current !== sessionId || request !== taskRequest.current) return null;
      setTask(value);
      setTasksById(current => ({...current, [value.id]: value}));
      return value;
    } catch (e) {
      if (selected.current === sessionId && request === taskRequest.current) setError(e.message);
      return null;
    }
  }, [api]);
  function showReadingFailure(id) {
    if (!mounted.current || selected.current !== id) return;
    const failure = views.current.get(id)?.failures.values().next().value;
    setReadingError(failure ? "阅读状态未确认保存：" + failure.message : null);
  }
  function rememberView(value, confirmed) {
    const merged = mergeReadingView(views.current,value,confirmed);
    showReadingFailure(value.sessionId ?? value.id);
    return merged;
  }
  function applyView(saved, confirmed) {
    rememberView(saved, confirmed);
    if (!mounted.current || selected.current !== saved.sessionId) return;
    setSession(current => current?.id === saved.sessionId && current.viewRevision < saved.viewRevision
      ? {...current,view:saved.view,viewRevision:saved.viewRevision} : current);
  }
  function recordView(sessionId, change) {
    const operation = viewQueue.current.then(async () => {
      const saved = views.current.get(sessionId);
      if (!saved?.view) return;
      const {anchor, seen, opened} = change;
      const next = {};
      if (opened) next.opened = true;
      if (anchor && !readingFactSaved(saved.view,"anchor",anchor)) next.anchor = anchor;
      if (seen && !readingFactSaved(saved.view,"seen",seen)) next.seen = seen;
      const facts = Object.entries(next).map(([field,value])=>({
        key:field === "seen" ? "seen:" + value.taskId : field,
        field, wanted:field === "opened" ? saved.view.lastOpenedAt : value,
      }));
      if (!facts.length) return;
      try {
        const receipt = await api.action("session.view",{sessionId,expectedViewRevision:saved.viewRevision,...next});
        applyView(receipt,facts.map(({key})=>key));
      } catch (error) {
        const fresh = await api.read("session",{id:sessionId}).catch(()=>null);
        if (fresh?.view) applyView({...fresh,sessionId});
        const latest = views.current.get(sessionId);
        for (const {key,field,wanted} of facts)
          if (latest.viewError || !readingFactSaved(latest.view,field,wanted))
            latest.failures.set(key,{field,wanted,message:error.message});
        showReadingFailure(sessionId);
      }
    });
    viewQueue.current = operation.catch(()=>{});
    return viewQueue.current;
  }
  function selectWorkspaceId(id) {
    workspaceRef.current = id;
    setWorkspaceId(id);
    if(!selected.current)setDraftText(id===null ? book.current.snapshot(HOME).text || "" : "");
  }
  async function openSession(sessionId, target, request = ++selectionRequest.current, confirmed) {
    if (!mounted.current || request !== selectionRequest.current) return null;
    const previous=selected.current;
    if (previous && previous !== sessionId) void flushDraft(previous).catch(()=>{});
    ++listRequest.current;
    setReadingPosition(null); setReadingError(null);
    const taskId = typeof target === "string" ? target : target?.taskId;
    selected.current = sessionId;
    setSelectedSessionId(sessionId);
    selectedTask.current = null;
    ++taskRequest.current;
    setSession(null);
    setTask(null);
    setDraftText(book.current.snapshot(sessionId).text || "");
    setError("");
    sessionStorage.setItem("cothink.session", sessionId);
    const observed=book.current.snapshot(sessionId);
    try {
      const value = confirmed ?? await api.read("session", {id: sessionId});
      if(value.contextOperationIds?.length)value.contextOperation=await api.read("context-operation",{operationId:value.contextOperationIds[0]});
      if (!mounted.current || request !== selectionRequest.current) return null;
      const restored=rememberView(value);
      setSession(restored);
      const jump=!!taskId && target?.jump !== false;
      setReadingPosition({sessionId, jump, target:jump ? {taskId,part:target?.part ?? "result",offsetPx:0} : restored.view?.anchor});
      if (Number.isSafeInteger(value.viewRevision) && value.view) void recordView(sessionId,{opened:true});
      projectRef.current = value.project; setCurrentProject(value.project);
      selectWorkspaceId(value.workspaceId);
      editorWorkspaces.current.set(sessionId, value.workspaceId);
      if (!value.navigation?.archived) recentByProject.current.set(value.project,sessionId);
      reconcileEditor(sessionId,value,observed);
      reconcileReadSelection(value);
      syncEditor(sessionId);
      await selectTask(taskId || value.turns.at(-1)?.taskId || null, sessionId);
      if (request !== selectionRequest.current) return null;
      if (listQuery.current.scope === "project") void loadSessions();
      return value;
    } catch (e) {
      if (mounted.current && request === selectionRequest.current) setError(e.message);
      return null;
    }
  }
  function clearSelection(request = ++selectionRequest.current) {
    if (request !== selectionRequest.current) return;
    ++taskRequest.current; ++listRequest.current;
    selected.current = null; selectedTask.current = null;
    setSelectedSessionId(null); setSession(null); setTask(null); setDraftText(workspaceRef.current===null ? book.current.snapshot(HOME).text || "" : "");
    setReadingPosition(null); setReadingError(null); setError("");
    sessionStorage.removeItem("cothink.session");
  }
  async function selectProject(project, request = ++selectionRequest.current) {
    if (!mounted.current || request !== selectionRequest.current) return null;
    // A project click invalidates every older navigation before its first await.
    // Drafts remain in the book, while no old conversation can still be submitted.
    if (selected.current) void flushDraft(selected.current).catch(()=>{});
    clearSelection(request);
    projectRef.current = project; setCurrentProject(project);
    try {
      const remembered = recentByProject.current.get(project);
      const rememberedSession = remembered ? await api.read("session",{id:remembered}).catch(()=>null) : null;
      if (!mounted.current || request !== selectionRequest.current) return null;
      const page = await querySessions({project,archived:"active",limit:1});
      if (!mounted.current || request !== selectionRequest.current) return null;
      const id = rememberedSession?.project === project && !rememberedSession.navigation?.archived ? remembered : page.items[0]?.id;
      if (id) await openSession(id,undefined,request);
      if (request === selectionRequest.current) await loadSessions();
    } catch (e) {
      if (mounted.current && request === selectionRequest.current) throw e;
    }
  }
  async function selectWorkspace(workspace, taskId, request = ++selectionRequest.current) {
    if (!mounted.current || request !== selectionRequest.current) return null;
    if (selected.current) void flushDraft(selected.current).catch(()=>{});
    clearSelection(request);
    const id = workspace === null ? null : workspace?.id;
    selectWorkspaceId(id);
    projectRef.current = workspace?.project ?? null; setCurrentProject(projectRef.current);
    if (taskId && workspace?.attention?.sessionId) {
      return openSession(workspace.attention.sessionId, taskId, request);
    }
    const page = await querySessions({workspaceId:id,archived:workspace?.archived ? "all" : "active",limit:1});
    if (request !== selectionRequest.current) return null;
    const fresh = page.workspaces?.find(row=>row.id === id);
    const recent = fresh?.recentSessionId ?? page.items[0]?.id;
    if (recent) return openSession(recent, undefined, request);
    await loadSessions();
    return null;
  }
  async function openWorkspaceAttention(workspaceId) {
    const request = ++selectionRequest.current;
    try {
      const fresh = await readBootstrap();
      if (!mounted.current || request !== selectionRequest.current) return;
      acceptBootstrap(fresh);
      const attention = fresh.workspaces?.find(row=>row.id===workspaceId)?.attention;
      if (attention && attention.kind !== "running")
        return openSession(attention.sessionId,attention.taskId,request);
    } catch(error) {
      if (mounted.current && request === selectionRequest.current) throw error;
    }
  }
  async function manageWorkspace(action, args, open = false) {
    const request = selectionRequest.current;
    const {workspaceId:id} = args;
    if (args.change?.archived || action === "workspace.delete") {
      for (const [sessionId, owner] of editorWorkspaces.current)
        if (owner === id) await flushDraft(sessionId);
    }
    const saved = await saveWorkspaceChange(api,action,args,readWorkspaces);
    if (action === "workspace.delete") {
      const rows = await readWorkspaces();
      if (request === selectionRequest.current && workspaceRef.current === id)
        await selectWorkspace(rows.find(row=>!row.archived) ?? null);
      else await refresh();
      return saved;
    }
    if (mounted.current) setBootstrap(current => {
      if (!Array.isArray(current.workspaces)) return current;
      const prior=current.workspaces.find(row=>row.id===id);
      if (prior && prior.revision > saved.revision) return current;
      const value={recentSessionId:null,...prior,...saved};
      return {...current,workspaces:prior ? current.workspaces.map(row=>row.id===id ? value : row) : [...current.workspaces,value]};
    });
    let firstSession;
    if (open && request === selectionRequest.current) {
      try {
        if (!selected.current && workspaceRef.current===null && book.current.snapshot(HOME).editId)
          firstSession = await transferHome({workspaceId:id});
        else
          firstSession = await createSession({workspaceId:id});
      } catch (error) {
        const message = `Team 已保存。第一条对话未能确认：${error.message}`;
        setError(message);
        void refresh();
        return {...saved,firstSessionError:message};
      }
    }
    await refresh();
    return firstSession && firstSession.workspaceId === id && selected.current === firstSession.id
      ? {...saved,openedSessionId:firstSession.id} : saved;
  }
  async function readWorkspaces() {
    const current=await readBootstrap();
    if (mounted.current) acceptBootstrap(current);
    if (!Array.isArray(current.workspaces)) throw Error("Team 列表暂不可用，请刷新。");
    return current.workspaces;
  }
  async function setSessionNavigation({sessionId, expectedRevision, change}) {
    const selection = selectionRequest.current;
    const field = Object.keys(change)[0];
    if (Object.keys(change).length !== 1 || !["archived","pinned"].includes(field)) throw Error("导航变更无效。");
    // Persist pending drafts before releasing this holder, without sending any task.
    if (field === "archived" && change.archived) {
      clearTimeout(draftTimers.current.get(sessionId)); draftTimers.current.delete(sessionId);
      await draftQueue.current.catch(()=>{});
      const snapshot = book.current.snapshot(sessionId);
      if (snapshot.sessionId) await saveDraft(snapshot);
    }
    let result;
    try { result = await api.action(field === "archived" ? "session.archive" : "session.pin",{sessionId,expectedRevision,...change}); }
    catch (e) {
      if (e.unknown || e.code === "SESSION_STATE_CONFLICT") {
        const saved = await api.read("session",{id:sessionId});
        if (selected.current === sessionId) setSession(rememberView(saved));
        await refresh();
        setNavigationNotice({text:`操作确认未完成；当前已保存状态：${saved.navigation?.archived ? "已归档" : "未归档"}，${saved.navigation?.pinned ? "已置顶" : "未置顶"}。未自动重发。`});
      }
      throw e;
    }
    await refresh();
    if (field === "archived" && change.archived) {
      setNavigationNotice({text:result.releaseError || "已归档，历史和草稿保留。", undo:{sessionId,expectedRevision:result.navigation.revision,change:{archived:false}}});
      if (selected.current === sessionId && selection === selectionRequest.current) await (session?.workspaceId !== undefined ? selectWorkspace(workspaceRef.current === null ? null : bootstrap.workspaces?.find(row=>row.id === workspaceRef.current)) : selectProject(projectRef.current));
    } else setNavigationNotice({text:field === "archived" ? "已恢复；可从导航打开对话。" : change.pinned ? "已置顶。" : "已取消置顶。"});
    return result;
  }
  async function closeSession(sessionId) {
    const selection = selectionRequest.current;
    const snapshot = book.current.snapshot(sessionId);
    if (snapshot.text?.trim()) throw Error("未发送草稿仍在，请先保留或清空草稿再关闭空白页。");
    clearTimeout(draftTimers.current.get(sessionId)); draftTimers.current.delete(sessionId);
    await draftQueue.current.catch(()=>{});
    await saveDraft(snapshot);
    await api.action("session.close",{sessionId});
    if (selected.current === sessionId && selection === selectionRequest.current) await (session?.workspaceId !== undefined ? selectWorkspace(workspaceRef.current === null ? null : bootstrap.workspaces?.find(row=>row.id === workspaceRef.current)) : selectProject(projectRef.current));
    await refresh();
  }
  const refresh = useCallback(async () => {
    if (refreshing.current) { refreshAgain.current = true; return; }
    refreshing.current = true;
    let observedSelection = selectionRequest.current;
    try {
      const homeBefore=home.current, homeEditor=book.current.snapshot(HOME);
      const b = await readBootstrap();
      if (!mounted.current) return;
      // Home has its own durable row and upload owner. Never rebind a dirty tab
      // to another tab's row or replace an in-progress creation reservation.
      const localHome=book.current.snapshot(HOME);
      if (!b.homeDraftError && home.current===homeBefore && !creationIntent.current &&
          localHome.editId===homeEditor.editId && localHome.savedEditId===homeEditor.savedEditId &&
          (!localHome.editId || localHome.editId===localHome.savedEditId)) {
        setHome(b.homeDraft??null);
        reconcileEditor(HOME,{editor:b.homeDraft?.editor,draft:"",draftRevision:b.homeDraft?.revision??null},homeEditor);
      }
      acceptBootstrap(b);
      if (observedSelection === selectionRequest.current && workspaceRef.current &&
          Array.isArray(b.workspaces) && !b.workspaces.some(row=>row.id===workspaceRef.current)) {
        await selectWorkspace(b.workspaces.find(row=>!row.archived) ?? null);
        return;
      }
      await loadSessions();
      const id = selected.current, taskId = selectedTask.current;
      const selection = selectionRequest.current, taskSelection = taskRequest.current;
      const observed=book.current.snapshot(id);
      observedSelection = selection;
      await Promise.all([
        id && api.read("session", {id}).then(async value => {
          if(value.contextOperationIds?.length)value.contextOperation=await api.read("context-operation",{operationId:value.contextOperationIds[0]});
          if (mounted.current && selectionRequest.current === selection && value.id === selected.current) {
            setSession(rememberView(value));
            reconcileEditor(id,value,observed);
            reconcileReadSelection(value);
            if (value.workspaceId !== workspaceRef.current) {
              selectWorkspaceId(value.workspaceId);
              editorWorkspaces.current.set(value.id, value.workspaceId);
              if (listQuery.current.scope === "project") void loadSessions();
            }
          }
        }),
        taskId && api.read("task", {id: taskId}).then(value => {
          if (mounted.current && selectionRequest.current === selection && taskRequest.current === taskSelection) {
            setTask(value);
            setTasksById(current => ({...current, [value.id]: value}));
          }
        }),
      ]);
    } catch (e) { if (mounted.current && observedSelection === selectionRequest.current) setError(e.message); }
    finally {
      refreshing.current = false;
      if (refreshAgain.current && mounted.current) {
        refreshAgain.current = false;
        void refresh();
      }
    }
  }, [api]);

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    const initialSelection = ++selectionRequest.current;
    (async () => {
      try {
        const b = await readBootstrap();
        if (cancelled || initialSelection !== selectionRequest.current) return;
        acceptBootstrap(b); seedSessionList(b);
        if(b.homeDraft)setHome(b.homeDraft);
        reconcileEditor(HOME,{editor:b.homeDraft?.editor,draft:"",
          draftRevision:b.homeDraft?.revision??null,readOnly:!!b.homeDraftError},book.current.snapshot(HOME));
        const p = readPending(), previous = sessionStorage.getItem("cothink.session");
        const wanted = p?.sessionId || previous;
        const restored = wanted ? await openSession(wanted,undefined,initialSelection) : null;
        if (initialSelection !== selectionRequest.current) return;
        if (!restored) {
          clearSelection(initialSelection);
          const latest = b.workspaces?.find(row=>!row.archived && row.recentSessionId);
          if (b.homeDraft || book.current.snapshot(HOME).editId) selectWorkspaceId(null);
          else if (latest) await selectWorkspace(latest,undefined,initialSelection);
          else if (b.sessions[0]?.id) await openSession(b.sessions[0].id,undefined,initialSelection);
          else if (b.workspaces?.some(row=>!row.archived)) await selectWorkspace(b.workspaces.find(row=>!row.archived),undefined,initialSelection);
        }
        if (cancelled) return;
        if (p) {
          const found = await api.recover(p);
          if (cancelled) return;
          if (found) {
            consumeSnapshot(p);
            storePending(null);
            setPendingStatus("已通过保存记录确认上次提交。");
            await flushDraft(p.sessionId);
            if (selected.current === p.sessionId) await selectTask(found.taskId, p.sessionId);
          } else setPendingStatus("尚未找到这次提交的已保存记录，结果未知。不会自动重发。");
        }
      } catch (e) { if (!cancelled && initialSelection === selectionRequest.current) setError(e.message); }
      finally { if (!cancelled) setReady(true); }
    })();
    const stop = api.subscribe(() => { if (!cancelled) refresh(); }, s => { if (!cancelled) setConnection(s); });
    const onFocus = () => {
      if (!cancelled) api.action("updates.check", {manual: false}).then(() => {
        if (!cancelled) refresh();
      }).catch(() => {});
    };
    window.addEventListener("focus", onFocus);
    const timer = setInterval(refresh, 3000);
    return () => {
      cancelled = true;
      mounted.current = false;
      stop();
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      for (const t of draftTimers.current.values()) clearTimeout(t);
    };
  }, [api, refresh]);

  async function queryCreation(id) {
    if(!(bootstrap.protocol?.guiInput>=2)){
      const value=await api.read("session",{id}).catch(()=>null);
      return value&&!value.selectionError?{status:"confirmed",session:value}:{status:"unknown"};
    }
    return api.read("session-creation",{id}).catch(()=>({status:"unknown"}));
  }
  const creationBusy=()=>creationIntent.current?.request===selectionRequest.current;
  function beginCreate(request){
    const intent={request};
    creationIntent.current=intent;setCreating(intent);
    return ()=>{if(creationIntent.current===intent){creationIntent.current=null;setCreating(null);}};
  }
  async function createSession(options = {}) {
    if (!options.workspaceId) throw Error("新建对话前，请先在左栏选择一个 Team。");
    if(submissionBusy.current || pendingRef.current) throw Error("先确认正在提交的任务。");
    const createScope=JSON.stringify(["workspace",options.workspaceId]);
    if (creatingSessions.current.has(createScope)) throw Error("正在确认此处的前一次创建，请稍候。");
    const unknown=unknownCreations.current.get(createScope);
    creatingSessions.current.add(createScope);
    const sessionId=unknown?.sessionId??crypto.randomUUID(), source=options.sourceSessionId??selected.current;
    const sourceLeaf=options.sourceLeafId??(session?.id===source?session?.branchAnchor:undefined);
    const request=++selectionRequest.current, end=beginCreate(request);
    try {
      let value;
      if(unknown){
        const result=await queryCreation(sessionId);
        if(result.status==="absent"){
          rememberCreation(createScope,null);setCreationNotice(null);
          throw Error("已核对原 ID：未保存新对话。可重新新建。");
        }
        value=result.session;
        if(result.status!=="confirmed")throw Error(`创建结果尚未确认，请按原会话 ID ${sessionId} 查询。不会自动重建。`);
        if (value.workspaceId!==options.workspaceId) throw Error("原会话不属于所选 Team，未继续。");
      }else{
        const flushed=source&&source===selected.current&&options.sourceLeafId===undefined?await flushDraft(source):null;
        const leaf=options.sourceLeafId??flushed?.branchAnchor??book.current.snapshot(source).branchAnchor??sourceLeaf;
        rememberCreation(createScope,{sessionId,options});
        try {
          value=await api.action("session.create",{sessionId,workspaceId:options.workspaceId,
            ...(source&&typeof leaf==="string"?{sourceSessionId:source,sourceLeafId:leaf}:{})});
          if(value?.selectionError)throw Object.assign(Error(value.selectionError),{unknown:true});
        }catch(error){
          if(!error.unknown && !["SESSION_STATE_UNAVAILABLE","SESSION_STATE_CONFLICT"].includes(error.code)){
            rememberCreation(createScope,null);
            throw error;
          }
          const result=await queryCreation(sessionId);
          if(result.status!=="confirmed"){
            setCreationNotice({sessionId,options});
            throw Error(`创建结果尚未确认，请按原会话 ID ${sessionId} 查询。不会自动重建。`);
          }
          value=result.session;
        }
      }
      rememberCreation(createScope,null);
      setCreationNotice(current=>current?.sessionId===sessionId?null:current);
      if(request===selectionRequest.current) await openSession(value.id,undefined,request,value);
      await refresh();
      return value;
    }catch(e){
      if(mounted.current&&request===selectionRequest.current)throw e;
      return null;
    }finally{creatingSessions.current.delete(createScope);end();}
  }
  function changeHomeReservation(action,sessionId,workspaceId){
    const operation=draftQueue.current.catch(()=>{}).then(async()=>{
      const row=home.current;
      if(!row||conflicts.current.has(HOME))throw Error("首页保存稿需要先核对。");
      let next;
      try{
        next=await api.action(action,{draftId:row.draftId,expectedRevision:row.revision,sessionId,
          ...(action==="home.reserve"?{workspaceId}:{})});
      }catch(error){
        if(error.code==="DRAFT_CONFLICT")await markHomeDraftConflict();
        if(!error.unknown)throw error;
        const fresh=(await readBootstrap().catch(()=>null))?.homeDraft;
        if(fresh?.draftId!==row.draftId||fresh.editor.editId!==row.editor.editId||
          fresh.pendingCreateSessionId!==(action==="home.reserve"?sessionId:null)||
          fresh.targetWorkspaceId!==(action==="home.reserve"?workspaceId:null))throw error;
        next=fresh;
      }
      setHome(next);
      book.current.rebase(HOME,{draftRevision:next.revision,branchAnchor:null});
      return next;
    });
    draftQueue.current=operation;
    return operation;
  }
  async function transferHome({workspaceId,recover=false} = {}) {
    if(selected.current || workspaceRef.current!==null || creationBusy())return null;
    if(bootstrap.protocol?.guiInput!==inputVersion||bootstrap.homeDraftError)throw Error(bootstrap.homeDraftError??"需要新版界面才能保存首页草稿。");
    const request=++selectionRequest.current,end=beginCreate(request);
    try {
      if(materialBatches.current.has(HOME)||materialRowsFor(HOME).some(row=>row.status!=="ready"))
        throw Error("首页草稿仍保留，请完成、核对或移除未就绪材料，再转移。");
      await flushDraft(HOME);
      let row=home.current;
      if(!row)return null;
      let sessionId=row.pendingCreateSessionId, received;
      if(sessionId){
        if(!recover)throw Error("首页已有待确认创建。请先查询原会话。");
        const status=await queryCreation(sessionId);
        if(status.status==="absent" || status.status==="confirmed" && row.targetWorkspaceId===null){
          await changeHomeReservation("home.clearReservation",sessionId);
          throw Error(status.status==="absent"
            ? "原会话未保存。首页草稿仍保留，可重新选择 Team。"
            : "旧会话仍可查阅。首页草稿保留，请选择有效 Team。");
        }
        if(status.status!=="confirmed")
          throw Error("创建结果尚未确认。请查询原会话；不会自动重建或发送。");
        received=status.session;
      }else if(!recover && workspaceId){
        sessionId=crypto.randomUUID();
        row=await changeHomeReservation("home.reserve",sessionId,workspaceId);
        try {
          received=await api.action("session.create",{sessionId,workspaceId,homeDraftId:row.draftId});
          if(received?.selectionError)throw Object.assign(Error(received.selectionError),{unknown:true});
        } catch(error){
          if(error.unknown || ["SESSION_STATE_UNAVAILABLE","SESSION_STATE_CONFLICT"].includes(error.code))
            throw Error("创建结果尚未确认。请查询原会话；不会自动重建或发送。");
          await changeHomeReservation("home.clearReservation",sessionId);
          throw error;
        }
      }
      if(!received)return null;
      if(received.workspaceId!==row.targetWorkspaceId)
        throw Error("原会话不属于保留的目标 Team；首页草稿仍保留。");
      const operation=draftQueue.current.catch(()=>{}).then(async()=>{
        if(conflicts.current.has(HOME)||home.current?.revision!==row.revision||
          book.current.snapshot(HOME).editId!==row.editor.editId)
          throw Error("首页草稿已有新编辑；原稿保留，请核对后再转移。");
        let saved;
        try {
          saved=await api.action("home.transfer",{draftId:row.draftId,expectedRevision:row.revision,sessionId});
        }catch(error){
          if(error.code==="DRAFT_CONFLICT")await markHomeDraftConflict();
          if(!error.unknown)throw error;
          const [fresh,result]=await Promise.all([readBootstrap(),queryCreation(sessionId)]);
          if(fresh.homeDraft||fresh.homeDraftError||result.status!=="confirmed"||
            result.session.workspaceId!==row.targetWorkspaceId||result.session.editor?.editId!==row.editor.editId)throw error;
          saved=result.session;
        }
        if(saved.id!==sessionId||saved.workspaceId!==row.targetWorkspaceId||saved.editor?.editId!==row.editor.editId)
          throw Error("新会话草稿尚未核对，请查询原会话。");
        setHome(null);book.current.restore(HOME,{});
        book.current.load(sessionId,saved.editor,saved.draftRevision,saved.branchAnchor);
        return saved;
      });
      draftQueue.current=operation;
      const saved=await operation;
      if(request!==selectionRequest.current)return null;
      await openSession(sessionId,undefined,request,saved);
      return saved;
    } finally{end();}
  }
  function showHome(){
    if(selected.current)void flushDraft(selected.current).catch(()=>{});
    clearSelection();
    selectWorkspaceId(null);
    projectRef.current=null;
    setCurrentProject(null);
  }
  async function recoverCreation(){
    if(!selected.current&&home.current?.pendingCreateSessionId)return transferHome({recover:true});
    if(creationNotice)return createSession(creationNotice.options);
  }
  async function forkSession({sessionId = selected.current, taskId} = {}) {
    if (!sessionId || !taskId) return null;
    // Reserve navigation intent before the mutation; a newer project/session
    // selection wins even if creating or reading the branch finishes late.
    const request = ++selectionRequest.current;
    try {
      const value = await api.action("session.fork", {sessionId, taskId});
      if (mounted.current && request === selectionRequest.current)
        await openSession(value.id, undefined, request);
      await refresh();
      return value;
    } catch (error) {
      if (mounted.current && request === selectionRequest.current) throw error;
      return null;
    }
  }
  async function changeSession(name, args = {}, sessionId = selected.current) {
    if (!sessionId) return;
    if(name==="session.thinking"){
      if(bootstrap.protocol?.guiInput!==inputVersion)throw Error("请重新打开新版界面后调整思考强度。");
      if(selected.current!==sessionId||session?.id!==sessionId||session.readOnly||session.navigation?.archived||
        session.selectionError||session.contextOrganizing||connection!=="connected"||submissionBusy.current||pendingRef.current||!session.team)return;
      return saveThinking(args,sessionId);
    }
    const value = await api.action(name, {...args, sessionId});
    if (selected.current === sessionId) setSession(rememberView(value));
    await refresh();
    return value;
  }
  async function materialEditor({createHome=false}={}){
    const sessionId=selected.current;
    if(sessionId)return {editorId:sessionId,ownerId:sessionId};
    if(workspaceRef.current!==null)throw Error("请先打开项目内的对话。");
    if(!home.current&&createHome){
      if(!book.current.snapshot(HOME).editId)book.current.edit(HOME,{});
      await flushDraft(HOME);
    }
    if(!home.current?.draftId)throw Error("首页草稿还未保存。");
    return {editorId:HOME,ownerId:home.current.draftId};
  }
  function materialRowsFor(editorId,confirmed){
    const refs=book.current.snapshot(editorId).materials??[];
    const observed=confirmed??(editorId===HOME?homeDraft:session?.id===editorId?session:null);
    const saved=observed?.materials??[];
    const local=Object.values(materialRows[editorId]??{});
    const ready=refs.map(ref=>local.find(row=>row.id===ref.id&&row.sha256===ref.sha256)||
      saved.find(row=>row.id===ref.id&&row.sha256===ref.sha256)||{...ref,name:"读取材料状态…",status:"loading"});
    const uploads=new Map((observed?.materialUploads??[]).map(row=>[row.uploadId,row]));
    for(const row of local){
      if(row.uploadId&&row.status!=="ready"&&row.status!=="removed")uploads.set(row.uploadId,row);
      else if(row.uploadId)uploads.delete(row.uploadId);
    }
    return [...ready,...uploads.values()];
  }
  function attachMaterial(editorId,manifest){
    putMaterialRow(editorId,manifest);
    const refs=book.current.snapshot(editorId).materials??[];
    if(!refs.some(ref=>ref.id===manifest.id&&ref.sha256===manifest.sha256)){
      book.current.edit(editorId,{materials:[...refs,{id:manifest.id,sha256:manifest.sha256}]});
      syncEditor(editorId);scheduleDraft(editorId);
    }
  }
  async function materialDescriptor(file,ownerId,uploadId=crypto.randomUUID()){
    if(typeof file?.arrayBuffer!=="function")throw Error("请选择有效文件。");
    const name=file.name||"粘贴图片",mediaType=materialType(name,file.type);
    const limits=bootstrap.materialCapabilities;
    if(!limits?.mediaTypes.includes(mediaType))throw Error("仅支持 UTF-8 文本、PNG、JPEG 和静态 WebP。");
    const limit=mediaType.startsWith("image/")?limits.imageBytes:limits.textBytes;
    if(file.size>limit)throw Error("文件超过单份材料上限。");
    const bytes=await file.arrayBuffer();
    const sha256=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),v=>v.toString(16).padStart(2,"0")).join("");
    return {bytes,intent:{ownerId,uploadId,name,mediaType,byteLength:bytes.byteLength,sha256}};
  }
  function checkMaterialAllowance(editorId,additions){
    const limits=bootstrap.materialCapabilities;
    if(!limits)throw Error("材料能力尚未加载。");
    const rows=[...materialRowsFor(editorId).filter(row=>row.status!=="failed"),...additions];
    if(rows.length>limits.maxCount||rows.reduce((sum,row)=>sum+(row.byteLength??0),0)>limits.totalBytes)
      throw Error("本条材料数量或总字节超过上限。");
  }
  async function uploadPrepared(editorId,intent,bytes,begin){
    const {ownerId,uploadId}=intent,abort=new AbortController();
    pendingUploads.current.set(uploadId,abort);
    putMaterialRow(editorId,{...intent,status:"uploading"});
    try {
      if(begin)await api.action("material.begin",intent);
      if(abort.signal.aborted)throw Error("已取消本次上传。");
      const ready=await api.uploadMaterial(ownerId,uploadId,bytes,abort.signal);
      if(abort.signal.aborted)return null;
      attachMaterial(editorId,ready);
      await flushDraft(editorId);
      return ready;
    }catch(error){
      if(!abort.signal.aborted)putMaterialRow(editorId,{...intent,status:error.unknown?"unknown":"failed",error:error.message});
      throw error;
    }finally{if(pendingUploads.current.get(uploadId)===abort)pendingUploads.current.delete(uploadId);}
  }
  async function addMaterials(files){
    const editorId=homeEditorId(selected.current),list=Array.from(files??[]);
    if(!list.length)return [];
    if(materialBatches.current.has(editorId))throw Error("当前编辑器正在准备一批材料。");
    checkMaterialAllowance(editorId,list.map(file=>({byteLength:file.size})));
    materialBatches.current.add(editorId);
    const pending=list.map(file=>({file,uploadId:crypto.randomUUID(),name:file.name||"粘贴图片",byteLength:file.size}));
    for(const {file,...row} of pending)putMaterialRow(editorId,{...row,status:"loading"});
    const result=[],errors=[];
    try{
      const {ownerId}=await materialEditor({createHome:true});
      for(const {file,uploadId,name,byteLength} of pending){
        if(removedUploads.current.has(uploadId))continue;
        let item;
        try{item=await materialDescriptor(file,ownerId,uploadId);}
        catch(error){putMaterialRow(editorId,{uploadId,name,byteLength,status:"failed",error:error.message});errors.push(error);continue;}
        if(removedUploads.current.has(uploadId))continue;
        try{result.push(await uploadPrepared(editorId,item.intent,item.bytes,true));}
        catch(error){if(!removedUploads.current.has(uploadId))errors.push(error);}
      }
    }catch(error){
      for(const {file,...row} of pending)if(!removedUploads.current.has(row.uploadId))
        putMaterialRow(editorId,{...row,status:"failed",error:error.message});
      errors.push(error);
    }finally{materialBatches.current.delete(editorId);}
    if(errors.length)throw errors[0];
    return result;
  }
  async function queryMaterial(uploadId){
    const {editorId,ownerId}=await materialEditor();
    const receipt=await api.read("materials",{ownerId,uploadId});
    if(removedUploads.current.has(uploadId))return receipt;
    if(receipt?.status==="ready"){
      attachMaterial(editorId,receipt);
      await flushDraft(editorId);
    }else if(receipt?.status==="pending")putMaterialRow(editorId,receipt);
    else forgetMaterialRow(editorId,uploadId);
    return receipt;
  }
  async function resumeMaterial(uploadId,file){
    const {editorId,ownerId}=await materialEditor();
    const receipt=await api.read("materials",{ownerId,uploadId});
    if(receipt?.status==="ready")return queryMaterial(uploadId);
    if(receipt?.status==="cancelled")throw Error("原上传已取消。");
    const {bytes,intent}=await materialDescriptor(file,ownerId,uploadId);
    if(receipt&&(intent.sha256!==receipt.sha256||intent.byteLength!==receipt.byteLength))
      throw Error("请选择与原摘要相同的文件。");
    return uploadPrepared(editorId,receipt?{...receipt,ownerId}:intent,bytes,!receipt);
  }
  async function removeMaterial(idOrUploadId){
    const editorId=homeEditorId(selected.current);
    const row=materialRowsFor(editorId).find(item=>item.id===idOrUploadId||item.uploadId===idOrUploadId);
    const uploadId=row?.uploadId??idOrUploadId;
    removedUploads.current.add(uploadId);
    pendingUploads.current.get(uploadId)?.abort();
    const refs=book.current.snapshot(editorId).materials??[];
    if(refs.some(ref=>ref.id===idOrUploadId)){
      book.current.edit(editorId,{materials:refs.filter(ref=>ref.id!==idOrUploadId)});
      syncEditor(editorId);await flushDraft(editorId);return;
    }
    putMaterialRow(editorId,{uploadId,status:"removed"});
    if(editorId===HOME&&!home.current)return;
    const {ownerId}=await materialEditor();
    const found=await api.read("materials",{ownerId,uploadId});
    if(found?.status==="pending"||found?.status==="ready")await api.action("material.cancel",{ownerId,uploadId});
    await refresh();
  }
  async function previewMaterial({id,sha256}){
    const {ownerId}=await materialEditor();
    return (await api.material({ownerId,id,...(sha256?{sha256}:{})})).blob;
  }
  async function resolveImage({sessionId,taskId,src,fileRef}){
    const id=/^(?:cothink-)?material:([0-9a-f-]{36})$/.exec(src)?.[1];
    if(id){
      const ownerId=sessionId??selected.current;
      if(!ownerId||!taskId)return null;
      const {blob}=await api.material({ownerId,id,taskId});
      return blob.type.startsWith("image/")?blob:null;
    }
    if(!taskId||fileRef&&fileRef.taskId!==taskId||!/^[^:/?#]+(?:\/[^:/?#]+)*$/.test(src))return null;
    const parts=fileRef?fileRef.path.split("/"):[];if(fileRef)parts.pop();
    for(const part of src.split("/")){
      if(part===".."||part==="."||part.includes("\\"))return null;
      parts.push(part);
    }
    const path=parts.join("/");
    let ref=fileRef?{...fileRef,path}:null;
    if(!ref){
      const ownerId=sessionId??selected.current;
      if(!ownerId)return null;
      const saved=await api.read("session",{id:ownerId});
      if(!saved.turns.some(turn=>turn.taskId===taskId))return null;
      const listed=await api.read("files",{id:taskId});
      ref=listed.items.find(item=>item.ref.path===path)?.ref;
      if(!ref)return null;
    }
    const result=await api.file(ref,{purpose:"preview"});
    return /^image\/(png|jpeg|gif|webp)$/.test(result.mediaType)?new Blob([result.bytes],{type:result.mediaType}):null;
  }
  async function listProjectMaterials(args){
    const {ownerId}=await materialEditor();
    return api.action("project.materials",{ownerId,...args});
  }
  async function previewProjectMaterial({source,version,path}){
    const {ownerId}=await materialEditor();
    const result=await api.material({ownerId,source,path,...(version?{version}:{})},{project:true});
    return result;
  }
  async function importProjectMaterials({source,paths}){
    const {editorId,ownerId}=await materialEditor();
    checkMaterialAllowance(editorId,paths);
    const prepared=paths.map(({path,sha256,sourceToken})=>{
      if(!sha256||!sourceToken)throw Error("请先预览并核对每份文件。");
      return {path,sha256,sourceToken,uploadId:crypto.randomUUID()};
    });
    const saved=await api.action("project.material.import",{ownerId,source,paths:prepared});
    for(const receipt of saved)attachMaterial(editorId,receipt);
    await flushDraft(editorId);
    return saved;
  }
  const getCapabilities=(sessionId=selected.current)=>api.read("capabilities",sessionId?{sessionId}:home.current?.draftId?{draftId:home.current.draftId}:{});
  async function listSkills(sessionId){
    const {skills=[]}=await getCapabilities(sessionId);return skills;
  }
  function chooseSkill(name){
    if(!/^[a-zA-Z0-9_-]+$/.test(name))throw Error("无效技能名称。");
    const id=homeEditorId(selected.current),text=book.current.snapshot(id).text??"";
    setDraft(id,`/skill:${name} ${text.replace(/^\/skill:[^\s]+[ \t]?/,"")}`);
  }
  function removeSkill(){
    const id=homeEditorId(selected.current);
    setDraft(id,(book.current.snapshot(id).text??"").replace(/^\/skill:[^\s]+[ \t]?/,""));
  }
  function localCommand(text){
    const value=text.trim();
    return !/[\r\n]/.test(value)?/^\/([^\s]+)(?:[ \t].*)?$/.exec(value)?.[1]:null;
  }
  function localDestination(command){
    return ({settings:"settings",models:"models",team:"team",help:"help"})[command];
  }
  async function submit({sessionId = selected.current, input} = {}) {
    if(creationBusy())return;
    if(!sessionId&&!selected.current&&workspaceRef.current===null){
      if(connection==="reconnecting"||bootstrap.shutdown?.requested||bootstrap.active||submissionBusy.current||pendingRef.current)return;
      if(input!==undefined)setDraft(HOME,input);
      const snapshot=book.current.snapshot(HOME),command=localCommand(snapshot.text??"");
      if(localDestination(command)){setDraft(HOME,"");return {local:localDestination(command)};}
      if(command&&!command.startsWith("skill:")){setError(["one","cothink","project"].includes(command)?"统一会话会按任务选择路径；旧模式命令已移除。":"未知本地命令。请使用 /help。");return;}
      if(!snapshot.text?.trim()&&!snapshot.materials?.length)return;
      setError("请先选择或创建 Team；首页草稿保留。");
      return;
    }
    return submitSaved(session,{sessionId,input});
  }
  async function submitSaved(session,{sessionId=session?.id,input}={}){
    if (!session || session.readOnly || session.navigation?.archived || session.id !== sessionId || selected.current !== sessionId ||
        bootstrap.workspaces?.some(row=>row.id===session.workspaceId && row.archived)) return;
    const snapshot = book.current.snapshot(sessionId);
    if (input !== undefined && input !== snapshot.text) {
      book.current.edit(sessionId, input);
      Object.assign(snapshot, book.current.snapshot(sessionId));
    }
    if(!snapshot.text?.trim()&&!snapshot.materials?.length)return;
    const slash=localCommand(snapshot.text);
    if(localDestination(slash)){setDraft(sessionId,"");return {local:localDestination(slash)};}
    if(retiredReviewOption(snapshot.turnOptions)){setError("请先在草稿中确认采用现行规则。");return;}
    if(materialBatches.current.has(sessionId)||materialRowsFor(sessionId,session).some(row=>row.status!=="ready")){setError("请完成、核对或移除未就绪材料。");return;}
    if (connection === "reconnecting" || bootstrap.shutdown?.requested) {setError("宿主未连接或正在退出；草稿保留，不发送新任务。");return;}
    if (thinkingPending(sessionId) || bootstrap.protocol?.guiInput!==inputVersion ||
        bootstrap.active || bootstrap.extensionUI?.command || submissionBusy.current || pendingRef.current || !session.team) return;
    const choice = {request:snapshot.workRequest??null,id:snapshot.selectionId,turnOptions:snapshot.turnOptions??null};
    submissionBusy.current = true;
    setSubmitting(true);
    setError("");
    clearTimeout(draftTimers.current.get(sessionId));
    draftTimers.current.delete(sessionId);
    let submitted = false;
    try {
      await saveDraft(snapshot);
      const {constraints,budget,readAuthorization}=editorTurnInput(snapshot.turnOptions,{project:session.project,workspaceId:session.workspaceId??null});
      if(slash&&!slash.startsWith("skill:")){
        if(!session.pluginCommands?.some(command=>command.name===slash)){
          setError(["one","cothink","project"].includes(slash)?"统一会话会按任务选择路径；旧模式命令已移除。":"未知本地命令。请使用 /help。");return;
        }
        await api.action("extension.command",{sessionId,input:snapshot.text.trim()});
        const now=book.current.snapshot(sessionId);
        if(now.editId===snapshot.editId){book.current.edit(sessionId,{text:""});syncEditor(sessionId);await flushDraft(sessionId);}
        await refresh();return;
      }
      const association = {sessionId, submissionId: crypto.randomUUID(), editorSnapshot:snapshot, ...(choice ? {selectionId:choice.id,workRequest:choice.request} : {})};
      storePending(association);
      setPendingStatus("正在确认本次提交…");
      submitted = true;
      const result = await api.action("task.submit", {sessionId, submissionId:association.submissionId, input: snapshot.text,protocolVersion:1,editorEditId:snapshot.editId,materials:snapshot.materials??[],constraints,budget,...(readAuthorization?{readAuthorization}:{})});
      consumeSnapshot(association);
      storePending(null);
      setPendingStatus("");
      const now = book.current.snapshot(sessionId);
      if (selected.current === sessionId) {
        setDraftText(now.text);
        await selectTask(result.taskId, sessionId);
      }
      await saveDraft(now);
      await refresh();
      return result;
    } catch (e) {
      if (submitted && !e.unknown) { storePending(null); setPendingStatus(""); }
      const draftError=submitted&&!e.unknown&&["NETWORK_POLICY","PROJECT_NOT_PREPARED","PROJECT_EXECUTION_REQUIRED"].includes(e.code);
      if (!draftError || book.current.snapshot(sessionId).editId===snapshot.editId) {
        setError(e.message);
        if (draftError) submissionError.current={sessionId,errorRevision:errorRevision.current,clearOnEdit:true};
      }
      if (submitted && e.code === "PROJECT_NOT_PREPARED") await refresh().catch(()=>{});
      if (submitted && e.unknown) {
        submissionError.current = {sessionId:pendingRef.current?.sessionId, submissionId:pendingRef.current?.submissionId, errorRevision:errorRevision.current};
        setPendingStatus("提交确认丢失，先读取同一 submissionId 的记录。不会自动重发。");
      }
    } finally {
      submissionBusy.current = false;
      setSubmitting(false);
    }
  }
  async function organizeContext() {
    const sessionId=selected.current;
    if(!sessionId||thinkingPending(sessionId)||bootstrap.active||pendingRef.current||submissionBusy.current)return;
    submissionBusy.current=true;setSubmitting(true);setError('');
    let sent=false;
    try{
      await flushDraft(sessionId);
      const saved=await api.read('session',{id:sessionId});
      if(saved.readOnly||saved.selectionError)throw Error(saved.selectionError||'会话只读。');
      const snapshot=book.current.snapshot(sessionId);
      if(snapshot.editId!==saved.editor?.editId&&snapshot.editId)throw Error('编辑稿尚未确认保存，整理未发送。');
      const {budget}=editorTurnInput(snapshot.turnOptions&&{...snapshot.turnOptions,readAllowed:false},{project:saved.project,workspaceId:saved.workspaceId??null});
      const operationId=crypto.randomUUID(),association={kind:'context',sessionId,submissionId:operationId,operationId,sourceLeaf:saved.branchAnchor,budget};
      organizingSession.current=sessionId;storePending(association);sent=true;
      const result=await api.action('context.organize',{sessionId,operationId,sourceLeaf:saved.branchAnchor,budget,protocolVersion:1});
      storePending(null);setPendingStatus('整理已受理；当前输入仍保留。');await refresh();return result;
    }catch(error){if(!sent||!error.unknown){organizingSession.current=null;storePending(null);}else setPendingStatus('整理响应未知，只查询原 operationId，不重发。');setError(error.message);}
    finally{submissionBusy.current=false;setSubmitting(false);void refresh();}
  }
  async function recoverSubmission(association = pendingRef.current) {
    if (!association) return;
    if(association.kind==='context'){
      try{const found=await api.read('context-operation',{operationId:association.operationId});
        if(found.sessionId!==association.sessionId)throw Error('整理恢复身份不一致。');
        storePending(null);setPendingStatus('已读取原整理状态，输入保留。');await refresh();return found;
      }catch(error){setError(error.message);return;}
    }
    try {
      const found = await api.recover(association);
      if (pendingRef.current?.submissionId !== association.submissionId) return;
      if (found) {
        const resolved = submissionError.current;
        if (resolved?.sessionId === association.sessionId && resolved?.submissionId === association.submissionId && resolved.errorRevision === errorRevision.current) setError("");
        submissionError.current = null;
        consumeSnapshot(association);
        storePending(null);
        setPendingStatus("已确认上次提交，后续输入仍保留。");
        await flushDraft(association.sessionId);
        if (selected.current === association.sessionId) await selectTask(found.taskId, association.sessionId);
        await refresh();
      } else setPendingStatus("尚未找到该提交的已保存记录，结果未知。保留草稿，不自动重发。");
      return found;
    } catch (e) {
      if (pendingRef.current?.sessionId !== association.sessionId || pendingRef.current?.submissionId !== association.submissionId) return;
      setError(e.message);
      submissionError.current = {sessionId:association.sessionId,submissionId:association.submissionId,errorRevision:errorRevision.current};
    }
  }
  const {confirmWork,inspectFileContinuation,continueFileWork,exportDraft}=createGuiFileCommands({
    api,bootstrap,session,pendingRef,submissionBusy,setSubmitting,storePending,selectTask,refresh,setError,
  });
  async function cancelTask() {
    const taskId=bootstrap.active?.taskId;
    if (!taskId) return;
    if (stoppingTask.current === taskId) {
      if (stopStatus?.status !== "stop_unknown") return;
      setStopStatus({taskId,status:"checking_stop"});
      try {
        const saved=await api.read("task",{id:taskId}).catch(async error=>{
          const original=(await readBootstrap()).active;
          if (original?.taskId!==taskId || original.status!=="preparing") throw error;
          return {id:taskId,status:original.cancelRequested===false?"running":"cancelling"};
        });
        if (stoppingTask.current !== taskId) return;
        if (saved.id !== taskId) throw Error("原任务身份无法确认。");
        if (saved.status === "stop_unknown") setStopStatus({taskId,status:"stop_unknown"});
        else if (saved.status === "cancelling" || (saved.status === "running" && saved.cancelRequestedAt))
          setStopStatus({taskId,status:"cancelling"});
        else {
          stoppingTask.current=null;
          setStopStatus(null);
          setError(saved.status === "running" ? "原任务仍在运行。可再次明确停止。" : "");
        }
      } catch(error) {
        if (stoppingTask.current === taskId) setStopStatus({taskId,status:"stop_unknown"});
        throw error;
      } finally { await refresh(); }
      return;
    }
    stoppingTask.current=taskId;
    setStopStatus({taskId,status:"cancelling"});
    try {
      await api.action("task.cancel",{taskId});
    } catch(error) {
      if (error.unknown) {
        setStopStatus({taskId,status:"stop_unknown"});
        await refresh();
      } else {
        stoppingTask.current=null;
        setStopStatus(null);
      }
      throw error;
    }
    await refresh();
  }
  function abandonSubmission() {
    storePending(null);
    setPendingStatus("已放弃关联。原提交结果仍未知，新任务仅由你再次明确发送。");
  }
  async function refreshTeams() {
    const value = await readBootstrap();
    if (mounted.current) acceptBootstrap(value);
    return value;
  }
  async function manageTeam(name, args) {
    const result = await api.action(name, args);
    // A failed refresh must not erase the already confirmed mutation receipt.
    await refreshTeams().catch(e => setError("操作已保存，列表刷新失败：" + e.message));
    return result;
  }
  async function acknowledgeNotes() {
    await api.action("releaseNotes.ack", {version: bootstrap.version});
    await refresh();
  }
  return {
    state: {bootstrap, readingPosition, readingError, stopping:stopStatus && stopStatus.taskId === bootstrap.active?.taskId ? stopStatus : null, sessions, nextCursor, navigationQuery, currentProject, workspaceId, workspaceMatches, navigationLoading, navigationError, navigationNotice, selectedSessionId, session, task, tasksById, draft, workRequest:workChoices[homeEditorId(selectedSessionId)]?.request ?? null,turnOptions:workChoices[homeEditorId(selectedSessionId)]?.turnOptions??null, draftConflict:!!draftConflicts[homeEditorId(selectedSessionId)], pending,
      homeDraft, homeReady:ready&&!session&&!selectedSessionId&&workspaceId===null&&!navigationLoading&&bootstrap.protocol?.guiInput===inputVersion&&!bootstrap.homeDraftError,
      creating:creating?.request===selectionRequest.current,creationNotice,
      materials:materialRowsFor(homeEditorId(selectedSessionId)),materialCapabilities:bootstrap.materialCapabilities,
      editorKey:selectedSessionId??homeDraft?.draftId??HOME,selectedSkill:/^\/skill:([^\s]+)/.exec(draft)?.[1]??null,
      thinkingSave:thinkingSaves[selectedSessionId]??null,
      pendingStatus, submitting, connection, ready, errors: error ? [error] : []},
    commands: {flushAllDrafts, querySessions, loadSessions, searchSessions, selectProject, selectWorkspace, openWorkspaceAttention, setSessionNavigation, closeSession,
      createWorkspace: args => manageWorkspace("workspace.create",{workspaceId:crypto.randomUUID(),...args},true),
      deleteWorkspace: workspace => manageWorkspace("workspace.delete",{workspaceId:workspace.id,expectedRevision:workspace.revision}),
      updateWorkspace: (workspace,change) => manageWorkspace("workspace.update",{workspaceId:workspace.id,expectedRevision:workspace.revision,change}),
      bindWorkspace: (workspace,path) => manageWorkspace("workspace.rebind",{workspaceId:workspace.id,expectedRevision:workspace.revision,path,operationId:crypto.randomUUID()}),
      queryWorkspaceRebind: args => api.action("workspace.rebind.query",args),
      queryWorkspaceCreation: async id => (await readWorkspaces()).find(row=>row.id===id),
      clearNavigationNotice: () => setNavigationNotice(null), openSession, createSession, recoverCreation, transferHome, showHome, forkSession, setDraft, insertCommand, resolveDraft, submit, organizeContext, confirmWork, inspectFileContinuation, continueFileWork, recoverSubmission, abandonSubmission,
      selectTask, changeSession, recoverThinkingSettings:options=>recoverThinkingSettings({sessionId:selected.current,...options}), recordView, refresh, cancelTask, acknowledgeNotes, setWorkRequest,setTurnOptions, refreshTeams,
      saveTeam: args => manageTeam("team.save", args),
      removeTeam: args => manageTeam("team.remove", args),
      saveProvider: args => manageTeam("provider.save", args),
      inspectProviderMetadata: args => api.action("provider.inspectMetadata",args),
      saveWorkSettings: args => manageTeam("settings.work", args),
      getCapabilities,listSkills,chooseSkill,removeSkill,
      addMaterials,removeMaterial,resumeMaterial,queryMaterial,previewMaterial,resolveImage,listProjectMaterials,previewProjectMaterial,importProjectMaterials,
      startOAuth:providerId=>api.action("oauth.start",{providerId}),
      getOAuth:operationId=>api.action("oauth.query",{operationId}),
      respondOAuth:(operationId,promptId,value)=>api.action("oauth.respond",{operationId,promptId,value}),
      cancelOAuth:operationId=>api.action("oauth.cancel",{operationId}),
      openOAuth:async operationId=>{const {url}=await api.action("oauth.open",{operationId});window.open(url,"_blank","noopener,noreferrer");},
      inspectExecution:args=>api.action("settings.inspectExecution",args),
      saveLocalSkills:args=>manageTeam("settings.localSkills",args),
      saveBuiltinSkills: async args => {
        try{return await manageTeam('settings.builtinSkills',args);}
        catch(error){if(!error.unknown)throw error;
          const saved=await readBootstrap().catch(()=>null);
          if(saved&&JSON.stringify([...(saved.builtinSkills?.disabled??[])].sort())===JSON.stringify([...args.builtinSkills.disabled].sort())){if(mounted.current)acceptBootstrap(saved);return saved.builtinSkills;}
          throw error;
        }
      },
      checkUpdates: () => manageTeam("updates.check", {}),
      configureUpdates: args => manageTeam("updates.configure", args),
      listPluginCommands: sessionId => api.action("extension.commands", {sessionId}),
      runPluginCommand: (sessionId, name) => api.action("extension.command", {sessionId, input: "/" + name}),
      reloadPlugins: sessionId => api.action("extension.reload", {sessionId}),
      answerPlugin: (prompt, value, cancelled) => api.action("extension.respond", {sessionId: prompt.sessionId, promptId: prompt.id, value, cancelled}),
      inspectProject: (path,purpose) => api.action("project.inspect", {path,purpose}),
      browseProject: path => api.action("project.browse",{path}),
      mkdirProject: args => api.action("project.mkdir",args),
      readOutput: args => api.read("output", args),
      readImage: args => api.image(args),
      readSession: id => api.read("session",{id}),
      selectTeam: ({sessionId, teamId}) => changeSession("session.team", {teamId}, sessionId),
      renameSession: ({sessionId, title}) => changeSession("session.name", {title}, sessionId),
      loadFiles: taskId => api.read("files",{id:taskId}),
      readFile: (ref,options) => api.file(ref,options),
      readFileDiff: ref => api.read("file-diff",ref),
      downloadPatch: taskId => api.read("patch",{id:taskId}),
      revealTask: taskId => api.action("task.reveal",{taskId}),
      exportDraft,
      setError},
  };
}
