import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { acquireSessionWriter, writePrivateJson } from "./storage.js";

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
const sameName = (a, b) => a.project === null && b.project === null && nameKey(a.name) === nameKey(b.name);
const rosterId = id => id === null || isWorkspaceId(id);

export function readGuiWorkspaces(home) {
  const path = pathFor(home);
  try {
    if (!lstatSync(path).isFile()) throw unavailable();
  } catch (error) {
    if (error.code === "ENOENT") return {schemaVersion:1, revision:0, workspaces:[]};
    throw unavailable();
  }
  try {
    const state = JSON.parse(readFileSync(path, "utf8"));
    if (!record(state) || state.schemaVersion !== 1 || !revision(state.revision) || !Array.isArray(state.workspaces))
      throw unavailable();
    const ids = new Set(), projects = new Set(), names = new Set();
    for (const w of state.workspaces) {
      if (!record(w) || !isWorkspaceId(w.id) || !revision(w.revision) || w.revision > state.revision ||
          !validName(w.name) || !(w.project === null || isWorkspaceProject(w.project)) ||
          !rosterId(w.defaultRosterId) || typeof w.archived !== "boolean" ||
          typeof w.createdAt !== "string" || !Number.isFinite(Date.parse(w.createdAt)))
        throw unavailable();
      const key = w.project === null ? nameKey(w.name) : projectKey(w.project);
      const unique = w.project === null ? names : projects;
      if (ids.has(w.id) || unique.has(key)) throw unavailable();
      ids.add(w.id);
      unique.add(key);
    }
    return state;
  } catch {
    throw unavailable();
  }
}

function write(home, update) {
  let writer;
  try { writer = acquireSessionWriter(join(home,"gui"),writerId); }
  catch { throw unavailable(); }
  try {
    const state = readGuiWorkspaces(home);
    const {changed, result} = update(state);
    if (changed) {
      if (!revision(state.revision + 1)) throw unavailable();
      try { writePrivateJson(pathFor(home), {...state, revision:state.revision + 1}, writer.assertOwned); }
      catch { throw unavailable(); }
    }
    return result;
  } finally { writer.release(); }
}

function assertUnique(state, candidate) {
  const existing = state.workspaces.find(w => w.id !== candidate.id && (sameDirectory(w.project,candidate.project) || sameName(w,candidate)));
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

export function createGuiWorkspace(home, {workspaceId, name, project, defaultRosterId}) {
  return write(home, state => {
    const existing = state.workspaces.find(w => w.id === workspaceId);
    if (existing) throw workspaceError("WORKSPACE_CONFLICT", "该 Team 标识已存在；请打开已保存的 Team。", existing);
    const result = workspace(workspaceId,name,project,defaultRosterId);
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
      if (current.project !== null)
        throw workspaceError("WORKSPACE_CONFLICT", "该 Team 已绑定目录；如需另一目录请新建 Team。", current);
      if (!isWorkspaceProject(value)) throw Error("项目目录无效。");
    } else throw Error("项目 Team 变更参数无效。");
    if (!revision(current.revision + 1)) throw unavailable();
    const result = {...current, [key]:value, revision:current.revision + 1};
    assertUnique(state,result);
    state.workspaces[at] = result;
    return {changed:true, result};
  });
}

export function workspaceForProject(state, path) {
  return state.workspaces.find(w => sameDirectory(w.project,path));
}

/** Old paths are historical identities, even if their repositories have moved. */
export function importGuiWorkspaceProjects(home, paths) {
  const state = readGuiWorkspaces(home);
  const missing = [...new Set(paths)].filter(path => isWorkspaceProject(path) && !workspaceForProject(state,path));
  if (!missing.length) return state;
  return write(home, current => {
    let changed = false;
    for (const path of missing) {
      if (workspaceForProject(current,path)) continue;
      const name = [...(basename(path).trim() || path.trim())].slice(0,80).join("").trimEnd();
      current.workspaces.push(workspace(randomUUID(),name,path,null));
      changed = true;
    }
    return {changed, result:{...current, revision:current.revision + Number(changed)}};
  });
}
