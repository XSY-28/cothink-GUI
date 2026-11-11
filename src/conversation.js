import {validateEditorTurnOptions} from "./gui-turn-options.js";
import {applyThinkingSelection, validateThinkingScope, validateThinkingModels, normalizeThinkingPreference, parseThinkingLevel, DEFAULT_THINKING_LEVEL} from "./thinking.js";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { isWorkspaceId, workspaceError } from "./gui-workspace-state.js";
import { loadConfig, updateConfig } from "./config.js";
import {
  readSessionTeam,
  snapshotTeam,
  resolveTeamConfig,
  selectTeam,
} from "./teams.js";
import { validateModelRefs } from "./setup.js";

// References, in selected branch order, are shared by CLI details and GUI history.
export function conversationTaskIds(manager) {
  return [...new Set(manager.getBranch().flatMap((entry) =>
    entry.message?.cothinkTaskId ? [entry.message.cothinkTaskId]
      : entry.details?.taskId ? [entry.details.taskId]
        : entry.type === "custom" && entry.customType === "cothink-task"
          ? [entry.data?.taskId] : [],
  ).filter(Boolean))];
}

// Only user entries on this exact branch carry attachment provenance. A fork
// inherits the selected prefix via Pi, so future and sibling entries stay out.
export function conversationMaterialRefs(manager) {
  return manager.getBranch().flatMap(entry => entry.type === "message" && entry.message?.role === "user" ?
    (entry.message.cothinkInputMaterials ?? []).map(ref => ({...ref,userEntryId:entry.id})) : []);
}

export function readSessionFlow(manager,{allBranches=false}={}) {
  const entry=(allBranches?manager.getEntries():manager.getBranch()).findLast(e=>e.type==='custom'&&e.customType==='cothink-flow');
  if(!entry)return 'legacy';
  if(entry.data?.flow!=='unified'||entry.data?.version!==1)throw Error('Unsupported conversation flow; open a compatible GUI');
  return 'unified';
}
export function readSessionMode(manager) {
  return readTerminalMode(manager) === "one";
}
export function readTerminalMode(manager) {
  const entry = manager
    .getBranch()
    .findLast((e) => e.type === "custom" && e.customType === "cothink-mode");
  if (!entry) return "cothink";
  if (typeof entry.data?.singleModel !== "boolean" ||
      (entry.data.projectMode !== undefined && (entry.data.projectMode !== true || entry.data.singleModel)))
    throw Error("会话模式记录损坏；请保留原记录并修复。");
  return entry.data.projectMode === true ? "project" : entry.data.singleModel ? "one" : "cothink";
}
export function readSessionWorkspace(manager) {
  const entry = manager.getBranch().findLast(e => e.type === "custom" && e.customType === "cothink-gui-workspace");
  if (!entry) return undefined;
  const id = entry.data?.workspaceId;
  if (id === null || isWorkspaceId(id)) return id;
  throw workspaceError("WORKSPACE_UNAVAILABLE", "会话的 Team 归属损坏；原记录保留。");
}
export function readSessionProject(manager) {
  const entry = manager
    .getBranch()
    .findLast((e) => e.type === "custom" && e.customType === "cothink-project");
  if (!entry) return manager.getCwd(); // Legacy CLI sessions retain their original project boundary.
  const project = entry.data?.project;
  if (
    project !== null &&
    (typeof project !== "string" ||
      !isAbsolute(project) ||
      resolve(project) !== project)
  )
    throw Error("会话项目关联损坏；保留原记录。");
  return project;
}
export const conversationFolderName = id => "对话-" + id;
export function readManagedDirectory(manager) {
  const data=manager.getBranch().findLast(e=>e.type==="custom" && e.customType==="cothink-project")?.data;
  if (data?.managedDirectory===undefined) return undefined;
  const path=readSessionProject(manager), identity=data.managedDirectory;
  if (!path || path!==join(dirname(path),conversationFolderName(manager.getSessionId())) ||
      !Array.isArray(identity) || identity.length!==2 || identity.some(part=>typeof part!=="string" || !/^\d+$/.test(part)))
    throw Error("无法核对对话文件夹的身份，原有文件已保留。");
  return identity;
}
function neutralPaths(home) {
  const root = join(realpathSync(tmpdir()), "cothink-chat");
  const key = createHash("sha256").update(resolve(home)).digest("hex").slice(0, 24);
  return [root, join(root,key)];
}
function checkNeutralDirectory(path) {
  const stat = lstatSync(path);
  const uid = process.getuid?.();
  if (!stat.isDirectory() || realpathSync(path)!==path ||
      uid!==undefined && (stat.uid!==uid || (stat.mode&0o022)!==0))
    throw Error("CoThink 的临时对话目录不可安全使用。");
}
export function existingNeutralDirectory(home) {
  try {
    const paths = neutralPaths(home);
    paths.forEach(checkNeutralDirectory);
    return paths[1];
  } catch { return undefined; }
}
export function neutralDirectory(home) {
  const paths = neutralPaths(home);
  for (const path of paths) {
    try { mkdirSync(path,{mode:0o700}); }
    catch (error) { if (error.code!=="EEXIST") throw error; }
    checkNeutralDirectory(path);
  }
  return paths[1];
}
export function conversationCwd(manager, home) {
  return readSessionProject(manager) ?? neutralDirectory(home);
}
export function appendConversationEntry(owner, type, data) {
  if (owner.selectionError) throw Error(owner.selectionError);
  const manager = owner.sessionManager,
    previous = manager.getLeafId();
  try {
    owner.assertOwned();
    return manager.appendCustomEntry(type, data);
  } catch (error) {
    if (previous) manager.branch(previous);
    else manager.resetLeaf();
    owner.selectionError =
      "会话选择保存失败，请重新打开对话；草稿保留：" + error.message;
    throw Error(owner.selectionError);
  }
}
export function saveSessionMode(owner, singleModel) {
  if (typeof singleModel !== "boolean" && singleModel !== "project") throw Error("模式无效");
  if (owner.selectionError) throw Error(owner.selectionError);
  const mode = singleModel === "project" ? "project" : singleModel ? "one" : "cothink";
  if (readTerminalMode(owner.sessionManager) !== mode) {
    try {
      appendConversationEntry(owner, "cothink-mode", { singleModel: mode === "one", ...(mode === "project" ? {projectMode:true} : {}) });
    } catch (error) {
      owner.selectionError = error.message.replace(
        "会话选择保存失败",
        "模式保存失败",
      );
      throw Error(owner.selectionError);
    }
  }
  owner.singleModel = mode === "one";
  owner.projectMode = mode === "project";
  return singleModel;
}
export function saveSessionTeam(owner, team) {
  const selected = snapshotTeam(team);
  if (
    JSON.stringify(readSessionTeam(owner.sessionManager.getBranch())) !==
    JSON.stringify(selected)
  )
    appendConversationEntry(owner, "cothink-team", { team: selected });
}
export function resolveConversationConfig(
  config,
  manager,
  { fresh = false, inheritedTeam } = {},
) {
  const saved = readSessionTeam(manager.getBranch());
  if (config?.formatVersion !== 3)
    return { config: structuredClone(config), needsTeam: !saved };
  const effective = resolveTeamConfig(config, saved ?? inheritedTeam);
  if (!fresh && !saved) delete effective.team;
  return { config: effective, needsTeam: !fresh && !saved };
}
export function rememberRecentTeam(home, team) {
  const latest = loadConfig(home);
  if (
    latest?.formatVersion === 3 &&
    team &&
    latest.teams.some((t) => t.id === team.id) &&
    latest.lastUsedTeamId !== team.id
  )
    updateConfig(home, (c) => selectTeam(c, team.id));
}
export async function selectConversationTeam({
  home,
  owner,
  team,
  busy = false,
}) {
  if (busy) throw Error("当前任务尚未结束，请先取消或等待。");
  if (owner.selectionError) throw Error(owner.selectionError);
  const latest = loadConfig(home),
    selected = snapshotTeam(team);
  if (!latest?.teams?.some((t) => t.id === selected.id))
    throw Error("team 已被其他实例删除，请刷新列表。");
  const next = resolveTeamConfig(latest, selected),
    before = owner.effectiveConfig;
  await validateModelRefs(next, owner.modelRuntime);
  try {
    owner.assertOwned();
    await owner.selectModel(next.main);
    saveSessionTeam(owner, selected);
  } catch (error) {
    if (sessionWriteIncomplete(owner))
      owner.selectionError ??=
        "模型/会话记录保存失败，请重新打开对话；草稿保留。";
    if (!owner.selectionError && before?.main)
      try {
        await owner.selectModel(before.main);
      } catch {
        owner.selectionError = "模型恢复失败，请重新打开对话。";
      }
    throw error;
  }
  owner.effectiveConfig = next;
  owner.needsTeam = false;
  owner.recentTeamError = null;
  try {
    rememberRecentTeam(home, selected);
  } catch (error) {
    owner.recentTeamError =
      "当前对话已切换，新对话默认未更新：" + error.message;
  }
  return next;
}
export function normalizeConversationEditor(data) {
  if (data?.editorVersion !== undefined && data.editorVersion !== 2)
    throw Error("草稿版本不支持；请使用兼容界面。");
  const editor = {editorVersion:2,text:data?.text ?? "",workRequest:data?.workRequest ?? null,
    selectionId:data?.selectionId ?? null,editId:data?.editId ?? null,
    ...(data?.turnOptions!==undefined?{turnOptions:validateEditorTurnOptions(data.turnOptions)}:{}),
    materials:data?.materials ?? []};
  if (!Array.isArray(editor.materials) || editor.materials.some(ref => !ref || !isWorkspaceId(ref.id) ||
    typeof ref.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(ref.sha256) ||
    Object.keys(ref).some(k=>!["id","sha256"].includes(k)))) throw Error("草稿材料引用无效；原记录保留。");
  if (typeof editor.text !== "string" || (editor.workRequest !== null &&
      (editor.workRequest.kind !== "html-svg" || Object.keys(editor.workRequest).length !== 1)) ||
      (editor.selectionId !== null && !isWorkspaceId(editor.selectionId)) ||
      (editor.editId !== null && !isWorkspaceId(editor.editId)) ||
      (editor.workRequest === null) !== (editor.selectionId === null)) throw Error("草稿记录损坏；原记录保留。");
  return editor;
}

export function readConversationMetadata(manager) {
  const entries = manager.getBranch();
  const last = (type) =>
    entries.findLast((e) => e.type === "custom" && e.customType === type)?.data;
  const draftEntry = entries.findLast(e => e.type === "custom" && e.customType === "cothink-draft");
  const data = draftEntry?.data;
  const editor = normalizeConversationEditor(data);
  const thinking = last("cothink-thinking");
  return {
    title: last("cothink-title")?.title ?? entries.findLast((e) => e.type === "session_info")?.name ?? "",
    draft: editor.text,
    editor,
    draftRevision: draftEntry?.id ?? null,
    branchAnchor: manager.getLeafId(),
    thinking: thinking?.level,
    thinkingScope: thinking ? validateThinkingScope(thinking.scope) : undefined,
  };
}

/** GUI admission validates the models this operation can actually call. */
export async function resolveConversationThinking(home, config, manager, {mainOnly = false} = {}) {
  const level = normalizeThinkingPreference(readConversationMetadata(manager).thinking);
  const effective = applyThinkingSelection(config, {level, scope:"all"});
  await validateThinkingModels(home, effective, level, mainOnly ? "main" : "all");
  return effective;
}

/** Legacy CLI restores its displayed Team snapshot from the selected branch. */
export function restoreConversationThinking(config, manager) {
  const {thinking:level, thinkingScope:scope} = readConversationMetadata(manager);
  const effective = applyThinkingSelection(config, {level, scope});
  if (level !== undefined && effective.team)
    effective.team = snapshotTeam({...effective.team, main:effective.main, secondary:effective.secondary});
  return effective;
}

export async function saveConversationThinking(home, owner, {level, scope}) {
  const team = readSessionTeam(owner.sessionManager.getBranch());
  if (!team) throw Error("请先绑定 Team。");
  if (scope !== undefined && scope !== "all") throw Error("新思考设置的作用范围必须为 all。");
  level = level === undefined ? DEFAULT_THINKING_LEVEL : parseThinkingLevel(level);
  await validateThinkingModels(home, team, level, "all");
  appendConversationEntry(owner, "cothink-thinking", {level, scope:"all"});
}

export function sessionWriteIncomplete(owner) {
  const path = owner.sessionManager.getSessionFile();
  if (!path || !existsSync(path)) return false;
  try {
    return !readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .some((e) => e.id === owner.sessionManager.getLeafId());
  } catch {
    return true;
  }
}
