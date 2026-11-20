import React, {forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState} from "react";
import {modelName,thinkingPreferenceView} from "../../view.js";
import styles from "./TeamPanel.module.css";
import { catalogModel, identity, matchesSearch, routeIssue } from "./ModelEditor.jsx";
import {RosterAuthFields, RosterFields, newRoster} from "./RosterFields.jsx";
// Compare normalized parameter values, not object key order.
const rosterParameters = team => JSON.stringify([team.main,...team.secondary].map(r=>[r.provider,r.modelId,thinkingPreferenceView(r.thinkingLevel).level??r.thinkingLevel,r.maxOutputTokens ?? null]));
const rosterText = team => `主：${modelName(team.main)}；副：${team.secondary.map(modelName).join("、")}`;
function parameterText(ref) {
  const preference=thinkingPreferenceView(ref.thinkingLevel);
  return `${modelName(ref)} · 思考 ${preference.level??`无效（${String(ref.thinkingLevel)}）`} · ${ref.maxOutputTokens == null ? "未设输出额度" : ref.maxOutputTokens+" tokens"}`;
}
export const TeamPanel = forwardRef(function TeamPanel({session, workspace, teams=[], models=[], providers=[], busy,
  onboarding, commands, onProviderSettings, onClose, onStart}, ref) {
  const [draft,setDraft]=useState(()=>onboarding && !teams.length ? newRoster("日常协作") : null);
  const [baseline,setBaseline]=useState(()=>draft ? JSON.stringify(draft) : "");
  const [chosenId,setChosenId]=useState(null);
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
  const actualThinking=thinkingPreferenceView(session?.thinking).level??"无效";
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
  function home(){focusRequest.current='[aria-label="搜索阵容"]';setMenu(null);setDraft(null);setUnknown(null);setDeleting(null);setKeys({});setChosenId(null);setError("");}
  function begin(source){requestLeave(()=>{
    const value=source ? {name:"",main:structuredClone(source.main),secondary:structuredClone(source.secondary)}
      : newRoster();
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
    const preserveDefault = () => {
      setDefaultRetry(null);
      setNotice("当前对话已可用。此 Team 已有另一个默认阵容，已保留。");
      return false;
    };
    if (onboarding && row.defaultRosterId && row.defaultRosterId!==team.id) return preserveDefault();
    try {
      await commands.updateWorkspace(row,{defaultRosterId:team.id});
      setDefaultRetry(null);
      setNotice(`此 Team 的新对话默认使用「${team.name}」。`);
      return true;
    } catch(error) {
      if (error.unknown || onboarding && error.code==="WORKSPACE_CONFLICT") {
        const latest=await commands.refreshTeams().catch(()=>null);
        const observed=latest?.workspaces?.find(item=>item.id===row.id);
        if (observed?.defaultRosterId===team.id) {
          setDefaultRetry(null);
          setNotice(`已读取保存状态。此 Team 的新对话默认使用「${team.name}」。`);
          return true;
        }
        if (onboarding && observed?.defaultRosterId) return preserveDefault();
      }
      setDefaultRetry({team,workspaceId:row.id});
      setNotice((onboarding ? "当前对话已可用。" : "") +
        (error.unknown ? "默认阵容保存结果未知，请先核对。" : "默认阵容未保存。"));
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
      if(onboarding)onStart();
      return;
    }
    if(await saveDefault(team,row) && onboarding)onStart();
  }
  async function select(team, prefix="") {
    try {
      await commands.selectTeam({sessionId,teamId:team.id});
      setNotice(`${prefix}当前对话已使用「${team.name}」，旧回复保持原阵容。`);
    } catch(e) {
      if(onboarding && e.unknown){
        const observed=await commands.readSession(sessionId).catch(()=>null);
        if(observed?.id===sessionId && observed.workspaceId===workspace.id && !observed.readOnly &&
          observed.team?.id===team.id && rosterParameters(observed.team)===rosterParameters(team))return;
      }
      setNotice(`${prefix}${e.unknown ? "当前对话切换结果未知，请读取状态核对。" : "当前对话未切换。"}`);
      if(e.unknown) await commands.refresh();
      throw e;
    }
  }
  async function startConversation(team) {
    if (current?.id !== team.id || rosterParameters(current) !== rosterParameters(team))
      await select(team);
    if (workspace.defaultRosterId === team.id || await saveDefault(team,workspace)) onStart();
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
    if(onboarding) {
      setChosenId(team.id);
      await startConversation(team);
    } else if(use && writable) await select(team,`已保存「${team.name}」。`);
  }
  async function refreshUnknown(){
    const fresh=await commands.refreshTeams();
    setAuthUnknown(ids=>ids.filter(id=>!fresh.providers?.find(p=>p.id===id)?.configured));
    await commands.refresh();
    setNotice("已重新读取保存状态；请核对下面的实际阵容。未重复保存或切换。");
  }
  const chosen=onboarding && (teams.find(team=>team.id===chosenId) || (saved?.id===chosenId ? saved : null));
  const editing=draft || chosen;
  const refs=editing ? [editing.main,...editing.secondary] : [];
  const authProviders=[...new Set(refs.map(r=>r.provider).filter(Boolean))];
  const rosterIssue=!editing ? "" : refs.some(r=>!r.provider || !r.modelId) || !editing.secondary.length
    ? "请选一位主模型和至少一位副模型。可以使用同一家服务商的不同型号。"
    : new Set(refs.map(identity)).size!==refs.length ? "同一个模型不能重复占据席位。"
    : refs.map(r=>routeIssue(r,models,providers)).find(Boolean);
  const canStart=writable && canSetDefault && !disabled && !unknown && !defaultRetry &&
    !!editing && !rosterIssue && (!draft || !!draft.name.trim());
  function saveKey(id) {
    const apiKey=keys[id];
    setKeys(previous=>({...previous,[id]:""}));
    run(async()=>{
      try {
        await commands.saveProvider({providerId:id,apiKey});
        setNotice(`${id} 认证已保存，远端权限尚未验证；取消阵容编辑也会保留认证。`);
      } catch(error) {
        if(error.unknown)setAuthUnknown(ids=>[...new Set([...ids,id])]);
        throw error;
      }
    });
  }
  const authFields=ids=><RosterAuthFields authProviders={ids} providers={providers} keys={keys} setKeys={setKeys}
    authUnknown={authUnknown} onboarding={onboarding} hasProviderSettings={!!onProviderSettings}
    disabled={disabled || !!unknown} pending={pending} onSaveKey={saveKey} onRefresh={()=>run(refreshUnknown)}/>;
  const onboardingActions=onboarding && <div className={styles.onboardingActions}>
    {rosterIssue && !current && <p className="field-note">{rosterIssue}</p>}
    {current ? <button type="button" className="primary" disabled={pending} onClick={onStart}>返回对话</button> : <>
      <p className="field-note">这个 Team 的新对话也将默认使用此阵容，以后可以更换。</p>
      <button type={draft ? "submit" : "button"} className="primary" disabled={!canStart}
        onClick={draft ? undefined : ()=>run(()=>startConversation(chosen))}>开始对话</button>
    </>}
  </div>;
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
    <div className={styles.intro}><div>
      {onboarding ? <p>主模型与你对话并负责交付。需要协作时，主模型可以请副模型参与。</p>
        : <><small>当前对话</small><h3>{current?.name || "尚未选择阵容"}</h3></>}
      {current && <p title={rosterText(current)}>{rosterLabel(current)}</p>}</div>
      {(!onboarding || !draft && !current) && <button type="button" className={onboarding ? "secondary" : "primary"} disabled={disabled} onClick={()=>begin(null)}>＋ 新建阵容</button>}</div>
    {onProviderSettings && (onboarding && !current || authProviders.some(id=>providers.some(p=>p.id===id && !p.configured && !p.apiKey))) &&
      <button type="button" disabled={pending} onClick={()=>requestLeave(onProviderSettings)}>打开模型与认证设置</button>}
    {workspace && !onboarding && <p className="field-note">此 Team 的新对话默认阵容：{defaultRoster?.name || (workspace.defaultRosterId ? "原阵容已删除，请为新对话选择" : "尚未设置")}</p>}
    {busy && <p className="field-note">任务进行中，阵容暂只读；结束或停止后可修改。草稿不会排队。</p>}
    {!writable && <p className="field-note">当前没有可编辑的对话，无法切换当前阵容或删除保存的阵容。</p>}
    {current && !onboarding && <details className={styles.thinking}>
      <summary>对话参数 · 思考 {actualThinking}</summary>
      <p>本对话所有模型统一采用思考档位：<strong>{actualThinking}</strong>。</p>
      <p>在输入框发送按钮左侧调整思考强度；新选档应用于后续新任务的全部模型。这里编辑各模型的阵容默认参数。</p>
    </details>}
    {error && <p className="error-text" role="alert">{error}</p>}
    {notice && <p className={styles.notice} role="status">{notice}</p>}
    {defaultRetry?.workspaceId===workspace?.id && defaultRetry && <button type="button" disabled={disabled || !canSetDefault}
      onClick={()=>run(retryDefault)}>重新保存默认阵容</button>}
    {!onboarding && saved && !draft && current?.id!==saved.id && <button type="button" disabled={disabled || !writable} onClick={()=>run(()=>select(saved,`「${saved.name}」已保存。`))}>使用已保存的「{saved.name}」</button>}
    {leave && <div className={styles.confirm} role="alert">
      <p>放弃未保存的编辑？{unknown && "保存结果仍未知，关闭不会撤销可能已保存的阵容。"}已确认保存的认证及对话思考设置会保留。</p>
      <button type="button" data-team-continue onClick={()=>{focusRequest.current=editingFocus.current || '[aria-label="新阵容名称"]';setLeave(null);}}>继续编辑</button>
      <button type="button" onClick={()=>{const next=leave;setLeave(null);setKeys({});next();}}>放弃未保存修改</button>
    </div>}
    {draft ? <>
      {(!onboarding || teams.length>0) && <button type="button" disabled={pending} onClick={()=>requestLeave(home)}>← 返回已保存阵容</button>}
      <form onSubmit={e=>{e.preventDefault();if(onboarding ? canStart : !unknown)run(()=>save(false));}}>
        <RosterFields draft={draft} setDraft={setDraft} models={models} providers={providers} onboarding={onboarding}
          disabled={disabled || !!unknown} actualThinking={actualThinking} authFields={authFields}/>
        {unknown && <section className={styles.confirm}>
          <p>保存结果未知，表单保留。找到同名阵容也不会自动使用或再次创建。</p>
          <button type="button" disabled={pending} onClick={()=>run(refreshUnknown)}>读取阵容列表核对</button>
          {sameName.length ? sameName.map(t=><div key={t.id}><strong>实际保存的「{t.name}」</strong><ul>{[t.main,...t.secondary].map((r,i)=><li key={i}>{i===0?"主":"副 "+i}：{parameterText(r)}</li>)}</ul></div>) : <p>当前列表未找到同名阵容；仍不能确认未保存。</p>}
        </section>}
        {onboarding ? onboardingActions : <div className={styles.actions}>
          <button type="button" disabled={pending} onClick={()=>requestLeave(home)}>取消编辑</button>
          <button type="submit" className="secondary" disabled={disabled || !!unknown}>仅保存新阵容</button>
          <button type="button" className="primary" disabled={disabled || !!unknown || !writable}
            onClick={e=>{if(e.currentTarget.form.reportValidity())run(()=>save(true));}}>保存并使用</button>
        </div>}
      </form>
    </> : <>
      <div className={styles.heading}><h3>已保存的阵容</h3>{!onboarding && <small>切换仅影响之后的提交</small>}</div>
      <input type="search" aria-label="搜索阵容" placeholder="搜索阵容名称或模型" value={search}
        onChange={e=>{setSearch(e.target.value);setMenu(null);setDeleting(null);}}/>
      {!matchingTeams.length && <p className="field-note" role="status">{teams.length ? "没有匹配的阵容。" : "尚无已保存的阵容。"}</p>}
      <div className={styles.list}>{matchingTeams.map(team=>{
        const selected=team.id===current?.id;
        const differsFromCurrent=selected && rosterParameters(team)!==rosterParameters(current);
        const mainIssue=routeIssue(team.main,models,providers);
        const issue=mainIssue || team.secondary.map(ref=>routeIssue(ref,models,providers)).find(Boolean);
        const reason=selected ? "当前对话正在使用，请先切换" : teams.length<=1 ? "至少保留一个阵容" : !writable ? "当前对话不可管理" : "";
        const isOpen=menu===team.id;
        const isDefault=workspace?.defaultRosterId===team.id;
        return <div className={`${styles.card} ${(onboarding ? chosenId===team.id : selected) ? styles.selected : ""}`} key={team.id}>
          <div className={styles.row}>
            <button type="button" className={styles.pick} aria-current={selected || undefined}
              disabled={disabled || !writable || (onboarding ? !!current : selected)}
              aria-pressed={onboarding ? chosenId===team.id : undefined} aria-label={`${onboarding ? "选择" : "使用"} ${team.name}`}
              onClick={()=>{setMenu(null);setDeleting(null);
                if(onboarding)requestLeave(()=>{setChosenId(team.id);setKeys({});setError("");});
                else run(()=>select(team));
              }}>
              <span><strong>{team.name}</strong>{selected && <span className={styles.tag}>当前</span>}{isDefault && <span className={styles.tag}>Team 默认</span>}</span>
              <span className={styles.rosterModels} title={rosterText(team)}>{rosterLabel(team)}</span>
              {differsFromCurrent && <span className={styles.rosterModels}>已保存参数与当前快照不同</span>}
              {issue && <span className={styles.rosterModels}>{issue}</span>}
            </button>
            {!onboarding && <button type="button" className={styles.more} aria-label={`管理 ${team.name}`} aria-expanded={isOpen} data-roster-actions
              onClick={()=>{setMenu(isOpen ? null : team.id);setDeleting(null);}}>⋯</button>}
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
      {onboarding ? <>
        {authFields(authProviders)}
        {chosen && !current && refs.some(ref=>routeIssue(ref,models,providers,false)) &&
          <button type="button" disabled={disabled} onClick={()=>begin(chosen)}>调整并另存阵容</button>}
        {onboardingActions}
      </> : <p className={styles.footer}>调整另存新阵容，历史与认证保留。当前与最后一个阵容不可删除。</p>}
    </>}
  </div>;
});
