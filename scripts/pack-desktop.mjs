/** Isolated macOS candidate: consumes the same backend tarball, never user data. */
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,cpSync,readdirSync,lstatSync,readlinkSync,rmSync,chmodSync,existsSync} from 'node:fs';
import {join,resolve,basename,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {packager} from '@electron/packager';
const require=createRequire(import.meta.url),root=fileURLToPath(new URL('..',import.meta.url));
const manifest=JSON.parse(readFileSync(join(root,'desktop/runtime-manifest.json')));
const pkg=JSON.parse(readFileSync(join(root,'package.json')));
const args=process.argv.slice(2),options={};
for(let i=0;i<args.length;i+=2){if(!['--node-archive','--electron-archive','--out'].includes(args[i]) || !args[i+1] || options[args[i]])throw Error('Use npm run pack:desktop -- --node-archive <official.tar.gz> --electron-archive <official.zip> --out <new-directory>');options[args[i]]=resolve(args[i+1]);}
if(process.platform!==manifest.target.platform||process.arch!==manifest.target.arch)throw Error('Only the frozen darwin-arm64 target has been verified');
const sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
for(const name of ['node','electron']){const path=options[`--${name}-archive`];if(!path||sha(path)!==manifest[name].sha256)throw Error(`${name} archive does not match frozen SHA-256`);}
const out=options['--out']??join(root,'dist/desktop.noindex');
if(!out.split(/[\\/]/).some(part=>part.endsWith('.noindex')))
 throw Error('Desktop candidates must be inside a .noindex directory to avoid duplicate Spotlight apps. Use --out <candidate.noindex>; only the installed App belongs in /Applications.');
if(existsSync(join(out,'CoThink-darwin-arm64')))throw Error('Candidate exists; choose a new output directory (never overwrite an inspected App)');
const scratch=mkdtempSync(join(tmpdir(),'cothink-desktop-pack-'));
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
 run('tar',['-xzf',options['--node-archive']]);
 const node=join(scratch,'node');mkdirSync(join(node,'bin'),{recursive:true});
 cpSync(join(scratch,manifest.node.executable),join(node,'bin/node'));chmodSync(join(node,'bin/node'),0o755);
 cpSync(join(scratch,manifest.node.archive.replace('.tar.gz',''),'LICENSE'),join(node,'LICENSE'));
 if(run(join(node,'bin/node'),['--version']).toString().trim()!==`v${manifest.node.version}`)throw Error('Bundled Node version mismatch');
 const files=[...inventory(stage,'app/'),...inventory(node,'node/')];
 const buildId=createHash('sha256').update(JSON.stringify({backendArchiveSha256:sha(archive),files})).digest('hex');
 const build={buildId,backendVersion:pkg.version,protocolVersion:manifest.protocolVersion,backendArchiveSha256:sha(archive),nodeVersion:manifest.node.version,electronVersion:manifest.electron.version};
 writeFileSync(join(stage,'build.json'),JSON.stringify(build,null,2)+'\n');
 const skillManifest=join(stage,'backend/resources/builtin-skills/manifest.json');
 writeFileSync(join(stage,'distribution.json'),JSON.stringify({schemaVersion:1,...build,files,externalDependencies:['Git for file projects','Docker and a fixed image for managed execution'],builtinSkills:{manifest:'backend/resources/builtin-skills/manifest.json',sha256:sha(skillManifest),names:JSON.parse(readFileSync(skillManifest)).skills.map(s=>s.name)}},null,2)+'\n');
 const zipDir=join(scratch,'electron');mkdirSync(zipDir);cpSync(options['--electron-archive'],join(zipDir,manifest.electron.archive));
 const paths=await packager({...require(join(root,'desktop/packager.config.cjs')),dir:stage,out,
  electronVersion:manifest.electron.version,electronZipDir:zipDir,icon:join(root,'desktop/assets/icon.icns'),extraResource:[node]});
 const app=join(paths[0],'CoThink.app');
 const resources=join(app,'Contents/Resources');
 // Re-read the actual packaged resource bytes, including native dependencies and Node.
 for(const item of files){const path=join(resources,item.path);const actual=item.link?readlinkSync(path):sha(path);if(actual!==(item.link??item.sha256))throw Error('Packaged resource mismatch: '+item.path);}
 const proof={...build,app,verifiedFiles:files.length,distributionSha256:sha(join(resources,'app/distribution.json')),signed:false,notarized:false};
 mkdirSync(out,{recursive:true});writeFileSync(join(out,'desktop-build.json'),JSON.stringify(proof,null,2)+'\n');
 console.log(JSON.stringify(proof,null,2));
} finally {rmSync(scratch,{recursive:true,force:true});}
