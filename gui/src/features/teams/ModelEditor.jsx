import React, { useState } from "react";
import {modelName} from "../../view.js";
import styles from "./TeamPanel.module.css";

export const identity = ref => JSON.stringify([ref?.provider, ref?.modelId]);
export const matchesSearch = (query, values) => {
  const text=values.filter(Boolean).join(" ").toLowerCase();
  return query.trim().toLowerCase().split(/\s+/).every(word=>text.includes(word));
};
export const catalogModel = (models, ref) => models.find(m => identity(m) === identity(ref));
export const outputLimitRequired = model => model?.outputLimitRequired ?? model?.api === "anthropic-messages";
export function ModelEditor({label, value, models, providers, used, onIdentity, onParameters}) {
  const [search,setSearch]=useState("");
  const model = catalogModel(models,value);
  const options=models.filter(m=>matchesSearch(search,[m.name,m.provider,m.modelId]));
  return <section className={styles.model}>
    <label>搜索{label}<input type="search" aria-label={`搜索${label}`} value={search}
      placeholder="名称、服务商或模型 ID" onChange={e=>setSearch(e.target.value)}
      onKeyDown={e=>{if(e.key==="Enter" && !e.nativeEvent.isComposing)e.preventDefault();}}/></label>
    <label>{label}<select required aria-label={label} value={value.modelId ? identity(value) : ""}
      onChange={e=>{const [provider,modelId]=JSON.parse(e.target.value);onIdentity({provider,modelId});setSearch("");}}>
      <option value="" disabled>选择模型</option>
      {value.modelId && !model && <option value={identity(value)} disabled>{modelName(value)}（目录不可用）</option>}
      {(model && !options.includes(model) ? [model,...options] : options).map(m=>{
        const duplicate=used?.has(identity(m));
        const auth=providers.find(provider=>provider.id===m.provider);
        return <option key={identity(m)} value={identity(m)} disabled={duplicate}>
          {m.name} · {m.provider} / {m.modelId}{duplicate ? "（已占用其他席位）" : ""}{!auth?.configured ? "（缺少认证）" : ""}{m.transport==="unsupported" ? "（统一会话不可用）" : ""}
        </option>;
      })}
    </select></label>
    {search.trim() && !options.length && <p className="field-note" role="status">没有匹配的模型。</p>}
    {value.modelId && !model && <p className="field-note">所选模型已不在当前目录中，请选择可用的模型。</p>}
    <details className={styles.parameters}><summary>思考与输出额度</summary>
      <div className="form-grid">
        <label>思考档位<select aria-label={`${label}思考档位`} value={value.thinkingLevel ?? ""}
          disabled={!model?.thinkingLevels?.length} onChange={e=>{const next={...value};if(e.target.value)next.thinkingLevel=e.target.value;else delete next.thinkingLevel;onParameters(next);}}>
          <option value="">{model?.reasoning ? "默认 high" : "默认 off（不启用思考）"}</option>
          {value.thinkingLevel && !model?.thinkingLevels?.includes(value.thinkingLevel) && <option value={value.thinkingLevel} disabled>{value.thinkingLevel}（当前模型不支持）</option>}
          {model?.thinkingLevels?.map(level=><option key={level}>{level}</option>)}
        </select></label>
        <label>输出额度{outputLimitRequired(model) ? "（协议必填）" : "（可留空）"}
          <input aria-label={`${label}输出额度`} type="number" min="1" step="1" required={outputLimitRequired(model)}
            value={value.maxOutputTokens ?? ""} placeholder="不设本地上限"
            onChange={e=>{const next={...value};if(e.target.value)next.maxOutputTokens=Number(e.target.value);else delete next.maxOutputTokens;onParameters(next);}}/>
        </label>
      </div>
      {model && <p className="field-note">协议 {model.api} · 输入 {model.input?.join(" / ") ?? "未知"} · 目录上下文 {model.contextWindow ?? "未知"} tokens；目录能力不是已设置的额度。</p>}
    </details>
  </section>;
}
