import React, { useState } from "react";
import styles from "./Settings.module.css";

export function ExecutionCheck({boot,inspect}) {
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
