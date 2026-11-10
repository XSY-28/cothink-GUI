import {parseFrontmatter} from "@earendil-works/pi-coding-agent";
import {createHash} from 'node:crypto';
import {constants,openSync,closeSync,fstatSync,readFileSync,lstatSync,readdirSync,mkdirSync,writeFileSync,realpathSync,existsSync,chmodSync} from 'node:fs';
import {join,dirname,basename,resolve,relative,isAbsolute} from 'node:path';
import {privateDirectory} from './storage.js';
import {problem} from './task.js';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const inside=(root,path)=>{const rel=relative(root,path);return !isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('../');};
function safeRelative(path){return typeof path==='string'&&path&&!isAbsolute(path)&&!/[\\\0]/.test(path)&&!path.split('/').some(p=>!p||p==='.'||p==='..'||p.toLowerCase()==='.git');}
// Every ancestor and the opened descriptor are checked; a symlink is never followed.
function stableRead(root,path){
  const abs=resolve(root,path);if(!inside(root,abs))throw problem('SKILL_CHANGED','Resource escaped frozen directory');
  if(lstatSync(root).isSymbolicLink())throw problem('SKILL_CHANGED','Selected skill resource root is a symbolic link');
  let part=root;
  for(const p of relative(root,abs).split('/').filter(Boolean)){part=join(part,p);if(lstatSync(part).isSymbolicLink())throw problem('SKILL_CHANGED','Symbolic link in selected skill resource: '+part);}
  const fd=openSync(abs,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{const before=fstatSync(fd);if(!before.isFile()||before.nlink!==1)throw problem('SKILL_CHANGED','Unsupported skill resource: '+abs);
    const bytes=readFileSync(fd),after=fstatSync(fd),pathStat=lstatSync(abs);
    if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||pathStat.ino!==after.ino||pathStat.dev!==after.dev||realpathSync(abs)!==join(realpathSync(root),relative(root,abs)))throw problem('SKILL_CHANGED','Skill resource changed while reading: '+abs);
    return {bytes,mode:before.mode&0o111?0o755:0o644};
  }finally{closeSync(fd);}
}
export function getTaskSkillResources(task) {
  const record=task.record??task,a=record.skillResources,b=record.work?.skillResources;
  if(a!==undefined&&!Array.isArray(a)||b!==undefined&&!Array.isArray(b))throw problem('SKILL_CHANGED','Invalid skill manifest');
  if(a!==undefined&&b!==undefined&&JSON.stringify(a)!==JSON.stringify(b))throw problem('SKILL_CHANGED','Conflicting generic and legacy skill manifests');
  const records=a??b??[];if(!Array.isArray(records))throw problem('SKILL_CHANGED','Invalid skill manifest');return records;
}
/** One task resource freeze, shared by employees and optional plugin helpers. */
export function freezeTaskSkillResources({task,skills=task.frozenSkills??task.answerSkills??[]}){
  const resourceRoot=join(task.home,'tasks',task.record.id+'-resources');
  if(Object.hasOwn(task.record,'skillResources')||Object.hasOwn(task.record.work??{},'skillResources')){
    const records=getTaskSkillResources(task);
    if(!Array.isArray(records))throw problem('SKILL_CHANGED','Saved skill manifest is invalid');
    for(const r of records){
      if(!safeRelative(r.name)||r.name.includes('/')||resolve(r.root)!==resolve(join(resourceRoot,r.name))||typeof r.sourceDirectory!=='string'||!isAbsolute(r.sourceDirectory)||!r.files?.['SKILL.md'])throw problem('SKILL_CHANGED','Saved skill provenance or path is invalid');
      let bytes;try{bytes=stableRead(r.root,'SKILL.md').bytes;}catch(error){throw problem('SKILL_CHANGED','Saved frozen skill is unavailable: '+error.message);}
      const {frontmatter}=parseFrontmatter(bytes.toString('utf8')),summary=task.record.answerSkills?.find(s=>s.name===r.name);
      if(frontmatter.name!==r.name||hash(bytes)!==r.files['SKILL.md']||(r.hash&&r.hash!==hash(bytes))||(r.description&&r.description!==frontmatter.description))throw problem('SKILL_CHANGED','Saved skill header or hash differs from frozen bytes');
      Object.assign(r,{description:r.description??summary?.description??frontmatter.description,hash:r.hash??r.files['SKILL.md'],disabledModelInvocation:r.disabledModelInvocation??frontmatter['disable-model-invocation']===true,sourcePath:r.sourcePath??summary?.path??join(r.sourceDirectory,'SKILL.md'),path:join(r.root,'SKILL.md'),executionPath:'/resources/'+r.name+'/SKILL.md'});
    }
    task.skillResourceRoot=resourceRoot;verifyTaskSkillResources(task);return records;
  }
  if(existsSync(resourceRoot)&&readdirSync(resourceRoot).length)throw problem('SKILL_CHANGED','Unbound task resource bytes already exist; preserved without refreshing');
  privateDirectory(resourceRoot);
  const records=skills.map(skill=>checkedSkillResources(skill,resourceRoot));
  task.record.skillResources=records;task.skillResourceRoot=resourceRoot;task.save();return records;
}

// Use the same source validation for a settings preview and for a task freeze.
export function validateSkillResources(skills) {
  for (const skill of skills) checkedSkillResources(skill);
}

function checkedSkillResources(skill, resourceRoot) {
  try { return collectSkillResources(skill,resourceRoot); }
  catch(error) {
    throw problem(error.code??'SKILL_CHANGED', `技能 ${skill.name} 的资源无法验证。${error.message}。请检查技能来源或在设置中移除。`);
  }
}

function collectSkillResources(skill,resourceRoot){
  if(!safeRelative(skill.name)||skill.name.includes('/'))throw problem('SKILL_PATH','Unsafe skill name');
  const sourceDirectory=dirname(skill.path),root=resourceRoot&&join(resourceRoot,skill.name);
  if(root)privateDirectory(root);
  const files={},modes={},unavailable=[],selected=new Set(['SKILL.md']),roots=new Set(['references','scripts','assets','templates']);
  for(const m of skill.body.matchAll(/\]\(([^)\s]+)\)|`([^`\n\s]+)`/g)){
    const candidate=(m[1]??m[2]).replace(/\/$/,'');if(candidate.includes(':')||candidate.startsWith('#'))continue;
    if(!safeRelative(candidate)){unavailable.push({path:candidate,reason:'Reference escapes selected skill or uses an unsupported path'});continue;}
    if(!existsSync(join(sourceDirectory,candidate))){unavailable.push({path:candidate,reason:'Referenced resource is missing'});continue;}roots.add(candidate);
  }
  function select(path){
    if(!safeRelative(path))throw problem('SKILL_PATH','Unsafe selected resource path: '+path);
    const stat=lstatSync(join(sourceDirectory,path));if(stat.isSymbolicLink())throw problem('SKILL_CHANGED','Selected resource is a symbolic link: '+path);
    if(stat.isDirectory())for(const entry of readdirSync(join(sourceDirectory,path)).sort())select(path+'/'+entry);
    else if(stat.isFile())selected.add(path);else throw problem('SKILL_CHANGED','Unsupported selected resource: '+path);
  }
  for(const path of roots)if(existsSync(join(sourceDirectory,path)))select(path);
  // Resolve local JS/TS imports in selected scripts too, without treating Markdown as dependency analysis.
  const pending=[...selected];
  for(let i=0;i<pending.length;i++){
    const path=pending[i],{bytes,mode}=stableRead(sourceDirectory,path==='SKILL.md'?basename(skill.path):path);
    if(path==='SKILL.md'&&hash(bytes)!==skill.hash)throw problem('SKILL_CHANGED','Skill main changed before freeze: '+skill.name);
    files[path]=hash(bytes);modes[path]=mode;
    if(root){mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),bytes,{mode});chmodSync(join(root,path),mode);}
    if(/\.[cm]?[jt]sx?$/.test(path))for(const match of bytes.toString('utf8').matchAll(/(?:from\s*|import\s*\(|require\s*\(|import\s*)["'](\.[^"']+)["']/g)){
      const target=resolve(sourceDirectory,dirname(path),match[1]);
      if(!inside(sourceDirectory,target)){unavailable.push({path:match[1],reason:'Local import escapes selected skill'});continue;}
      const found=[target,target+'.js',target+'.mjs',target+'.ts',join(target,'index.js')].find(p=>existsSync(p)&&lstatSync(p).isFile());
      if(!found){unavailable.push({path:match[1],reason:'Local script import is missing'});continue;}
      const rel=relative(sourceDirectory,found).replaceAll('\\','/');if(!selected.has(rel)){selected.add(rel);pending.push(rel);}
    }
  }
  // Recheck original bytes after collection, so an edit cannot mix two versions.
  for(const [path,digest]of Object.entries(files))if(hash(stableRead(sourceDirectory,path==='SKILL.md'?basename(skill.path):path).bytes)!==digest)throw problem('SKILL_CHANGED','Skill changed during resource freeze: '+skill.name+'/'+path);
  if(root)return {name:skill.name,description:skill.description,version:skill.version??null,sourceKind:skill.sourceKind??'selected',sourceDigest:skill.sourceDigest??skill.hash,hash:skill.hash,disabledModelInvocation:!!skill.disabledModelInvocation,sourceDirectory,sourcePath:skill.path,root,path:join(root,'SKILL.md'),executionPath:'/resources/'+skill.name+'/SKILL.md',unavailable,files,modes};
}
export function taskSkillDirectory(task){return (getTaskSkillResources(task)).map(({name,description,version,sourceKind,hash,disabledModelInvocation,unavailable})=>({name,description,version:version??null,sourceKind:sourceKind??'selected',hash,disabledModelInvocation,path:'skill:'+name+'/SKILL.md',executionPath:'/resources/'+name+'/SKILL.md',unavailable:unavailable?.map(x=>({reason:x.reason})),resourceMode:'on-demand'}));}
/** Narrow model-facing reader; arbitrary source aliases remain internal to managed read. */
export function readFrozenSkill(task,args,{actor,stageId,toolCallId,explicit=false}={}) {
 if(task.signal?.aborted||task.record.status!=='running')throw problem('TASK_ENDED','Skill reading requires a running task');
 if(!args||typeof args.name!=='string'||!safeRelative(args.name)||args.name.includes('/')||!safeRelative(args.path??'SKILL.md'))throw problem('SKILL_RESOURCE','Use a selected skill name and relative resource path');
 const offset=args.offset??0,limit=args.limit??16000;
 if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>32000)throw problem('SKILL_RESOURCE','Invalid skill read page');
 let resource;try{resource=readTaskSkillResource(task,'skill:'+args.name+'/'+(args.path??'SKILL.md'));}catch{throw problem('SKILL_CHANGED','Frozen skill resource missing or changed: '+args.name);}
 if(!resource)throw problem('SKILL_RESOURCE','Skill resource is not available in this task');
 const text=resource.bytes.toString('utf8'),content=text.slice(offset,offset+limit),nextOffset=offset+content.length;
 (task.record.tools??=[]).push({kind:'skill_resource_read',name:explicit?'skill_expansion':'read_skill',toolCallId,actor,stageId,resourceName:resource.record.name,resourcePath:resource.relativePath,resourceHash:resource.hash,skillHash:resource.record.hash,offset,characters:content.length,explicit,status:'completed'});task.save();
 return {name:resource.record.name,path:resource.relativePath,skillHash:resource.record.hash,resourceHash:resource.hash,offset,nextOffset,eof:nextOffset>=text.length,content};
}
export function readTaskSkillResource(task,path){
  if(typeof path!=='string'||path.includes('\0')||path.includes('\\'))return null;
  for(const r of getTaskSkillResources(task)){
    let requested=path;
    if(requested.startsWith('skill:'+r.name+'/'))requested=join(r.root,requested.slice(('skill:'+r.name+'/').length));
    if(requested.startsWith('/resources/'+r.name+'/'))requested=join(r.root,requested.slice(('/resources/'+r.name+'/').length));
    if(!isAbsolute(requested))continue;
    // Canonicalize path aliases through the nearest existing ancestor, never read live resource bytes.
    const requestedPaths=[resolve(requested)];let ancestor=resolve(requested),suffix=[];
    for(;;){try{requestedPaths.push(join(realpathSync(ancestor),...suffix));break;}catch{const parent=dirname(ancestor);if(parent===ancestor)break;suffix.unshift(basename(ancestor));ancestor=parent;}}
    for(const base of [r.root,r.sourceDirectory])for(const candidate of requestedPaths){
      const rel=(candidate===r.sourcePath?'SKILL.md':relative(base,candidate)).replaceAll('\\','/');
      if(!rel||!inside(base,candidate))continue;
      if(!r.files[rel]){if(base===r.root)throw problem('SKILL_RESOURCE','Resource was not selected in the task freeze: '+rel);continue;}
      try{const {bytes}=stableRead(r.root,rel);if(hash(bytes)!==r.files[rel])throw Error('Hash mismatch');return {bytes,record:r,path:join(r.root,rel),relativePath:rel,hash:r.files[rel]};}
      catch(error){throw problem('SKILL_CHANGED','Frozen resource unavailable or changed: '+r.name+'/'+rel+'; '+error.message);}
    }
  }
  return null;
}
export function verifyTaskSkillResources(task){
  const records=getTaskSkillResources(task),expectedNames=records.map(r=>r.name).sort();
  if(task.skillResourceRoot){const names=readdirSync(task.skillResourceRoot).sort();if(JSON.stringify(names)!==JSON.stringify(expectedNames))throw problem('SKILL_CHANGED','Task resource inventory changed');}
  for(const r of records){
    const inventory=[];function walk(directory,prefix=''){for(const name of readdirSync(directory).sort()){const path=prefix+name,stat=lstatSync(join(directory,name));if(stat.isSymbolicLink())throw problem('SKILL_CHANGED','Link in frozen resource inventory');if(stat.isDirectory())walk(join(directory,name),path+'/');else if(stat.isFile())inventory.push(path);else throw problem('SKILL_CHANGED','Unsupported frozen resource type');}}
    try{walk(r.root);if(JSON.stringify(inventory.sort())!==JSON.stringify(Object.keys(r.files).sort()))throw Error('Frozen file inventory changed');
      for(const path of Object.keys(r.files)){readTaskSkillResource(task,join(r.root,path));if(process.platform!=='win32'&&r.modes?.[path]!==undefined&&(lstatSync(join(r.root,path)).mode&0o777)!==r.modes[path])throw Error('Frozen resource mode changed: '+path);}
    }catch(error){throw problem('SKILL_CHANGED',error.message);}
  }
}
