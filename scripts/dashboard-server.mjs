import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { createBridge } from './bridge.mjs';
import { createUsageLedger } from './usage.mjs';
import { buildDesktopCatalog, buildUnifiedCatalog, createDesktopInstaller } from './desktop-config.mjs';
import { withCodexRpc } from './codex-rpc.mjs';
import { loadClientCatalog, publishCatalog } from './catalog-runtime.mjs';
import { createNetworkController, diagnoseProvider, publicNetworkError } from './network.mjs';
import { createCredentialStore, createCredentialSession } from './credentials.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)),'..');
const arg = flag => {const i=process.argv.indexOf(flag);return i<0?undefined:process.argv[i+1];};
const stateDir=resolve(arg('--state-dir')??join(root,'.runtime'));
mkdirSync(stateDir,{recursive:true,mode:0o700});
const config=JSON.parse(readFileSync(arg('--config')??join(root,'config.example.json'),'utf8'));
config.port=Number(arg('--port')??17631);
const cli=arg('--codex')??process.env.CODEX_CLI_PATH??'codex';
const connectionFile=join(stateDir,'connection.json');
let prior;
try { prior=JSON.parse(readFileSync(connectionFile,'utf8')); } catch {}
const token=typeof prior?.token==='string'&&prior.token.length>=24?prior.token:randomBytes(32).toString('hex');
let bootstrap=randomBytes(32).toString('hex');
const env={ [config.accessTokenEnv]:token };
const keyUpdatedAt={};
const credentials=await createCredentialSession({store:createCredentialStore({root,stateDir}),config,env,keyUpdatedAt});
const network=createNetworkController();
await network.refresh();
const networkChecks={};
const ledger=createUsageLedger(join(stateDir,'usage.jsonl'));
const catalogPath=join(stateDir,'models.json');
const codexHome=process.env.CODEX_HOME??join(process.env.HOME,'.codex');
const defaults=await loadClientCatalog(cli,arg('--openai-catalog')??join(codexHome,'models_cache.json'),{explicit:!!arg('--openai-catalog')});
const catalogs={openai:defaults.catalog,
  deepseek:JSON.parse(readFileSync(join(root,'vendor/cc-switch/codex_deepseek_catalog_template.json'),'utf8'))};
const catalog=buildDesktopCatalog(config,catalogs);
const catalogValidation=await publishCatalog(cli,catalogPath,catalog);
const subscriptionPath=join(stateDir,'subscription-models.json');
let subscription;
try { const saved=JSON.parse(readFileSync(subscriptionPath,'utf8'));if(saved.client_version===defaults.version)subscription=saved; } catch {}
if (!subscription && defaults.source==='matching-local-cache') {
  subscription={client_version:defaults.version,models:defaults.catalog.models.filter(m=>m.visibility==='list')};
  writeFileSync(subscriptionPath,JSON.stringify(subscription,null,2),{mode:0o600});
}
let unifiedUnavailable=null;
if (!subscription) {
  try {
  const visible = await withCodexRpc(cli,async rpc=>{
    const current=await rpc('config/read',{includeLayers:false});
    if(current.config.model_provider==='codex-model-bridge')throw new Error('Restore the original subscription configuration once before building a combined menu.');
    const result=await rpc('model/list',{includeHidden:false});
    if(result.nextCursor)throw new Error('The official model list needs pagination before it can be combined.');
    return result.data.map(m=>m.model);
  });
  const models=defaults.catalog.models.filter(m=>visible.includes(m.slug));
  if(models.length!==visible.length||!models.length)throw new Error('Official model metadata is incomplete.');
  subscription={client_version:defaults.version,models};
  writeFileSync(subscriptionPath,JSON.stringify(subscription,null,2),{mode:0o600});
  } catch { unifiedUnavailable='Restore the original subscription configuration, then restart the gateway to refresh official model metadata.'; }
}
const officialModels=subscription?.models.map(m=>m.slug)??[];
const unifiedCatalogPath=subscription?join(stateDir,'unified-models.json'):undefined;
const unifiedCatalog=subscription?buildUnifiedCatalog(catalog,subscription,officialModels):catalog;
const unifiedCatalogValidation=subscription?await publishCatalog(cli,unifiedCatalogPath,unifiedCatalog):null;
const gatewayConfig={...config,providers:{...config.providers,chatgpt:{baseUrl:'https://chatgpt.com/backend-api/codex',auth:'chatgpt'}},
  routes:{...config.routes,...Object.fromEntries(officialModels.map(model=>[model,{provider:'chatgpt',model}]))}};
writeFileSync(join(stateDir,'catalog-validation.json'),JSON.stringify({...catalogValidation,defaultsSource:defaults.source},null,2),{mode:0o600});
let baseUrl,installer;
const equal=(a,b)=>typeof a==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const json=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data));};
async function body(req){let size=0,chunks=[];for await(const c of req){size+=c.length;if(size>16384)throw new Error('Request too large.');chunks.push(c);}try{return JSON.parse(Buffer.concat(chunks));}catch{throw new Error('Invalid JSON request.');}}
let cachedConfigStatus={mode:'checking',restartRequired:true};
async function refreshConfig(){try{cachedConfigStatus=await installer.status();}catch{cachedConfigStatus={mode:'unknown',restartRequired:true};}return cachedConfigStatus;}
const staticFiles={ '/':['index.html','text/html; charset=utf-8'], '/app.js':['app.js','text/javascript; charset=utf-8'], '/style.css':['style.css','text/css; charset=utf-8'] };
const server=createBridge(gatewayConfig,{env,catalog:unifiedCatalog,onRequestStart:()=>network.enter(),onReceipt:receipt=>ledger.record(receipt),handleRequest:async(req,res)=>{
  const expectedHost=new URL(baseUrl).host;
  if(req.headers.host!==expectedHost){json(res,403,{error:'Invalid local host.'});return true;}
  const path=new URL(req.url,baseUrl).pathname;
  const security={'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer',
    'content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"};
  for(const [k,v] of Object.entries(security))res.setHeader(k,v);
  if(req.method==='GET'&&path.startsWith('/bootstrap/')){
    if(!bootstrap||!equal(path.slice(11),bootstrap)){json(res,401,{error:'This one-time link has expired.'});return true;}
    bootstrap=null;
    res.writeHead(303,{'set-cookie':`bridge_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`,location:'/'});res.end();return true;
  }
  if(req.method==='GET'&&staticFiles[path]){
    const [file,type]=staticFiles[path];res.writeHead(200,{'content-type':type});res.end(readFileSync(join(root,'web',file)));return true;
  }
  if(!path.startsWith('/api/'))return false;
  const cookie=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('bridge_admin='))?.slice(13);
  const bearer=req.headers.authorization?.startsWith('Bearer ')?req.headers.authorization.slice(7):null;
  if(!equal(cookie,token)&&!equal(bearer,token)){json(res,401,{error:'Open the authorized local management link from the setup helper.'});return true;}
  if(req.method!=='GET'&&(!equal(bearer,token)&&req.headers.origin!==baseUrl)){json(res,403,{error:'Use this local page to submit changes.'});return true;}
  try{
    if(req.method==='GET'&&path==='/api/state'){
      json(res,200,{service:'running',baseUrl,version:'0.5.0',config:cachedConfigStatus,catalogValidation,unifiedCatalogValidation,unifiedUnavailable,officialModels,network:network.status(),networkChecks,
        providers:Object.entries(config.providers).map(([id,p])=>({id,ready:!!env[p.apiKeyEnv],persisted:credentials.persisted(id),keyUpdatedAt:keyUpdatedAt[id]??null,baseUrl:p.baseUrl,models:Object.entries(config.routes).filter(([,r])=>r.provider===id).map(([alias,r])=>({alias,model:r.model}))})),
        usage:ledger.summary(),keyStorage:credentials.status(),catalogModels:unifiedCatalog.models.map(m=>({alias:m.slug,name:m.display_name}))});return true;
    }
    if(req.method==='GET'&&path==='/api/usage'){json(res,200,ledger.summary());return true;}
    if(req.method==='GET'&&path==='/api/config/preview'){json(res,200,installer.preview());return true;}
    if(req.method==='POST'&&path==='/api/network/refresh'){json(res,200,await network.refresh());return true;}
    if(req.method==='POST'&&path==='/api/network/check'){
      const input=await body(req);if(!Object.hasOwn(config.providers,input.provider))throw new Error('Unknown provider.');
      const release=network.enter();
      try{networkChecks[input.provider]=await diagnoseProvider(input.provider,config.providers[input.provider].baseUrl);json(res,200,networkChecks[input.provider]);}
      finally{release();}return true;
    }
    if(req.method==='POST'&&path==='/api/keys'){
      const input=await body(req);const provider=Object.hasOwn(config.providers,input.provider)?config.providers[input.provider]:null;
      if(!provider||typeof input.key!=='string'||input.key.length>8192||/\s/.test(input.key)||input.key.length<8)throw new Error('Choose a provider and paste its API key without spaces.');
      const result=await credentials.set(input.provider,input.key,input.persist??credentials.status().supported);input.key='';json(res,200,result);return true;
    }
    if(req.method==='POST'&&path==='/api/keys/clear'){
      const input=await body(req);if(!Object.hasOwn(config.providers,input.provider))throw new Error('Unknown provider.');json(res,200,await credentials.clear(input.provider));return true;
    }
    if(req.method==='POST'&&path==='/api/config/activate'){
      const input=await body(req);cachedConfigStatus=await installer.activate(input.model);json(res,200,cachedConfigStatus);return true;
    }
    if(req.method==='POST'&&path==='/api/config/unified'){
      const input=await body(req);cachedConfigStatus=await installer.activateUnified(input.model);json(res,200,cachedConfigStatus);return true;
    }
    if(req.method==='POST'&&path==='/api/config/restore'){cachedConfigStatus=await installer.restore();json(res,200,cachedConfigStatus);return true;}
    if(req.method==='POST'&&path==='/api/config/refresh'){json(res,200,await refreshConfig());return true;}
    if(req.method==='POST'&&path==='/api/test'){
      const input=await body(req);if(!Object.hasOwn(config.routes,input.model))throw new Error('Unknown model alias.');
      const testedKeyUpdatedAt=keyUpdatedAt[config.routes[input.model].provider]??null;
      const upstream=await fetch(baseUrl+'/v1/responses',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},
        body:JSON.stringify({model:input.model,input:'Reply exactly BRIDGE_OK.',max_output_tokens:128,reasoning:{effort:'low'},stream:false,store:false}),signal:AbortSignal.timeout(60000)});
      const result=await upstream.json();const text=(result.output??[]).flatMap(item=>item.content??[]).filter(item=>item.type==='output_text').map(item=>item.text).join('');
      json(res,200,{passed:upstream.ok&&result.status==='completed'&&text.trim()==='BRIDGE_OK',responseStatus:['completed','failed','incomplete'].includes(result.status)?result.status:null,status:upstream.status,testedKeyUpdatedAt,
        network:publicNetworkError(result.error?.network),errorCode:typeof result.error?.code==='string'&&/^[a-z_]{1,80}$/.test(result.error.code)?result.error.code:null});return true;
    }
    json(res,404,{error:'Unknown local management action.'});return true;
  }catch(error){json(res,400,{error:error.rpcCode?'Codex rejected the settings update. No provider key was logged.':error.message});return true;}
}});
server.on('error',error=>{console.error(JSON.stringify({status:'startup_failed',code:error.code??'server_error'}));process.exitCode=1;});
server.listen(config.port,'127.0.0.1');await once(server,'listening');
baseUrl=`http://127.0.0.1:${server.address().port}`;
installer=createDesktopInstaller({cli,root,stateDir,baseUrl,connectionFile,catalogPath,config,unifiedCatalogPath,officialModels,localToken:token});
writeFileSync(connectionFile,JSON.stringify({baseUrl,token,bootstrapUrl:baseUrl+'/bootstrap/'+bootstrap,pid:process.pid}),{mode:0o600});
await refreshConfig();
console.log(JSON.stringify({status:'dashboard_ready',url:baseUrl,connectionFile,keyStorage:credentials.status().backend}));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{for(const p of Object.values(config.providers))delete env[p.apiKeyEnv];network.close();server.close();server.closeAllConnections();process.exit(0);});
