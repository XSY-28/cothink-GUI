import React, {forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState} from "react";
import {switchModelRoles} from "../../../../src/model-roster.js";
import {modelName} from "../../view.js";
import styles from "./TeamPanel.module.css";

const identity = ref => JSON.stringify([ref?.provider, ref?.modelId]);
const emptyRef = () => ({provider:"",modelId:""});
const matchesSearch = (query, values) => {
  const text=values.filter(Boolean).join(" ").toLowerCase();
  return query.trim().toLowerCase().split(/\s+/).every(word=>text.includes(word));
};
const catalogModel = (models, ref) => models.find(m => identity(m) === identity(ref));
// Model refs have four allowed fields. Compare their values, not object key order.
const rosterParameters = team => JSON.stringify([team.main,...team.secondary].map(r=>[r.provider,r.modelId,r.thinkingLevel ?? null,r.maxOutputTokens ?? null]));
const rosterText = team => `主：${modelName(team.main)}；副：${team.secondary.map(modelName).join("、")}`;
function parameterText(ref) {
  return `${modelName(ref)} · 思考 ${ref.thinkingLevel ?? "默认"} · ${ref.maxOutputTokens == null ? "未设输出额度" : ref.maxOutputTokens+" tokens"}`;
}
function rosterIssue(team, models, providers) {
  for (const ref of [team.main, ...team.secondary]) {
    const model = catalogModel(models, ref);
    if (!model) return `${modelName(ref)}：目录不可用`;
    if (!providers.find(provider => provider.id === ref.provider)?.configured) {
      return `${ref.provider} 缺少认证（${modelName(ref)}）`;
    }
    if (ref.thinkingLevel != null && !model.thinkingLevels?.includes(ref.thinkingLevel)) {
      return `${modelName(ref)} 不支持思考档位 ${ref.thinkingLevel}`;
    }
    if (model.api === "anthropic-messages" && ref.maxOutputTokens == null) {
      return `${modelName(ref)} 需要设置输出额度`;
    }
  }
  return "";
}
function ModelEditor({label, value, models, providers, used, onIdentity, onParameters}) {
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
          {m.name} · {m.provider} / {m.modelId}{duplicate ? "（已占用其他席位）" : ""}{!auth?.configured ? "（缺少认证）" : ""}
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
        <label>输出额度{model?.api === "anthropic-messages" ? "（协议必填）" : "（可留空）"}
          <input aria-label={`${label}输出额度`} type="number" min="1" step="1" required={model?.api === "anthropic-messages"}
            value={value.maxOutputTokens ?? ""} placeholder="不设本地上限"
            onChange={e=>{const next={...value};if(e.target.value)next.maxOutputTokens=Number(e.target.value);else delete next.maxOutputTokens;onParameters(next);}}/>
        </label>
      </div>
      {model && <p className="field-note">协议 {model.api} · 目录上下文 {model.contextWindow ?? "未知"} tokens；目录能力不是已设置的额度。</p>}
    </details>
  </section>;
}

/** Feature-local edits; the caller owns the modal and focus restoration. */
export const TeamPanel = forwardRef(function TeamPanel({session, workspace, teams=[], models=[], providers=[], busy, commands, onClose}, ref) {
  const [draft,setDraft]=useState(null), [baseline,setBaseline]=useState("");
  const [search,setSearch]=useState(""), [menu,setMenu]=useState(null);
  const [deleting,setDeleting]=useState(null), [leave,setLeave]=useState(null);
  const [pending,setPending]=useState(false), [error,setError]=useState(""), [notice,setNotice]=useState("");
  const [defaultRetry,setDefaultRetry]=useState(null);
  const [unknown,setUnknown]=useState(null), [saved,setSaved]=useState(null);
  const [keys,setKeys]=useState({}), [authUnknown,setAuthUnknown]=useState([]);
  const operation=useRef(false), panel=useRef(null), editingFocus=useRef(null), focusRequest=useRef(null), focusMounted=useRef(false);
  // Local controls can disappear or become disabled during a transition. Keep
  // keyboard events inside the modal without changing its shared focus trap.
  useLayoutEffect(()=>{
    // The carrier captures the opener before choosing initial focus. Do not
    // preempt that mount-time capture with this feature's transition recovery.
    if(!focusMounted.current){focusMounted.current=true;return;}
    const root=panel.current;if(!root)return;
    const requested=focusRequest.current;focusRequest.current=null;
    const active=document.activeElement;
    const usable=node=>node?.isConnected && !node.matches(":disabled") && !node.closest("[hidden],[inert]") && node.getClientRects().length;
    if(!requested && active!==document.body && usable(active))return;
    const target=typeof requested==="string" ? root.querySelector(requested) : requested;
    const field=root.querySelector('[aria-label="新阵容名称"], [aria-label="搜索阵容"]');
    for(const candidate of [target,field,root]){
      if(usable(candidate)){candidate.focus();if(document.activeElement===candidate)break;}
    }
  });
  const dirty=!!draft && JSON.stringify(draft)!==baseline;
  const hasKeys=Object.values(keys).some(Boolean);
  const sessionId=session?.id, current=session?.team;
  const writable=!!sessionId && !workspace?.archived && !session.readOnly && !session.navigation?.archived && !session.selectionError && !session.navigationError;
  const disabled=busy || pending;
  const canSetDefault=!!workspace?.id && !workspace.archived;
  const defaultRoster=teams.find(team=>team.id===workspace?.defaultRosterId);
  const currentModel=catalogModel(models,current?.main);
  const actualThinking=session?.thinking ?? current?.main.thinkingLevel ?? (currentModel?.reasoning ? "high" : currentModel ? "off" : "未知");
  function requestLeave(action) {
    if(operation.current){setNotice("正在确认操作结果，请稍候。");return;}
    if(dirty || unknown || hasKeys){focusRequest.current="[data-team-continue]";setLeave(()=>action);return;}
    action();
  }
  useImperativeHandle(ref,()=>({requestClose:()=>requestLeave(onClose)}));
  useEffect(()=>{
    if(!dirty && !unknown && !hasKeys)return;
    const prevent=e=>{e.preventDefault();e.returnValue="";};
    window.addEventListener("beforeunload",prevent);
    return()=>window.removeEventListener("beforeunload",prevent);
  },[dirty,unknown,hasKeys]);
  function home(){focusRequest.current='[aria-label="搜索阵容"]';setMenu(null);setDraft(null);setUnknown(null);setDeleting(null);setKeys({});setError("");}
  function begin(source){requestLeave(()=>{
    const value=source ? {name:"",main:structuredClone(source.main),secondary:structuredClone(source.secondary)}
      : {name:"",main:emptyRef(),secondary:[emptyRef()]};
    focusRequest.current='[aria-label="新阵容名称"]';setMenu(null);setDraft(value);setBaseline(JSON.stringify(value));setUnknown(null);setSaved(null);setDeleting(null);setError("");setNotice("");setKeys({});
  });}
  async function run(action) {
    if(operation.current)return;
    const trigger=document.activeElement;
    operation.current=true;setPending(true);setError("");
    try{return await action();}catch(e){setError(e.message);if(e.unknown) await commands.refresh();}
    finally{operation.current=false;focusRequest.current=trigger;setPending(false);}
  }
  async function saveDefault(team, row) {
    try {
      await commands.updateWorkspace(row,{defaultRosterId:team.id});
      setDefaultRetry(null);
      setNotice(`此 Team 的新对话默认使用「${team.name}」。`);
    } catch(error) {
      if (error.unknown) {
        const latest=await commands.refreshTeams().catch(()=>null);
        const observed=latest?.workspaces?.find(item=>item.id===row.id);
        if (observed?.defaultRosterId===team.id) {
          setDefaultRetry(null);
          setNotice(`已读取保存状态。此 Team 的新对话默认使用「${team.name}」。`);
          return;
        }
      }
      setDefaultRetry({team,workspaceId:row.id});
      setNotice(error.unknown ? "默认阵容保存结果未知，请先核对。" : "默认阵容未保存。");
      throw error;
    }
  }
  async function retryDefault() {
    const {team,workspaceId}=defaultRetry;
    const fresh=await commands.refreshTeams();
    const row=fresh.workspaces?.find(item=>item.id===workspaceId);
    if (!row || row.archived) throw Error("Team 已归档或暂不可用，无法保存默认阵容。");
    if (row.defaultRosterId===team.id) {
      setDefaultRetry(null);
      setNotice(`当前默认阵容已是「${team.name}」。`);
      return;
    }
    await saveDefault(team,row);
  }
  async function select(team, prefix="") {
    try {
      await commands.selectTeam({sessionId,teamId:team.id});
      setNotice(`${prefix}当前对话已使用「${team.name}」，旧回复保持原阵容。`);
    } catch(e) {
      setNotice(`${prefix}${e.unknown ? "当前对话切换结果未知，请读取状态核对。" : "当前对话未切换。"}`);
      if(e.unknown) await commands.refresh();
      throw e;
    }
  }
  async function save(use) {
    const value=structuredClone(draft);
    const refs=[value.main,...value.secondary];
    if(refs.some(r=>!r.provider || !r.modelId) || !value.secondary.length)throw Error("请选择主模型及至少一个副模型。");
    if(new Set(refs.map(identity)).size!==refs.length)throw Error("同一个模型不能重复占据席位。");
    let team;
    try { team=await commands.saveTeam(value); }
    catch(e){if(e.unknown){setUnknown(value);setNotice("保存结果未知。编辑内容保留，只读取阵容列表核对，不会自动再次创建。");await commands.refreshTeams().catch(()=>{});}throw e;}
    setSaved(team);setDraft(null);setUnknown(null);setKeys({});
    setNotice(`已保存「${team.name}」；当前对话尚未切换。`);
    if(use && writable) await select(team,`已保存「${team.name}」。`);
  }
  async function refreshUnknown(){
    const fresh=await commands.refreshTeams();
    setAuthUnknown(ids=>ids.filter(id=>!fresh.providers?.find(p=>p.id===id)?.configured));
    await commands.refresh();
    setNotice("已重新读取保存状态；请核对下面的实际阵容。未重复保存或切换。");
  }
  const authProviders=[...new Set((draft ? [draft.main,...draft.secondary] : []).map(r=>r.provider).filter(Boolean))];
  const shortModel = value => catalogModel(models,value)?.name || value.modelId || "目录不可用";
  const rosterLabel = team => `主：${shortModel(team.main)}；副：${team.secondary.map(shortModel).join("、")}`;
  const matchingTeams=teams.filter(team=>matchesSearch(search,[team.name,...[team.main,...team.secondary].flatMap(model=>[shortModel(model),model.provider,model.modelId])]));
  const sameName=unknown ? teams.filter(t=>t.name===unknown.name.trim().normalize("NFC")) : [];
  return <div className={styles.panel} ref={panel} tabIndex={-1} onKeyDownCapture={e=>{
    if(e.key!=="Escape" || (!menu && !deleting && !leave))return;
    e.preventDefault();e.stopPropagation();
    if(leave){focusRequest.current=editingFocus.current || '[aria-label="新阵容名称"]';setLeave(null);}
    else if(!operation.current){
      focusRequest.current=panel.current.querySelector('[aria-expanded="true"][data-roster-actions]') || '[aria-label="搜索阵容"]';
      if(deleting)setDeleting(null);else setMenu(null);
    }
  }} onFocusCapture={e=>{
    if(e.target.matches("input,select,textarea") && e.target.closest("form"))editingFocus.current=e.target;
  }}>
    <div className={styles.intro}><div><small>当前对话</small><h3>{current?.name || "尚未选择阵容"}</h3>
      {current && <p title={rosterText(current)}>{rosterLabel(current)}</p>}</div>
      <button type="button" className="primary" disabled={disabled} onClick={()=>begin(null)}>＋ 新建阵容</button></div>
    {workspace && <p className="field-note">此 Team 的新对话默认阵容：{defaultRoster?.name || (workspace.defaultRosterId ? "原阵容已删除，请为新对话选择" : "尚未设置")}</p>}
    {busy && <p className="field-note">任务进行中，阵容暂只读；结束或停止后可修改。草稿不会排队。</p>}
    {!writable && <p className="field-note">当前没有可编辑的对话，无法切换当前阵容或删除保存的阵容。</p>}
    {current && <details className={styles.thinking}>
      <summary>对话参数 · 思考 {actualThinking}</summary>
      <p>本对话主模型实际思考：<strong>{actualThinking}</strong>{session.thinking != null ? `（对话设置，覆盖阵容中的 ${current.main.thinkingLevel ?? "默认值"}）` : "（跟随阵容）"}</p>
      {session.thinking != null && !currentModel?.thinkingLevels?.includes(session.thinking) && <p role="alert" className="error-text">此对话的思考设置不被当前模型支持；发送前请选择兼容档位或跟随阵容。</p>}
      <label>此对话的思考设置<select aria-label="此对话的思考设置" disabled={!writable || disabled}
        value={session.thinking ?? ""} onChange={e=>{if(!writable || disabled)return;const level=e.target.value;run(async()=>{
          await commands.changeSession("session.thinking",level ? {level} : {},sessionId);
          setNotice("对话思考设置已保存；仅影响之后的提交，取消阵容编辑不会撤销它。");
        });}}>
        <option value="">跟随阵容</option>
        {session.thinking != null && !currentModel?.thinkingLevels?.includes(session.thinking) && <option value={session.thinking}>{session.thinking}（不支持）</option>}
        {currentModel?.thinkingLevels?.map(level=><option key={level}>{level}</option>)}
      </select></label>
    </details>}
    {error && <p className="error-text" role="alert">{error}</p>}
    {notice && <p className={styles.notice} role="status">{notice}</p>}
    {defaultRetry?.workspaceId===workspace?.id && defaultRetry && <button type="button" disabled={disabled || !canSetDefault}
      onClick={()=>run(retryDefault)}>重新保存默认阵容</button>}
    {saved && !draft && current?.id!==saved.id && <button type="button" disabled={disabled || !writable} onClick={()=>run(()=>select(saved,`「${saved.name}」已保存。`))}>使用已保存的「{saved.name}」</button>}
    {leave && <div className={styles.confirm} role="alert">
      <p>放弃未保存的编辑？{unknown && "保存结果仍未知，关闭不会撤销可能已保存的阵容。"}已确认保存的认证及对话思考设置会保留。</p>
      <button type="button" data-team-continue onClick={()=>{focusRequest.current=editingFocus.current || '[aria-label="新阵容名称"]';setLeave(null);}}>继续编辑</button>
      <button type="button" onClick={()=>{const next=leave;setLeave(null);setKeys({});next();}}>放弃未保存修改</button>
    </div>}
    {draft ? <>
      <button type="button" disabled={pending} onClick={()=>requestLeave(home)}>← 返回已保存阵容</button>
      <form onSubmit={e=>{e.preventDefault();if(!unknown)run(()=>save(false));}}>
        <fieldset disabled={disabled || !!unknown} className={styles.fields}>
          <label>新阵容名称<input aria-label="新阵容名称" required maxLength={80} value={draft.name} placeholder="为新阵容取名，原阵容保留"
            onChange={e=>setDraft({...draft,name:e.target.value})}/></label>
          <ModelEditor label="主模型" value={draft.main} models={models} providers={providers}
            onIdentity={next=>setDraft(d=>d.main.modelId ? switchModelRoles(d,next) : {...d,main:next})}
            onParameters={main=>setDraft({...draft,main})}/>
          {session?.thinking != null && <p className="field-note">当前对话的 {session.thinking} 会优先于这里的主模型思考参数；另存只保存阵容参数，可在上方明确选择“跟随阵容”。</p>}
          {draft.secondary.map((value,index)=><div key={index}>
            <ModelEditor label={`副模型 ${index+1}`} value={value} models={models} providers={providers}
              used={new Set([draft.main,...draft.secondary.filter((_,i)=>i!==index)].map(identity))}
              onIdentity={next=>setDraft(d=>({...d,secondary:d.secondary.map((r,i)=>i===index ? next : r)}))}
              onParameters={next=>setDraft(d=>({...d,secondary:d.secondary.map((r,i)=>i===index ? next : r)}))}/>
            <div className={styles.actions}>
              <small>{index===0 ? "普通问答的评审模型" : "项目工作可参与"}</small>
              <button type="button" aria-label={`上移副模型 ${index+1}`} disabled={index===0} onClick={()=>setDraft(d=>{const rows=[...d.secondary];[rows[index-1],rows[index]]=[rows[index],rows[index-1]];return {...d,secondary:rows};})}>上移</button>
              <button type="button" aria-label={`下移副模型 ${index+1}`} disabled={index===draft.secondary.length-1} onClick={()=>setDraft(d=>{const rows=[...d.secondary];[rows[index+1],rows[index]]=[rows[index],rows[index+1]];return {...d,secondary:rows};})}>下移</button>
              <button type="button" aria-label={`移除副模型 ${index+1}`} disabled={draft.secondary.length===1} onClick={()=>setDraft({...draft,secondary:draft.secondary.filter((_,i)=>i!==index)})}>移除</button>
            </div>
          </div>)}
          <button type="button" onClick={()=>setDraft({...draft,secondary:[...draft.secondary,emptyRef()]})}>＋ 添加副模型</button>
        </fieldset>
        {authProviders.map(id=>{const p=providers.find(x=>x.id===id);const uncertain=authUnknown.includes(id);
          return <section className={styles.auth} key={id} aria-label={`${id}认证`}>
            <strong>{p?.name || id} · {id}</strong>
            <p>{p?.configured ? `将复用${({oauth:" OAuth 登录",environment:"环境认证",api_key:"已配置 API key",configured:"已有认证"})[p.authKind] || "已有认证"}；保存不代表远端权限已验证。`
              : p?.apiKey ? "缺少认证，可在此保存 API key，随后继续编辑阵容。" : "需先在 CLI /login 完成 OAuth 或环境认证，然后刷新；当前编辑保留。"}</p>
            {!p?.configured && p?.apiKey && <><label>API key<input type="password" autoComplete="new-password" aria-label={`${id} API key`}
              disabled={disabled || uncertain || !!unknown} value={keys[id] || ""} onChange={e=>setKeys({...keys,[id]:e.target.value})}/></label>
              <button type="button" disabled={disabled || uncertain || !!unknown || !keys[id]?.trim()} onClick={()=>{
                const apiKey=keys[id];setKeys(k=>({...k,[id]:""}));run(async()=>{try{
                  await commands.saveProvider({providerId:id,apiKey});setNotice(`${id} 认证已保存，远端权限尚未验证；取消阵容编辑也会保留认证。`);
                }catch(e){if(e.unknown)setAuthUnknown(v=>[...new Set([...v,id])]);throw e;}});
              }}>保存 {id} 认证</button></>}
            {uncertain && <p role="status">认证保存结果未知；只刷新核对，不自动重传密钥。</p>}
            {!p?.configured && <button type="button" disabled={pending} onClick={()=>run(refreshUnknown)}>刷新认证状态</button>}
          </section>;
        })}
        {unknown && <section className={styles.confirm}>
          <p>保存结果未知，表单保留。找到同名阵容也不会自动使用或再次创建。</p>
          <button type="button" disabled={pending} onClick={()=>run(refreshUnknown)}>读取阵容列表核对</button>
          {sameName.length ? sameName.map(t=><div key={t.id}><strong>实际保存的「{t.name}」</strong><ul>{[t.main,...t.secondary].map((r,i)=><li key={i}>{i===0?"主":"副 "+i}：{parameterText(r)}</li>)}</ul></div>) : <p>当前列表未找到同名阵容；仍不能确认未保存。</p>}
        </section>}
        <div className={styles.actions}>
          <button type="button" disabled={pending} onClick={()=>requestLeave(home)}>取消编辑</button>
          <button type="submit" className="secondary" disabled={disabled || !!unknown}>仅保存新阵容</button>
          <button type="button" className="primary" disabled={disabled || !!unknown || !writable}
            onClick={e=>{if(e.currentTarget.form.reportValidity())run(()=>save(true));}}>保存并使用</button>
        </div>
      </form>
    </> : <>
      <div className={styles.heading}><h3>已保存的阵容</h3><small>切换仅影响之后的提交</small></div>
      <input type="search" aria-label="搜索阵容" placeholder="搜索阵容名称或模型" value={search}
        onChange={e=>{setSearch(e.target.value);setMenu(null);setDeleting(null);}}/>
      {!matchingTeams.length && <p className="field-note" role="status">{teams.length ? "没有匹配的阵容。" : "尚无已保存的阵容。"}</p>}
      <div className={styles.list}>{matchingTeams.map(team=>{
        const selected=team.id===current?.id;
        const differsFromCurrent=selected && rosterParameters(team)!==rosterParameters(current);
        const issue=rosterIssue(team,models,providers);
        const reason=selected ? "当前对话正在使用，请先切换" : teams.length<=1 ? "至少保留一个阵容" : !writable ? "当前对话不可管理" : "";
        const isOpen=menu===team.id;
        const isDefault=workspace?.defaultRosterId===team.id;
        return <div className={`${styles.card} ${selected ? styles.selected : ""}`} key={team.id}>
          <div className={styles.row}>
            <button type="button" className={styles.pick} aria-current={selected || undefined}
              disabled={disabled || !writable || selected} aria-label={`使用 ${team.name}`}
              onClick={()=>{setMenu(null);setDeleting(null);run(()=>select(team));}}>
              <span><strong>{team.name}</strong>{selected && <span className={styles.tag}>当前</span>}{isDefault && <span className={styles.tag}>Team 默认</span>}</span>
              <span className={styles.rosterModels} title={rosterText(team)}>{rosterLabel(team)}</span>
              {differsFromCurrent && <span className={styles.rosterModels}>已保存参数与当前快照不同</span>}
              {issue && <span className={styles.rosterModels}>{issue}</span>}
            </button>
            <button type="button" className={styles.more} aria-label={`管理 ${team.name}`} aria-expanded={isOpen} data-roster-actions
              onClick={()=>{setMenu(isOpen ? null : team.id);setDeleting(null);}}>⋯</button>
          </div>
          {isOpen && <div className={styles.management} role="group" aria-label={`${team.name}的管理操作`}>
            {differsFromCurrent && <>
              <p className="field-note">当前对话保留不同参数的历史快照，可明确使用已保存参数；旧回复不变。</p>
              <button type="button" disabled={disabled || !writable} onClick={()=>run(()=>select(team))}>使用已保存参数</button>
              <button type="button" disabled={disabled} onClick={()=>begin(current)}>按当前快照另存</button>
            </>}
            {workspace && <button type="button" disabled={disabled || !canSetDefault || isDefault || !!issue}
              aria-label={`将 ${team.name} 设为此 Team 默认`} onClick={()=>run(()=>saveDefault(team,workspace))}>设为此 Team 默认</button>}
            <button type="button" disabled={disabled} aria-label={`调整 ${team.name}`} onClick={()=>begin(team)}>调整另存</button>
            <button type="button" disabled={disabled || !!reason} title={reason} aria-label={`删除 ${team.name}`}
              onClick={()=>{focusRequest.current="[data-team-cancel-delete]";setDeleting(team);}}>删除</button>
            {reason && <p className="field-note">{reason}{selected && teams.length<=1 ? "；至少保留一个阵容" : ""}。</p>}
            {deleting?.id===team.id && <div className={styles.confirm} role="alert"><p>删除已保存的「{deleting.name}」？模型、认证和已有对话快照保留。</p>
              <button type="button" data-team-cancel-delete disabled={pending} onClick={()=>{focusRequest.current=panel.current.querySelector('[aria-expanded="true"][data-roster-actions]');setDeleting(null);}}>取消删除</button>
              <button type="button" disabled={disabled || deleting.id===current?.id || teams.length<=1 || !writable} onClick={()=>run(async()=>{
                const target=deleting;setDeleting(null);setMenu(null);
                try{await commands.removeTeam({sessionId,teamId:target.id});setNotice(`已删除「${target.name}」，历史快照保留。`);}
                catch(e){if(e.unknown){await commands.refreshTeams();setNotice("删除结果未知，已读取当前列表；不会自动再次删除。");}throw e;}
              })}>确认删除</button></div>}
          </div>}
        </div>;
      })}</div>
      {current && !teams.some(t=>t.id===current.id) && <>
        <p className="field-note">当前阵容已从保存列表删除，此对话仍保留历史快照。</p>
        <button type="button" disabled={disabled} onClick={()=>begin(current)}>基于当前阵容调整</button>
      </>}
      <p className={styles.footer}>调整另存新阵容，历史与认证保留。当前与最后一个阵容不可删除。</p>
    </>}
  </div>;
});
