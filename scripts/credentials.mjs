import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

const exec=promisify(execFile);
export const credentialService=root=>'dev.codex-model-bridge.'+createHash('sha256').update(root).digest('hex').slice(0,16);
const validProvider=id=>['openai','deepseek','fixture'].includes(id);

export function createCredentialStore({root,stateDir,service=credentialService(root),platform=process.platform,invoke:injectedInvoke}={}) {
  const supported=platform==='darwin'||!!injectedInvoke;
  let build;
  async function helper() {
    if(!supported)throw new Error('本机钥匙串保存目前仅支持 macOS。');
    const directory=join(stateDir,'bin');mkdirSync(directory,{recursive:true,mode:0o700});
    const binary=join(directory,'model-bridge-keychain-v1');
    const source=join(root,'scripts/keychain-helper.swift');
    const hash=createHash('sha256').update(readFileSync(source)).digest('hex');
    let savedHash;try{savedHash=readFileSync(binary+'.sha256','utf8');}catch{}
    if(!existsSync(binary)||savedHash!==hash) {
      const temporary=binary+'.build-'+randomBytes(4).toString('hex');
      try {await exec('/usr/bin/xcrun',['swiftc','-O',source,'-o',temporary],{timeout:60000,maxBuffer:1024*1024});}
      catch {throw new Error('无法构建系统钥匙串助手，请安装 Xcode Command Line Tools。');}
      chmodSync(temporary,0o700);renameSync(temporary,binary);writeFileSync(binary+'.sha256',hash,{mode:0o600});
    }
    return binary;
  }
  async function invoke(request) {
    if(injectedInvoke)return injectedInvoke(request);
    if(!build)build=helper().catch(error=>{build=undefined;throw error;});
    const binary=await build;
    return new Promise((resolve,reject)=>{
      const child=spawn(binary,[],{stdio:['pipe','pipe','pipe']});let output='',tooLarge=false;
      const timer=setTimeout(()=>child.kill('SIGTERM'),10000);
      child.stderr.resume();
      child.stdout.on('data',chunk=>{if(output.length+chunk.length>65536){tooLarge=true;child.kill();}else output+=chunk;});
      child.on('error',()=>{clearTimeout(timer);reject(new Error('无法运行本机钥匙串助手。'));});
      child.on('close',code=>{
        clearTimeout(timer);let result;try{result=JSON.parse(output);}catch{}
        if(code!==0||tooLarge||!result?.ok){reject(new Error('本机钥匙串不可用，请确认登录钥匙串已解锁。'));return;}
        resolve(result);
      });
      child.stdin.on('error',()=>{});
      child.stdin.end(JSON.stringify({...request,service}));
    });
  }
  const check=id=>{if(!validProvider(id))throw new Error('Unknown credential provider.');};
  return {
    supported,service,
    async load(id){check(id);const result=await invoke({action:'get',account:id});const value=result.value;
      if(value==null)return null;
      if(typeof value.key!=='string'||value.key.length<8||value.key.length>8192||/\s/.test(value.key)||typeof value.updatedAt!=='string')throw new Error('本机钥匙串条目格式不兼容。');
      return {key:value.key,updatedAt:value.updatedAt};},
    async save(id,key,updatedAt=new Date().toISOString()){check(id);if(typeof key!=='string'||key.length<8||key.length>8192||/\s/.test(key))throw new Error('Invalid API key.');await invoke({action:'save',account:id,value:{key,updatedAt}});return {provider:id,persisted:true,updatedAt};},
    async remove(id){check(id);await invoke({action:'delete',account:id});return {provider:id,persisted:false};}
  };
}

export async function createCredentialSession({store,config,env,keyUpdatedAt}) {
  const saved=new Set(),unavailable=new Set();
  for(const [id,provider] of Object.entries(config.providers)) {
    if(!store.supported)break;
    try {const value=await store.load(id);if(value){env[provider.apiKeyEnv]=value.key;keyUpdatedAt[id]=value.updatedAt;saved.add(id);}}
    catch {unavailable.add(id);}
  }
  return {
    status:()=>({backend:store.supported?'macos-keychain':'process-memory',supported:store.supported,unavailable:unavailable.size>0}),
    persisted:id=>saved.has(id),
    async set(id,key,persist=store.supported) {
      const provider=config.providers[id];if(!provider)throw new Error('Unknown provider.');
      if(typeof persist!=='boolean')throw new Error('Choose whether to save this key.');
      const updatedAt=new Date().toISOString();
      if(persist){await store.save(id,key,updatedAt);saved.add(id);}
      else if(store.supported){await store.remove(id);saved.delete(id);}
      env[provider.apiKeyEnv]=key;keyUpdatedAt[id]=updatedAt;
      unavailable.delete(id);
      return {ready:true,persisted:saved.has(id),storage:saved.has(id)?'macos-keychain':'process-memory',updatedAt};
    },
    async clear(id) {
      const provider=config.providers[id];if(!provider)throw new Error('Unknown provider.');
      if(store.supported)await store.remove(id);
      saved.delete(id);delete env[provider.apiKeyEnv];delete keyUpdatedAt[id];
      unavailable.delete(id);
      return {ready:false,persisted:false};
    }
  };
}
