import React, {useState} from "react";
import {Modal} from "../../Modal.jsx";
import {IconAction} from "../../Icon.js";
import {statusLabel} from "../../view.js";
import styles from "./Conversation.module.css";

export function StopButton({stopping, activeStatus, onClick}) {
  const check = stopping?.status === "stop_unknown";
  const label = check ? "核对停止" : stopping ? statusLabel(stopping.status) : "停止";
  return <button type="button" className="stop-button" disabled={!check && (!!stopping || activeStatus === "cancelling")} onClick={onClick}>{label}</button>;
}

export function WorkProposal({turn, disabled, onConfirm}) {
  const blocker=turn.confirmationBlocker;
  const collaboration=turn.proposal?.collaboration;
  return <>
    <pre className={styles.proposalText}>{turn.finalText}</pre>
    {!!collaboration?.length && <ul className="field-note" aria-label="协作要求">
      {collaboration.map((item,index)=><li key={index}>{[
        item.source.kind==="user"?"用户要求":"计划承诺",
        `至少 ${item.workers} 名员工`,
        item.parallel&&"实际并行请求",
        item.distinctModels&&"使用不同模型",
        item.stepIds?.length&&`步骤 ${item.stepIds.join("、")}`,
      ].filter(Boolean).join(" · ")}</li>)}
    </ul>}
    {!turn.confirmationIntent?.consumedByTaskId && <>
      {blocker && <p className="field-note">{blocker}</p>}
      <button type="button" disabled={disabled||!!blocker} onClick={onConfirm}>确认上述计划并执行</button>
    </>}
  </>;
}

export function UserMessage({turn, onCopy}) {
  return <div className={styles.userMessage}>
    <div className={styles.userText}>{turn.input}
      {!!turn.materials?.length && <ul className={styles.sentMaterials} aria-label="已发送材料">
        {turn.materials.map(item=><li key={item.id}>{item.name??"已保存材料"}</li>)}
      </ul>}
    </div>
    {turn.input && onCopy && <div className={styles.messageActions}>
      <IconAction icon="copy" label="复制消息" onClick={()=>onCopy(turn.input)} />
    </div>}
  </div>;
}

export function ReplyActions({turn, forkDisabled, showChanges, onDetails, onCopy, onFork}) {
  return <footer className={styles.answerActions}>
    {turn.finalText && <IconAction icon="copy" label="复制原文" onClick={()=>onCopy(turn.finalText)} />}
    <IconAction icon="fork" label="从这里分支" disabled={forkDisabled}
      description="保留截至此条回复的上下文，在新对话中继续" onClick={()=>onFork(turn.taskId)} />
    {showChanges && <button type="button" onClick={event=>onDetails(turn.taskId,"changes",event)}>变更与检查</button>}
  </footer>;
}


export function FileContinuation({turn, disabled, onInspect, onContinue}) {
  const [open,setOpen]=useState(false),[facts,setFacts]=useState(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const inspect=async draft=>{
    setOpen(true);setBusy(true);setError('');setFacts(null);
    try{setFacts(await onInspect(turn,draft));}catch(e){setError(e.message);}finally{setBusy(false);}
  };
  const confirm=async()=>{
    if(busy||!facts?.eligible)return;
    setBusy(true);setError('');
    try{const result=await onContinue(turn,facts);if(result)setOpen(false);}
    catch(e){setError(e.message);}finally{setBusy(false);}
  };
  return <>
    <button type="button" disabled={disabled||busy} onClick={()=>inspect()}>从保存成果继续</button>
    {open&&<Modal title="从保存成果继续" onClose={()=>{if(!busy)setOpen(false);}}>
      <div className="dialog-body">
        <p>这将开始一次新的执行尝试。旧请求和未知费用保留，不会重发原请求；沿用原目标、范围和检查。</p>
        {busy&&!facts&&<p role="status">正在核对已保存版本和原执行状态…</p>}
        {error&&<p className="error-text" role="alert">{error}</p>}
        {facts&&<>
          {facts.draft?<p>{facts.inputOnly?"已保存输入版本":"未验收草稿"}：{facts.draft.changeId} · {facts.draft.version}</p>:<p>{facts.eligible?"沿用已核验的正式成果，只补剩余沟通。":"尚未核实可继续的成果，请查看下方原因。"}</p>}
          {!!facts.drafts?.length&&facts.drafts.length>1&&<label>选择来源
            <select disabled={busy} value={facts.draft?.changeId??''} onChange={e=>inspect(facts.drafts.find(d=>d.changeId===e.target.value))}>
              {facts.drafts.map(d=><option key={d.changeId} value={d.changeId}>{d.changeId} · {d.version.slice(0,12)}</option>)}
            </select>
          </label>}
          {facts.creditExhausted&&<p>服务商额度已耗尽，本轮已停止。请先恢复 API 额度，再明确确认继续；不会自动续跑。</p>}
          {!!facts.remainingRepair?.length&&<p>沿用已完成的判断，仍剩 1 次修复写入。允许路径：{facts.remainingRepair.join("、")}；原检查仍须全部通过。</p>}
          <p>剩余模型请求：{facts.remainingBudget?.maxCalls==null?'未设上限':facts.remainingBudget.maxCalls}。此次授权只消费一次。</p>
          {!!facts.models?.length&&<p>沿用阵容：{facts.models.join('；')}</p>}
          {!!facts.blockers?.length&&<ul aria-label="无法继续的原因">{facts.blockers.map((b,i)=><li key={i}>{b.message}（{b.sourceId??b.code}）</li>)}</ul>}
        </>}
        <button type="button" disabled={busy||!facts?.eligible||disabled} onClick={confirm}>确认并继续一次</button>
      </div>
    </Modal>}
  </>;
}
