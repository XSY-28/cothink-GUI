import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { SessionManager, CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import { writePrivateBytes } from "./storage.js";
import { sessionStateError } from "./session-ui-state.js";
import { existingNeutralDirectory } from "./conversation.js";
import { isWorkspaceId, isWorkspaceProject, sameWorkspaceDirectory, workspaceError } from "./gui-workspace-state.js";

// Summaries deliberately omit unidentifiable histories. Creation must also inspect
// UUID-bearing filenames, so a damaged header cannot make an occupied ID look free.
export function assertNewGuiSessionId(directory, id) {
  for (const name of readdirSync(directory).filter(name => name.endsWith(".jsonl"))) {
    let header;
    try { header = JSON.parse(readFileSync(join(directory,name),"utf8").split("\n").find(Boolean)); }
    catch {
      if (name.includes(id)) throw sessionStateError("SESSION_STATE_UNAVAILABLE","同一会话 ID 的文件头损坏；原文件保留，请读取核对，不能重新创建。");
      continue;
    }
    if (name.includes(id) || header?.id === id) {
      if (header?.type !== "session" || header.id !== id || header.version !== CURRENT_SESSION_VERSION || typeof header.cwd !== "string")
        throw sessionStateError("SESSION_STATE_UNAVAILABLE","同一会话 ID 的文件头不可确认；原文件保留。");
      throw sessionStateError("SESSION_STATE_CONFLICT","会话 ID 已存在；请按原 ID 读取核对，本次未覆盖。");
    }
  }
}

/** Only the first GUI publication; all later appends belong to the public SDK. */
export function persistNewGuiSession({manager,directory,assertOwned,parentSession}) {
  const header = manager.getHeader(), entries = manager.getEntries();
  const path = parentSession ? join(directory,header.timestamp.replace(/[:.]/g,"-")+"_"+header.id+".jsonl") : manager.getSessionFile();
  if (!path || resolve(dirname(path)) !== resolve(directory) || realpathSync(dirname(path)) !== realpathSync(directory) ||
      header?.type !== "session" || header.version !== CURRENT_SESSION_VERSION || header.id !== manager.getSessionId() ||
      !parentSession && entries.some(entry => entry.type === "message") || !entries.some(entry => entry.type === "custom" && entry.customType === "cothink-gui-workspace"))
    throw sessionStateError("SESSION_STATE_UNAVAILABLE","不是可首次发布的 GUI 会话。");
  assertOwned();
  assertNewGuiSessionId(directory,header.id);
  const bytes=[parentSession?{...header,parentSession}:header,...entries].map(entry=>JSON.stringify(entry)).join("\n")+"\n";
  writePrivateBytes(path,bytes,()=>{
    assertOwned();
    if (existsSync(path)) throw sessionStateError("SESSION_STATE_CONFLICT","会话文件已存在，请按原 ID 读取核对；未覆盖。");
    assertNewGuiSessionId(directory,header.id);
  });
  try {
    const reopened=SessionManager.open(path,directory,manager.getCwd());
    if (reopened.getSessionId() !== header.id || reopened.getLeafId() !== manager.getLeafId()) throw Error("会话身份或终点不匹配");
    return reopened;
  } catch(error) {
    throw sessionStateError("SESSION_STATE_UNAVAILABLE",`会话 ${header.id} 已发布，但重开未确认；请按原 ID 查询，不要重复创建。${error.message}`);
  }
}

// Rebind may exclude a damaged history only when every intact record is under
// the original GUI-created scope. This does not recover the history for use.
export function scopeAfterTruncatedTail(lines, home, protocolVersion) {
  if (lines.length < 5 || lines.at(-1).trim() !== "{") return undefined;
  try {
    const [header, projectEntry, workspaceEntry, flow, ...entries] =
      lines.slice(0,-1).map(line=>JSON.parse(line));
    const neutral = existingNeutralDirectory(home);
    if (!neutral || header.type !== "session" || header.version !== CURRENT_SESSION_VERSION ||
        !isWorkspaceId(header.id) || header.parentSession || header.cwd !== neutral) return undefined;
    const scope = [projectEntry,workspaceEntry,flow], types = ["cothink-project","cothink-gui-workspace","cothink-flow"];
    const ids = new Set();
    for (const [index, entry] of scope.entries()) {
      if (entry.type !== "custom" || entry.customType !== types[index] ||
          typeof entry.id !== "string" || !entry.id || ids.has(entry.id) ||
          entry.parentId !== (index ? scope[index-1].id : null)) return undefined;
      ids.add(entry.id);
    }
    const project = projectEntry.data?.project, marker = workspaceEntry.data?.workspaceId;
    if ((project !== null && !isWorkspaceProject(project)) ||
        (marker === null ? project !== null : !isWorkspaceId(marker)) ||
        flow.data?.flow !== "unified" || flow.data?.version !== protocolVersion) return undefined;
    const descendants = new Set([flow.id]);
    for (const entry of entries) {
      if (entry.type === "session" || (entry.type === "custom" && types.includes(entry.customType)) ||
          typeof entry.id !== "string" || !entry.id || ids.has(entry.id) || !descendants.has(entry.parentId)) return undefined;
      ids.add(entry.id);
      descendants.add(entry.id);
    }
    return [{sessionId:header.id,project,marker}];
  } catch { return undefined; }
}

export function freezeWorkspaceHistory(directory,infos,table,current,nextPath,{signature,projectMembership,inspectWorkspaceProject,assertIdle}) {
  const directoryFiles=()=>readdirSync(directory).filter(name=>name.endsWith(".jsonl")).sort().map(name=>join(directory,name));
  const files=directoryFiles(), found=new Map(infos.map(info=>[info.path,info]));
  const related=new Set(), legacyBindings=[];
  const directoryStamp=nextPath===null?null:signature(nextPath);
  const affects=branch=>projectMembership(branch,table).workspaceId===current.id ||
    sameWorkspaceDirectory(branch.project,current.project) || sameWorkspaceDirectory(branch.project,nextPath);
  const unverified=branch=>branch.associationError ||
    branch.marker!==undefined && projectMembership(branch,table).workspaceError;
  const snapshot=files.map(path=>{
    const info=found.get(path);
    if (!info || signature(path)!==info.stamp || !info.branches ||
        info.branches.some(branch=>unverified(branch) || info.error && affects(branch)))
      throw workspaceError("WORKSPACE_CONFLICT","有旧会话的分支归属无法核对，目录未变更。",current);
    for (const branch of info.branches) {
      if (affects(branch)) related.add(info.id);
      if (branch.marker===undefined && branch.project!==null)
        legacyBindings.push({sessionId:info.id,project:branch.project});
    }
    return [path,info.stamp];
  });
  const verify=()=>{
    if (JSON.stringify(directoryFiles())!==JSON.stringify(files) ||
        snapshot.some(([path,stamp])=>signature(path)!==stamp))
      throw workspaceError("WORKSPACE_CONFLICT","旧会话在核对期间变化，目录未变更。",current);
    assertIdle(related);
    if (nextPath!==null && (inspectWorkspaceProject(nextPath)!==nextPath || signature(nextPath)!==directoryStamp))
      throw workspaceError("WORKSPACE_CONFLICT","新目录在核对期间改变。",current);
  };
  return {legacyBindings,verify};
}
