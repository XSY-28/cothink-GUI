import { readdirSync } from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {fixture} from './helpers/pi-fixture.js';
import { fixtureConversation, fixtureWorkspace } from './helpers/gui-controller-fixture.js';
import {saveConfig} from '../src/config.js';
import {createTeamConfig} from '../src/teams.js';
import {createGuiController} from '../src/gui-controller.js';

const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
export const answer=text=>({role:'assistant',api:'openai-completions',provider:'fixture',model:'main',content:[{type:'text',text}],stopReason:'stop',usage,timestamp:Date.now()});
export async function setup(t,handler,split=false,pairs=14){
 const f=await fixture(t,handler),defaultRosterId=randomUUID();saveConfig(f.home,createTeamConfig({formatVersion:2,...f.models},'Fixture',defaultRosterId));
 let c=await createGuiController({home:f.home,cwd:f.cwd});const workspace=await fixtureWorkspace(t,c,{defaultRosterId}),s=await fixtureConversation(t,c,{workspace});await c.close();
 const path=join(f.home,'pi/sessions/main',readdirSync(join(f.home,'pi/sessions/main')).find(n=>n.endsWith('.jsonl'))),m=SessionManager.open(path);
 m.appendCustomMessageEntry('cothink-task-status','OLD_PROCESS_MUST_NOT_BE_SUMMARIZED',false);
 if(split){m.appendMessage({role:'user',content:'old '.repeat(1800),timestamp:Date.now()});m.appendMessage(answer('done '.repeat(1800)));m.appendMessage({role:'user',content:'Current goal',timestamp:Date.now()});for(let i=0;i<28;i++)m.appendMessage(answer('observed '.repeat(650)));}
 else for(let i=0;i<pairs;i++){m.appendMessage({role:'user',content:'User request '+i+'. '+'material '.repeat(650),timestamp:Date.now()});m.appendMessage(answer('Response '+i+'. '+'evidence '.repeat(650)));}
 m.appendThinkingLevelChange('off');
 c=await createGuiController({home:f.home,cwd:f.cwd});t.after(()=>c.close());return {f,c,s,path,workspace,leaf:m.getLeafId()};
}
export async function settled(c,id){for(let i=0;i<500;i++){const v=await c.readContextOperation(id);if(!['running','preparing','cancelling'].includes(v.status))return v;await new Promise(r=>setTimeout(r,10));}throw Error('context operation did not settle');}
