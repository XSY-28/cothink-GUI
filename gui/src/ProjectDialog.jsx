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
      const value = await commands.inspectProject(candidate,"directory");
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
    if ((binding || path.trim()) && !validDirectory) {
      if (path.trim()) await inspect();
      return;
    }
    saveBusy.current = true; setSaving(true); setError(""); setExisting(null);
    try {
      const saved = binding ? await commands.bindWorkspace(workspace,result.canonicalPath??result.path)
        : await commands.createWorkspace({name:name.trim(),project:result?.canonicalPath??result?.path??null,defaultRosterId:defaultRoster?.id??null});
      if (saved) onSaved(saved);
    } catch (e) {
      setError(e.message);
      if (e.unknown) setUncertain(e.operation??{});
      if (e.workspace && (!binding || e.workspace.id !== workspace.id)) setExisting(e.workspace);
    } finally {
      saveBusy.current = false; setSaving(false);
    }
  }
  async function detach() {
    if (saveBusy.current) return;
    saveBusy.current=true;setSaving(true);setError("");
    try {const saved=await commands.bindWorkspace(workspace,null);if(saved)onSaved(saved);}
    catch(error){setError(error.message);if(error.unknown)setUncertain(error.operation??{});}
    finally{saveBusy.current=false;setSaving(false);}
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
      <p>{binding ? "新对话会使用此目录。已有对话保留各自的目录与权限。" : "一个 Team 对应一个长期项目。只填名称也可以开始讨论。"}</p>
      {!binding && <label>名称<input autoComplete="off" required value={name} disabled={saving || !!uncertain}
        placeholder="例如：个人网站" onChange={event=>setName(event.target.value)}/></label>}
      {!binding && name.trim() && !validName && <p className="error-text" role="alert">Team 名称须为 1—80 个字符。</p>}
      {(window.cothinkDesktop || commands.browseProject) && <>
        <button type="button" disabled={busy || saving || !!uncertain} onClick={pickDirectory}>选择或新建文件夹…</button>
        <p className="field-note">新建会立即创建文件夹，取消或解除关联会保留它。{window.cothinkDesktop?.info?.platform==="darwin"
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
        <label>{binding ? "项目绝对路径" : "项目绝对路径（可选）"}
          <input aria-label="项目绝对路径" required={binding} autoComplete="off" value={path} list="recent-projects"
            disabled={saving || !!uncertain} placeholder="/Users/you/projects/example" onChange={event=>{
              ++request.current; setBusy(false); setPath(event.target.value); setResult(null); setExisting(null); setBrowser(null); setError("");
            }}/>
        </label>
        <datalist id="recent-projects">{projects.map(project=><option key={project} value={project}/>)}</datalist>
        {path.trim() && <button type="button" disabled={busy || saving || !!uncertain} onClick={()=>inspect()}>{busy ? "正在检查…" : "只读检查目录"}</button>}
      </details>
      {!binding && <p className="field-note">{defaultRoster ? "默认阵容：" + defaultRoster.name : "暂无默认阵容，可以先保存，稍后配置。"}</p>}
      {result && <div className="project-inspection">
        <p>{validDirectory ? "目录可以关联。开始文件工作前会核对正式起点。" : "无法关联此目录。"}</p>
        {(result.reason??result.error) && <p role="alert" className="error-text">{result.reason??result.error}</p>}
        {result.dirty && <p className="inset-note">存在未提交修改。这些内容不会自动进入工作起点，也不会被覆盖。</p>}
        {validDirectory && result.head && <p className="field-note">{result.execution ? "已配置执行环境，尚未验证实际可用性。" : "未配置执行环境，Shell 与非空正式检查将被阻止。纯问答仍可使用。"}</p>}
        {validDirectory && result.head && <details><summary>目录与版本详情</summary><dl className="facts">
          <dt>目录</dt><dd>{result.path}</dd><dt>Git HEAD</dt><dd>{result.head}</dd>
          <dt>正式起点</dt><dd>{result.version || "未读取"}</dd>
          <dt>正式检查</dt><dd>{result.checks?.length ? `${result.checks.length} 项，尚未运行` : "空检查策略，后续结果将标为未验证"}</dd>
        </dl></details>}
      </div>}
      {error && <p role="alert" className="error-text">{error}</p>}
      {uncertain?.workspaceId && <button type="button" disabled={saving} onClick={query}>
        {uncertain.operationId ? "查询原目录变更" : "查询原 Team"}</button>}
      {existing && <button type="button" onClick={()=>onOpenExisting(existing)}>打开 · {existing.name}</button>}
      <div className="form-actions">
        <button type="button" onClick={onClose} disabled={saving}>取消</button>
        {workspace?.project && <button type="button" disabled={busy||saving||!!uncertain} onClick={detach}>解除目录关联</button>}
        <button type="submit" className="primary" disabled={saving || busy || !!uncertain || (!binding && !validName) ||
          (binding && !path.trim()) || (!!path.trim() && !validDirectory)}>{saving ? "正在保存…" : saveLabel}</button>
      </div>
    </form>
  </Modal>;
}

export function ProjectPreparationDialog({commands,path,initialPreparation,onClose,onReady}) {
  const [operationId,setOperationId]=useState(()=>initialPreparation?.operationId??crypto.randomUUID());
  const [result,setResult]=useState(initialPreparation??null),[selected,setSelected]=useState([]);
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[unknown,setUnknown]=useState(false);
  const active=useRef(false);
  async function run(action, extra={}) {
    if (active.current) return;
    active.current=true;setBusy(true);setError("");
    try {
      const value=await commands.prepareProject({action,operationId,...extra});
      if (action === "query" && value.status === "missing") {
        if (unknown === "preview") {
          setOperationId(crypto.randomUUID());setResult(null);setSelected([]);setUnknown(false);
          setError("未找到原盘点结果，可以重新盘点。");
        } else setError("未找到原操作记录。请先核对目录状态。");
        return;
      }
      if (value.operationId && value.operationId!==operationId) setOperationId(value.operationId);
      setResult(value);setUnknown(false);
      if (value.status==="ready") onReady?.();
    } catch(error) {
      setError(error.message);
      if (error.unknown) setUnknown(previous=>previous||action);
    } finally {active.current=false;setBusy(false);}
  }
  const status=result?.status;
  return <Modal title="准备文件工作" onClose={()=>{if(!active.current)onClose();}}>
    <p>{path}</p>
    {result?.root && result.root!==path && <p>实际仓库 {result.root} · 所选范围 {result.relativePath}</p>}
    {!result && <p>先盘点此目录，再明确选择要进入 Git 起点的文件。</p>}
    {status==="inventory" && <fieldset>
      <legend>选择纳入起点的文件</legend>
      {result.files.map(file=><label key={file.path}><input type="checkbox" checked={selected.includes(file.path)}
        disabled={busy||unknown} onChange={event=>setSelected(list=>event.target.checked?[...list,file.path]:list.filter(item=>item!==file.path))}/>{file.path}</label>)}
      <p>选择了 {selected.length} 项。空清单可建立空提交。</p>
    </fieldset>}
    {result?.ignored?.length>0 && <details><summary>忽略项 · {result.ignored.length}</summary>
      <ul>{result.ignored.map(file=><li key={file.path}>{file.path}</li>)}</ul></details>}
    {result?.staged?.length>0 && <p>已有暂存项：{result.staged.join("、")}</p>}
    {result?.changes && Object.values(result.changes).some(items=>items.length) && <details><summary>现有工作目录改动</summary><ul>
      {[...new Set(Object.values(result.changes).flat())].map(file=><li key={file}>{file}</li>)}
    </ul></details>}
    {status==="preview" && <>
      <p>{result.metadata.createsGitDirectory?"将创建 .git 和初始索引。":"将沿现有分支建立初始索引。"}</p>
      <p>包含 {result.selectedPaths.length ? result.selectedPaths.join("、") : "空清单"}</p>
      <details><summary>提交详情</summary><dl className="facts">
        <dt>作者和提交者</dt><dd>{result.metadata.author.name} &lt;{result.metadata.author.email}&gt;</dd>
        <dt>时间</dt><dd>{result.metadata.date}</dd><dt>消息</dt><dd>{result.metadata.message}</dd>
        <dt>分支</dt><dd>{result.metadata.ref}</dd><dt>Tree</dt><dd>{result.expectedTree}</dd>
        <dt>提交</dt><dd>{result.expectedCommit}</dd>
      </dl></details>
    </>}
    {status==="ready" && <p role="status">文件工作起点已核对。</p>}
    {(error||result?.error) && <p className="error-text" role="alert">{error||result.error}</p>}
    <div className="form-actions">
      <button disabled={busy} onClick={onClose}>关闭</button>
      {!result&&!unknown && <button className="primary" disabled={busy} onClick={()=>run("preview",{path})}>盘点文件</button>}
      {status==="inventory"&&!unknown && <button className="primary" disabled={busy} onClick={()=>run("preview",{path,selectedPaths:selected})}>预览起点</button>}
      {status==="preview"&&!unknown && <button className="primary" disabled={busy} onClick={()=>run("confirm")}>确认建立起点</button>}
      {status==="partial"&&!unknown && <button className="primary" disabled={busy} onClick={()=>run("finish")}>完成准备</button>}
      {(unknown||status==="unknown") && <button disabled={busy} onClick={()=>run("query")}>查询原操作</button>}
      {error&&!unknown&&status==="preview" && <button disabled={busy} onClick={()=>{setOperationId(crypto.randomUUID());setResult(null);setSelected([]);setError("");}}>重新盘点</button>}
    </div>
  </Modal>;
}
