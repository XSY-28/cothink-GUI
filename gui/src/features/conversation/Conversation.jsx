import {OutcomeFiles} from "../files/FilePanel.jsx";
import React, {useEffect,useRef,useState} from "react";
import { Composer } from "../../Composer.js";
import {Icon} from "../../Icon.js";
import { Markdown } from "../../Markdown.js";
import { ReplyHeading } from "./ReplyHeading.jsx";
import { ConversationHeading } from "./ConversationMenu.jsx";
import { FileContinuation, ReplyActions, StopButton, UserMessage, WorkProposal } from "./ReplyActions.jsx";
import { useConversationReading } from "./useConversationReading.js";
import {conversationThinking} from "../../view.js";
import styles from "./Conversation.module.css";

export function Conversation({state, workspace, commands, inert, showNotes, onHideNotes,
  onSettings, onPlugins, onToggleNavigation, onWorkspaceMenu, onConversations, onRoster, onAttention, onFork, onOpenFile, onOpenDetails, onNotes, onCopy, onLocalCommand, onConversationMenu, onChooseProjectFiles,
  onChooseSkill, onPreviewMaterial, onRetryMaterial, onOpenTurnLimits, conversationMenuTrigger, firstRun, onCreateTeam}) {
  const {bootstrap: boot, task, draft, ready, submitting, pending, pendingStatus} = state;
  const session = workspace?.archived && state.session ? {...state.session,workspaceArchived:true,readOnly:true} : state.session;
  const replyTeamId = session?.workspaceId && !session.workspaceError &&
    session.id === state.selectedSessionId && workspace?.id === session.workspaceId
    ? session.workspaceId : null;
  const [targetTeam,setTargetTeam]=useState("");
  const [now,setNow]=useState(Date.now());
  const timing = session?.turns.some(turn=>["running","preparing","cancelling"].includes(turn.status));
  useEffect(()=>{if(!timing)return;setNow(Date.now());const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[timing,session?.id]);
  const teamName = workspace?.name || (state.workspaceId === null ? "未分组对话" : "归属待核对");
  const error = state.errors[0] || "";
  const {openSession, refresh, setError, abandonSubmission} = commands;
  const safely = operation => Promise.resolve(operation).catch(e => setError(e.message));
  const stop = <StopButton stopping={state.stopping} activeStatus={boot.active?.status} onClick={()=>safely(commands.cancelTask())} />;
  const recoverPending = () => commands.recoverSubmission();
  const editDraft = text => commands.setDraft(session?.id, text);
  const submit = async (options) => {
    if (!session && state.homeReady && !/^\/(?:team|models|settings|help)$/u.test(draft.trim())) {
      onCreateTeam?.();
      return;
    }
    const result = await commands.submit({sessionId:session?.id,...options});
    if(result?.local) {
      if(onLocalCommand)onLocalCommand(result.local);
      else if(result.local==="team"||result.local==="models")onSettings?.("teams");
    }
    return result;
  };
  const {scroll,onScroll} = useConversationReading({session,inert,readingPosition:state.readingPosition,recordView:commands.recordView});
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
          <ConversationHeading teamName={teamName} sessionTitle={session?.title} homeReady={state.homeReady}
            onWorkspaceMenu={onWorkspaceMenu} onConversationMenu={onConversationMenu} conversationMenuTrigger={conversationMenuTrigger} />
          <div className={styles.headerActions}>
            <button className="conversation-picker-trigger" onClick={onConversations}><Icon name="conversations" />对话</button>
            <button className={styles.teamButton} aria-label="阵容" onClick={onRoster} title={session?.team?.name || "查看阵容"}><Icon name="team" />{session?.team?.name || "阵容"}</button>
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
        {session?.projectDirectoryAvailable===false && <p className={styles.contextNote}>保存的目录不可用。可以继续聊天；本次项目资源和文件读取不可用。</p>}
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
              <small>可浏览历史，草稿不会排队</small>
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
            {stop}
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
            <span>{error.split("\n")[0]}</span>
            {error.includes("\n")&&<details className={styles.errorDetails}><summary>展开诊断</summary><pre>{error}</pre></details>}
            {onLocalCommand&&/命令/.test(error)&&<button onClick={()=>onLocalCommand("help")}>可用命令</button>}
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
                {!ready || state.navigationLoading ? <p>正在读取…</p> : error ? <p>请先核对上方提示，已保存的 Team 和历史会保留。</p> : state.workspaceId === undefined ? <p>Team 归属暂时无法确认。请从左侧选择 Team，或搜索已保存的对话。</p> : firstRun ? <>
                  <h2>从一件想做的事开始</h2>
                  <p>一个 Team 对应一个项目，可以在里面开多条对话。</p>
                  <button type="button" className="primary" onClick={onCreateTeam}>创建我的第一个 Team</button>
                </> : <>
                  <h2>{workspace ? "继续这个 Team 的工作" : "从一件想做的事开始"}</h2>
                  <p>{workspace ? "这个 Team 还没有可打开的对话。从‘对话’中新建，或查找已归档对话。" : "直接输入即可开始，也可搜索已保存的对话。"}</p>
                  <button onClick={onConversations}>打开对话</button>
                </>}
              </section>
            ) : (
              session.turns.map((turn) => {
                const inProgress = ["running", "preparing", "cancelling"].includes(turn.status);
                const canStop = (inProgress || state.stopping?.status === "stop_unknown") && boot.active?.status !== "preparing" && boot.active?.taskId === turn.taskId;
                const failedModel = session.turns.length===1 && !session.readOnly ? turn.failedModel : null;
                return (
                <section
                  className={styles.turn}
                  id={"turn-"+turn.taskId}
                  tabIndex={-1}
                  key={turn.taskId}
                >
                  <div className={styles.turnInput} data-task-id={turn.taskId} data-reading-part="input" tabIndex={-1}>
                    <UserMessage turn={turn} onCopy={onCopy} />
                  </div>
                  <article className={styles.answer} data-task-id={turn.taskId} data-reading-part="result" data-result-revision={turn.resultRevision || undefined} tabIndex={-1}>
                    <ReplyHeading turn={turn} now={now} teamId={replyTeamId}>
                      {canStop && stop}
                    </ReplyHeading>
                    {["partial","cancelled","failed","outcome_unknown","stop_unknown"].includes(turn.status) && <p className={styles.incompleteAnswer}>{turn.status === "stop_unknown" ? "停止结果未确认。" : turn.status === "outcome_unknown" ? "请求结果未知，不会自动重发。" : turn.status === "cancelled" ? "已停止。已完成的内容保留。" : "本次未完整完成。已有成果文件会列在下方。"}</p>}
                    {!turn.proposalRef&&!inProgress&&(turn.error || (task?.id===turn.taskId && task.error))&&<p className="error-text">{turn.error || task.error}</p>}
                    {failedModel && <div className={styles.incompleteAnswer}>
                      <p>请求失败的模型 <strong>{failedModel.provider} / {failedModel.modelId}</strong></p>
                      <div className={styles.answerActions}>
                        <button type="button" onClick={()=>onSettings("providers")}>检查模型与认证</button>
                        <button type="button" onClick={onRoster}>更换阵容</button>
                      </div>
                    </div>}
                    {turn.proposalRef ? <WorkProposal turn={turn} disabled={!!boot.active||!!pending||session.readOnly}
                      onConfirm={()=>safely(commands.confirmWork(turn))} /> : turn.finalText ? (
                      <div className="prose">
                        <TurnMarkdown text={turn.finalText} sessionId={session.id} taskId={turn.taskId} resolveImage={commands.resolveImage}
                          onPreview={(preview,event)=>onOpenDetails(turn.taskId,"reply-preview",event,preview)} />
                      </div>
                    ) : !inProgress && (
                      <div className={styles.incompleteAnswer}>
                        <p>这轮没有完整最终稿。执行记录保留已取得的内容；可交付文件以本条文件清单为准。</p>
                      </div>
                    )}
                    {turn.hasWork && <OutcomeFiles taskId={turn.taskId} status={turn.status} resultRevision={turn.resultRevision} commands={commands} onOpen={onOpenFile}/>}
                    {boot.protocol?.fileContinuation===1 && turn.hasWork && !inProgress && !turn.proposalRef &&
                      ["partial","failed","outcome_unknown","stop_unknown"].includes(turn.status) &&
                      <FileContinuation turn={turn} disabled={!!boot.active||!!pending||session.readOnly||!!session.selectionError}
                        onInspect={commands.inspectFileContinuation} onContinue={commands.continueFileWork}/>}
                    <ReplyActions turn={turn} forkDisabled={!!boot.active || !!pending || session.readOnly || !!session.selectionError || !turn.canFork}
                      showChanges={turn.hasWork || task?.id === turn.taskId && task.work}
                      onDetails={onOpenDetails} onCopy={onCopy} onFork={taskId=>safely(onFork(taskId))} />
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
          {session?.workspaceId===null && <p role="status">
            未分组历史可查阅和复制。要继续，请在 Team 内新建对话，再带入需要的内容。
            {session.draft && <button type="button" onClick={()=>onCopy(session.draft)}>复制原草稿</button>}
            <button type="button" onClick={onCreateTeam}>新建 Team</button>
          </p>}
          {!state.homeReady && state.homeDraft && <p role="status"><button type="button" onClick={commands.showHome}>返回首页草稿</button></p>}
          {state.homeReady && state.homeDraft && !state.homeDraft.pendingCreateSessionId && (boot.workspaces??[]).some(row=>row.project&&!row.archived) &&
            <p>
              <select aria-label="草稿目标 Team" value={targetTeam} onChange={event=>setTargetTeam(event.target.value)} disabled={state.creating}>
                <option value="">选择 Team</option>
                {(boot.workspaces??[]).filter(row=>row.project&&!row.archived).map(row=><option key={row.id} value={row.id}>{row.name}</option>)}
              </select>{" "}
              <button type="button" disabled={!targetTeam||state.creating} onClick={()=>safely(commands.transferHome({workspaceId:targetTeam}))}>把草稿带到新对话</button>
            </p>}
          {state.creating && <p role="status">正在确认新对话，当前草稿保留…</p>}
          {(state.creationNotice || state.homeReady && state.homeDraft?.pendingCreateSessionId) && <p role="status">
            创建待确认 · {state.creationNotice?.sessionId ?? state.homeDraft?.pendingCreateSessionId}{" "}
            <button type="button" disabled={state.creating} onClick={()=>safely(commands.recoverCreation())}>查询原会话</button>
          </p>}
          {!session && boot.homeDraftError && <p className="error-text" role="alert">{boot.homeDraftError}</p>}
          <Composer
            session={session}
            homeReady={state.homeReady}
            creating={state.creating}
            homeCreationPending={!!(state.homeReady && state.homeDraft?.pendingCreateSessionId)}
            boot={boot}
            draft={draft}
            draftConflict={state.draftConflict}
            onResolveDraft={choice=>safely(commands.resolveDraft(session?.id,choice))}
            onDraft={editDraft}
            turnOptions={state.turnOptions} onTurnOptions={change=>commands.setTurnOptions(session?.id,change)}
            onOpenTurnLimits={onOpenTurnLimits}
            onSubmit={submit}
            busy={!!boot.active || !!boot.extensionUI?.command || !!boot.shutdown?.requested || state.connection === "reconnecting"}
            submitting={submitting}
            pending={!!pending}
            connection={state.connection}
            thinking={{...conversationThinking(session,boot.models),save:state.thinkingSave}}
            onThinkingChange={level=>safely(commands.changeSession("session.thinking",{scope:"all",level},session.id))}
            onThinkingRecover={options=>safely(commands.recoverThinkingSettings(options))}
            onPlugins={onPlugins}
            editorKey={state.editorKey??session?.id}
            materials={state.materials}
            materialCapabilities={state.materialCapabilities}
            materialError={state.materialError??session?.materialError??state.homeDraft?.materialError}
            onImportMaterials={state.materialCapabilities?commands.addMaterials:undefined}
            onRemoveMaterial={commands.removeMaterial?item=>safely(commands.removeMaterial(item.status==="ready"?item.id:item.uploadId??item.id)):undefined}
            onPreviewMaterial={onPreviewMaterial}
            onRetryMaterial={onRetryMaterial}
            onChooseProjectFiles={onChooseProjectFiles}
            onChooseSkill={onChooseSkill}
            selectedSkill={state.selectedSkill}
            onRemoveSkill={commands.removeSkill}
            onSettings={() => onSettings("teams")}
            workRequest={state.workRequest} onWorkRequest={value=>commands.setWorkRequest(session?.id,value)}
          />
        </div>
      </main>
  );
}

function TurnMarkdown({text,sessionId,taskId,resolveImage,onPreview}) {
  const latest=useRef(resolveImage);
  latest.current=resolveImage;
  const resolve=React.useCallback(src=>latest.current({sessionId,taskId,src}),[sessionId,taskId]);
  return <Markdown text={text} foldCode onPreview={onPreview} resolveImage={resolveImage?resolve:undefined}/>;
}
