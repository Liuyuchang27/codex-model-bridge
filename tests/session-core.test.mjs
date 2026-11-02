import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createInMemoryTestSession } from '../scripts/session-core.mjs';

test('native-form credentials reach the actual gateway without being present in process.env', async t => {
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"status":"completed","output":[]}');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const baseUrl = `http://127.0.0.1:${upstream.address().port}`;
  const config = {
    accessTokenEnv: 'FORM_FIXTURE_LOCAL_TOKEN',
    providers: {
      openai: { baseUrl, apiKeyEnv: 'FORM_FIXTURE_OPENAI_KEY' },
      deepseek: { baseUrl, apiKeyEnv: 'FORM_FIXTURE_DEEPSEEK_KEY' },
    },
    routes: {
      'openai-api/test': { provider: 'openai', model: 'openai-model' },
      'deepseek/test': { provider: 'deepseek', model: 'deepseek-model' },
    },
  };
  const session = createInMemoryTestSession(config, { deepseek: 'fixture-form-deepseek' }, { allowTestLoopback: true });
  session.server.listen(0, '127.0.0.1');
  await once(session.server, 'listening');
  t.after(async () => {
    session.server.closeAllConnections();
    await new Promise(resolve => session.server.close(resolve));
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  });
  assert.deepEqual(session.providers, ['deepseek']);
  assert.deepEqual(session.aliases, ['deepseek/test']);
  assert.equal(process.env.FORM_FIXTURE_DEEPSEEK_KEY, undefined);
  assert.equal(process.env.FORM_FIXTURE_LOCAL_TOKEN, undefined);
  const local = `http://127.0.0.1:${session.server.address().port}/v1/responses`;
  const response = await fetch(local, {
    method: 'POST', headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' },
    body: '{"model":"deepseek/test","input":"hello"}',
  });
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  assert.equal(seen[0].authorization, 'Bearer fixture-form-deepseek');
  assert.equal(seen[0].body.model, 'deepseek-model');
  const missing = await fetch(local, {
    method: 'POST', headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' },
    body: '{"model":"openai-api/test","input":"hello"}',
  });
  assert.equal(missing.status, 400);
  await missing.arrayBuffer();
  assert.equal(seen.length, 1);
});

test('empty form values do not produce a running gateway', () => {
  assert.throws(() => createInMemoryTestSession({ accessTokenEnv: 'TOKEN', providers: { p: { apiKeyEnv: 'KEY', baseUrl: 'https://example.com' } }, routes: { alias: { provider: 'p', model: 'model' } } }, {}), /at least one/);
});
