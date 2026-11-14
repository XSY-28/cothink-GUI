import {resolveDelivery,resolveDeliveryEvidence,resolveOwnedTasks} from "./project-delivery.js";
import {realpathSync,lstatSync,mkdirSync,mkdtempSync,writeFileSync,renameSync,rmSync} from "node:fs";
import {resolve,join,relative,isAbsolute,dirname,basename} from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {createVersioning,inScope} from "./versioning.js";
import {taskOutputRefs} from "./gui-projection.js";
import {readTask} from "./task.js";
import {FILE_LIMITS,snapshot,readFixedBlob,regular,reject,validateFilePath} from "./gui-file-content.js";
const exec=promisify(execFile);

export async function withGuiWork(home, record, fn) {
  const delivery=resolveDeliveryEvidence(home,record);
  const sources=delivery?.sources??[];
  const selected=sources.findLast(s=>s.record.work?.version===record.deliveryRef.version);
  const work = delivery ? (selected ? {...selected.record.work,startVersion:delivery.startVersion} : null) : record.work;
  if (!work?.root) throw Error("任务没有已保存的工作项目。");
  const v = await createVersioning({
    home,
    project: work.root,
    readOnly: true,
    backend: work.backend,
    toolHome: work.toolHome,
  });
  try {
    return await fn(v, work, delivery);
  } finally {
    await v.close();
  }
}
export async function guiWorkVersions(v, w) {
  let from = w.startVersion,
    to = w.version, accepted = null;
  if (!from) throw Error("旧任务未记录可信起点，无法生成任务差异。");
  if (!w.resultWorkspace) {
    for (const saved of (w.acceptance ?? []).toReversed()) {
      if (!saved.requestId) continue;
      const receipt = await v.inspect({requestId:saved.requestId});
      if (receipt.status === "accepted" && receipt.acceptedVersion &&
          (!saved.acceptedVersion || receipt.acceptedVersion === saved.acceptedVersion)) {
        accepted = receipt.acceptedVersion;
        break;
      }
    }
    to = accepted ?? to;
  }
  if (!to) throw Error("任务未记录可信终点；未知接纳不自动重发。");
  return {fromVersion: from, toVersion: to, accepted};
}
export async function guiDiff(home, record) {
  return withGuiWork(home, record, async (v, w) => {
    const {fromVersion: from, toVersion: to, accepted} = await guiWorkVersions(v, w);
    if (record.project && !w.resultWorkspace && !accepted)
      throw Object.assign(Error("没有已接纳的固定版本，不能生成成果补丁。"),{code:"FILE_UNAVAILABLE"});
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
  const ownOutput=taskOutputRefs(record).includes(outputRef);
  if(record.deliveryRef&&!ownOutput){const source=resolveDelivery(home,record).find(s=>taskOutputRefs(s.record).includes(outputRef));if(!source)throw Error("outputRef 不属于此根任务的已核验交付。");return guiOutput(home,source.record,outputRef,offset,limit);}
  if (!ownOutput)
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
export async function guiResultWorkspace(v, work, version) {
  if (!work.resultWorkspace || !work.resultChangeId)
    throw Object.assign(Error("此任务没有可核验的成果目录。"),{code:"FILE_UNAVAILABLE"});
  const result=await v.inspect({changeId:work.resultChangeId});
  if(result.readOnly!==true || result.baseVersion!==version || typeof result.workspace!=="string" || resolve(result.workspace)!==resolve(work.resultWorkspace))
    throw Object.assign(Error("成果目录与任务固定版本不匹配，已拒绝读取。"),{code:"FILE_IDENTITY_MISMATCH"});
  try {
    const info=lstatSync(work.resultWorkspace),path=realpathSync(work.resultWorkspace);
    const local=v.toolHome?relative(resolve(v.toolHome),resolve(work.resultWorkspace)):null;
    if(!info.isDirectory() || info.isSymbolicLink() || local!==null&&
      (!local||local===".."||local.startsWith("../")||local.startsWith("..\\")||isAbsolute(local)||path!==resolve(realpathSync(v.toolHome),local)))
      throw Object.assign(Error("成果目录包含链接或不是目录。"),{code:"FILE_PATH_INVALID"});
    return path;
  } catch(error) {
    if(error.code?.startsWith("FILE_"))throw error;
    throw Object.assign(Error("成果目录已不存在或不可读取。"),{code:"FILE_UNAVAILABLE"});
  }
}
export async function revealGuiTask(home, record) {
  const path = await withGuiWork(home,record,async(v,w)=>{
    const {toVersion}=await guiWorkVersions(v,w);
    return guiResultWorkspace(v,w,toVersion);
  });
  return revealGuiDirectory(path);
}
export async function revealGuiDirectory(path) {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "explorer.exe"
        : "xdg-open";
  await exec(command, [path]);
  return { path };
}


function draftChanges(record) {
  return (record.work?.changes??[]).filter(change=>!change.readOnly &&
    (change.actor==='main'||(record.members??[]).some(member=>member.changeId===change.changeId&&member.collected)));
}
function draftPaths(record,change) {
  const visible=[...(change.scope??[]),...(change.readScope??[])];
  const original=record.project?[...(record.project.scope??[]),...(record.project.readScope??[])]:visible;
  return path=>inScope(path,visible)&&inScope(path,original);
}
async function resolveDraft(v,home,record,changeId) {
  if(record.rootTaskId) {
    const root=readTask(home,record.rootTaskId);
    if(!resolveOwnedTasks(home,root,()=>{}).some(child=>child.id===record.id))
      reject('FILE_VERSION_MISMATCH','草稿不属于当前任务的已核验执行。');
  }
  const saved=draftChanges(record).find(change=>change.changeId===changeId);
  if(!saved)return null;
  const fact=await v.inspect({changeId});
  if(fact.changeId!==saved.changeId||fact.actor!==saved.actor||fact.baseVersion!==saved.baseVersion||fact.readOnly)
    reject('FILE_VERSION_MISMATCH','草稿来源或起点与保存的任务不一致。');
  if(fact.status==='accepted')return null;
  if(!saved.privateVersion||!saved.baseVersion)return null;
  // The saved version is authoritative even if another writer has since changed its projection.
  await v.read({version:saved.privateVersion,path:'.',kind:'tree'});
  return {taskId:record.id,changeId,baseVersion:saved.baseVersion,version:saved.privateVersion};
}
export async function resolveTaskDraft({home,record,changeId}) {
  return withGuiWork(home,record,v=>resolveDraft(v,home,record,changeId));
}
export async function withGuiFileWork(home,record,ref,fn) {
  if(!ref?.draft)return withGuiWork(home,record,fn);
  if(ref.taskId!==record.id)reject('FILE_VERSION_MISMATCH','草稿引用不属于此任务。');
  return withGuiWork(home,record,async(v,w)=>{
    const draft=await resolveDraft(v,home,record,ref.draft.changeId);
    if(!draft||draft.version!==ref.version||draft.baseVersion!==ref.draft.baseVersion)
      reject('FILE_VERSION_MISMATCH','草稿引用与已保存的固定版本不一致。');
    const change=draftChanges(record).find(c=>c.changeId===draft.changeId);
    return fn(v,{...w,startVersion:draft.baseVersion,version:draft.version},null,{draft,allows:draftPaths(record,change)});
  });
}
export async function exportTaskDraft({home,record,draft}) {
  if(!draft||draft.taskId!==record.id)reject('FILE_VERSION_MISMATCH','草稿引用不属于此任务。');
  const ref={taskId:draft.taskId,version:draft.version,draft:{changeId:draft.changeId,baseVersion:draft.baseVersion}};
  return withGuiFileWork(home,record,ref,async(v,w,_,source)=>{
    const s=await snapshot(v,w,{fromVersion:draft.baseVersion,toVersion:draft.version,accepted:null});
    const parent=join(realpathSync(home),'artifacts',record.id),warnings=['未验收草稿：仅导出原任务授权读取范围内的固定版本文件；未确认测试通过或依赖完整。'];
    mkdirSync(parent,{recursive:true,mode:0o700});
    if(realpathSync(parent)!==resolve(parent))reject('FILE_PATH_INVALID','草稿导出目录包含链接。');
    const temporary=mkdtempSync(join(parent,'.draft-')),directory=join(parent,basename(temporary).replace(/^\.draft-/,'draft-')),paths=[];
    try {
      for(const [path,entry] of s.after) {
        if(!source.allows(path))continue;
        try {
          validateFilePath(path);
          if(!regular(entry))reject('FILE_UNSUPPORTED','仅导出普通文件。');
          const bytes=await readFixedBlob(v.root,path,entry,FILE_LIMITS.downloadBytes);
          const target=join(temporary,path);mkdirSync(dirname(target),{recursive:true,mode:0o700});
          writeFileSync(target,bytes,{flag:'wx',mode:entry.mode==='100755'?0o700:0o600});paths.push(path);
        } catch(error) {warnings.push(`${path}：${error.message}`);}
      }
      for(const path of record.project?.deliverables??[])
        if(!paths.includes(path))warnings.push(`${path}：声明的交付文件未能导出。`);
      renameSync(temporary,directory);
      return {directory,version:draft.version,paths,warnings};
    } catch(error) {rmSync(temporary,{recursive:true,force:true});throw error;}
  });
}
