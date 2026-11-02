import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createBridge, validateConfig, repairRejectedReasoning } from '../scripts/bridge.mjs';
import { createNetworkController } from '../scripts/network.mjs';

const token = 'test-only-local-bridge-token-123456';
async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
async function fixture(t, answer, bridgeOptions = {}) {
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = { path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks)) };
    seen.push(request);
    await answer(request, res, seen.length);
  });
  const url = await listen(upstream);
  const config = {
    port: 0, accessTokenEnv: 'BRIDGE_TOKEN', timeoutMs: 3000,
    providers: {
      openai: { baseUrl: `${url}/v1`, apiKeyEnv: 'OPENAI_TEST_KEY' },
      deepseek: { baseUrl: url, apiKeyEnv: 'DEEPSEEK_TEST_KEY' },
    },
    routes: {
      'openai-api/test': { provider: 'openai', model: 'native-openai' },
      'deepseek/test': { provider: 'deepseek', model: 'native-deepseek' },
    },
  };
  const bridge = createBridge(config, {
    allowTestLoopback: true,
    env: { BRIDGE_TOKEN: token, OPENAI_TEST_KEY: 'fixture-openai', DEEPSEEK_TEST_KEY: 'fixture-deepseek' },
    ...bridgeOptions,
  });
  const local = await listen(bridge);
  t.after(async () => { await close(bridge); await close(upstream); });
  return {
    seen, url: local,
    post: (body, headers = {}) => fetch(`${local}/v1/responses`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  };
}
function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json', 'x-request-id': 'fixture-request' });
  res.end(JSON.stringify(payload));
}

test('transport resets return actionable safe diagnostics and record the network category',async t=>{
  const receipts=[];
  const f=await fixture(t,(_request,res)=>res.destroy(),{onReceipt:r=>receipts.push(r)});
  const response=await f.post({model:'openai-api/test',input:'test'});
  assert.equal(response.status,502);
  const payload=await response.json();
  assert.equal(payload.error.code,'upstream_transport_error');
  assert.equal(payload.error.network.category,'tls_or_connection_reset');
  assert.match(payload.error.message,/proxy route/);
  assert.equal(JSON.stringify(payload).includes('fixture-openai'),false);
  assert.equal(receipts[0].network.category,'tls_or_connection_reset');
  assert.equal(receipts[0].retries,0);
});

test('each alias selects its own endpoint, model and key; local and ChatGPT credentials stay local', async t => {
  const f = await fixture(t, (request, res) => json(res, 200, { object: 'response', model: request.body.model, output: [] }));
  for (const [alias, expectedPath, expectedKey, expectedModel] of [
    ['openai-api/test', '/v1/responses', 'fixture-openai', 'native-openai'],
    ['deepseek/test', '/responses', 'fixture-deepseek', 'native-deepseek'],
  ]) {
    const response = await f.post({ model: alias, input: 'hello', stream: false }, {
      cookie: 'not-for-upstream', 'chatgpt-account-id': 'private-chatgpt-account',
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-request-id'), 'fixture-request');
    const sent = f.seen.at(-1);
    assert.equal(sent.path, expectedPath);
    assert.equal(sent.headers.authorization, `Bearer ${expectedKey}`);
    assert.equal(sent.headers.cookie, undefined);
    assert.equal(sent.headers['chatgpt-account-id'], undefined);
    assert.match(sent.headers['user-agent'], /Codex local gateway/);
    assert.equal(sent.body.model, expectedModel);
    assert.equal(sent.body.input, 'hello');
    await response.arrayBuffer();
  }
});

test('SSE deltas, UTF-8 text and final usage pass through unchanged', async t => {
  const chunks = [
    'event: response.created\ndata: {"type":"response.created"}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"你好"}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2}}}\n\n',
  ];
  const f = await fixture(t, async (_request, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const chunk of chunks) { res.write(chunk); await new Promise(resolve => setImmediate(resolve)); }
    res.end();
  });
  const response = await f.post({ model: 'deepseek/test', input: 'hi', stream: true });
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  assert.equal(await response.text(), chunks.join(''));
});

test('proxy refresh waits for the complete API stream and request guards release after upstream errors',async t=>{
  const network=createNetworkController({env:{},platform:'linux',setProxy:()=>()=>{}});
  await network.refresh();let finish;
  const f=await fixture(t,async(_request,res,n)=>{
    if(n!==1)return json(res,429,{error:{code:'credit_balance_exhausted'}});
    res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: {"type":"response.created"}\n\n');
    await new Promise(resolve=>{finish=resolve;});res.end('data: [DONE]\n\n');
  },{onRequestStart:()=>network.enter()});
  const stream=await f.post({model:'deepseek/test',input:'fixture',stream:true});
  assert.equal(network.status().activeRequests,1);await assert.rejects(network.refresh(),/请求正在进行/);
  finish();await stream.text();await new Promise(resolve=>setImmediate(resolve));assert.equal(network.status().activeRequests,0);
  const failure=await f.post({model:'deepseek/test',input:'fixture'});assert.equal(failure.status,429);await failure.arrayBuffer();
  await new Promise(resolve=>setImmediate(resolve));assert.equal(network.status().activeRequests,0);await network.refresh();network.close();
});

test('tool calls, freeform patches, call_id pairs and readable history remain intact', async t => {
  const f = await fixture(t, (_request, res) => json(res, 200, { output: [] }));
  const input = [
    { role: 'user', content: 'inspect then edit' },
    { type: 'function_call', call_id: 'call-7', name: 'read_file', arguments: '{"path":"a.txt"}' },
    { type: 'function_call_output', call_id: 'call-7', output: 'existing text' },
    { type: 'custom_tool_call', call_id: 'patch-1', name: 'apply_patch', input: '*** Begin Patch\n*** End Patch' },
    { type: 'custom_tool_call_output', call_id: 'patch-1', output: 'ok' },
  ];
  const tools = [{ type: 'custom', name: 'apply_patch', format: { type: 'text' } }];
  const response = await f.post({ model: 'deepseek/test', input, tools });
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  assert.deepEqual(f.seen[0].body.input, input);
  assert.deepEqual(f.seen[0].body.tools, tools);
});

test('explicit foreign-reasoning rejection retries once on the same provider, preserving task history', async t => {
  const f = await fixture(t, (_request, res, n) => n === 1
    ? json(res, 400, { error: { code: 'invalid_encrypted_content' } })
    : json(res, 200, { output: [] }));
  const input = [{ role: 'user', content: 'continue' }, { type: 'reasoning', encrypted_content: 'fixture-opaque-state' }, { role: 'assistant', content: 'done so far' }];
  const response = await f.post({ model: 'openai-api/test', input });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-bridge-state-retries'), '1');
  await response.arrayBuffer();
  assert.equal(f.seen.length, 2);
  assert.equal(f.seen[0].body.input.length, 3);
  assert.deepEqual(f.seen[1].body.input, [input[0], input[2]]);
  assert.equal(f.seen[1].headers.authorization, f.seen[0].headers.authorization);
  assert.equal(f.seen[1].body.model, f.seen[0].body.model);
});

test('repeated reasoning errors stop after a single retry', async t => {
  const f = await fixture(t, (_request, res) => json(res, 400, { error: { code: 'invalid_encrypted_content' } }));
  const response = await f.post({ model: 'deepseek/test', input: [{ role: 'user', content: 'hi' }, { type: 'reasoning', encrypted_content: 'fixture' }] });
  assert.equal(response.status, 400);
  await response.arrayBuffer();
  assert.equal(f.seen.length, 2);
});

test('balance errors never retry or switch to a different provider', async t => {
  const f = await fixture(t, (_request, res) => json(res, 429, { error: { code: 'credit_balance_exhausted' } }));
  const response = await f.post({ model: 'openai-api/test', input: 'hi' });
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error.code, 'credit_balance_exhausted');
  assert.equal(f.seen.length, 1);
});

test('opaque compacted history and active encrypted subagent tasks are not silently discarded', async t => {
  const f = await fixture(t, (_request, res) => json(res, 400, { error: { code: 'invalid_encrypted_content' } }));
  for (const special of [
    { type: 'compaction', encrypted_content: 'sole-history-carrier' },
    { type: 'agent_message', content: [{ type: 'encrypted_content', encrypted_content: 'current-task' }] },
  ]) {
    const response = await f.post({ model: 'deepseek/test', input: [special, { type: 'reasoning', encrypted_content: 'fixture' }] });
    assert.equal(response.status, 400);
    await response.arrayBuffer();
    assert.deepEqual(f.seen.at(-1).body.input[0], special);
  }
  assert.equal(f.seen.length, 2);
});

test('unknown routes and missing local authentication make no upstream calls', async t => {
  const f = await fixture(t, (_request, res) => json(res, 200, {}));
  const unknown = await f.post({ model: 'nonexistent', input: 'hi' });
  assert.equal(unknown.status, 400);
  await unknown.arrayBuffer();
  const denied = await f.post({ model: 'openai-api/test', input: 'hi' }, { authorization: 'Bearer wrong' });
  assert.equal(denied.status, 401);
  await denied.arrayBuffer();
  assert.equal(f.seen.length, 0);
});

test('configuration requires local binding and HTTPS production upstreams', () => {
  const good = { accessTokenEnv: 'TOKEN', providers: { p: { apiKeyEnv: 'KEY', baseUrl: 'https://example.com/v1' } }, routes: { alias: { provider: 'p', model: 'model' } } };
  assert.equal(validateConfig(good).host, '127.0.0.1');
  assert.throws(() => validateConfig({ ...good, host: '0.0.0.0' }), /127.0.0.1/);
  assert.throws(() => validateConfig({ ...good, providers: { p: { apiKeyEnv: 'KEY', baseUrl: 'http://example.com' } } }), /HTTPS/);
});

test('DeepSeek plaintext-reasoning rejection repairs history and foreign IDs in one same-provider retry', async t => {
  const f = await fixture(t, (_request, res, n) => n === 1
    ? json(res, 400, { error: { code: 'array_above_max_length', param: 'input[1].content', message: "Invalid 'input[1].content': array too long. Expected an array with maximum length 0." } })
    : json(res, 200, { output: [] }));
  const input = [
    { role: 'user', content: 'continue the project' },
    { type: 'reasoning', id: 'foreign_rs_1', content: [{ type: 'reasoning_text', text: 'fixture reasoning' }], encrypted_content: 'foreign-opaque-state' },
    { type: 'message', id: 'foreign_msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'project status' }] },
    { type: 'function_call', id: 'foreign_fc_1', call_id: 'keep-call-id', name: 'read_file', arguments: '{}' },
    { type: 'function_call_output', call_id: 'keep-call-id', output: 'file content' },
  ];
  const response = await f.post({ model: 'openai-api/test', input });
  assert.equal(response.status, 200); await response.arrayBuffer();
  assert.equal(f.seen.length, 2);
  assert.equal(f.seen[1].headers.authorization, f.seen[0].headers.authorization);
  const repaired = f.seen[1].body.input;
  assert.equal(repaired.length, 4);
  assert.equal(repaired[1].id, undefined);
  assert.equal(repaired[1].content[0].text, 'project status');
  assert.equal(repaired[2].id, undefined);
  assert.equal(repaired[2].call_id, repaired[3].call_id);
  assert.equal(input[2].id, 'foreign_msg_1');
});

test('an ordinary message content error must not trigger reasoning removal', () => {
  const body = { input: [{ type: 'message', content: ['task'] }, { type: 'reasoning', encrypted_content: 'fixture' }] };
  const error = Buffer.from(JSON.stringify({ error: { code: 'array_above_max_length', param: 'input[0].content', message: 'Expected maximum length 0' } }));
  assert.equal(repairRejectedReasoning(body, 400, error), null);
});

test('reasoning-only input and item references are not erased during recovery', () => {
  const error = Buffer.from('{"error":{"code":"invalid_encrypted_content"}}');
  for (const input of [[{ type: 'reasoning', encrypted_content: 'fixture' }], [{ type: 'item_reference', id: 'external-resource' }, { type: 'reasoning', encrypted_content: 'fixture' }]]) {
    assert.equal(repairRejectedReasoning({ input }, 400, error), null);
  }
});

test('unrelated invalid arguments do not trigger a retry', () => {
  const body = { input: [{ role: 'user', content: 'task' }, { type: 'reasoning', content: ['fixture'] }] };
  for (const error of [null, { error: null }, { error: { code: 'unknown_parameter', param: 'input[1].status' } }]) {
    assert.equal(repairRejectedReasoning(body, 400, Buffer.from(JSON.stringify(error))), null);
  }
});
