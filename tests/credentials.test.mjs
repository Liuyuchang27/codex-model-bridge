import test from 'node:test';
import assert from 'node:assert/strict';
import {createCredentialStore,createCredentialSession,credentialService} from '../scripts/credentials.mjs';

const config={providers:{openai:{apiKeyEnv:'OPENAI_API_KEY'},deepseek:{apiKeyEnv:'DEEPSEEK_API_KEY'}}};
function fixture(){
  const items=new Map();const calls=[];
  const store=createCredentialStore({root:'/fixture/project',stateDir:'/unused',invoke:async request=>{
    calls.push(request);
    if(request.action==='save')items.set(request.account,request.value);
    if(request.action==='delete')items.delete(request.account);
    return {ok:true,value:items.get(request.account)??null};
  }});
  return {items,calls,store};
}
test('credentials reload for both providers after restart, without returning key material in status',async()=>{
  const {store}=fixture();const env={},keyUpdatedAt={};
  const first=await createCredentialSession({store,config,env,keyUpdatedAt});
  await first.set('openai','fixture-openai-key',true);await first.set('deepseek','fixture-deepseek-key',true);
  const newEnv={},newTimes={};const restarted=await createCredentialSession({store,config,env:newEnv,keyUpdatedAt:newTimes});
  assert.equal(newEnv.OPENAI_API_KEY,'fixture-openai-key');assert.equal(newEnv.DEEPSEEK_API_KEY,'fixture-deepseek-key');
  assert.deepEqual(newTimes,keyUpdatedAt);assert.equal(restarted.persisted('openai'),true);
  assert.equal(JSON.stringify(restarted.status()).includes('fixture-openai-key'),false);
});
test('memory-only replacement removes an older saved key; clear removes saved and live credentials',async()=>{
  const {store,items}=fixture();const env={},keyUpdatedAt={};const session=await createCredentialSession({store,config,env,keyUpdatedAt});
  await session.set('openai','fixture-old-key',true);await session.set('openai','fixture-memory-key',false);
  assert.equal(items.has('openai'),false);assert.equal(session.persisted('openai'),false);assert.equal(env.OPENAI_API_KEY,'fixture-memory-key');
  await session.set('deepseek','fixture-deepseek-key',true);await session.clear('deepseek');
  assert.equal(items.has('deepseek'),false);assert.equal(env.DEEPSEEK_API_KEY,undefined);assert.equal(keyUpdatedAt.deepseek,undefined);
});
test('locked Keychain starts without credentials and does not silently fall back to plaintext',async()=>{
  const store={supported:true,load:async()=>{throw Error('locked');},save:async()=>{throw Error('locked');}};
  const env={};const session=await createCredentialSession({store,config,env,keyUpdatedAt:{}});
  assert.equal(session.status().unavailable,true);assert.deepEqual(env,{});
  await assert.rejects(session.set('openai','fixture-new-key',true),/locked/);assert.deepEqual(env,{});
});
test('credential names isolate projects and only allow known provider accounts',async()=>{
  assert.notEqual(credentialService('/project/a'),credentialService('/project/b'));
  const {store}=fixture();await assert.rejects(store.load('../other'));
  await assert.rejects(store.save('openai','bad key'));
});
