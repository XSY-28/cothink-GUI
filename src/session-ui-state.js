import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { acquireSessionWriter, privateDirectory, writePrivateJson } from "./storage.js";

export const sessionStateError = (code, message) => Object.assign(new Error(message), {code});
const defaults = () => ({schemaVersion: 2, revision: 0, archived: false, pinned: false, changedAt: null, viewRevision: 0, view: null});
const timestamp = value => value === null || typeof value === "string" && Number.isFinite(Date.parse(value));
function validSeen(seen) {
  return !!seen && typeof seen === "object" && !Array.isArray(seen) &&
    Object.entries(seen).every(([id,revision]) => id.length > 0 && typeof revision === "string" && revision.length > 0);
}
function validView(view) {
  return view === null || !!view && typeof view === "object" && !Array.isArray(view) && view.initialized === true &&
    timestamp(view.lastOpenedAt) && validSeen(view.seenResults) &&
    Object.keys(view).every(key => ["initialized","lastOpenedAt","anchor","seenResults"].includes(key)) &&
    (view.anchor === null || !!view.anchor && typeof view.anchor.taskId === "string" &&
      ["input","result"].includes(view.anchor.part) && Number.isFinite(view.anchor.offsetPx) && view.anchor.offsetPx >= 0 &&
      Object.keys(view.anchor).every(key => ["taskId","part","offsetPx"].includes(key)));
}
function withUiWriter(home,sessionId,operation) {
  const writer = acquireSessionWriter(join(home,"gui-ui"),sessionId);
  try { return operation(writer.assertOwned); } finally { writer.release(); }
}
function pathFor(home, id) {
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))
    throw sessionStateError("INVALID_ID", "无效会话 ID。");
  return join(home, "session-ui", id + ".json");
}
export function readSessionUiState(home, sessionId) {
  const path = pathFor(home, sessionId);
  try {
    const state = JSON.parse(readFileSync(path, "utf8"));
    if (![1,2].includes(state?.schemaVersion) || !Number.isSafeInteger(state.revision) || state.revision < 0 ||
      typeof state.archived !== "boolean" || typeof state.pinned !== "boolean" ||
      !timestamp(state.changedAt) ||
      Object.keys(state).some(k => !(state.schemaVersion === 1 ? ["schemaVersion","revision","archived","pinned","changedAt"] : Object.keys(defaults())).includes(k)) ||
      state.schemaVersion === 2 && (!Number.isSafeInteger(state.viewRevision) || state.viewRevision < 0 || !validView(state.view))) throw Error("format");
    return {...defaults(),...state,schemaVersion:2};
  } catch (e) {
    if (e.code === "ENOENT") return defaults();
    throw sessionStateError("SESSION_STATE_UNAVAILABLE", "导航状态损坏、不可读或版本不支持；原文件保留，管理操作已停用。");
  }
}
export function writeSessionUiState(home, change, assertOwned) {
  const {sessionId, expectedRevision, ...fields} = change;
  const keys = Object.keys(fields);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || keys.length !== 1 ||
    !["archived", "pinned"].includes(keys[0]) || typeof fields[keys[0]] !== "boolean") throw Error("导航状态参数无效。");
  return withUiWriter(home,sessionId,assertUiOwned => {
    assertOwned();
    const before = readSessionUiState(home, sessionId);
    if (before.revision !== expectedRevision)
      throw sessionStateError("SESSION_STATE_CONFLICT", "导航状态已变化，请重新读取后决定；本次未覆盖。");
    const next = {...before, ...fields, revision: before.revision + 1, changedAt: new Date().toISOString()};
    privateDirectory(join(home, "session-ui"));
    writePrivateJson(pathFor(home, sessionId), next, () => {
      assertOwned();
      assertUiOwned();
      if (readSessionUiState(home, sessionId).revision !== expectedRevision)
        throw sessionStateError("SESSION_STATE_CONFLICT", "导航状态已变化，本次未覆盖。");
    });
    return next;
  });
}

export function initializeSessionView(home,{sessionId,seenResults,onlyIfMissing = false}) {
  if (!validSeen(seenResults)) throw Error("阅读基线无效。");
  const path = pathFor(home,sessionId);
  const current=readSessionUiState(home,sessionId);
  if (current.view?.initialized || onlyIfMissing && existsSync(path)) return current;
  return withUiWriter(home,sessionId,assertOwned => {
    const before=readSessionUiState(home,sessionId);
    if (before.view?.initialized || onlyIfMissing && existsSync(path)) return before;
    const next={...before,viewRevision:before.viewRevision+1,
      view:{initialized:true,lastOpenedAt:null,anchor:null,seenResults:{...seenResults}}};
    privateDirectory(join(home,"session-ui"));
    writePrivateJson(path,next,assertOwned);
    return next;
  });
}

export function writeSessionViewState(home,{sessionId,expectedViewRevision,baseline,opened,anchor,seen}) {
  if (!Number.isSafeInteger(expectedViewRevision) || expectedViewRevision < 0 ||
      !validSeen(baseline) || opened !== undefined && opened !== true)
    throw Error("阅读状态参数无效。");
  return withUiWriter(home,sessionId,assertOwned => {
    const before = readSessionUiState(home,sessionId);
    if (before.viewRevision !== expectedViewRevision)
      throw sessionStateError("VIEW_CONFLICT","阅读状态已变化，请重新读取；本次未覆盖。");
    const prior = before.view ?? {initialized:true,lastOpenedAt:null,anchor:null,seenResults:baseline};
    const view = {...prior,
      lastOpenedAt:opened ? new Date().toISOString() : prior.lastOpenedAt,
      anchor:anchor === undefined ? prior.anchor : anchor,
      seenResults:seen ? {...prior.seenResults,[seen.taskId]:seen.resultRevision} : prior.seenResults,
    };
    if (!validView(view)) throw Error("阅读状态参数无效。");
    const next = {...before,view,viewRevision:before.viewRevision+1};
    privateDirectory(join(home,"session-ui"));
    writePrivateJson(pathFor(home,sessionId),next,assertOwned);
    return next;
  });
}


// One durable editor before a session exists. Its revision is scoped to draftId.
const homePath = home => join(home,"session-ui","pending-home.json");
export function readHomeDraft(home) {
  try {
    const row=JSON.parse(readFileSync(homePath(home),"utf8"));
    const id=value=>typeof value==="string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
    if (row?.schemaVersion!==1 || !id(row.draftId) || !Number.isSafeInteger(row.revision) || row.revision<1 ||
      !row.editor || row.editor.editorVersion!==2 || !id(row.editor.editId) ||
      !(row.pendingCreateSessionId===null || id(row.pendingCreateSessionId)) ||
      !(row.targetWorkspaceId===null || id(row.targetWorkspaceId)))
      throw Error("format");
    return row;
  } catch (error) {
    if(error.code==="ENOENT") return null;
    throw sessionStateError("DRAFT_CONFLICT","首页保存稿不可读取；原记录保留。");
  }
}

export function writeHomeDraft(home,{draftId,expectedRevision},change) {
  return withUiWriter(home,"00000000-0000-0000-0000-000000000001",assertOwned=>{
    const check=()=>{
      assertOwned();
      const row=readHomeDraft(home);
      if ((row?.revision ?? null)!==expectedRevision || row && row.draftId!==draftId)
        throw sessionStateError("DRAFT_CONFLICT","首页保存稿已变化；当前输入保留，请先核对。");
      return row;
    };
    const previous=check(), fields=change(previous);
    const path=homePath(home);
    if(fields===null) {
      check();
      unlinkSync(path);
      return null;
    }
    const next={schemaVersion:1,draftId,revision:(previous?.revision ?? 0)+1,...fields};
    privateDirectory(join(home,"session-ui"));
    writePrivateJson(path,next,check);
    return next;
  });
}
