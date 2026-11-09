import {OutcomeFiles} from "../files/FilePanel.jsx";
import React, {useEffect,useLayoutEffect,useRef,useState} from "react";
import { Composer } from "../../Composer.js";
import {Icon} from "../../Icon.js";
import { Markdown } from "../../Markdown.js";
import { statusLabel, phaseLabel, elapsedLabel } from "../../view.js";
import styles from "./Conversation.module.css";

export function Conversation({state, workspace, commands, inert, showNotes, onHideNotes,
  onSettings, onPlugins, onToggleNavigation, onWorkspaceMenu, onConversations, onRoster, onAttention, onFork, onOpenFile, onOpenDetails, onNotes, onCopy}) {
  const {bootstrap: boot, task, draft, ready, submitting, pending, pendingStatus} = state;
  const session = workspace?.archived && state.session ? {...state.session,workspaceArchived:true,readOnly:true} : state.session;
  const [now,setNow]=useState(Date.now());
  const timing = session?.turns.some(turn=>["running","preparing","cancelling"].includes(turn.status));
  useEffect(()=>{if(!timing)return;setNow(Date.now());const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[timing,session?.id]);
  const teamName = workspace?.name || (state.workspaceId === null ? "未分组对话" : "归属待核对");
  const error = state.errors[0] || "";
  const {openSession, refresh, setError, abandonSubmission} = commands;
  const safely = operation => Promise.resolve(operation).catch(e => setError(e.message));
  const cancelTask = () => safely(commands.cancelTask());
  const stopLabel = state.stopping ? statusLabel(state.stopping.status) : "停止";
  const recoverPending = () => commands.recoverSubmission();
  const editDraft = text => commands.setDraft(session?.id, text);
  const change = (name, args) => safely(commands.changeSession(name, args));
  const submit = async (options) => {
    const result = await commands.submit({sessionId:session?.id,...options});
    if (result?.local === "team") onSettings("teams");
    return result;
  };
  const copy = onCopy;
  const scroll = useRef(null);
  const reading = useRef({position:null,following:true,seen:new Set()});
  const anchorTimer = useRef(null), writeView = useRef(commands.recordView);
  writeView.current = commands.recordView;
  function recordVisible() {
    const root = scroll.current;
    if (!root || !session || inert || document.visibilityState !== "visible" || root.closest("[inert]") || !root.clientHeight) return;
    const viewport = root.getBoundingClientRect();
    for (const node of root.querySelectorAll("[data-result-revision]")) {
      const box = node.getBoundingClientRect();
      if (box.bottom <= viewport.top || box.top >= viewport.bottom || box.height === 0) continue;
      const {taskId,resultRevision} = node.dataset;
      const key = taskId + resultRevision;
      if (session.view?.seenResults[taskId] === resultRevision || reading.current.seen.has(key)) continue;
      reading.current.seen.add(key);
      void writeView.current(session.id,{seen:{taskId,resultRevision}});
    }
  }
  function onScroll() {
    const root = scroll.current;
    if (!root || !session || inert || document.visibilityState !== "visible") return;
    reading.current.following = root.scrollHeight - root.clientHeight - root.scrollTop <= 36;
    recordVisible();
    const top = root.getBoundingClientRect().top;
    const region = [...root.querySelectorAll("[data-reading-part]")].find(node=>node.getBoundingClientRect().bottom > top);
    if (!region) return;
    const {taskId,readingPart:part} = region.dataset;
    const rect = region.getBoundingClientRect();
    const offsetPx = Math.round(Math.max(0,Math.min(top-rect.top,rect.height,2048)));
    if (anchorTimer.current) clearTimeout(anchorTimer.current.timer);
    const save = () => {void writeView.current(session.id,{anchor:{taskId,part,offsetPx}});};
    anchorTimer.current = {save,timer:setTimeout(()=>{
      anchorTimer.current=null;
      save();
    },250)};
  }
  useLayoutEffect(()=>{
    const root = scroll.current, position = state.readingPosition;
    if (!root || !session || position?.sessionId !== session.id) return;
    if (reading.current.position !== position) {
      const target = position.target;
      const node = target && [...root.querySelectorAll("[data-reading-part]")].find(node=>
        node.dataset.taskId === target.taskId && node.dataset.readingPart === target.part);
      if (target && !node) return;
      reading.current = {position,following:!target,seen:new Set()};
      root.scrollTop = node ? node.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop + target.offsetPx : root.scrollHeight;
      if (node && position.jump) node.focus({preventScroll:true});
    } else if (reading.current.following) root.scrollTop = root.scrollHeight;
  },[session?.id,session?.turns,state.readingPosition]);
  useLayoutEffect(()=>()=>{
    const queued=anchorTimer.current;
    if (!queued) return;
    clearTimeout(queued.timer);
    anchorTimer.current=null;
    queued.save();
  },[session?.id,state.readingPosition]);
  useEffect(()=>{
    if (!session || !scroll.current) return;
    const root=scroll.current;
    const frame=window.requestAnimationFrame(recordVisible);
    const observer=typeof ResizeObserver !== "undefined" ? new ResizeObserver(()=>{
      if (reading.current.following && reading.current.position === state.readingPosition) root.scrollTop=root.scrollHeight;
      recordVisible();
    }) : null;
    if (root.firstElementChild) observer?.observe(root.firstElementChild);
    document.addEventListener("visibilitychange",recordVisible);
    return ()=>{
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      document.removeEventListener("visibilitychange",recordVisible);
    };
  },[session?.id,session?.turns,session?.view,inert,state.readingPosition]);
  return (
      <main className="main-workspace" inert={inert}>
        <header className="topbar" data-desktop={globalThis.window?.cothinkDesktop ? "true" : undefined}>
          <button
            className="icon-button nav-toggle"
            aria-label="切换导航"
            onClick={() => {
              onToggleNavigation();
            }}
          >
            <Icon name="panel" />
          </button>
          <h1 className={styles.workspaceHeading}>
            <button onClick={onWorkspaceMenu} title={teamName}>{teamName}</button>
          </h1>
          <div className={styles.headerActions}>
            <button className="conversation-picker-trigger" onClick={onConversations}><Icon name="conversations" />对话</button>
            <button className={styles.teamButton} onClick={onRoster} title={session?.team?.name || "查看阵容"}><Icon name="team" />阵容</button>
          </div>
        </header>
        {workspace?.archived && <div className="pending-banner" role="status">
          <span>此 Team 已归档。仍可查看历史；继续工作前请先恢复。</span>
          <button onClick={onWorkspaceMenu}>查看 Team</button>
        </div>}
        {workspace?.attention && workspace.attention.kind !== "running" && (workspace.attention.sessionId !== session?.id || workspace.attention.kind === "unread") &&
          <div className="pending-banner" role="status">
            <span>{workspace.attention.kind === "unread" ? "这个 Team 有新结果。" : "这个 Team 有对话需要处理。"}</span>
            <button onClick={onAttention}>{workspace.attention.kind === "unread" ? "查看新结果" : "查看待处理"}</button>
          </div>}
        {session && workspace?.project && !session.project && <p className={styles.contextNote}>当前对话未关联目录。需要使用项目目录时，请新建对话。</p>}
        {session?.forkOf && <div className={styles.forkContext}><span>分支对话</span><button onClick={()=>safely(commands.openSession(session.forkOf.sessionId,session.forkOf.taskId))}>返回来源对话</button></div>}
        {showNotes && <div className={styles.releaseNotice} role="status"><span>CoThink {boot.version} 已安装，有新的本地更新记录。</span><button onClick={onNotes}>查看</button><button aria-label="暂时收起本地更新提示" onClick={onHideNotes}>×</button></div>}
        {boot.active && (boot.active.status === "preparing" || boot.active.sessionId !== session?.id) && (
          <div className="active-banner" role="status">
            <span className="status-dot live" />
            <span>
              {boot.active.status === "preparing" ? "正在准备任务" : "正在执行"} ·{" "}
              {boot.sessions.find((s) => s.id === boot.active.sessionId)
                ?.title || "当前任务"}
              <small>
                {boot.active.sessionId === session?.id &&
                task?.id === boot.active.taskId
                  ? phaseLabel(task.phase)
                  : "可浏览历史，草稿不会排队"}
              </small>
            </span>
            <button
              onClick={() =>
                openSession(boot.active.sessionId, boot.active.status === "preparing" ? undefined : boot.active.taskId).catch(
                  (e) => setError(e.message),
                )
              }
            >
              返回任务
            </button>
            <button className="stop-button" disabled={!!state.stopping} onClick={cancelTask}>{stopLabel}</button>
          </div>
        )}
        {boot.extensionUI?.command && boot.extensionUI.command.sessionId !== session?.id &&
          <div className="pending-banner" role="status"><span>另一对话正在运行插件命令</span>
            <button onClick={() => safely(openSession(boot.extensionUI.command.sessionId))}>返回插件对话</button>
          </div>}
        {state.readingPosition?.jump && session && <p className={styles.contextNote}>正在查看历史对话 · {session.title}</p>}
        {state.readingError && <p className="pending-banner" role="status">{state.readingError} <button onClick={refresh}>重新读取阅读状态</button></p>}
        {state.navigationNotice && <div className="pending-banner" role="status">
          <span>{state.navigationNotice.text}</span>
          {state.navigationNotice.undo && <button onClick={()=>safely(commands.setSessionNavigation(state.navigationNotice.undo))}>撤销归档</button>}
          <button onClick={commands.clearNavigationNotice}>关闭提示</button>
        </div>}
        {session?.navigation?.archived && <div className="pending-banner"><span>此对话已归档，当前只读。恢复后可以继续发送。</span>
          <button disabled={!!workspace?.archived} onClick={()=>safely(commands.setSessionNavigation({sessionId:session.id,expectedRevision:session.navigation.revision,change:{archived:false}}))}>恢复对话</button></div>}
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button
              onClick={() => {
                setError("");
                refresh();
              }}
            >
              重新读取
            </button>
            <button
              className="icon-button"
              aria-label="收起错误提示"
              onClick={() => setError("")}
            >
              ×
            </button>
          </div>
        )}
        {boot.historyErrors?.length > 0 && (
          <details className="history-errors">
            <summary>存在损坏记录，原文件保留；未知提交不会重发</summary><p>可继续打开健康历史。需要修复时保留以下诊断和原文件，再使用备份核对；不要删除记录或重复发送未知任务。</p>
            <pre>{JSON.stringify(boot.historyErrors, null, 2)}</pre>
          </details>
        )}
        {(pending || pendingStatus) && (
          <div className="pending-banner" role="status">
            <span>{pendingStatus || "存在待确认的提交。"}</span>
            {pending && <button onClick={recoverPending}>读取提交记录</button>}
            {pending && !boot.active && (
              <button
                onClick={() => {
                  abandonSubmission();
                }}
              >
                保留草稿并放弃关联
              </button>
            )}
          </div>
        )}
        <div className={styles.conversationScroll} ref={scroll} onScroll={onScroll}>
          <div className={styles.conversationContent}>
            {!session ? (
              <section className={styles.emptyState}>
                {!ready || state.navigationLoading ? <p>正在读取…</p> : error ? <p>请先核对上方提示，已保存的 Team 和历史会保留。</p> : state.workspaceId === undefined ? <p>Team 归属暂时无法确认。请从左侧选择 Team，或搜索已保存的对话。</p> : <>
                  <h2>{workspace ? "继续这个 Team 的工作" : "从一件想做的事开始"}</h2>
                  <p>{workspace ? "这个 Team 还没有可打开的对话。从‘对话’中新建，或查找已归档对话。" : "从左侧新建 Team，或搜索已保存的对话。"}</p>
                  <button onClick={onConversations}>打开对话</button>
                </>}
              </section>
            ) : (
              session.turns.map((turn) => {
                const elapsed = elapsedLabel(turn,now);
                const timing = ["running","preparing","cancelling"].includes(turn.status);
                return (
                <section
                  className={styles.turn}
                  id={"turn-"+turn.taskId}
                  tabIndex={-1}
                  key={turn.taskId}
                >
                  <div className={styles.turnInput} data-task-id={turn.taskId} data-reading-part="input" tabIndex={-1}>

                    <div className={styles.userText}>{turn.input}</div>
                  </div>
                  <article className={styles.answer} data-task-id={turn.taskId} data-reading-part="result" data-result-revision={turn.resultRevision || undefined} tabIndex={-1}>
                    <header className={styles.answerHeading}>
                      <span className={styles.elapsed}>
                        {elapsed.startsWith("用时") ? elapsed : `${timing ? "已用时" : "用时"} ${elapsed}`}
                      </span>
                      <span className={styles.turnStatus}>
                        {statusLabel(turn.status)}
                      </span>
                    </header>
                    {turn.status === "running" && boot.active?.status !== "preparing" && boot.active?.taskId === turn.taskId && <div className={styles.runState} role="status"><span>{phaseLabel(state.tasksById[turn.taskId]?.phase)} · {typeof state.tasksById[turn.taskId]?.usage?.calls === "number" ? `已发 ${state.tasksById[turn.taskId].usage.calls} 次调用` : "调用数尚未汇总"}</span><button className="stop-button" disabled={!!state.stopping} onClick={cancelTask}>{stopLabel}</button></div>}
                    {["partial","cancelled","failed","outcome_unknown","stop_unknown"].includes(turn.status) && <p className={styles.incompleteAnswer}>{turn.status === "stop_unknown" ? "停止结果未确认。请核对已保存的执行记录。" : turn.status === "outcome_unknown" ? "请求结果未知，不会自动重发。请查看此条执行记录核对已保存内容。" : turn.status === "cancelled" ? "已停止。已完成的内容保留，停止不等于回滚；可查看此条执行记录后继续说明下一步。" : "本次未完整完成。请核对已有内容和执行记录；若有成果，文件入口会列在下方。"}</p>}
                    {turn.finalText ? (
                      <div className="prose">
                        <Markdown text={turn.finalText} />
                      </div>
                    ) : (
                      <div className={styles.incompleteAnswer}>
                        <p>
                          {turn.status === "running"
                            ? `${phaseLabel(task?.id === turn.taskId ? task.phase : null)}，完整交付将在结束后显示。`
                            : "这轮没有完整最终稿。执行记录保留已取得的内容；可交付文件以本条文件清单为准。"}
                        </p>
                        {task?.id === turn.taskId && task.error && (
                          <p className="error-text">{task.error}</p>
                        )}
                      </div>
                    )}
                    {turn.proposalRef && !turn.confirmationIntent?.consumedByTaskId && <button disabled={!!boot.active||!!pending||session.readOnly} onClick={()=>safely(commands.confirmWork(turn))}>确认上述计划并执行</button>}
                    {turn.hasWork && <OutcomeFiles taskId={turn.taskId} status={turn.status} commands={commands} onOpen={onOpenFile}/>}
                    <footer className={styles.answerActions}>
                      <button
                        onClick={e => onOpenDetails(turn.taskId, "collaboration", e)}
                      >
                        查看过程{" "}
                        <span aria-hidden="true">↗</span>
                      </button>
                      {turn.finalText && (
                        <button onClick={() => copy(turn.finalText)}>
                          复制原文
                        </button>
                      )}
                      <button disabled={!!boot.active || !!pending || session.readOnly || !!session.selectionError || !turn.canFork}
                        title="保留截至此条回复的上下文，在新对话中继续"
                        onClick={() => safely(onFork(turn.taskId))}>从这里分支</button>
                      {(turn.hasWork || task?.id === turn.taskId && task.work) && (
                        <button onClick={(e) => onOpenDetails(turn.taskId, "changes", e)}>
                          变更与检查
                        </button>
                      )}
                    </footer>
                  </article>
                </section>
              );})
            )}
          </div>
        </div>
        <div className={styles.composerArea}>
          {session && !session.turns.length && <h2 className={styles.composerGreeting}>这次想完成什么？</h2>}
          <div className={styles.pluginFeedback}>
            {boot.extensionUI?.statuses.filter(s => s.sessionId === session?.id).map(s => <p key={s.key} role="status">{s.text}</p>)}
            {boot.extensionUI?.notifications.filter(n => n.sessionId === session?.id).slice(-4).map(n =>
              <p key={n.id} role={n.type === "error" ? "alert" : "status"}>{n.message}</p>)}
          </div>
          <Composer
            session={session}
            boot={boot}
            draft={draft}
            draftConflict={state.draftConflict}
            onResolveDraft={choice=>safely(commands.resolveDraft(session.id,choice))}
            onDraft={editDraft}
            turnOptions={state.turnOptions} onTurnOptions={change=>commands.setTurnOptions(session?.id,change)}
            onSubmit={submit}
            onOrganize={()=>safely(commands.organizeContext())}
            onChange={change}
            busy={!!boot.active || !!boot.extensionUI?.command || !!boot.shutdown?.requested || state.connection === "reconnecting"}
            submitting={submitting}
            pending={!!pending}
            onPlugins={onPlugins}
            onSettings={() => onSettings("teams")}
            workRequest={state.workRequest} onWorkRequest={value=>commands.setWorkRequest(session?.id,value)}
          />
          {boot.releaseNotes?.unread && (
            <button
              hidden={showNotes}
              className={styles.unreadNotes}
              onClick={onNotes}
            >
              查看本次更新
            </button>
          )}
        </div>
      </main>
  );
}
