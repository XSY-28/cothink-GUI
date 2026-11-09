import React from "react";
import {Icon} from "../../Icon.js";
import styles from "./Conversation.module.css";

function ReplyAction({icon, label, onClick, disabled, description}) {
  return <span className={styles.replyAction}>
    <button type="button" aria-label={label} aria-description={description} onClick={onClick} disabled={disabled}>
      <Icon name={icon} />
    </button>
    <span className={styles.replyTooltip} role="tooltip" aria-hidden="true">{label}</span>
  </span>;
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
