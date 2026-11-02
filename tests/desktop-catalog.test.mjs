import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildDesktopCatalog } from '../scripts/desktop-config.mjs';
test('desktop metadata retains native instructions and tool settings while constraining gateway transports and tiers',()=>{
  const native={slug:'native',model_messages:{instructions_template:'native instructions'},tool_mode:'code_mode_only',context_window:500000,service_tiers:[{id:'priority'}],use_responses_lite:true,available_access_programs:{cyber:['standard']}};
  const result=buildDesktopCatalog({routes:{'openai-api/native':{provider:'openai',model:'native'}}},{openai:{identity:'not-for-catalog',models:[native]}});
  const model=result.models[0];assert.equal(model.tool_mode,'code_mode_only');assert.equal(model.model_messages.instructions_template,'native instructions');assert.equal(model.context_window,500000);
  assert.deepEqual(model.service_tiers,[]);assert.equal(model.prefer_websockets,false);assert.equal(model.use_responses_lite,false);assert.equal(result.identity,undefined);assert.equal(native.use_responses_lite,true);
  assert.equal(model.available_access_programs,null,'an empty object is invalid for Codex ModelAccessPrograms');
  assert.deepEqual(native.available_access_programs,{cyber:['standard']});
});

test('Flash and Pro keep distinct aliases, names and native capabilities while sharing one DeepSeek credential',()=>{
  const config=JSON.parse(readFileSync(new URL('../config.example.json',import.meta.url),'utf8'));
  const deepseek=JSON.parse(readFileSync(new URL('../vendor/cc-switch/codex_deepseek_catalog_template.json',import.meta.url),'utf8'));
  const routes=Object.fromEntries(Object.entries(config.routes).filter(([,route])=>route.provider==='deepseek'));
  const catalog=buildDesktopCatalog({routes},{deepseek});
  assert.deepEqual(catalog.models.map(m=>m.slug),['deepseek/deepseek-flash','deepseek/deepseek-v4-pro']);
  assert.deepEqual(catalog.models.map(m=>m.display_name),['DeepSeek Flash · API','DeepSeek V4 Pro · API']);
  assert.deepEqual(catalog.models[0].input_modalities,['text','image']);
  assert.deepEqual(catalog.models[1].input_modalities,['text']);
  assert.deepEqual(catalog.models[1].supported_reasoning_levels.map(r=>r.effort),['low','high','max']);
  assert.equal(config.providers.deepseek.apiKeyEnv,'DEEPSEEK_API_KEY');
  assert.equal(routes['deepseek/deepseek-v4-pro'].model,'deepseek-v4-pro');
});
