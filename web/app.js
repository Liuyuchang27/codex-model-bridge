const $=id=>document.getElementById(id);
const fmt=n=>new Intl.NumberFormat('zh-CN').format(n??0);
let state,loaded=false,lastConfiguredModel;
const networkErrorText=category=>({connect_timeout:'连接超时',dns_failed:'域名解析失败',connection_refused:'无法连接代理或目标服务',tls_verification_failed:'TLS 证书验证失败',tls_or_connection_reset:'TLS 或网络连接被重置',transport_error:'上游网络连接失败'}[category]??'上游网络连接失败');
function notice(text,error=false){$('notice').hidden=false;$('notice').textContent=text;$('notice').classList.toggle('error',error);}
async function api(path,body){const response=await fetch(path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),credentials:'same-origin'});const data=await response.json();if(!response.ok)throw new Error(data.error??'本机请求未完成');return data;}
async function action(button,fn){const old=button.textContent;button.disabled=true;button.textContent='处理中…';try{await fn();await refresh();}catch(error){notice(error.message,true);}finally{button.disabled=false;button.textContent=old;}}
function providerCards(){
  for(const provider of state.providers){
    const card=document.createElement('article');card.className='card';const isOpenAI=provider.id==='openai';
    card.innerHTML=`<div class="provider-head"><span class="provider-mark ${isOpenAI?'':'deepseek'}">${isOpenAI?'O':'D'}</span><h3>${isOpenAI?'OpenAI':'DeepSeek'}</h3><span class="status" id="status-${provider.id}">待填写 Key</span></div><div class="model-name"></div><div class="endpoint"></div><p class="footnote key-time"></p><form autocomplete="off"><label>API Key</label><div class="key-input"><input type="password" autocomplete="new-password" spellcheck="false" placeholder="填写新的 Key 可替换已保存的 Key" aria-label="${isOpenAI?'OpenAI':'DeepSeek'} API Key"><button type="submit" class="primary">提交 Key</button></div><label class="save-key"><input type="checkbox" class="persist"> 保存到本机钥匙串，重启后自动读取</label></form><div class="actions"><select class="test-model" aria-label="${isOpenAI?'OpenAI':'DeepSeek'} 测试模型"></select><button class="secondary test">测试连接</button><button class="text-button clear">移除本机 Key</button></div><p class="footnote">已保存的 Key 不会回显。测试连接会消耗少量对应 API 额度。</p>`;
    const persist=card.querySelector('.persist');persist.checked=!!state.keyStorage?.supported;persist.disabled=!state.keyStorage?.supported;
    if(!state.keyStorage?.supported)card.querySelector('.save-key').append('（当前系统仅支持内存）');
    card.querySelector('.endpoint').textContent=provider.baseUrl;
    const modelName=alias=>state.catalogModels.find(m=>m.alias===alias)?.name??alias;
    card.querySelector('.model-name').textContent=provider.models.map(m=>modelName(m.alias)).join(' / ');
    const testModel=card.querySelector('.test-model');
    for(const model of provider.models){const option=document.createElement('option');option.value=model.alias;option.textContent=modelName(model.alias);testModel.append(option);}
    card.querySelector('form').addEventListener('submit',e=>{e.preventDefault();const input=card.querySelector('input[type=password]');const key=input.value;input.value='';action(card.querySelector('button[type=submit]'),async()=>{const result=await api('/api/keys',{provider:provider.id,key,persist:persist.checked});notice(result.persisted?'Key 已保存到本机钥匙串，后台重启会自动读取。':'Key 仅保存在本次后台内存，旧钥匙串条目已移除。');});});
    card.querySelector('.test').onclick=e=>action(e.currentTarget,async()=>{const result=await api('/api/test',{model:testModel.value});notice(result.passed?'连接成功，模型已完成回复；token 用量已记录。':result.responseStatus==='incomplete'?'上游已接受 Key，但本次回复未完成；用量已记录。':result.errorCode==='upstream_transport_error'?networkErrorText(result.network?.category)+'；尚未验证 Key。可先点击检测 API 网络。':`测试未通过：HTTP ${result.status}${result.errorCode?' · '+result.errorCode:''}${result.errorCode==='invalid_api_key'?' · 上游拒绝了这把 Key':''}`,!result.passed);});
    card.querySelector('.clear').onclick=e=>action(e.currentTarget,async()=>{await api('/api/keys/clear',{provider:provider.id});notice('已移除这家供应商的钥匙串条目和内存 Key。');});
    $('provider-cards').append(card);
  }
}
function renderModelUsage(){
  $('model-usage').replaceChildren();
  const subscriptions=Object.entries(state.usage.models??{}).filter(([,u])=>u.provider==='chatgpt').map(([alias])=>({alias}));
  const groups=[...state.providers,{id:'chatgpt',models:subscriptions}];
  for(const p of groups)for(const model of p.models){
    const usage=state.usage.models?.[model.alias]??{};
    const card=document.createElement('article');card.className='card model-usage-card';
    const heading=document.createElement('div');heading.className='card-title';
    const title=document.createElement('h3');title.textContent=state.catalogModels.find(m=>m.alias===model.alias)?.name??model.alias;
    const badge=document.createElement('span');badge.className='pill subtle';badge.textContent=p.id==='chatgpt'?'官方订阅':p.id==='openai'?'OpenAI API':'DeepSeek API';heading.append(title,badge);
    const total=document.createElement('strong');total.className='model-total';total.textContent=usage.requests&&!usage.measured?'用量未知':fmt(usage.total)+' tokens';
    const list=document.createElement('dl');list.className='usage-detail';
    for(const [label,key] of [['输入','input'],['输出','output'],['缓存命中','cached'],['缓存写入','cacheWrite'],['其中推理','reasoning'],['请求数','requests']]){const item=document.createElement('div');const dt=document.createElement('dt');dt.textContent=label;const dd=document.createElement('dd');dd.textContent=key!=='requests'&&usage.requests&&!usage.measured?'—':fmt(usage[key]);item.append(dt,dd);list.append(item);}
    const note=document.createElement('p');note.className='footnote';note.textContent=`有回执 ${fmt(usage.measured)} · 用量未知 ${fmt(usage.unknown)} · 失败 ${fmt(usage.failed)} · 未完成 ${fmt(usage.incomplete)}`;
    const alias=document.createElement('p');alias.className='endpoint';alias.textContent=model.alias;
    card.append(heading,alias,total,list,note);$('model-usage').append(card);
  }
}
function renderNetwork(){const n=state.network;const modes={'macos-system':'Mac 系统代理',environment:'环境变量代理',mixed:'环境与系统代理',direct:'直连',checking:'检查中'};$('network-source').textContent=modes[n?.mode]??'后台待升级';$('network-route').textContent=n?.httpsProxy?'HTTPS → '+n.httpsProxy.protocol+'//'+n.httpsProxy.host:n?'HTTPS → 直连':'尚未读取代理';$('refresh-network').disabled=!n;$('check-network').disabled=!n;$('network-warning').textContent=(n?.warnings??[]).map(w=>({'pac-not-supported':'检测到 PAC 自动代理；本版仅读取 HTTP/HTTPS 代理地址。','all-proxy-not-supported':'ALL_PROXY 不会生效，请使用 HTTP_PROXY 和 HTTPS_PROXY。','unsupported-system-bypass':'部分系统绕过规则未映射；可通过 NO_PROXY 明确指定。'}[w]??'')).filter(Boolean).join(' ');$('network-checks').replaceChildren();for(const [id,result] of Object.entries(state.networkChecks??{})){const p=document.createElement('p');p.className='footnote '+(result.responseReceived?'status-good':'status-bad');p.textContent=(id==='openai'?'OpenAI':'DeepSeek')+'：'+(result.responseReceived?'网络已收到 HTTP '+result.status+'，未使用 Key':networkErrorText(result.category)+(result.code?' · '+result.code:''))+' · '+new Date(result.checkedAt).toLocaleTimeString('zh-CN');$('network-checks').append(p);}}
function render(){renderNetwork();renderModelUsage();const {totals,providers,recent}=state.usage;for(const k of ['total','input','output','requests'])$(k).textContent=fmt(totals[k]);$('cached').textContent='缓存命中 '+fmt(totals.cached);$('reasoning').textContent='其中推理 '+fmt(totals.reasoning);$('measured').textContent=`有用量回执 ${fmt(totals.measured)} · 未知 ${fmt(totals.unknown)}`;$('connection').textContent='已连接 · '+state.baseUrl;$('period').textContent=state.usage.began?'自 '+new Date(state.usage.began).toLocaleString('zh-CN')+' 起':'尚无经过本机后台的调用';$('provider-usage').replaceChildren();for(const p of state.providers){const usage=providers[p.id]??{requests:0,total:0};const row=document.createElement('div');row.className='provider-row';const mark=document.createElement('span');mark.className='provider-mark '+(p.id==='deepseek'?'deepseek':'');mark.textContent=p.id==='openai'?'O':'D';const text=document.createElement('p');text.append(document.createTextNode(p.id==='openai'?'OpenAI':'DeepSeek'));const small=document.createElement('small');small.textContent=fmt(usage.requests)+' 次请求';text.append(small);const total=document.createElement('strong');total.textContent=fmt(usage.total);row.append(mark,text,total);$('provider-usage').append(row);const status=$('status-'+p.id);status.textContent=p.ready?(p.persisted?'钥匙串已保存':'本次内存可用'):'待填写 Key';status.classList.toggle('ready',p.ready);status.closest('.card').querySelector('.key-time').textContent=p.keyUpdatedAt?'最近提交：'+new Date(p.keyUpdatedAt).toLocaleString('zh-CN'):'';}
$('key-storage').textContent=state.keyStorage?.unavailable?'钥匙串不可用':state.keyStorage?.supported?'本机钥匙串':'内存保管';
const unified=state.config.mode==='unified',apiMode=state.config.mode==='api',checking=state.config.mode==='checking';
const validation=state.unifiedCatalogValidation;
$('catalog-status').textContent=validation?'合并目录已通过 Codex '+validation.clientVersion+' 的实际加载校验。每次启用前会重新校验。':'暂缺官方模型元数据：恢复原订阅配置后，重新启动网关。';
$('unified-model-count').textContent=fmt(state.officialModels?.length)+' 个官方订阅模型 + '+fmt(state.providers.reduce((n,p)=>n+p.models.length,0))+' 个 API 模型';
$('activate').disabled=!validation;
$('config-status').textContent=checking?'检查配置中':unified?'已配置：统一模型菜单':apiMode?'当前仍为 API 兼容模式':state.config.mode==='subscription-or-original'?'已配置：官方直连':'配置状态待确认';
$('subscription-mode').classList.toggle('mode-configured',state.config.mode==='subscription-or-original');$('api-mode').classList.toggle('mode-configured',unified);
$('subscription-state').textContent=state.config.mode==='subscription-or-original'?'当前配置':'可恢复';$('api-state').textContent=unified?'当前配置':'可启用';
$('subscription-state').classList.toggle('subtle',state.config.mode!=='subscription-or-original');$('api-state').classList.toggle('subtle',!unified);
if(lastConfiguredModel!==state.config.model){if(state.config.model&&[...$('default-model').options].some(o=>o.value===state.config.model))$('default-model').value=state.config.model;lastConfiguredModel=state.config.model;}
const nativeUsage=providers.chatgpt;
if(nativeUsage){const row=document.createElement('div');row.className='provider-row';const label=document.createElement('p');label.textContent='ChatGPT 官方订阅';const note=document.createElement('small');note.textContent=fmt(nativeUsage.requests)+' 次请求 · 独立于 API 账单';label.append(note);const total=document.createElement('strong');total.textContent=nativeUsage.measured?fmt(nativeUsage.total):'用量未知';row.append(label,total);$('provider-usage').append(row);}
$('recent').replaceChildren();if(!recent.length){const tr=document.createElement('tr');const td=document.createElement('td');td.colSpan=7;td.className='empty';td.textContent='尚无请求。填写 Key 后可测试连接。';tr.append(td);$('recent').append(tr);}for(const row of recent){const tr=document.createElement('tr');const values=[new Date(row.time).toLocaleTimeString('zh-CN'),row.alias,`${row.status} · ${row.outcome==='completed'?'完成':row.outcome==='upstream_error'?'上游错误':row.outcome==='transport_or_request_error'?'连接或配置失败':row.outcome}`,row.usage?fmt(row.usage.input):'未知',row.usage?fmt(row.usage.output):'未知',row.usage?.reasoning==null?'—':fmt(row.usage.reasoning),row.retries];values.forEach((value,i)=>{const td=document.createElement('td');td.textContent=value;if(i===2)td.className=row.status<400&&row.outcome==='completed'?'status-good':'status-bad';tr.append(td);});$('recent').append(tr);}}
async function refresh(){try{state=await api('/api/state');if(!loaded){providerCards();
const group=document.createElement('optgroup');group.label='官方订阅';
for(const model of state.officialModels??[]){const option=document.createElement('option');option.value=model;option.textContent=state.catalogModels.find(m=>m.alias===model)?.name??model;group.append(option);}
const apiGroup=document.createElement('optgroup');apiGroup.label='API Key';
for(const model of state.providers.flatMap(p=>p.models)){const option=document.createElement('option');option.value=model.alias;option.textContent=state.catalogModels.find(m=>m.alias===model.alias)?.name??model.alias;apiGroup.append(option);}
$('default-model').replaceChildren(group,apiGroup);loaded=true;}render();}catch(error){$('connection').textContent='后台未连接或需要本机授权';if(!loaded)notice(error.message,true);}}
$('activate').onclick=e=>action(e.currentTarget,async()=>{await api('/api/config/unified',{model:$('default-model').value});notice('统一模型菜单已写入。用 ⌘Q 完全退出并重开 Codex，在新的本地聊天确认官方订阅和两家 API 模型；之后在同一网关对话中切换无需重启。');});
$('restore').onclick=e=>action(e.currentTarget,async()=>{await api('/api/config/restore',{});notice('官方订阅配置已恢复。用 ⌘Q 完全退出并重开 Codex 后，加载原官方模型列表。API Key 和历史用量已保留。');});
$('export').onclick=async()=>{try{const data=await api('/api/usage');const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='model-bridge-usage.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(error){notice(error.message,true);}};
$('refresh-network').onclick=e=>action(e.currentTarget,async()=>{await api('/api/network/refresh',{});notice('已重新读取代理设置；内存中的 Key 保留。');});
$('check-network').onclick=e=>action(e.currentTarget,async()=>{await Promise.all(state.providers.map(p=>api('/api/network/check',{provider:p.id})));notice('网络检测完成。HTTP 401 表示已收到上游响应，本次没有使用 Key。');});
await refresh();setInterval(refresh,4000);
