import React, { useState, useLayoutEffect, useRef } from "react";
import {modelName,THINKING_LEVELS,thinkingPreferenceView} from "../../view.js";
import styles from "./TeamPanel.module.css";

export const identity = ref => JSON.stringify([ref?.provider, ref?.modelId]);
export const matchesSearch = (query, values) => {
  const text=values.filter(Boolean).join(" ").toLowerCase();
  return query.trim().toLowerCase().split(/\s+/).every(word=>text.includes(word));
};
export const catalogModel = (models, ref) => models.find(m => identity(m) === identity(ref));
export const outputLimitRequired = model => model?.outputLimitRequired ?? model?.api === "anthropic-messages";
export function ModelEditor({label, value, models, providers, used, onboarding, onIdentity, onParameters}) {
  const [search,setSearch]=useState("");
  const model = catalogModel(models,value);
  const thinking=thinkingPreferenceView(value.thinkingLevel),thinkingSelect=useRef(null);
  useLayoutEffect(()=>{if(thinking.error&&thinkingSelect.current)thinkingSelect.current.selectedIndex=-1;});
  const options=models.filter(m=>matchesSearch(search,[m.name,m.provider,m.modelId]));
  const unsupported = m => m.transport === "unsupported";
  if (onboarding) options.sort((a,b)=>Number(unsupported(a))-Number(unsupported(b)));
  const requiredLimit=outputLimitRequired(model);
  const outputEditor=<label>输出额度{requiredLimit ? "（协议必填，tokens）" : "（可留空）"}
    <input aria-label={`${label}输出额度`} type="number" min="1" step="1" required={requiredLimit}
      value={value.maxOutputTokens ?? ""} placeholder="不设本地上限"
      onChange={e=>{const next={...value};if(e.target.value)next.maxOutputTokens=Number(e.target.value);else delete next.maxOutputTokens;onParameters(next);}}/>
  </label>;
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
        return <option key={identity(m)} value={identity(m)} disabled={duplicate || onboarding && unsupported(m)}>
          {m.name} · {m.provider} / {m.modelId}{duplicate ? "（已占用其他席位）" : ""}{!auth?.configured ? "（缺少认证）" : ""}{m.transport==="unsupported" ? "（统一会话不可用）" : ""}
        </option>;
      })}
    </select></label>
    {search.trim() && !options.length && <p className="field-note" role="status">没有匹配的模型。</p>}
    {value.modelId && !model && <p className="field-note">所选模型已不在当前目录中，请选择可用的模型。</p>}
    {onboarding && requiredLimit && outputEditor}
    <details className={styles.parameters}><summary>{onboarding && requiredLimit ? "思考档位" : "思考与输出额度"}</summary>
      <div className="form-grid">
        <label>思考档位<select aria-label={`${label}思考档位`} ref={thinkingSelect} required aria-invalid={thinking.error?true:undefined} value={thinking.level??""}
          onChange={e=>onParameters({...value,thinkingLevel:e.target.value})}>
          {THINKING_LEVELS.map(level=><option key={level}>{level}</option>)}
        </select>{thinking.error&&<span className="field-note" role="alert">{thinking.error}</span>}</label>
        {!(onboarding && requiredLimit) && outputEditor}
      </div>
      {model && <p className="field-note">协议 {model.api} · 输入 {model.input?.join(" / ") ?? "未知"} · 目录上下文 {model.contextWindow ?? "未知"} tokens；目录能力不是已设置的额度。</p>}
    </details>
  </section>;
}

export function routeIssue(ref, models, providers, checkAuth=true) {
  const model = catalogModel(models, ref);
  if (!model) return `${modelName(ref)}：目录不可用`;
  if (model.transport === "unsupported") return `${modelName(ref)}：当前协议不可用于统一会话`;
  const preference=thinkingPreferenceView(ref.thinkingLevel);
  if(preference.error)return `${modelName(ref)}：${preference.error}`;
  const thinking=preference.level;
  if (thinking != null && !model.thinkingLevels?.includes(thinking))
    return `${modelName(ref)} 不支持思考档位 ${thinking}`;
  if (outputLimitRequired(model) && ref.maxOutputTokens == null)
    return `${modelName(ref)} 需要设置输出额度`;
  if (ref.maxOutputTokens != null && (!Number.isSafeInteger(ref.maxOutputTokens) || ref.maxOutputTokens<1))
    return `${modelName(ref)} 的输出额度须为正整数`;
  if (checkAuth && !(model.auth ? model.auth === "configured" : providers.find(provider => provider.id === ref.provider)?.configured))
    return `${ref.provider} 缺少认证（${modelName(ref)}）`;
  return "";
}
