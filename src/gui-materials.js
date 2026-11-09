import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync, readdirSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { privateDirectory, writePrivateBytes } from "./storage.js";
import { git } from "../packages/agent-sync/src/git.js";
import { inScope, validProjectPath } from "./versioning.js";

export const GUI_MATERIAL_CAPABILITIES = Object.freeze({
  mediaTypes: Object.freeze(["text/plain", "text/markdown", "image/png", "image/jpeg", "image/webp"]),
  textBytes: 512 * 1024,
  imageBytes: 4 * 1024 * 1024,
  maxCount: 8,
  totalBytes: 16 * 1024 * 1024,
  maxImagePixels: 25_000_000,
});
const limits = GUI_MATERIAL_CAPABILITIES;
const metadataBytes = 2048;
const problem = (code, message, cause) => Object.assign(new Error(message, { cause }), { code });
const format = () => problem("MATERIAL_FORMAT", "材料格式无效或当前无法解码。");
const tooLarge = () => problem("MATERIAL_LIMIT", "材料超过字节、像素或单条数量上限。");
const conflict = () => problem("MATERIAL_CONFLICT", "材料与原上传意图或引用摘要不一致。");
const missing = () => problem("MATERIAL_NOT_FOUND", "当前归属没有这份已就绪的材料或上传意图。");
const cancelled = () => problem("MATERIAL_CANCELLED", "这次上传已取消。");
const interrupted = (cause) => problem("MATERIAL_INTERRUPTED", "上传中断，请先核对原上传结果。", cause);
const corrupt = () => problem("MATERIAL_CORRUPT", "材料记录或字节损坏，无法读取。");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const isId = (v) => typeof v === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v);
const isDigest = (v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
function checkId(id) {
  if (!isId(id)) throw problem("MATERIAL_ID", "无效的材料、归属或上传 ID。");
  return id;
}
function describe({ ownerId, uploadId, name, mediaType, byteLength, sha256, branchAnchor }) {
  checkId(ownerId);
  checkId(uploadId);
  if (typeof name !== "string" || !name.trim() || Buffer.byteLength(name) > 512 || /[\x00-\x1f\x7f]/.test(name) || !isDigest(sha256))
    throw format();
  if (!limits.mediaTypes.includes(mediaType)) throw format();
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > (mediaType.startsWith("image/") ? limits.imageBytes : limits.textBytes))
    throw tooLarge();
  if(branchAnchor!==undefined&&branchAnchor!==null&&(typeof branchAnchor!=="string"||!/^[a-zA-Z0-9_-]{1,80}$/.test(branchAnchor)))throw format();
  return { ownerId, uploadId, name, mediaType, byteLength, sha256, ...(branchAnchor!==undefined?{branchAnchor}:{}) };
}
const descriptorFields = ["ownerId", "uploadId", "name", "mediaType", "byteLength", "sha256","branchAnchor"];
const matches = (a, b) => descriptorFields.every((key) => a[key] === b[key]);

function syncDirectory(path) {
  if (process.platform === "win32") return;
  const fd = openSync(path, "r");
  try { fsyncSync(fd); }
  finally { closeSync(fd); }
}

function install(path, bytes) {
  const temp = `${path}.${randomUUID()}.part`;
  try {
    writePrivateBytes(temp, bytes);
    try { linkSync(temp, path); }
    catch (error) {
      if (error.code === "EEXIST") return false;
      throw error;
    }
    try { syncDirectory(dirname(path)); }
    catch (error) { throw problem("MATERIAL_UNKNOWN", "无法确认材料已持久化，请查询原上传 ID。", error); }
    return true;
  } catch (error) {
    if (error.code === "MATERIAL_UNKNOWN") throw error;
    throw problem("MATERIAL_STORAGE", "无法保存材料，请检查本机存储并查询原上传 ID。", error);
  } finally {
    // The immutable target (if linked) keeps the inode. Never delete a target
    // or sweep temporary files left by another process.
    try { unlinkSync(temp); } catch {}
  }
}

const pack = (manifest, bytes = Buffer.alloc(0)) => Buffer.concat([Buffer.from(JSON.stringify(manifest) + "\n"), bytes]);
function load(path, maxBytes) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) throw corrupt();
    const data = Buffer.alloc(stat.size);
    let read = 0;
    while (read < data.length) {
      const count = readSync(fd, data, read, data.length - read, read);
      if (!count) throw corrupt();
      read += count;
    }
    const newline = data.indexOf(10);
    if (newline < 0 || newline >= metadataBytes) throw corrupt();
    let manifest;
    try { manifest = JSON.parse(data.subarray(0, newline).toString("utf8")); }
    catch { throw corrupt(); }
    try { describe(manifest); }
    catch { throw corrupt(); }
    if (!isId(manifest.id)) throw corrupt();
    return { manifest, bytes: data.subarray(newline + 1) };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error.code === "MATERIAL_CORRUPT") throw error;
    throw problem("MATERIAL_STORAGE", "无法读取材料存储。", error);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const pngMagic = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function checkPixels(width, height) {
  if (!width || !height) throw format();
  if (width * height > limits.maxImagePixels) throw tooLarge();
  return [width, height];
}
function pngSize(bytes) {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(pngMagic) ||
      bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") throw format();
  return checkPixels(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
}

const jpegSof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
function jpegSize(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw format();
  let offset = 2;
  while (offset + 3 < bytes.length && bytes[offset++] === 0xff) {
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9 || offset + 2 > bytes.length) break;
    const size = bytes.readUInt16BE(offset);
    if (size < 2 || offset + size > bytes.length) break;
    if (jpegSof.has(marker) && size >= 8)
      return checkPixels(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
    offset += size;
  }
  throw format();
}

function webpSize(bytes) {
  if (bytes.length < 20 || bytes.toString("ascii", 0, 4) !== "RIFF" ||
      bytes.toString("ascii", 8, 12) !== "WEBP" || bytes.readUInt32LE(4) !== bytes.length - 8) throw format();
  let canvas, frame;
  for (let offset = 12; offset < bytes.length;) {
    if (offset + 8 > bytes.length) throw format();
    const type = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    const next = start + size + (size % 2);
    if (next > bytes.length) throw format();
    if (type === "VP8X") {
      if (size !== 10 || offset !== 12 || (bytes[start] & 2)) throw format();
      canvas = checkPixels(1 + bytes.readUIntLE(start + 4, 3), 1 + bytes.readUIntLE(start + 7, 3));
    } else if (type === "VP8L") {
      if (frame || size < 5 || bytes[start] !== 0x2f) throw format();
      const bits = bytes.readUInt32LE(start + 1);
      frame = checkPixels(1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff));
    } else if (type === "VP8 ") {
      if (frame || size < 10 || (bytes[start] & 1) || !bytes.subarray(start + 3, start + 6).equals(Buffer.from([0x9d, 1, 0x2a]))) throw format();
      frame = checkPixels(bytes.readUInt16LE(start + 6) & 0x3fff, bytes.readUInt16LE(start + 8) & 0x3fff);
    } else if (type === "ANIM" || type === "ANMF") throw format();
    offset = next;
  }
  if (!frame || (canvas && (canvas[0] !== frame[0] || canvas[1] !== frame[1]))) throw format();
  return frame;
}

const imageSize = { "image/png": pngSize, "image/jpeg": jpegSize, "image/webp": webpSize };
async function validateContent(bytes, mediaType) {
  if (!mediaType.startsWith("image/")) {
    try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw format(); }
    return {};
  }
  // Reject dimensions before allocating a decoded image. Pi's existing
  // decoder then verifies the actual payload; the original bytes stay intact.
  const [width, height] = imageSize[mediaType](bytes);
  const { resizeImage } = await import("@earendil-works/pi-coding-agent");
  const decoded = await resizeImage(bytes, mediaType, {
    maxWidth: Math.max(width, height), maxHeight: Math.max(width, height),
    maxBytes: Math.ceil(limits.imageBytes / 3) * 4 + 1,
  });
  if (!decoded || decoded.wasResized ||
      !((decoded.width === width && decoded.height === height) || (decoded.width === height && decoded.height === width))) throw format();
  return { width: decoded.width, height: decoded.height };
}

function checkAbort(signal) {
  if (signal?.aborted) throw interrupted(signal.reason);
}
async function readBody(body, length, signal) {
  if (body instanceof Uint8Array) body = [body];
  if (typeof body?.[Symbol.asyncIterator] !== "function" && typeof body?.[Symbol.iterator] !== "function") throw format();
  const bytes = Buffer.alloc(length);
  let offset = 0;
  try {
    for await (const chunk of body) {
      checkAbort(signal);
      if (!(chunk instanceof Uint8Array)) throw format();
      if (offset + chunk.length > length) throw tooLarge();
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
  } catch (error) {
    if (["MATERIAL_FORMAT", "MATERIAL_LIMIT", "MATERIAL_INTERRUPTED"].includes(error?.code)) throw error;
    throw interrupted(error);
  }
  checkAbort(signal);
  if (offset !== length) throw conflict();
  return bytes;
}

/** Call only with an owner authorized by the host. A reference by itself grants no access. */
export function createGuiMaterialStore(home) {
  const root = join(home, "gui-materials");
  const intents = join(root, "intents");
  const objects = join(root, "objects");
  const ownerPath = (ownerId) => join(intents, checkId(ownerId));
  const intentPath = ({ ownerId, uploadId }) => join(ownerPath(ownerId), `${checkId(uploadId)}.json`);
  const acknowledgedPath = (key) => intentPath(key)+".ack";
  const objectPath = (id) => join(objects, `${checkId(id)}.material`);

  function ensureOwner(ownerId) {
    try {
      privateDirectory(ownerPath(ownerId));
      privateDirectory(objects);
      syncDirectory(intents);
      syncDirectory(root);
      syncDirectory(home);
    } catch (error) {
      throw problem("MATERIAL_STORAGE", "无法创建私有材料目录。", error);
    }
  }
  function lookupIntent(key) {
    const entry = load(intentPath(key), metadataBytes);
    if (!entry) return null;
    const { manifest, bytes } = entry;
    if (manifest.ownerId !== key.ownerId || manifest.uploadId !== key.uploadId || manifest.status !== "pending" || bytes.length)
      throw corrupt();
    return manifest;
  }
  function lookupObject(ownerId, id) {
    checkId(ownerId);
    const entry = load(objectPath(id), metadataBytes + limits.imageBytes);
    if (!entry || entry.manifest.ownerId !== ownerId) return null;
    const { manifest, bytes } = entry;
    if (manifest.id !== id || !["ready", "cancelled"].includes(manifest.status)) throw corrupt();
    if (manifest.status === "cancelled" ? bytes.length : bytes.length !== manifest.byteLength || digest(bytes) !== manifest.sha256)
      throw corrupt();
    return entry;
  }
  function outcome(intent) {
    const manifest = lookupObject(intent.ownerId, intent.id)?.manifest;
    if (!manifest) return intent;
    if (!matches(intent, manifest)) throw corrupt();
    // A previous process may have linked the immutable outcome and lost its
    // acknowledgement before flushing the directory.
    try { syncDirectory(objects); }
    catch (error) { throw problem("MATERIAL_UNKNOWN", "无法确认材料已持久化，请查询原上传 ID。", error); }
    return manifest;
  }
  function query(key) {
    const intent = lookupIntent(key);
    if (!intent) return null;
    try { syncDirectory(ownerPath(intent.ownerId)); }
    catch (error) { throw problem("MATERIAL_UNKNOWN", "无法确认上传意图已持久化，请查询原上传 ID。", error); }
    return outcome(intent);
  }
  function begin(input) {
    const descriptor = describe(input);
    const existing = lookupIntent(descriptor);
    if (existing) {
      if (!matches(existing, descriptor)) throw conflict();
      return query(descriptor);
    }
    ensureOwner(descriptor.ownerId);
    const intent = { ...descriptor, id: randomUUID(), status: "pending" };
    if (install(intentPath(descriptor), pack(intent))) return intent;
    const winner = query(descriptor);
    if (!winner || !matches(winner, descriptor)) throw conflict();
    return winner;
  }
  function acknowledge(key) {
    const receipt=query(key);
    if(receipt?.status!=="ready")throw missing();
    if(!load(acknowledgedPath(key),metadataBytes))install(acknowledgedPath(key),pack(receipt));
  }
  function list({ ownerId }) {
    let names;
    try { names = readdirSync(ownerPath(ownerId)); }
    catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    return names.filter((name) => name.endsWith(".json") && isId(name.slice(0, -5))).sort()
      .map((name) => {
        const key={ownerId,uploadId:name.slice(0,-5)},receipt=query(key);
        if(receipt?.status!=="ready")return receipt;
        const ack=load(acknowledgedPath(key),metadataBytes);
        if(ack&&(!matches(ack.manifest,receipt)||ack.manifest.id!==receipt.id))throw corrupt();
        return ack?{...receipt,acknowledged:true}:receipt;
      }).filter(Boolean);
  }
  async function publish({ ownerId, uploadId, body, signal }) {
    const intent = query({ ownerId, uploadId });
    if (!intent) throw missing();
    if (intent.status === "cancelled") throw cancelled();
    checkAbort(signal);
    const bytes = await readBody(body, intent.byteLength, signal);
    if (digest(bytes) !== intent.sha256) throw conflict();
    if (intent.status === "ready") return intent;
    const extra = await validateContent(bytes, intent.mediaType);
    checkAbort(signal);
    const ready = { ...intent, status: "ready", ...extra };
    if (install(objectPath(intent.id), pack(ready, bytes))) return ready;
    const winner = outcome(intent);
    if (winner.status === "cancelled") throw cancelled();
    if (winner.status === "ready") return winner;
    throw problem("MATERIAL_UNKNOWN", "无法确认材料发布结果，请查询原上传 ID。");
  }
  function cancel(key) {
    const intent = query(key);
    if (!intent) throw missing();
    if (intent.status !== "pending") return intent;
    const tombstone = { ...intent, status: "cancelled" };
    if (install(objectPath(intent.id), pack(tombstone))) return tombstone;
    const winner = outcome(intent);
    if (winner.status !== "pending") return winner;
    throw problem("MATERIAL_UNKNOWN", "无法确认取消结果，请查询原上传 ID。");
  }
  function read({ ownerId, id, sha256 }) {
    const entry = lookupObject(ownerId, id);
    if (entry?.manifest.status !== "ready") throw missing();
    if (sha256 !== undefined && entry.manifest.sha256 !== sha256) throw conflict();
    return entry;
  }
  function resolve({ ownerId, materials, ownerFor = () => ownerId }) {
    if (!Array.isArray(materials) || materials.length > limits.maxCount) throw tooLarge();
    let total = 0;
    return materials.map(({ id, sha256 }) => {
      if (!isDigest(sha256)) throw conflict();
      // ownerFor, when supplied, resolves the exact authorized provenance
      // from the host's draft/history, never from incoming material fields.
      const entry = read({ ownerId: ownerFor({ id, sha256 }), id, sha256 });
      total += entry.manifest.byteLength;
      if (total > limits.totalBytes) throw tooLarge();
      return entry;
    });
  }
  return { begin, publish, query, list, cancel, read, resolve, acknowledge };
}

// The host has already resolved the selected session directory and fixed version.
// Current copies and saved blobs are read independently, with the same byte limits as uploads.
const sourceDigest=value=>digest(JSON.stringify(value));
function directoryIdentity(path){
  try{const stat=statSync(path,{bigint:true});return [String(stat.dev),String(stat.ino)];}
  catch{return null;}
}
function projectMaterialType(path){
  const ext=extname(path).toLowerCase();
  if(ext===".png")return "image/png";
  if(ext===".jpeg"||ext===".jpg")return "image/jpeg";
  if(ext===".webp")return "image/webp";
  if(ext===".md"||ext===".markdown")return "text/markdown";
  if(!ext||[".txt",".json",".csv",".tsv",".xml",".yaml",".yml",".toml",".ini",".log",".js",".ts",".jsx",".tsx",".css",".html",".py",".sh",".rs",".go",".c",".h",".java",".sql",".tex",".diff",".patch"].includes(ext))return "text/plain";
  return null;
}
const permittedMaterialPath=(path,source)=>validProjectPath(path,true)&&inScope(path,[source.scope]);
function diskMaterialPath(root,path,asDirectory){
  let target=root;
  for(const piece of path==="."?[]:path.split("/")){
    target=join(target,piece);
    const stat=lstatSync(target);
    if(stat.isSymbolicLink())throw problem("MATERIAL_SOURCE","链接不能作为项目材料读取。");
  }
  const stat=lstatSync(target);
  if(realpathSync(target)!==target||asDirectory&&!stat.isDirectory()||!asDirectory&&(!stat.isFile()||stat.nlink!==1))
    throw problem("MATERIAL_SOURCE","材料必须位于所选目录的普通文件中。");
  return target;
}
async function savedMaterialEntries(source,path){
  const entries=(await git(source.root,["--literal-pathspecs","ls-tree","-rz","--full-tree",source.version,"--",...(path==="."?[]:[path])],undefined,{GIT_NO_LAZY_FETCH:"1"})).toString("utf8").split("\0").filter(Boolean);
  return entries.flatMap(line=>{
    const tab=line.indexOf("\t"),[mode,type,object]=line.slice(0,tab).split(" "),name=line.slice(tab+1);
    return type==="blob"&&["100644","100755"].includes(mode)&&/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(object)&&permittedMaterialPath(name,source)?[{path:name,object}]:[];
  });
}
export async function listGuiProjectMaterials(source,{path=source.scope,cursor}={}){
  if(!permittedMaterialPath(path,source))throw problem("MATERIAL_SOURCE","目录超出选择范围。");
  let entries;
  if(source.source==="current"){
    const dir=diskMaterialPath(source.root,path,true);
    entries=readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{
      const rel=path==="."?entry.name:path+"/"+entry.name;
      if(!permittedMaterialPath(rel,source))return [];
      if(entry.isDirectory())return [{path:rel,name:entry.name,kind:"directory",byteLength:null}];
      if(!entry.isFile())return [];
      const stat=lstatSync(join(dir,entry.name));
      return stat.nlink===1&&projectMaterialType(rel)?[{path:rel,name:entry.name,kind:"file",byteLength:stat.size}]:[];
    });
  }else{
    const children=new Map();
    for(const entry of await savedMaterialEntries(source,path)){
      const leaf=path==="."?entry.path:entry.path.slice(path.length+1),name=leaf.split("/")[0];
      if(!name)continue;
      const child=path==="."?name:path+"/"+name;
      const kind=leaf.includes("/")?"directory":"file";
      if(kind==="directory"||projectMaterialType(child)){
        const count=(children.get(child)?.fileCount??0)+1;
        children.set(child,{path:child,name,kind,byteLength:null,fileCount:count});
      }
    }
    entries=[...children.values()];
  }
  entries.sort((a,b)=>a.kind.localeCompare(b.kind)||a.name.localeCompare(b.name));
  const fingerprint=sourceDigest([source.path,source.identity,source.version,path,entries]);
  let offset=0;
  if(cursor){
    const [id,pos]=cursor.split(":");offset=Number(pos);
    if(id!==fingerprint||!Number.isSafeInteger(offset)||offset<0)throw problem("MATERIAL_SOURCE","文件清单已变化，请重新浏览。");
  }
  return {source:source.source,version:source.version,path,scope:source.scope,entries:entries.slice(offset,offset+100),
    nextCursor:offset+100<entries.length?`${fingerprint}:${offset+100}`:null};
}
export async function readGuiProjectMaterial(source,path){
  const mediaType=projectMaterialType(path??"");
  if(!validProjectPath(path)||!permittedMaterialPath(path,source)||!mediaType)
    throw problem("MATERIAL_SOURCE","该项目材料格式或相对路径不可用。");
  const limit=mediaType.startsWith("image/")?GUI_MATERIAL_CAPABILITIES.imageBytes:GUI_MATERIAL_CAPABILITIES.textBytes;
  let bytes;
  if(source.source==="current"){
    const target=diskMaterialPath(source.root,path,false),initial=lstatSync(target,{bigint:true});
    const fd=openSync(target,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
    const signature=stat=>[stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs,stat.mode,stat.nlink].map(String).join(":");
    try{
      const stat=fstatSync(fd,{bigint:true});
      if(signature(initial)!==signature(stat)||!stat.isFile())throw problem("MATERIAL_SOURCE","文件在读取期间已变化。");
      if(stat.size>BigInt(limit))throw problem("MATERIAL_LIMIT","材料超过单份字节上限。");
      const buffer=Buffer.alloc(Number(stat.size)+1);
      let count=0;
      while(count<buffer.length){const n=readSync(fd,buffer,count,buffer.length-count,count);if(!n)break;count+=n;}
      if(count!==Number(stat.size)||signature(stat)!==signature(fstatSync(fd,{bigint:true}))||
        signature(stat)!==signature(lstatSync(diskMaterialPath(source.root,path,false),{bigint:true})))
        throw problem("MATERIAL_SOURCE","文件在读取期间已变化。");
      bytes=buffer.subarray(0,count);
    }finally{closeSync(fd);}
  }else{
    const entry=(await savedMaterialEntries(source,path)).find(entry=>entry.path===path);
    if(!entry)throw problem("MATERIAL_NOT_FOUND","固定版本中没有该普通文件。");
    const size=Number((await git(source.root,["cat-file","-s",entry.object],undefined,{GIT_NO_LAZY_FETCH:"1"})).toString("utf8").trim());
    if(!Number.isSafeInteger(size)||size>limit)throw problem("MATERIAL_LIMIT","材料超过单份字节上限。");
    bytes=await git(source.root,["cat-file","blob",entry.object],undefined,{GIT_NO_LAZY_FETCH:"1"});
    if(bytes.length!==size)throw problem("MATERIAL_SOURCE","固定版本内容无法核验。");
  }
  if(sourceDigest(source.identity)!==sourceDigest(directoryIdentity(source.path)))throw problem("MATERIAL_SOURCE","所选目录已变化，请重新预览。");
  const sha256=digest(bytes);
  const sourceToken=sourceDigest([source.path,source.identity,source.version,path,sha256]);
  return {mediaType,bytes,sha256,sourceToken};
}
