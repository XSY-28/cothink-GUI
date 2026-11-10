import {defaultTurnOptions,editorTurnInput} from "../../src/gui-turn-options.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { createDraftBook } from "./view.js";

const HOME = "@home";
const emptyBootstrap = { teams: [], models: [], providers: [], sessions: [], work: {}, active: null };
function readPending() {
  try {
    const value = JSON.parse(sessionStorage.getItem("cothink.pending") || "null");
    return typeof value?.sessionId === "string" && typeof value?.submissionId === "string" ? value : null;
  } catch { return null; }
}

function readCreations() {
  try {
    const rows=JSON.parse(sessionStorage.getItem("cothink.creations")||"[]");
    return new Map(rows.filter(([key,row])=>typeof key==="string"&&typeof row?.sessionId==="string"));
  }catch{return new Map();}
}

/** One owner for host snapshots, draft persistence and once-only mutations.
 * Display choices and feature-local forms intentionally live outside this hook.
 */
export function useGuiWorkspace(api) {
  const [bootstrap, setBootstrap] = useState(emptyBootstrap);
  const [ready, setReady] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [navigationQuery, setNavigationQuery] = useState({query:"", scope:"project", includeArchived:false});
  const [workspaceId, setWorkspaceId] = useState(null);
  const [workspaceMatches, setWorkspaceMatches] = useState([]);
  const [navigationLoading, setNavigationLoading] = useState(false);
  const workspaceRef = useRef(null), editorWorkspaces = useRef(new Map());
  const [currentProject, setCurrentProject] = useState(null);
  const [navigationNotice, setNavigationNotice] = useState(null);
  const listQuery = useRef({query:"", scope:"project", includeArchived:false}), projectRef = useRef(null);
  const loadedCount = useRef(50);
  const listRequest = useRef(0), recentByProject = useRef(new Map());
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
    if (homeEditorId(selected.current) === sessionId) setDraftText(snapshot.text || "");
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
  const book = useRef(createDraftBook()), draftTimers = useRef(new Map());
  const draftQueue = useRef(Promise.resolve()), submissionBusy = useRef(false);
  const pendingRef = useRef(pending), mounted = useRef(true), organizingSession = useRef(null);
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
    if (value) sessionStorage.setItem("cothink.pending", JSON.stringify(value));
    else sessionStorage.removeItem("cothink.pending");
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
  function saveDraft(snapshot) {
    if (!snapshot?.sessionId || !snapshot.editId) return Promise.resolve();
    const operation = draftQueue.current.catch(() => {}).then(async () => {
      if(organizingSession.current===snapshot.sessionId)return;
      const latest=book.current.snapshot(snapshot.sessionId);
      if (conflicts.current.has(snapshot.sessionId)) throw Error("草稿存在保存冲突，请先读取保存稿或明确使用本机稿。");
      // A deferred caller may enqueue an obsolete cleanup after a newer edit.
      // Only the current editor can borrow the latest acknowledged host version.
      // In-flight writes still acknowledge normally; newer snapshots stay queued.
      if (latest.editId !== snapshot.editId || latest.revision !== snapshot.revision ||
          latest.savedEditId === snapshot.editId) return;
      const editor={editorVersion:2,text:snapshot.text,workRequest:snapshot.workRequest,
        selectionId:snapshot.selectionId,editId:snapshot.editId,materials:snapshot.materials??[],
        ...(snapshot.turnOptions!==undefined?{turnOptions:snapshot.turnOptions}:{})};
      const isHome=snapshot.sessionId===HOME;
      const args=isHome?{draftId:home.current?.draftId??crypto.randomUUID(),expectedRevision:latest.expectedDraftRevision,editor}:
        {sessionId:snapshot.sessionId,...editor,expectedDraftRevision:latest.expectedDraftRevision,branchAnchor:latest.branchAnchor};
      const homeAck=saved=>{setHome(saved);return {editor:saved.editor,draftRevision:saved.revision,branchAnchor:null};};
      try {
        const row=await api.action(isHome?"home.draft":"session.draft",args);
        const saved=isHome?homeAck(row):row;
        book.current.confirmed(snapshot,saved);
        return saved;
      } catch(error) {
        if (error.unknown || error.code === "DRAFT_CONFLICT") {
          const row=await (isHome?readBootstrap().then(b=>b.homeDraft):api.read("session",{id:snapshot.sessionId})).catch(()=>null);
          const saved=isHome?{editor:row?.editor,draftRevision:row?.revision??null,branchAnchor:null}:row;
          if (error.unknown && saved?.editor?.editId === snapshot.editId) {
            if(isHome)homeAck(row);
            book.current.confirmed(snapshot,saved); return saved;
          }
          markDraftConflict(snapshot.sessionId,saved);
        }
        throw error;
      }
    });
    draftQueue.current = operation;
    operation.catch(e => {
      if (mounted.current) setError("草稿未保存到宿主：" + e.message + " 当前页面仍保留输入。");
    });
    return operation;
  }
  function scheduleDraft(sessionId) {
    if(organizingSession.current===sessionId)return;
    clearTimeout(draftTimers.current.get(sessionId));
    const snapshot=book.current.snapshot(sessionId);
    draftTimers.current.set(sessionId,setTimeout(()=>{
      draftTimers.current.delete(sessionId); void saveDraft(snapshot).catch(()=>{});
    },650));
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
    book.current.edit(sessionId, text);
    syncEditor(sessionId); scheduleDraft(sessionId);
  }
  function insertCommand(sessionId,command) {
    const current=book.current.snapshot(homeEditorId(sessionId)).text || "";
    setDraft(sessionId,current ? `${current}\n${command}` : command);
  }
  async function selectTask(taskId, sessionId = selected.current) {
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
  }
  function readingFactSaved(view, field, wanted) {
    if (!view) return false;
    if (field === "opened") return !!view.lastOpenedAt && view.lastOpenedAt !== wanted;
    if (field === "anchor") return JSON.stringify(wanted) === JSON.stringify(view.anchor);
    return view.seenResults[wanted.taskId] === wanted.resultRevision;
  }
  function showReadingFailure(id) {
    if (!mounted.current || selected.current !== id) return;
    const failure = views.current.get(id)?.failures.values().next().value;
    setReadingError(failure ? "阅读状态未确认保存：" + failure.message : null);
  }
  function rememberView(value, confirmed = []) {
    const id = value.sessionId ?? value.id;
    const known = views.current.get(id);
    if (Number.isSafeInteger(value.viewRevision) && (!known || value.viewRevision >= known.viewRevision)) {
      const failures = known?.failures ?? new Map();
      for (const [key, {field,wanted}] of failures)
        if (confirmed.includes(key) || (!value.viewError && readingFactSaved(value.view,field,wanted))) failures.delete(key);
      views.current.set(id, {viewRevision:value.viewRevision, view:value.view, viewError:value.viewError, failures});
    }
    showReadingFailure(id);
    return known && Number.isSafeInteger(value.viewRevision) && value.viewRevision < known.viewRevision
      ? {...value,viewRevision:known.viewRevision,view:known.view} : value;
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
      book.current.load(sessionId,value.editor ?? value.draft,value.draftRevision,value.branchAnchor);
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
  function querySessions(options = {}) {
    const args = {...options};
    if (Object.hasOwn(args,"workspaceId") && args.workspaceId === undefined) return Promise.resolve({items:[],nextCursor:null});
    if (args.workspaceId === null) args.workspaceId = "";
    if (Object.hasOwn(args,"project") && args.project === null) args.project = "";
    return api.read("sessions",args);
  }
  async function loadSessions({more = false} = {}) {
    const request = ++listRequest.current, q = listQuery.current;
    const args = {query:q.query, archived:q.includeArchived ? "all" : "active",
      ...(q.scope === "project" ? {workspaceId:workspaceRef.current} : {}), ...(more && nextCursor ? {cursor:nextCursor} : {})};
    try {
      let page = await querySessions(args);
      if (!more) {
        while (page.nextCursor && page.items.length < loadedCount.current) {
          const next = await querySessions({...args,cursor:page.nextCursor});
          page = {...next,items:[...page.items,...next.items]};
          if (request !== listRequest.current || !mounted.current) return;
        }
      }
      if (request !== listRequest.current || !mounted.current) return;
      setSessions(previous => more ? [...new Map([...previous,...page.items].map(s=>[s.id,s])).values()] : page.items);
      setNextCursor(page.nextCursor);
      setWorkspaceMatches(page.workspaceMatches ?? []);
      setNavigationLoading(false);
      if (more) loadedCount.current += page.items.length;
    } catch (e) {
      if (!mounted.current || request !== listRequest.current) return;
      if (e.code === "CURSOR_EXPIRED" && more) return loadSessions();
      setNavigationLoading(false);
      setError(e.message);
    }
  }
  function searchSessions(change) {
    loadedCount.current = 50;
    listQuery.current = {...listQuery.current,...change};
    setNavigationQuery(listQuery.current);
    setNavigationLoading(true);
    setSessions([]); setWorkspaceMatches([]); setNextCursor(null);
    void loadSessions();
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
    if (args.change?.archived) {
      for (const [sessionId, owner] of editorWorkspaces.current)
        if (owner === id) await flushDraft(sessionId);
    }
    let saved;
    try { saved = await api.action(action, args); }
    catch (error) {
      if (error.unknown && action === "workspace.rebind") {
        const {workspaceId,operationId,expectedRevision}=args;
        const receipt=await api.action("workspace.rebind.query",{workspaceId,operationId,expectedRevision}).catch(()=>null);
        if (receipt?.status==="confirmed") saved=receipt.workspace;
        else throw Object.assign(Error("原目录变更尚未确认。可查询原操作，当前目录以最新记录为准。"),{unknown:true,operation:{workspaceId,operationId,expectedRevision}});
      } else if (error.unknown || error.code === "WORKSPACE_CONFLICT") {
        const current = await readBootstrap().catch(()=>null);
        if (current && mounted.current) acceptBootstrap(current);
        const found = current?.workspaces?.find(row=>row.id === id);
        if (error.unknown && found && (action === "workspace.create" ||
            action === "workspace.update" && Object.entries(args.change).every(([key,value])=>found[key]===value))) saved = found;
        else if (error.unknown) throw Object.assign(Error(`Team 操作结果尚未确认，请按原 Team ID ${id} 核对。不会自动重发。`),{unknown:true});
      }
      if (!saved) throw error;
    }
    if (mounted.current) setBootstrap(current => {
      if (!Array.isArray(current.workspaces)) return current;
      const prior=current.workspaces.find(row=>row.id===id);
      if (prior && prior.revision > saved.revision) return current;
      const value={recentSessionId:null,...prior,...saved};
      return {...current,workspaces:prior ? current.workspaces.map(row=>row.id===id ? value : row) : [...current.workspaces,value]};
    });
    if (open && request === selectionRequest.current) {
      selectWorkspaceId(id);
      try {
        await createSession({workspaceId:id});
      } catch (error) {
        const message = `Team 已保存。第一条对话未能确认：${error.message}`;
        setError(message);
        void refresh();
        return {...saved,firstSessionError:message};
      }
    }
    await refresh();
    return saved;
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
      const b = await readBootstrap();
      if (!mounted.current) return;
      acceptBootstrap(b);
      await loadSessions();
      const id = selected.current, taskId = selectedTask.current;
      const selection = selectionRequest.current, taskSelection = taskRequest.current;
      observedSelection = selection;
      await Promise.all([
        id && api.read("session", {id}).then(async value => {
          if(value.contextOperationIds?.length)value.contextOperation=await api.read("context-operation",{operationId:value.contextOperationIds[0]});
          if (mounted.current && selectionRequest.current === selection && value.id === selected.current) {
            setSession(rememberView(value));
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
        b.active?.taskId && b.active.status !== "preparing" && b.active.taskId !== taskId && api.read("task", {id:b.active.taskId}).then(value => {
          if (mounted.current) setTasksById(current => ({...current,[value.id]:value}));
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
        acceptBootstrap(b); setSessions(b.sessions); setNextCursor(b.sessionsCursor);
        if(b.homeDraft){
          setHome(b.homeDraft);
          book.current.load(HOME,b.homeDraft.editor,b.homeDraft.revision);
          syncEditor(HOME);
        }
        const p = readPending(), previous = sessionStorage.getItem("cothink.session");
        const wanted = p?.sessionId || previous;
        const restored = wanted ? await openSession(wanted,undefined,initialSelection) : null;
        if (initialSelection !== selectionRequest.current) return;
        if (!restored) {
          clearSelection(initialSelection);
          const latest = b.workspaces?.find(row=>!row.archived && row.recentSessionId);
          if (b.homeDraft) selectWorkspaceId(null);
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
    if(bootstrap.protocol?.guiInput!==2){
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
    const project=Object.hasOwn(options,"project") ? options.project : projectRef.current;
    const modern=Object.hasOwn(options,"workspaceId");
    if (workspaceRef.current === undefined || (modern && options.workspaceId === undefined))
      throw Error("新建对话前，请先在左栏选择一个 Team 或通用对话。");
    if(submissionBusy.current || pendingRef.current) throw Error("先确认正在提交的任务。");
    const createScope=JSON.stringify(modern ? ["workspace",options.workspaceId] : ["project",project]);
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
      }else{
        const flushed=source&&source===selected.current&&options.sourceLeafId===undefined?await flushDraft(source):null;
        const leaf=options.sourceLeafId??flushed?.branchAnchor??book.current.snapshot(source).branchAnchor??sourceLeaf;
        rememberCreation(createScope,{sessionId,options});
        try {
          value=await api.action("session.create",{sessionId,...(modern ? {workspaceId:options.workspaceId} : {project}),
            ...(modern&&source&&typeof leaf==="string"?{sourceSessionId:source,sourceLeafId:leaf}:{})});
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
  function changeHomeReservation(action,sessionId){
    const operation=draftQueue.current.catch(()=>{}).then(async()=>{
      const row=home.current;
      if(!row||conflicts.current.has(HOME))throw Error("首页保存稿需要先核对。");
      let next;
      try{
        next=await api.action(action,{draftId:row.draftId,expectedRevision:row.revision,sessionId,
          ...(action==="home.reserve"?{workspaceId:null}:{})});
      }catch(error){
        if(error.code==="DRAFT_CONFLICT")await markHomeDraftConflict();
        if(!error.unknown)throw error;
        const fresh=(await readBootstrap().catch(()=>null))?.homeDraft;
        if(fresh?.draftId!==row.draftId||fresh.editor.editId!==row.editor.editId||
          fresh.pendingCreateSessionId!==(action==="home.reserve"?sessionId:null))throw error;
        next=fresh;
      }
      setHome(next);
      book.current.rebase(HOME,{draftRevision:next.revision,branchAnchor:null});
      return next;
    });
    draftQueue.current=operation;
    return operation;
  }
  async function transferHome({send=false} = {}) {
    if(selected.current || workspaceRef.current!==null || creationBusy())return null;
    if(bootstrap.protocol?.guiInput!==2||bootstrap.homeDraftError)throw Error(bootstrap.homeDraftError??"需要新版界面才能保存首页草稿。");
    const request=++selectionRequest.current,end=beginCreate(request);
    let received;
    try {
      const desired=book.current.snapshot(HOME).editId;
      await flushDraft(HOME);
      let row=home.current;
      if(!row)return null;
      let sessionId=row.pendingCreateSessionId;
      if(sessionId){
        const status=await queryCreation(sessionId);
        if(status.status!=="confirmed"){
          if(status.status==="absent"){
            await changeHomeReservation("home.clearReservation",sessionId);
            throw Error("已查询原创建：没有保存新对话。首页草稿保留，可再次发送。");
          }
          throw Error("创建结果尚未确认。请查询原会话；不会自动重建或发送。");
        }
        received=status.session;
        send=false;
      }else if(send){
        sessionId=crypto.randomUUID();
        row=await changeHomeReservation("home.reserve",sessionId);
        try {
          received=await api.action("session.create",{sessionId,workspaceId:null,homeDraftId:row.draftId});
          if(received?.selectionError)throw Object.assign(Error(received.selectionError),{unknown:true});
        } catch(error){
          if(error.unknown || ["SESSION_STATE_UNAVAILABLE","SESSION_STATE_CONFLICT"].includes(error.code))
            throw Error("创建结果尚未确认。请查询原会话；不会自动重建或发送。");
          await flushDraft(HOME);
          await changeHomeReservation("home.clearReservation",sessionId);
          throw error;
        }
      }
      if(!received)return null;
      // A newer edit during creation must be saved to the same destination, but cannot be sent automatically.
      let saved;
      clearTimeout(draftTimers.current.get(HOME));draftTimers.current.delete(HOME);
      await flushDraft(HOME);
      const operation=draftQueue.current.catch(()=>{}).then(async()=>{
        row=home.current;
        try {
          saved=await api.action("home.transfer",{draftId:row.draftId,expectedRevision:row.revision,sessionId});
        }catch(error){
          if(error.code==="DRAFT_CONFLICT")await markHomeDraftConflict();
          if(!error.unknown)throw error;
          const [fresh,result]=await Promise.all([readBootstrap(),queryCreation(sessionId)]);
          if(fresh.homeDraft||fresh.homeDraftError||result.status!=="confirmed"||result.session.editor?.editId!==row.editor.editId)throw error;
          saved=result.session;send=false;
        }
        const newest=book.current.snapshot(HOME);
        setHome(null);book.current.restore(HOME,{});
        book.current.load(sessionId,saved.editor,saved.draftRevision,saved.branchAnchor);
        if(newest.editId!==saved.editor.editId){
          const {text,workRequest,selectionId,turnOptions,materials}=newest;
          book.current.edit(sessionId,{text,workRequest,selectionId,turnOptions,materials});
          scheduleDraft(sessionId);send=false;
        }
      });
      draftQueue.current=operation;
      await operation;
      if(request!==selectionRequest.current)return null;
      await openSession(sessionId,undefined,request,saved);
      return {session:saved,send:send&&desired===saved.editor.editId&&!!saved.team};
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
    if(!selected.current&&home.current?.pendingCreateSessionId)return transferHome();
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
    if (name === "session.mode" && (submissionBusy.current || pendingRef.current?.sessionId === sessionId)) return;
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
    const name=file.name||"粘贴图片",ext=name.split(".").at(-1).toLowerCase();
    const mediaType=({png:"image/png",jpeg:"image/jpeg",jpg:"image/jpeg",webp:"image/webp",md:"text/markdown",markdown:"text/markdown",txt:"text/plain"})[ext]||
      (file.type?.startsWith("text/")?"text/plain":file.type);
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
    const result=await api.file(ref,{purpose:"source"});
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
      if(materialBatches.current.has(HOME)||materialRowsFor(HOME).some(row=>row.status!=="ready")){setError("请完成、核对或移除未就绪材料。");return;}
      try{
        const result=await transferHome({send:true});
        if(result?.send)return submitSaved(result.session);
      }catch(error){setError(error.message);}
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
    if(materialBatches.current.has(sessionId)||materialRowsFor(sessionId,session).some(row=>row.status!=="ready")){setError("请完成、核对或移除未就绪材料。");return;}
    if (connection === "reconnecting" || bootstrap.shutdown?.requested) {setError("宿主未连接或正在退出；草稿保留，不发送新任务。");return;}
    if (bootstrap.active || bootstrap.extensionUI?.command || submissionBusy.current || pendingRef.current || !session.team) return;
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
      setError(e.message);
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
    if(!sessionId||bootstrap.active||pendingRef.current||submissionBusy.current)return;
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
  async function continuePrepared(turn) {
    if (!session?.id || selected.current!==session.id || session.readOnly || bootstrap.active || pendingRef.current || submissionBusy.current) return;
    submissionBusy.current=true;
    setSubmitting(true);
    const association={sessionId:session.id,submissionId:crypto.randomUUID(),sourceTaskId:turn.taskId,kind:"prepared-continuation"};
    storePending(association);
    try {
      const result=await api.action("task.continuePrepared",{sessionId:association.sessionId,
        submissionId:association.submissionId,sourceTaskId:turn.taskId,protocolVersion:1});
      storePending(null);
      if (selected.current===association.sessionId) await selectTask(result.taskId,association.sessionId);
      await refresh();
      return result;
    } catch(error) {
      if (!error.unknown) storePending(null);
      else setPendingStatus("续作响应未知，请查询原提交。");
      setError(error.message);
    } finally { submissionBusy.current=false;setSubmitting(false); }
  }
  async function prepareProject(args) {
    const result=await api.action("project.prepare",args);
    if (["confirm","finish"].includes(args.action)) await refresh().catch(()=>{});
    return result;
  }
  async function confirmWork(turn) {
    if(bootstrap.active||pendingRef.current||submissionBusy.current)return;
    submissionBusy.current=true;setSubmitting(true);
    const association={sessionId:session.id,submissionId:crypto.randomUUID(),proposalRef:turn.proposalRef,kind:'confirmation'};
    storePending(association);
    try{const result=await api.action('task.confirmWork',{sessionId:session.id,submissionId:association.submissionId,proposalRef:turn.proposalRef,protocolVersion:1});storePending(null);await selectTask(result.taskId,session.id);await refresh();return result;}
    catch(error){if(!error.unknown)storePending(null);setError(error.message);}
    finally{submissionBusy.current=false;setSubmitting(false);}
  }
  async function cancelTask() {
    const taskId=bootstrap.active?.taskId;
    if (!taskId || stoppingTask.current === taskId) return;
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
    state: {bootstrap, readingPosition, readingError, stopping:stopStatus && stopStatus.taskId === bootstrap.active?.taskId ? stopStatus : null, sessions, nextCursor, navigationQuery, currentProject, workspaceId, workspaceMatches, navigationLoading, navigationNotice, selectedSessionId, session, task, tasksById, draft, workRequest:workChoices[homeEditorId(selectedSessionId)]?.request ?? null,turnOptions:workChoices[homeEditorId(selectedSessionId)]?.turnOptions??null, draftConflict:!!draftConflicts[homeEditorId(selectedSessionId)], pending,
      homeDraft, homeReady:ready&&!session&&!selectedSessionId&&workspaceId===null&&!navigationLoading&&bootstrap.protocol?.guiInput===2&&!bootstrap.homeDraftError,
      creating:creating?.request===selectionRequest.current,creationNotice,
      materials:materialRowsFor(homeEditorId(selectedSessionId)),materialCapabilities:bootstrap.materialCapabilities,
      editorKey:selectedSessionId??homeDraft?.draftId??HOME,selectedSkill:/^\/skill:([^\s]+)/.exec(draft)?.[1]??null,
      pendingStatus, submitting, connection, ready, errors: error ? [error] : []},
    commands: {flushAllDrafts, querySessions, loadSessions, searchSessions, selectProject, selectWorkspace, openWorkspaceAttention, setSessionNavigation, closeSession,
      createWorkspace: args => manageWorkspace("workspace.create",{workspaceId:crypto.randomUUID(),...args},true),
      updateWorkspace: (workspace,change) => manageWorkspace("workspace.update",{workspaceId:workspace.id,expectedRevision:workspace.revision,change}),
      bindWorkspace: (workspace,path) => manageWorkspace("workspace.rebind",{workspaceId:workspace.id,expectedRevision:workspace.revision,path,operationId:crypto.randomUUID()}),
      queryWorkspaceRebind: args => api.action("workspace.rebind.query",args),
      clearNavigationNotice: () => setNavigationNotice(null), openSession, createSession, recoverCreation, showHome, forkSession, setDraft, insertCommand, resolveDraft, submit, organizeContext, confirmWork, continuePrepared, recoverSubmission, abandonSubmission,
      selectTask, changeSession, recordView, refresh, cancelTask, acknowledgeNotes, setWorkRequest,setTurnOptions, refreshTeams,
      saveTeam: args => manageTeam("team.save", args),
      removeTeam: args => manageTeam("team.remove", args),
      saveProvider: args => manageTeam("provider.save", args),
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
      prepareProject,
      readOutput: args => api.read("output", args),
      readImage: args => api.image(args),
      selectTeam: ({sessionId, teamId}) => changeSession("session.team", {teamId}, sessionId),
      renameSession: ({sessionId, title}) => changeSession("session.name", {title}, sessionId),
      loadFiles: taskId => api.read("files",{id:taskId}),
      readFile: (ref,options) => api.file(ref,options),
      readFileDiff: ref => api.read("file-diff",ref),
      downloadPatch: taskId => api.read("patch",{id:taskId}),
      revealTask: taskId => api.action("task.reveal",{taskId}),
      setError},
  };
}
