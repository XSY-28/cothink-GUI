import React, {useEffect, useRef, useState} from "react";
import {Modal} from "./Modal.jsx";

export function ProjectDialog({commands, workspace, projects = [], defaultRoster, onSaved, onOpenExisting, onClose}) {
  const binding = !!workspace;
  const title = binding ? "关联项目目录" : "新建 Team";
  const [name, setName] = useState(""), [path, setPath] = useState("");
  const [result, setResult] = useState(null), [busy, setBusy] = useState(false), [saving, setSaving] = useState(false);
  const [error, setError] = useState(""), [existing, setExisting] = useState(null), [uncertain, setUncertain] = useState(false);
  const request = useRef(0), saveBusy = useRef(false);
  useEffect(()=>()=>{++request.current;},[]);
  async function inspect() {
    const token = ++request.current;
    setBusy(true); setError(""); setExisting(null); setResult(null);
    try {
      const value = await commands.inspectProject(path.trim());
      if (token === request.current) setResult(value);
    } catch (e) {
      if (token === request.current) setError(e.message);
    } finally {
      if (token === request.current) setBusy(false);
    }
  }
  async function save(event) {
    event.preventDefault();
    if (busy || saveBusy.current || uncertain || (!binding && !name.trim())) return;
    if ((binding || path.trim()) && !result?.valid) {
      if (path.trim()) await inspect();
      return;
    }
    saveBusy.current = true; setSaving(true); setError(""); setExisting(null);
    try {
      const saved = binding ? await commands.bindWorkspace(workspace,result.path)
        : await commands.createWorkspace({name:name.trim(),project:result?.path ?? null,defaultRosterId:defaultRoster?.id ?? null});
      if (saved) onSaved(saved);
    } catch (e) {
      setError(e.message);
      setUncertain(!!e.unknown);
      if (e.workspace && (!binding || e.workspace.id !== workspace.id)) setExisting(e.workspace);
    } finally {
      saveBusy.current = false; setSaving(false);
    }
  }
  const saveLabel = binding ? "保存目录" : "创建 Team";
  return <Modal title={title} onClose={()=>{if (!saveBusy.current) onClose();}}>
    <form onSubmit={save}>
      <p>{binding ? "新对话可使用此目录。已有对话保留各自的目录与权限。" : "为持续进行的工作留一个位置。只填名称也可以开始讨论。"}</p>
      {!binding && <label>Team 名称<input autoComplete="off" required maxLength={160} value={name} disabled={saving || uncertain}
        placeholder="例如：个人网站" onChange={event=>setName(event.target.value)}/></label>}
      <label>{binding ? "项目绝对路径" : "项目绝对路径（可选）"}
        <input aria-label="项目绝对路径" required={binding} autoComplete="off" value={path} list="recent-projects"
          disabled={saving || uncertain} placeholder="/Users/you/projects/example" onChange={event=>{
            ++request.current; setBusy(false); setPath(event.target.value); setResult(null); setExisting(null); setError("");
          }}/>
      </label>
      <datalist id="recent-projects">{projects.map(project=><option key={project} value={project}/>)}</datalist>
      {path.trim() && <button type="button" disabled={busy || saving || uncertain} onClick={inspect}>{busy ? "正在检查…" : "只读检查目录"}</button>}
      {!binding && <p className="field-note">{defaultRoster ? "默认阵容：" + defaultRoster.name : "暂无默认阵容，可以先保存 Team，稍后配置。"}</p>}
      {result && <div className="project-inspection">
        <p>{result.valid ? "目录已核对。执行仍使用正式版本和已配置的环境。" : "无法关联此目录。请选择具有有效 HEAD 的 Git 项目。"}</p>
        {result.error && <p role="alert" className="error-text">{result.error}</p>}
        {result.dirty && <p className="inset-note">存在未提交修改。这些内容不会自动进入工作起点，也不会被覆盖。</p>}
        {result.valid && <p className="field-note">{result.execution ? "已配置执行环境，尚未验证实际可用性。" : "未配置执行环境，Shell 与非空正式检查将被阻止。纯问答仍可使用。"}</p>}
        {result.valid && <details><summary>目录与版本详情</summary><dl className="facts">
          <dt>目录</dt><dd>{result.path}</dd><dt>Git HEAD</dt><dd>{result.head || "未读取"}</dd>
          <dt>正式起点</dt><dd>{result.version || "未读取"}</dd>
          <dt>正式检查</dt><dd>{result.checks?.length ? `${result.checks.length} 项，尚未运行` : "空检查策略，后续结果将标为未验证"}</dd>
        </dl></details>}
      </div>}
      {error && <p role="alert" className="error-text">{error}</p>}
      {existing && <button type="button" onClick={()=>onOpenExisting(existing)}>打开已有 Team · {existing.name}</button>}
      <div className="form-actions">
        <button type="button" onClick={onClose} disabled={saving}>取消</button>
        <button type="submit" className="primary" disabled={saving || busy || uncertain || (!binding && !name.trim()) ||
          (binding && !path.trim()) || (!!path.trim() && !result?.valid)}>{saving ? "正在保存…" : saveLabel}</button>
      </div>
    </form>
  </Modal>;
}
