import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {zstdCompressSync} from 'node:zlib';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBridge,validateConfig} from '../scripts/bridge.mjs';
import {buildUnifiedCatalog,createDesktopInstaller,PROVIDER_ID} from '../scripts/desktop-config.mjs';
const local='test-local-guard-token-1234567890',oauth='test-chatgpt-oauth-only',key='test-api-key-only';
async function serve(server){server.listen(0,'127.0.0.1');await once(server,'listening');return 'http://127.0.0.1:'+server.address().port;}
async function close(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
async function fixture(fn){
 const seen=[];const upstream=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;seen.push({headers:req.headers,body:JSON.parse(body)});res.writeHead(200,{'content-type':'text/event-stream','x-codex-primary-used-percent':'7'});res.end('data: '+JSON.stringify({type:'response.completed',response:{status:'completed',output:[],usage:{input_tokens:3,output_tokens:2,total_tokens:5}}})+'\n\n');});
 const origin=await serve(upstream);
 const config={accessTokenEnv:'LOCAL_TOKEN',providers:{chatgpt:{baseUrl:origin,auth:'chatgpt'},openai:{baseUrl:origin,apiKeyEnv:'API_KEY'}},routes:{native:{provider:'chatgpt',model:'gpt'},'api/gpt':{provider:'openai',model:'gpt'}}};
 const bridge=createBridge(config,{allowTestLoopback:true,env:{LOCAL_TOKEN:local,API_KEY:key}});const url=await serve(bridge);
 try{await fn({url,seen,config});}finally{await close(bridge);await close(upstream);}
}
const headers={'content-type':'application/json','x-codex-bridge-token':local,authorization:'Bearer '+oauth,'chatgpt-account-id':'account-test',cookie:'must-not-forward','x-session-id':'native-session'};
test('one endpoint routes native and API aliases separately; only official requests retain ChatGPT OAuth',()=>fixture(async({url,seen})=>{
 for(const model of ['native','api/gpt']){const r=await fetch(url+'/v1/responses',{method:'POST',headers,body:JSON.stringify({model,input:'synthetic history',stream:true})});assert.equal(r.status,200);assert.equal(r.headers.get('x-codex-primary-used-percent'),model==='native'?'7':null);await r.text();}
 assert.equal(seen.length,2);assert.equal(seen[0].headers.authorization,'Bearer '+oauth);assert.equal(seen[0].headers['chatgpt-account-id'],'account-test');assert.equal(seen[0].headers['x-session-id'],'native-session');assert.equal(seen[0].headers.cookie,undefined);
 assert.equal(seen[1].headers.authorization,'Bearer '+key);assert.equal(seen[1].headers['chatgpt-account-id'],undefined);assert.equal(seen[1].headers['x-session-id'],undefined);assert.equal(seen[1].headers.cookie,undefined);
 for(const row of seen){assert.equal(row.headers['x-codex-bridge-token'],undefined);assert.equal(row.body.model,'gpt');assert.equal(JSON.stringify(row).includes(local),false);}
}));
test('OAuth without the local guard is refused, and the local bearer alone cannot call subscription routes',()=>fixture(async({url,seen})=>{
 for(const h of [{authorization:'Bearer '+oauth},{authorization:'Bearer '+local},{'x-codex-bridge-token':local}]){const r=await fetch(url+'/v1/responses',{method:'POST',headers:{'content-type':'application/json',...h},body:JSON.stringify({model:'native',input:'test'})});assert.equal(r.status,401);await r.text();}
 assert.equal(seen.length,0);
}));
test('native zstd requests are bounded, decoded and forwarded without a stale compression header',()=>fixture(async({url,seen})=>{
 const bytes=zstdCompressSync(Buffer.from(JSON.stringify({model:'native',input:'compressed test',stream:true})));
 const r=await fetch(url+'/v1/responses',{method:'POST',headers:{...headers,'content-encoding':'zstd'},body:bytes});assert.equal(r.status,200);await r.text();assert.equal(seen[0].body.input,'compressed test');assert.equal(seen[0].headers['content-encoding'],undefined);
}));
test('a configured ChatGPT credential route cannot point to another production host',()=>{
 const c={accessTokenEnv:'LOCAL_TOKEN',providers:{chatgpt:{baseUrl:'https://example.com/collect',auth:'chatgpt'}},routes:{native:{provider:'chatgpt',model:'gpt'}}};assert.throws(()=>validateConfig(c),/official Codex service/);
});
test('combined catalog keeps the original subscription slugs and metadata, adding distinct API aliases only',()=>{
 const native={slug:'gpt',display_name:'GPT',service_tiers:['default'],model_messages:{instructions_template:'native'}};
 const api={slug:'api/gpt',display_name:'GPT API'};
 const result=buildUnifiedCatalog({models:[api]},{models:[native,{slug:'hidden'}]},['gpt']);assert.deepEqual(result.models.map(m=>m.slug),['gpt','api/gpt']);assert.deepEqual(result.models[0].model_messages,native.model_messages);assert.deepEqual(result.models[0].service_tiers,native.service_tiers);assert.equal(native.display_name,'GPT');assert.throws(()=>buildUnifiedCatalog({models:[native]},{models:[native]},['gpt']),/distinct/);assert.throws(()=>buildUnifiedCatalog({models:[api]},{models:[native]},['unavailable']),/incomplete/);
});
test('combined activation preserves original settings and restore removes every managed override atomically',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'bridge-unified-'));const file=join(dir,'config.toml');writeFileSync(file,'model = "gpt"\n# unrelated setting\n');
 const original={model:'gpt',model_reasoning_effort:'xhigh',service_tier:'default',model_providers:{unrelated:{name:'Keep me'}}};let current=structuredClone(original),version=1,writes=0;
 const runRpc=async(_cli,fn)=>fn(async(method,params)=>{
  if(method==='account/read')return {account:{type:'chatgpt'}};
  if(method==='config/read')return {layers:[{name:{type:'user',file},config:structuredClone(current),version:String(version)}]};
  assert.equal(method,'config/batchWrite');assert.equal(params.expectedVersion,String(version));writes++;version++;
  for(const {keyPath,value}of params.edits){const target=keyPath.startsWith('model_providers.')?current.model_providers:current;const name=keyPath.startsWith('model_providers.')?PROVIDER_ID:keyPath;if(value===null)delete target[name];else target[name]=structuredClone(value);}
  return {status:'ok'};
 });
 try{const i=createDesktopInstaller({cli:'unused',root:dir,stateDir:dir,baseUrl:'http://127.0.0.1:1',connectionFile:'unused',catalogPath:'api.json',unifiedCatalogPath:'combined.json',officialModels:['gpt'],localToken:local,config:{routes:{'api/gpt':{}}},validate:async()=>({validated:true}),runRpc});
 await i.activateUnified('gpt');assert.equal((await i.status()).mode,'unified');assert.equal(current.model_providers[PROVIDER_ID].requires_openai_auth,true);assert.equal(current.model_providers[PROVIDER_ID].auth,undefined);assert.equal(current.model_catalog_json,'combined.json');assert.equal(current.model_providers.unrelated.name,'Keep me');
 await i.restore();assert.equal(writes,2);assert.deepEqual(current,original);assert.equal(readFileSync(file,'utf8'),'model = "gpt"\n# unrelated setting\n');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('SSE with generic content type or direct response payload still reports terminal usage',async()=>{
 const {UsageTap}=await import('../scripts/usage.mjs');
 const tap=new UsageTap('application/octet-stream');tap.resume();
 tap.write('event: response.completed\nda');tap.end('ta: '+JSON.stringify({status:'completed',usage:{input_tokens:7,output_tokens:4}})+'\n\n');
 await once(tap,'end');assert.equal(tap.responseStatus,'completed');assert.equal(tap.usage.total,11);
});
