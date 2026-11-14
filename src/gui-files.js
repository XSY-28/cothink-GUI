import {resolveOwnedTasks} from "./project-delivery.js";
import { posix } from 'node:path';
import {withGuiWork, guiWorkVersions, guiResultWorkspace,resolveTaskDraft,withGuiFileWork} from './gui-work.js';
import {inScope} from './versioning.js';
import { FILE_LIMITS, changed, format, raster, readFixedBlob, readBounded, regular, reject, sha256, snapshot, statusOf, text, unsupported, validateFilePath } from "./gui-file-content.js";
import { staticPreview } from "./gui-file-preview.js";
export { FILE_LIMITS, fileError, validateFilePath } from "./gui-file-content.js";

// Git's quoted names use C escapes and UTF-8 octets. Raw names may contain spaces.
function gitPath(raw) {
  if(!raw.startsWith('"'))return raw;
  if(!raw.endsWith('"'))throw Error('quoted path');
  const bytes=[]; const body=raw.slice(1,-1);
  for(let i=0;i<body.length;i++){
    if(body[i]!=='\\'){const cp=body.codePointAt(i);bytes.push(...Buffer.from(String.fromCodePoint(cp)));if(cp>65535)i++;continue;}
    const c=body[++i], escaped={'a':7,'b':8,'t':9,'n':10,'v':11,'f':12,'r':13,'"':34,'\\':92};
    if(/[0-7]/.test(c??'')){let oct=c;while(oct.length<3&&/[0-7]/.test(body[i+1]??''))oct+=body[++i]; const value=parseInt(oct,8);if(value>255)throw Error('octal');bytes.push(value);}
    else if(Object.hasOwn(escaped,c))bytes.push(escaped[c]);else throw Error('escape');
  }
  return text(Buffer.from(bytes));
}
function patchPath(header, paths) {
  const matches=[];
  for(let i=0;i<header.length;i++)if(header[i]===' '){
    try {const a=gitPath(header.slice(0,i)),b=gitPath(header.slice(i+1));if(a.startsWith('a/')&&b===`b/${a.slice(2)}`&&paths.has(a.slice(2)))matches.push(a.slice(2));}catch{/* other split */}
  }
  if(matches.length!==1)throw Error('ambiguous path');return matches[0];
}
export function splitFileDiff(diff, s) {
  try {
    const paths=new Set(changed(s));
    if(!Array.isArray(diff.files)||diff.files.length!==paths.size||new Set(diff.files).size!==paths.size||diff.files.some(p=>!paths.has(p))||typeof diff.text!=='string')throw Error('paths');
    const blocks=diff.text ? diff.text.split(/(?=^diff --git )/m) : [];
    const result=new Map();
    for(const block of blocks){
      const lines=block.split('\n'); if(!lines[0].startsWith('diff --git '))throw Error('header');
      const path=patchPath(lines[0].slice(11),paths); if(result.has(path))throw Error('duplicate');
      const before=s.before.get(path)??null,after=s.after.get(path)??null;
      const metadata=lines.slice(1,lines.findIndex((l,i)=>i>0&&(l.startsWith('@@')||l==='GIT binary patch'))===-1?lines.length:lines.findIndex((l,i)=>i>0&&(l.startsWith('@@')||l==='GIT binary patch')));
      for(const line of metadata){
        if(line.startsWith('new file mode ')&& (before||line.slice(14)!==after?.mode))throw Error('new mode');
        if(line.startsWith('deleted file mode ')&& (after||line.slice(18)!==before?.mode))throw Error('deleted mode');
        if(line.startsWith('old mode ')&&line.slice(9)!==before?.mode)throw Error('old mode');
        if(line.startsWith('new mode ')&&line.slice(9)!==after?.mode)throw Error('mode');
        if(line.startsWith('--- ')||line.startsWith('+++ ')){
          const old=line.startsWith('--- '),p=gitPath(line.slice(4).replace(/\t$/,''));
          if(p!==((old?before:after)?`${old?'a':'b'}/${path}`:'/dev/null'))throw Error('marker');
        }
      }
      if(!before&&!metadata.includes(`new file mode ${after.mode}`))throw Error('missing new mode');
      if(!after&&!metadata.includes(`deleted file mode ${before.mode}`))throw Error('missing delete mode');
      if(before&&after&&before.mode!==after.mode&&(!metadata.includes(`old mode ${before.mode}`)||!metadata.includes(`new mode ${after.mode}`)))throw Error('missing mode');
      result.set(path,{path,fromVersion:s.fromVersion,toVersion:s.toVersion,before,after,status:statusOf(before,after),binary:diff.binaryFiles?.includes(path)??false,patch:block});
    }
    if(result.size!==paths.size)throw Error('incomplete');
    return {items:[...result.values()],warning:null};
  }catch{return {items:[],warning:'该差异暂无法可靠按文件拆分，请下载完整补丁。'};}
}
export async function guiFiles(home, record) {
  if(record.flow==='unified'&&!record.deliveryRef)return guiPartialFiles(home,record);
  try {
    const result=await guiWorkFiles(home,record);
    if(record.deliveryRef)return result;
    const drafts=await guiDraftFiles(home,record);
    return {...result,items:[...result.items,...drafts.items],warnings:[...result.warnings,...drafts.warnings]};
  }
  catch(error) {
    if(record.flow!=='unified')throw error;
    return guiPartialFiles(home,record,'正式交付来源尚不能核验：'+error.message);
  }
}
async function guiPartialFiles(home,record,reason) {
  const items=[],warnings=reason?[reason]:[];
  let children=[];
  const addError=error=>warnings.push('执行来源尚不能核验：'+error.message);
  try {children=resolveOwnedTasks(home,record,addError);}
  catch(error){addError(error);}
  for(const child of children.filter(c=>c.work?.root)){
    try{
      const list=await guiFiles(home,child);
      items.push(...list.items.map(item=>({...item,patchTaskId:list.patchTaskId,revealTaskId:list.revealTaskId})));
      warnings.push(...list.warnings);
    }catch(error){warnings.push(error.message);}
  }
  if(items.length)warnings.unshift('项目整体验收尚未完成；已接纳文件与未验收草稿分别标记。');
  return {taskId:record.id,fromVersion:null,toVersion:null,items,limits:FILE_LIMITS,warnings:[...new Set(warnings)]};
}
async function guiDraftFiles(home,record) {
  const items=[],warnings=[];
  for(const change of record.work?.changes??[]) {
    try {
      const draft=await resolveTaskDraft({home,record,changeId:change.changeId});
      if(!draft)continue;
      const ref={taskId:record.id,version:draft.version,draft:{changeId:draft.changeId,baseVersion:draft.baseVersion}};
      await withGuiFileWork(home,record,ref,async(v,w,_,source)=>{
        const s=await snapshot(v,w,{fromVersion:draft.baseVersion,toVersion:draft.version,accepted:null});
        for(const path of changed(s).filter(source.allows))items.push({
          ref:{...ref,path},name:path,status:statusOf(s.before.get(path),s.after.get(path)),...format(path),
          readable:!!regular(s.after.get(path)),source:change.actor,unverified:true,
        });
      });
    }catch(error){warnings.push(`草稿 ${change.changeId}：${error.message}`);}
  }
  if(items.length)warnings.unshift('未验收草稿来自已保存的固定版本；尚未确认接纳、测试或完整可运行。');
  return {items,warnings};
}
async function guiWorkFiles(home,record) {
  return withGuiWork(home,record,async(v,w,delivery)=>{
    const versions=await guiWorkVersions(v,w);
    if(record.project&&!w.resultWorkspace&&!versions.accepted)
      return {taskId:record.id,fromVersion:null,toVersion:null,items:[],limits:FILE_LIMITS,warnings:[]};
    const s=await snapshot(v,w,versions);
    const warnings=[];
    let workspace=null;
    if(w.resultWorkspace) {
      try {workspace=await guiResultWorkspace(v,w,s.toVersion);}
      catch(error){warnings.push(error.message);}
    }
    const readable=!!workspace||!!s.accepted;
    if(delivery){
      for(const [path,hash] of delivery.artifacts){
        const entry=s.after.get(path);
        if(!regular(entry))reject('DELIVERY_ARTIFACT',`正式版本缺少可核验的成果文件：${path}`);
        // The persisted delivery check attests all artifacts, including files over the UI byte cap.
        // Small files can also be checked before making them clickable.
        if(workspace)try{
          if(sha256(readBounded(workspace,path,entry,FILE_LIMITS.downloadBytes))!==hash)
            reject('DELIVERY_ARTIFACT',`文件内容与正式交付记录不一致：${path}`);
        }catch(error){if(error.code!=='FILE_TOO_LARGE')throw error;}
      }
    }
    if(!readable&&!warnings.length)warnings.push('此任务没有可核验的成果目录，文件仅可查看已有差异与截图。');
    const changedPaths=changed(s);
    const item=path=>({ref:{taskId:record.id,version:s.toVersion,path},name:path,status:statusOf(s.before.get(path),s.after.get(path)),...format(path),readable:readable&&!!regular(s.after.get(path))});
    const changes=changedPaths.map(item);
    const placement=record.deliveryPlacement?.version===s.toVersion?record.deliveryPlacement:null;
    return {taskId:record.id,fromVersion:s.fromVersion,toVersion:s.toVersion,limits:FILE_LIMITS,
      items:delivery?[...delivery.artifacts.keys()].map(item):changes,
      ...(delivery&&{changes}),
      patchTaskId:changes.length?record.id:null,revealTaskId:workspace?record.id:null,placement,
      resultWorkspace:workspace,checks:delivery?.checks??null,warnings};
  });
}
export async function guiFileDiff(home,record,ref) {
  return withGuiFileWork(home,record,ref,async(v,w,_,source)=>{
    const s=await snapshot(v,w,source?{fromVersion:source.draft.baseVersion,toVersion:source.draft.version,accepted:null}:undefined);validateRef(record,ref,s);
    if(source&&!source.allows(ref.path))reject('FILE_NOT_FOUND','文件不在原草稿授权范围内。');
    if(!source&&record.project&&!w.resultWorkspace&&!s.accepted)reject('FILE_UNAVAILABLE','此任务尚无已接纳的文件版本。');
    const diff=await v.inspect({fromVersion:s.fromVersion,toVersion:s.toVersion});
    const split=splitFileDiff(diff,s);
    if(split.warning)reject('FILE_DIFF_UNSUPPORTED',split.warning);
    return split.items.find(e=>e.path===ref.path);
  });
}
function validateRef(record,ref,s,artifacts) {
  if(!ref||ref.taskId!==record.id||ref.version!==s.toVersion)reject('FILE_VERSION_MISMATCH','文件引用不属于此任务的固定终点版本。');
  validateFilePath(ref.path);
  if(!artifacts?.has(ref.path)&&!changed(s).includes(ref.path))reject('FILE_NOT_FOUND','文件不属于此任务的成果或变更清单。');
}
export async function guiFile(home, record, ref, {purpose='source'}={}) {
  if(!['source','preview','download'].includes(purpose))reject('FILE_PURPOSE_INVALID','文件读取用途无效。');
  return withGuiFileWork(home,record,ref,async(v,w,delivery,source)=>{
    const s=await snapshot(v,w,source?{fromVersion:source.draft.baseVersion,toVersion:source.draft.version,accepted:null}:undefined);validateRef(record,ref,s,delivery?.artifacts);
    if(source&&!source.allows(ref.path))reject('FILE_NOT_FOUND','文件不在原草稿授权范围内。');
    const entry=s.after.get(ref.path);if(!entry)reject('FILE_DELETED','文件在此版本已删除，仅能查看差异。');
    const workspace=s.accepted||source?null:await guiResultWorkspace(v,w,s.toVersion),type=format(ref.path);
    const read=(path,file,limit)=>{
      if(!s.accepted&&!source)return readBounded(workspace,path,file,limit);
      if(source&&!source.allows(path))unsupported('预览资源不在该草稿的读取范围内');
      if(!source&&path!==ref.path&&!inScope(path,[...(record.project?.scope??[]),...(record.project?.readScope??[])]))
        unsupported('预览资源不在该次执行的读取范围内');
      return readFixedBlob(v.root,path,file,limit);
    };
    if(purpose==='preview'&&type.previewKind==='unsupported')reject('FILE_PREVIEW_UNSUPPORTED','此格式暂不支持内嵌预览，请下载原文件或打开成果目录。');
    const max=purpose==='download'?FILE_LIMITS.downloadBytes:purpose==='preview'&&type.previewKind==='image'?FILE_LIMITS.previewBytes:FILE_LIMITS.textBytes;
    let bytes=await read(ref.path,entry,max), representation='original',sourceContentHash=sha256(bytes),warnings=[];
    if(delivery?.artifacts.has(ref.path)&&delivery.artifacts.get(ref.path)!==sourceContentHash)
      reject('DELIVERY_ARTIFACT','文件内容与正式交付记录不一致。');
    if(purpose!=='download') {
      if(type.previewKind==='image'&&purpose==='preview')raster(bytes,type.mediaType);
      else text(bytes);
      if(type.previewKind==='static'&&purpose==='preview') {bytes=await staticPreview(read,ref.path,bytes,s.after);representation='static-preview';warnings=['静态预览：脚本、表单、导航和外部资源均未运行。'];}
    }
    return {bytes,representation,filename:posix.basename(ref.path),version:s.toVersion,contentHash:sha256(bytes),sourceContentHash,warnings,
      mediaType:representation==='static-preview'?'text/html; charset=utf-8':purpose==='source'?'text/plain; charset=utf-8':type.mediaType};
  });
}
