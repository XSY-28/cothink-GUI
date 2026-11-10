import {FilePanel} from "./features/files/FilePanel.jsx";
import React, { useEffect, useReducer, useRef, useState } from "react";
import { createApi, consumeToken, copyText } from "./api.js";
import { useGuiWorkspace } from "./useGuiWorkspace.js";
import { initialView, workspaceViewReducer, readDisplayPreferences, useDisplayTheme } from "./workspace-view.js";
import { Navigation, ConversationPicker, ConversationRename } from "./features/navigation/Navigation.jsx";
import { Conversation } from "./features/conversation/Conversation.jsx";
import { NewConversationDialogs } from "./features/conversation/NewConversationDialogs.jsx";
import { ConversationActionDialogs, useConversationActions } from "./features/conversation/ConversationMenu.jsx";
import { Collaboration } from "./Collaboration.jsx";
import { Settings } from "./Settings.jsx";
import { ProjectDialog, ProjectPreparationDialog } from "./ProjectDialog.jsx";
import { TeamPanel } from "./features/teams/TeamPanel.jsx";
import { Modal } from "./Modal.jsx";
import { MaterialPicker, MaterialPreview } from "./MaterialPicker.jsx";

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

function SkillChoices({items,onChoose,onSettings}) {
  const [query,setQuery]=useState("");
  const needle=query.trim().toLocaleLowerCase();
  const matches=items?.filter(item=>`${item.name} ${item.description??""}`.toLocaleLowerCase().includes(needle));
  if(!items)return <p role="status">正在读取此处可用的技能…</p>;
  if(!items.length)return <><p>当前没有可选技能。</p><button onClick={onSettings}>打开技能设置</button></>;
  const source={builtin:"内置",selected:"本地来源",package:"已安装包",project:"项目"};
  return <>
    <label>搜索技能<input value={query} onChange={event=>setQuery(event.target.value)} placeholder="名称或用途"/></label>
    <p className="field-note">只为当前输入显式选择一个技能；不会启用脚本或扩大文件权限。</p>
    <div className="material-skill-list">{matches.map(item=>
      <button type="button" key={item.name} onClick={()=>onChoose(item.name)}>
        <strong>{item.name}</strong> · {source[item.sourceKind]??"当前资源"}{item.explicitOnly?" · 仅手动使用":""}
        {item.description&&<small>{item.description}</small>}
      </button>)}
      {!matches.length&&<p>没有匹配的技能。</p>}
    </div>
  </>;
}

export function App() {
  const [api] = useState(() => createApi(consumeToken()));
  const {state, commands} = useGuiWorkspace(api);
  const {bootstrap: boot, session, task, selectedSessionId} = state;
  const [view, dispatch] = useReducer(workspaceViewReducer, initialView, () => readDisplayPreferences(localStorage));
  const [title, setTitle] = useState("");
  const [toast, setToast] = useState("");
  const [notesHidden, setNotesHidden] = useState(false);
  const closeBoundary=useRef(null), resumeInput=useRef(null), resumeChoice=useRef(null);
  useEffect(()=>{
    const bridge=window.cothinkDesktop;
    if(!bridge)return;
    return bridge.onPrepareClose(async({requestId,phase})=>{
      if(phase === "resume") {
        if(closeBoundary.current===requestId){closeBoundary.current=null;document.body.inert=false;}
        return;
      }
      closeBoundary.current=requestId;
      // Freeze all input/metadata controls across the final backend-confirmed
      // save and acknowledgement. Native hide/show or failure resumes editing.
      document.body.inert=true;
      try {
        await commands.flushAllDrafts();
        if(closeBoundary.current===requestId)bridge.acknowledgeClose({requestId,saved:true});
      } catch(error) {
        if(closeBoundary.current===requestId){closeBoundary.current=null;document.body.inert=false;}
        commands.setError(error.message);bridge.acknowledgeClose({requestId,saved:false});
      }
    });
  },[commands]);
  const theme = view.theme;
  const setTheme = useDisplayTheme(theme,dispatch,setToast);
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
  const targetWorkspace = boot.workspaces?.find(row=>row.id===overlay?.workspaceId&&!row.archived);
  const projects = boot.projects ?? [];
  const rosterId = [session?.team?.id,workspace?.defaultRosterId,boot.currentTeamId]
    .find(id=>boot.teams.some(roster=>roster.id === id));
  const defaultRoster = boot.teams.find(roster=>roster.id === rosterId);
  const safely = operation => Promise.resolve(operation).catch(e => commands.setError(e.message));
  const setOverlay = value => {
    if (overlayRef.current?.kind === "picker" && value?.kind !== "picker")
      commands.searchSessions({scope:"project",query:"",includeArchived:false});
    overlayRef.current = value;
    dispatch({type: "overlay", overlay: value});
  };
  const teamPanel = useRef(null);
  const closeOverlay = () => {
    if (overlayRef.current !== overlay || overlay?.busy) return;
    if (overlay?.kind === "team") teamPanel.current?.requestClose();
    else setOverlay(null);
  };
  const openTeam = () => setOverlay({kind:"team"});
  const conversationActions = useConversationActions(state, workspace, setOverlay);
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
    const loading = {kind:"plugins",sessionId,items:reload?null:session?.pluginCommands};
    setOverlay(loading);
    if(!reload)return;
    try {
      await commands.reloadPlugins(sessionId);
      const items = await commands.listPluginCommands(sessionId);
      if(overlayRef.current===loading)setOverlay({...loading,items});
      await commands.refresh();
    } catch(error) {
      if(overlayRef.current===loading)setOverlay({...loading,error:error.message,items:[]});
    }
  }
  async function showSkills() {
    const loading={kind:"choose-skill"};
    setOverlay(loading);
    try {
      const result=await commands.listSkills(session?.id);
      if(overlayRef.current===loading)setOverlay({...loading,items:Array.isArray(result)?result:result.skills});
    }catch(error){if(overlayRef.current===loading)setOverlay({...loading,error:error.message,items:[]});}
  }
  async function showMaterial(item) {
    const loading={kind:"material-preview",item};
    setOverlay(loading);
    try {
      const blob=await commands.previewMaterial(item);
      if(!blob)throw Error("没有可核对的文件内容。");
      if(overlayRef.current===loading)setOverlay({...loading,blob});
    }catch(error){if(overlayRef.current===loading)setOverlay({...loading,error:error.message});}
  }
  async function checkMaterial(item) {
    const uploadId=item.uploadId;
    if(!uploadId)return;
    if(item.status==="unknown"){
      await safely(commands.queryMaterial(uploadId));
      return;
    }
    resumeChoice.current={uploadId,editorKey:state.editorKey};
    resumeInput.current?.click();
  }
  function onResumeFile(event) {
    const file=event.target.files?.[0],choice=resumeChoice.current;
    event.target.value="";
    resumeChoice.current=null;
    if(file&&choice?.editorKey===state.editorKey)void safely(commands.resumeMaterial(choice.uploadId,file));
    document.querySelector("#message-input")?.focus();
  }
  function openLocal(name) {
    if(name==="team"||name==="models")openTeam();
    else if(name==="settings"||name==="help")setOverlay({kind:name});
  }
  async function createConversation(workspaceId) {
    const prior=overlayRef.current;
    if(!prior||prior.busy)return;
    const saving={...prior,workspaceId,busy:true,error:null};
    setOverlay(saving);
    try {
      const handoff=prior.kind==="use-project-directory";
      if(handoff && (prior.sourceSessionId!==(session?.id??null) || state.draftConflict))
        throw Error("原草稿已变化，请重新核对。");
      const created=await commands.createSession({workspaceId,
        ...(handoff?{handoff:{project:prior.project,text:state.draft}}:{})});
      if(overlayRef.current===saving)setOverlay(created?null:prior);
    }catch(error){if(overlayRef.current===saving)setOverlay({...saving,busy:false,error:error.message});}
  }
  const useTeamDirectory = row => setOverlay({kind:"use-project-directory",workspaceId:row.id,project:row.project,sourceSessionId:session?.id??null});
  const canUseTeamDirectory = !!workspace?.project && workspace.project !== session?.project &&
    workspace.projectAvailable !== false && !workspace.archived;
  const navigationCommands = {...commands, requestRename:row=>setOverlay({kind:"rename",sessionId:row.id,title:row.title})};
  const prepareProject = (path,preparation) => setOverlay({kind:"prepare-project",path,preparation});
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
    try { await copyText(text); setToast("已复制原文"); }
    catch { setToast("未能访问系统剪贴板，请手动选中文字复制。"); }
  }
  return <div className={`app-shell ${detailOpen ? "detail-expanded" : ""}`} data-desktop-platform={window.cothinkDesktop?.info?.platform}>
    {commands.resumeMaterial&&<input type="file" hidden ref={resumeInput} onChange={onResumeFile} onCancel={()=>{resumeChoice.current=null;document.querySelector("#message-input")?.focus();}}/>}
    {navOpen && <button className="nav-scrim" aria-label="关闭导航" onClick={dismissNavigation} />}
    <Navigation workspaces={boot.workspaces} workspaceId={state.workspaceId} ready={state.ready} mobileOpen={navOpen}
      onOpenWorkspace={openWorkspace} onNewConversation={workspaceId=>{closeNavigation();setOverlay({kind:"new-conversation",workspaceId});}} onSearch={()=>openPicker("all")} onCreate={()=>setOverlay({kind:"create-team"})}
      onSettings={()=>setOverlay({kind:"settings"})} connection={state.connection}
      updateLabel={boot.updates?.status === "available" ? "有新版本" : boot.releaseNotes?.unread ? "更新记录未读" : null}
      inert={modalOpen || (mobile && !navOpen) || (compact && detailOpen && !navOpen)} />
    <Conversation state={state} workspace={workspace} commands={{...commands, openSession}} inert={modalOpen || navOpen || (compact && detailOpen)}
      showNotes={showNotes} onHideNotes={()=>setNotesHidden(true)}
      onSettings={section => section === "teams" ? openTeam() : setOverlay({kind:"settings", section})}
      onWorkspaceMenu={()=>setOverlay({kind:"workspace"})} onPrepareProject={prepareProject} onConversations={()=>openPicker("project")} onRoster={openTeam}
      onAttention={()=>workspace && safely(commands.openWorkspaceAttention(workspace.id))}
      onToggleNavigation={() => dispatch({type:"navigation",change:{mobileOpen:!navOpen}})}
      onPlugins={session?.pluginCommands?.length&&!session.readOnly&&!boot.active ? ()=>showPlugins(session.id):undefined}
      onLocalCommand={openLocal}
      {...conversationActions.controls}
      onChooseProjectFiles={commands.listProjectMaterials&&session?.projectDirectoryAvailable!==false?()=>setOverlay({kind:"project-materials",sessionId:session?.id}):undefined}
      onAssociateProject={()=>canUseTeamDirectory ? useTeamDirectory(workspace) : setOverlay({kind:workspace?"bind-team":"create-team"})}
      onUseTeamDirectory={canUseTeamDirectory ? ()=>useTeamDirectory(workspace) : undefined}
      onChooseSkill={boot.protocol?.capabilities===1&&commands.listSkills?showSkills:undefined}
      onPreviewMaterial={commands.previewMaterial?showMaterial:undefined}
      onRetryMaterial={commands.queryMaterial&&commands.resumeMaterial?checkMaterial:undefined}
      onFork={taskId => commands.forkSession({sessionId:session.id,taskId})}
      onOpenFile={openFile} onOpenDetails={openDetails}
      onNotes={() => setOverlay({kind:"settings",section:"preferences",showNotes:true})} onCopy={copy} />
    {detailOpen && <>
      <button className="detail-scrim" aria-label="关闭任务详情" onClick={closeDetails} inert={modalOpen || navOpen} />
      <aside className="detail-wrapper glass is-open" ref={detail} tabIndex={-1} inert={modalOpen || navOpen}
        role={compact ? "dialog" : "complementary"} aria-modal={compact ? true : undefined} aria-label="阅读面板">
        <div className="detail-back"><button onClick={closeDetails}>← 返回对话</button></div>
        {selection.tab === "files" ? <FilePanel task={state.tasksById[selection.taskId] || null} sessionId={session?.id}
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
        {overlay.error&&<p role="alert" className="error-text">{overlay.error}</p>}
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
      session={session} theme={theme} onTheme={setTheme} showNotes={overlay.showNotes} commands={{...navigationCommands, openSession:async (id,taskId,fileRef,field)=>{await openSession(id,taskId,fileRef,field);closeOverlay();}, openWorkspace:async row=>{closeOverlay();await openWorkspace(row);}}} onOpenTeam={openTeam} onClose={closeOverlay} />}
    {overlay?.kind === "team" && <Modal title="阵容" wide className="team-modal" onClose={closeOverlay}>
      <TeamPanel ref={teamPanel} session={session} workspace={workspace} teams={boot.teams} models={boot.models} providers={boot.providers}
        busy={!!(state.submitting || boot.active || boot.extensionUI?.command)} commands={commands} onClose={()=>{if(overlayRef.current === overlay)setOverlay(null);}} />
    </Modal>}
    <NewConversationDialogs overlay={overlay} workspace={targetWorkspace} session={session} draft={state.draft}
      creating={state.creating} conflict={state.draftConflict} onCreate={createConversation} onClose={closeOverlay}
      onHome={state.homeDraft&&!state.homeReady?()=>{commands.showHome();closeOverlay();}:undefined} />
    <ConversationActionDialogs state={state} overlay={overlay} actions={conversationActions} setOverlay={setOverlay}
      onRename={navigationCommands.requestRename} onPrepareProject={prepareProject} onClose={closeOverlay}
      onChangeTurnLimits={change=>commands.setTurnOptions(session?.id,change)} onOrganize={()=>void safely(commands.organizeContext())} />
    {overlay?.kind==="project-materials"&&(session?.project&&session.id===overlay.sessionId?<MaterialPicker key={state.editorKey??session.id} project={session.project} commands={commands}
      sessionId={session.id} capabilities={state.materialCapabilities} onClose={closeOverlay}
      onSelected={()=>{closeOverlay();requestAnimationFrame(()=>document.querySelector("#message-input")?.focus());}}/>:
      <Modal title="选择项目文件" onClose={closeOverlay}><p className="dialog-body" role="status">当前对话目录不可用，请重新选择。</p></Modal>)}
    {overlay?.kind==="choose-skill"&&<Modal title="使用技能" onClose={closeOverlay}>
      <div className="dialog-body">
        {overlay.error&&<p className="error-text" role="alert">{overlay.error}</p>}
        <SkillChoices items={overlay.items} onSettings={()=>setOverlay({kind:"settings",section:"skills"})} onChoose={async name=>{
          try {await commands.chooseSkill(name);if(overlayRef.current===overlay){closeOverlay();requestAnimationFrame(()=>document.querySelector("#message-input")?.focus());}}
          catch(error){if(overlayRef.current===overlay)setOverlay({...overlay,error:error.message});}
        }}/>
      </div>
    </Modal>}
    {overlay?.kind==="material-preview"&&<Modal title={`预览 · ${overlay.item.name}`} onClose={closeOverlay} wide>
      <div className="dialog-body">
        {overlay.error?<p className="error-text" role="alert">{overlay.error}</p>:<MaterialPreview blob={overlay.blob} name={overlay.item.name}/>}
      </div>
    </Modal>}
    {overlay?.kind==="help"&&<Modal title="CoThink 帮助" onClose={closeOverlay}>
      <div className="dialog-body">
        <p>Enter 发送，Shift+Enter 换行；可从“+”添加材料或选择技能。在“对话操作”中可设置下一条消息的限制。</p>
        <p><code>/settings</code> 打开设置，<code>/team</code> 或 <code>/models</code> 打开阵容，<code>/help</code> 打开本页。</p>
        <div className="form-actions"><button onClick={()=>openLocal("settings")}>打开设置</button><button onClick={openTeam}>打开阵容</button></div>
      </div>
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
      onSaved={saved=>{
        if(overlay.kind==="bind-team" && saved.project && session?.project!==saved.project) useTeamDirectory(saved);
        else closeOverlay();
      }}
      onClose={closeOverlay} />}
    {overlay?.kind === "prepare-project" && <ProjectPreparationDialog key={overlay.path} commands={commands} path={overlay.path}
      initialPreparation={overlay.preparation} onClose={closeOverlay} onReady={()=>safely(commands.refresh())} />}
    {overlay?.kind === "workspace" && <Modal title={workspace?.name || (state.workspaceId === null ? "未分组对话" : "归属待核对")} onClose={closeOverlay}>
      {!workspace ? <p>{state.workspaceId === null ? "这里保存不属于项目的历史和随手提问。" :
        session?.workspaceError || "Team 归属暂时无法确认，仍可阅读已保存的历史。"}</p> : <>
        <p>Team 默认目录</p>
        <p className="workspace-directory">{workspace.project || "未关联目录，可用于问答与讨论。"}</p>
        {session && canUseTeamDirectory && <p className="workspace-directory">当前对话目录：{session.project || "未关联"}</p>}
        {workspace.project && workspace.projectAvailable === false && <p className="error-text">目录不可用。仍可阅读历史。</p>}
        <div className="form-actions">
          {!workspace.archived && <button onClick={()=>{setTitle(workspace.name);setOverlay({kind:"rename-team"});}}>重命名</button>}
          {!workspace.archived && <button onClick={()=>setOverlay({kind:"bind-team"})}>{workspace.project?"更换或解除目录":"关联目录"}</button>}
          {canUseTeamDirectory && <button onClick={()=>useTeamDirectory(workspace)}>用新目录继续</button>}
          {workspace.project && !workspace.projectHomeProtected && workspace.projectAvailable!==false && !workspace.archived && <button onClick={()=>prepareProject(workspace.project)}>准备文件工作</button>}
          <button disabled={overlay.busy} onClick={()=>updateWorkspace({archived:!workspace.archived})}>{workspace.archived ? "恢复" : "归档"}</button>
        </div>
        {overlay.error && <p className="error-text" role="alert">{overlay.error}</p>}
      </>}
    </Modal>}
    {overlay?.kind === "rename-team" && <Modal title="重命名" onClose={closeOverlay}>
      <form onSubmit={event=>{event.preventDefault();void updateWorkspace({name:title.trim()});}}>
        <label>名称<input required maxLength={160} value={title} onChange={event=>setTitle(event.target.value)}/></label>
        <div className="form-actions"><button className="primary" disabled={overlay.busy || !title.trim()}>保存名称</button></div>
        {overlay.error && <p className="error-text" role="alert">{overlay.error}</p>}
      </form>
    </Modal>}
    {overlay?.kind === "rename" && <ConversationRename key={overlay.sessionId} initialTitle={overlay.title}
      onSave={title=>commands.renameSession({sessionId:overlay.sessionId,title})} onClose={closeOverlay}/>}
    </div>
    {prompt && <ExtensionPrompt key={prompt.id} prompt={prompt}
      onAnswer={(value, cancelled = false) => safely(commands.answerPlugin(prompt, value, cancelled).then(commands.refresh))} />}
    {toast && <div className="toast" role="status">{toast}</div>}
  </div>;
}
