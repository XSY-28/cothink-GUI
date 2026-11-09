import React, { useState, useRef, useEffect } from "react";
import { Modal } from "./Modal.jsx";
import styles from "./Settings.module.css";
import { SessionRow } from "./features/navigation/Navigation.jsx";

function ProviderSettings({ boot, commands, onSave }) {
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
      {!custom && provider?.oauth && commands?.startOAuth &&
        <OAuthLogin key={provider.id} provider={provider} commands={commands}
          existing={boot.oauthOperations?.findLast(op=>op.providerId===provider.id)} />}
      {!custom && provider && !provider.apiKey && !(provider.oauth && commands?.startOAuth) &&
        <p className="field-note">此服务商需使用环境认证，或在终端运行 <code>cothink</code> 后通过 <code>/login</code> 授权。</p>}
    </>
  );
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

function ExecutionCheck({boot,inspect}) {
  const [check,setCheck]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const configKey=boot.executionConfigDigest ?? JSON.stringify(boot.work ?? {});
  const stale=check && (check.configKey!==configKey ||
    boot.executionConfigDigest && check.result.configDigest!==boot.executionConfigDigest);

  async function run(probe) {
    if(busy) return;
    setBusy(true);
    setCheck(null);
    setError("");
    try {
      const result=await inspect({probe});
      setCheck({configKey,result});
    } catch(error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }

  const result=stale ? null : check?.result;
  return <div className={styles.settingSection} aria-label="执行环境检查">
    <h4>检查本机 Docker</h4>
    <p className="field-note">只读检查核对本机 Docker 和固定镜像。执行环境检查还会启动并清理一个最小容器。</p>
    <div className="form-actions">
      <button type="button" disabled={busy} onClick={()=>run(false)}>只读检查 Docker</button>
      <button type="button" className="primary" disabled={busy || !boot.work?.execution} onClick={()=>run(true)}>检查执行环境</button>
    </div>
    {busy && <p role="status">正在检查…</p>}
    {error && <p className="error-text" role="alert">{error}</p>}
    {stale && <p role="status">执行配置已变更，请重新检查。</p>}
    {result && <div role="status" className={styles.executionResult}>
      <p><strong>只读诊断</strong> {result.diagnostic.message}</p>
      <p><strong>容器探针</strong> {result.probe.message ?? "尚未运行容器探针。"}</p>
      <details>
        <summary>查看检查详情</summary>
        <dl>
          <dt>检查时间</dt><dd>{new Date(result.checkedAt).toLocaleString()}</dd>
          <dt>状态代码</dt><dd>{[result.diagnostic.code,result.probe.code].filter(Boolean).join(" / ")}</dd>
          {result.diagnostic.daemonVersion && <><dt>Docker 服务</dt><dd>{result.diagnostic.daemonVersion} · {result.diagnostic.endpointKind}</dd></>}
          {result.diagnostic.image && <><dt>固定镜像</dt><dd><code>{result.diagnostic.image}</code></dd></>}
          {result.probe.container && <><dt>待核对容器</dt><dd><code>{result.probe.container}</code></dd></>}
          <dt>配置摘要</dt><dd><code>{result.configDigest}</code></dd>
        </dl>
      </details>
    </div>}
  </div>;
}

function WorkSettings({ boot, onSave, inspect }) {
  const [validationError, setValidationError] = useState("");
  const existing = boot.work || {},
    execution = existing.execution;
  const [enabled, setEnabled] = useState(!!execution),
    [image, setImage] = useState(execution?.image || ""),
    [memory, setMemory] = useState(
      execution?.limits?.memoryBytes
        ? execution.limits.memoryBytes / 1048576
        : "",
    ),
    [cpus, setCpus] = useState(execution?.limits?.cpus ?? ""),
    [pids, setPids] = useState(execution?.limits?.pids ?? ""),
    [artifacts, setArtifacts] = useState(
      execution?.artifactPaths?.join("\n") || "",
    );
  const [policy, setPolicy] = useState(
    existing.checks === undefined
      ? "auto"
      : existing.checks.length
        ? "custom"
        : "none",
  );
  const [checks, setChecks] = useState(
    existing.checks?.length
      ? existing.checks.map((c) => ({
          command: c.command,
          args: JSON.stringify(c.args || []),
        }))
      : [{ command: "", args: "[]" }],
  );
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setValidationError("");
        const work = {};
        if (policy === "none") work.checks = [];
        if (policy === "custom") {
          try {
            work.checks = checks.map((c) => {
              const args = JSON.parse(c.args);
              if (
                !Array.isArray(args) ||
                args.some((value) => typeof value !== "string")
              )
                throw Error("invalid args");
              return { command: c.command, args };
            });
          } catch {
            setValidationError('检查参数需要 JSON 字符串数组，例如 ["test"]。');
            return;
          }
        }
        if (enabled)
          work.execution = {
            engine: "docker",
            image,
            network: "none",
            limits: {
              memoryBytes: Number(memory) * 1048576,
              cpus: Number(cpus),
              pids: Number(pids),
            },
            artifactPaths: artifacts
              .split(/\r?\n/)
              .map((s) => s.trim())
              .filter(Boolean),
          };
        onSave({ work });
      }}
    >
      {validationError && (
        <p className="error-text" role="alert">
          {validationError}
        </p>
      )}
      <p>
        共享全局设置，对后续任务生效。Shell 与非空正式检查使用固定 Docker
        镜像；不会退回宿主执行。
      </p>
      <div className="inset-note"><strong>{execution ? "Docker 执行环境已配置" : "尚未配置执行环境"}</strong>
        <p>{execution ? "此处显示已保存配置，不代表 Docker 或镜像已经通过现场检查。" : "Shell 与非空正式检查将被阻止；纯问答不需要执行环境。"}</p>
        <p>当前检查策略：{existing.checks === undefined ? "按项目 package.json 解析" : existing.checks.length ? "使用指定检查命令" : "空检查策略（未验证）"}</p>
      </div>
      {inspect && <ExecutionCheck boot={boot} inspect={inspect} />}
      <details className="settings-advanced"><summary>编辑执行环境与检查策略</summary>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        配置 Docker 执行环境
      </label>
      {enabled && (
        <>
          <label>
            固定镜像 digest
            <input
              required
              value={image}
              onChange={(e) => setImage(e.target.value)}
              placeholder="repository@sha256:…"
            />
          </label>
          <div className="form-grid three">
            <label>
              内存上限（MiB）
              <input
                required
                type="number"
                min="16"
                step="1"
                value={memory}
                onChange={(e) => setMemory(e.target.value)}
              />
            </label>
            <label>
              CPU 上限
              <input
                required
                type="number"
                min="0.01"
                step="any"
                value={cpus}
                onChange={(e) => setCpus(e.target.value)}
              />
            </label>
            <label>
              进程数上限
              <input
                required
                type="number"
                min="2"
                value={pids}
                onChange={(e) => setPids(e.target.value)}
              />
            </label>
          </div>
          <p className="field-note">
            网络固定关闭（network: none）。镜像须已在本机 Docker
            可用，不会在这里拉取镜像。
          </p>
          <label>
            辅助产物目录（相对路径，每行一个）
            <textarea
              rows="2"
              value={artifacts}
              onChange={(e) => setArtifacts(e.target.value)}
              placeholder="node_modules"
            />
          </label>
        </>
      )}
      <label>
        正式检查策略
        <select value={policy} onChange={(e) => setPolicy(e.target.value)}>
          <option value="auto">自动解析项目 package.json 的 test</option>
          <option value="none">空检查策略（未验证）</option>
          <option value="custom">指定检查命令</option>
        </select>
      </label>
      {policy === "custom" && (
        <>
          {checks.map((c, i) => (
            <div className="check-editor" key={i}>
              <label>
                容器内命令
                <input
                  required
                  value={c.command}
                  onChange={(e) =>
                    setChecks((rows) =>
                      rows.map((row, j) =>
                        i === j ? { ...row, command: e.target.value } : row,
                      ),
                    )
                  }
                  placeholder="npm"
                />
              </label>
              <label>
                参数（JSON 数组）
                <input
                  required
                  value={c.args}
                  onChange={(e) =>
                    setChecks((rows) =>
                      rows.map((row, j) =>
                        i === j ? { ...row, args: e.target.value } : row,
                      ),
                    )
                  }
                  placeholder={'["test"]'}
                />
              </label>
              <button
                type="button"
                disabled={checks.length === 1}
                onClick={() =>
                  setChecks((rows) => rows.filter((_, j) => j !== i))
                }
              >
                移除
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setChecks([...checks, { command: "", args: "[]" }])}
          >
            ＋ 添加检查
          </button>
        </>
      )}
      <p className="field-note">
        空策略会明确显示“未验证”，不能代表测试通过。命令使用参数数组，不接受宿主绝对路径、秘密环境变量或自定义挂载。
      </p>
      </details>
      <div className="form-actions">
        <button className="primary">保存工作设置</button>
      </div>
    </form>
  );
}
const builtinSkillUse = {
  "doc-maintenance": "随代码变更维护用法与文档，并核对说明是否准确。",
  "context-management": "查找当前对话的上下文，并在需要时整理记要。",
};
const skillSourceLabels={builtin:"内置",package:"已启用的包",selected:"本地来源"};

function LocalSkillSettings({paths:savedPaths,configured,commands,onSaved}) {
  const [paths,setPaths]=useState(savedPaths),[path,setPath]=useState("");
  const [resolved,setResolved]=useState(null),[busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const savedKey=JSON.stringify(savedPaths);
  const pick=commands.chooseSkillPath ?? window.cothinkDesktop?.chooseProjectDirectory;

  useEffect(()=>{
    setPaths(savedPaths);
  },[savedKey]);

  async function save(event) {
    event.preventDefault();
    if(busy) return;
    setError("");
    setResolved(null);
    setBusy(true);
    try {
      const proposed=[...new Set([...paths,...(path.trim() ? [path.trim()] : [])])];
      const result=await commands.saveLocalSkills({paths:proposed});
      setPaths(result.paths);
      setPath("");
      setResolved(result.skills);
      onSaved();
    } catch(error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }

  return <section className={styles.settingSection} aria-label="本地技能来源">
    <h4>本地技能来源</h4>
    <p className="field-note">选择 SKILL.md 或包含技能的本机目录。保存会核对技能说明和同名来源，下一条任务才会使用新设置。</p>
    <form onSubmit={save}>
      {paths.length ? <ul className={styles.skillPaths}>
        {paths.map(source=><li key={source}>
          <code>{source}</code>
          <button type="button" disabled={busy} aria-label={"移除技能来源 "+source}
            onClick={()=>setPaths(paths.filter(value=>value!==source))}>移除</button>
        </li>)}
      </ul> : <p>还没有保存本地来源。</p>}
      <label>SKILL.md 或目录的绝对路径
        <input autoComplete="off" value={path} onChange={event=>setPath(event.target.value)}
          placeholder="/Users/you/skills/example/SKILL.md" disabled={busy}/>
      </label>
      <div className="form-actions">
        {pick && <button type="button" disabled={busy} onClick={async()=>{
          try {
            const value=await pick();
            if(value) setPath(value);
          } catch(error) {
            setError(error.message);
          }
        }}>{commands.chooseSkillPath ? "选择本地技能…" : "选择技能目录…"}</button>}
        <button className="primary" disabled={!configured || busy || !path.trim() && JSON.stringify(paths)===savedKey}>
          {busy ? "正在核对…" : "保存本地技能来源"}
        </button>
      </div>
    </form>
    {error && <p className="error-text" role="alert">{error}</p>}
    {resolved && <p role="status" className="success-text">本地技能来源已保存。</p>}
    {resolved?.length>0 && <ul className={styles.skillResults}>
      {resolved.map(skill=><li key={skill.name}>
        <strong>{skill.name}</strong> · {skillSourceLabels[skill.sourceKind] ?? "已启用来源"}
        {skill.explicitOnly && " · 仅手动使用"}<p>{skill.description}</p>
      </li>)}
    </ul>}
  </section>;
}

function SkillSettings({boot,session,commands,onSave}) {
  const saved=boot.builtinSkills?.disabled??[],[disabled,setDisabled]=useState(saved),[capabilities,setCapabilities]=useState(null),[failure,setFailure]=useState('');
  const savedKey=JSON.stringify(saved),[skillRevision,setSkillRevision]=useState(0);
  useEffect(()=>{setDisabled(saved);},[savedKey]);
  useEffect(()=>{setCapabilities(null);},[session?.id,boot.active?.taskId]);
  useEffect(()=>{let current=true;setFailure('');
    if(session?.id && commands.getCapabilities)commands.getCapabilities(session.id).then(value=>{if(current)setCapabilities(value);}).catch(error=>{if(current){setFailure(error.message);setCapabilities(null);}});
    return ()=>{current=false;};
  },[session?.id,savedKey,boot.active,skillRevision]);
  return <section aria-label="技能与实际能力">
    <p>内置技能按需读取。修改只影响新任务，已有任务继续使用冻结版本。技能指导不增加文件或脚本权限。</p>
    <form onSubmit={e=>{e.preventDefault();onSave({builtinSkills:{disabled}});}}>
      {(boot.builtinSkills?.names??[]).map(name=><label className="checkbox" key={name}><input type="checkbox" checked={!disabled.includes(name)} onChange={e=>setDisabled(old=>e.target.checked?old.filter(n=>n!==name):[...old,name])}/>{name}{builtinSkillUse[name] && <span className={styles.skillUse}>{builtinSkillUse[name]}</span>}</label>)}
      <p className="field-note">使用外部同名技能前，先禁用内置项，再配置外部来源；两个启用来源同名时会拒绝新任务。</p>
      <button className="primary" disabled={!boot.configured}>保存技能选择</button>
    </form>
    {commands.saveLocalSkills && <LocalSkillSettings paths={boot.localSkillPaths ?? []} configured={boot.configured}
      commands={commands} onSaved={()=>setSkillRevision(revision=>revision+1)} />}
    <h4>{capabilities?.scope==='coordinator'?'协调器与所属执行者的能力':capabilities?.phase==='next-turn'?'下一条对话的能力':'当前角色的能力'}</h4>
    {!session?.id&&<p>打开一条对话后查看其实际能力。</p>}
    {failure&&<p role="alert" className="error-text">{failure}</p>}
    {capabilities&&<>
      <ul>{capabilities.skills.map(skill=><li key={skill.name}><strong>{skill.name}</strong> {skill.version??'版本未声明'}{skill.explicitOnly?' · 仅用户显式选择':''}<p>{skill.description}</p></li>)}</ul>
      {!capabilities.skills.length&&<p>当前没有可用技能。</p>}
      {[{label:capabilities.scope==='coordinator'?'协调器':'当前角色',value:capabilities},...(capabilities.executors??[]).map(value=>({label:'所属执行者 '+value.source.role,value}))].map(({label,value},index)=><section key={value.source?.stageId??index} aria-label={'能力来源 '+label}>
        {capabilities.scope==='coordinator'&&<h4>{label}{value.source?.taskId?' · '+value.source.taskId.slice(0,8):''}</h4>}
        <p>工具：{value.tools.join('、')||'无'}</p>
        <p className="field-note">{value.permissions.fileReadAuthorized?'当前可读取授权范围内的项目文件。':'当前未获项目文件读取权限。'}{value.permissions.fileWrite?'当前允许受管文件写入。':'当前未获文件写入权限。'}{value.permissions.scriptExecution?'当前允许受管脚本执行。':'当前未获脚本执行权限。'}{value.environment.managedExecutionConfigured?'已配置受管执行环境；实际可用性在执行时检查。':'未配置受管执行环境。'}</p>
      </section>)}
      {capabilities.scope==='coordinator'&&!capabilities.executors?.length&&<p className="field-note">尚无已绑定的活动执行者。协调器的权限不代表历史或其他任务的权限。</p>}
      <p className="field-note">上下文检索与派生记要：{capabilities.environment.contextToolsAvailable?'当前分支可用':'当前角色不可用'}。手动整理：{capabilities.environment.contextOrganizationAvailable?'由用户单次触发，会调用模型':'当前角色不可用'}。自动压缩关闭。{capabilities.context?.summary?' 当前有派生摘要，原文仍保留。':''}</p>
      {capabilities.diagnostics.map((d,i)=><p role="alert" key={i} className="error-text">{d.message}</p>)}
    </>}
  </section>;
}
export function Settings({
  boot,
  session,
  theme = "light",
  onTheme,
  showNotes = false,
  onClose,
  onOpenTeam,
  initialTab,
  commands,
}) {
  const [tab, setTab] = useState(["updates","notes"].includes(initialTab) ? "preferences" : initialTab || "providers"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  async function act(operation, args, message) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation(args);
      setNotice(message || "设置已保存。");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="设置" onClose={onClose} wide>
      <div className={`settings-layout ${styles.layout}`}>
        <nav className={`settings-nav ${styles.navigation}`} aria-label="设置分类">
          {[
            ["archives", "已归档"],
            ["providers", "模型与认证"],
            ["work", "项目执行"],
            ["skills", "技能与能力"],
            ["preferences", "偏好与更新"],
          ].map(([id, label]) => (
            <button
              type="button"
              aria-current={tab === id ? "page" : undefined}
              key={id}
              onClick={() => {
                setTab(id);
                setError("");
                setNotice("");
              }}
            >
              {label}
            </button>
          ))}
          <small>
            CoThink {boot.version}
            <br />
            {boot.updates?.channel === "desktop-local" ? "桌面仅显示本地版本与随包更新记录" : "页面连接本机宿主；查新由宿主访问 npm"}
          </small>
        </nav>
        <div className={`settings-body ${styles.body}`}>
          <h3>
            {
              {
                archives: "已归档",
                providers: "模型与认证",
                work: "项目执行",
                skills: "技能与能力",
                preferences: "偏好与更新",
              }[tab]
            }
          </h3>
          {!boot.configured && (
            <div className="inset-note onboarding">
              首次使用：先保存认证，再选主副模型并命名
              阵容。全部设置均不产生模型调用。
            </div>
          )}
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="success-text" role="status">
              {notice}
            </p>
          )}
          <fieldset
            disabled={busy || !!boot.active}
            className={`settings-fields ${styles.fields}`}
          >
            {boot.active && (
              <p className="field-note">
                任务进行中，等待结束或停止后再修改认证和执行设置。
              </p>
            )}
            {tab === "providers" && <><ProviderSettings boot={boot} commands={commands} onSave={args=>act(commands.saveProvider,args,"认证已保存；远端权限尚未验证。")} />
              <p className="field-note">模型阵容由对话顶部统一管理。</p>
              <button type="button" onClick={onOpenTeam}>打开阵容</button></>}{" "}
            {tab === "work" && (
              <WorkSettings
                boot={boot}
                inspect={commands.inspectExecution}
                onSave={args=>act(commands.saveWorkSettings,args)}
              />
            )}
            {tab === 'skills'&&<SkillSettings boot={boot} session={session} commands={commands} onSave={args=>act(commands.saveBuiltinSkills,args,'技能选择已保存；仅影响新任务。')}/>}
          </fieldset>
          {tab === "archives" && commands && <ArchivedSessions commands={commands} active={boot.active} workspaces={boot.workspaces} />}
          {boot.active && <button type="button" onClick={()=>commands.openSession(boot.active.sessionId,boot.active.status === "preparing" ? undefined : boot.active.taskId)}>返回运行任务</button>}
          {tab === "preferences" && <>
            <label>界面主题<select value={theme} onChange={e=>onTheme?.(e.target.value)}><option value="light">浅色</option><option value="dark">深色</option></select></label>
            <p className="field-note">主题仅保存在此浏览器。清除偏好会保留历史、Team 和成果。</p>
            <ReleaseNotes notes={boot.releaseNotes} version={boot.version} show={showNotes || initialTab === "notes"} busy={busy} onAcknowledge={()=>act(commands.acknowledgeNotes,undefined,"当前安装版本的更新记录已标为看过。")}/>
            <UpdateSettings state={boot.updates} busy={busy} onCheck={()=>act(commands.checkUpdates,undefined,"检查结束，结果见下方。")} onConfigure={args=>act(commands.configureUpdates,args)}/>
          </>}

        </div>
      </div>
    </Modal>
  );
}

function UpdateSettings({state:s, busy, onCheck, onConfigure}) {
  const [installation,setInstallation]=useState("unknown");
  const lastControl=useRef(null);
  const checking=busy || s?.status === "checking";
  useEffect(()=>{
    // Disabling the clicked control can move browser focus to body. Restore it
    // after the request, but never pull focus away from another chosen control.
    const control=lastControl.current;
    if(control?.isConnected && (document.activeElement === document.body || document.activeElement === control.closest('[role="dialog"]'))) {
      if(checking) control.closest('[role="dialog"]')?.focus();
      else control.focus();
    }
  },[checking]);
  if(s?.channel === "desktop-local") return <section aria-label="桌面版本"><p>CoThink {s.currentVersion}</p><p>{s.message}</p><p className="field-note">当前 App 不使用 npm 自动查新或安装指引。下方可查看随包更新记录。</p></section>;
  if(!s) return <p>尚未读取远端更新状态；当前安装版本见上方。关闭设置后可重新读取。</p>;
  return <section className="update-settings" aria-label="可用更新">
    <p className="update-result" role="status">{s.message}</p>
    <dl className="update-versions"><div><dt>当前版本</dt><dd>{s.currentVersion}</dd></div>
      <div><dt>已知发布版本</dt><dd>{s.latestVersion || "未知"}{s.prerelease && "（预发布版本）"}</dd></div>
      <div><dt>最近成功检查</dt><dd>{s.checkedAt == null ? "尚无" : new Date(s.checkedAt).toLocaleString()}{s.stale && " · 旧缓存，不代表本次在线结论"}</dd></div></dl>
    {s.storageError && <p className="error-text" role="alert">{s.storageError}</p>}
    <label className="checkbox"><input type="checkbox" checked={s.preference} disabled={checking || s.offline || s.environmentDisabled || !!s.storageError}
      onChange={e=>{lastControl.current=e.currentTarget;e.currentTarget.closest('[role="dialog"]')?.focus();onConfigure({automatic:e.target.checked});}}/>自动检查更新</label>
    <p className="field-note">默认在后台访问官方 npm 发布源，每 24 小时尝试一次；不发送密钥或对话，不调用模型。关闭后仍可手动检查。仅提供指引，不执行安装。</p>
    {s.environmentDisabled && <p className="field-note">COTHINK_NO_UPDATE_CHECK=1 已禁止自动检查。</p>}
    <button type="button" className="secondary" disabled={checking || s.offline} onClick={e=>{lastControl.current=e.currentTarget;e.currentTarget.closest('[role="dialog"]')?.focus();onCheck();}}>{checking ? "正在检查…" : "检查更新"}</button>
    <p className="update-links"><a href={s.releaseUrl} target="_blank" rel="noreferrer">官方说明与下载 ↗</a><a href={s.npmUrl} target="_blank" rel="noreferrer">npm 发布页 ↗</a></p>
    <label>原安装方式<select value={installation} onChange={e=>setInstallation(e.target.value)}>
      <option value="unknown">源码、托管目录或无法判断</option><option value="npm">npm 全局安装</option><option value="zip">Windows ZIP</option></select></label>
    {installation === "npm" ? <><p className="field-note">macOS / Linux 使用 npm；Windows 使用 npm.cmd。自定义 prefix 沿用原 prefix。</p>
      {s.instructions.npm ? <pre className="update-command">{s.instructions.npm}</pre> : <p>暂无已验证的更高目标版本，不建议执行升级命令。</p>}</>
      : <p>{installation === "zip" ? s.instructions.zip : s.instructions.source}</p>}
    <p className="field-note">{s.instructions.note}</p><p className="field-note">当前程序：<code>{s.programPath}</code></p>
    <p className="field-note">npm 推荐版本已可发现，不代表所有平台下载资产均已核实。旧版需先手动安装一次含提醒功能的版本。</p>
  </section>;
}

function ReleaseNotes({notes, version, show, busy, onAcknowledge}) {
  const [opened,setOpened]=useState(!!show);
  useEffect(()=>{if(show)setOpened(true);},[show]);
  return <section className="local-release" aria-label="当前安装版本更新记录">
    <p><strong>当前安装版本：{version}</strong>{notes?.unread ? " · 更新记录尚未确认" : ""}</p>
    <details open={opened} onToggle={e=>setOpened(e.currentTarget.open)}><summary>查看本地更新记录</summary>
      <p className="field-note">来自随包 CHANGELOG，只说明当前已安装版本；下方查新显示另一个发布版本，不代表已升级。</p>
      {notes?.error && <p className="error-text" role="alert">{notes.error}</p>}
      <pre className="changelog">{notes?.full || notes?.summary || "当前安装包未提供可读取的更新记录。"}</pre>
      {notes?.unread && <button disabled={busy || !opened || !!notes.error || !(notes.full || notes.summary)} onClick={onAcknowledge}>我已看过此版本更新</button>}
    </details>
  </section>;
}

function ArchivedSessions({commands,active,workspaces}) {
  const [query,setQuery] = useState(""), [page,setPage] = useState({items:[],nextCursor:null});
  const [error,setError] = useState(""), [loading,setLoading] = useState(false), request = useRef(0);
  const queryRef = useRef(query); queryRef.current = query;
  const [restoring,setRestoring] = useState(null), restoreLock = useRef(false);
  const workspaceRows = workspaces?.filter(row=>row.archived && (!query.trim() || page.workspaceMatches?.includes(row.id))) ?? [];
  async function restoreWorkspace(row) {
    if (restoreLock.current) return;
    restoreLock.current = true;
    setRestoring(row.id); setError("");
    try { await commands.updateWorkspace(row,{archived:false}); await load(); }
    catch (e) {setError(e.message);}
    finally {restoreLock.current=false;setRestoring(null);}
  }
  async function load(more = false) {
    const token = ++request.current; setLoading(true); setError("");
    try {
      const next = await commands.querySessions({query:queryRef.current,archived:"archived",...(more ? {cursor:page.nextCursor} : {})});
      if (request.current !== token) return;
      setPage(prior=>({...next,items:more ? [...new Map([...prior.items,...next.items].map(s=>[s.id,s])).values()] : next.items}));
    } catch(e) {
      if (e.code === "CURSOR_EXPIRED") return load();
      if (request.current === token) setError(e.message);
    } finally { if (request.current === token) setLoading(false); }
  }
  useEffect(()=>{void load(); return ()=>{++request.current;};},[query]);
  return <section aria-label="已归档 Team 和对话">
    <p className="field-note">归档保留全部历史。查看仅打开记录；恢复后仍留在此页。</p>
    <label>搜索归档<input value={query} maxLength={200} onChange={e=>setQuery(e.target.value)} placeholder="Team、对话或文件" /></label>
    {error && <p className="error-text" role="alert">{error}</p>}
    {workspaces === null && <p role="status">Team 目录暂不可用，仍可查看已保存的对话。</p>}
    {workspaceRows.map(row=><div className="form-actions" key={row.id}>
      <strong>{row.name}</strong>
      <button onClick={()=>commands.openWorkspace?.(row)}>查看 Team</button>
      <button disabled={!!restoring} onClick={()=>restoreWorkspace(row)}>恢复 Team</button>
    </div>)}
    {page.items.map(session=><SessionRow key={session.id} session={session} commands={commands} onOpen={commands.openSession} onChanged={()=>load()} active={active} />)}
    {!loading && !workspaceRows.length && !page.items.length && <p>{query ? <>没有匹配的归档对话。<button onClick={()=>setQuery("")}>清空搜索</button></> : "暂无已归档对话。可从对话行的 ⋯ 菜单归档已完成工作。"}</p>}
    {loading && <p role="status">正在读取…</p>}
    {page.nextCursor && <button disabled={loading} onClick={()=>load(true)}>加载更多归档</button>}
  </section>;
}
