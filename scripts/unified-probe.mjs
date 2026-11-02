import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {withCodexRpc} from './codex-rpc.mjs';
import {unifiedProvider} from './desktop-config.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const stateDir=join(root,'.runtime');
const cli=process.argv[2]??process.env.CODEX_CLI_PATH??'codex';
const workDir=join(stateDir,'unified-probe');mkdirSync(workDir,{recursive:true,mode:0o700});
const instructions=join(workDir,'instructions.txt');
writeFileSync(instructions,'Follow the exact output instructions. Retain facts from readable conversation history. Do not call any tool, inspect files or environment, use a browser or network, or delegate.',{mode:0o600});
const c=JSON.parse(readFileSync(join(stateDir,'connection.json'),'utf8'));
const config={model_provider:'bridge-unified-probe',model:'gpt-6.1-sol',model_catalog_json:join(stateDir,'unified-models.json'),model_providers:{'bridge-unified-probe':unifiedProvider(c.baseUrl,c.token)},
 model_instructions_file:instructions,model_reasoning_effort:'low',web_search:'disabled',project_doc_max_bytes:0,
 features:{multi_agent:false,plugins:false,apps:false},agents:{enabled:false},skills:{max_context_tokens:1},mcp_servers:{},hooks:{},analytics:{enabled:false}};
const notifications=[],waiters=new Set();
function waitFor(predicate){const old=notifications.find(predicate);if(old)return Promise.resolve(old);return new Promise((resolve,reject)=>{const w={predicate,resolve,timer:setTimeout(()=>{waiters.delete(w);reject(new Error('Turn completion timed out.'));},90000)};waiters.add(w);});}
const report={checkedAt:new Date().toISOString(),scope:'one ephemeral Codex thread using the combined provider, native ChatGPT authentication and per-turn model switches',results:[],creditSource:'unverified',desktopMenuVisuallyVerified:false};
try{
 await withCodexRpc(cli,async rpc=>{
  const a=await rpc('account/read',{refreshToken:false});if(a.account?.type!=='chatgpt')throw new Error('ChatGPT sign-in is required.');
  const list=await rpc('model/list',{includeHidden:false});report.listedModels=list.data.map(m=>m.model);if(!['gpt-6.1-sol','openai-api/gpt-6.1-sol','deepseek/deepseek-flash'].every(m=>report.listedModels.includes(m)))throw new Error('Combined models were not listed.');
  console.log(JSON.stringify({test:'combined_model_list',count:report.listedModels.length,passed:true}));
  const start=await rpc('thread/start',{model:'gpt-6.1-sol',modelProvider:'bridge-unified-probe',cwd:workDir,ephemeral:true,sandbox:'read-only',approvalPolicy:'never',config});
  if(!start.thread.ephemeral)throw new Error('Codex did not confirm an ephemeral thread.');
  const A='A_'+randomBytes(6).toString('hex'),B='B_'+randomBytes(6).toString('hex');
  const steps=[
   {model:'gpt-6.1-sol',name:'subscription_seed',text:`Remember token A: ${A}. Reply exactly ACK.`,expected:'ACK'},
   {model:'openai-api/gpt-6.1-sol',name:'subscription_to_openai_api',text:'Return exactly token A from earlier.',expected:A},
   {model:'deepseek/deepseek-flash',name:'openai_api_to_deepseek',text:`Remember token B: ${B}. Return exactly token A from earlier.`,expected:A},
   {model:'gpt-6.1-sol',name:'deepseek_to_subscription',text:'Return exactly token B from earlier.',expected:B},
  ];
  for(const step of steps){
   const begin=await rpc('turn/start',{threadId:start.thread.id,model:step.model,effort:'low',input:[{type:'text',text:step.text}]});
   const id=begin.turn.id;const end=await waitFor(n=>n.method==='turn/completed'&&n.params.turn.id===id);
   const items=notifications.filter(n=>n.method==='item/completed'&&n.params.turnId===id).map(n=>n.params.item);
   const answer=items.filter(i=>i.type==='agentMessage').map(i=>i.text??'').join('');
   const result={test:step.name,model:step.model,status:end.params.turn.status,passed:end.params.turn.status==='completed'&&answer.trim()===step.expected,toolCalls:items.filter(i=>i.type==='commandExecution').length,error:end.params.turn.error?'client_error':null};
   report.results.push(result);console.log(JSON.stringify(result));if(!result.passed)throw new Error('A combined-provider continuity step failed.');
  }
 },{overrides:['model_provider="openai"',`model_catalog_json=${JSON.stringify(config.model_catalog_json)}`],onNotification:n=>{notifications.push(n);for(const w of waiters)if(w.predicate(n)){clearTimeout(w.timer);waiters.delete(w);w.resolve(n);}}});
}catch(error){report.failure=error.rpcCode?'Codex rejected the isolated probe configuration.':error.message;console.log(JSON.stringify({status:'probe_failed',diagnostic:report.failure}));process.exitCode=1;}
finally{for(const w of waiters)clearTimeout(w.timer);report.completedAt=new Date().toISOString();const receipts=join(stateDir,'receipts');mkdirSync(receipts,{recursive:true,mode:0o700});writeFileSync(join(receipts,'unified-menu.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});}
