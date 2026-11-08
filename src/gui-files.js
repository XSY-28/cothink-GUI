/** Task-owned file reading. Public trees authorize identities; bounded local reads prove bytes.
 * No current-checkout fallback, executable preview, or independent asset store. */
import {createHash} from 'node:crypto';
import {constants, lstatSync, realpathSync, openSync, closeSync, fstatSync, readSync} from 'node:fs';
import {join, resolve, relative, isAbsolute, posix, extname} from 'node:path';
import {parse, serialize} from 'parse5';
import {withGuiWork, guiWorkVersions} from './gui-work.js';

export const FILE_LIMITS = Object.freeze({textBytes:1048576, previewBytes:8388608, downloadBytes:33554432, resources:64, depth:4, derivedBytes:16777216});
export const fileError = (code, message) => Object.assign(Error(message), {code});
const reject = (code, message) => { throw fileError(code, message); };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const unsupported = message => reject('STATIC_PREVIEW_UNSUPPORTED', message + ' 请查看源码、已保存截图或下载原文件。');
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
function format(path) {
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
async function snapshot(v, work) {
  if (typeof v.read !== 'function') reject('FILE_UNSUPPORTED', '旧任务不支持固定版本文件读取；可保留已有截图或差异。');
  const versions = await guiWorkVersions(v, work);
  const [before, after] = await Promise.all([v.read({version:versions.fromVersion,path:'.',kind:'tree'}),v.read({version:versions.toVersion,path:'.',kind:'tree'})]);
  return {...versions, before:treeMap(before,versions.fromVersion), after:treeMap(after,versions.toVersion)};
}
function changed(s) {
  return [...new Set([...s.before.keys(),...s.after.keys()])].sort().filter(p => {
    const a=s.before.get(p), b=s.after.get(p); return a?.object !== b?.object || a?.mode !== b?.mode;
  });
}
const statusOf = (a,b) => !a ? 'added' : !b ? 'deleted' : a.object !== b.object ? 'modified' : 'modeChanged';
async function trustedRoot(v, work, version) {
  if (!work.resultWorkspace || !work.resultChangeId) reject('FILE_UNAVAILABLE', '此任务没有可核验的成果目录，不能读取或下载；已有差异与截图仍可查看。');
  const result = await v.inspect({changeId:work.resultChangeId});
  if (result.readOnly !== true || result.baseVersion !== version || typeof result.workspace !== 'string' || resolve(result.workspace) !== resolve(work.resultWorkspace))
    reject('FILE_IDENTITY_MISMATCH', '成果目录与任务固定版本不匹配，已拒绝读取。');
  try {
    if(lstatSync(work.resultWorkspace).isSymbolicLink())reject("FILE_PATH_INVALID","成果根目录不能是符号链接。");
    return realpathSync(work.resultWorkspace);
  } catch(e) {if(e.code?.startsWith("FILE_"))throw e;reject("FILE_UNAVAILABLE","成果目录已不存在或不可读取。");}
}
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
function readBounded(root, path, entry, limit) {
  validateFilePath(path);
  if (!entry || !['100644','100755'].includes(entry.mode)) reject('FILE_UNSUPPORTED','该路径不是固定版本中的普通文件。');
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
    const bytes=out.subarray(0,n), algorithm=entry.object.length===40?'sha1':'sha256';
    const oid=createHash(algorithm).update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
    if(oid!==entry.object)reject('FILE_IDENTITY_MISMATCH','成果内容与任务固定版本不一致，已拒绝返回。');
    return bytes;
  } catch(e) {if(e.code?.startsWith('FILE_'))throw e; reject('FILE_UNAVAILABLE','成果文件不存在或无法安全读取；不会改读当前工作目录。');}
  finally {if(fd!==undefined)closeSync(fd);}
}
function text(bytes) {try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{reject('FILE_ENCODING_UNSUPPORTED','当前文本编码无法可靠显示，请下载原文件。');}}
function raster(bytes, mime) {
  const valid = mime==='image/png' ? bytes.subarray(0,8).toString('hex')==='89504e470d0a1a0a' :
    mime==='image/jpeg' ? bytes[0]===255&&bytes[1]===216&&bytes[2]===255 :
    mime==='image/gif' ? ['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString()) :
    mime==='image/webp' ? bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP' : false;
  if(!valid)reject('FILE_TYPE_MISMATCH','图片字节与声明格式不一致，已拒绝预览。');
}

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
  return withGuiWork(home,record,async(v,w)=>{
    const s=await snapshot(v,w);
    const readable=!!w.resultWorkspace&&!!w.resultChangeId;
    return {taskId:record.id,fromVersion:s.fromVersion,toVersion:s.toVersion,limits:FILE_LIMITS,
      items:changed(s).map(path=>({ref:{taskId:record.id,version:s.toVersion,path},name:path,status:statusOf(s.before.get(path),s.after.get(path)),...format(path),readable:readable&&!!s.after.get(path)&&['100644','100755'].includes(s.after.get(path).mode)})),
      warnings:readable?[]:['此任务没有可核验的成果目录，文件仅可查看已有差异与截图。']};
  });
}
export async function guiFileDiff(home,record,ref) {
  return withGuiWork(home,record,async(v,w)=>{
    const s=await snapshot(v,w);validateRef(record,ref,s);
    const diff=await v.inspect({fromVersion:s.fromVersion,toVersion:s.toVersion});
    const split=splitFileDiff(diff,s);
    if(split.warning)reject('FILE_DIFF_UNSUPPORTED',split.warning);
    return split.items.find(e=>e.path===ref.path);
  });
}
function validateRef(record,ref,s) {
  if(!ref||ref.taskId!==record.id||ref.version!==s.toVersion)reject('FILE_VERSION_MISMATCH','文件引用不属于此任务的固定终点版本。');
  validateFilePath(ref.path);
  if(!changed(s).includes(ref.path))reject('FILE_NOT_FOUND','文件不属于此任务的变更清单。');
}
export async function guiFile(home, record, ref, {purpose='source'}={}) {
  if(!['source','preview','download'].includes(purpose))reject('FILE_PURPOSE_INVALID','文件读取用途无效。');
  return withGuiWork(home,record,async(v,w)=>{
    const s=await snapshot(v,w);validateRef(record,ref,s);
    const entry=s.after.get(ref.path);if(!entry)reject('FILE_DELETED','文件在此版本已删除，仅能查看差异。');
    const root=await trustedRoot(v,w,s.toVersion),type=format(ref.path);
    if(purpose==='preview'&&type.previewKind==='unsupported')reject('FILE_PREVIEW_UNSUPPORTED','此格式暂不支持内嵌预览，请下载原文件或打开成果目录。');
    const max=purpose==='download'?FILE_LIMITS.downloadBytes:purpose==='preview'&&type.previewKind==='image'?FILE_LIMITS.previewBytes:FILE_LIMITS.textBytes;
    let bytes=readBounded(root,ref.path,entry,max), representation='original',sourceContentHash=sha256(bytes),warnings=[];
    if(purpose!=='download') {
      if(type.previewKind==='image'&&purpose==='preview')raster(bytes,type.mediaType);
      else text(bytes);
      if(type.previewKind==='static'&&purpose==='preview') {bytes=staticPreview(root,ref.path,bytes,s.after);representation='static-preview';warnings=['静态预览：脚本、表单、导航和外部资源均未运行。'];}
    }
    return {bytes,representation,filename:posix.basename(ref.path),version:s.toVersion,contentHash:sha256(bytes),sourceContentHash,warnings,
      mediaType:representation==='static-preview'?'text/html; charset=utf-8':purpose==='source'?'text/plain; charset=utf-8':type.mediaType};
  });
}

const HTML_TAGS=new Set('html head body title meta div span p h1 h2 h3 h4 h5 h6 section article main header footer nav aside figure figcaption blockquote pre code br hr strong em b i u s small sub sup mark time ul ol li dl dt dd table caption colgroup col thead tbody tfoot tr th td a img link style details summary'.split(' '));
const SVG_TAGS=new Set('svg g defs title desc path rect circle ellipse line polyline polygon text tspan linearGradient radialGradient stop clipPath mask pattern use image'.split(' '));
const ATTRS=new Set('id class title lang dir role style width height alt loading decoding colspan rowspan scope datetime open start reversed type viewBox preserveAspectRatio x y x1 x2 y1 y2 cx cy r rx ry d points fill fill-opacity fill-rule stroke stroke-width stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset stroke-opacity opacity transform font-family font-size font-weight text-anchor dominant-baseline dx dy offset stop-color stop-opacity gradientUnits gradientTransform spreadMethod patternUnits patternContentUnits patternTransform clip-path clip-rule mask xmlns version'.toLowerCase().split(' '));
function cssSafe(css) {
  // A deliberately closed static CSS subset, not a sanitizer or a full CSS compiler.
  if(/[\\@<\x00-\x08]/.test(css))unsupported('此预览暂不支持该样式语法');
  const stripped=css.replace(/\/\*[\s\S]*?\*\//g,'');
  if(stripped.includes('/*')||/\b(?:url|image-set|image|cross-fade|element|expression|src)\s*\(/i.test(stripped)||/\b(?:behavior|-moz-binding)\s*:/i.test(stripped))unsupported('此预览暂不支持该样式资源引用');
  const functions=[...stripped.matchAll(/([a-zA-Z_-][\w-]*)\s*\(/g)].map(m=>m[1].toLowerCase());
  const allowed=new Set('rgb rgba hsl hsla hwb lab lch oklab oklch color calc min max clamp var env linear-gradient radial-gradient conic-gradient repeating-linear-gradient repeating-radial-gradient cubic-bezier steps translate translatex translatey scale scalex scaley rotate skew matrix blur brightness contrast grayscale hue-rotate invert opacity saturate sepia drop-shadow repeat minmax fit-content nth-child nth-of-type not is where has'.split(' '));
  if(functions.some(f=>!allowed.has(f)))unsupported('此预览无法可靠解释该样式函数');
  return css;
}
function resourcePath(from,url) {
  if(typeof url!=='string'||!url||url.trim()!==url||/[\\\x00-\x20\x7f]/.test(url.replaceAll(' ',''))||url.startsWith('/')||/^[a-z][a-z0-9+.-]*:/i.test(url)||/[?#]/.test(url)||/%(?:2f|5c)/i.test(url))unsupported('资源地址不是受支持的同版本相对路径');
  let decoded;try{decoded=decodeURIComponent(url);}catch{unsupported('资源地址编码无效');}
  if(/%[0-9a-f]{2}/i.test(decoded)||decoded.startsWith('/')||/[\\:]/.test(decoded))unsupported('资源地址包含不明确的路径编码');
  const path=posix.normalize(posix.join(posix.dirname(from),decoded));validateFilePath(path);return path;
}
function staticPreview(root, entryPath, entryBytes, tree) {
  const seen=new Map([[entryPath,entryBytes]]), stack=new Set([entryPath]);let total=entryBytes.length, derived=entryBytes.length;
  function account(value) {derived+=Buffer.byteLength(value);if(derived>FILE_LIMITS.derivedBytes)reject("FILE_TOO_LARGE","静态预览派生内容超过 16 MiB。");return value;}
  function resource(from,url,depth,kind) {
    if(depth>FILE_LIMITS.depth)reject('FILE_TOO_LARGE','静态预览资源超过 4 层引用。');
    const path=resourcePath(from,url);
    if(stack.has(path))unsupported('静态预览存在循环资源引用');
    if(!seen.has(path)) {
      if(seen.size-1>=FILE_LIMITS.resources)reject('FILE_TOO_LARGE','静态预览超过 64 个资源。');
      const entry=tree.get(path);if(!entry)unsupported('同一固定版本缺少预览资源');
      const remaining=FILE_LIMITS.previewBytes-total;
      const bytes=readBounded(root,path,entry,Math.min(remaining,kind==='css'?FILE_LIMITS.textBytes:remaining));
      seen.set(path,bytes);total+=bytes.length;
    }
    const bytes=seen.get(path);
    if(kind==='css') {if(extname(path).toLowerCase()!=='.css')unsupported('样式资源不是 CSS');return account(cssSafe(text(bytes)));}
    const type=format(path);if(type.previewKind!=='image')unsupported('图片资源不是受支持的栅格图片');raster(bytes,type.mediaType);
    return account(`data:${type.mediaType};base64,${bytes.toString('base64')}`);
  }
  const source=text(entryBytes);
  if(extname(entryPath).toLowerCase()==='.svg'&&!/^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(source))unsupported('SVG 根文档无效');
  const document=parse(source),ids=new Set(),references=[];
  function visit(node) {
    if(node.tagName){
      const svg=node.namespaceURI==='http://www.w3.org/2000/svg',name=node.tagName;
      if(!(svg?SVG_TAGS:HTML_TAGS).has(name))unsupported(`静态预览不支持 ${name} 元素`);
      const attrs=node.attrs??[];
      if(name==='meta') {if(attrs.some(a=>a.name!=='charset'&&!(a.name==='name'&&a.value==='viewport')&&a.name!=='content'))unsupported('页面包含主动 meta 设置'); if(attrs.some(a=>a.name==='content')&&!attrs.some(a=>a.name==='name'&&a.value==='viewport'))unsupported('页面 meta 设置不受支持');}
      else if(name==='link') {
        if(attrs.find(a=>a.name==='rel')?.value.toLowerCase()!=='stylesheet'||attrs.some(a=>!['rel','href','media'].includes(a.name)))unsupported('页面包含不支持的链接资源');
        const css=resource(entryPath,attrs.find(a=>a.name==='href')?.value,1,'css');
        node.tagName='style';node.nodeName='style';node.attrs=attrs.filter(a=>a.name==='media');node.childNodes=[{nodeName:'#text',value:css,parentNode:node}];
      } else {
        node.attrs=attrs.filter(a=>{
          const name=a.name.toLowerCase();
          if(name==='href'&&node.tagName==='a'&&!svg)return false;
          if(name==='target'||name==='download'||name==='rel') {if(node.tagName==='a')return false;}
          if(/^on/i.test(name)||a.prefix&&a.prefix!=='xlink')unsupported('页面包含事件或不支持的命名空间');
          if(name==='src'&&node.tagName==='img') {a.value=resource(entryPath,a.value,1,'image');return true;}
          if(name==='href'&&svg) {if(node.tagName==='image'){a.value=resource(entryPath,a.value,1,'image');return true;} if(node.tagName==='use'&&/^#[A-Za-z_][\w:.-]*$/.test(a.value)){references.push(a.value.slice(1));return true;}unsupported('SVG 引用不受支持');}
          if(!ATTRS.has(name)&&!name.startsWith('aria-')&&!name.startsWith('data-'))unsupported(`静态预览不支持 ${name} 属性`);
          if(name==='id')ids.add(a.value);
          if(name==='style')cssSafe(a.value);
          if(/url\s*\(/i.test(a.value)) {if(!svg||!['fill','stroke','clip-path','mask'].includes(name)||!/^url\(#[A-Za-z_][\w:.-]*\)$/.test(a.value))unsupported('SVG 或属性资源引用不受支持');references.push(a.value.slice(5,-1));}
          return true;
        });
      }
      if(node.tagName==='style') {for(const n of node.childNodes??[])if(n.nodeName==='#text')cssSafe(n.value);}
    }
    for(const child of node.childNodes??[])visit(child);
    if(node.content)unsupported('静态预览不支持模板内容');
  }
  visit(document);
  if(references.some(id=>!ids.has(id)))unsupported('SVG 局部引用缺少目标');
  const head=document.childNodes.find(n=>n.tagName==='html')?.childNodes.find(n=>n.tagName==='head');
  if(!head)unsupported('页面结构无法可靠读取');
  const policy="default-src 'none'; script-src 'none'; connect-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
  head.childNodes.unshift({nodeName:'meta',tagName:'meta',namespaceURI:'http://www.w3.org/1999/xhtml',attrs:[{name:'http-equiv',value:'Content-Security-Policy'},{name:'content',value:policy}],childNodes:[],parentNode:head});
  const bytes=Buffer.from(serialize(document));
  if(bytes.length>FILE_LIMITS.derivedBytes)reject('FILE_TOO_LARGE','静态预览派生内容超过 16 MiB，请下载原文件。');
  return bytes;
}
