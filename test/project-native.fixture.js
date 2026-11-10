import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

export const productRoot=resolve(process.env.COTHINK_TEST_PACKAGE_ROOT??fileURLToPath(new URL('..',import.meta.url)));
export const {saveConfig}=await import(pathToFileURL(join(productRoot,'src/config.js')));
export const {listTasks}=await import(pathToFileURL(join(productRoot,'src/task.js')));
export const tool=(name,args={})=>({toolCalls:[{name,args}]});
export const runtime=process.env.COTHINK_TEST_PLUGIN_RUNTIME;
export function installNative(f){
 const root=process.env.COTHINK_TEST_NATIVE_HOME;if(!root)throw Error('Set COTHINK_TEST_NATIVE_HOME to a prepared Pi directory containing original pi-subagents@0.84.0 npm/ and settings.json; prepare it with the normal cothink install command.');
 cpSync(join(root,'npm'),join(f.home,'pi/npm'),{recursive:true});cpSync(join(root,'settings.json'),join(f.home,'pi/settings.json'));
}
export function evidence(name,value){const directory=process.env.COTHINK_TEST_EVIDENCE_DIR;if(!directory)return;mkdirSync(directory,{recursive:true});writeFileSync(join(directory,name),JSON.stringify(value,null,2));}
