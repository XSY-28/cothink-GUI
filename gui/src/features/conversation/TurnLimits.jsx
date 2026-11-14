import React from "react";
import {defaultTurnOptions,retiredReviewOption} from "../../../../src/gui-turn-options.js";
import {Modal} from "../../Modal.jsx";
import styles from "./Conversation.module.css";

export function TurnLimits({available, team, models=[], options, onChange, onClose, returnFocusTo}) {
  const {readOnly, delegate, maxCalls, allowFileContinuation} = options ?? defaultTurnOptions();
  const needsReviewUpdate = retiredReviewOption(options);
  const refs = team ? [team.main, ...team.secondary] : [];
  return <Modal title="下一条消息的限制" onClose={onClose} returnFocusTo={returnFocusTo}>
    <div className="dialog-body">
      {available ? <>
        <p className="field-note">保存到当前草稿，发送时生效。</p>
        <label className={styles.turnChoice}>
          <input type="checkbox" checked={readOnly} onChange={event=>onChange({readOnly:event.target.checked})}/>
          只分析，不修改
        </label>
        <label className={styles.turnChoice}>
          <input type="checkbox" checked={delegate!==true} disabled={needsReviewUpdate} onChange={event=>onChange({delegate:!event.target.checked})}/>
          禁止派工
        </label>
        <p className="field-note">{needsReviewUpdate ? "请先在草稿中确认采用现行规则。" : "勾选后仅由主模型工作。若成果要求独立审查，需先解决冲突。"}</p>
        <label className={styles.turnChoice}>
          <input type="checkbox" checked={allowFileContinuation===true} disabled={readOnly}
            onChange={event=>onChange({allowFileContinuation:event.target.checked})}/>
          模型连接中断后，允许从保存成果继续一次
        </label>
        <p className="field-note">仅在原本地执行已结清且没有相关未决操作时生效。继续使用本轮剩余额度；旧请求与未知费用保留。再次中断或主动取消后不会自动继续。</p>
        <label>本轮最多模型请求（留空不设上限）
          <input type="number" min="0" step="1" value={maxCalls} onChange={event=>onChange({maxCalls:event.target.value})}/>
        </label>
        <details className={styles.turnLimitPolicy}>
          <summary>调用与输出额度详情</summary>
          {refs.map((ref,index)=>{
            const model=models.find(model=>model.provider===ref.provider && model.modelId===ref.modelId);
            const output=ref.maxOutputTokens==null ? model ? "未设本地输出上限" : "模型目录不可用，输出额度要求未知" : `${ref.maxOutputTokens} tokens`;
            return <p key={`${ref.provider}/${ref.modelId}`}>{index===0 ? "主模型" : `副模型 ${index}`} {ref.provider}/{ref.modelId}：{output}
              {(model?.outputLimitRequired ?? model?.api==="anthropic-messages") && ref.maxOutputTokens==null && "（协议必填，请在阵容中设置）"}</p>;
          })}
          <p>简单答复通常一次请求，读取材料后的续答、评审和正式工作按实际请求计账。默认不设调用上限；确认工作沿用提议剩余额度。没有默认模型超时；自动重试、压缩、预热关闭。未知用量与费用保持未知，目录估价不等于账单。</p>
        </details>
      </> : <p role="status">当前草稿暂不可编辑。</p>}
    </div>
  </Modal>;
}
