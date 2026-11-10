import React from "react";
import {Modal} from "../../Modal.jsx";

export function NewConversationDialogs({overlay, workspace, session, draft, creating, conflict, onCreate, onClose, onHome}) {
  if (!["new-conversation","use-project-directory"].includes(overlay?.kind)) return null;
  const handoff = overlay.kind === "use-project-directory";
  const ready = workspace?.project && workspace.project === overlay.project && workspace.projectAvailable !== false;
  const busy = overlay.busy || creating;
  return <Modal title={handoff ? "使用 Team 目录" : "新对话"} onClose={onClose}>
    <div className="dialog-body">
      {handoff ? ready ? <>
        <p>当前对话目录：{session?.project || "未关联"}</p>
        <p>Team 默认目录</p>
        <p className="workspace-directory">{workspace.project}</p>
        <p>{draft ? "只复制草稿文字。原对话、附件与文件权限仍留在原处。"
          : "将在这个目录新建对话。原对话保持原目录。"}</p>
        {conflict && <p role="alert">先处理当前草稿的保存冲突，再复制草稿。</p>}
        <button className="primary" disabled={busy || conflict} onClick={()=>onCreate(workspace.id)}>
          {draft ? "新建并复制草稿" : "在此目录新建对话"}
        </button>
      </> : <p role="status">Team 默认目录已变化或不可用，请关闭后重新核对。</p> : <>
        <p>{workspace ? `将在 ${workspace.name} 中新建对话。` : overlay.workspaceId ? "所选 Team 已不可用，请另选范围。" : "将新建未分组对话。"}</p>
        <div className="form-actions">
          {(!overlay.workspaceId || workspace) && <button className="primary" disabled={busy} onClick={()=>onCreate(overlay.workspaceId??null)}>
            {workspace ? `在 ${workspace.name} 新建` : "新建未分组对话"}
          </button>}
          {overlay.workspaceId && <button disabled={busy} onClick={()=>onCreate(null)}>新建未分组对话</button>}
          {onHome && <button disabled={busy} onClick={onHome}>返回首页草稿</button>}
        </div>
      </>}
      {overlay.error && <p className="error-text" role="alert">{overlay.error}</p>}
    </div>
  </Modal>;
}
