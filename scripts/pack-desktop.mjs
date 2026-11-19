/** Isolated desktop candidate built from the shared backend tarball. */
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,cpSync,readdirSync,lstatSync,readlinkSync,renameSync,rmSync,chmodSync,existsSync} from 'node:fs';
import {join,resolve,basename,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),root=fileURLToPath(new URL('..',import.meta.url));
const manifest=JSON.parse(readFileSync(join(root,'desktop/runtime-manifest.json')));
const pkg=JSON.parse(readFileSync(join(root,'package.json')));
const {platform,arch}=process;
const target=`${platform}-${arch}`;
const windows=platform==='win32'?manifest.windows[arch]:undefined;
const isMac=platform===manifest.target.platform&&arch===manifest.target.arch;
if(!isMac&&!windows)throw Error(`Unsupported desktop build host: ${target}`);
const nodeFolder=windows?`node-v${manifest.node.version}-win-${arch}`:manifest.node.archive.replace('.tar.gz','');
const nodeExecutable=windows?'node.exe':'node';
const nodeMember=windows?join(nodeFolder,nodeExecutable):manifest.node.executable;
const electronArchive=windows?`electron-v${manifest.electron.version}-${target}.zip`:manifest.electron.archive;
const archives={
 node:{name:windows?`${nodeFolder}.zip`:manifest.node.archive,sha256:windows?.nodeSha256??manifest.node.sha256},
 electron:{name:electronArchive,sha256:windows?.electronSha256??manifest.electron.sha256},
};
const args=process.argv.slice(2),options={};
for(let i=0;i<args.length;i+=2){if(!['--node-archive','--electron-archive','--out'].includes(args[i]) || !args[i+1] || options[args[i]])throw Error('Use npm run pack:desktop -- --node-archive <official archive> --electron-archive <official.zip> --out <new-directory>');options[args[i]]=resolve(args[i+1]);}
const sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
for(const [name,archive] of Object.entries(archives)){
 const path=options[`--${name}-archive`];
 if(!path||sha(path)!==archive.sha256)throw Error(`Expected ${archive.name} with the frozen SHA-256`);
}
const out=options['--out']??join(root,'dist',isMac?'desktop.noindex':'desktop');
if(isMac&&!out.split(/[\\/]/).some(part=>part.endsWith('.noindex')))
 throw Error('Desktop candidates must be inside a .noindex directory to avoid duplicate Spotlight apps. Use --out <candidate.noindex>; only the installed App belongs in /Applications.');
const candidate=join(out,`CoThink-${target}`);
if(existsSync(candidate))throw Error('Candidate exists; choose a new output directory (never overwrite an inspected App)');
const scratch=mkdtempSync(join(tmpdir(),'cothink-desktop-pack-'));
let windowsStage;
const run=(cmd,argv,cwd=scratch)=>execFileSync(cmd,argv,{cwd,stdio:['ignore','pipe','pipe'],maxBuffer:64*1024*1024,env:{...process.env,COPYFILE_DISABLE:'1'}});
function inventory(root,prefix='') {
 const result=[];
 for(const name of readdirSync(root).sort()){
  const path=join(root,name),rel=prefix+name,stat=lstatSync(path);
  if(stat.isSymbolicLink())result.push({path:rel,link:readlinkSync(path)});
  else if(stat.isDirectory())result.push(...inventory(path,rel+'/'));
  else if(stat.isFile())result.push({path:rel,size:stat.size,sha256:sha(path)});
 }
 return result;
}
try {
 const npm=process.env.npm_execpath;if(!npm)throw Error('Run through npm run pack:desktop');
 console.error('Building the shared backend consumer tarball…');
 const result=JSON.parse(run(process.execPath,[npm,'run','--silent','pack:npm','--',join(scratch,'packed')],root).toString());
 const archive=join(scratch,'packed',result[0].filename);
 run('tar',['-xzf',archive]);
 const stage=join(scratch,'app');mkdirSync(stage);
 for(const name of ['main.cjs','preload.cjs','host.mjs','runtime-manifest.json','assets'])cpSync(join(root,'desktop',name),join(stage,name),{recursive:true});
 cpSync(join(scratch,'package'),join(stage,'backend'),{recursive:true,verbatimSymlinks:true});
 const shell=JSON.parse(readFileSync(join(root,'desktop/package.json')));shell.version=pkg.version;delete shell.private;
 writeFileSync(join(stage,'package.json'),JSON.stringify(shell,null,2)+'\n');
 for(const required of ['src/gui-server.js','gui/dist/index.html','node_modules/@earendil-works/pi-coding-agent/package.json','vendor/project-handoff/manifest.json']){
  // The handoff artifact's own layout differs by platform; inventory below is authoritative.
  if(required.includes('project-handoff'))continue;
  if(!existsSync(join(stage,'backend',required)))throw Error('Missing backend distribution resource: '+required);
 }
 run('tar',['-xf',options['--node-archive']]);
 const node=join(scratch,'node');mkdirSync(join(node,'bin'),{recursive:true});
 const bundledNode=join(node,'bin',nodeExecutable);
 cpSync(join(scratch,nodeMember),bundledNode);chmodSync(bundledNode,0o755);
 cpSync(join(scratch,nodeFolder,'LICENSE'),join(node,'LICENSE'));
 const identity=run(bundledNode,['-p','[process.platform,process.arch,process.version].join("/")']).toString().trim();
 if(identity!==`${platform}/${arch}/v${manifest.node.version}`)throw Error('Bundled Node platform, architecture or version mismatch');
 const files=[...inventory(stage,'app/'),...inventory(node,'node/')];
 const buildId=createHash('sha256').update(JSON.stringify({backendArchiveSha256:sha(archive),files})).digest('hex');
 const build={buildId,target,backendVersion:pkg.version,protocolVersion:manifest.protocolVersion,backendArchiveSha256:sha(archive),nodeVersion:manifest.node.version,electronVersion:manifest.electron.version};
 writeFileSync(join(stage,'build.json'),JSON.stringify(build,null,2)+'\n');
 const skillManifest=join(stage,'backend/resources/builtin-skills/manifest.json');
 writeFileSync(join(stage,'distribution.json'),JSON.stringify({schemaVersion:1,...build,files,externalDependencies:['Git for file projects','Docker and a fixed image for managed execution'],builtinSkills:{manifest:'backend/resources/builtin-skills/manifest.json',sha256:sha(skillManifest),names:JSON.parse(readFileSync(skillManifest)).skills.map(s=>s.name)}},null,2)+'\n');
 let app,resources;
 if(windows) {
  // Use Windows' archive tool so a build needs no additional C++ runtime for Electron Packager's ZIP binding.
  mkdirSync(out,{recursive:true});
  windowsStage=mkdtempSync(join(out,'.cothink-packing-'));
  run('tar.exe',['-xf',options['--electron-archive'],'-C',windowsStage]);
  renameSync(join(windowsStage,'electron.exe'),join(windowsStage,'CoThink.exe'));
  resources=join(windowsStage,'resources');
  rmSync(join(resources,'default_app.asar'),{force:true});
  cpSync(stage,join(resources,'app'),{recursive:true,verbatimSymlinks:true});
  cpSync(node,join(resources,'node'),{recursive:true});
  app=join(candidate,'CoThink.exe');
 } else {
  const {packager}=await import('@electron/packager');
  const zipDir=join(scratch,'electron');mkdirSync(zipDir);cpSync(options['--electron-archive'],join(zipDir,electronArchive));
  const paths=await packager({...require(join(root,'desktop/packager.config.cjs')),dir:stage,out,
   electronVersion:manifest.electron.version,electronZipDir:zipDir,icon:join(root,'desktop/assets/icon.icns'),extraResource:[node]});
  app=join(paths[0],'CoThink.app');
  resources=join(app,'Contents','Resources');
 }
 // Re-read the actual packaged resource bytes, including native dependencies and Node.
 for(const item of files){const path=join(resources,item.path);const actual=item.link?readlinkSync(path):sha(path);if(actual!==(item.link??item.sha256))throw Error('Packaged resource mismatch: '+item.path);}
 const proof={...build,app,verifiedFiles:files.length,distributionSha256:sha(join(resources,'app/distribution.json')),signed:false,notarized:false};
 if(windowsStage)renameSync(windowsStage,candidate);
 mkdirSync(out,{recursive:true});writeFileSync(join(out,'desktop-build.json'),JSON.stringify(proof,null,2)+'\n');
 console.log(JSON.stringify(proof,null,2));
} finally {
 if(windowsStage)rmSync(windowsStage,{recursive:true,force:true});
 rmSync(scratch,{recursive:true,force:true});
}
