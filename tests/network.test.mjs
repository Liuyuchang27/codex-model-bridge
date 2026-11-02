import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtempSync,writeFileSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync,execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildProxyPlan,createNetworkController,diagnoseProvider,classifyNetworkError,publicNetworkError } from '../scripts/network.mjs';

const system=(port=18080)=>`<dictionary> {\n HTTPEnable : 1\n HTTPProxy : 127.0.0.1\n HTTPPort : ${port}\n HTTPSEnable : 1\n HTTPSProxy : 127.0.0.1\n HTTPSPort : ${port}\n ExceptionsList : <array> {\n 0 : *.local\n }\n}`;

test('macOS HTTP and HTTPS destinations use the system HTTP proxy, with local management always bypassed',()=>{
  const plan=buildProxyPlan({}, {platform:'darwin',systemText:system()});
  assert.equal(plan.proxyEnv.HTTPS_PROXY,'http://127.0.0.1:18080/');
  assert.equal(plan.proxyEnv.HTTP_PROXY,'http://127.0.0.1:18080/');
  assert.equal(plan.status.mode,'macos-system');
  for(const host of ['127.0.0.1','localhost','::1','*.local'])assert.ok(plan.proxyEnv.NO_PROXY.split(',').includes(host));
});

test('explicit proxy environment and lowercase precedence are honored without leaking proxy credentials',()=>{
  const fixtureProxy=new URL('http://lower.invalid:8888');
  fixtureProxy.username='person';fixtureProxy.password='fixture-password';
  const plan=buildProxyPlan({HTTPS_PROXY:'http://upper.invalid:8080',https_proxy:fixtureProxy.href,NO_PROXY:'intranet.invalid'}, {platform:'darwin',systemText:system()});
  assert.equal(plan.status.mode,'mixed');
  assert.equal(plan.status.httpsProxy.host,'lower.invalid:8888');
  assert.ok(plan.proxyEnv.NO_PROXY.includes('intranet.invalid'));
  assert.equal(JSON.stringify(plan.status).includes('fixture-password'),false);
  assert.equal(JSON.stringify(plan.status).includes('person'),false);
  assert.equal(buildProxyPlan({http_proxy:''},{platform:'darwin',systemText:system()}).proxyEnv.HTTP_PROXY,undefined);
});

test('unsupported PAC/SOCKS settings are reported rather than treated as HTTP proxies',()=>{
  assert.throws(()=>buildProxyPlan({HTTPS_PROXY:'socks5://127.0.0.1:1080'}),/HTTP or HTTPS/);
  const plan=buildProxyPlan({}, {platform:'darwin',systemText:'ProxyAutoConfigEnable : 1\n'});
  assert.equal(plan.status.mode,'direct');assert.deepEqual(plan.status.warnings,['pac-not-supported']);
});

test('macOS IPv4 CIDR bypass rules become Node-supported address ranges',()=>{
  const plan=buildProxyPlan({}, {platform:'darwin',systemText:system().replace('0 : *.local','0 : 169.254/16\n 1 : 10.0.0.0/8\n 2 : 192.168.1.7/32')});
  assert.deepEqual(plan.status.warnings,[]);
  assert.ok(plan.proxyEnv.NO_PROXY.includes('169.254.0.0-169.254.255.255'));
  assert.ok(plan.proxyEnv.NO_PROXY.includes('10.0.0.0-10.255.255.255'));
  assert.ok(plan.proxyEnv.NO_PROXY.includes('192.168.1.7-192.168.1.7'));
});

test('proxy refresh applies real changes and refuses to reset transport during an active request',async()=>{
  let port=18080,sets=0,restores=0;
  const network=createNetworkController({env:{},platform:'darwin',readProxy:async()=>system(port),setProxy:()=>{sets++;return()=>{restores++;};}});
  await network.refresh();await network.refresh();assert.equal(sets,1);
  const release=network.enter();port=1083;
  await assert.rejects(network.refresh(),/请求正在进行/);assert.equal(sets,1);
  release();release();assert.equal(network.status().activeRequests,0);
  await network.refresh();assert.equal(sets,2);assert.equal(restores,1);
  assert.equal(network.status().httpsProxy.host,'127.0.0.1:1083');network.close();assert.equal(restores,2);
});

test('an API call starting while macOS settings are being read prevents a transport reset',async()=>{
  let resolveRead,sets=0;
  const network=createNetworkController({env:{},platform:'darwin',readProxy:()=>new Promise(resolve=>{resolveRead=resolve;}),setProxy:()=>{sets++;}});
  const refresh=network.refresh();const release=network.enter();resolveRead(system());
  await assert.rejects(refresh,/请求正在进行/);assert.equal(sets,0);release();
});

test('network checks use no credentials or model tokens and distinguish HTTP responses from transport failures',async()=>{
  const result=await diagnoseProvider('p','https://fixture.invalid/v1',{fetchImpl:async(url,options)=>{
    assert.equal(url,'https://fixture.invalid/v1/models');assert.equal(options.headers,undefined);assert.equal(options.body,undefined);
    return new Response(null,{status:401});
  }});
  assert.equal(result.responseReceived,true);assert.equal(result.status,401);assert.equal(result.keyUsed,false);
  const failed=await diagnoseProvider('p','https://fixture.invalid',{fetchImpl:async()=>{throw Object.assign(new Error('PRIVATE_ERROR_WITH_SECRET'),{cause:{code:'ECONNRESET'}});}});
  assert.equal(failed.category,'tls_or_connection_reset');assert.equal(JSON.stringify(failed).includes('PRIVATE_ERROR'),false);
  assert.equal(classifyNetworkError({name:'TimeoutError'}).category,'connect_timeout');
  assert.deepEqual(publicNetworkError({category:'dns_failed',code:'ENOTFOUND',headers:'secret'}),{category:'dns_failed',code:'ENOTFOUND'});
  assert.equal(publicNetworkError({category:'PRIVATE_ERROR'}),null);
});

test('native fetch uses HTTPS CONNECT, keeps loopback tokens off the proxy, and follows a refreshed system proxy',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'bridge-proxy-test-'));
  const sockets=new Set();const servers=[];const counts=[0,0];
  t.after(async()=>{for(const socket of sockets)socket.destroy();for(const server of servers){server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}rmSync(dir,{recursive:true,force:true});});
  writeFileSync(join(dir,'openssl.cnf'),'[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=bridge-upstream.test\n[ext]\nsubjectAltName=DNS:bridge-upstream.test\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n');
  // Test-only CA, trusted solely by the child test process. TLS checks stay on.
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-config',join(dir,'openssl.cnf'),'-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem')],{stdio:'ignore',timeout:15000});
  const listen=async server=>{servers.push(server);server.listen(0,'127.0.0.1');await once(server,'listening');return server.address().port;};
  let authenticated=0;
  const upstream=https.createServer({key:readFileSync(join(dir,'key.pem')),cert:readFileSync(join(dir,'cert.pem'))},(req,res)=>{
    assert.equal(req.headers['proxy-authorization'],undefined);
    const allowed=req.headers.authorization==='Bearer fixture-provider-key';if(allowed)authenticated++;
    res.writeHead(allowed?200:401,{'content-type':'application/json'});res.end(JSON.stringify({ok:allowed}));
  });
  const upstreamPort=await listen(upstream);
  const local=http.createServer((req,res)=>{assert.equal(req.headers.authorization,'Bearer fixture-local-token');res.end('local-ok');});
  const localPort=await listen(local);
  const proxyPorts=[];
  for(let i=0;i<2;i++){
    const proxy=http.createServer((_req,res)=>{res.writeHead(500);res.end();});
    proxy.on('connect',(req,socket,head)=>{
      counts[i]++;assert.equal(req.url,'bridge-upstream.test:'+upstreamPort);assert.equal(req.headers.authorization,undefined);
      sockets.add(socket);socket.on('close',()=>sockets.delete(socket));
      const remote=net.connect(upstreamPort,'127.0.0.1',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)remote.write(head);socket.pipe(remote);remote.pipe(socket);});
      sockets.add(remote);remote.on('close',()=>sockets.delete(remote));remote.on('error',()=>socket.destroy());socket.on('error',()=>remote.destroy());
    });
    proxyPorts.push(await listen(proxy));
  }
  const source=`import assert from 'node:assert/strict';import{createNetworkController,diagnoseProvider}from ${JSON.stringify(new URL('../scripts/network.mjs',import.meta.url).href)};
let port=${proxyPorts[0]};const network=createNetworkController({env:{},platform:'darwin',readProxy:async()=>${JSON.stringify(system())}.replaceAll('18080',String(port))});
await network.refresh();
assert.equal(await(await fetch('http://127.0.0.1:${localPort}/health',{headers:{authorization:'Bearer fixture-local-token'}})).text(),'local-ok');
const url='https://bridge-upstream.test:${upstreamPort}';const check=await diagnoseProvider('fixture',url);assert.equal(check.status,401);assert.equal(check.keyUsed,false);
assert.equal((await fetch(url,{headers:{authorization:'Bearer fixture-provider-key'}})).status,200);
port=${proxyPorts[1]};await network.refresh();assert.equal((await fetch(url,{headers:{authorization:'Bearer fixture-provider-key'}})).status,200);
network.close();console.log(JSON.stringify({passed:true}));`;
  const env={...process.env,NODE_EXTRA_CA_CERTS:join(dir,'cert.pem')};
  for(const key of ['NODE_TLS_REJECT_UNAUTHORIZED','NODE_USE_ENV_PROXY','NODE_OPTIONS','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy','OPENAI_API_KEY','DEEPSEEK_API_KEY'])delete env[key];
  const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',source],{env,timeout:25000,maxBuffer:8192});
  assert.equal(JSON.parse(stdout).passed,true);assert.ok(counts.every(n=>n>=1));assert.equal(authenticated,2);
});
