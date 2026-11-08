// Explicit preparation only. PROJECT execution never installs missing dependencies.
import {mkdirSync,copyFileSync,cpSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('..',import.meta.url));
if(!process.argv[2])throw Error('Usage: node scripts/prepare-project-plugin-runtime.mjs <new-runtime-directory>');
const directory=resolve(process.argv[2]);
if(existsSync(join(directory,'node_modules')))throw Error('Use a new directory; existing runtime bytes are not replaced');
const bundled=join(root,'vendor/project-runtime');
if(existsSync(join(bundled,'manifest.json'))) {
  const manifest=JSON.parse(readFileSync(join(bundled,'manifest.json'))),archive=join(bundled,'runtime.tgz');
  if(createHash('sha256').update(readFileSync(archive)).digest('hex')!==manifest.archiveSha256)throw Error('Bundled runtime archive digest mismatch');
  const image=JSON.parse(execFileSync('docker',['image','inspect',manifest.image],{encoding:'utf8'}))[0];
  if(image.Os+'/'+image.Architecture!==manifest.platform)throw Error('Bundled runtime does not match the Docker platform');
  const paths=execFileSync('tar',['-tzf',archive],{encoding:'utf8',maxBuffer:64*1024*1024}).split('\n').filter(Boolean);
  if(paths.some(path=>path.startsWith('/')||path.split('/').includes('..')))throw Error('Unsafe bundled archive path');
  mkdirSync(directory,{recursive:true,mode:0o700});
  execFileSync('tar',['-xzf',archive,'-C',directory],{stdio:'inherit'});
  console.log(JSON.stringify({directory,...manifest,source:'bundled offline runtime'}));
  process.exit(0);
}
if(!existsSync(join(root,'package-lock.json')))throw Error('This package has no prepared platform runtime. Prepare from the locked source checkout; execution never installs dependencies.');
const {execution}=JSON.parse(readFileSync(join(root,'packages/agent-sync/execution-manifest.json')));
mkdirSync(directory,{recursive:true,mode:0o700});
for(const name of ['package.json','package-lock.json'])copyFileSync(join(root,name),join(directory,name));
cpSync(join(root,'vendor/pi-deps'),join(directory,'vendor/pi-deps'),{recursive:true});
execFileSync('docker',['run','--rm','--pull','never','--network','bridge','-v',directory+':/runtime','-w','/runtime',execution.image,
  'npm','ci','--omit=dev','--ignore-scripts'],{stdio:'inherit'});
const info=JSON.parse(execFileSync('docker',['image','inspect',execution.image],{encoding:'utf8'}))[0];
const manifest={image:execution.image,platform:info.Os+'/'+info.Architecture,
  pi:JSON.parse(readFileSync(join(directory,'node_modules/@earendil-works/pi-coding-agent/package.json'))).version,
  lockSha256:createHash('sha256').update(readFileSync(join(directory,'package-lock.json'))).digest('hex')};
writeFileSync(join(directory,'cothink-runtime.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({directory,...manifest}));
