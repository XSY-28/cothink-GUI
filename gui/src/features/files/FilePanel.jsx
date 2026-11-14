import React,{useCallback,useEffect,useRef,useState} from 'react';
import {Markdown} from '../../Markdown.js';
import {VisualEvidence} from '../../Collaboration.jsx';
import {checkLabel} from '../../view.js';
import styles from './FilePanel.module.css';
const labels={added:'新增',deleted:'删除',modified:'修改',modeChanged:'权限变化',unchanged:'已核验'};
const key=ref=>ref?JSON.stringify([ref.taskId,ref.version,ref.path,ref.draft?.changeId,ref.draft?.baseVersion]):'';
const choicesFor=(list,selection)=>!list?[]:selection?.taskId===list.taskId?(list.changes??list.items):list.items;
function downloadBlob(blob,name) {const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}

export function OutcomeFiles({taskId,status,resultRevision,commands,onOpen}) {
  const [result,setResult]=useState(null),[error,setError]=useState('');
  const current=useRef(commands);current.current=commands;
  useEffect(()=>{let alive=true;setResult(null);setError('');
    current.current.loadFiles(taskId).then(value=>{if(alive)setResult(value);}).catch(e=>{if(alive)setError(e.message);});return()=>{alive=false;};
  },[taskId,status,resultRevision]);
  return <div className={styles.outcome} aria-label="本次成果文件">
    {result?.items.length>0?<><strong>本次文件</strong><div className={styles.outcomeLinks}>{result.items.map(item=><button key={key(item.ref)} onClick={e=>onOpen(item.ref,item.status==='deleted'?'diff':'preview',e)}>{item.name}<small>{item.ref?.draft?'未验收草稿 · ':''}{labels[item.status]}</small></button>)}</div></>:
      <p className="field-note">{error|| (result?'本轮没有文件变更或可交付文件；可查看对应执行记录。':'读取本轮成果清单…')}</p>}
  </div>;
}
export function FilePanel({task,sessionId,selection,commands,onSelection,onRecords}) {
  const [list,setList]=useState(null),[listError,setListError]=useState(''),[loadedContent,setContent]=useState(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[downloading,setDownloading]=useState(false),[exporting,setExporting]=useState(false),[exported,setExported]=useState(null);
  const current=useRef(commands);current.current=commands;
  const callbacks=useRef({onSelection});callbacks.current={onSelection};
  const selected=useRef(selection);selected.current=selection;
  const downloads=useRef(new Set());
  const sources=task?.executionTasks??(task?.work?[task]:[]);
  const visual=task?.deliveryVisual;
  const fileState=JSON.stringify(sources.map(({id,work})=>[id,work?.version,work?.changes,work?.resultWorkspace,work?.acceptance?.map(r=>[r.requestId,r.status,r.acceptedVersion])]));
  useEffect(()=>{setDownloading(false);return()=>{for(const abort of downloads.current)abort.abort();downloads.current.clear();};},[key(selection?.fileRef)]);
  useEffect(()=>{
    let alive=true;setList(null);setListError('');if(!task?.id)return;
    current.current.loadFiles(task.id).then(value=>{
      if(!alive)return;setList(value);
      const choices=choicesFor(value,selected.current),saved=selected.current?.fileRef;
      const match=choices.find(i=>key(i.ref)===key(saved))??choices[0];
      if(match){
        const tab=tabFor(match,selected.current?.tab);
        if(key(saved)!==key(match.ref)||selected.current?.tab!==tab)callbacks.current.onSelection({fileRef:match.ref,tab});
      }
    }).catch(e=>{if(alive)setListError(e.message);});
    return()=>{alive=false;};
  },[task?.id,task?.resultRevision,task?.status,fileState]);
  const choices=choicesFor(list,selection);
  const item=choices.find(i=>key(i.ref)===key(selection?.fileRef)),tab=selection?.tab??'preview';
  const patchTaskId=list?.patchTaskId??item?.patchTaskId, revealTaskId=list?.revealTaskId??item?.revealTaskId;
  const identity=key(item?.ref)+':'+tab;
  const fileRef=item?.ref;
  const resolveImage=useCallback(src=>current.current.resolveImage({sessionId,taskId:fileRef.taskId,src,fileRef}),[sessionId,fileRef]);
  const content=loadedContent?.identity===identity?loadedContent:null;
  useEffect(()=>{
    const abort=new AbortController();let alive=true,url;
    setContent(null);setError('');setLoading(false);
    if(!item)return()=>abort.abort();
    if(tab!=='diff'&&!item.readable){setError(item.status==='deleted'?'文件在此版本已删除，请查看差异。':'没有可核验的文件内容，请查看已有差异或截图。');return()=>abort.abort();}
    setLoading(true);
    (async()=>{
      try {
        if(tab==='diff'){const result=await current.current.readFileDiff(item.ref);if(alive)setContent({diff:result,identity});return;}
        const result=await current.current.readFile(item.ref,{purpose:tab==='source'?'source':'preview',signal:abort.signal});
        if(!alive)return;
        if(result.version!==item.ref.version)throw Error('读取结果与所选固定版本不一致。');
        if(tab==='preview'&&(result.representation==='static-preview'||item.previewKind==='image')){
          url=URL.createObjectURL(new Blob([result.bytes],{type:result.mediaType}));setContent({...result,url,identity});
        }else setContent({...result,identity,text:new TextDecoder('utf-8',{fatal:true}).decode(result.bytes)});
      }catch(e){if(alive&&e.name!=='AbortError')setError(e.message||'当前文件无法可靠显示，请下载原文件。');}
      finally{if(alive)setLoading(false);}
    })();
    return()=>{alive=false;abort.abort();if(url)URL.revokeObjectURL(url);};
  },[key(item?.ref),item?.readable,task?.resultRevision,tab]);
  async function download() {
    if(!item)return;const abort=new AbortController();downloads.current.add(abort);setDownloading(true);
    try{const result=await current.current.readFile(item.ref,{purpose:'download',signal:abort.signal});if(!abort.signal.aborted)downloadBlob(new Blob([result.bytes],{type:'application/octet-stream'}),item.ref.path.split('/').at(-1));}
    catch(e){if(!abort.signal.aborted)setError(e.message);}finally{downloads.current.delete(abort);if(!abort.signal.aborted)setDownloading(false);}
  }
  async function exportDraft() {
    if(!item?.ref.draft)return;
    setExporting(true);setError('');setExported(null);
    try {setExported(await current.current.exportDraft({taskId:item.ref.taskId,version:item.ref.version,...item.ref.draft}));}
    catch(e){setError(e.message);}
    finally{setExporting(false);}
  }
  async function patch() {try{downloadBlob(new Blob([await current.current.downloadPatch(patchTaskId)],{type:'text/x-diff'}),`cothink-${patchTaskId}.patch`);}catch(e){setError(e.message);}}
  const visualSources=visual?[visual,...sources]:sources;
  const selectedEvidence=tab==='preview'&&error&&item? visualSources.flatMap(source=>(source.work?.visualEvidence??[])
    .filter(e=>e.entry===item.name&&e.images.length)
    .map(e=>({taskId:source.id,evidence:e,version:item.ref.version}))) : [];
  return <section className={styles.panel} aria-label="成果文件阅读">
    <header className={styles.header}><div><small>本轮成果</small><h2>{item?.name||'文件与差异'}</h2></div></header>
    <div className={styles.tools}>{item?.ref.draft&&<button disabled={exporting} onClick={exportDraft}>{exporting?'导出中…':'导出草稿'}</button>}{patchTaskId&&<button onClick={patch}>下载完整补丁</button>}{revealTaskId&&<button onClick={()=>current.current.revealTask(revealTaskId).catch(e=>setError(e.message))}>打开成果目录</button>}<button onClick={onRecords}>执行记录</button></div>
    {item?.ref.draft&&<p className="field-note">未验收草稿 · 来源 {item.source||item.ref.taskId} · 版本 {item.ref.version}。保存状态与新增、修改或删除状态分别记录。</p>}
    {exported&&<div role="status"><p>草稿已导出：{exported.directory}</p>{exported.warnings.map((message,index)=><p className="field-note" key={index}>{message}</p>)}</div>}
    {!task&&<p role="status">读取任务…</p>}
    {listError&&<p role="alert" className="error-text">{listError}</p>}
    {(list?.warnings??[]).map(message=><p key={message} className="field-note">{message}</p>)}
    {list?.placement?.status==='placed'&&<p className="field-note">已放入对话文件夹。</p>}
    {list?.placement?.status==='failed'&&<p role="alert" className="field-note">成果未放入对话文件夹：{list.placement.error} 已保存的固定版本仍可打开。</p>}
    {list?.checks?.length>0&&<p className="field-note">正式版本检查通过。</p>}
    {list&&!choices.length&&<p>{selection?.taskId===list.taskId?'本轮没有已核验的文件变更。':'本轮尚无可打开的文件或差异。'}</p>}
    {choices.length>0&&<>
      <details className={styles.fileChoices}><summary>切换文件 · {choices.length} 个</summary><nav className={styles.list} aria-label="本轮文件">{choices.map(f=><button aria-pressed={key(f.ref)===key(item?.ref)} key={key(f.ref)} onClick={()=>onSelection({fileRef:f.ref,tab:tabFor(f,tab)})}><span>{f.name}</span><small>{f.ref?.draft?'未验收草稿 · ':''}{labels[f.status]}</small></button>)}</nav></details>
      <div className={styles.tabs} role="tablist" aria-label="文件视图">{[['preview','预览'],['source','源码'],['diff','差异']].map(([value,label])=><button key={value} role="tab" aria-selected={tab===value} disabled={item?.status==='deleted'&&value!=='diff'||item?.status==='unchanged'&&value==='diff'} onClick={()=>onSelection({fileRef:item?.ref,tab:value})}>{label}</button>)}<button disabled={!item?.readable||downloading} onClick={download}>{downloading?'下载中…':'下载原文件'}</button></div>
      {loading&&<p role="status">读取固定版本文件…</p>}
      {error&&<div className={styles.fallback}><p role="alert">{error}</p><p>原始文件未改写。可切换源码、差异，或查看下方已有截图。</p></div>}
      {selectedEvidence.map(({taskId,evidence,version})=><VisualEvidence key={taskId+evidence.toolCallId} work={{visualEvidence:[evidence]}} taskId={taskId} commands={commands} currentVersion={version} expandFrames />)}
      {content?.diff&&(content.diff.binary?<p className={styles.fallback}>二进制变更；完整二进制内容保留在原文件和完整补丁中。</p>:<pre className={styles.code} tabIndex={0}>{content.diff.patch}</pre>)}
      {content?.url&&(content.representation==='static-preview'?<><p className="field-note">静态预览：脚本、表单、导航和外部资源未运行。</p><iframe sandbox="" referrerPolicy="no-referrer" src={content.url} title={`静态预览 ${item.name}`} className={styles.frame}/></>:<img className={styles.image} src={content.url} alt={item.name}/>)}
      {content?.text!==undefined&&(tab==='preview'&&item.previewKind==='markdown'?<div className={`prose ${styles.markdown}`}><Markdown text={content.text} resolveImage={commands.resolveImage&&fileRef?resolveImage:undefined}/></div>:<pre className={styles.code} tabIndex={0}>{content.text}</pre>)}
    </>}
    {!!visual?.work?.visualEvidence?.length&&!selectedEvidence.some(e=>e.taskId===visual.id)&&
      <details className={styles.facts}><summary>最终组合视觉复核</summary>
        <VisualEvidence work={visual.work} taskId={visual.id} commands={commands} currentVersion={list?.toVersion??null}/>
      </details>}
    {sources.filter(source=>source.work).map(source=><details key={source.id} className={styles.facts}><summary>检查、截图与版本详情</summary>
      <p>{checkLabel(source.work.finalCheck)}。文件保存状态、截图生成情况与模型判断分别记录。</p>
      <p>独立成果目录：{list?.resultWorkspace||source.work.resultWorkspace||'尚未产生'}。</p>
      <dl><dt>步骤起点</dt><dd>{source.work.startVersion}</dd><dt>步骤终点</dt><dd>{source.work.version}</dd>{list?.toVersion&&<><dt>本轮文件版本</dt><dd>{list.toVersion}</dd></>}</dl>
      {content?.contentHash&&<p>返回内容 SHA-256：{content.contentHash}{content.representation==='static-preview'&&<>；原文件 SHA-256：{content.sourceContentHash}</>}</p>}
      {list?.limits&&<p>源码 {list.limits.textBytes} 字节；预览资源合计 {list.limits.previewBytes} 字节；下载 {list.limits.downloadBytes} 字节。最多 {list.limits.resources} 个资源，{list.limits.depth} 层。</p>}
      {!selectedEvidence.some(e=>e.taskId===source.id)&&<VisualEvidence work={source.work} taskId={source.id} commands={commands} currentVersion={list?.toVersion??null}/>}
    </details>)}
  </section>;
}
function tabFor(item,tab) {
  return item.status==='deleted'?'diff':item.status==='unchanged'&&tab==='diff'?'preview':tab??'preview';
}
