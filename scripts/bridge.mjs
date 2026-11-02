import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { gunzipSync, inflateSync, zstdDecompressSync } from 'node:zlib';
import { UsageTap } from './usage.mjs';
import { classifyNetworkError } from './network.mjs';

const MAX_BODY = 16 * 1024 * 1024;
const MAX_ERROR = 256 * 1024;
const own = (obj, key) => Object.hasOwn(obj, key);

class BridgeError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function validEnv(name) {
  return typeof name === 'string' && /^[A-Z][A-Z0-9_]*$/.test(name);
}

export function validateConfig(raw, { allowTestLoopback = false } = {}) {
  if (!raw || typeof raw !== 'object') throw new Error('Config must be an object.');
  const config = structuredClone(raw);
  config.host ??= '127.0.0.1';
  config.port ??= 17631;
  config.timeoutMs ??= 300000;
  if (config.host !== '127.0.0.1') throw new Error('This prototype only listens on 127.0.0.1.');
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error('Invalid port.');
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 3600000) throw new Error('Invalid timeoutMs.');
  if (!validEnv(config.accessTokenEnv)) throw new Error('Missing accessTokenEnv.');
  for (const [name, provider] of Object.entries(config.providers ?? {})) {
    if (provider.auth !== 'chatgpt' && !validEnv(provider.apiKeyEnv)) throw new Error(`Invalid apiKeyEnv for ${name}.`);
    const url = new URL(provider.baseUrl);
    const localTest = allowTestLoopback && url.protocol === 'http:' && url.hostname === '127.0.0.1';
    if ((!localTest && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash) {
      throw new Error(`Invalid upstream URL for ${name}. HTTPS is required.`);
    }
    provider.baseUrl = url.href.replace(/\/+$/, '');
    if (provider.auth === 'chatgpt' && !localTest && provider.baseUrl !== 'https://chatgpt.com/backend-api/codex') {
      throw new Error('ChatGPT credentials may only be forwarded to the official Codex service.');
    }
  }
  if (!Object.keys(config.routes ?? {}).length) throw new Error('At least one explicit model route is required.');
  for (const [alias, route] of Object.entries(config.routes)) {
    if (!alias || !own(config.providers ?? {}, route.provider) || typeof route.model !== 'string' || !route.model.trim()) {
      throw new Error(`Invalid route: ${alias}`);
    }
  }
  return config;
}

function authorized(header, token) {
  if (typeof header !== 'string') return false;
  const actual = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readLimited(stream, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw new BridgeError(413, 'body_too_large', 'Payload exceeds the prototype size limit.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function sendJSON(res, status, payload, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(payload));
}

// Adapted in part from CC Switch opaque_state_rectifier.rs and
// providers/codex_compaction.rs at 1cc2c7321395acff94afd00e126804b82dfa534e.
// Copyright (c) 2025 JasonYoung. MIT: ../vendor/cc-switch/LICENSE.
// Preserve same-backend state initially. Remove incompatible reasoning only
// after a specific upstream rejection, once, with the same model and credentials.
// Opaque compaction and encrypted tool/agent tasks need separate recovery; this
// prototype deliberately refuses to erase those tasks or the sole history carrier.
export function repairRejectedReasoning(body, status, errorBytes) {
  if (![400, 422].includes(status) || !Array.isArray(body.input)) return null;
  let error;
  try { error = JSON.parse(errorBytes.toString('utf8')); } catch { return null; }
  const rejection = error?.error;
  const contentPath = typeof rejection?.param === 'string' && /^input\[(\d+)\]\.content$/.exec(rejection.param);
  const rejectedItem = contentPath && body.input[Number(contentPath[1])];
  const plaintextRejected = rejection?.code === 'array_above_max_length'
    && typeof rejection.message === 'string' && rejection.message.includes('maximum length 0')
    && rejectedItem?.type === 'reasoning' && Array.isArray(rejectedItem.content) && rejectedItem.content.length > 0;
  if (rejection?.code !== 'invalid_encrypted_content' && !plaintextRejected) return null;
  if (body.input.some(item => item && (
    ['compaction', 'compaction_summary', 'context_compaction', 'agent_message', 'item_reference'].includes(item.type)
    || (item.type !== 'reasoning' && JSON.stringify(item).includes('"encrypted_content"'))
  ))) return null;
  const retained = body.input.filter(item => item?.type !== 'reasoning');
  if (!retained.length || retained.length === body.input.length) return null;
  const prefixes = { message: 'msg_', function_call: 'fc_', custom_tool_call: 'ctc_', tool_search_call: 'tsc_', web_search_call: 'ws_' };
  const input = retained.map(item => {
    const prefix = prefixes[item?.type];
    if (!prefix || !own(item, 'id') || (typeof item.id === 'string' && item.id.startsWith(prefix))) return item;
    const copy = { ...item }; delete copy.id; return copy;
  });
  return { ...body, input };
}

export function createBridge(rawConfig, {
  env = process.env,
  allowTestLoopback = false,
  onEvent = () => {},
  onReceipt = () => {},
  onRequestStart = () => {},
  handleRequest,
  catalog,
} = {}) {
  const config = validateConfig(rawConfig, { allowTestLoopback });
  const token = env[config.accessTokenEnv];
  if (typeof token !== 'string' || token.length < 24) throw new Error(`${config.accessTokenEnv} must contain at least 24 characters.`);
  const server = http.createServer(async (req, res) => {
    const controller = new AbortController();
    let timer;
    const began = Date.now();
    let receipt;
    let recorded = false;
    let releaseRequest;
    const record = values => { if (!recorded && receipt) { recorded = true; onReceipt({ ...receipt, durationMs: Date.now() - began, ...values }); } };
    res.once('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    try {
      if (handleRequest && await handleRequest(req,res)) return;
      const path = new URL(req.url, 'http://127.0.0.1').pathname;
      if (req.method === 'GET' && path === '/healthz') {
        return sendJSON(res, 200, { status: 'ok', mode: 'responses-api-prototype', liveBillingVerified: false });
      }
      const guarded = authorized(typeof req.headers['x-codex-bridge-token'] === 'string' ? 'Bearer '+req.headers['x-codex-bridge-token'] : null, token);
      if (!authorized(req.headers.authorization, token) && !guarded) throw new BridgeError(401, 'bridge_auth_required', 'A valid local bridge bearer token is required.');
      if (req.method === 'GET' && path === '/codex/models' && catalog) return sendJSON(res,200,catalog);
      if (req.method === 'GET' && path === '/v1/models') {
        // Diagnostic list only. This is not the richer Codex Models catalog.
        return sendJSON(res, 200, { object: 'list', data: Object.keys(config.routes).map(id => ({ id, object: 'model' })) });
      }
      if (req.method !== 'POST' || path !== '/v1/responses') throw new BridgeError(404, 'unsupported_endpoint', 'This prototype supports POST /v1/responses.');
      if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) throw new BridgeError(415, 'json_required', 'Use application/json.');
      let body;
      try {
        let bytes = await readLimited(req, MAX_BODY);
        const encoding = req.headers['content-encoding'];
        if (encoding && encoding !== 'identity') {
          const decode = { gzip: gunzipSync, deflate: inflateSync, zstd: zstdDecompressSync }[encoding];
          if (!decode) throw new BridgeError(415,'unsupported_encoding','Unsupported request compression.');
          bytes = decode(bytes,{maxOutputLength:MAX_BODY});
        }
        body = JSON.parse(bytes.toString('utf8'));
      }
      catch (error) {
        if (error instanceof BridgeError) throw error;
        throw new BridgeError(400, 'invalid_json', 'Request body must be valid JSON.');
      }
      if (!body || Array.isArray(body) || typeof body !== 'object' || !own(config.routes, body.model)) {
        throw new BridgeError(400, 'unknown_model_route', 'Choose an explicitly configured model alias; there is no automatic provider fallback.');
      }
      const alias = body.model;
      const route = config.routes[alias];
      const provider = config.providers[route.provider];
      receipt = { provider: route.provider, alias, status: 0, retries: 0 };
      releaseRequest = onRequestStart();
      const subscription = provider.auth === 'chatgpt';
      const apiKey = env[provider.apiKeyEnv];
      if (subscription && (!guarded || !/^Bearer \S{8,8192}$/.test(req.headers.authorization ?? '') || authorized(req.headers.authorization,token))) {
        throw new BridgeError(401,'chatgpt_login_required','Reload Codex with the combined provider and ChatGPT sign-in; an old API-only session cannot use subscription models.');
      }
      if (!subscription && !apiKey) throw new BridgeError(503, 'provider_key_missing', `Set ${provider.apiKeyEnv} locally before testing this route.`);
      body = { ...body, model: route.model };
      timer = setTimeout(() => controller.abort(), config.timeoutMs);
      // Only subscription routes retain the native client's headers and OAuth.
      // The separate local guard is never sent upstream. API routes construct
      // their own headers below, so account IDs/cookies/OAuth cannot leak.
      const nativeHeaders = {};
      if (subscription) for (const [name,value] of Object.entries(req.headers)) {
        if (typeof value !== 'string' || /^(host|connection|content-length|content-encoding|transfer-encoding|cookie|origin|referer|x-codex-bridge-token|upgrade|te|trailer|keep-alive)$/.test(name) || /^(proxy-|sec-)/.test(name)) continue;
        nativeHeaders[name] = value;
      }
      const requestUpstream = payload => fetch(`${provider.baseUrl}/responses`, {
        method: 'POST',
        // Never forward the local bearer, ChatGPT OAuth, cookies or account ID.
        // Identify this gateway honestly; no client impersonation or billing flags.
        headers: subscription ? { ...nativeHeaders, 'content-type':'application/json' } : {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: payload.stream ? 'text/event-stream' : 'application/json',
          'user-agent': 'codex-model-bridge-probe/0.1 (Codex local gateway)',
        },
        body: JSON.stringify(payload),
        redirect: 'error',
        signal: controller.signal,
      });
      let response = await requestUpstream(body);
      let errorBytes;
      let retries = 0;
      if (!response.ok) {
        errorBytes = await readLimited(response.body, MAX_ERROR);
        const repaired = repairRejectedReasoning(body, response.status, errorBytes);
        if (repaired) {
          retries = 1;
          response = await requestUpstream(repaired);
          errorBytes = response.ok ? undefined : await readLimited(response.body, MAX_ERROR);
        }
      }
      receipt.status = response.status; receipt.retries = retries;
      const headers = {
        'content-type': response.headers.get('content-type') ?? 'application/json',
        'cache-control': 'no-store',
        'x-bridge-provider': route.provider,
        'x-bridge-state-retries': String(retries),
      };
      for (const name of ['x-request-id', 'retry-after']) {
        const value = response.headers.get(name);
        if (value) headers[name] = value;
      }
      if (subscription) for (const [name,value] of response.headers) {
        if (/^x-codex-/.test(name)) headers[name] = value;
      }
      onEvent({ provider: route.provider, alias, status: response.status, reasoningRetry: retries });
      res.writeHead(response.status, headers);
      if (errorBytes) { res.end(errorBytes); record({ outcome: 'upstream_error', usage: null }); }
      else if (response.body) {
        const tap = new UsageTap(headers['content-type']);
        try { await pipeline(Readable.fromWeb(response.body), tap, res); }
        finally { record({ outcome: ['completed','failed','incomplete'].includes(tap.responseStatus) ? tap.responseStatus : res.writableFinished ? 'completed' : 'interrupted', usage: tap.usage, responseStatus: tap.responseStatus }); }
      } else { res.end(); record({ outcome: 'completed', usage: null }); }
    } catch (error) {
      const failureStatus = error instanceof BridgeError ? error.status : controller.signal.aborted ? 504 : 502;
      const network = error instanceof BridgeError ? null : classifyNetworkError(error);
      if (receipt && !recorded) { receipt.status = failureStatus; record({ outcome: 'transport_or_request_error', usage: null, network }); }
      if (res.headersSent) res.destroy();
      else if (!res.destroyed) {
        const status = error instanceof BridgeError ? error.status : controller.signal.aborted ? 504 : 502;
        const code = error instanceof BridgeError ? error.code : controller.signal.aborted ? 'upstream_timeout' : 'upstream_transport_error';
        const host = receipt ? new URL(config.providers[receipt.provider].baseUrl).hostname : 'upstream';
        const detail = {tls_or_connection_reset:'TLS handshake or connection was reset; check the proxy route and selected proxy node.',
          connection_refused:'Connection was refused; check that the configured proxy is running.',
          dns_failed:'DNS lookup failed; check the proxy and DNS route.',
          tls_verification_failed:'TLS certificate verification failed.',
          connect_timeout:'Connection timed out; check the proxy route and connectivity.'}[network?.category];
        sendJSON(res, status, { error: { code, message: error instanceof BridgeError ? error.message : detail ? `${host}: ${detail} (${network.code ?? network.category})` : 'Upstream request did not complete. Check the endpoint and connectivity.',
          ...(code==='upstream_transport_error'?{network}:{}) } });
      }
    } finally {
      if (timer) clearTimeout(timer);
      if(typeof releaseRequest==='function')releaseRequest();
    }
  });
  server.on('upgrade', (_req, socket) => {
    socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!process.argv[2]) throw new Error('Usage: node scripts/bridge.mjs config.json');
    const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    const server = createBridge(config, { onEvent: event => console.log(JSON.stringify(event)) });
    server.on('error', error => {
      console.error(`Bridge could not start (${error.code ?? 'server_error'}).`);
      process.exitCode = 1;
    });
    server.listen(config.port ?? 17631, '127.0.0.1', () => console.log(`Bridge listening at http://127.0.0.1:${server.address().port}`));
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
      server.close();
      server.closeAllConnections();
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
