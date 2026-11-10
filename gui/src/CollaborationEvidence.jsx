import React, { useEffect, useRef, useState } from "react";
import { Markdown } from "./Markdown.js";
import { checkLabel, outputReferences } from "./view.js";

function VisualFrame({image,taskId,commands,entry}) {
  const [src,setSrc]=useState(null),[error,setError]=useState('');
  const dialog=useRef(null);
  const current=useRef(commands);current.current=commands;
  useEffect(()=>{let active=true,url;setSrc(null);setError('');current.current.readImage({id:taskId,ref:image.ref,index:image.index}).then(value=>{url=value;if(active)setSrc(value);else URL.revokeObjectURL(value);}).catch(e=>{if(active)setError(e.message);});return ()=>{active=false;if(url)URL.revokeObjectURL(url);};},[taskId,image.ref,image.index]);
  const label=`${entry}，采样 ${Math.round(image.capturedAtMs??0)} 毫秒`;
  return <figure className="visual-frame">{src?<><button type="button" aria-label={`放大截图：${label}`} onClick={()=>dialog.current.showModal()}><img src={src} alt={label}/></button>
    <dialog ref={dialog} aria-label="放大截图" onKeyDown={event=>{if(event.key==='Escape')event.stopPropagation();}}><button type="button" autoFocus onClick={()=>dialog.current.close()}>关闭截图</button><img src={src} alt={label}/></dialog></>:<p>{error||'读取截图…'}</p>}<figcaption>{Math.round(image.capturedAtMs??0)} ms · PNG</figcaption></figure>;
}
export function VisualEvidence({work,commands,taskId,currentVersion,expandFrames=false}) {
  if (!work.visualEvidence?.length) return null;
  const verdict = {match:'模型判断符合',mismatch:'模型判断不符合',uncertain:'证据不足，判断不确定'};
  return <section className="visual-evidence"><h3>视觉检查</h3>
    <p className="muted">接纳表示版本已保存；图片发送、审查完成和模型判断分别记录。模型判断不等于客观证明。</p>
    {work.visualEvidence.map(e => {
      const checked=e.checked&&(currentVersion===undefined||currentVersion===e.integrationVersion);
      const stale=currentVersion&&currentVersion!==e.integrationVersion;
      return <details key={e.toolCallId} open={expandFrames || !!e.review || e.result==='failed'}>
      <summary>{e.entry} · {e.result==='failed'?'截图失败':checked?'最终版本审查完成':stale?'早期或候选版本截图':e.review?'视觉复核未完成':e.imageRequestCompleted?'图像请求已完成':e.imageRequestId?'图像已发送，请求未完成':'尚未回传模型'}</summary>
      <p>{e.actor} · {e.viewport?.width} × {e.viewport?.height}</p>
      {e.review && <div className="prose"><strong>主模型视觉复核：{checked ? verdict[e.review.verdict] : '未获得当前版本的有效判断'}</strong>
        <Markdown text={[e.review.observation,e.review.reasons,e.review.text].filter(Boolean).join('\n\n')}/>
        {e.review.error && <p role="alert" className="error-text">{e.review.error}</p>}
      </div>}
      <div className="visual-frames">{e.images.map(i=><VisualFrame key={i.index} image={i} taskId={taskId} commands={commands} entry={e.entry}/>)}</div>
      {e.error&&<p role="alert" className="error-text">{e.error}</p>}
      <details><summary>版本与诊断</summary><pre>{JSON.stringify({sourceVersion:e.sourceVersion,privateVersion:e.privateVersion,integrationVersion:e.integrationVersion,imageRequestId:e.imageRequestId,imageRequestCompleted:e.imageRequestCompleted,review:e.review,visibility:e.visibility,execution:e.execution,actions:e.actions,frameTimesMs:e.frameTimesMs,diagnostics:e.diagnostics},null,2)}</pre></details>
    </details>;})}
  </section>;
}
export function Checks({ work, commands, taskId }) {
  const [log, setLog] = useState(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  const refs = [
    ...new Set([...(work.outputRefs || []), ...outputReferences(work)]),
  ];
  async function load(ref, offset = 0) {
    setLoading(true);
    setError("");
    try {
      const page = await commands.readOutput({
        id: taskId,
        ref,
        offset,
        limit: 65536,
      });
      setLog((prior) => ({
        ...page,
        ref,
        text: offset && prior?.ref === ref ? prior.text + page.text : page.text,
      }));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }
  return (
    <div className="work-detail">
      <VisualEvidence work={work} commands={commands} taskId={taskId}/>
      <h3>检查与执行记录</h3>
      <div
        className={`check-outcome ${work.finalCheck?.status === "passed" && work.finalCheck?.verification === "passed" ? "verified" : ""}`}
      >
        <strong>{checkLabel(work.finalCheck)}</strong>
        <p>检查只证明记录中对应版本的结果。</p>
      </div>
      <dl className="facts">
        <dt>正式版本</dt>
        <dd>{work.version || "未记录"}</dd>
        <dt>检查版本</dt>
        <dd>
          {work.finalCheck?.version ||
            work.finalCheck?.candidateVersion ||
            "以下原始回执为准"}
        </dd>
      </dl>
      {work.finalCheck?.checks?.map((check, i) => (
        <section className="check-card" key={i}>
          <strong>{check.command || check.name || `检查 ${i + 1}`}</strong>
          <pre>{JSON.stringify(check, null, 2)}</pre>
          {check.outputRef && (
            <button disabled={loading} onClick={() => load(check.outputRef)}>
              读取检查日志
            </button>
          )}
        </section>
      ))}
      <details>
        <summary>检查与接纳原始回执</summary>
        <pre>
          {JSON.stringify(
            { finalCheck: work.finalCheck, acceptance: work.acceptance },
            null,
            2,
          )}
        </pre>
      </details>
      <h4>只读日志</h4>
      {refs.length ? (
        refs.map((ref) => (
          <button
            className="log-ref"
            key={ref}
            disabled={loading}
            onClick={() => load(ref)}
          >
            {ref}
          </button>
        ))
      ) : (
        <p className="muted">此任务没有已保存的日志引用。</p>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {log && (
        <section className="log-output">
          <div className="small-label">{log.ref}</div>
          <pre tabIndex={0}>{log.text || "（空日志）"}</pre>
          {!log.eof && (
            <button
              disabled={loading}
              onClick={() => load(log.ref, log.nextOffset)}
            >
              继续读取日志
            </button>
          )}
        </section>
      )}
    </div>
  );
}
