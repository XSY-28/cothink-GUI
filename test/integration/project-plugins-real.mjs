import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {fixture} from '../helpers/pi-fixture.js';
import {invoke} from '../helpers/cli-fixture.js';
import {execution} from '../helpers/agent-sync-fixture.js';
const productRoot=resolve(process.env.COTHINK_TEST_PACKAGE_ROOT??fileURLToPath(new URL('../..',import.meta.url)));
const {createProjectPluginRuntime}=await import(pathToFileURL(join(productRoot,'src/project-plugin-runtime.js')));

for(const sample of [
  {source:'npm:@xynogen/pix-read@0.4.8',entry:'node_modules/@xynogen/pix-read/src/extension.ts',write:false},
  {source:'npm:pi-hashline-edit-pro@7.1.1',entry:'node_modules/pi-hashline-edit-pro/index.ts',write:true},
])test(`actual installed ${sample.source} uses Pi API in offline container`,{timeout:60000},async t=>{
  const f=await fixture(t);
  const installed=await invoke(f,['install',sample.source,'--json']);
  assert.equal(installed.code,0,installed.stdout+installed.stderr);
  const workspace=join(f.home,'controlled-source');mkdirSync(workspace);writeFileSync(join(workspace,'input.txt'),'original input\n');
  const record={requests:[]};
  const runtime=await createProjectPluginRuntime({execution,runtimeDirectory:process.env.COTHINK_TEST_PLUGIN_RUNTIME,
    codeDirectory:join(f.home,'pi/npm'),extensions:[sample.entry],workspace,readOnly:!sample.write,
    record,save(){},authorize(){},onOperation(action){if(action==='ui.notify')return;throw Error('Unexpected host API '+action);}});
  t.after(()=>runtime.stop());
  const value=await runtime.call('read',{path:'input.txt'},'read-input');
  assert.match(JSON.stringify(value),/original input/);
  if(sample.write) {
    const anchor=value.structuredContent.lines[0].anchor;
    const result=await runtime.call('replace',{path:'input.txt',remove_from:anchor,remove_to:anchor,text:'actual third party edit'},'edit-input');
    assert.equal(result.isError,false,JSON.stringify(result));
    await runtime.freeze();
    assert.equal(readFileSync(join(workspace,'input.txt'),'utf8'),'actual third party edit\n');
  }
  assert.equal(f.calls.length,0,'No paid or fixture model call is needed for API compatibility');
  assert.equal((await runtime.stop()).stopped,true);
});
