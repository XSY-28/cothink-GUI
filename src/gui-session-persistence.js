import { existsSync, readFileSync, readdirSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { SessionManager, CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import { acquireSessionWriter, sessionWriterBusy, writePrivateBytes } from "./storage.js";
import { sessionStateError } from "./session-ui-state.js";
import { existingNeutralDirectory, readSessionProject, readSessionWorkspace } from "./conversation.js";
import { isWorkspaceId, isWorkspaceProject, sameWorkspaceDirectory, workspaceError, deleteGuiWorkspace, sessionTeamWasDeleted, workspaceForSession } from "./gui-workspace-state.js";

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

export function workspaceFacts(manager) {
  let project;
  try {
    project = readSessionProject(manager);
    if (project !== null && !isWorkspaceProject(project))
      return {associationError:"会话的项目路径无法确认；原记录保留。"};
    const forkOf = manager.getBranch().findLast(entry =>
      entry.type === "custom" && entry.customType === "cothink-fork")?.data ?? null;
    return {sessionId:manager.getSessionId(),marker:readSessionWorkspace(manager), project, forkOf,
      branched: !!forkOf || !!manager.getHeader()?.parentSession};
  } catch (error) {
    return {project, associationError:error.message};
  }
}
export function projectMembership(facts, table) {
  const {marker, project, associationError, sessionId} = facts ?? {};
  const unknown = (message = "会话的 Team 归属无法确认；原记录保留。") => ({workspaceError:message});
  if (!facts || associationError) return unknown(associationError);
  if (marker === null) return project === null ? {workspaceId:null, workspaceArchived:false} : unknown();
  if (marker === undefined && project === null) return {workspaceId:null, workspaceArchived:false};
  const workspace = table && workspaceForSession(table,sessionId,project,marker);
  if (!workspace && sessionTeamWasDeleted(table,sessionId,project,marker)) return {workspaceDeleted:true, workspaceError:"所属 Team 和对话已删除。"};
  if (!workspace) return unknown();
  return {workspaceId:workspace.id, workspaceArchived:workspace.archived};
}
export function branchFacts(manager) {
  const entries = manager.getEntries();
  const seen = new Set(), parents = new Set();
  for (const {id,parentId} of entries) {
    if (typeof id !== "string" || seen.has(id) || (parentId !== null && !seen.has(parentId)))
      throw Error("会话分支关系损坏。");
    seen.add(id);
    if (parentId !== null) parents.add(parentId);
  }
  const leaves = entries.filter(entry=>!parents.has(entry.id)).map(entry=>entry.id);
  if (!leaves.length) return [workspaceFacts(manager)];
  return leaves.map(id=>workspaceFacts({
    getBranch:()=>manager.getBranch(id), getCwd:()=>manager.getCwd(),
    getHeader:()=>manager.getHeader(), getSessionId:()=>manager.getSessionId(),
  }));
}

export async function deleteTeamConversations(home,args,infos,table,current,{holders,busySessions,signature,releaseHolder}) {
  const related = new Set(infos.filter(info =>
    (info.branches ?? []).some(branch => projectMembership(branch,table).workspaceId === current.id)).map(info => info.id));
  for (const [id,holder] of holders)
    if (projectMembership(workspaceFacts(holder.sessionManager),table).workspaceId === current.id) related.add(id);
  const verify = () => {
    if (busySessions.some(id => related.has(id)))
      throw workspaceError("WORKSPACE_CONFLICT","此 Team 正在执行任务或插件命令，请结束后再删除。",current);
    if ([...related].some(id => !holders.has(id) && sessionWriterBusy(join(home,"pi"),id)))
      throw workspaceError("WORKSPACE_CONFLICT","此 Team 的对话正被另一窗口占用，请先关闭该窗口。",current);
  };
  // A legacy Pi file can contain branches owned by different Teams.
  // Remove the whole file only when every branch belongs to this Team.
  const files = infos.filter(info => related.has(info.id) && info.branches?.length &&
    info.branches.every(branch => projectMembership(branch,table).workspaceId === current.id));
  const locks = [];
  try {
    verify();
    for (const info of files) {
      if (!holders.has(info.id)) locks.push(acquireSessionWriter(join(home,"pi"),info.id));
    }
    const removed = deleteGuiWorkspace(home,args,files.map(info=>info.id),()=>{
      for (const lock of locks) lock.assertOwned();
      for (const info of files) {
        holders.get(info.id)?.assertOwned();
        if (signature(info.path) !== info.stamp)
          throw workspaceError("WORKSPACE_CONFLICT","对话已变化，请重新确认删除。",current);
      }
    });
    // The table commit already removed these conversations from CoThink.
    // File cleanup on Windows can be delayed by an open OS handle.
    for (const info of files) {
      try { unlinkSync(info.path); }
      catch (error) {
        if (error.code !== "ENOENT") removed.warning = "Team 已删除，部分本地历史文件未能清理。";
      }
      try { await releaseHolder(info.id); }
      catch { removed.warning = "Team 已删除，部分对话资源仍被占用。"; }
    }
    return removed;
  } finally { for (const lock of locks) lock.release(); }
}
