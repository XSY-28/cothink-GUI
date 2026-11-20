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
const featuredIds=[
  ["openai","gpt-6.2-sol"], ["openai","gpt-6.2-astra"], ["anthropic","claude-fable-5-2"],
  ["anthropic","claude-sonnet-5-5"], ["deepseek","deepseek-flash"], ["moonshotai-cn","kimi-k3.1-pro"],
];
const rank=new Map(featuredIds.map((pair,i)=>[JSON.stringify(pair),i]));
const normalizeModelText = text => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu,"");
function matchModel(m,query) {
  const fields=[m.name,m.modelId,m.provider].filter(Boolean).map(normalizeModelText);
  return query.trim().split(/\s+/).map(normalizeModelText).every(word=>fields.some(field=>field.includes(word)));
}
export function ModelEditor({label, value, models, providers, used, onboarding, onIdentity, onParameters, children}) {
  const [search,setSearch]=useState("");
  const model = catalogModel(models,value);
  const thinking=thinkingPreferenceView(value.thinkingLevel),thinkingSelect=useRef(null);
  useLayoutEffect(()=>{if(thinking.error&&thinkingSelect.current)thinkingSelect.current.selectedIndex=-1;});
  const [browse,setBrowse]=useState(false),[providerFilter,setProviderFilter]=useState("");
  const configured=new Set(providers.filter(p=>p.configured).map(p=>p.id));
  const priority=m=>m.transport==="unsupported" ? 100 : rank.get(identity(m)) ?? (configured.has(m.provider) ? 20 : 40);
  const matches=models.filter(m=>(!browse || !providerFilter || m.provider===providerFilter) && matchModel(m,search))
    .sort((a,b)=>priority(a)-priority(b) || (a.name??a.modelId).localeCompare(b.name??b.modelId,undefined,{numeric:true}));
  const featured=matches.filter(m=>rank.has(identity(m)));
  const selection=!search.trim() && !providerFilter && featured.length
    ? [...featured,...matches.filter(m=>!rank.has(identity(m)) && configured.has(m.provider))] : matches;
  const options=browse && providerFilter ? [...matches] : selection.slice(0,12);
  if(model && !options.includes(model))options.unshift(model);
  const groups=Map.groupBy(options,m=>m.provider);
  const providerName=id=>providers.find(p=>p.id===id)?.name || id;
  const selectProviderIds=[...new Set(models.map(m=>m.provider))].sort((a,b)=>providerName(a).localeCompare(providerName(b)));
  const requiredLimit=outputLimitRequired(model);
  const outputEditor=<label>输出额度{requiredLimit ? "（协议必填，tokens）" : "（可留空）"}
    <input aria-label={`${label}输出额度`} type="number" min="1" step="1" required={requiredLimit}
      value={value.maxOutputTokens ?? ""} placeholder={requiredLimit ? "输入本次最大输出 tokens 数" : "不设本地上限"}
      onChange={e=>{const next={...value};if(e.target.value)next.maxOutputTokens=Number(e.target.value);else delete next.maxOutputTokens;onParameters(next);}}/>
  </label>;
  return <section className={styles.model}>
    <label>搜索{label}<input type="search" aria-label={`搜索${label}`} value={search}
      placeholder="名称、服务商或模型 ID" onChange={e=>setSearch(e.target.value)}
      onKeyDown={e=>{if(e.key==="Enter" && !e.nativeEvent.isComposing)e.preventDefault();}}/></label>
    {models.length>12 && <div className={styles.catalogBrowse}>
      <button type="button" aria-expanded={browse} onClick={()=>{setBrowse(!browse);setProviderFilter("");}}>
        {browse ? "收起服务商列表" : "按服务商浏览"}</button>
      {browse && <select aria-label={label+"服务商"} value={providerFilter} onChange={e=>{setProviderFilter(e.target.value);setSearch("");}}>
        <option value="">选择服务商</option>
        {selectProviderIds.map(id=><option key={id} value={id}>{providerName(id)}</option>)}
      </select>}
    </div>}
    <label>{label}<select required aria-label={label} value={value.modelId ? identity(value) : ""}
      onChange={e=>{const [provider,modelId]=JSON.parse(e.target.value);onIdentity({provider,modelId});setSearch("");setBrowse(false);setProviderFilter("");}}>
      <option value="" disabled>选择模型</option>
      {value.modelId && !model && <option value={identity(value)} disabled>{modelName(value)}（目录不可用）</option>}
      {[...groups].map(([id,rows])=><optgroup key={id} label={providerName(id)}>
        {rows.map(m=>{
          const duplicate=used?.has(identity(m));
          return <option key={identity(m)} value={identity(m)} disabled={duplicate || m.transport==="unsupported"}>
            {m.name || m.modelId}{rows.some(other=>other!==m && other.name===m.name) ? " · "+m.modelId : ""}{duplicate ? "（已占用其他席位）" : ""}{m.transport==="unsupported" ? "（协议不支持）" : ""}
          </option>;
        })}
      </optgroup>)}
    </select></label>
    {children}
    {search.trim() && !matches.length && <p className="field-note" role="status">没有匹配的模型。</p>}
    {matches.length>options.length && <p className="field-note">{search ? "可继续输入型号缩小范围，或按服务商浏览。" : "显示常用型号。搜索可查全部模型。"}</p>}
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
