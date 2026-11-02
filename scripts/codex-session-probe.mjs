import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';

const arg = flag => { const i = process.argv.indexOf(flag); return i < 0 ? undefined : process.argv[i + 1]; };
const required = flag => { const value = arg(flag); if (!value) throw new Error(`Missing ${flag}.`); return value; };
let child;
const pending = new Map();
const waiters = new Set();
const notifications = [];
let nextId = 0;
let token;
const safe = value => String(value).replaceAll(token || '<no-token>', '[local-token]').replace(/sk-[A-Za-z0-9_-]+/g, '[redacted-key]').slice(0, 1000);
function send(value) { child.stdin.write(JSON.stringify(value) + '\n'); }
function rpc(method, params) {
  const id = ++nextId;
  return new Promise((accept, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, 30000);
    pending.set(id, { accept, reject, timer });
    send({ id, method, params });
  });
}
function waitFor(predicate, timeoutMs = 90000) {
  const old = notifications.find(predicate);
  if (old) return Promise.resolve(old);
  return new Promise((accept, reject) => {
    const waiter = { predicate, accept, timer: setTimeout(() => { waiters.delete(waiter); reject(new Error('Turn completion timeout.')); }, timeoutMs) };
    waiters.add(waiter);
  });
}
const report = { began: new Date().toISOString(), scope: 'one ephemeral Codex app-server thread with per-turn model switches; isolated probe instructions', results: [], creditSource: 'unverified-check-organization-billing' };
let receiptDir;
try {
  const cli = required('--codex');
  const session = JSON.parse(readFileSync(required('--session'), 'utf8'));
  token = session.token;
  const local = new URL(session.baseUrl);
  if (local.protocol !== 'http:' || local.hostname !== '127.0.0.1' || local.username || local.password || local.search || local.hash || typeof token !== 'string' || token.length < 24) throw new Error('Expected a private loopback gateway session.');
  const catalogPath = resolve(required('--catalog'));
  const models = JSON.parse(readFileSync(catalogPath, 'utf8')).models;
  const aliases = ['openai-api/gpt-6.1-sol', 'deepseek/deepseek-flash'];
  if (!aliases.every(alias => models.some(m => m.slug === alias))) throw new Error('Probe catalog must include both configured model aliases.');
  const workDir = resolve(required('--work-dir'));
  receiptDir = resolve(required('--receipts-dir'));
  mkdirSync(workDir, { recursive: true, mode: 0o700 });
  const instructions = join(workDir, 'session-probe-instructions.txt');
  writeFileSync(instructions, 'You are running a bounded conversation continuity test. Follow the user exact-output instructions. Remember facts in the readable conversation across model switches. Do not call any tool, inspect files or environment, use network, or delegate.');
  const config = {
    model_provider: 'bridge-probe',
    model_providers: { 'bridge-probe': { name: 'Codex Model Bridge Probe', base_url: session.baseUrl + '/v1', env_key: 'CODEX_BRIDGE_TOKEN', wire_api: 'responses', supports_websockets: false, request_max_retries: 0, stream_max_retries: 0 } },
    model_catalog_json: catalogPath, model_instructions_file: instructions,
    model_reasoning_effort: 'low', web_search: 'disabled', project_doc_max_bytes: 0,
    features: { multi_agent: false, plugins: false, apps: false }, agents: { enabled: false },
    skills: { max_context_tokens: 1 }, mcp_servers: {}, hooks: {}, analytics: { enabled: false },
    shell_environment_policy: { inherit: 'core', exclude: ['CODEX_BRIDGE_TOKEN','OPENAI_API_KEY','DEEPSEEK_API_KEY'] },
  };
  const toml = value => Array.isArray(value) ? '[' + value.map(toml).join(',') + ']' : value && typeof value === 'object' ? '{' + Object.entries(value).map(([k,v]) => JSON.stringify(k) + '=' + toml(v)).join(',') + '}' : JSON.stringify(value);
  const args = ['app-server', '--stdio', ...Object.entries(config).flatMap(([k,v]) => ['-c', k + '=' + toml(v)])];
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => ['HOME','USER','LOGNAME','PATH','TMPDIR','LANG','LC_ALL','SHELL'].includes(k)));
  env.NO_PROXY = '127.0.0.1,localhost'; env.CODEX_BRIDGE_TOKEN = token; env.RUST_LOG = 'error';
  child = spawn(cli, args, { env, cwd: workDir, stdio: ['pipe','pipe','pipe'] });
  let buffer = '';
  child.stderr.resume();
  child.stdout.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 4e6) { child.kill(); return; }
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0,index); buffer = buffer.slice(index+1);
      let message; try { message = JSON.parse(line); } catch { continue; }
      if (message.id != null && !message.method) {
        const request = pending.get(message.id);
        if (request) { clearTimeout(request.timer); pending.delete(message.id); message.error ? request.reject(new Error(`Codex RPC rejected request (code ${Number.isInteger(message.error.code) ? message.error.code : 'unknown'}).`)) : request.accept(message.result); }
      } else if (message.id != null && message.method) {
        send({ id: message.id, error: { code: -32601, message: 'Interactive actions are disabled for this bounded probe.' } });
      } else if (message.method) {
        notifications.push(message);
        for (const waiter of waiters) if (waiter.predicate(message)) { clearTimeout(waiter.timer); waiters.delete(waiter); waiter.accept(message); }
      }
    }
  });
  child.on('error', () => { for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error('Could not launch Codex app-server.')); } pending.clear(); });
  child.on('close', () => { for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error('Codex app-server exited before replying.')); } pending.clear(); });
  const initialized = await rpc('initialize', { clientInfo: { name: 'codex_model_bridge_probe', title: 'Codex Model Bridge Probe', version: '0.1.0' }, capabilities: { experimentalApi: true } });
  report.codexUserAgent = initialized.userAgent ?? null;
  send({ method: 'initialized', params: {} });
  const list = await rpc('model/list', { includeHidden: false });
  const listed = (list.data ?? []).map(m => m.model ?? m.id);
  report.catalogAliasesVisible = aliases.every(alias => listed.includes(alias));
  console.log(JSON.stringify({ test: 'codex_model_list', passed: report.catalogAliasesVisible, aliases: listed.filter(x => aliases.includes(x)) }));
  if (!report.catalogAliasesVisible) throw new Error('Configured model aliases were not visible in the Codex model list.');
  const started = await rpc('thread/start', { model: aliases[0], modelProvider: 'bridge-probe', cwd: workDir, ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never', config });
  report.ephemeral = started.thread.ephemeral === true;
  if (!report.ephemeral) throw new Error('Codex did not confirm an ephemeral probe thread.');
  const threadId = started.thread.id;
  const markerA = 'OPENAI_' + randomBytes(8).toString('hex');
  const markerB = 'DEEPSEEK_' + randomBytes(8).toString('hex');
  const steps = [
    { model: aliases[0], test: 'seed_openai_history', prompt: `Remember project token A: ${markerA}. Reply exactly ACK.`, expected: 'ACK' },
    { model: aliases[1], effort: 'high', test: 'openai_to_deepseek_history', prompt: `Remember project token B: ${markerB}. Internally verify that (37*41)+29 equals 1546, then return exactly project token A from earlier, and nothing else.`, expected: markerA },
    { model: aliases[0], test: 'deepseek_to_openai_history', prompt: 'Return exactly project token B from earlier, and nothing else.', expected: markerB },
  ];
  for (const step of steps) {
    const begin = await rpc('turn/start', { threadId, model: step.model, effort: step.effort ?? 'low', input: [{ type: 'text', text: step.prompt }] });
    const turnId = begin.turn.id;
    const end = await waitFor(e => e.method === 'turn/completed' && e.params.turn.id === turnId);
    const items = notifications.filter(e => e.method === 'item/completed' && e.params.turnId === turnId).map(e => e.params.item);
    const answer = items.filter(i => i.type === 'agentMessage').map(i => i.text ?? '').join('');
    const row = { test: step.test, alias: step.model, status: end.params.turn.status, passed: end.params.turn.status === 'completed' && answer.trim() === step.expected,
      expectedText: answer.trim() === step.expected, toolCalls: items.filter(i => i.type === 'commandExecution').length,
      errorCode: typeof end.params.turn.error?.codexErrorInfo === 'string' ? end.params.turn.error.codexErrorInfo : end.params.turn.error ? 'client_error' : null };
    report.results.push(row); console.log(JSON.stringify(row));
    if (!row.passed) { process.exitCode = 1; break; }
  }
} catch (error) { report.failure = safe(error.message); console.log(JSON.stringify({ status: 'probe_failed', diagnostic: report.failure })); process.exitCode = 1; }
finally {
  if (child) child.kill('SIGTERM');
  for (const p of pending.values()) clearTimeout(p.timer);
  for (const w of waiters) clearTimeout(w.timer);
  report.completed = new Date().toISOString();
  if (receiptDir) {
    mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
    const path = join(receiptDir, `codex-session-${Date.now()}.json`);
    writeFileSync(path, JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ report: path, passed: report.results.filter(r => r.passed).length, checks: report.results.length }));
  }
}
