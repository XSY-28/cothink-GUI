import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { acquireSessionWriter, writePrivateBytes, writePrivateJson } from "./storage.js";
import avatarManifest from "../gui/src/assets/team-avatars/manifest.json" with {type:"json"};

const writerId = "00000000-0000-4000-8000-000000000001";
export const isWorkspaceId = id =>
  typeof id === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id);
export const isWorkspaceProject = path =>
  typeof path === "string" && !path.includes("\0") && isAbsolute(path) && resolve(path) === path;
export const workspaceError = (code, message, workspace) =>
  Object.assign(new Error(message), {code, ...(workspace && {workspace})});
const unavailable = () =>
  workspaceError("WORKSPACE_UNAVAILABLE", "项目 Team 目录表不可用或无法确认；原记录保留，请刷新或修复后再操作。");
const pathFor = home => join(home,"gui-workspaces.json");
const revision = value => Number.isSafeInteger(value) && value >= 0;
const record = value => !!value && typeof value === "object" && !Array.isArray(value);
const validName = name => typeof name === "string" && name === name.trim() && name.length > 0 && [...name].length <= 80;
const nameKey = name => name.normalize("NFC").replace(/[A-Z]/g, letter => letter.toLowerCase());
const projectKey = path => process.platform === "win32" ? path.toLowerCase() : path;
const sameDirectory = (a, b) => a !== null && b !== null && projectKey(a) === projectKey(b);
export function sameWorkspaceDirectory(a, b) {
  if (!isWorkspaceProject(a) || !isWorkspaceProject(b)) return false;
  if (sameDirectory(a, b)) return true;
  try {
    const first = statSync(a, {bigint:true}), second = statSync(b, {bigint:true});
    return first.isDirectory() && second.isDirectory() && first.ino !== 0n &&
      first.dev === second.dev && first.ino === second.ino;
  } catch { return false; }
}
const sameName = (a, b) => a.project === null && b.project === null && nameKey(a.name) === nameKey(b.name);
const rosterId = id => id === null || isWorkspaceId(id);

function readSnapshot(home) {
  const path = pathFor(home);
  try {
    if (!lstatSync(path).isFile()) throw unavailable();
  } catch (error) {
    if (error.code === "ENOENT") return {bytes:null, state:{schemaVersion:1, revision:0, workspaces:[]}};
    throw unavailable();
  }
  try {
    const bytes = readFileSync(path);
    const state = JSON.parse(bytes.toString("utf8"));
    if (!record(state) || ![1,2,3].includes(state.schemaVersion) || !revision(state.revision) || !Array.isArray(state.workspaces))
      throw unavailable();
    const ids = new Set(), projects = new Set(), names = new Set();
    for (const w of state.workspaces) {
      if (!record(w) || !isWorkspaceId(w.id) || !revision(w.revision) || w.revision > state.revision ||
          !validName(w.name) || !(w.project === null || isWorkspaceProject(w.project)) ||
          !rosterId(w.defaultRosterId) || typeof w.archived !== "boolean" ||
          typeof w.createdAt !== "string" || !Number.isFinite(Date.parse(w.createdAt)) ||
          (w.mutationId !== undefined && (state.schemaVersion < 2 || !isWorkspaceId(w.mutationId))))
        throw unavailable();
      const key = w.project === null ? nameKey(w.name) : projectKey(w.project);
      const unique = w.project === null ? names : projects;
      if (ids.has(w.id) || unique.has(key)) throw unavailable();
      ids.add(w.id);
      unique.add(key);
    }
    if (state.schemaVersion === 3) {
      if (!Array.isArray(state.deletedWorkspaceIds) || !Array.isArray(state.deletedSessionIds) ||
          !state.deletedSessionIds.every(isWorkspaceId)) throw unavailable();
      for (const id of state.deletedWorkspaceIds) {
        if (!isWorkspaceId(id) || ids.has(id)) throw unavailable();
        ids.add(id);
      }
    }
    if (state.schemaVersion >= 2) {
      if (!record(state.legacyMembership)) throw unavailable();
      for (const [sessionId, branches] of Object.entries(state.legacyMembership)) {
        if (!isWorkspaceId(sessionId) || !record(branches)) throw unavailable();
        for (const [project, workspaceId] of Object.entries(branches))
          if (!isWorkspaceProject(project) || !ids.has(workspaceId)) throw unavailable();
      }
    }
    return {state, bytes};
  } catch {
    throw unavailable();
  }
}

export function readGuiWorkspaces(home) {
  return readSnapshot(home).state;
}

// History remains readable when an unrelated workspace table is unavailable.
export function readableWorkspaceTable(home) {
  try { return readGuiWorkspaces(home); } catch { return null; }
}

export function taskTeamWasDeleted(state, task) {
  return state?.deletedSessionIds?.includes(task.sessionId) || state?.deletedWorkspaceIds?.includes(task.workspace?.id);
}

function backupV1(home, bytes, beforeCommit) {
  const primary = join(home,"gui-workspaces.v1.json");
  const existing = path => {
    try {
      if (!lstatSync(path).isFile()) throw unavailable();
      return readFileSync(path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return null;
    }
  };
  let target = primary;
  const previous = existing(primary);
  if (previous && !previous.equals(bytes)) {
    // A prior attempt may have saved its backup before the v2 publication failed.
    const digest = createHash("sha256").update(bytes).digest("hex");
    target = join(home,"gui-workspaces.v1." + digest + ".json");
  }
  const saved = existing(target);
  if (!saved) writePrivateBytes(target, bytes, beforeCommit);
  else if (!saved.equals(bytes)) throw unavailable();
}

function write(home, update) {
  let writer;
  try { writer = acquireSessionWriter(join(home,"gui"),writerId); }
  catch { throw unavailable(); }
  try {
    const {state, bytes} = readSnapshot(home);
    const oldVersion = state.schemaVersion;
    const {changed, result, verify} = update(state);
    if (changed) {
      if (!revision(state.revision + 1)) throw unavailable();
      const beforeCommit = () => {
        writer.assertOwned();
        const latest = readSnapshot(home).bytes;
        if (bytes ? !latest?.equals(bytes) : latest !== null) throw unavailable();
        if (verify) verify();
      };
      beforeCommit();
      if (bytes && oldVersion === 1 && state.schemaVersion >= 2) backupV1(home, bytes, beforeCommit);
      writePrivateJson(pathFor(home), {...state, revision:state.revision + 1}, beforeCommit);
    }
    return result;
  } finally { writer.release(); }
}

function assertUnique(state, candidate, checkAliases = true) {
  const sameProject = checkAliases ? sameWorkspaceDirectory : sameDirectory;
  const existing = state.workspaces.find(w => w.id !== candidate.id && (sameProject(w.project,candidate.project) || sameName(w,candidate)));
  if (existing)
    throw workspaceError("WORKSPACE_CONFLICT", candidate.project === null
      ? "已有同名的无目录 Team；请改名或打开已有 Team。"
      : "此目录已有 Team；请打开已有 Team，归档项需先恢复。", existing);
}
function workspace(id, name, project, defaultRosterId) {
  name = typeof name === "string" ? name.trim() : name;
  if (!isWorkspaceId(id) || !validName(name) || !(project === null || isWorkspaceProject(project)) || !rosterId(defaultRosterId))
    throw Error("项目 Team 参数无效；名称须为 1—80 个字符。");
  return {id, revision:0, name, project, defaultRosterId, archived:false, createdAt:new Date().toISOString()};
}

export function validateWorkspaceAction(name, args) {
  const keys = name === "workspace.create" ? ["workspaceId","name","project","defaultRosterId"] :
    name === "workspace.rebind" ? ["workspaceId","expectedRevision","path","operationId"] :
    name === "workspace.delete" ? ["workspaceId","expectedRevision"] :
    name === "workspace.bind" ? ["workspaceId","expectedRevision","path"] : ["workspaceId","expectedRevision","change"];
  if (name === "workspace.create" && args && Object.hasOwn(args,"avatarId")) keys.push("avatarId");
  if (!args || Object.keys(args).length !== keys.length || !keys.every(key => Object.hasOwn(args,key)) ||
      !isWorkspaceId(args.workspaceId))
    throw Error("项目 Team 参数无效。");
}

export function createGuiWorkspace(home, {workspaceId, name, project, defaultRosterId, avatarId}) {
  if (avatarId !== undefined && !avatarManifest.some(avatar => avatar.id === avatarId))
    throw Error("请选择列表中的 Team 头像。");
  return write(home, state => {
    const existing = state.workspaces.find(w => w.id === workspaceId);
    if (state.deletedWorkspaceIds?.includes(workspaceId)) throw workspaceError("WORKSPACE_CONFLICT", "这个 Team 已删除，请重新创建。");
    if (existing) throw workspaceError("WORKSPACE_CONFLICT", "该 Team 标识已存在；请打开已保存的 Team。", existing);
    const result = workspace(workspaceId,name,project,defaultRosterId);
    if (avatarId !== undefined) result.avatarId = avatarId;
    assertUnique(state,result);
    state.workspaces.push(result);
    return {changed:true, result};
  });
}

/** A controller may supply a project change only after inspecting its canonical directory. */
export function updateGuiWorkspace(home, {workspaceId, expectedRevision, change}) {
  if (!isWorkspaceId(workspaceId) || !revision(expectedRevision) || !record(change) || Object.keys(change).length !== 1)
    throw Error("项目 Team 变更参数无效。");
  return write(home, state => {
    const at = state.workspaces.findIndex(w => w.id === workspaceId);
    const current = state.workspaces[at];
    if (!current) throw workspaceError("WORKSPACE_UNAVAILABLE", "项目 Team 不存在，请刷新。");
    if (current.revision !== expectedRevision)
      throw workspaceError("WORKSPACE_CONFLICT", "项目 Team 已变化，请读取最新状态。", current);
    const [key] = Object.keys(change);
    let value = change[key];
    if (key === "name") {
      value = typeof value === "string" ? value.trim() : value;
      if (!validName(value)) throw Error("项目 Team 名称须为 1—80 个字符。");
    } else if (key === "defaultRosterId") {
      if (!rosterId(value)) throw Error("默认阵容 ID 无效。");
    } else if (key === "archived") {
      if (typeof value !== "boolean") throw Error("归档状态无效。");
    } else if (key === "project") {
      if (state.schemaVersion >= 2 || current.project !== null)
        throw workspaceError("WORKSPACE_CONFLICT", "该 Team 已绑定目录；如需另一目录请新建 Team。", current);
      if (!isWorkspaceProject(value)) throw Error("项目目录无效。");
    } else throw Error("项目 Team 变更参数无效。");
    if (!revision(current.revision + 1)) throw unavailable();
    const {mutationId: _mutationId, ...previous} = current;
    const result = {...previous, [key]:value, revision:current.revision + 1};
    assertUnique(state,result,key === "project");
    state.workspaces[at] = result;
    return {changed:true, result};
  });
}

export function workspaceForProject(state, path) {
  return state.workspaces.find(w => sameDirectory(w.project,path));
}

// Retain only deleted IDs to distinguish a deliberately removed Team from damaged history.
export function deleteGuiWorkspace(home, {workspaceId, expectedRevision}, sessionIds = [], verify) {
  if (!isWorkspaceId(workspaceId) || !revision(expectedRevision) || !Array.isArray(sessionIds) || !sessionIds.every(isWorkspaceId))
    throw Error("项目 Team 删除参数无效。");
  return write(home, state => {
    const at = state.workspaces.findIndex(row => row.id === workspaceId);
    if (at < 0) throw workspaceError("WORKSPACE_UNAVAILABLE", "项目 Team 不存在，请刷新。");
    const current = state.workspaces[at];
    if (current.revision !== expectedRevision)
      throw workspaceError("WORKSPACE_CONFLICT", "项目 Team 已变化，请重新确认删除。", current);
    state.workspaces.splice(at, 1);
    state.schemaVersion = 3;
    state.legacyMembership ??= {};
    (state.deletedWorkspaceIds ??= []).push(workspaceId);
    state.deletedSessionIds = [...new Set([...(state.deletedSessionIds ?? []), ...sessionIds])];
    return {changed:true, result:{workspaceId, deleted:true}, verify};
  });
}

function mappedId(state, sessionId, project) {
  return state.legacyMembership?.[sessionId]?.[project];
}

export function workspaceForSession(state, sessionId, project, workspaceId) {
  const id = workspaceId ?? mappedId(state,sessionId,project);
  return id ? state.workspaces.find(w => w.id === id) : workspaceForProject(state, project ?? null);
}

export function sessionTeamWasDeleted(state, sessionId, project, marker) {
  return state?.deletedWorkspaceIds?.includes(marker ?? mappedId(state,sessionId,project));
}

function remember(state, sessionId, project, workspaceId) {
  state.schemaVersion = Math.max(2,state.schemaVersion);
  state.legacyMembership ??= {};
  const branches = state.legacyMembership[sessionId] ??= {};
  branches[project] = workspaceId;
}

function discoverLegacyBinding(state, {sessionId, project}) {
  if (sessionId && mappedId(state,sessionId,project)) return false;
  let target = workspaceForProject(state,project);
  if (!target) {
    const aliases = state.workspaces.filter(item => sameWorkspaceDirectory(item.project,project));
    // Old tables with existing aliases keep their saved owners. A third
    // spelling does not determine which old Team should own a new branch.
    if (aliases.length > 1) return false;
    target = aliases[0];
  }
  if (!target) {
    const name = [...(basename(project).trim() || project.trim())].slice(0,80).join("").trimEnd();
    target = workspace(randomUUID(),name,project,null);
    state.workspaces.push(target);
  } else if (!sessionId) return false;
  if (sessionId) remember(state,sessionId,project,target.id);
  return true;
}

function checkRebind({workspaceId, operationId, expectedRevision}) {
  if (!isWorkspaceId(workspaceId) || !isWorkspaceId(operationId) || !revision(expectedRevision))
    throw Error("项目 Team 目录变更参数无效。");
}

function confirmed(current, {operationId, expectedRevision}) {
  return current?.mutationId === operationId && current.revision === expectedRevision + 1;
}

export function queryGuiWorkspaceRebind(home, input) {
  checkRebind(input);
  const state = readGuiWorkspaces(home);
  const workspace = state.workspaces.find(w => w.id === input.workspaceId) ?? null;
  return {status:confirmed(workspace, input) ? "confirmed" : "unconfirmed", workspace};
}

export function rebindGuiWorkspace(home, input, verifyLegacyBindings) {
  checkRebind(input);
  const {workspaceId, operationId, expectedRevision, path, legacyBindings} = input;
  if (!(path === null || isWorkspaceProject(path)) || !Array.isArray(legacyBindings) ||
      !legacyBindings.every(binding => record(binding) && isWorkspaceId(binding.sessionId) && isWorkspaceProject(binding.project)) ||
      typeof verifyLegacyBindings !== "function")
    throw Error("项目 Team 目录或旧会话归属参数无效。");

  return write(home, state => {
    const at = state.workspaces.findIndex(w => w.id === workspaceId);
    const current = state.workspaces[at];
    if (!current) throw workspaceError("WORKSPACE_UNAVAILABLE", "项目 Team 不存在，请刷新。");
    if (confirmed(current, input) && current.project === path) return {changed:false, result:current};
    if (current.revision !== expectedRevision || !revision(current.revision + 1))
      throw workspaceError("WORKSPACE_CONFLICT", "项目 Team 已变化，请读取最新状态。", current);
    if (current.archived) throw workspaceError("WORKSPACE_CONFLICT", "请先恢复项目 Team。", current);
    const result = {...current, project:path, mutationId:operationId, revision:current.revision + 1};
    assertUnique(state,result);

    state.schemaVersion = Math.max(2,state.schemaVersion);
    state.legacyMembership ??= {};
    // Discover against the old directory table. A destination with new
    // legacy history needs its own Team before it can participate in rebind.
    for (const binding of legacyBindings) {
      if (sameWorkspaceDirectory(binding.project,path) &&
          !mappedId(state,binding.sessionId,binding.project) &&
          !state.workspaces.some(item=>sameWorkspaceDirectory(item.project,binding.project)))
        throw workspaceError("WORKSPACE_CONFLICT", "目标目录有尚未归属的旧对话。请刷新历史后查看该目录的 Team。");
      discoverLegacyBinding(state,binding);
    }
    state.workspaces[at] = result;
    const verify = () => {
      const result = verifyLegacyBindings();
      if (result === false || typeof result?.then === "function")
        throw workspaceError("WORKSPACE_CONFLICT", "旧会话归属已变化，请重新读取。", current);
    };
    return {changed:true, result, verify};
  });
}

/** Legacy history uses its persisted branch path, even after a Team moves. */
export function importGuiWorkspaceProjects(home, paths) {
  const candidates = paths.flatMap(item => {
    if (isWorkspaceProject(item)) return [{project:item}];
    if (record(item) && isWorkspaceId(item.sessionId) && isWorkspaceProject(item.project)) return [item];
    return [];
  });
  const missing = (state, {sessionId, project}) => sessionId
    ? !mappedId(state, sessionId, project)
    : !workspaceForProject(state, project);
  const state = readGuiWorkspaces(home);
  if (!candidates.some(item => missing(state,item))) return state;
  return write(home, current => {
    let changed = false;
    for (const item of candidates)
      if (discoverLegacyBinding(current,item)) changed = true;
    return {changed, result:{...current, revision:current.revision + Number(changed)}};
  });
}
