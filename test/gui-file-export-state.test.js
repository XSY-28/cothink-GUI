import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {modalEnvironment} from './gui-modal.fixture.js';
for(const timing of ['finished','late-success','late-failure'])test(`file export status stays with its selected draft (${timing})`,async()=>{
 await modalEnvironment(async({root,container,FilePanel})=>{
  const draft={taskId:'old',version:'draft-v',path:'a.txt',draft:{changeId:'change',baseVersion:'base'}};
  const formal={taskId:'new',version:'formal-v',path:'a.txt'};
  const pending=Promise.withResolvers();
  const commands={loadFiles:async taskId=>({taskId,items:[{ref:taskId==='old'?draft:formal,name:'a.txt',status:'unchanged',readable:true,previewKind:'text'}],warnings:[]}),
   readFile:async ref=>({bytes:new TextEncoder().encode(ref===draft?'draft content':'formal content'),version:ref.version}),exportDraft:()=>pending.promise};
  const render=(ref,tab='preview')=>React.createElement(FilePanel,{task:{id:ref.taskId,status:'completed'},sessionId:'s',selection:{fileRef:ref,tab},commands,onSelection(){},onRecords(){}});
  const result={directory:'/fixture/export',warnings:['OLD_DRAFT_WARNING']};
  await act(async()=>root.render(render(draft)));
  await act(async()=>[...container.querySelectorAll('button')].find(x=>x.textContent==='导出草稿').click());
  if(timing==='finished'){
   await act(async()=>pending.resolve(result));assert.match(container.textContent,/OLD_DRAFT_WARNING/);
   await act(async()=>root.render(render(draft,'source')));assert.match(container.textContent,/OLD_DRAFT_WARNING/,'same draft tab switch preserves its export receipt');
  }
  await act(async()=>root.render(render(formal)));
  if(timing==='late-success')await act(async()=>pending.resolve(result));
  if(timing==='late-failure')await act(async()=>pending.reject(Error('OLD_EXPORT_FAILURE')));
  assert.match(container.textContent,/formal content/);
  assert.doesNotMatch(container.textContent,/草稿已导出|OLD_DRAFT_WARNING|OLD_EXPORT_FAILURE|未验收草稿/);
  await act(async()=>root.render(render(draft)));
  assert.match(container.textContent,/draft content/,'old draft itself remains readable');
  assert.doesNotMatch(container.textContent,/OLD_DRAFT_WARNING|OLD_EXPORT_FAILURE/);
  assert.equal([...container.querySelectorAll('button')].find(x=>x.textContent==='导出草稿').disabled,false);
 });
});
