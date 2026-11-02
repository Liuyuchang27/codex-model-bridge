import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDesktopCatalog } from '../scripts/desktop-config.mjs';
test('desktop metadata retains native instructions and tool settings while constraining gateway transports and tiers',()=>{
  const native={slug:'native',model_messages:{instructions_template:'native instructions'},tool_mode:'code_mode_only',context_window:500000,service_tiers:[{id:'priority'}],use_responses_lite:true,available_access_programs:{cyber:['standard']}};
  const result=buildDesktopCatalog({routes:{'openai-api/native':{provider:'openai',model:'native'}}},{openai:{identity:'not-for-catalog',models:[native]}});
  const model=result.models[0];assert.equal(model.tool_mode,'code_mode_only');assert.equal(model.model_messages.instructions_template,'native instructions');assert.equal(model.context_window,500000);
  assert.deepEqual(model.service_tiers,[]);assert.equal(model.prefer_websockets,false);assert.equal(model.use_responses_lite,false);assert.equal(result.identity,undefined);assert.equal(native.use_responses_lite,true);
  assert.equal(model.available_access_programs,null,'an empty object is invalid for Codex ModelAccessPrograms');
  assert.deepEqual(native.available_access_programs,{cyber:['standard']});
});
