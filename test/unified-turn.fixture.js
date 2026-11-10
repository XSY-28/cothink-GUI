import {join} from 'node:path';
import {fixture} from './helpers/pi-fixture.js';

export const opts=f=>({home:f.home,cwd:f.cwd,input:'question',frozenConfig:{formatVersion:2,...f.models},workspace:{id:null,project:null}});

export async function frozenInputFixture(t, respond, imageModels=['main','r1']) {
 const f=await fixture(t,respond);
 const fs=await import('node:fs'),{createHash,randomUUID}=await import('node:crypto'),{createGuiMaterialStore}=await import('../src/gui-materials.js');
 const path=join(f.home,'pi','models.json'),config=JSON.parse(fs.readFileSync(path,'utf8'));
 for(const m of config.providers.fixture.models)if(imageModels.includes(m.id))m.input.push('image');
 fs.writeFileSync(path,JSON.stringify(config));
 const store=createGuiMaterialStore(f.home),ownerId=randomUUID();
 const put=async(name,mediaType,bytes)=>{
  const intent={ownerId,uploadId:randomUUID(),name,mediaType,byteLength:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  store.begin(intent);const saved=await store.publish({...intent,body:bytes});return store.read(saved);
 };
 const image=await put('proof.png','image/png',Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAFElEQVR42mNklAtgYGBgYmBgQFAACEIAdYij2wsAAAAASUVORK5CYII=','base64'));
 const text=await put('notes.md','text/markdown',Buffer.from('Exact material text 你好'));
 return {f,image,text,put};
}
