import React from "react";
import {Modal} from "../../Modal.jsx";

export function ConversationMenu({session, onRename, onOrganize, onPrepareProject, onClose}) {
  const needsPreparation = session?.project && session.projectDirectoryAvailable !== false &&
    session.projectStatus?.executionReady === false;

  return <Modal title="对话操作" onClose={onClose}>
    <div className="dialog-body">
      {session ? <>
        <p className="workspace-directory">{session.title}</p>
        <div className="form-actions">
          <button type="button" disabled={session.readOnly} onClick={()=>onRename(session)}>重命名对话</button>
          {onOrganize && <button type="button" onClick={onOrganize}>整理上下文…</button>}
          {needsPreparation && <button type="button"
            onClick={()=>onPrepareProject(session.project,session.projectStatus.preparation)}>准备文件工作</button>}
        </div>
        {needsPreparation && <p className="field-note">修改文件或运行检查前，可为这个对话的目录建立 Git 起点。</p>}
      </> : <p role="status">原对话当前不可用。</p>}
    </div>
  </Modal>;
}
