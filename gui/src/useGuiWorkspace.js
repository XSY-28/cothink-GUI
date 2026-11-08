import { useCallback, useEffect, useRef, useState } from "react";
import { createDraftBook } from "./view.js";

const emptyBootstrap = { teams: [], models: [], providers: [], sessions: [], work: {}, active: null };
function readPending() {
  try {
    const value = JSON.parse(sessionStorage.getItem("cothink.pending") || "null");
    return typeof value?.sessionId === "string" && typeof value?.submissionId === "string" ? value : null;
  } catch { return null; }
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
  const creatingSessions = useRef(new Set());
  const [task, setTask] = useState(null);
  const [tasksById, setTasksById] = useState({});
  const [draft, setDraftText] = useState("");
  const [workChoices, setWorkChoices] = useState({});
  const [draftConflicts,setDraftConflicts] = useState({});
  const conflicts = useRef(new Map());
  function syncEditor(sessionId) {
    const snapshot=book.current.snapshot(sessionId);
    setWorkChoices(previous=>({...previous,[sessionId]:snapshot.workRequest ? {request:snapshot.workRequest,id:snapshot.selectionId} : null}));
    if (selected.current === sessionId) setDraftText(snapshot.text || "");
  }
  function setWorkRequest(sessionId, request) {
    if (!sessionId || pendingRef.current?.sessionId === sessionId || submissionBusy.current) return;
    book.current.edit(sessionId,{workRequest:request ?? null,selectionId:request ? crypto.randomUUID() : null});
    syncEditor(sessionId); scheduleDraft(sessionId);
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
  const pendingRef = useRef(pending), mounted = useRef(true);
  const refreshing = useRef(false), refreshAgain = useRef(false);
  const selectionRequest = useRef(0), taskRequest = useRef(0);

  function acceptBootstrap(value) {
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
  function saveDraft(snapshot) {
    if (!snapshot?.sessionId || !snapshot.editId) return Promise.resolve();
    const operation = draftQueue.current.catch(() => {}).then(async () => {
      const latest=book.current.snapshot(snapshot.sessionId);
      if (conflicts.current.has(snapshot.sessionId)) throw Error("草稿存在保存冲突，请先读取保存稿或明确使用本机稿。");
      // A deferred caller may enqueue an obsolete cleanup after a newer edit.
      // Only the current editor can borrow the latest acknowledged host version.
      // In-flight writes still acknowledge normally; newer snapshots stay queued.
      if (latest.editId !== snapshot.editId || latest.revision !== snapshot.revision ||
          latest.savedEditId === snapshot.editId) return;
      const args={sessionId:snapshot.sessionId,text:snapshot.text,workRequest:snapshot.workRequest,
        selectionId:snapshot.selectionId,editId:snapshot.editId,
        expectedDraftRevision:latest.expectedDraftRevision,branchAnchor:latest.branchAnchor};
      try {
        const saved=await api.action("session.draft",args);
        book.current.confirmed(snapshot,saved);
        return saved;
      } catch(error) {
        if (error.unknown || error.code === "DRAFT_CONFLICT") {
          const saved=await api.read("session",{id:snapshot.sessionId}).catch(()=>null);
          if (error.unknown && saved?.editor?.editId === snapshot.editId) {
            book.current.confirmed(snapshot,saved); return saved;
          }
          conflicts.current.set(snapshot.sessionId,saved);
          if (mounted.current) setDraftConflicts(previous=>({...previous,[snapshot.sessionId]:true}));
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
  async function resolveDraft(sessionId, choice) {
    clearTimeout(draftTimers.current.get(sessionId)); draftTimers.current.delete(sessionId);
    await draftQueue.current.catch(()=>{});
    const saved=await api.read("session",{id:sessionId});
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
    if (!sessionId) return;
    book.current.edit(sessionId, text);
    syncEditor(sessionId); scheduleDraft(sessionId);
  }
  function insertCommand(sessionId,command) {
    const current=book.current.snapshot(sessionId).text || "";
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
  }
  async function openSession(sessionId, target, request = ++selectionRequest.current) {
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
      const value = await api.read("session", {id: sessionId});
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
    setSelectedSessionId(null); setSession(null); setTask(null); setDraftText("");
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
      const fresh = await api.read("bootstrap");
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
      if (error.unknown || error.code === "WORKSPACE_CONFLICT") {
        const current = await api.read("bootstrap").catch(()=>null);
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
      const b = await api.read("bootstrap");
      if (!mounted.current) return;
      acceptBootstrap(b);
      await loadSessions();
      const id = selected.current, taskId = selectedTask.current;
      const selection = selectionRequest.current, taskSelection = taskRequest.current;
      observedSelection = selection;
      await Promise.all([
        id && api.read("session", {id}).then(value => {
          if (mounted.current && selectionRequest.current === selection && value.id === selected.current) {
            setSession(rememberView(value));
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
        const b = await api.read("bootstrap");
        if (cancelled || initialSelection !== selectionRequest.current) return;
        acceptBootstrap(b); setSessions(b.sessions); setNextCursor(b.sessionsCursor);
        const p = readPending(), previous = sessionStorage.getItem("cothink.session");
        const wanted = p?.sessionId || previous;
        const restored = wanted ? await openSession(wanted,undefined,initialSelection) : null;
        if (initialSelection !== selectionRequest.current) return;
        if (!restored) {
          clearSelection(initialSelection);
          const latest = b.workspaces?.find(row=>!row.archived && row.recentSessionId);
          if (latest) await selectWorkspace(latest,undefined,initialSelection);
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

  async function createSession(options = {}) {
    const project=Object.hasOwn(options,"project") ? options.project : projectRef.current;
    const modern=Object.hasOwn(options,"workspaceId");
    if (workspaceRef.current === undefined || (modern && options.workspaceId === undefined))
      throw Error("新建对话前，请先在左栏选择一个 Team 或通用对话。");
    const createScope=JSON.stringify(modern ? ["workspace",options.workspaceId] : ["project",project]);
    if (creatingSessions.current.has(createScope)) throw Error("正在确认此处的前一次创建，请稍候。");
    creatingSessions.current.add(createScope);
    const sessionId=crypto.randomUUID();
    const request = ++selectionRequest.current;
    if (selected.current) void flushDraft(selected.current).catch(()=>{});
    clearSelection(request);
    projectRef.current = project; setCurrentProject(project);
    if (modern) selectWorkspaceId(options.workspaceId);
    try {
      let value;
      try { value=await api.action("session.create",{sessionId,...(modern ? {workspaceId:options.workspaceId} : {project})}); }
      catch(error) {
        if (!error.unknown) throw error;
        value=await api.read("session",{id:sessionId}).catch(()=>null);
        if (!value || value.selectionError) throw Error(`创建结果尚未确认，请按原会话 ID ${sessionId} 查询。不会自动重建。`);
      }
      if (request === selectionRequest.current) await openSession(value.id,undefined,request);
      await refresh();
      return value;
    } catch (e) {
      if (mounted.current && request === selectionRequest.current) throw e;
      return null;
    } finally { creatingSessions.current.delete(createScope); }
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
  async function submit({sessionId = selected.current, input, workRequest} = {}) {
    if (!session || session.readOnly || session.navigation?.archived || session.id !== sessionId || selected.current !== sessionId ||
        bootstrap.workspaces?.some(row=>row.id===session.workspaceId && row.archived)) return;
    const snapshot = book.current.snapshot(sessionId);
    if (input !== undefined && input !== snapshot.text) {
      book.current.edit(sessionId, input);
      Object.assign(snapshot, book.current.snapshot(sessionId));
    }
    if (!snapshot.text?.trim()) return;
    if (snapshot.text.trim() === "/team") {
      setDraft(sessionId, "");
      return {local: "team"};
    }
    if (bootstrap.active || bootstrap.extensionUI?.command || submissionBusy.current || pendingRef.current) return;
    const choice = snapshot.workRequest ? {request:snapshot.workRequest,id:snapshot.selectionId} : null;
    workRequest ??= snapshot.workRequest;
    submissionBusy.current = true;
    setSubmitting(true);
    setError("");
    clearTimeout(draftTimers.current.get(sessionId));
    draftTimers.current.delete(sessionId);
    let submitted = false;
    try {
      await saveDraft(snapshot);
      const commandInput = snapshot.text.trim();
      const slash = /^\/([^\s]+)/.exec(commandInput)?.[1];
      if (slash && slash !== "one" && !slash.startsWith("skill:")) {
        const available = await api.action("extension.commands", {sessionId});
        if (available.some(command => command.name === slash)) {
          await api.action("extension.command", {sessionId, input: commandInput});
          book.current.accepted(snapshot);
          syncEditor(sessionId);
          const now = book.current.snapshot(sessionId);
          if (selected.current === sessionId) setDraftText(now.text);
          await saveDraft(now);
          await refresh();
          return;
        }
      }
      if (workRequest && !session.project) { setError("制作HTML/SVG需要先选择项目；草稿已保留。"); return; }
      const association = {sessionId, submissionId: crypto.randomUUID(), editorSnapshot:snapshot, ...(choice ? {selectionId:choice.id,workRequest:choice.request} : {})};
      storePending(association);
      setPendingStatus("正在确认本次提交…");
      submitted = true;
      const result = await api.action("task.submit", {sessionId, submissionId:association.submissionId, input: snapshot.text, ...(workRequest ? {workRequest} : {})});
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
      if (submitted && e.unknown) {
        submissionError.current = {sessionId:pendingRef.current?.sessionId, submissionId:pendingRef.current?.submissionId, errorRevision:errorRevision.current};
        setPendingStatus("提交确认丢失，先读取同一 submissionId 的记录。不会自动重发。");
      }
    } finally {
      submissionBusy.current = false;
      setSubmitting(false);
    }
  }
  async function recoverSubmission(association = pendingRef.current) {
    if (!association) return;
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
    const value = await api.read("bootstrap");
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
    state: {bootstrap, readingPosition, readingError, stopping:stopStatus && stopStatus.taskId === bootstrap.active?.taskId ? stopStatus : null, sessions, nextCursor, navigationQuery, currentProject, workspaceId, workspaceMatches, navigationLoading, navigationNotice, selectedSessionId, session, task, tasksById, draft, workRequest:workChoices[selectedSessionId]?.request ?? null, draftConflict:!!draftConflicts[selectedSessionId], pending,
      pendingStatus, submitting, connection, ready, errors: error ? [error] : []},
    commands: {querySessions, loadSessions, searchSessions, selectProject, selectWorkspace, openWorkspaceAttention, setSessionNavigation, closeSession,
      createWorkspace: args => manageWorkspace("workspace.create",{workspaceId:crypto.randomUUID(),...args},true),
      updateWorkspace: (workspace,change) => manageWorkspace("workspace.update",{workspaceId:workspace.id,expectedRevision:workspace.revision,change}),
      bindWorkspace: (workspace,path) => manageWorkspace("workspace.bind",{workspaceId:workspace.id,expectedRevision:workspace.revision,path}),
      clearNavigationNotice: () => setNavigationNotice(null), openSession, createSession, forkSession, setDraft, insertCommand, resolveDraft, submit, recoverSubmission, abandonSubmission,
      selectTask, changeSession, recordView, refresh, cancelTask, acknowledgeNotes, setWorkRequest, refreshTeams,
      saveTeam: args => manageTeam("team.save", args),
      removeTeam: args => manageTeam("team.remove", args),
      saveProvider: args => manageTeam("provider.save", args),
      saveWorkSettings: args => manageTeam("settings.work", args),
      checkUpdates: () => manageTeam("updates.check", {}),
      configureUpdates: args => manageTeam("updates.configure", args),
      listPluginCommands: sessionId => api.action("extension.commands", {sessionId}),
      runPluginCommand: (sessionId, name) => api.action("extension.command", {sessionId, input: "/" + name}),
      reloadPlugins: sessionId => api.action("extension.reload", {sessionId}),
      answerPlugin: (prompt, value, cancelled) => api.action("extension.respond", {sessionId: prompt.sessionId, promptId: prompt.id, value, cancelled}),
      inspectProject: path => api.action("project.inspect", {path}),
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
