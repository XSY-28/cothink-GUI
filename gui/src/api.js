// Transport owns credentials and reconnects only reads. Mutations are sent once.
export function consumeToken(win = window) {
  const token = new URLSearchParams(win.location.hash.slice(1)).get("token");
  if (token) win.sessionStorage.setItem("cothink.token", token);
  if (win.location.hash)
    win.history.replaceState(
      null,
      "",
      win.location.pathname + win.location.search,
    );
  return token || win.sessionStorage.getItem("cothink.token") || "";
}
export function createApi(token, fetcher = (...args) => fetch(...args)) {
  const headers = { Authorization: `Bearer ${token}` };
  async function request(path, options = {}) {
    let response;
    try {
      response = await fetcher(path, {
        method: "GET",
        ...options,
        headers: { ...headers, ...options.headers },
      });
    } catch {
      throw Object.assign(
        Error("连接中断。操作结果尚未确认，请读取已保存状态；不会自动重发。"),
        { unknown: true },
      );
    }
    const content = await response.text().catch(() => null);
    if (content === null)
      throw Object.assign(Error("响应读取中断，操作结果尚未确认。"), {
        unknown: true,
      });
    if (!response.ok) {
      let message, code, workspace;
      try {
        const failure = JSON.parse(content);
        message = failure.error; code = failure.code; workspace = failure.workspace;
      } catch {
        /* A proxy or stopped host may return text. */
      }
      throw Object.assign(
        Error(message || `本机服务返回 ${response.status}。`),
        { unknown: response.status >= 500, code, workspace, status: response.status },
      );
    }
    if (path.startsWith("/api/patch?")) return content;
    try {
      return JSON.parse(content);
    } catch {
      throw Object.assign(Error("本机服务响应不完整，请重新读取状态。"), {
        unknown: true,
      });
    }
  }
  const read = (kind, args = {}) =>
    request(
      `/api/${kind}${Object.keys(args).length ? "?" + new URLSearchParams(args) : ""}`,
    );
  return {
    read,
    uploadMaterial: (ownerId,uploadId,bytes,signal) => request("/api/materials?"+new URLSearchParams({ownerId,uploadId}),{
      method:"POST",headers:{"Content-Type":"application/octet-stream","X-CoThink-GUI-Input":"2"},body:bytes,signal,
    }),
    async material(ref,{project=false}={}){
      const path=(project?"/api/project-material?":"/api/materials?")+new URLSearchParams(ref);
      const response=await fetcher(path,{headers});
      if(!response.ok){
        const failure=await response.json().catch(()=>null);
        throw Object.assign(Error(failure?.error??"材料无法读取。"),{code:failure?.code,status:response.status});
      }
      return {blob:await response.blob(),sha256:response.headers.get("x-cothink-content-hash"),sourceToken:response.headers.get("x-cothink-material-source")};
    },
    async file(ref, {purpose="source",signal}={}) {
      const response=await fetcher('/api/file?'+new URLSearchParams({...ref,purpose}),{headers,signal});
      if(!response.ok){let failure;try{failure=await response.json();}catch{} throw Object.assign(Error(failure?.error||'文件读取失败。'),{code:failure?.code,status:response.status});}
      const bytes=await response.arrayBuffer();
      return {bytes,mediaType:response.headers.get('content-type'),representation:response.headers.get('x-cothink-representation'),
        version:response.headers.get('x-cothink-version'),contentHash:response.headers.get('x-cothink-content-hash'),sourceContentHash:response.headers.get('x-cothink-source-hash')};
    },
    async image(args) {
      const response=await fetcher('/api/artifact?'+new URLSearchParams(args),{headers});
      if(!response.ok||response.headers.get('content-type')!=='image/png')throw Error('截图读取失败，请检查本任务证据。');
      return URL.createObjectURL(await response.blob());
    },
    action: (action, args = {}) =>
      request("/api/action", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CoThink-GUI-Input":"2" },
        body: JSON.stringify({ action, args }),
      }),
    async recover(pending) {
      const session = await read("session", { id: pending.sessionId });
      if(pending.kind==='confirmation') {
        const source=session.turns.find(t=>t.taskId===pending.proposalRef?.sourceTaskId);
        const intent=source?.confirmationIntent;
        return intent ? session.submissions.find(t=>t.taskId===intent.taskId)??null : null;
      }
      return (
        (session.submissions ?? session.turns).find((t) => t.submissionId === pending.submissionId) ||
        null
      );
    },
    subscribe(invalidate, status) {
      const abort = new AbortController();
      let timer;
      async function connect() {
        try {
          const response = await fetcher("/api/events", {
            method: "GET",
            headers,
            signal: abort.signal,
          });
          if (!response.ok || !response.body) throw Error("events unavailable");
          status("connected");
          const reader = response.body.getReader();
          try {
            while (!abort.signal.aborted) {
              const { done } = await reader.read();
              if (done) break;
              invalidate();
            }
          } finally {
            reader.releaseLock();
          }
        } catch {
          /* Reconnect notifications, never actions. */
        }
        if (!abort.signal.aborted) {
          status("reconnecting");
          invalidate();
          timer = setTimeout(connect, 1800);
        }
      }
      connect();
      return () => {
        abort.abort();
        clearTimeout(timer);
      };
    },
  };
}
