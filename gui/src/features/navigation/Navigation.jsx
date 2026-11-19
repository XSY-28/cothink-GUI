import React, {useCallback,useEffect,useId,useState,useRef} from "react";
import {Icon} from "../../Icon.js";
import {Modal} from "../../Modal.jsx";
import {SidebarTeamAvatar,teamAvatarFor} from "../avatars/TeamAvatar.jsx";
import styles from "./Navigation.module.css";

export function SessionRow({session, selected, onOpen, commands, onChanged, active}) {
  const menu = useRef(null);
  const running = session.running || active?.sessionId === session.id;
  const lastActivity=session.updatedAt&&new Date(session.updatedAt);
  const dated=lastActivity&&Number.isFinite(lastActivity.getTime());
  const activityLabel=dated?new Intl.DateTimeFormat("zh-CN",{year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}).format(lastActivity):null;
  const statuses=[session.hasDraft&&"有草稿",running&&"运行中",
    (session.navigation?.archived||session.workspaceArchived)?"已归档":session.readOnly&&"只读"].filter(Boolean);
  const summary=session.summary?.trim().replace(/\s+/g," ");
  const [busy,setBusy] = useState(false), [error,setError] = useState("");
  async function change(field, value) {
    setBusy(true); setError("");
    try {
      if (field === "close") await commands.closeSession(session.id);
      else await commands.setSessionNavigation({sessionId:session.id,expectedRevision:session.navigation.revision,change:{[field]:value}});
      if (menu.current) {menu.current.open=false; menu.current.querySelector("summary")?.focus();}
      await onChanged?.();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  const open=()=>onOpen(session.id,session.match?.taskId,session.match?.fileRef,session.match?.field);
  return <div className={styles.rowWrap}>
    <div className={styles.row}>
      <button title={session.title} aria-label={session.title} aria-description={[summary,activityLabel,...statuses].filter(Boolean).join(" · ")||undefined} className={`${styles.historyItem} ${selected ? styles.selected : ""}`}
        aria-current={selected ? "page" : undefined} onClick={open}>
        <span>{session.title}</span>
        {summary&&<small className={styles.rowSummary}>{summary}</small>}
        {(activityLabel||statuses.length>0)&&<small className={styles.rowMeta}>
          {activityLabel&&<time dateTime={session.updatedAt} title={session.updatedAt}>{activityLabel}</time>}
          {statuses.length>0&&<span>{statuses.join(" · ")}</span>}
        </small>}
      </button>
      {commands && <details ref={menu} className={styles.menu} onKeyDownCapture={event=>{if(event.key === "Escape" && menu.current?.open){event.preventDefault();event.stopPropagation();menu.current.open=false;menu.current.querySelector("summary")?.focus();}}}>
        <summary aria-label={`${session.title}的菜单`}>⋯</summary>
        <div>
          {commands.requestRename && <button disabled={busy || session.readOnly || !!session.navigation?.archived} onClick={()=>{menu.current.open=false;commands.requestRename(session);}}>重命名</button>}
          {session.readOnly && <p className={styles.menuNote}>当前只读，解除占用或修复历史后再管理。</p>}
          {running && <p className={styles.menuNote}>任务进行中，请结束后归档。</p>}
          {!session.persisted ? <button disabled={busy || session.readOnly || running} onClick={()=>change("close")}>关闭空白页</button> : <>
            <button disabled={busy || !!session.navigationError || session.readOnly} onClick={()=>change("pinned",!session.navigation?.pinned)}>{session.navigation?.pinned ? "取消置顶" : "置顶"}</button>
            <button disabled={busy || !!session.navigationError || !!session.workspaceArchived || (session.readOnly && !session.navigation?.archived) || running} onClick={()=>change("archived",!session.navigation?.archived)}>{session.navigation?.archived ? "恢复对话" : "归档对话"}</button>
          </>}
        </div>
      </details>}
    </div>
    {session.match && <button className={styles.snippet} onClick={open}>{session.match.snippet}</button>}
    {(error || session.navigationError) && <p className={styles.rowError} role="alert">{error || session.navigationError}</p>}
  </div>;
}

const attentionLabels = {needs_attention:"需处理",unread:"有新结果",running:"运行中"};
const teamNameDelay = 2000;

function workspaceDirectoryHint(row, rows) {
  const sameName = rows.filter(other => other.id !== row.id && other.name === row.name);
  if (!sameName.length) return null;
  if (!row.project) return "未关联目录";
  const pathParts = path => path.split(/[\\/]/).filter(Boolean);
  const own = pathParts(row.project);
  const others = sameName.filter(other => other.project).map(other => pathParts(other.project));
  for (let count = Math.min(2,own.length); count <= own.length; count++) {
    const suffix = own.slice(-count).join("/");
    if (others.every(parts => parts.slice(-count).join("/") !== suffix)) return suffix;
  }
  return row.project;
}

export function Navigation({workspaces, workspaceId, ready, mobileOpen, onOpenWorkspace, onSearch, onCreate, onNewConversation,
  onSettings, connection, updateLabel, inert}) {
  const active = workspaces?.filter(item=>!item.archived) ?? [];
  const currentTeam=active.find(row=>row.id===workspaceId);
  const newScope=currentTeam?.name||"未分组";
  const canCreateConversation = ready && !!onNewConversation;
  const canCreateTeam = ready && workspaces !== null && !!onCreate;
  const createId = useId();
  const createArea = useRef(null), createButton = useRef(null);
  const [createOpen, setCreateOpen] = useState(false);
  const hover = useRef(null);
  const [hovered, setHovered] = useState(null);
  const labeledTeam = hovered?.labelTop != null && !inert
    ? active.find(row=>row.id===hovered.id) : null;
  const labelHint = labeledTeam && workspaceDirectoryHint(labeledTeam,active);
  const labelAttention = labeledTeam && attentionLabels[labeledTeam.attention?.kind];

  useEffect(() => {
    if (!createOpen) return;
    if (inert || (!canCreateConversation && !canCreateTeam)) {
      setCreateOpen(false);
      return;
    }
    const area = createArea.current;
    const doc = area.ownerDocument;
    area.querySelector('[role="group"] button:not(:disabled)')?.focus();
    const outside = event => {
      if (!area.contains(event.target)) setCreateOpen(false);
    };
    doc.addEventListener("pointerdown",outside,true);
    return () => doc.removeEventListener("pointerdown",outside,true);
  }, [createOpen,inert,canCreateConversation,canCreateTeam]);

  function chooseCreate(action) {
    createButton.current?.focus();
    setCreateOpen(false);
    action();
  }

  const stopHover = useCallback(() => {
    const current = hover.current;
    if (!current) return;
    hover.current = null;
    current.dispose();
    setHovered(null);
  }, []);
  useEffect(() => () => hover.current?.dispose(), []);
  useEffect(() => {
    if (inert || (hover.current && !hover.current.target.isConnected)) stopHover();
  }, [inert, workspaces, stopHover]);

  function startHover(event, id) {
    const target = event.currentTarget;
    const doc = target.ownerDocument;
    const win = doc.defaultView;
    if (event.pointerType !== "mouse" || doc.hidden || target.closest("[inert]")) return;
    stopHover();
    const listeners = new win.AbortController();
    const options = {signal:listeners.signal};
    const current = {target, x:event.clientX, y:event.clientY};
    function placeLabel() {
      const rect = target.getBoundingClientRect();
      const rail = target.closest("nav").getBoundingClientRect();
      setHovered({id,labelTop:rect.top - rail.top + rect.height / 2});
    }
    function checkHover() {
      if (hover.current !== current) return false;
      if (!target.isConnected || doc.hidden || target.closest("[inert]") ||
          !target.contains(doc.elementFromPoint(current.x,current.y))) {
        stopHover();
        return false;
      }
      if (current.labelVisible) placeLabel();
      return true;
    }
    const timer = win.setTimeout(() => {
      if (!checkHover()) return;
      current.labelVisible = true;
      placeLabel();
    }, teamNameDelay);
    const observer = new win.MutationObserver(checkHover);
    // Desktop close/save can make the body inert without changing Navigation props.
    for (let ancestor = target; ancestor; ancestor = ancestor.parentElement) {
      observer.observe(ancestor,{attributes:true,attributeFilter:["inert"]});
    }
    current.dispose = () => {
      win.clearTimeout(timer);
      listeners.abort();
      observer.disconnect();
    };
    hover.current = current;
    setHovered({id});
    doc.addEventListener("scroll",checkHover,{...options,capture:true,passive:true});
    doc.addEventListener("visibilitychange",stopHover,options);
    win.addEventListener("blur",stopHover,options);
    win.addEventListener("resize",checkHover,options);
  }

  function moveOverAvatar(event) {
    if (event.pointerType !== "mouse" || hover.current?.target !== event.currentTarget) return;
    hover.current.x = event.clientX;
    hover.current.y = event.clientY;
  }

  function leaveAvatar(event) {
    if (hover.current?.target === event.currentTarget) stopHover();
  }

  return <nav className={`sidebar ${styles.sidebar} ${mobileOpen ? "mobile-open" : ""}`}
    aria-label="工作导航" inert={inert}>
    <div className={styles.windowSpace} aria-hidden="true" />
    <div className={styles.historyScroll}>
      {workspaces === null ? <p className={styles.railStatus} role="alert">
        <span aria-hidden="true">列表不可用</span><span className="sr-only">工作列表暂不可用，已有对话仍可读取。</span>
      </p> : !ready ? <p className={styles.railStatus}>正在读取…</p>
        : !active.length && connection === "connected" ? <p className={styles.railStatus}>
          <span aria-hidden="true">暂无 Team</span><span className="sr-only">{workspaces?.length ? "暂无活动 Team。已归档 Team 可在搜索或设置中恢复。" : "创建第一个 Team，开始持续的工作。"}</span>
        </p> : null}
      {active.map(row=>{
        const hint = workspaceDirectoryHint(row,active);
        const attention = attentionLabels[row.attention?.kind];
        const animated = !inert && hovered?.id === row.id;
        return <div key={row.id} className={`${styles.workspaceEntry} ${workspaceId === row.id ? styles.selected : ""}`}>
          <button className={styles.teamRow} aria-label={row.name}
            aria-description={[attention,hint && (row.project ?? hint)].filter(Boolean).join(" · ") || undefined}
            aria-current={workspaceId === row.id ? "page" : undefined}
            onClick={()=>{stopHover();onOpenWorkspace(row);}}>
            <span className={styles.avatarTrigger} aria-hidden="true" data-team-avatar-trigger=""
              onPointerEnter={event=>startHover(event,row.id)} onPointerMove={moveOverAvatar}
              onPointerLeave={leaveAvatar} onPointerCancel={leaveAvatar}>
              <SidebarTeamAvatar avatar={teamAvatarFor(row)} animated={animated} />
            </span>
            {attention && <span className={styles.indicator} data-attention={row.attention.kind} aria-hidden="true" />}
          </button>
        </div>;
      })}
    </div>
    {labeledTeam && <div className={styles.teamLabel} style={{top:hovered.labelTop}} role="tooltip" aria-hidden="true">
      <span>{labeledTeam.name}</span>
      {labelHint && <small>{labelHint}</small>}
      {labelAttention && <small>{labelAttention}</small>}
    </div>}
    <div className={styles.railActions}>
      {connection !== "connected" && <p className={styles.railStatus} role="status">
        {connection === "connecting" ? "连接中…" : "重连中…"}</p>}
      <div className={styles.createArea} ref={createArea}
        onBlur={event=>{if (!event.currentTarget.contains(event.relatedTarget)) setCreateOpen(false);}}
        onKeyDownCapture={event=>{
          if (!createOpen || event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          createButton.current?.focus();
          setCreateOpen(false);
        }}>
        <button type="button" ref={createButton} className={styles.railAction}
          aria-label="新建" title="新建" aria-expanded={createOpen} aria-controls={createOpen ? createId : undefined}
          disabled={!canCreateConversation && !canCreateTeam} onClick={()=>{stopHover();setCreateOpen(!createOpen);}}>
          <Icon name="plus" />
        </button>
        {createOpen && !inert && <div className={styles.createChoices} id={createId} role="group" aria-label="新建选项">
          {onNewConversation && <button type="button" disabled={!canCreateConversation} aria-description={newScope}
            onClick={()=>chooseCreate(()=>onNewConversation(currentTeam?.id??null))}>新对话</button>}
          <button type="button" disabled={!canCreateTeam} onClick={()=>chooseCreate(onCreate)}>新建 Team</button>
        </div>}
      </div>
      <button type="button" className={styles.railAction} onClick={onSearch} aria-label="搜索" title="搜索"><Icon name="search" /></button>
      <button type="button" className={styles.railAction} onClick={onSettings} aria-label="设置"
        aria-description={updateLabel || undefined} title={updateLabel ? `设置 · ${updateLabel}` : "设置"}>
        <Icon name="settings" />
        {updateLabel && <span className={styles.indicator} aria-hidden="true" />}
      </button>
    </div>
  </nav>;
}

/** Global and Team search share the host's filtered, paginated list. */
export function ConversationPicker({state, commands, scope, workspace, busy, onOpenSession, onOpenWorkspace, onCreateSession}) {
  const global = scope === "all";
  const {navigationQuery, workspaceMatches, nextCursor, selectedSessionId} = state;
  const unknown = !global && state.workspaceId === undefined;
  const loaded = !unknown && navigationQuery.scope === scope;
  const canCreate = !busy && !(selectedSessionId && !state.session) && !workspace?.archived && (state.workspaceId === null || !!workspace);
  const rows = loaded ? state.sessions.filter(row=>global || row.workspaceId === state.workspaceId) : [];
  const names = state.bootstrap.workspaces ?? [];
  const matches = global && loaded ? names.filter(row=>workspaceMatches.includes(row.id)) : [];
  const error = loaded ? state.navigationError : null;
  return <div className={styles.picker}>
    {!global && <button className="primary" disabled={!canCreate} onClick={onCreateSession} aria-label="新建对话" aria-description={workspace?.name||"未分组"}><span aria-hidden="true">＋ </span>新建对话 <span className={styles.scopeLabel}>· {workspace?.name||"未分组"}</span></button>}
    {unknown ? <p className={styles.empty}>归属待核对。请从左侧选择工作，或搜索并打开健康的对话后再新建。</p> : <>
    <label className={styles.search}>
      <span className="sr-only">{global ? "搜索工作和对话" : "搜索当前工作中的对话"}</span>
      <input placeholder={global ? "搜索名称、对话或文件…" : "搜索此处的对话…"} maxLength={200}
        value={loaded ? navigationQuery.query : ""} onChange={event=>commands.searchSessions({query:event.target.value,scope})} />
    </label>
    <label className={styles.archiveFilter}><input type="checkbox" checked={loaded && navigationQuery.includeArchived}
      onChange={event=>commands.searchSessions({includeArchived:event.target.checked,scope})}/>包含归档</label>
    <div className={styles.pickerRows}>
      {error && !state.navigationLoading && <div>
        <p className="error-text" role="alert">读取失败：{error.message}</p>
        <button onClick={()=>commands.loadSessions({more:error.more,showProgress:true})}>重试</button>
      </div>}
      {matches.map(row=>{
        const hint = workspaceDirectoryHint(row,matches);
        return <button key={row.id} className={styles.workspaceRow} onClick={()=>onOpenWorkspace(row)}
          aria-label={row.name} aria-description={[hint && (row.project ?? hint),row.archived && "已归档"].filter(Boolean).join(" · ") || undefined}>
          <span>{row.name}</span>{row.archived && <small>已归档</small>}
          {hint && <small className={styles.searchPathHint}>{hint}</small>}
        </button>;
      })}
      {rows.map(row=><div key={row.id}>
        {global && <div className={styles.matchOwner}>{names.find(item=>item.id === row.workspaceId)?.name || (row.workspaceId === null ? "未分组" : "归属待核对")}</div>}
        <SessionRow session={row} selected={row.id === selectedSessionId} onOpen={onOpenSession} commands={global ? undefined : commands} active={state.bootstrap.active} />
      </div>)}
      {state.navigationLoading && <p className={styles.empty} role="status">正在读取…</p>}
      {!error && !state.navigationLoading && !matches.length && !rows.length &&
        <p className={styles.empty}>{navigationQuery.query ? "没有匹配结果。" : "暂无可显示的对话。"}</p>}
      {loaded && !error && nextCursor && <button disabled={state.navigationLoading} onClick={()=>commands.loadSessions({more:true,showProgress:true})}>加载更多</button>}
    </div>
    </>}
  </div>;
}

export function ConversationRename({initialTitle, onSave, onClose}) {
  const [title, setTitle] = useState(initialTitle), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const saving = useRef(false);
  async function submit(event) {
    event.preventDefault();
    if (saving.current) return;
    const value = title.trim();
    if (!value || value.length > 200) {setError("标题需要 1—200 字符。");return;}
    saving.current = true;
    setBusy(true); setError("");
    try {
      await onSave(value);
      onClose();
    } catch (error) {setError(error.message);}
    finally {saving.current=false;setBusy(false);}
  }
  return <Modal title="重命名对话" onClose={()=>{if(!saving.current)onClose();}}>
    <form onSubmit={submit}>
      <label>对话标题<input maxLength={200} value={title} disabled={busy} onChange={event=>{setTitle(event.target.value);setError("");}}/></label>
      <div className="form-actions"><button className="primary" disabled={busy}>保存标题</button></div>
      {error && <p className="error-text" role="alert">{error}</p>}
    </form>
  </Modal>;
}
