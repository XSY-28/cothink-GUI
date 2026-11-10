import {resolveDelivery} from "./project-turn.js";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { realpathSync, readFileSync, lstatSync, statSync, accessSync, constants, readdirSync, mkdirSync, rmdirSync } from "node:fs";
import { resolve, join, relative, isAbsolute, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createVersioning } from "./versioning.js";
import { taskOutputRefs } from "./gui-projection.js";
import { inspectGuiPreparation, inspectGuiGitChanges, protectedGuiProjectPath } from "./gui-project-preparation.js";
import { workspaceError, workspaceForProject } from "./gui-workspace-state.js";
import { conversationFolderName } from "./conversation.js";
import { git } from "../packages/agent-sync/src/git.js";
const exec = promisify(execFile);
export function inspectGuiDirectory(path) {
  let canonicalPath=null;
  try {
    if(typeof path!=="string"||!path.trim())throw Error("请选择目录。");
    if(!isAbsolute(path))throw Error("请输入项目目录的绝对路径。");
    canonicalPath=realpathSync(resolve(path));
    if(!statSync(canonicalPath).isDirectory())throw Error("该路径不是文件夹。");
    accessSync(canonicalPath,constants.R_OK|constants.X_OK);
    return {directoryAvailable:true,canonicalPath,reason:null};
  } catch(error) {
    const reason=error.code==="ENOENT"?"目录已不存在。":
      ["EACCES","EPERM"].includes(error.code)?"无法读取此目录。":error.message;
    return {directoryAvailable:false,canonicalPath,reason};
  }
}

export function inspectWorkspaceProject(path) {
  const directory = inspectGuiDirectory(path);
  if (!directory.directoryAvailable) throw Error(directory.reason);
  return directory.canonicalPath;
}

export function inspectTeamFolder(home,path) {
  const directory=inspectGuiDirectory(path);
  if(!directory.directoryAvailable) return directory;
  const {canonicalPath}=directory;
  try {
    if(protectedGuiProjectPath(canonicalPath,home)) throw Error("请选择专用的 Team 文件夹。");
    accessSync(canonicalPath,constants.W_OK);
    return directory;
  } catch(error) {
    return {...directory,directoryAvailable:false,reason:error.code?"不能在此文件夹新建对话。":error.message};
  }
}

export function browseProjectFolders(input) {
  const path = inspectWorkspaceProject(input ?? homedir());
  const folders = readdirSync(path,{withFileTypes:true}).filter(entry => !entry.name.startsWith(".") &&
    (entry.isDirectory() || entry.isSymbolicLink() && inspectGuiDirectory(join(path,entry.name)).directoryAvailable))
    .map(entry => ({name:entry.name,path:join(path,entry.name)})).sort((a,b) => a.name.localeCompare(b.name));
  return {path,parent:dirname(path)===path?null:dirname(path),folders};
}

export function makeProjectFolder({parent,name}) {
  if (typeof parent!=="string" || typeof name!=="string" || !name.trim() || name!==name.trim() ||
      /[\x00-\x1f\x7f\\/:]/.test(name) || /[. ]$/.test(name))
    throw Error("请输入一个新文件夹名称。");
  if (name.startsWith(".")) throw Error("浏览器选择器不创建隐藏文件夹，请使用不以点开头的名称。");
  if (inspectWorkspaceProject(parent)!==parent) throw Error("父目录已改变，请重新浏览。");
  const path = join(parent,name);
  try { mkdirSync(path); }
  catch (error) {
    if (error.code==="EEXIST") throw Error("已有同名文件或文件夹，请刷新列表或改名。");
    if (["EACCES","EPERM","EROFS"].includes(error.code)) throw Error("没有权限在此目录新建文件夹，请选择其他父目录。");
    throw error;
  }
  return {path:inspectWorkspaceProject(path)};
}

export function savedDirectoryAvailable(path, directory = inspectGuiDirectory(path)) {
  return directory.directoryAvailable &&
    !!workspaceForProject({ workspaces: [{ project: path }] }, directory.canonicalPath);
}

export function workspaceDirectoryFacts(home, path) {
  return {
    projectAvailable: path === null ? null : savedDirectoryAvailable(path),
    projectHomeProtected: protectedGuiProjectPath(path, home),
  };
}

function pathIdentity(path) {
  const stat=lstatSync(path,{bigint:true});
  if (!stat.isDirectory() || realpathSync(path)!==path)
    throw workspaceError("WORKSPACE_UNAVAILABLE","文件夹指向了其他位置。");
  return [String(stat.dev),String(stat.ino)];
}

export function createConversationFolder(home, teamRoot, id) {
  if (protectedGuiProjectPath(teamRoot,home))
    throw workspaceError("WORKSPACE_UNAVAILABLE","请选择专用的 Team 文件夹。");
  const before=pathIdentity(teamRoot), project=join(teamRoot,conversationFolderName(id));
  try { mkdirSync(project,{mode:0o700}); }
  catch(error) {
    if(error.code==="EEXIST") throw Error("对话文件夹已存在，未覆盖现有内容。");
    throw error;
  }
  if (JSON.stringify(pathIdentity(teamRoot))!==JSON.stringify(before))
    throw workspaceError("WORKSPACE_UNAVAILABLE","Team 文件夹已改变，请重新打开 Team。");
  return {project,managedDirectory:pathIdentity(project)};
}

function verifyConversationFolder(home,{project,managedDirectory}) {
  if (!managedDirectory || protectedGuiProjectPath(project,home) ||
      JSON.stringify(pathIdentity(project))!==JSON.stringify(managedDirectory))
    throw workspaceError("WORKSPACE_UNAVAILABLE","对话文件夹已移动或更换，不能写入。");
  return project;
}

export function discardEmptyConversationFolder(home, folder) {
  try { rmdirSync(verifyConversationFolder(home,folder)); }
  catch { /* Preserve any existing user content, including an occupied folder. */ }
}

async function verifyConversationRepository(project) {
  pathIdentity(join(project,".git"));
  const root=(await git(project,["rev-parse","--show-toplevel"])).toString().replace(/\r?\n$/,"");
  if (JSON.stringify(pathIdentity(root))!==JSON.stringify(pathIdentity(project)))
    throw workspaceError("WORKSPACE_UNAVAILABLE","对话文件夹的 Git 范围已改变。");
}

async function initializeConversationRepository(home, workspace) {
  const project=verifyConversationFolder(home,workspace);
  try { pathIdentity(join(project,".git")); }
  catch (error) {
    if (error.code!=="ENOENT") throw error;
    await git(project,["init","--quiet","--template=","--initial-branch=main"]);
  }
  await verifyConversationRepository(project);
  try { await git(project,["rev-parse","--verify","HEAD^{commit}"]); }
  catch (error) {
    if (error.exitCode!==128) throw error;
    const tree=(await git(project,["mktree"],Buffer.alloc(0))).toString().trim();
    const commit=(await git(project,["commit-tree",tree,"-m","Initialize CoThink conversation"])).toString().trim();
    await git(project,["update-ref","HEAD",commit,"0".repeat(commit.length)]);
  }
  verifyConversationFolder(home,workspace);
}

export async function requireConversationFileWork(home, workspace, expectedIdentity = workspace.directoryIdentity) {
  if (workspace.managedDirectory) await initializeConversationRepository(home,workspace);
  return requireFileWork(home,workspace.project,expectedIdentity);
}

export async function placeConversationDelivery(home,workspace,version) {
  const project=verifyConversationFolder(home,workspace);
  await verifyConversationRepository(project);
  const head=async()=>(await git(project,["rev-parse","--verify","HEAD^{commit}"])).toString().trim();
  if (await head()===version) return;
  if ((await git(project,["status","--porcelain","--untracked-files=no"])).length)
    throw Error("对话文件夹有尚未保存到 Git 的修改。");
  await git(project,["merge","--ff-only","--no-autostash","--no-overwrite-ignore",version]);
  if (await head()!==version) throw Error("对话文件夹没有更新到交付版本。");
}

export async function fileWorkStatus(home, path) {
  if (!savedDirectoryAvailable(path))
    return { executionReady: false, reason: "保存的目录已不可用或指向其他位置。" };
  try {
    const repo = await inspectGuiPreparation(path, home);
    const executionReady = !!repo.head && !repo.preparation;
    return {
      executionReady, root: repo.root, relativePath: repo.relativePath, directoryIdentity: repo.pathIdentity,
      preparation: repo.preparation ?? null,
      reason: executionReady ? null : "此目录需要先准备文件工作。",
    };
  } catch (error) {
    return {
      executionReady: false, reason: error.message,
      ...(error.code === "PROJECT_PREPARATION_PROTECTED" ? { homeDirectory: true } : {}),
    };
  }
}

export async function requireFileWork(home, path, expectedIdentity) {
  const inspected = await fileWorkStatus(home, path);
  if (expectedIdentity !== undefined && inspected.executionReady &&
      JSON.stringify(inspected.directoryIdentity) !== JSON.stringify(expectedIdentity))
    throw workspaceError("WORKSPACE_UNAVAILABLE", "工作请求发出后目录身份已改变，请重新核对。");
  if (!inspected.executionReady)
    throw Object.assign(Error(inspected.reason), { code: "PROJECT_NOT_PREPARED", path });
  return inspected;
}

export async function requireGuiFileTask(home, workspace, work) {
  const {project}=workspace;
  if (!project) throw workspaceError("PROJECT_NOT_PREPARED", "此对话尚未关联项目目录，文件任务未发送。");
  try {
    await requireConversationFileWork(home,workspace);
  } catch (error) {
    if (error.code !== "PROJECT_NOT_PREPARED") throw error;
    throw workspaceError(error.code, `此旧对话的文件夹不能用于文件工作。请在 Team 中新建对话。未发送模型请求。`);
  }
  if(!work?.execution)throw workspaceError("PROJECT_EXECUTION_REQUIRED","项目目录已准备。请在设置中配置项目执行环境后再发送。");
}

export async function inspectGuiProject(home, path, work = {}, { includeChanges = true } = {}) {
  const directory = inspectGuiDirectory(path);
  const unavailable = (reason, extra = {}) => ({
    ...directory, path: directory.canonicalPath, valid:false, executionReady:false,
    dirty:null, head:null, version:null, execution:null, checks:[], reason, error:reason, ...extra,
  });
  if (!directory.directoryAvailable) return unavailable(directory.reason);
  try {
    const repo = await inspectGuiPreparation(directory.canonicalPath, home);
    const {root,relativePath,head,preparation} = repo;
    const facts = {root,relativePath,head,preparation:preparation??null};
    if (!head || preparation) return unavailable("此目录需要先准备文件工作。",facts);
    const changes = includeChanges ? await inspectGuiGitChanges(repo) : null;
    let checks = work?.checks;
    if (checks === undefined) {
      try {
        const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
        checks = pkg.scripts?.test ? [{ command: "npm", args: ["test"] }] : [];
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
        checks = [];
      }
    }
    let version = head, execution = work?.execution ?? null, error = null;
    try {
      const v = await createVersioning({home,project:root,readOnly:true});
      try {
        const fact = await v.inspect();
        version = fact.version;
        execution = fact.execution;
      } finally { await v.close(); }
    } catch (e) {
      if (!["NO_PROJECT","ENOENT"].includes(e.code)) error=e.message;
    }
    return {
      ...directory,...facts,path:root,valid:true,executionReady:!error,
      dirty:changes?Object.values(changes).some(paths=>paths.length):null,
      changes,version,execution,checks,error,reason:error,
    };
  } catch (error) {
    return unavailable(error.message);
  }
}
export async function withGuiWork(home, record, fn) {
  const sources=record.deliveryRef?resolveDelivery(home,record):[];
  const selected=sources.findLast(s=>s.record.work?.version===record.deliveryRef.version);
  const work = record.deliveryRef ? (selected ? {...selected.record.work,startVersion:sources[0].record.work.startVersion} : null) : record.work;
  if (!work?.root) throw Error("任务没有已保存的工作项目。");
  const v = await createVersioning({
    home,
    project: work.root,
    readOnly: true,
    backend: work.backend,
    toolHome: work.toolHome,
  });
  try {
    return await fn(v, work);
  } finally {
    await v.close();
  }
}
export async function guiWorkVersions(v, w) {
  let from = w.startVersion,
    to = w.version;
  if (!from) throw Error("旧任务未记录可信起点，无法生成任务差异。");
  if (!w.resultWorkspace) {
    const receipts = await Promise.all(
    (w.acceptance ?? []).map((r) =>
      r.requestId ? v.inspect({ requestId: r.requestId }) : r,
    ),
    );
    to =
    receipts.findLast((r) => r.status === "accepted")?.acceptedVersion ??
    to;
  }
  if (!to) throw Error("任务未记录可信终点；未知接纳不自动重发。");
  return {fromVersion: from, toVersion: to};
}
export async function guiDiff(home, record) {
  return withGuiWork(home, record, async (v, w) => {
    const {fromVersion: from, toVersion: to} = await guiWorkVersions(v, w);
    const diff = await v.inspect({ fromVersion: from, toVersion: to });
    if (!Array.isArray(diff.files) || typeof (diff.text ?? diff.patch) !== "string")
      throw Object.assign(Error("旧任务不支持可信固定版本差异。"), {code:"FILE_UNSUPPORTED"});
    return {
      fromVersion: from,
      toVersion: to,
      files: diff.files,
      text: diff.text ?? diff.patch ?? "",
      binaryFiles: diff.binaryFiles ?? [],
    };
  });
}
export async function guiOutput(
  home,
  record,
  outputRef,
  offset = 0,
  limit = 65536,
) {
  if(record.deliveryRef){const source=resolveDelivery(home,record).find(s=>taskOutputRefs(s.record).includes(outputRef));if(!source)throw Error("outputRef 不属于此根任务的已核验交付。");return guiOutput(home,source.record,outputRef,offset,limit);}
  if (!taskOutputRefs(record).includes(outputRef))
    throw Error("outputRef 不属于此任务。");
  return withGuiWork(home, record, async (v) => {
    const page = await v.read({ outputRef, offset, limit });
    return {
      text: Buffer.from(page.contentBase64, "base64").toString("utf8"),
      nextOffset: page.nextOffset,
      eof: page.eof,
    };
  });
}
export async function revealGuiTask(record) {
  if (!record.work?.resultWorkspace) throw Error("任务尚无可信成果目录。");
  const path = realpathSync(record.work.resultWorkspace);
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "explorer.exe"
        : "xdg-open";
  await exec(command, [path]);
  return { path };
}

export function guiArtifact(home,record,ref,index) {
 if(typeof ref!=="string"||!Number.isSafeInteger(index)||index<0)throw Error("截图引用无效。");
 const evidence=record.work?.visualEvidence?.find(e=>e.outputRef===ref), image=evidence?.images?.[index];
 if(!image)throw Error("截图不属于此任务。");
 const expected=resolve(home,"artifacts",record.id,ref,`${index}.png`);
 const root=realpathSync(join(home,"artifacts")), taskRoot=realpathSync(join(root,record.id));
 const inside=(base,path)=>{const rel=relative(base,path);return rel&&!isAbsolute(rel)&&rel!==".."&&!rel.startsWith("../")&&!rel.startsWith("..\\");};
 if(!inside(root,taskRoot)||resolve(image.path)!==expected)throw Error("截图路径无效。");
 const path=realpathSync(image.path),info=lstatSync(image.path);
 if(!inside(taskRoot,path)||!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>4*1024*1024)throw Error("截图路径或大小无效。");
 const bytes=readFileSync(path);
 if(bytes.subarray(0,8).toString("hex")!=="89504e470d0a1a0a"||createHash("sha256").update(bytes).digest("hex")!==image.sha256)throw Error("截图类型或哈希不匹配。");
 return bytes;
}
