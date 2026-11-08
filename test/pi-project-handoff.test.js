import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {mkdtempSync,mkdirSync,cpSync,readFileSync,writeFileSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {verifiedHandoffLauncher} from '../src/project-handoff.js';

test('kernel handoff observer records a last-instant detached fork and reaps the original shell',{skip:process.platform!=='darwin'?'macOS kqueue only; no non-mac kernel proof claimed':false},async()=>{
 const binary=verifiedHandoffLauncher();
 for(const fork of [false,true]){
  const script=`process.on('message',m=>{if(m==='go'){${fork?"require('node:child_process').spawn('/usr/bin/true',[],{detached:true,stdio:'ignore'}).unref();":""}process.exit(0)}});process.send('ready')`;
  const p=spawn(binary,[process.execPath,'-e',script],{stdio:['ignore','pipe','pipe','ipc','pipe','pipe']});
  let events='',sent=false;p.stdio[4].on('data',b=>{events+=b;if(!sent&&events.includes('ARMED')){sent=true;p.send('go')}});
  p.once('message',()=>p.stdio[5].write('ARM\n'));
  const [code]=await once(p,'close');assert.equal(code,0);
  assert.match(events,fork?/FORK 1[\s\S]*EXIT_UNKNOWN 0/:/EXIT_CLEAN 0/);
 }
});

test("unsupported platforms refuse automatic native handoff",{skip:process.platform==='darwin'},()=>assert.throws(()=>verifiedHandoffLauncher(),/平台/));

test('missing, corrupt and non-executable observer artifacts never certify a host',{skip:process.platform!=='darwin'},async t=>{
 const dir=mkdtempSync(join(tmpdir(),'cothink-observer-artifacts-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 mkdirSync(join(dir,'src'));cpSync(fileURLToPath(new URL('../src/project-handoff.js',import.meta.url)),join(dir,'src/project-handoff.mjs'));
 const module=await import(pathToFileURL(join(dir,'src/project-handoff.mjs')));
 assert.throws(()=>module.verifiedHandoffLauncher(),/ENOENT/);
 cpSync(fileURLToPath(new URL('../native',import.meta.url)),join(dir,'native'),{recursive:true});
 cpSync(fileURLToPath(new URL('../vendor/project-handoff',import.meta.url)),join(dir,'vendor/project-handoff'),{recursive:true});
 const binary=join(dir,'vendor/project-handoff',`darwin-${process.arch}`,'watch');
 const bytes=readFileSync(binary);writeFileSync(binary,Buffer.concat([bytes,Buffer.from('corrupt')]));assert.throws(()=>module.verifiedHandoffLauncher(),/摘要/);
 writeFileSync(binary,bytes);chmodSync(binary,0o600);assert.throws(()=>module.verifiedHandoffLauncher(),/EACCES/);
});

test('a failed successor launcher preserves the handoff instead of reopening ordinary extensions',{skip:process.platform!=='darwin'},async t=>{
 const dir=mkdtempSync(join(tmpdir(),'cothink-successor-failure-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 for(const folder of ['src','bin','home/pi/sessions/main'])mkdirSync(join(dir,folder),{recursive:true});
 cpSync(fileURLToPath(new URL('../src/project-handoff.js',import.meta.url)),join(dir,'src/project-handoff.js'));
 cpSync(fileURLToPath(new URL('../native',import.meta.url)),join(dir,'native'),{recursive:true});
 cpSync(fileURLToPath(new URL('../vendor/project-handoff',import.meta.url)),join(dir,'vendor/project-handoff'),{recursive:true});
 writeFileSync(join(dir,'package.json'),'{"type":"module"}');
 writeFileSync(join(dir,'bin/cothink.js'),`import {runEntrypoint} from '../src/project-handoff.js';Object.defineProperty(process.stdin,'isTTY',{value:true});Object.defineProperty(process.stdout,'isTTY',{value:true});process.exitCode=await runEntrypoint();`);
 writeFileSync(join(dir,'src/cli.js'),`import fs from 'node:fs';import {createHash} from 'node:crypto';import {join} from 'node:path';import {beforeHostExtensionImport,migrateHostSession} from './project-handoff.js';
 export async function main(){const root=${JSON.stringify(dir)},home=join(root,'home');fs.appendFileSync(join(root,'ordinary-starts'),'start\\n');await beforeHostExtensionImport();
 const binary=join(root,'vendor/project-handoff/darwin-${process.arch}/watch'),manifest=binary.replace(/watch$/,'manifest.json');
 fs.writeFileSync(binary,'#!/definitely/missing/cothink-interpreter\\n');const m=JSON.parse(fs.readFileSync(manifest));m.sha256=createHash('sha256').update(fs.readFileSync(binary)).digest('hex');fs.writeFileSync(manifest,JSON.stringify(m));
 await migrateHostSession({sessionFile:join(home,'pi/sessions/main/original.jsonl'),cwd:root,leafId:null,entries:[{type:'session',id:'fixture-session',cwd:root}]});process.exit(0);}`);
 const p=spawn(process.execPath,[join(dir,'bin/cothink.js')],{env:{...process.env,COTHINK_HOME:join(dir,'home')},stdio:['pipe','pipe','pipe']});let stderr='';p.stderr.on('data',b=>stderr+=b);p.stdout.resume();
 const [code]=await once(p,'close');assert.equal(code,1,stderr);assert.match(stderr,/不回退普通会话/);assert.equal(readFileSync(join(dir,'ordinary-starts'),'utf8'),'start\n');
});
