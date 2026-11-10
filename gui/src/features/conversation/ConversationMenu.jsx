import React, {useRef} from "react";
import {Modal} from "../../Modal.jsx";
import {TurnLimits} from "./TurnLimits.jsx";
import styles from "./Conversation.module.css";

function ConversationMenu({session, homeDraft, onRename, onOrganize, onOpenTurnLimits, onClose}) {
  return <Modal title="对话操作" onClose={onClose}>
    <div className="dialog-body">
      {session || homeDraft ? <>
        <p className="workspace-directory">{session?.title ?? "首页草稿"}</p>
        {session?.project && <p className="workspace-directory">{session.project}</p>}
        <div className="form-actions">
          {session && <button type="button" disabled={session.readOnly} onClick={()=>onRename(session)}>重命名对话</button>}
          {onOpenTurnLimits && <button type="button" aria-haspopup="dialog" onClick={()=>onOpenTurnLimits()}>下一条消息的限制</button>}
          {onOrganize && <button type="button" onClick={onOrganize}>整理上下文…</button>}
        </div>
      </> : <p role="status">原对话当前不可用。</p>}
    </div>
  </Modal>;
}

export function ConversationHeading({teamName, sessionTitle, homeReady, onWorkspaceMenu, onConversationMenu, conversationMenuTrigger}) {
  const title = sessionTitle || (homeReady ? "首页草稿" : null);
  return <h1 className={styles.workspaceHeading}>
    <button onClick={onWorkspaceMenu} title={teamName}>{teamName}</button>
    {title && <><span className={styles.headingSeparator} aria-hidden="true">/</span>
      <span className={styles.currentTitle} title={`${teamName} / ${title}`}>
        {onConversationMenu ? <button ref={conversationMenuTrigger} onClick={onConversationMenu}
          aria-label={`对话操作：${title}`} aria-haspopup="dialog">{title}</button> : title}
      </span></>}
  </h1>;
}

export function useConversationActions(state, workspace, setOverlay) {
  const {session, selectedSessionId, homeReady, homeDraft, submitting, pending, creating} = state;
  const conversationMenuTrigger = useRef(null);
  const canEditTurnLimits = !submitting && !pending && !creating && (session
    ? !workspace?.archived && !session.navigation?.archived && !session.navigationError && !session.readOnly && !session.selectionError && !session.contextOrganizing
    : homeReady && !homeDraft?.pendingCreateSessionId);
  // The home editor stays the same when its first save assigns a persisted ID.
  const editorScope = selectedSessionId ?? (homeReady ? "home" : null);
  return {editorScope, canEditTurnLimits, controls: {
    conversationMenuTrigger,
    onConversationMenu: session || homeReady ? () => setOverlay({kind:"conversation-menu",editorScope}) : undefined,
    onOpenTurnLimits: canEditTurnLimits ? opener => setOverlay({kind:"turn-limits",editorScope,opener}) : undefined,
  }};
}

export function ConversationActionDialogs({state, overlay, actions, setOverlay, onRename, onClose, onChangeTurnLimits, onOrganize}) {
  const {bootstrap, session, homeReady, turnOptions} = state;
  const {editorScope, canEditTurnLimits, controls} = actions;
  const currentEditor = editorScope!==null && overlay?.editorScope===editorScope;
  const canOrganize = !!(session?.team && session.turns?.length && !session.readOnly && !session.selectionError && !state.draftConflict &&
    !state.pending && !state.submitting && !bootstrap.active && !bootstrap.extensionUI?.command && state.connection==="connected");
  if (overlay?.kind==="conversation-menu") return <ConversationMenu session={currentEditor ? session : null} homeDraft={currentEditor && homeReady}
    onRename={onRename} onClose={onClose}
    onOpenTurnLimits={currentEditor ? controls.onOpenTurnLimits : undefined}
    onOrganize={currentEditor && canOrganize ? ()=>setOverlay({kind:"organize-context",sessionId:session.id}) : undefined} />;
  if (overlay?.kind==="turn-limits") return <TurnLimits available={currentEditor && canEditTurnLimits} team={session?.team} models={bootstrap.models}
    options={turnOptions} onChange={onChangeTurnLimits} onClose={onClose}
    returnFocusTo={()=>overlay.opener?.isConnected ? overlay.opener : controls.conversationMenuTrigger.current} />;
  if (overlay?.kind==="organize-context") return <Modal title="整理上下文" onClose={onClose}>
    <div className="dialog-body">
      <p>手动整理通常需要 1 次模型请求；分段整理最多 2 次，按实际使用计费。原文可追溯，当前草稿保留。</p>
      <p>{turnOptions?.maxCalls ? `本次请求上限：${turnOptions.maxCalls} 次。` : "本次未设更低的请求上限。"}</p>
      <button className="primary" disabled={!canOrganize || session?.id!==overlay.sessionId} onClick={()=>{onClose();onOrganize();}}>确认整理并调用模型</button>
    </div>
  </Modal>;
  return null;
}
