import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {writeFileSync,readFileSync,unlinkSync,symlinkSync,linkSync,renameSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync,execFileSync} from 'node:child_process';
import {repository} from './helpers/git-fixture.js';
const packageRoot=resolve(process.env.COTHINK_TEST_PACKAGE_ROOT??fileURLToPath(new URL('..',import.meta.url)));
const load=path=>import(pathToFileURL(join(packageRoot,path)));
const {createVersioning}=await load('src/versioning.js');
const {guiFiles,guiFile,guiFileDiff,FILE_LIMITS,validateFilePath,splitFileDiff}=await load('src/gui-files.js');
const {startGuiServer}=await load('src/gui-server.js');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
async function prepared(t){
  const cleanup=[];const f=repository({after:fn=>cleanup.push(fn)}),v=await createVersioning({...f,checks:[]});t.after(async()=>{await v.close();for(const fn of cleanup)await fn();});
  async function publish(contents,modes={}){
    const start=(await v.inspect()).version;
    const c=await v.beginChange({requestId:randomUUID(),actor:'gui-files',intent:'file contract fixture',scope:['.']});
    const edits=[];
    for(const [path,content] of Object.entries(contents)) {const old=await v.read({changeId:c.changeId,path});edits.push({path,oldHash:old.contentHash,contentBase64:content===null?null:Buffer.from(content).toString('base64'),...(modes[path]?{mode:modes[path]}:{})});}
    await v.edit(c.changeId,{requestId:randomUUID(),expectedVersion:c.privateVersion,edits});
    const p=await v.prepareChange(c.changeId,{requestId:randomUUID()});const a=await v.acceptChange({requestId:randomUUID(),changeId:c.changeId,candidateVersion:p.candidateVersion});
    const result=await v.beginChange({requestId:randomUUID(),actor:'result',intent:'read only final result',scope:[],readScope:['.'],readOnly:true});
    return {id:randomUUID(),work:{root:f.project,backend:'agent-sync',toolHome:v.toolHome,startVersion:start,version:a.acceptedVersion,resultWorkspace:result.workspace,resultChangeId:result.changeId}};
  }
  return {...f,v,publish};
}
const ref=(r,path)=>({taskId:r.id,version:r.work.version,path});

test("session search keeps a real file match when conversation text matches too", async t=>{
  const f = await prepared(t);
  const filename = "accepted-notes.txt", secondFile = "accepted-table.txt";
  const published = await f.publish({[filename]:"accepted file body\n",[secondFile]:"accepted table body\n"});
  const {SessionManager} = await load("node_modules/@earendil-works/pi-coding-agent/dist/index.js");
  const {createTask} = await load("src/task.js");
  function seedSession(title,input,work) {
    const manager = SessionManager.create(f.project,join(f.home,"pi/sessions/main"));
    const id = manager.getSessionId();
    manager.appendCustomEntry("cothink-title",{title});
    const task = createTask({home:f.home,input,sessionId:id,models:{main:{provider:"fixture",modelId:"main"},secondary:[]}});
    if(work) task.record.work=work;
    task.finish("completed");
    manager.appendCustomEntry("cothink-task",{taskId:task.record.id});
    manager.appendMessage({role:"user",content:input,timestamp:Date.now()});
    return {id,taskId:task.record.id};
  }
  const delivery = seedSession(filename+" 交付",`请交付 ${filename} 与 ${secondFile}`,published.work);
  const chat = seedSession("文件名讨论","请说明 "+filename+" 的命名。");
  const host = await startGuiServer({home:f.home,cwd:f.project,suggestedProject:null,open:false});
  t.after(()=>host.close());
  async function page(queryText, cursor) {
    const query = new URLSearchParams({query:queryText,limit:"1"});
    if(cursor) query.set("cursor",cursor);
    const response = await fetch(host.origin+"/api/sessions?"+query,{headers:{Authorization:"Bearer "+host.token}});
    assert.equal(response.status,200);
    return response.json();
  }
  const first = await page(filename);
  assert.ok(first.nextCursor,"a second matching conversation is paginated");
  const second = await page(filename,first.nextCursor);
  assert.equal(second.nextCursor,null);
  const rows = [...first.items,...second.items];
  assert.deepEqual(new Set(rows.map(row=>row.id)),new Set([delivery.id,chat.id]));
  const match = rows.find(row=>row.id===delivery.id).match;
  assert.equal(match.field,"file");
  assert.deepEqual(match.fileRef,{taskId:delivery.taskId,version:published.work.version,path:filename});
  assert.equal(rows.find(row=>row.id===chat.id).match.field,"input");
  const inputMatch = await page(secondFile);
  assert.equal(inputMatch.nextCursor,null);
  assert.equal(inputMatch.items[0].match.field,"file","a message-only match cannot hide the accepted file either");
  assert.equal(inputMatch.items[0].match.fileRef.path,secondFile);
});

test('fixed task files preserve original bytes after newer versions, with honest deleted/binary/quoted diffs',async t=>{
  const f=await prepared(t), name='中文 空格/a "quote".txt';
  const old=await f.publish({'a.txt':'first\n','b.txt':null,[name]:'line\ndiff --git trick\n','binary.bin':Buffer.from([0,255,1,2])});
  const list=await guiFiles(f.home,old);
  assert.equal(list.items.find(i=>i.name==='b.txt').status,'deleted');
  assert.equal(list.items.find(i=>i.name===name).status,'added');
  const newer=await f.publish({'a.txt':'second\n'});
  assert.equal((await guiFile(f.home,old,ref(old,'a.txt'),{purpose:'source'})).bytes.toString(),'first\n');
  assert.equal((await guiFile(f.home,newer,ref(newer,'a.txt'))).bytes.toString(),'second\n');
  const binary=await guiFile(f.home,old,ref(old,'binary.bin'),{purpose:'download'});
  assert.deepEqual(binary.bytes,Buffer.from([0,255,1,2]));
  assert.equal(binary.contentHash,createHash('sha256').update(binary.bytes).digest('hex'));
  await assert.rejects(guiFile(f.home,old,ref(old,'b.txt'),{purpose:'download'}),{code:'FILE_DELETED'});
  await assert.rejects(guiFile(f.home,old,{...ref(old,'a.txt'),version:newer.work.version}),{code:'FILE_VERSION_MISMATCH'});
  const quoted=await guiFileDiff(f.home,old,ref(old,name));assert.match(quoted.patch,/\+line/);assert.equal(quoted.path,name);
  const deleted=await guiFileDiff(f.home,old,ref(old,'b.txt'));assert.equal(deleted.after,null);
  assert.equal((await guiFileDiff(f.home,old,ref(old,'binary.bin'))).binary,true);
  const mode=await f.publish({'a.txt':'second\n'},{'a.txt':'100755'});
  assert.equal((await guiFiles(f.home,mode)).items[0].status,'modeChanged');
  assert.match((await guiFileDiff(f.home,mode,ref(mode,'a.txt'))).patch,/new mode 100755/);
  assert.equal(readFileSync(join(f.project,'a.txt'),'utf8'),'base A\n');
});

test('file reads reject traversal, changed bytes, links, unavailable results and purpose-specific size before returning content',async t=>{
  const f=await prepared(t),r=await f.publish({'a.txt':'saved\n','dir/a.txt':'saved\n','large.txt':Buffer.alloc(FILE_LIMITS.textBytes+1,97)});
  for(const path of ['../a','/etc/passwd','a//b','a/../b','CON.txt','x.','x ','e\u0301.txt','a\\b','C:/x'])assert.throws(()=>validateFilePath(path),{code:'FILE_PATH_INVALID'});
  await assert.rejects(guiFile(f.home,r,ref(r,'large.txt')),{code:'FILE_TOO_LARGE'});
  assert.equal((await guiFile(f.home,r,ref(r,'large.txt'),{purpose:'download'})).bytes.length,FILE_LIMITS.textBytes+1);
  const path=join(r.work.resultWorkspace,'a.txt');writeFileSync(path,'other\n');
  await assert.rejects(guiFile(f.home,r,ref(r,'a.txt')),{code:'FILE_IDENTITY_MISMATCH'});writeFileSync(path,'saved\n');
  const outside=join(f.root,'outside');writeFileSync(outside,'saved\n');unlinkSync(path);symlinkSync(outside,path);
  await assert.rejects(guiFile(f.home,r,ref(r,'a.txt')),{code:'FILE_PATH_INVALID'});unlinkSync(path);linkSync(outside,path);
  await assert.rejects(guiFile(f.home,r,ref(r,'a.txt')),{code:'FILE_PATH_INVALID'});unlinkSync(path);writeFileSync(path,'saved\n');
  if(process.platform!=='win32') {
    unlinkSync(path);execFileSync('mkfifo',[path]);
    const moduleUrl=pathToFileURL(join(packageRoot,'src/gui-files.js')).href;
    const child=spawnSync(process.execPath,['--input-type=module','-e',
      `const {guiFile}=await import(process.argv[1]);const [home,record,ref]=JSON.parse(process.argv[2]);try{await guiFile(home,record,ref);process.exitCode=1;}catch(e){if(e.code!=='FILE_PATH_INVALID')throw e;console.log(e.code);}`,
      moduleUrl,JSON.stringify([f.home,r,ref(r,'a.txt')])],{timeout:5000,encoding:'utf8'});
    assert.equal(child.error,undefined,'FIFO refusal must not block the host');assert.equal(child.status,0,child.stderr);assert.match(child.stdout,/FILE_PATH_INVALID/);
    unlinkSync(path);writeFileSync(path,'saved\n');
  }
  const dir=join(r.work.resultWorkspace,'dir');renameSync(dir,dir+'-moved');symlinkSync(dir+'-moved',dir);
  await assert.rejects(guiFile(f.home,r,ref(r,'dir/a.txt')),{code:'FILE_PATH_INVALID'});
  await assert.rejects(guiFile(f.home,{...r,work:{...r.work,resultChangeId:null}},ref(r,'a.txt')),{code:'FILE_UNAVAILABLE'});
  await assert.rejects(guiFile(f.home,r,ref(r,'a.txt'),{purpose:'arbitrary'}),{code:'FILE_PURPOSE_INVALID'});
});

test('static preview closes over verified relative images and CSS; raw download remains unchanged and unsafe structures fall back',async t=>{
  const f=await prepared(t);
  const good='<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="../style.css"><h1>中文</h1><a href="https://example.invalid">disabled</a><img src="../图片%20空格.png">';
  const cases={script:'<script>alert(1)</script>',event:'<img src="../图片%20空格.png" onerror="alert(1)">',external:'<img src="https://example.invalid/a.png">',css:'<style>p{background:u/**/rl(https://example.invalid)}</style>',frame:'<iframe srcdoc="hi"></iframe>',refresh:'<meta http-equiv="refresh" content="0;https://example.invalid">',form:'<form action="/api/action"></form>',encoded:'<img src="..%2f图片%20空格.png">',missing:'<img src="missing.png">',cssEscape:'<style>p{background:u\\72l(x)}</style>',svg:'<svg><foreignObject/></svg>'};
  const contents={'web/page.html':good,'style.css':'h1 {color:rgb(20,30,40)}','图片 空格.png':png,'shape.svg':'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect width="20" height="20" fill="url(#g)"/></svg>'};
  for(const [name,value]of Object.entries(cases))contents[`web/${name}.html`]=value;
  const r=await f.publish(contents), preview=await guiFile(f.home,r,ref(r,'web/page.html'),{purpose:'preview'});
  assert.equal(preview.representation,'static-preview');const html=preview.bytes.toString();
  assert.match(html,/Content-Security-Policy/);assert.match(html,/data:image\/png;base64,/);assert.match(html,/color:rgb/);assert.doesNotMatch(html,/href="https/);
  assert.notEqual(preview.contentHash,preview.sourceContentHash);
  assert.equal((await guiFile(f.home,r,ref(r,'web/page.html'),{purpose:'download'})).bytes.toString(),good);
  assert.equal((await guiFile(f.home,r,ref(r,'shape.svg'),{purpose:'preview'})).representation,'static-preview');
  for(const name of Object.keys(cases))await assert.rejects(guiFile(f.home,r,ref(r,`web/${name}.html`),{purpose:'preview'}),{code:'STATIC_PREVIEW_UNSUPPORTED'},name);
  const h=await startGuiServer({home:f.home,open:false,controller:{file:(fileRef,options)=>guiFile(f.home,r,fileRef,options),files:()=>guiFiles(f.home,r),fileDiff:fileRef=>guiFileDiff(f.home,r,fileRef),close:async()=>{}}});t.after(()=>h.close());
  const origin=new URL(h.url).origin,headers={Authorization:`Bearer ${h.token}`};
  const url='/api/file?'+new URLSearchParams({...ref(r,'web/page.html'),purpose:'download'});
  assert.equal((await fetch(origin+url)).status,403);
  const response=await fetch(origin+url,{headers});assert.equal(response.status,200);assert.equal(await response.text(),good);
  assert.match(response.headers.get('content-disposition'),/^attachment;/);assert.equal(response.headers.get('content-length'),String(Buffer.byteLength(good)));
  assert.match(response.headers.get('content-security-policy'),/frame-src blob:/);
  const unsafe=await fetch(origin+'/api/file?'+new URLSearchParams({...ref(r,'web/script.html'),purpose:'preview'}),{headers});assert.equal((await unsafe.json()).code,'STATIC_PREVIEW_UNSUPPORTED');
});

test('diff splitter refuses a mismatched section instead of assigning it to a clicked file',()=>{
  const entry={path:'a.txt',mode:'100644',object:'a'.repeat(40)},s={before:new Map(),after:new Map([['a.txt',entry]]),fromVersion:'a',toVersion:'b'};
  assert.match(splitFileDiff({files:['a.txt'],text:'diff --git a/other b/other\nnew file mode 100644\n',binaryFiles:[]},s).warning,/可靠/);
});

test('static preview enforces aggregate bytes and resource count on the server before publishing any representation',async t=>{
  const f=await prepared(t),contents={};
  const image=Buffer.concat([png,Buffer.alloc(2*1024*1024-png.length)]);
  for(let i=0;i<4;i++)contents[`large${i}.png`]=image;
  contents['bytes.html']=Array.from({length:4},(_,i)=>`<img src="large${i}.png">`).join('');
  for(let i=0;i<65;i++)contents[`tiny${i}.png`]=png;
  contents['count.html']=Array.from({length:65},(_,i)=>`<img src="tiny${i}.png">`).join('');
  const r=await f.publish(contents);
  for(const path of ['bytes.html','count.html'])await assert.rejects(guiFile(f.home,r,ref(r,path),{purpose:'preview'}),{code:'FILE_TOO_LARGE'});
});
