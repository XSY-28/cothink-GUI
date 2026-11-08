import {FilePanel} from "./features/files/FilePanel.jsx";
import React, { useEffect, useReducer, useRef, useState } from "react";
import { createApi, consumeToken } from "./api.js";
import { useGuiWorkspace } from "./useGuiWorkspace.js";
import { initialView, workspaceViewReducer, readDisplayPreferences, saveDisplayPreferences } from "./workspace-view.js";
import { Navigation, ConversationPicker } from "./features/navigation/Navigation.jsx";
import { Conversation } from "./features/conversation/Conversation.jsx";
import { Collaboration } from "./Collaboration.jsx";
import { Settings } from "./Settings.jsx";
import { ProjectDialog } from "./ProjectDialog.jsx";
import { TeamPanel } from "./features/teams/TeamPanel.jsx";
import { Modal } from "./Modal.jsx";

function ExtensionPrompt({prompt, onAnswer}) {
  const [value, setValue] = useState(""), [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!prompt.expiresAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [prompt.expiresAt]);
  const cancel = () => onAnswer(undefined, true);
  const selecting = prompt.kind === "select";
  return <Modal title={prompt.title} onClose={cancel}>
    <p>已安装插件的请求</p>
    {prompt.expiresAt && <p>将在 {Math.max(0, Math.ceil((prompt.expiresAt - now) / 1000))} 秒后关闭</p>}
    {prompt.kind === "confirm" ? <>
      <p>{prompt.message}</p>
      <div className="form-actions"><button onClick={() => onAnswer(true)}>确认</button><button onClick={cancel}>取消</button></div>
    </> : <form onSubmit={e => {e.preventDefault(); onAnswer(value);}}>
      {selecting ? <label>选择<select aria-label="插件选项" value={value} onChange={e => setValue(e.target.value)}>
        <option value="" disabled>请选择</option>
        {prompt.options.map((option, i) => <option key={i} value={option}>{option}</option>)}
      </select></label> : <label>输入<input aria-label="插件输入" value={value} placeholder={prompt.placeholder} onChange={e => setValue(e.target.value)} /></label>}
      <div className="form-actions">
        <button type="submit" disabled={selecting && !value}>继续</button>
        <button type="button" onClick={cancel}>取消</button>
      </div>
    </form>}
  </Modal>;
}

export function App() {
  const [api] = useState(() => createApi(consumeToken()));
  const {state, commands} = useGuiWorkspace(api);
  const {bootstrap: boot, session, task, selectedSessionId} = state;
  const [view, dispatch] = useReducer(workspaceViewReducer, initialView, () => readDisplayPreferences(localStorage));
  const [title, setTitle] = useState("");
  const [toast, setToast] = useState("");
  const [notesHidden, setNotesHidden] = useState(false);
  const theme = view.theme;
  const [compact, setCompact] = useState(() => matchMedia("(max-width: 1179px)").matches);
  const [mobile, setMobile] = useState(() => matchMedia("(max-width: 899px)").matches);
  const detail = useRef(null), detailTrigger = useRef(null);
  const selection = view.detailsBySession[selectedSessionId];
  const detailOpen = !!selection?.open;
  const navOpen = mobile && view.navigation.mobileOpen;
  const showNotes = !!boot.releaseNotes?.unread && !notesHidden;
  const overlay = view.overlay;
  const prompt = boot.extensionUI?.prompts.find(p => p.sessionId === selectedSessionId);
  const modalOpen = !!(overlay || prompt);
  const overlayRef = useRef(overlay); overlayRef.current = overlay;
  const workspace = boot.workspaces?.find(row=>row.id === state.workspaceId);
  const projects = boot.projects ?? [];
  const rosterId = [session?.team?.id,workspace?.defaultRosterId,boot.currentTeamId]
    .find(id=>boot.teams.some(roster=>roster.id === id));
  const defaultRoster = boot.teams.find(roster=>roster.id === rosterId);
  const safely = operation => Promise.resolve(operation).catch(e => commands.setError(e.message));
  const setOverlay = value => {overlayRef.current = value; dispatch({type: "overlay", overlay: value});};
  const teamPanel = useRef(null);
  const closeOverlay = () => {
    if (overlayRef.current !== overlay || overlay?.busy) return;
    if (overlay?.kind === "team") teamPanel.current?.requestClose();
    else setOverlay(null);
  };
  const openTeam = () => setOverlay({kind:"team"});
  function openPicker(scope) {
    commands.searchSessions({scope,query:"",includeArchived:false});
    setOverlay({kind:"picker",scope});
  }
  function openWorkspace(row) {
    closeNavigation();
    return safely(commands.selectWorkspace(row));
  }
  function openFromPicker(id, taskId, fileRef, field) {
    setOverlay(null);
    return safely(openSession(id,taskId,fileRef,field));
  }
  async function showPlugins(sessionId, reload = false) {
    const loading = {kind: "plugins", sessionId};
    setOverlay(loading);
    try {
      if (reload) await commands.reloadPlugins(sessionId);
      const items = await commands.listPluginCommands(sessionId);
      if (overlayRef.current === loading) setOverlay({...loading, items});
    } catch (error) {
      if (overlayRef.current === loading) setOverlay(null);
      commands.setError(error.message);
    }
  }
  const navigationCommands = {...commands, requestRename:row=>{setTitle(row.title);setOverlay({kind:"rename",sessionId:row.id});}};
  const closeNavigation = () => dispatch({type: "navigation", change: {mobileOpen: false}});
  function dismissNavigation() {
    closeNavigation();
    requestAnimationFrame(() => document.querySelector(".nav-toggle")?.focus());
  }
  function openSession(id, taskId, fileRef, field) {
    if(fileRef){
      dispatch({type:"files",sessionId:id,selection:{fileRef,tab:"preview"}});
      dispatch({type:"details",sessionId:id,change:{taskId:fileRef.taskId,tab:"files",open:true}});
    }
    dispatch({type: "session"});
    const remembered = view.detailsBySession[id];
    const target = taskId ? {taskId,part:field === "input" ? "input" : "result"}
      : remembered?.open ? {taskId:remembered.taskId,jump:false} : undefined;
    return commands.openSession(id,target);
  }
  function restoreDetailFocus() {
    for (const node of [detailTrigger.current, document.querySelector(".conversation-picker-trigger"), document.querySelector(".nav-toggle")]) {
      if (!node?.isConnected || node.matches(":disabled") || node.closest("[inert]") || !node.getClientRects().length) continue;
      node.focus();
      if (document.activeElement === node) break;
    }
  }
  function closeDetails() {
    dispatch({type: "details", sessionId: selectedSessionId, change: {open: false}});
    requestAnimationFrame(restoreDetailFocus);
  }
  function openFile(fileRef, tab="preview", event) {
    dispatch({type:"files",sessionId:selectedSessionId,selection:{fileRef,tab}});
    openDetails(fileRef.taskId,"files",event);
  }
  function openDetails(taskId, tab = "collaboration", event) {
    if(tab === "changes") {
      dispatch({type:"files",sessionId:selectedSessionId,selection:{taskId,tab:"diff"}});
      tab="files";
    }
    if (!selectedSessionId || !taskId) return;
    const trigger = event?.currentTarget || document.activeElement;
    if (!detail.current?.contains(trigger)) detailTrigger.current = trigger;
    dispatch({type: "details", sessionId: selectedSessionId, change: {taskId, tab, open: true}});
    void commands.selectTask(taskId, selectedSessionId);
  }
  useEffect(() => {
    const media = matchMedia("(max-width: 1179px)");
    const changed = () => setCompact(media.matches);
    const navigationMedia = matchMedia("(max-width: 899px)");
    const navigationChanged = () => {
      setMobile(navigationMedia.matches);
      if (!navigationMedia.matches) closeNavigation();
    };
    media.addEventListener("change", changed);
    navigationMedia.addEventListener("change", navigationChanged);
    return () => {
      media.removeEventListener("change", changed);
      navigationMedia.removeEventListener("change", navigationChanged);
    };
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    saveDisplayPreferences(localStorage, view);
  }, [theme]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3000);
    return () => clearTimeout(timer);
  }, [toast]);
  // Drawer keyboard behavior belongs to its carrier, not the task or navigation data.
  useEffect(() => {
    if (modalOpen || (!navOpen && !detailOpen)) return;
    const node = navOpen ? document.querySelector(".sidebar") : detail.current;
    if (!node) return;
    const modal = navOpen || compact;
    const items = () => [...node.querySelectorAll('button,input,select,textarea,a[href],summary,[tabindex="0"]')]
      .filter(n => !n.disabled && !n.closest("[inert]") && n.getClientRects().length);
    (items()[0] || node).focus();
    const key = event => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (navOpen) dismissNavigation();
        else closeDetails();
      }
      if (modal && event.key === "Tab") {
        const elements = items(), first = elements[0], last = elements.at(-1);
        if (!elements.includes(document.activeElement)) {event.preventDefault(); (event.shiftKey ? last : first)?.focus();}
        else if (event.shiftKey && document.activeElement === first) {event.preventDefault(); last?.focus();}
        else if (!event.shiftKey && document.activeElement === last) {event.preventDefault(); first?.focus();}
      }
    };
    node.addEventListener("keydown", key);
    return () => node.removeEventListener("keydown", key);
  }, [navOpen, detailOpen, compact, modalOpen, selectedSessionId]);
  function currentOverlayError(error) {
    return {...overlay,busy:false,error:error.message};
  }
  async function updateWorkspace(change) {
    if (!workspace || overlayRef.current?.busy) return;
    const saving = {...overlay,busy:true,error:null};
    setOverlay(saving);
    try {
      await commands.updateWorkspace(workspace,change);
      if (overlayRef.current === saving) setOverlay(null);
    } catch (error) {
      if (overlayRef.current === saving) setOverlay(currentOverlayError(error));
    }
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); setToast("已复制原文"); }
    catch { commands.setError("未能访问系统剪贴板，请手动选中文字复制。"); }
  }
  return <div className={`app-shell ${detailOpen ? "detail-expanded" : ""}`}>
    {navOpen && <button className="nav-scrim" aria-label="关闭导航" onClick={dismissNavigation} />}
    <Navigation workspaces={boot.workspaces} workspaceId={state.workspaceId} ready={state.ready} mobileOpen={navOpen}
      onOpenWorkspace={openWorkspace} onSearch={()=>openPicker("all")} onCreate={()=>setOverlay({kind:"create-team"})}
      onSettings={()=>setOverlay({kind:"settings"})} connection={state.connection}
      updateLabel={boot.updates?.status === "available" ? "有新版本" : boot.releaseNotes?.unread ? "更新记录未读" : null}
      inert={modalOpen || (mobile && !navOpen) || (compact && detailOpen && !navOpen)} />
    <Conversation state={state} workspace={workspace} commands={{...commands, openSession}} inert={modalOpen || navOpen || (compact && detailOpen)}
      showNotes={showNotes} onHideNotes={()=>setNotesHidden(true)}
      onSettings={section => section === "teams" ? openTeam() : setOverlay({kind:"settings", section})}
      onWorkspaceMenu={()=>setOverlay({kind:"workspace"})} onConversations={()=>openPicker("project")} onRoster={openTeam}
      onAttention={()=>workspace && safely(commands.openWorkspaceAttention(workspace.id))}
      onToggleNavigation={() => dispatch({type:"navigation",change:{mobileOpen:!navOpen}})}
      onPlugins={() => showPlugins(session.id)}
      onFork={taskId => commands.forkSession({sessionId:session.id,taskId})}
      onOpenFile={openFile} onOpenDetails={openDetails}
      onNotes={() => setOverlay({kind:"settings",section:"preferences",showNotes:true})} onCopy={copy} />
    {detailOpen && <>
      <button className="detail-scrim" aria-label="关闭任务详情" onClick={closeDetails} inert={modalOpen || navOpen} />
      <aside className="detail-wrapper glass is-open" ref={detail} tabIndex={-1} inert={modalOpen || navOpen}
        role={compact ? "dialog" : "complementary"} aria-modal={compact ? true : undefined} aria-label="阅读面板">
        <div className="detail-back"><button onClick={closeDetails}>← 返回对话</button></div>
        {selection.tab === "files" ? <FilePanel task={state.tasksById[selection.taskId] || null}
          selection={view.filesBySession[selectedSessionId]} commands={commands}
          onRecords={()=>openDetails(selection.taskId,"collaboration")}
          onSelection={change=>dispatch({type:"files",sessionId:selectedSessionId,selection:{...view.filesBySession[selectedSessionId],...change}})}/>
          : <Collaboration task={state.tasksById[selection.taskId] || null} expanded tab={selection.tab || "collaboration"}
          setTab={tab => openDetails(selection.taskId,tab)}
          onExpand={() => {}} onClose={closeDetails} commands={commands} />}
      </aside>
    </>}
    <div style={{display:"contents"}} inert={!!prompt}>
    {overlay?.kind === "plugins" && <Modal title="插件命令" onClose={closeOverlay}>
      <div className="plugin-actions">
        {!overlay.items ? <p role="status">正在读取插件命令…</p> : <>
          {!overlay.items.length && <p>没有已注册的插件命令。</p>}
          {overlay.items.map(item => <button key={item.name} aria-label={"/" + item.name} onClick={() => {
            setOverlay(null);
            safely(commands.runPluginCommand(overlay.sessionId, item.name).then(commands.refresh));
          }}><strong>/{item.name}</strong> {item.description}</button>)}
        </>}
        <button disabled={!overlay.items} onClick={() => showPlugins(overlay.sessionId, true)}>重载插件</button>
      </div>
    </Modal>}
    {overlay?.kind === "settings" && <Settings boot={boot} initialTab={overlay.section}
      session={session} theme={theme} onTheme={theme=>dispatch({type:"theme",theme})} showNotes={overlay.showNotes} commands={{...navigationCommands, openSession:async (id,taskId,fileRef,field)=>{await openSession(id,taskId,fileRef,field);closeOverlay();}, openWorkspace:async row=>{closeOverlay();await openWorkspace(row);}}} onOpenTeam={openTeam} onClose={closeOverlay} />}
    {overlay?.kind === "team" && <Modal title="阵容" wide className="team-modal" onClose={closeOverlay}>
      <TeamPanel ref={teamPanel} session={session} workspace={workspace} teams={boot.teams} models={boot.models} providers={boot.providers}
        busy={!!(state.submitting || boot.active || boot.extensionUI?.command)} commands={commands} onClose={()=>{if(overlayRef.current === overlay)setOverlay(null);}} />
    </Modal>}
    {overlay?.kind === "picker" && <Modal title={overlay.scope === "all" ? "搜索" : "对话"} className="picker-modal" onClose={closeOverlay}>
      <ConversationPicker state={state} workspace={workspace} commands={navigationCommands} scope={overlay.scope} busy={overlay.busy}
        onOpenSession={openFromPicker} onOpenWorkspace={row=>{setOverlay(null);openWorkspace(row);}}
        onCreateSession={async ()=>{
          if (overlayRef.current?.busy) return;
          const saving = {...overlay,busy:true,error:null};
          setOverlay(saving);
          try {
            const created = await commands.createSession({workspaceId:state.workspaceId});
            if (overlayRef.current === saving) setOverlay(created ? null : overlay);
          } catch(error) { if (overlayRef.current === saving) setOverlay(currentOverlayError(error)); }
        }} />
      {overlay.error && <p className="error-text" role="alert">{overlay.error}</p>}
    </Modal>}
    {["create-team","bind-team"].includes(overlay?.kind) && <ProjectDialog key={overlay.kind}
      commands={commands} projects={projects} defaultRoster={defaultRoster} workspace={overlay.kind === "bind-team" ? workspace : null}
      onOpenExisting={row=>{setOverlay(null);openWorkspace(boot.workspaces?.find(item=>item.id === row.id) ?? row);}}
      onSaved={saved=>{closeOverlay();if(overlay.kind === "bind-team")setToast(`已关联 ${saved.name}，可从对话菜单新建对话。`);}}
      onClose={closeOverlay} />}
    {overlay?.kind === "workspace" && <Modal title={workspace?.name || (state.workspaceId === null ? "通用对话" : "归属待核对")} onClose={closeOverlay}>
      {!workspace ? <p>{state.workspaceId === null ? "这里保存不属于项目的历史和随手提问。" :
        session?.workspaceError || "Team 归属暂时无法确认，仍可阅读已保存的历史。"}</p> : <>
        <p className="workspace-directory">{workspace.project || "未关联目录，可用于问答与讨论。"}</p>
        {workspace.project && workspace.projectAvailable === false && <p className="error-text">目录不可用。仍可阅读历史。</p>}
        <div className="form-actions">
          {!workspace.archived && <button onClick={()=>{setTitle(workspace.name);setOverlay({kind:"rename-team"});}}>重命名 Team</button>}
          {!workspace.project && !workspace.archived && <button onClick={()=>setOverlay({kind:"bind-team"})}>关联目录</button>}
          <button disabled={overlay.busy} onClick={()=>updateWorkspace({archived:!workspace.archived})}>{workspace.archived ? "恢复 Team" : "归档 Team"}</button>
        </div>
        {overlay.error && <p className="error-text" role="alert">{overlay.error}</p>}
      </>}
    </Modal>}
    {overlay?.kind === "rename-team" && <Modal title="重命名 Team" onClose={closeOverlay}>
      <form onSubmit={event=>{event.preventDefault();void updateWorkspace({name:title.trim()});}}>
        <label>Team 名称<input required maxLength={160} value={title} onChange={event=>setTitle(event.target.value)}/></label>
        <div className="form-actions"><button className="primary" disabled={overlay.busy || !title.trim()}>保存名称</button></div>
        {overlay.error && <p className="error-text" role="alert">{overlay.error}</p>}
      </form>
    </Modal>}
    {overlay?.kind === "rename" && <Modal title="重命名对话" onClose={closeOverlay}>
      <form onSubmit={event => {event.preventDefault(); safely(commands.renameSession({sessionId: overlay.sessionId, title}).then(closeOverlay));}}>
        <label>对话标题<input required maxLength={200} value={title} onChange={e => setTitle(e.target.value)} /></label>
        <div className="form-actions"><button className="primary">保存标题</button></div>
      </form>
    </Modal>}
    </div>
    {prompt && <ExtensionPrompt key={prompt.id} prompt={prompt}
      onAnswer={(value, cancelled = false) => safely(commands.answerPlugin(prompt, value, cancelled).then(commands.refresh))} />}
    {toast && <div className="toast" role="status">{toast}</div>}
  </div>;
}
