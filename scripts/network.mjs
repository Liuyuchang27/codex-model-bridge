import * as http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isIP } from 'node:net';

const exec = promisify(execFile);
const own = (object,key) => Object.hasOwn(object,key);
const scalar = (text,key) => text.match(new RegExp('^\\s*'+key+'\\s*:\\s*(.*?)\\s*$','m'))?.[1];
const explicit = (env,key) => own(env,key.toLowerCase()) ? env[key.toLowerCase()] : own(env,key) ? env[key] : undefined;

function checkedProxy(value) {
  if (!value) return undefined;
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid HTTP/HTTPS proxy URL.'); }
  if (!['http:','https:'].includes(url.protocol) || url.search || url.hash || url.pathname !== '/') throw new Error('Use an HTTP or HTTPS proxy URL. SOCKS and PAC URLs need an HTTP proxy endpoint.');
  return url.href;
}

function systemProxy(text,prefix) {
  if (scalar(text,prefix+'Enable') !== '1') return undefined;
  const host = scalar(text,prefix+'Proxy');
  const port = Number(scalar(text,prefix+'Port'));
  if (!host || /[\s/@?#]/.test(host) || !Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('The macOS system proxy has an invalid host or port.');
  return checkedProxy('http://'+(host.includes(':')&&!host.startsWith('[')?'['+host+']':host)+':'+port);
}

// Proxy URLs with credentials remain only in memory; status never includes them.
const displayProxy = value => {if (!value) return null; const url=new URL(value); return {protocol:url.protocol,host:url.host};};

function bypassEntry(entry) {
  if(!entry.includes('/'))return entry&&!/[\s@?#]/.test(entry)?entry:null;
  const [ip,prefix,...extra]=entry.split('/');
  const octets=ip.split('.');
  if(octets.length<1||octets.length>4||octets.some(o=>!/^\d{1,3}$/.test(o)||Number(o)>255))return null;
  const normalized=[...octets,...Array(4-octets.length).fill('0')].map(Number).join('.');
  if(extra.length||isIP(normalized)!==4||!/^\d{1,2}$/.test(prefix)||Number(prefix)>32)return null;
  const address=normalized.split('.').reduce((n,octet)=>(n<<8n)|BigInt(octet),0n);
  const mask=(0xffffffffn<<BigInt(32-Number(prefix)))&0xffffffffn;
  const first=address&mask,last=first|(0xffffffffn^mask);
  const format=n=>[24n,16n,8n,0n].map(shift=>String((n>>shift)&255n)).join('.');
  return format(first)+'-'+format(last);
}

export function buildProxyPlan(env={}, {platform=process.platform,systemText=''}={}) {
  const proxyEnv = {};
  const sources = {};
  for (const [name,prefix] of [['HTTP_PROXY','HTTP'],['HTTPS_PROXY','HTTPS']]) {
    const fromEnv=explicit(env,name);
    proxyEnv[name] = fromEnv !== undefined ? checkedProxy(fromEnv) : platform === 'darwin' ? systemProxy(systemText,prefix) : undefined;
    sources[prefix.toLowerCase()] = fromEnv !== undefined ? 'environment' : proxyEnv[name] ? 'macos-system' : 'direct';
  }
  const bypass = (explicit(env,'NO_PROXY')??'').split(',').map(x=>x.trim()).filter(Boolean);
  // Honor supported system bypass entries; never proxy management credentials.
  const exceptions=systemText.match(/ExceptionsList\s*:\s*<array>\s*\{([\s\S]*?)\}/)?.[1]??'';
  const systemBypass=[...exceptions.matchAll(/^\s*\d+\s*:\s*(.*?)\s*$/gm)].map(m=>m[1]);
  const warnings=[];
  for(const entry of systemBypass) {
    const converted=bypassEntry(entry);
    if(converted)bypass.push(converted);else warnings.push('unsupported-system-bypass');
  }
  proxyEnv.NO_PROXY=[...new Set([...bypass,'127.0.0.1','localhost','::1','[::1]'])].join(',');
  if (scalar(systemText,'ProxyAutoConfigEnable')==='1') warnings.push('pac-not-supported');
  if ((env.ALL_PROXY||env.all_proxy)&&!proxyEnv.HTTP_PROXY&&!proxyEnv.HTTPS_PROXY) warnings.push('all-proxy-not-supported');
  const used=Object.entries(sources).filter(([protocol])=>!!proxyEnv[protocol.toUpperCase()+'_PROXY']).map(([,source])=>source);
  const mode=used.length?new Set(used).size===1?used[0]:'mixed':'direct';
  return {proxyEnv,status:{mode,sources,httpProxy:displayProxy(proxyEnv.HTTP_PROXY),httpsProxy:displayProxy(proxyEnv.HTTPS_PROXY),
    localBypass:true,warnings:[...new Set(warnings)]}};
}

export async function readSystemProxy() {
  try { const {stdout}=await exec('/usr/sbin/scutil',['--proxy'],{timeout:5000,maxBuffer:256*1024});return stdout; }
  catch { throw new Error('Could not read macOS system proxy settings. Check the system proxy or set HTTP_PROXY and HTTPS_PROXY before starting.'); }
}

export function createNetworkController({env={...process.env},platform=process.platform,readProxy=readSystemProxy,setProxy=http.setGlobalProxyFromEnv}={}) {
  let status={mode:'checking'},lastPlan,restore,active=0,pending;
  async function update() {
    if(active)throw new Error('有 API 请求正在进行，请完成后再更新代理。');
    if(typeof setProxy!=='function')throw new Error('The dashboard requires Node.js 24.14 or later for system proxy support.');
    const systemText=platform==='darwin'&&(explicit(env,'HTTP_PROXY')===undefined||explicit(env,'HTTPS_PROXY')===undefined)?await readProxy():'';
    if(active)throw new Error('有 API 请求正在进行，请完成后再更新代理。');
    const plan=buildProxyPlan(env,{platform,systemText});
    const signature=JSON.stringify(plan.proxyEnv);
    if(signature!==lastPlan){
      restore?.();
      restore=setProxy(plan.proxyEnv);
      lastPlan=signature;
    }
    status={...plan.status,checkedAt:new Date().toISOString()};
    return status;
  }
  return {
    status:()=>({...status,activeRequests:active}),
    refresh(){if(!pending)pending=update().finally(()=>{pending=undefined;});return pending;},
    enter(){active++;let released=false;return()=>{if(!released){active--;released=true;}};},
    close(){restore?.();restore=undefined;}
  };
}

export function classifyNetworkError(error) {
  const nested=[error,error?.cause,...(error?.cause?.errors??[])];
  const raw=nested.map(e=>e?.code).find(c=>typeof c==='string');
  const code=typeof raw==='string'&&/^[A-Z_0-9]{1,80}$/.test(raw)?raw:null;
  const category=['AbortError','TimeoutError'].includes(error?.name)||['ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT'].includes(code)?'connect_timeout'
    :['ENOTFOUND','EAI_AGAIN'].includes(code)?'dns_failed'
    :code==='ECONNREFUSED'?'connection_refused'
    :['CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT','UNABLE_TO_VERIFY_LEAF_SIGNATURE','SELF_SIGNED_CERT_IN_CHAIN','ERR_TLS_CERT_ALTNAME_INVALID'].includes(code)?'tls_verification_failed'
    :['ECONNRESET','UND_ERR_SOCKET'].includes(code)||code?.startsWith('ERR_SSL_')?'tls_or_connection_reset':'transport_error';
  return {category,code};
}

export function publicNetworkError(value) {
  if(!value||!['connect_timeout','dns_failed','connection_refused','tls_verification_failed','tls_or_connection_reset','transport_error'].includes(value.category))return null;
  return {category:value.category,code:typeof value.code==='string'&&/^[A-Z_0-9]{1,80}$/.test(value.code)?value.code:null};
}

export async function diagnoseProvider(provider,baseUrl,{fetchImpl=fetch,timeoutMs=10000}={}) {
  const began=Date.now();
  try {
    // No provider key or gateway token is used by a network check.
    const response=await fetchImpl(baseUrl.replace(/\/$/,'')+'/models',{redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
    await response.body?.cancel();
    return {provider,responseReceived:true,status:response.status,keyUsed:false,checkedAt:new Date().toISOString(),durationMs:Date.now()-began};
  } catch(error) {
    return {provider,responseReceived:false,status:null,keyUsed:false,...classifyNetworkError(error),checkedAt:new Date().toISOString(),durationMs:Date.now()-began};
  }
}
