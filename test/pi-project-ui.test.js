import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {fixture} from './helpers/pi-fixture.js';
import {repository} from './helpers/git-fixture.js';
import {invoke} from './helpers/cli-fixture.js';
import {execution} from './helpers/agent-sync-fixture.js';
const root=resolve(process.env.COTHINK_TEST_PACKAGE_ROOT??fileURLToPath(new URL('..',import.meta.url)));
const {projectChat}=await import(pathToFileURL(join(root,'src/project-chat.js')));
const {saveConfig}=await import(pathToFileURL(join(root,'src/config.js')));
const {listTasks}=await import(pathToFileURL(join(root,'src/task.js')));

test('confirmed PROJECT terminal controller passes select/input/confirm/notify through the actual plugin container',{timeout:60000},async t=>{
  const repo=repository(t);let source,draft,error;const seen=[];
  const f=await fixture(t,({body},n)=>{
    if(n===1)return {text:JSON.stringify({plugins:[source],scope:['a.txt'],budget:{maxCalls:2},deliverables:['a.txt'],checks:[{command:'node',args:['-e',"require('fs').accessSync('a.txt')"]}]})};
    if(n===2)return {toolCalls:[{name:'project_plugin_0_dialog',args:{}}]};
    try{assert.match(JSON.stringify(body.messages),/CHOSEN.*ENTERED.*true/);}catch(e){error=e;}
    return {text:'Reviewed actual selected plugin dialog replies.'};
  });
  const path=join(f.home,'ui-plugin');mkdirSync(path);writeFileSync(join(path,'package.json'),JSON.stringify({name:'project-dialog',version:'1.0.0',type:'module',pi:{extensions:['extension.mjs']}}));
  writeFileSync(join(path,'extension.mjs'),`export default pi=>pi.registerTool({name:'dialog',label:'dialog',description:'Select a local task option',parameters:{type:'object',properties:{}},execute:async(id,args,signal,update,ctx)=>{const selected=await ctx.ui.select('PROJECT_SELECT',['CHOSEN']);const input=await ctx.ui.input('PROJECT_INPUT');const confirmed=await ctx.ui.confirm('PROJECT_CONFIRM','Use selected local task values?');await ctx.ui.notify('PROJECT_NOTIFY'+String.fromCharCode(27)+'[31m','info');return {content:[{type:'text',text:JSON.stringify({selected,input,confirmed})}]};}});`);
  const install=await invoke(f,['install',path,'--json']);assert.equal(install.code,0,install.stdout+install.stderr);source=JSON.parse(install.stdout).packages[0].source;
  const config={formatVersion:2,...f.models,work:{execution,projectPluginRuntime:process.env.COTHINK_TEST_PLUGIN_RUNTIME}};saveConfig(f.home,config);
  const uiContext={select:async title=>{seen.push(title);return 'CHOSEN';},input:async title=>{seen.push(title);return 'ENTERED';},confirm:async title=>{seen.push(title);return true;},notify:title=>seen.push(title)};
  const send=text=>projectChat({home:f.home,cwd:repo.project,config,text,uiContext,draft,signal:new AbortController().signal,saveDraft:v=>{draft=v;},report(){},onTask(){},chooseStep(){throw Error('Unexpected step');}});
  await send('Use the selected project-dialog plugin for local options, then check a.txt.');assert.equal(seen.length,0,'Planning must not invoke plugin UI');
  await send('开始');if(error)throw error;assert.deepEqual(seen,['PROJECT_SELECT','PROJECT_INPUT','PROJECT_CONFIRM','PROJECT_NOTIFY⟦U+001B⟧[31m']);
  assert.equal(listTasks(f.home).find(task=>task.project).status,'completed');assert.equal(f.calls.length,3);
});
