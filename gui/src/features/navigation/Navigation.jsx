import React, {useState,useRef} from "react";
import {Icon} from "../../Icon.js";
import styles from "./Navigation.module.css";

export function SessionRow({session, selected, onOpen, commands, onChanged, active}) {
  const menu = useRef(null);
  const running = active?.sessionId === session.id;
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
      <button title={session.title} className={`${styles.historyItem} ${selected ? styles.selected : ""}`}
        aria-current={selected ? "page" : undefined} onClick={open}>
        <span>{session.title}</span>
        {(session.navigation?.archived || session.workspaceArchived) ? <small>已归档</small> : session.readOnly && <small>只读</small>}
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

export function Navigation({workspaces, workspaceId, ready, mobileOpen, onOpenWorkspace, onSearch, onCreate,
  onSettings, connection, updateLabel, inert}) {
  const active = workspaces?.filter(item=>!item.archived) ?? [];
  return <nav className={`sidebar ${styles.sidebar} ${mobileOpen ? "mobile-open" : ""}`}
    aria-label="工作导航" inert={inert}>
    <div className={styles.windowSpace} aria-hidden="true" />
    <div className={styles.actions}>
      <button onClick={onSearch} aria-label="搜索" title="搜索"><Icon name="search" /></button>
      <button className={styles.createTeam} disabled={!ready || workspaces === null} onClick={onCreate} aria-label="新建 Team"><Icon name="plus" /><span>新建 Team</span></button>
    </div>
    <div className={styles.historyScroll}>
      {workspaces === null ? <p className={styles.empty} role="alert">工作列表暂不可用，已有对话仍可读取。</p>
        : !ready ? <p className={styles.empty}>正在读取…</p>
        : !active.length && connection === "connected" ? <p className={styles.empty}>{workspaces?.length ? "暂无活动 Team。已归档 Team 可在搜索或设置中恢复。" : "创建第一个 Team，开始持续的工作。"}</p> : null}
      {active.map(row=>{
        const duplicate = row.project && active.some(other=>other.id !== row.id && other.name === row.name);
        const hint = row.project?.split(/[\\/]/).filter(Boolean).slice(-2).join("/");
        return <div key={row.id} className={`${styles.workspaceEntry} ${workspaceId === row.id ? styles.selected : ""}`}>
          <button className={styles.workspaceRow}
          title={duplicate ? row.project : row.name} aria-current={workspaceId === row.id ? "page" : undefined}
          onClick={()=>onOpenWorkspace(row)}>
          <span>{row.name}</span>
          {row.attention && <small>{attentionLabels[row.attention.kind]}</small>}
          {duplicate && <small className={styles.pathHint}>{hint}</small>}
          </button>
        </div>;
      })}
    </div>
    <div className={styles.bottom}><button onClick={onSettings} aria-label="设置" aria-description={updateLabel || undefined}><Icon name="settings" /><span>设置</span>{updateLabel && <small className={styles.updateBadge}>{updateLabel}</small>}</button></div>
    {connection !== "connected" && <p className={styles.connection} role="status">
      {connection === "connecting" ? "正在连接本机" : "连接中断 · 正在重连"}</p>}
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
  return <div className={styles.picker}>
    {!global && <button className="primary" disabled={!canCreate} onClick={onCreateSession}><span aria-hidden="true">＋ </span>新建对话</button>}
    {unknown ? <p className={styles.empty}>归属待核对。请从左侧选择工作，或搜索并打开健康的对话后再新建。</p> : <>
    <label className={styles.search}>
      <span className="sr-only">{global ? "搜索工作和对话" : "搜索当前工作中的对话"}</span>
      <input placeholder={global ? "搜索名称、对话或文件…" : "搜索此处的对话…"} maxLength={200}
        value={loaded ? navigationQuery.query : ""} onChange={event=>commands.searchSessions({query:event.target.value,scope})} />
    </label>
    <label className={styles.archiveFilter}><input type="checkbox" checked={loaded && navigationQuery.includeArchived}
      onChange={event=>commands.searchSessions({includeArchived:event.target.checked,scope})}/>包含归档</label>
    <div className={styles.pickerRows}>
      {matches.map(row=><button key={row.id} className={styles.workspaceRow} onClick={()=>onOpenWorkspace(row)}>
        <span>{row.name}</span>{row.archived && <small>已归档</small>}
      </button>)}
      {rows.map(row=><div key={row.id}>
        {global && <div className={styles.matchOwner}>{names.find(item=>item.id === row.workspaceId)?.name || (row.workspaceId === null ? "未分组" : "归属待核对")}</div>}
        <SessionRow session={row} selected={row.id === selectedSessionId} onOpen={onOpenSession} commands={global ? undefined : commands} active={state.bootstrap.active} />
      </div>)}
      {!matches.length && !rows.length && <p className={styles.empty}>{state.navigationLoading ? "正在读取…" : navigationQuery.query ? "没有匹配结果。" : "暂无可显示的对话。"}</p>}
      {loaded && nextCursor && <button onClick={()=>commands.loadSessions({more:true})}>加载更多</button>}
    </div>
    </>}
  </div>;
}
