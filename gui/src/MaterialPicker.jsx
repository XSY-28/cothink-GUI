import React,{useEffect,useRef,useState} from "react";
import {Modal} from "./Modal.jsx";

const imageTypes=new Set(["image/png","image/jpeg","image/webp"]);
export function MaterialPreview({blob,name}) {
  const [view,setView]=useState(null);
  useEffect(()=>{
    if(!blob)return;
    let alive=true,url;
    if(imageTypes.has(blob.type)){
      url=URL.createObjectURL(blob);
      setView({blob,url});
    }else if(["text/plain","text/markdown"].includes(blob.type.split(";")[0])){
      blob.arrayBuffer().then(bytes=>new TextDecoder("utf-8",{fatal:true}).decode(bytes))
        .then(text=>{if(alive)setView({blob,text});})
        .catch(()=>{if(alive)setView({blob,error:"文件无法按 UTF-8 读取。"});});
    }else setView({blob,error:"此格式无法安全预览。"});
    return()=>{alive=false;if(url)URL.revokeObjectURL(url);};
  },[blob]);
  if(!blob||view?.blob!==blob)return <p role="status">正在读取预览…</p>;
  if(view.error)return <p className="error-text" role="alert">{view.error}</p>;
  return view.url?<img className="markdown-image" src={view.url} alt={name} onError={()=>setView({blob,error:"图片无法解码预览。"})}/>:<pre className="material-preview" tabIndex={0}>{view.text}</pre>;
}

const parentPath=path=>path.split("/").slice(0,-1).join("/")||".";
const sizeLabel=bytes=>Number.isFinite(bytes)?new Intl.NumberFormat("zh-CN").format(bytes)+" B":"";

export function MaterialPicker({project,commands,sessionId,capabilities,onClose,onSelected}) {
  const [source,setSource]=useState("current"),[path,setPath]=useState(undefined),[list,setList]=useState(null),[selected,setSelected]=useState([]);
  const [preview,setPreview]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(""),[unknown,setUnknown]=useState(false);
  const owner=useRef(commands);owner.current=commands;
  const request=useRef(0),committing=useRef(false);
  useEffect(()=>{
    const id=++request.current;
    setList(null);setPreview(null);setError("");setBusy(true);
    owner.current.listProjectMaterials({source,path}).then(value=>{
      if(id===request.current)setList(value);
    }).catch(e=>{if(id===request.current)setError(e.message);})
      .finally(()=>{if(id===request.current)setBusy(false);});
    return()=>{++request.current;};
  },[source,path]);
  function switchSource(next) {
    if(source===next)return;
    setPath(undefined);setSelected([]);setSource(next);
  }
  async function more() {
    const id=request.current;
    setBusy(true);setError("");
    try {
      const next=await commands.listProjectMaterials({source,path,cursor:list.nextCursor});
      if(id!==request.current)return;
      if(next.version!==list.version)throw Error("列出的版本已变化，请重新打开项目文件再确认。");
      setList({...next,entries:[...list.entries,...next.entries]});
    }catch(e){if(id===request.current)setError(e.message);}
    finally{if(id===request.current)setBusy(false);}
  }
  async function inspect(entry) {
    const id=request.current;
    setBusy(true);setError("");setPreview(null);
    try {
      const {blob,sha256,sourceToken}=await commands.previewProjectMaterial({source,version:list.version,path:entry.path});
      if(!blob||!sha256||!sourceToken)throw Error("没有可核对的文件内容。");
      if(id===request.current)setPreview({path:entry.path,blob,sha256,sourceToken,byteLength:blob.size});
    }catch(e){if(id===request.current)setError(e.message);}
    finally{if(id===request.current)setBusy(false);}
  }
  function toggle(entry) {
    const prior=selected.find(item=>item.path===entry.path);
    if(prior){
      if(entry.sha256&&prior.sourceToken!==entry.sourceToken)
        setSelected(rows=>rows.map(item=>item.path===entry.path?{...entry,version:list?.version}:item));
      else setSelected(rows=>rows.filter(item=>item.path!==entry.path));
      return;
    }
    setSelected(rows=>[...rows,{...entry,version:list?.version}]);
  }
  async function confirm() {
    if(busy||unknown||committing.current||!selected.length)return;
    const id=request.current;
    committing.current=true;setBusy(true);setError("");
    try {
      if(source==="current"){
        await commands.importProjectMaterials({source,paths:selected.map(({path,sha256,sourceToken})=>({path,sha256,sourceToken}))});
      }else{
        if(!list?.version||selected.some(item=>item.path.includes(",")||item.version!==list.version))throw Error("选定范围无法按已保存版本提交。");
        await commands.setTurnOptions(sessionId,{readAllowed:true,readPaths:selected.map(item=>item.path).join(","),readVersion:list.version});
      }
      if(id===request.current)onSelected();
    }catch(e){if(id===request.current){
      if(e.unknown)setUnknown(true);
      setError(e.unknown?"导入结果尚未确认。请关闭弹层，从原草稿查询待核对材料。":e.message);
    }}
    finally{committing.current=false;if(id===request.current)setBusy(false);}
  }
  const priorPreview=preview&&selected.find(item=>item.path===preview.path);
  const bytes=selected.reduce((total,entry)=>total+(entry.byteLength??0),0);
  const estimatedFiles=selected.every(entry=>Number.isFinite(entry.fileCount))?selected.reduce((total,entry)=>total+entry.fileCount,0):null;
  const maxCount=capabilities?.maxCount;
  const maxBytes=capabilities?.totalBytes;
  const exceeds=source==="current"&&(Number.isFinite(maxCount)&&selected.length>maxCount||Number.isFinite(maxBytes)&&bytes>maxBytes);
  return <Modal title="选择项目文件" wide className="material-picker" onClose={()=>{if(!committing.current)onClose();}}>
    <div className="dialog-body">
      <p className="workspace-directory">{project}</p>
      <div className="form-actions material-source-switch">
        <button type="button" aria-pressed={source==="current"} disabled={busy||unknown} onClick={()=>switchSource("current")}>当前磁盘副本</button>
        <button type="button" aria-pressed={source==="saved"} disabled={busy||unknown} onClick={()=>switchSource("saved")}>读取已保存版本</button>
      </div>
      <p className="field-note">{source==="current"?"逐项预览后导入当前文件，包括尚未提交的内容。副本不授予目录访问权限。":"只允许读取所选已保存版本和范围，不包括未提交内容，也不授予写入或执行权限。"}</p>
      <div className="form-actions material-source-switch">
        {path&&list&&list.path!==list.scope&&<button type="button" disabled={busy} onClick={()=>setPath(parentPath(path))}>上一级</button>}
        <span className="workspace-directory">{list?.path&&list.path!==list.scope?list.path:"项目根目录"}</span>
        {source==="saved"&&list?.version&&<code title={list.version}>{list.version.slice(0,12)}</code>}
      </div>
      {busy&&<p role="status">正在核对项目文件…</p>}
      {error&&<p className="error-text" role="alert">{error}</p>}
      {list&&!list.entries.length&&<p>此处没有可选择的文件。</p>}
      <ul className="material-picker-list" aria-label="项目文件">
        {list?.entries.map(entry=>{
          const directory=entry.kind==="directory",checked=selected.some(item=>item.path===entry.path);
          return <li key={entry.path}>
            {directory?<button type="button" disabled={busy} onClick={()=>setPath(entry.path)}>{entry.name||entry.path}/</button>
              :<span title={entry.path}>{entry.name||entry.path}</span>}
            <small>{source==="saved"&&Number.isFinite(entry.fileCount)?`${entry.fileCount} 个文件`:sizeLabel(entry.byteLength)}</small>
            {source==="saved"?<button type="button" disabled={busy} aria-pressed={checked} onClick={()=>toggle(entry)}>{checked?"取消选择":"选择范围"}</button>
              :!directory&&<button type="button" disabled={busy} onClick={()=>inspect(entry)}>预览</button>}
          </li>;
        })}
      </ul>
      {list?.nextCursor&&<button type="button" disabled={busy} onClick={more}>加载更多</button>}
      {source==="current"&&preview&&<>
        <h3 className="workspace-directory">{preview.path}</h3>
        <MaterialPreview blob={preview.blob} name={preview.path}/>
        <button type="button" disabled={busy} aria-pressed={selected.some(item=>item.path===preview.path)} onClick={()=>toggle(preview)}>
          {!priorPreview?"选择预览中的文件":priorPreview.sourceToken!==preview.sourceToken?"更新为本次预览":"取消选中此文件"}
        </button>
      </>}
      {selected.length>0&&<div className="material-picker-selection">
        <p>已选择 {selected.length} {source==="current"?`个文件 · ${sizeLabel(bytes)}`:`项范围${estimatedFiles!==null?` · 预计 ${estimatedFiles} 个文件`:""}`}</p>
        {selected.map(entry=><button key={entry.path} type="button" disabled={busy} onClick={()=>toggle(entry)} title={entry.path}>移除 {entry.path}</button>)}
      </div>}
      {exceeds&&<p className="error-text" role="alert">所选材料超过本次导入上限。</p>}
      <div className="form-actions"><button className="primary" type="button" disabled={busy||unknown||!selected.length||exceeds||!list} onClick={confirm}>
        {source==="current"?"导入所选副本":"确认读取范围"}
      </button></div>
    </div>
  </Modal>;
}
