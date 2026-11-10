import React, {useEffect, useRef, useState} from "react";
import {Modal} from "./Modal.jsx";

export function ProjectDialog({commands, workspace, projects = [], defaultRoster, onSaved, onOpenExisting, onClose}) {
  const binding = !!workspace;
  const title = workspace?.project ? "更换项目目录" : binding ? "关联项目目录" : "新建 Team";
  const [name, setName] = useState(""), [path, setPath] = useState("");
  const [result, setResult] = useState(null), [busy, setBusy] = useState(false), [saving, setSaving] = useState(false);
  const [error, setError] = useState(""), [existing, setExisting] = useState(null), [uncertain, setUncertain] = useState(null);
  const [browser, setBrowser] = useState(null), [folderName,setFolderName] = useState("");
  const request = useRef(0), saveBusy = useRef(false);
  useEffect(()=>()=>{++request.current;},[]);
  const validDirectory = result?.directoryAvailable ?? result?.valid;
  const validName = !!name.trim() && [...name.trim()].length <= 80;
  async function inspect(candidate = path) {
    const token = ++request.current;
    setBusy(true); setError(""); setExisting(null); setResult(null);
    try {
      const value = await commands.inspectProject(candidate,"team-directory");
      if (token === request.current) {
        setResult(value);
        if (!binding && (value.directoryAvailable ?? value.valid)) {
          const directory = value.canonicalPath ?? value.path ?? candidate;
          const basename = directory.split(/[\\/]/).filter(Boolean).at(-1)?.trim() ?? "";
          if (basename) setName(current=>current.trim()?current:[...basename].slice(0,80).join("").trimEnd());
        }
      }
    } catch (e) {
      if (token === request.current) setError(e.message);
    } finally {
      if (token === request.current) setBusy(false);
    }
  }
  async function choose(candidate) {
    setPath(candidate);setBrowser(null);
    await inspect(candidate);
  }
  async function browse(candidate) {
    const token = ++request.current;
    setBusy(true);setError("");
    try {
      const result=await commands.browseProject(candidate);
      if (token===request.current) setBrowser(result);
    } catch (error) {
      if (token===request.current) setError(error.message);
    } finally {
      if (token===request.current) setBusy(false);
    }
  }
  async function mkdir() {
    if (!browser || browser.unverified || !folderName.trim()) return;
    const token=++request.current, parent=browser.path;
    setBusy(true);setError("");
    try {
      const created=await commands.mkdirProject({parent,name:folderName.trim()});
      if (token===request.current) {
        setFolderName("");
        await choose(created.path);
      }
    } catch(error) {
      if (token!==request.current) return;
      if (!error.unknown) {setError(error.message);return;}
      setBrowser({...browser,unverified:true});
      try {
        const refreshed=await commands.browseProject(parent);
        if (token===request.current) {
          setBrowser(refreshed);
          setError("新建结果未收到。已重新浏览父目录，请核对文件夹是否存在，再选择或新建。");
        }
      } catch {
        if (token===request.current) setError("新建结果未收到。请重新浏览父目录核对。");
      }
    } finally {
      if (token===request.current) setBusy(false);
    }
  }
  async function pickDirectory() {
    const desktop=window.cothinkDesktop;
    if (!desktop) return browse(result?.canonicalPath ?? workspace?.project ?? undefined);
    const token=++request.current;
    setBusy(true);setError("");
    try {
      const selected=await desktop.chooseProjectDirectory(path.trim() ? path : workspace?.project ?? undefined);
      if (token===request.current && selected!==null) await choose(selected);
    } catch(error) {
      if (token===request.current) setError(error.message);
    } finally {
      if (token===request.current) setBusy(false);
    }
  }
  async function save(event) {
    event.preventDefault();
    if (busy || saveBusy.current || uncertain || (!binding && !validName)) return;
    if (!validDirectory) {
      if (path.trim()) await inspect();
      return;
    }
    saveBusy.current = true; setSaving(true); setError(""); setExisting(null);
    try {
      const saved = binding ? await commands.bindWorkspace(workspace,result.canonicalPath??result.path)
        : await commands.createWorkspace({name:name.trim(),project:result.canonicalPath??result.path,defaultRosterId:defaultRoster?.id??null});
      if (saved) onSaved(saved);
    } catch (e) {
      setError(e.message);
      if (e.unknown) setUncertain(e.operation??{});
      if (e.workspace && (!binding || e.workspace.id !== workspace.id)) setExisting(e.workspace);
    } finally {
      saveBusy.current = false; setSaving(false);
    }
  }
  async function query() {
    if (saveBusy.current) return;
    saveBusy.current=true;
    setSaving(true);
    try {
      if (uncertain.operationId) {
        const receipt=await commands.queryWorkspaceRebind(uncertain);
        if (receipt.status==="confirmed") onSaved(receipt.workspace);
        else setError("原操作未确认。请查看当前 Team 目录。");
      } else {
        const created=await commands.queryWorkspaceCreation(uncertain.workspaceId);
        if (created) onOpenExisting(created);
        else setError("尚未查到原 Team。可再次查询，或关闭弹窗后核对 Team 列表。");
      }
    } catch(error) {setError(error.message);}
    finally {saveBusy.current=false;setSaving(false);}
  }
  const saveLabel = binding ? "保存目录" : "创建";
  return <Modal title={title} onClose={()=>{if (!saveBusy.current) onClose();}}>
    <form onSubmit={save}>
      <p>选一个 Team 文件夹。每个新对话会在其中创建自己的子文件夹。</p>
      {!binding && <label>名称<input autoComplete="off" required value={name} disabled={saving || !!uncertain}
        placeholder="例如：个人网站" onChange={event=>setName(event.target.value)}/></label>}
      {!binding && name.trim() && !validName && <p className="error-text" role="alert">Team 名称须为 1—80 个字符。</p>}
      {(window.cothinkDesktop || commands.browseProject) && <>
        <button type="button" disabled={busy || saving || !!uncertain} onClick={pickDirectory}>选择或新建文件夹…</button>
        <p className="field-note">新建会立即创建文件夹，取消会保留它。{window.cothinkDesktop?.info?.platform==="darwin"
          ? "要清理时，可在系统选择器的父目录中右键移到废纸篓，也可在访达处理。"
          : "要清理时，可在系统文件管理器打开上级目录。"} </p>
      </>}
      {path.trim() && <p className="workspace-directory">{validDirectory?"已选目录":"目录"}：{result?.canonicalPath ?? path}</p>}
      {browser && <fieldset>
        <legend>浏览文件夹</legend>
        <p>{browser.path}</p>
        {browser.parent && <button type="button" disabled={busy} onClick={()=>browse(browser.parent)}>上一级</button>}
        <button type="button" disabled={busy} onClick={()=>browse(browser.path)}>重新浏览</button>
        <button type="button" disabled={busy} onClick={()=>choose(browser.path)}>使用此文件夹</button>
        <ul>{browser.folders.map(folder=><li key={folder.path}><button type="button" disabled={busy} onClick={()=>browse(folder.path)}>{folder.name}</button></li>)}</ul>
        <label>新文件夹名称<input disabled={busy} value={folderName} onChange={event=>setFolderName(event.target.value)} /></label>
        <button type="button" disabled={busy||browser.unverified||!folderName.trim()||
          browser.folders.some(folder=>folder.name===folderName.trim())} onClick={mkdir}>新建文件夹</button>
      </fieldset>}
      <details>
        <summary>手动输入路径</summary>
        <label>项目绝对路径
          <input aria-label="项目绝对路径" required autoComplete="off" value={path} list="recent-projects"
            disabled={saving || !!uncertain} placeholder="/Users/you/projects/example" onChange={event=>{
              ++request.current; setBusy(false); setPath(event.target.value); setResult(null); setExisting(null); setBrowser(null); setError("");
            }}/>
        </label>
        <datalist id="recent-projects">{projects.map(project=><option key={project} value={project}/>)}</datalist>
        {path.trim() && <button type="button" disabled={busy || saving || !!uncertain} onClick={()=>inspect()}>{busy ? "正在检查…" : "只读检查目录"}</button>}
      </details>
      {!binding && <p className="field-note">{defaultRoster ? "默认阵容：" + defaultRoster.name : "暂无默认阵容，可以先保存，稍后配置。"}</p>}
      {result && <div className="project-inspection">
        <p>{validDirectory ? "可以使用这个文件夹。" : "无法关联此目录。"}</p>
        {(result.reason??result.error) && <p role="alert" className="error-text">{result.reason??result.error}</p>}
      </div>}
      {error && <p role="alert" className="error-text">{error}</p>}
      {uncertain?.workspaceId && <button type="button" disabled={saving} onClick={query}>
        {uncertain.operationId ? "查询原目录变更" : "查询原 Team"}</button>}
      {existing && <button type="button" onClick={()=>onOpenExisting(existing)}>打开 · {existing.name}</button>}
      <div className="form-actions">
        <button type="button" onClick={onClose} disabled={saving}>取消</button>
        <button type="submit" className="primary" disabled={saving || busy || !!uncertain || (!binding && !validName) ||
          !validDirectory}>{saving ? "正在保存…" : saveLabel}</button>
      </div>
    </form>
  </Modal>;
}
