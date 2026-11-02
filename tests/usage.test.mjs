import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeUsage, UsageTap, createUsageLedger } from '../scripts/usage.mjs';

const usage={input_tokens:100,output_tokens:30,total_tokens:130,input_tokens_details:{cached_tokens:40,cache_write_tokens:20},output_tokens_details:{reasoning_tokens:10}};
test('model totals distinguish aliases within one provider and reconstruct the complete historical ledger',t=>{
  const dir=mkdtempSync(join(tmpdir(),'bridge-model-usage-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=join(dir,'usage.jsonl');
  const ledger=createUsageLedger(file);
  for(let i=0;i<55;i++)ledger.record({provider:'openai',alias:'openai/a',status:200,outcome:'completed',usage:normalizeUsage(usage)});
  ledger.record({provider:'openai',alias:'openai/b',status:502,outcome:'upstream_error',usage:null});
  ledger.record({provider:'deepseek',alias:'deepseek/c',status:200,outcome:'completed',usage:normalizeUsage({input_tokens:8,output_tokens:2})});
  ledger.record({provider:'deepseek',alias:'deepseek/c',status:200,outcome:'incomplete',usage:normalizeUsage({input_tokens:1,output_tokens:2})});
  const result=createUsageLedger(file).summary();
  assert.equal(result.recent.length,50);assert.equal(result.models['openai/a'].total,7150);
  assert.equal(result.models['openai/a'].cacheWrite,1100);assert.equal(result.models['openai/b'].unknown,1);assert.equal(result.models['openai/b'].failed,1);
  assert.equal(result.models['deepseek/c'].total,13);assert.equal(result.models['deepseek/c'].incomplete,1);assert.equal(result.models['deepseek/c'].failed,0);assert.equal(result.providers.openai.requests,56);assert.equal(result.providers.openai.failed,1);
  assert.equal(Object.values(result.models).reduce((n,m)=>n+m.total,0),result.totals.total);
});
test('token subsets are preserved without counting reasoning or cache hits twice',()=>{
  assert.deepEqual(normalizeUsage(usage),{input:100,output:30,total:130,cached:40,cacheWrite:20,reasoning:10});
  assert.equal(normalizeUsage(null),null);
  assert.equal(normalizeUsage({input_tokens:-1,output_tokens:1}),null);
  assert.equal(normalizeUsage({input_tokens:0,output_tokens:0}).total,0);
});
test('usage observer passes SSE bytes unchanged across UTF-8 and CRLF splits and reads final usage once',async()=>{
  const text='data: '+JSON.stringify({type:'response.output_text.delta',delta:'你好'})+'\r\n\r\n'+'data: '+JSON.stringify({type:'response.completed',response:{status:'completed',usage}})+'\r\n\r\ndata: [DONE]\r\n\r\n';
  const bytes=Buffer.from(text);const tap=new UsageTap('text/event-stream');const chunks=[];tap.on('data',c=>chunks.push(c));
  await pipeline(Readable.from([...bytes].map(b=>Buffer.from([b]))),tap);
  assert.deepEqual(Buffer.concat(chunks),bytes);assert.equal(tap.usage.total,130);assert.equal(tap.responseStatus,'completed');
});
test('JSON observation keeps unknown usage unknown rather than generating a zero count',async()=>{
  for(const payload of [{status:'completed',usage},{status:'incomplete',usage:null}]){
    const tap=new UsageTap('application/json');tap.resume();await pipeline(Readable.from([JSON.stringify(payload)]),tap);
    assert.equal(tap.usage?.total??null,payload.usage?130:null);assert.equal(tap.responseStatus,payload.status);
  }
});
test('persistent ledger uses a private allowlist, survives reload and excludes keys, prompts and raw errors',t=>{
  const dir=mkdtempSync(join(tmpdir(),'bridge-usage-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=join(dir,'usage.jsonl');
  const ledger=createUsageLedger(file);
  ledger.record({provider:'openai',alias:'openai-api/test',status:200,outcome:'completed',durationMs:1,usage:normalizeUsage(usage),apiKey:'fixture-secret',input:'private-prompt',error:'raw-error'});
  ledger.record({provider:'openai',alias:'openai-api/test',status:502,outcome:'transport_or_request_error',durationMs:1,usage:null});
  const content=readFileSync(file,'utf8');for(const value of ['fixture-secret','private-prompt','raw-error'])assert.ok(!content.includes(value));
  assert.equal(statSync(file).mode&0o777,0o600);
  const totals=createUsageLedger(file).summary().totals;assert.equal(totals.total,130);assert.equal(totals.requests,2);assert.equal(totals.measured,1);assert.equal(totals.unknown,1);assert.equal(totals.failed,1);
});
