import React from "react";
import {Icon} from "../../Icon.js";
import {statusLabel} from "../../view.js";
import styles from "./Conversation.module.css";

function ReplyAction({icon, label, onClick, disabled, description}) {
  return <span className={styles.replyAction}>
    <button type="button" aria-label={label} aria-description={description} onClick={onClick} disabled={disabled}>
      <Icon name={icon} />
    </button>
    <span className={styles.replyTooltip} role="tooltip" aria-hidden="true">{label}</span>
  </span>;
}

export function StopButton({stopping, activeStatus, onClick}) {
  const check = stopping?.status === "stop_unknown";
  const label = check ? "核对停止" : stopping ? statusLabel(stopping.status) : "停止";
  return <button type="button" className="stop-button" disabled={!check && (!!stopping || activeStatus === "cancelling")} onClick={onClick}>{label}</button>;
}

export function WorkProposal({turn, disabled, onConfirm}) {
  const blocker=turn.confirmationBlocker;
  return <>
    <pre className={styles.proposalText}>{turn.finalText}</pre>
    {!turn.confirmationIntent?.consumedByTaskId && <>
      {blocker && <p className="field-note">{blocker}</p>}
      <button type="button" disabled={disabled||!!blocker} onClick={onConfirm}>确认上述计划并执行</button>
    </>}
  </>;
}

export function UserMessage({turn, onCopy}) {
  return <div className={styles.userMessage}>
    <div className={styles.userText}>{turn.input}
      {!!turn.materials?.length && <ul className={styles.sentMaterials} aria-label="已发送材料">
        {turn.materials.map(item=><li key={item.id}>{item.name??"已保存材料"}</li>)}
      </ul>}
    </div>
    {turn.input && onCopy && <div className={styles.messageActions}>
      <ReplyAction icon="copy" label="复制消息" onClick={()=>onCopy(turn.input)} />
    </div>}
  </div>;
}

export function ReplyActions({turn, forkDisabled, showChanges, onDetails, onCopy, onFork}) {
  return <footer className={styles.answerActions}>
    <ReplyAction icon="process" label="查看过程" onClick={event=>onDetails(turn.taskId,"collaboration",event)} />
    {turn.finalText && <ReplyAction icon="copy" label="复制原文" onClick={()=>onCopy(turn.finalText)} />}
    <ReplyAction icon="fork" label="从这里分支" disabled={forkDisabled}
      description="保留截至此条回复的上下文，在新对话中继续" onClick={()=>onFork(turn.taskId)} />
    {showChanges && <button type="button" onClick={event=>onDetails(turn.taskId,"changes",event)}>变更与检查</button>}
  </footer>;
}
