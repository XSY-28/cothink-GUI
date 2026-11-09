import {readFileSync,lstatSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
export const builtinSkillNames=Object.freeze(['doc-maintenance','context-management']);
const directory=fileURLToPath(new URL('../resources/builtin-skills/',import.meta.url));
const sha=value=>createHash('sha256').update(value).digest('hex');
export function validateBuiltinSkills(config) {
 const value=config?.piResources?.builtinSkills;
 if(value===undefined)return [];
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>k!=='disabled')||!Array.isArray(value.disabled)||value.disabled.some(n=>!builtinSkillNames.includes(n))||new Set(value.disabled).size!==value.disabled.length)throw Error('内置 builtinSkills 仅接受 disabled 数组，名称必须规范且不重复。');
 return value.disabled;
}
/** Only the unified caller opts into this source. Legacy selectedResources stays unchanged. */
export function resolveBuiltinSkills(config) {
 const disabled=validateBuiltinSkills(config),enabled=builtinSkillNames.filter(n=>!disabled.includes(n)),skills=[],diagnostics=[];
 if(!enabled.length)return {skills,diagnostics};
 let manifest;try {manifest=JSON.parse(readFileSync(join(directory,'manifest.json')));if(manifest.schemaVersion!==1||!Array.isArray(manifest.skills))throw Error();}
 catch {return {skills,diagnostics:[{code:'BUILTIN_RESOURCE',message:'内置技能清单缺失或损坏；请重新构建或安装完整包。'}]};}
 for(const name of enabled)try {
  const item=manifest.skills.find(x=>x.name===name);if(!item?.files?.some(f=>f.path==='SKILL.md'))throw Error();
  for(const file of item.files){if(typeof file.path!=='string'||file.path.startsWith('/')||file.path.includes('\\')||file.path.split('/').some(x=>!x||x==='.'||x==='..'))throw Error();
   let path=join(directory,name);for(const part of file.path.split('/')){path=join(path,part);if(lstatSync(path).isSymbolicLink())throw Error();}
   const stat=lstatSync(path);if(!stat.isFile()||sha(readFileSync(path))!==file.sha256||(process.platform!=='win32'&&(stat.mode&0o777)!==file.mode))throw Error();}
  skills.push({name,version:item.version,path:join(directory,name,'SKILL.md'),sourceKind:'builtin',sourceDigest:sha(JSON.stringify(item))});
 }catch {diagnostics.push({name,code:'BUILTIN_RESOURCE',message:'内置技能 '+name+' 缺失、权限或摘要不匹配；运行时不会安装或修复。'});}
 return {skills,diagnostics};
}
/** Whitelist shared by model and settings. Inputs are host facts, never model claims. */
export function capabilitySnapshot({skills=[],tools=[],readOnly=false,hasProject=false,readAuthorized=false,writeAuthorized=true,scriptAuthorized=true,executionConfigured=false,phase='next-turn',diagnostics=[],context=null}={}) {
 return {version:1,phase,skills:skills.map(s=>({name:s.name,description:s.description,version:s.version??null,hash:s.hash??null,sourceKind:s.sourceKind??'selected',explicitOnly:!!s.disabledModelInvocation,reference:s.path?.startsWith('skill:')?s.path:'skill:'+s.name+'/SKILL.md'})),
  tools:[...new Set(tools)].sort(),permissions:{readOnly:!!readOnly,projectAssociated:!!hasProject,fileReadAuthorized:!!readAuthorized,fileWrite:(tools.includes('write')||tools.includes('edit'))&&!readOnly&&!!writeAuthorized,scriptExecution:tools.includes('resource_exec')&&!readOnly&&!!scriptAuthorized},
  environment:{managedExecutionConfigured:!!executionConfigured,contextToolsAvailable:['search_context','read_context','save_context_note'].every(n=>tools.includes(n)),contextOrganizationAvailable:!!context,automaticCompression:false},context,diagnostics:diagnostics.map(d=>({code:d.code??'RESOURCE',name:d.name??null,message:d.message}))};
}
