import { readFileSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNetworkController } from './network.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const arg=flag=>{const i=process.argv.indexOf(flag);return i<0?undefined:process.argv[i+1];};
const stateDir=resolve(arg('--state-dir')??join(root,'.runtime'));
const port=Number(arg('--port')??17631);
if (!Number.isSafeInteger(port)||port<1||port>65535) throw new Error('Choose a valid local port.');
mkdirSync(stateDir,{recursive:true,mode:0o700});
const network=createNetworkController();
await network.refresh();
let existing;
async function healthy() {
  try {
    const c=JSON.parse(readFileSync(join(stateDir,'connection.json'),'utf8'));
    if (c.baseUrl!==`http://127.0.0.1:${port}`) return false;
    const r=await fetch(c.baseUrl+'/api/state',{headers:{authorization:'Bearer '+c.token},signal:AbortSignal.timeout(1500)});
    const state=await r.json();
    const ok=r.ok&&state.service==='running';
    if(ok)existing={connection:c,state};
    return ok;
  } catch{return false;}
}
if(process.argv.includes('--restart')&&await healthy()) {
  const pid=existing.connection.pid;
  if(!Number.isSafeInteger(pid)||pid<=1)throw new Error('No valid owned dashboard PID is available.');
  let command;
  try{command=execFileSync('ps',['-p',String(pid),'-o','args='],{encoding:'utf8',timeout:5000,maxBuffer:16384});}catch{}
  if(!command?.includes(join(root,'scripts/dashboard-server.mjs')))throw new Error('Refusing to stop a process that is not this dashboard.');
  console.log(JSON.stringify({status:'restarting_owned_dashboard',keysReloadFromKeychain:existing.state.providers.every(p=>!p.ready||p.persisted)}));
  process.kill(pid,'SIGTERM');
  const deadline=Date.now()+10000;
  while(await healthy()) {
    if(Date.now()>deadline)throw new Error('The existing dashboard did not stop; no second process was started.');
    await new Promise(resolve=>setTimeout(resolve,150));
  }
}
if (!(await healthy())) {
  const env={...process.env,NO_PROXY:[process.env.NO_PROXY,'127.0.0.1','localhost'].filter(Boolean).join(',')};
  // Keys are submitted on the local page, never inherited by the launcher.
  delete env.OPENAI_API_KEY;delete env.DEEPSEEK_API_KEY;
  const args=[...(process.allowedNodeEnvironmentFlags.has('--use-env-proxy')?['--use-env-proxy']:[]),join(root,'scripts/dashboard-server.mjs'),'--state-dir',stateDir,'--port',String(port)];
  for(const flag of ['--codex','--config','--openai-catalog'])if(arg(flag))args.push(flag,arg(flag));
  const log=openSync(join(stateDir,'dashboard.log'),'a',0o600);
  const child=spawn(process.execPath,args,{cwd:root,env,detached:true,stdio:['ignore',log,log]});
  let failed=false;child.on('error',()=>{failed=true;});child.unref();closeSync(log);
  const deadline=Date.now()+55000;
  while(!(await healthy())) {
    if(failed||Date.now()>deadline)throw new Error('Dashboard did not start. Inspect the private .runtime/dashboard.log; active Codex settings were not changed.');
    await new Promise(resolve=>setTimeout(resolve,300));
  }
}
console.log(JSON.stringify({status:'dashboard_ready',url:`http://127.0.0.1:${port}`,connectionFile:join(stateDir,'connection.json'),keyStorage:existing?.state.keyStorage,startsAtLogin:false,network:network.status()}));
network.close();
