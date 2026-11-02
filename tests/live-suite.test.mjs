import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { runLiveSuite, readSSE } from '../scripts/live-suite.mjs';

async function host(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
const success = { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'BRIDGE_OK' }] }], usage: { input_tokens: 12, output_tokens: 3 } };

test('the live-test driver completes text, stream, tool call and same-backend continuation with bounded requests', async t => {
  const requests = [];
  const url = await host(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    requests.push(body);
    assert.equal(req.headers.authorization, 'Bearer fixture-token');
    res.setHeader('x-request-id', 'fixture-request');
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: {"type":"response.output_text.delta","delta":"BRIDGE_OK"}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: success })}\n\n`);
    } else if (body.tools && body.tool_choice === 'auto') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'completed', output: [
        { type: 'reasoning', encrypted_content: 'fixture-same-provider' },
        { type: 'function_call', name: 'report_probe', call_id: 'fixture-call-id', arguments: '{"ping":"BRIDGE_OK"}' },
      ] }));
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(success));
    }
  });
  const result = await runLiveSuite({ baseUrl: url, token: 'fixture-token', aliases: ['fixture-model'] });
  assert.equal(requests.length, 4);
  assert.equal(result.results.length, 4);
  assert.ok(result.results.every(row => row.passed));
  assert.equal(requests[3].input[1].encrypted_content, 'fixture-same-provider');
  assert.equal(requests[3].input.at(-1).call_id, 'fixture-call-id');
  assert.ok(!JSON.stringify(result).includes('fixture-same-provider'));
  assert.ok(!JSON.stringify(result).includes('fixture-token'));
});

test('a failed access/credit check stops later requests and excludes raw error text from the receipt', async t => {
  let requests = 0;
  const url = await host(t, async (req, res) => {
    for await (const _chunk of req) {}
    requests++;
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'credit_balance_exhausted', message: 'fixture-private-data-do-not-log' } }));
  });
  const report = await runLiveSuite({ baseUrl: url, token: 'fixture-token', aliases: ['fixture-model'] });
  assert.equal(requests, 1);
  assert.equal(report.results[0].errorCode, 'credit_balance_exhausted');
  assert.equal(report.results[0].passed, false);
  assert.ok(!JSON.stringify(report).includes('fixture-private-data'));
});

test('SSE parser survives split UTF-8 code points and CRLF event separators', async () => {
  const data = Buffer.from('data: {"type":"response.output_text.delta","delta":"你好"}\r\n\r\ndata: {"type":"response.completed","response":{"status":"completed"}}\r\n\r\n');
  const stream = new ReadableStream({ start(controller) { for (const byte of data) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  const result = await readSSE(new Response(stream));
  assert.equal(result.text, '你好');
  assert.equal(result.final.status, 'completed');
});
