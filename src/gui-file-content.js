import {createHash} from 'node:crypto';
import {constants, lstatSync, realpathSync, openSync, closeSync, fstatSync, readSync} from 'node:fs';
import {join, resolve, relative, isAbsolute, posix, extname} from 'node:path';
import { guiWorkVersions } from './gui-work.js';
import {git} from '../packages/agent-sync/src/git.js';

export const FILE_LIMITS = Object.freeze({textBytes:1048576, previewBytes:8388608, downloadBytes:33554432, resources:64, depth:4, derivedBytes:16777216});
export const fileError = (code, message) => Object.assign(Error(message), {code});
export const reject = (code, message) => { throw fileError(code, message); };
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const unsupported = message => reject('STATIC_PREVIEW_UNSUPPORTED', message + ' 请查看源码、已保存截图或下载原文件。');
export function validateFilePath(path) {
  if (typeof path !== 'string' || !path || path !== path.normalize('NFC') || /[\\\x00-\x1f\x7f:]/.test(path) || posix.isAbsolute(path) ||
      path.split('/').some(s => !s || s === '.' || s === '..' || /[. ]$/.test(s) || /^\.git(?:$|~)/i.test(s) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)))
    reject('FILE_PATH_INVALID', '文件路径不符合受限的项目相对路径规则。');
  return path;
}
const formats = {
  '.md':['text/markdown','markdown'], '.markdown':['text/markdown','markdown'],
  '.html':['text/html','static'], '.htm':['text/html','static'], '.svg':['image/svg+xml','static'],
  '.png':['image/png','image'], '.jpg':['image/jpeg','image'], '.jpeg':['image/jpeg','image'], '.gif':['image/gif','image'], '.webp':['image/webp','image'],
};
const textExtensions = new Set('.txt .js .jsx .ts .tsx .mjs .cjs .json .css .csv .tsv .xml .yml .yaml .toml .ini .sh .py .rb .rs .go .c .h .cpp .java .sql .tex .log .diff .patch'.split(' '));
export function format(path) {
  const ext = extname(path).toLowerCase();
  const [mediaType, previewKind] = formats[ext] ?? (textExtensions.has(ext) || !ext ? ['text/plain','text'] : ['application/octet-stream','unsupported']);
  return {mediaType, previewKind};
}
function treeMap(tree, version) {
  if (tree?.version !== version || !Array.isArray(tree.entries)) reject('FILE_UNSUPPORTED', '当前任务缺少可信固定版本文件清单。');
  const result = new Map();
  for (const e of tree.entries) {
    validateFilePath(e.path);
    if (result.has(e.path) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(e.object) || !/^\d{6}$/.test(e.mode)) reject('FILE_IDENTITY_MISMATCH', '固定版本文件身份无效。');
    result.set(e.path, e);
  }
  return result;
}
export async function snapshot(v, work, versions) {
  if (typeof v.read !== 'function') reject('FILE_UNSUPPORTED', '旧任务不支持固定版本文件读取；可保留已有截图或差异。');
  versions ??= await guiWorkVersions(v, work);
  const [before, after] = await Promise.all([v.read({version:versions.fromVersion,path:'.',kind:'tree'}),v.read({version:versions.toVersion,path:'.',kind:'tree'})]);
  return {...versions, before:treeMap(before,versions.fromVersion), after:treeMap(after,versions.toVersion)};
}
export function changed(s) {
  return [...new Set([...s.before.keys(),...s.after.keys()])].sort().filter(p => {
    const a=s.before.get(p), b=s.after.get(p); return a?.object !== b?.object || a?.mode !== b?.mode;
  });
}
export const statusOf = (a,b) => !a ? 'added' : !b ? 'deleted' : a.object !== b.object ? 'modified' : a.mode !== b.mode ? 'modeChanged' : 'unchanged';
function checkedPath(root, path) {
  // Inspect every absolute root ancestor as well as the project-relative descendants.
  let current = resolve(root), ancestors=[];
  while (true) {ancestors.push(current); const parent=resolve(current,'..'); if(parent===current)break; current=parent;}
  for (const p of ancestors.reverse()) {const s=lstatSync(p); if(s.isSymbolicLink() || !s.isDirectory()) reject('FILE_PATH_INVALID','成果目录包含链接或不是目录。');}
  const base=realpathSync(root); current=base;
  const parts=path.split('/');
  for (let i=0;i<parts.length;i++) {current=join(current,parts[i]);const s=lstatSync(current); if(s.isSymbolicLink() || (i<parts.length-1&&!s.isDirectory()) || (i===parts.length-1&&(!s.isFile()||s.nlink!==1)))reject('FILE_PATH_INVALID','成果路径必须是无链接目录内的普通单链接文件。');}
  const real=realpathSync(current), rel=relative(base,real);
  if(!rel || isAbsolute(rel) || rel==='..' || rel.startsWith('../') || rel.startsWith('..\\'))reject('FILE_PATH_INVALID','成果路径超出授权目录。');
  return current;
}
function sameStat(a,b) {return ['dev','ino','size','mtimeMs','ctimeMs','nlink','mode'].every(k=>a[k]===b[k]);}
export const regular = entry => entry && ['100644','100755'].includes(entry.mode);
function verifyBlob(bytes, entry) {
  const algorithm=entry.object.length===40?'sha1':'sha256';
  const oid=createHash(algorithm).update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
  if(oid!==entry.object)reject('FILE_IDENTITY_MISMATCH','成果内容与任务固定版本不一致，已拒绝返回。');
  return bytes;
}
export async function readAcceptedBlob(repo, path, entry, limit) {
  validateFilePath(path);
  if(!regular(entry))reject('FILE_UNSUPPORTED','该路径不是固定版本中的普通文件。');
  // Agent-sync's version tree gives the exact immutable object. Preflight its size before reading bytes.
  const object=async args=>git(repo,['cat-file',...args,entry.object],undefined,{GIT_NO_LAZY_FETCH:'1'});
  try {
    const size=Number((await object(['-s'])).toString().trim());
    if(!Number.isSafeInteger(size)||size<0)reject('FILE_UNAVAILABLE','无法核对接纳文件的大小。');
    if(size>limit)reject('FILE_TOO_LARGE',`文件超出本次读取的 ${limit} 字节额度。`);
    const bytes=await object(['blob']);
    if(bytes.length!==size)reject('FILE_IDENTITY_MISMATCH','固定文件对象与核验大小不一致。');
    return verifyBlob(bytes,entry);
  } catch(error) {
    if(error.code?.startsWith('FILE_'))throw error;
    reject('FILE_UNAVAILABLE','无法读取已接纳版本的文件对象。');
  }
}
export function readBounded(root, path, entry, limit) {
  validateFilePath(path);
  if (!regular(entry)) reject('FILE_UNSUPPORTED','该路径不是固定版本中的普通文件。');
  let fd;
  try {
    const target=checkedPath(root,path);
    // A raced replacement with a FIFO must not block before fstat can reject it.
    fd=openSync(target,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
    const before=fstatSync(fd);
    if(!before.isFile() || before.nlink!==1)reject('FILE_PATH_INVALID','仅允许普通单链接文件；硬链接不作为可信成果读取。');
    if(before.size>limit)reject('FILE_TOO_LARGE',`文件超出本次读取的 ${limit} 字节额度，请打开成果目录。`);
    const out=Buffer.alloc(Math.min(before.size,limit)+1); let n=0;
    while(n<out.length){const k=readSync(fd,out,n,out.length-n,null);if(!k)break;n+=k;}
    if(n>limit)reject('FILE_TOO_LARGE','文件读取超过额度，请打开成果目录。');
    const after=fstatSync(fd), pathAfter=lstatSync(checkedPath(root,path));
    if(n!==before.size || !sameStat(before,after) || !sameStat(after,pathAfter))reject('FILE_IDENTITY_MISMATCH','成果在读取期间发生变化，已拒绝返回。');
    return verifyBlob(out.subarray(0,n),entry);
  } catch(e) {if(e.code?.startsWith('FILE_'))throw e; reject('FILE_UNAVAILABLE','成果文件不存在或无法安全读取；不会改读当前工作目录。');}
  finally {if(fd!==undefined)closeSync(fd);}
}
export function text(bytes) {try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{reject('FILE_ENCODING_UNSUPPORTED','当前文本编码无法可靠显示，请下载原文件。');}}
export function raster(bytes, mime) {
  const valid = mime==='image/png' ? bytes.subarray(0,8).toString('hex')==='89504e470d0a1a0a' :
    mime==='image/jpeg' ? bytes[0]===255&&bytes[1]===216&&bytes[2]===255 :
    mime==='image/gif' ? ['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString()) :
    mime==='image/webp' ? bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP' : false;
  if(!valid)reject('FILE_TYPE_MISMATCH','图片字节与声明格式不一致，已拒绝预览。');
}
