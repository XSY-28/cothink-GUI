import test from 'node:test';
import assert from 'node:assert/strict';
import {observedIdentity,reviewFamily,assertProjectReview} from '../src/project-review.js';
const aliases=['deepseek-flash','deepseek-v4-flash','deepseek-v4-flash-vision-exp','deepseek-v4.1-flash','deepseek-v4.1-flash-1017'];
const origin='https://api.deepseek.com';
const call=(selector='deepseek-flash',reported=selector)=>({actualModel:{modelId:selector,baseUrl:origin},transport:{requestOrigin:origin,responseOrigin:origin},events:[{response:{model:reported}}]});
for(const selector of aliases)test(`official direct Flash selector ${selector} requires provider response`,()=>{
 assert.equal(reviewFamily(selector),'deepseek-flash');
 assert.equal(observedIdentity(call(selector)),'deepseek-flash');
 assert.equal(observedIdentity({...call(selector),events:[]}),null);
 for(const reported of aliases)assert.equal(observedIdentity(call(selector,reported)),'deepseek-flash');
});
for(const [label,mutate] of [
 ['proxy route',c=>{c.actualModel.baseUrl='https://proxy.example';}],
 ['origin mismatch',c=>{c.transport.responseOrigin='https://proxy.example';}],
 ['missing request origin',c=>{delete c.transport.requestOrigin;}],
 ['http',c=>{c.actualModel.baseUrl='http://api.deepseek.com';}],
 ['custom port',c=>{c.actualModel.baseUrl='https://api.deepseek.com:9443';}],
 ['lookalike host',c=>{c.actualModel.baseUrl='https://api.deepseek.com.evil.example';}],
 ['missing provider model',c=>{c.events=[{response:{}}];}],
 ['different family',c=>{c.events=[{model:'deepseek-v4-pro'}];}],
 ['mixed families',c=>{c.events.push({model:'deepseek-v4-pro'});}],
 ['arbitrary configured alias',c=>{c.actualModel.modelId='custom-flash';c.events=[{model:'custom-flash'}];}],
 ['spoofed openai host',c=>{c.actualModel.baseUrl='https://api.openai.com';c.transport={requestOrigin:'https://api.openai.com',responseOrigin:'https://api.openai.com'};}],
])test(`Flash identity fails closed: ${label}`,()=>{const c=call();mutate(c);assert.equal(observedIdentity(c),null);});
test('Flash selectors cannot certify one another as independent',()=>{
 for(const author of aliases)for(const reviewer of aliases){
  const source={candidate:'candidate',reference:'source',identity:author,participants:[{staffId:'author',identities:[author]}]};
  assert.throws(()=>assertProjectReview({callIntents:[]},{reviewOf:'source',reviewSource:source,reviewKind:'independent',readOnly:true,scope:[],staffId:'reviewer',identity:reviewer}),/participated/);
 }
 assert.notEqual(reviewFamily('deepseek-v4-pro'),reviewFamily('deepseek-flash'));
});
