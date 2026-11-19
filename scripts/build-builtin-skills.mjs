/** Build-time only. Runtime resources never install packages or consult a developer home. */
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,cpSync,rmSync,readdirSync,lstatSync,realpathSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {build} from 'rolldown';
const root=fileURLToPath(new URL('..',import.meta.url)),base=join(root,'resources/builtin-skills'),doc=join(base,'doc-maintenance');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=(path,value)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n');
function inventory(dir,prefix='') {
 return readdirSync(dir).sort().flatMap(name=>{const path=join(dir,name),rel=prefix+name,stat=lstatSync(path);
  if(stat.isSymbolicLink())throw Error('Link in builtin input: '+rel);
  if(stat.isDirectory())return inventory(path,rel+'/');
  if(!stat.isFile())throw Error('Unsupported builtin input: '+rel);
  return [{path:rel,sha256:sha(readFileSync(path)),mode:stat.mode&0o111?0o755:0o644}];});
}
const scratch=realpathSync(mkdtempSync(join(tmpdir(),'cothink-builtin-build-')));
try {
 const source=JSON.parse(readFileSync(join(doc,'build-input/source.json'))),prepared=join(scratch,'source');mkdirSync(prepared);
 for(const name of ['LICENSE','NOTICE.md'])if(sha(readFileSync(join(doc,'assets',name)))!==source.files.find(f=>f.path===name)?.sha256)throw Error('Upstream notice changed: '+name);
 for(const name of ['scripts','package.json','npm-shrinkwrap.json'])cpSync(join(doc,'build-input',name),join(prepared,name),{recursive:true});
 for(const file of inventory(prepared))if(source.files.find(x=>x.path===file.path)?.sha256!==file.sha256)throw Error('Fixed checker source changed: '+file.path);
 const lock=JSON.parse(readFileSync(join(prepared,'npm-shrinkwrap.json')));
 for(const name of ['user.npmrc','global.npmrc'])writeFileSync(join(scratch,name),'');
 const npmArgs=['ci','--ignore-scripts','--no-audit','--no-fund','--registry=https://registry.npmjs.org/','--cache',join(scratch,'cache'),'--userconfig='+join(scratch,'user.npmrc'),'--globalconfig='+join(scratch,'global.npmrc')];
 if(process.env.npm_execpath)execFileSync(process.execPath,[process.env.npm_execpath,...npmArgs],{cwd:prepared,stdio:['ignore','pipe','pipe']});
 else execFileSync(process.platform==='win32'?'npm.cmd':'npm',npmArgs,{cwd:prepared,stdio:['ignore','pipe','pipe'],shell:process.platform==='win32'});
 const dependencies=[],licenses=join(doc,'assets/licenses');rmSync(licenses,{recursive:true,force:true});mkdirSync(licenses,{recursive:true});
 for(const [location,value]of Object.entries(lock.packages)) {
  if(!location)continue;const dir=join(prepared,location),pkg=JSON.parse(readFileSync(join(dir,'package.json')));
  if(pkg.version!==value.version)throw Error('Locked dependency changed: '+pkg.name);
  const names=readdirSync(dir).sort().filter(name=>/license|notice|copying/i.test(name)&&lstatSync(join(dir,name)).isFile());
  if(!names.length)throw Error('Missing license: '+pkg.name);
  const target=join(licenses,pkg.name);mkdirSync(target,{recursive:true});
  for(const name of names)cpSync(join(dir,name),join(target,name));
  dependencies.push({name:pkg.name,version:pkg.version,license:value.license,resolved:value.resolved,integrity:value.integrity,
   treeSha256:sha(JSON.stringify(inventory(dir))),licenses:names.map(name=>({path:'assets/licenses/'+pkg.name+'/'+name,sha256:sha(readFileSync(join(dir,name)))}))});
 }
 mkdirSync(join(doc,'scripts'),{recursive:true});const outputFile=join(doc,'scripts/doc-maintenance.mjs');
 const output=await build({cwd:prepared,input:'scripts/doc-maintenance.mjs',platform:'node',external:id=>id.startsWith('node:'),
  onwarn:warning=>{throw Error('Builtin bundle warning: '+warning.code);},
  output:{file:outputFile,format:'esm',codeSplitting:false,sourcemap:false,comments:false}});
 const code=readFileSync(outputFile,'utf8');
 if(output.output.length!==1||output.output[0].type!=='chunk'||output.output[0].imports.some(x=>!x.startsWith('node:'))||/\bimport\s*\(/.test(code))throw Error('Checker must be one offline Node ESM file');
 if([...code.matchAll(/__require\("([^"]+)"\)/g)].some(m=>!['process','buffer'].includes(m[1])))throw Error('External checker dependency');
 if(code.includes(root)||code.includes(scratch)||/\/Users\/|sourceMappingURL/.test(code))throw Error('Build path leaked into checker');
 chmodSync(outputFile,0o755);
 const bundler=JSON.parse(readFileSync(join(root,'node_modules/rolldown/package.json')));
 json(join(doc,'assets/source.json'),{...source,bundler:{name:'rolldown',version:bundler.version,format:'esm',codeSplitting:false,comments:false},dependencies,checker:{path:'scripts/doc-maintenance.mjs',sha256:sha(code)}});
 const skills=[['doc-maintenance','0.1.0-cothink.1'],['context-management','0.1.1'],['web-design-engineer','1.3.0']].map(([name,version])=>{
  const directory=join(base,name);for(const file of inventory(directory)){if(!file.path.startsWith('build-input/'))chmodSync(join(directory,file.path),file.path.startsWith('scripts/')?0o755:0o644);}
  return {name,version,files:inventory(directory).filter(f=>!f.path.startsWith('build-input/'))};});
 json(join(base,'manifest.json'),{schemaVersion:1,skills});
 console.log(JSON.stringify({skills:skills.map(s=>s.name),checkerSha256:sha(code),manifestSha256:sha(readFileSync(join(base,'manifest.json')))}));
} finally {rmSync(scratch,{recursive:true,force:true});}
