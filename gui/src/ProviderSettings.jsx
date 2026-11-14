import React, { useState, useRef, useEffect } from "react";
import styles from "./Settings.module.css";

export function ProviderSettings({ boot, commands, onSave }) {
  const [custom, setCustom] = useState(false),
    [providerId, setProviderId] = useState(""),
    [key, setKey] = useState("");
  const [config, setConfig] = useState({
    baseUrl: "",
    api: "openai-completions",
    modelId: "",
    name: "",
    contextWindow: "",
    maxTokens: "",
  });
  const set = (k, value) => setConfig({ ...config, [k]: value });
  const provider = boot.providers.find((p) => p.id === providerId);
  return (
    <>
      <p>
        已有认证直接复用。API Key 只发送给本机宿主，页面不读取或保存历史密钥。
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const apiKey = key;
          setKey("");
          let args = { providerId, apiKey };
          if (custom) {
            args.custom = {
              baseUrl: config.baseUrl,
              api: config.api,
              modelId: config.modelId,
              ...(config.name ? { name: config.name } : {}),
              ...(config.contextWindow
                ? { contextWindow: Number(config.contextWindow) }
                : {}),
              ...(config.maxTokens
                ? { maxTokens: Number(config.maxTokens) }
                : {}),
            };
          }
          onSave(args);
        }}
      >
        <label className="checkbox">
          <input
            type="checkbox"
            checked={custom}
            onChange={(e) => {
              setCustom(e.target.checked);
              setProviderId("");
              setKey("");
            }}
          />
          添加自定义服务商
        </label>
        <label>
          {custom ? "新的唯一配置 ID" : "服务商"}
          {custom ? (
            <input
              required
              value={providerId}
              onChange={(e) => setProviderId(e.target.value)}
              pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}"
              placeholder="例如：my-provider"
            />
          ) : (
            <select
              required
              value={providerId}
              onChange={(e) => {
                setProviderId(e.target.value);
                setKey("");
              }}
            >
              <option value="">选择服务商</option>
              {boot.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.configured ? " · 已有认证" : ""}
                  {p.oauth && commands?.startOAuth ? " · OAuth" : !p.apiKey && !p.configured ? " · 终端或环境认证" : ""}
                </option>
              ))}
            </select>
          )}
        </label>
        {custom && (
          <>
            <p className="field-note">
              一个新配置提供一个模型。不能覆盖已有配置
              ID；需要多个常规模型时使用服务商目录。
            </p>
            <label>
              API 根地址
              <input
                required
                type="url"
                value={config.baseUrl}
                onChange={(e) => set("baseUrl", e.target.value)}
                placeholder="https://api.example.com/v1"
              />
            </label>
            <div className="form-grid">
              <label>
                协议
                <select
                  value={config.api}
                  onChange={(e) => set("api", e.target.value)}
                >
                  <option value="openai-completions">OpenAI compatible</option>
                  <option value="anthropic-messages">Anthropic messages</option>
                </select>
              </label>
              <label>
                模型 ID
                <input
                  required
                  value={config.modelId}
                  onChange={(e) => set("modelId", e.target.value)}
                  placeholder="服务商给出的实际模型 ID"
                />
              </label>
              <label>
                显示名称（可选）
                <input
                  value={config.name}
                  onChange={(e) => set("name", e.target.value)}
                />
              </label>
              <label>
                上下文能力（可选）
                <input
                  type="number"
                  min="1"
                  value={config.contextWindow}
                  onChange={(e) => set("contextWindow", e.target.value)}
                />
              </label>
              <label>
                最大输出能力（可选）
                <input
                  type="number"
                  min="1"
                  value={config.maxTokens}
                  onChange={(e) => set("maxTokens", e.target.value)}
                />
              </label>
            </div>
          </>
        )}
        {!custom && provider && (
          <p className="field-note">
            {provider.configured
              ? "已配置认证，可直接在阵容中复用。"
              : "尚未配置认证。"}
            {provider.oauth ? " 此服务商支持 OAuth；已有登录直接复用。" : ""}
          </p>
        )}
        {(custom || provider?.apiKey) && <>
          <label>
            新的 API Key
            <input required type="password" autoComplete="new-password" value={key}
              onChange={e=>setKey(e.target.value)} placeholder="输入本次要保存的密钥" />
          </label>
          <div className="form-actions"><button className="primary">保存认证</button></div>
          <p className="field-note">保存后清空输入框。远端权限在实际调用时验证。</p>
        </>}
      </form>
      {!custom && provider && commands?.inspectProviderMetadata &&
        <ProviderMetadata key={provider.id} provider={provider} commands={commands} onSave={onSave} />}
      {!custom && provider?.oauth && commands?.startOAuth &&
        <OAuthLogin key={provider.id} provider={provider} commands={commands}
          existing={boot.oauthOperations?.findLast(op=>op.providerId===provider.id)} />}
      {!custom && provider && !provider.apiKey && !(provider.oauth && commands?.startOAuth) &&
        <p className="field-note">此服务商需使用环境认证，或在终端运行 <code>cothink</code> 后通过 <code>/login</code> 授权。</p>}
    </>
  );
}
const capabilityLabels={contextWindow:"上下文能力",maxTokens:"最大输出能力",input:"输入类型"};
const capabilitySources={model_override:"本地显式覆盖",local_config_unverified:"本地配置 / 未核实",bundled_catalog:"随包目录",sdk_default:"SDK 默认 / 未核实"};
const capabilityValue=value=>Array.isArray(value)?value.join(", "):value??"未知";
function ProviderMetadata({provider,commands,onSave}) {
  const [result,setResult]=useState(null), [busy,setBusy]=useState(false), [error,setError]=useState("");
  const [selected,setSelected]=useState({}), mounted=useRef(true), inFlight=useRef(false);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  async function inspect() {
    if(inFlight.current)return;
    inFlight.current=true;setBusy(true);setError("");
    try {
      const next=await commands.inspectProviderMetadata({providerId:provider.id});
      if(mounted.current){setResult(next);setSelected({});}
    } catch(e) {if(mounted.current)setError(e.message);}
    finally{inFlight.current=false;if(mounted.current)setBusy(false);}
  }
  return <section className={styles.settingSection} aria-label="模型能力核对">
    <h4>模型能力</h4>
    <p className="field-note">仅在点击时查询当前服务的模型目录，不生成回答。能力值与每次请求的输出额度分别设置。</p>
    <button type="button" disabled={busy || !provider.configured} onClick={inspect}>核对模型能力</button>
    {result && <>
      <p role="status">{result.message}</p>
      <p className="field-note">本次查询：{result.checkedAt}。保存仅影响后续任务，已运行任务沿用原快照。</p>
      {result.models.map(row=>{
        const fields=Object.keys(capabilityLabels).filter(field=>selected[row.modelId]?.[field]);
        return <div key={row.modelId}>
          <h5>{row.name}（{row.modelId}）</h5>
          <table className={styles.metadataTable}><thead><tr><th>字段</th><th>本地有效值</th><th>服务端报告</th><th>应用</th></tr></thead>
            <tbody>{Object.keys(capabilityLabels).map(field=><tr key={field}>
              <th>{capabilityLabels[field]}</th>
              <td>{capabilityValue(row.current[field])}<small className={styles.metadataSource}>{capabilitySources[row.sources[field]]??"来源未知"}</small></td>
              <td>{capabilityValue(row.reported[field])}</td>
              <td><input type="checkbox" aria-label={`应用 ${row.modelId} ${field}`} disabled={busy || row.reported[field]===undefined}
                checked={!!selected[row.modelId]?.[field]} onChange={e=>setSelected({...selected,[row.modelId]:{...selected[row.modelId],[field]:e.target.checked}})} /></td>
            </tr>)}</tbody></table>
          <button type="button" disabled={busy || !fields.length} onClick={async()=>{
            if(inFlight.current)return;
            inFlight.current=true;setBusy(true);
            try {await onSave({providerId:provider.id,metadata:{modelId:row.modelId,...Object.fromEntries(fields.map(field=>[field,row.reported[field]]))},expectedModelDigest:row.expectedModelDigest});
              if(mounted.current)setSelected({...selected,[row.modelId]:{}});
            } finally {inFlight.current=false;if(mounted.current)setBusy(false);}
          }}>保存所选能力</button>
        </div>;
      })}
    </>}
    {error && <p role="alert" className="error-text">{error}</p>}
  </section>;
}
const oauthWaiting = operation => ["running","cancelling"].includes(operation?.status);

function OAuthLogin({provider,commands,existing}) {
  const [operation,setOperation]=useState(existing ?? null);
  const [busy,setBusy]=useState(false), [error,setError]=useState("");
  const current=useRef(operation), actions=useRef(commands);
  const mounted=useRef(true), revision=useRef(0), inFlight=useRef(false);
  actions.current=commands;

  function update(value) {
    current.current=value;
    setOperation(value);
  }

  useEffect(()=>{
    mounted.current=true;
    return ()=>{
      mounted.current=false;
      ++revision.current;
      if(oauthWaiting(current.current))
        void actions.current.cancelOAuth?.(current.current.operationId).catch(()=>{});
    };
  },[]);

  const id=operation?.operationId, waiting=oauthWaiting(operation);
  useEffect(()=>{
    if(!id || !waiting || !actions.current.getOAuth) return;
    let stopped=false, timer;
    const tick=async()=>{
      const version=revision.current;
      try {
        const next=await actions.current.getOAuth(id);
        if(!stopped && version===revision.current && !inFlight.current) {
          update(next);
          setError("");
        }
      } catch {
        if(!stopped && version===revision.current) setError("登录状态暂时不可用，正在核对。");
      } finally {
        if(!stopped && oauthWaiting(current.current)) timer=setTimeout(tick,650);
      }
    };
    timer=setTimeout(tick,650);
    return ()=>{stopped=true;clearTimeout(timer);};
  },[id,waiting]);

  async function run(operationAction, {start=false, readOnly=false}={}) {
    if(inFlight.current) return;
    const version=++revision.current;
    inFlight.current=true;
    setBusy(true);
    setError("");
    try {
      const result=await operationAction();
      if(!mounted.current || version!==revision.current) {
        if(start && oauthWaiting(result)) await actions.current.cancelOAuth?.(result.operationId);
      } else if(!readOnly) update(result);
    } catch {
      if(mounted.current && version===revision.current)
        setError(start ? "无法确认登录是否已开始。请先刷新并核对认证状态。" :
          "未收到操作结果。请核对当前登录状态。");
    } finally {
      inFlight.current=false;
      if(mounted.current && version===revision.current) setBusy(false);
    }
  }

  const prompt=operation?.prompt, notification=operation?.notification;
  return <section className={styles.settingSection} aria-label="OAuth 登录">
    <h4>浏览器授权</h4>
    {!waiting && <button type="button" disabled={busy} onClick={()=>run(()=>commands.startOAuth(provider.id),{start:true})}>
      {provider.configured ? "重新授权" : "使用 OAuth 登录"}
    </button>}
    {operation?.message && <p role="status">{operation.message}</p>}
    {waiting && notification?.url && <div className={styles.authStep}>
      <p>授权地址 <strong>{notification.url}</strong></p>
      {notification.userCode && <p>短码 <code>{notification.userCode}</code></p>}
      <button type="button" disabled={busy || !commands.openOAuth}
        onClick={()=>run(()=>commands.openOAuth(id),{readOnly:true})}>在浏览器打开授权页</button>
    </div>}
    {waiting && notification?.message && <p className="field-note">{notification.message}</p>}
    {waiting && prompt && <form key={prompt.id} className={styles.authStep} onSubmit={event=>{
      event.preventDefault();
      const field=event.currentTarget.elements.namedItem("authReply"), value=field.value;
      field.value="";
      void run(()=>commands.respondOAuth(id,prompt.id,value));
    }}>
      <label>{prompt.message}
        {prompt.type==="select" ? <select name="authReply" defaultValue="" required>
          <option disabled value="">请选择</option>
          {prompt.options.map(option=><option key={option.id} value={option.id}>{option.label}</option>)}
        </select> : <input name="authReply" type={prompt.type==="text" ? "text" : "password"}
          autoComplete="off" spellCheck={false} maxLength={8192} />}
      </label>
      <button disabled={busy || !commands.respondOAuth}>提交授权输入</button>
    </form>}
    {waiting && <button type="button" disabled={busy || operation.status==="cancelling" || !commands.cancelOAuth}
      onClick={()=>run(()=>commands.cancelOAuth(id))}>取消登录</button>}
    {error && <p className="error-text" role="alert">{error}</p>}
  </section>;
}
