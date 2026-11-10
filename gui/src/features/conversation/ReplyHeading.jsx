import React from "react";
import {elapsedLabel, statusLabel} from "../../view.js";
import {ChatTeamAvatar, teamAvatarFor} from "../avatars/TeamAvatar.jsx";
import styles from "./Conversation.module.css";

export function ReplyHeading({turn, now, teamId, children}) {
  const elapsed = elapsedLabel(turn, now);
  const running = ["running", "preparing", "cancelling"].includes(turn.status);
  const avatar = turn.finalText && teamAvatarFor(teamId);

  return <header className={styles.answerHeading}>
    {avatar && <ChatTeamAvatar key={avatar.id} avatar={avatar} />}
    <span className={styles.elapsed}>
      {elapsed.startsWith("用时") ? elapsed : `${running ? "已用时" : "用时"} ${elapsed}`}
    </span>
    {turn.status !== "completed" && <span className={styles.turnStatus} role={running ? "status" : undefined}>{statusLabel(turn.status)}</span>}
    {children}
  </header>;
}
