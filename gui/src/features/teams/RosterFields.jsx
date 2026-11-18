import React from "react";
import {switchModelRoles} from "../../../../src/model-roster.js";
import {ModelEditor, identity} from "./ModelEditor.jsx";
import styles from "./TeamPanel.module.css";

const emptyRef = () => ({provider:"",modelId:""});
export const newRoster = (name="") => ({name,main:emptyRef(),secondary:[emptyRef()]});

export function RosterFields({draft,setDraft,models,providers,onboarding,disabled,actualThinking}) {
  return <fieldset disabled={disabled} className={styles.fields}>
    <label>新阵容名称<input aria-label="新阵容名称" required maxLength={80} value={draft.name} placeholder="为新阵容取名，原阵容保留"
      onChange={e=>setDraft({...draft,name:e.target.value})}/></label>
    <ModelEditor label="主模型" value={draft.main} models={models} providers={providers} onboarding={onboarding}
      used={onboarding ? new Set(draft.secondary.map(identity)) : undefined}
      onIdentity={next=>setDraft(d=>!onboarding && d.main.modelId ? switchModelRoles(d,next) : {...d,main:next})}
      onParameters={main=>setDraft({...draft,main})}/>
    {!onboarding && <p className="field-note">本对话统一采用 {actualThinking}，提交时覆盖所有模型的思考参数；另存保留各模型的三档配置。</p>}
    {draft.secondary.map((value,index)=><div key={index}>
      <ModelEditor label={`副模型 ${index+1}`} value={value} models={models} providers={providers} onboarding={onboarding}
        used={new Set([draft.main,...draft.secondary.filter((_,i)=>i!==index)].map(identity))}
        onIdentity={next=>setDraft(d=>({...d,secondary:d.secondary.map((r,i)=>i===index ? next : r)}))}
        onParameters={next=>setDraft(d=>({...d,secondary:d.secondary.map((r,i)=>i===index ? next : r)}))}/>
      {(!onboarding || draft.secondary.length>1) && <div className={styles.actions}>
        <small>协作候选</small>
        <button type="button" aria-label={`上移副模型 ${index+1}`} disabled={index===0} onClick={()=>setDraft(d=>{const rows=[...d.secondary];[rows[index-1],rows[index]]=[rows[index],rows[index-1]];return {...d,secondary:rows};})}>上移</button>
        <button type="button" aria-label={`下移副模型 ${index+1}`} disabled={index===draft.secondary.length-1} onClick={()=>setDraft(d=>{const rows=[...d.secondary];[rows[index+1],rows[index]]=[rows[index],rows[index+1]];return {...d,secondary:rows};})}>下移</button>
        <button type="button" aria-label={`移除副模型 ${index+1}`} disabled={draft.secondary.length===1} onClick={()=>setDraft({...draft,secondary:draft.secondary.filter((_,i)=>i!==index)})}>移除</button>
      </div>}
    </div>)}
    <button type="button" onClick={()=>setDraft({...draft,secondary:[...draft.secondary,emptyRef()]})}>＋ 添加副模型</button>
  </fieldset>;
}

export function RosterAuthFields({authProviders,providers,keys,setKeys,authUnknown,onboarding,hasProviderSettings,
  disabled,pending,onSaveKey,onRefresh}) {
  return authProviders.map(id=>{
    const p=providers.find(x=>x.id===id),uncertain=authUnknown.includes(id);
    return <section className={styles.auth} key={id} aria-label={`${id}认证`}>
      <strong>{p?.name || id} · {id}</strong>
      <p>{p?.configured ? `将复用${({oauth:" OAuth 登录",environment:"环境认证",api_key:"已配置 API key",configured:"已有认证"})[p.authKind] || "已有认证"}；保存不代表远端权限已验证。`
        : p?.apiKey ? onboarding ? "请在服务商的开发者控制台创建 API Key。费用取决于服务商与账户。" : "缺少认证，可在此保存 API key，随后继续编辑阵容。"
          : hasProviderSettings ? "缺少认证。请在模型与认证设置中登录，或配置环境凭据。"
            : "需先在 CLI /login 完成 OAuth 或环境认证，然后刷新；当前编辑保留。"}</p>
      {!p?.configured && p?.apiKey && <><label>API key<input type="password" autoComplete="new-password" aria-label={`${id} API key`}
        disabled={disabled || uncertain} value={keys[id] || ""} onChange={e=>setKeys({...keys,[id]:e.target.value})}/></label>
        <button type="button" disabled={disabled || uncertain || !keys[id]?.trim()} onClick={()=>onSaveKey(id)}>保存 {id} 认证</button></>}
      {uncertain && <p role="status">认证保存结果未知；只刷新核对，不自动重传密钥。</p>}
      {!p?.configured && <button type="button" disabled={pending} onClick={onRefresh}>刷新认证状态</button>}
    </section>;
  });
}
