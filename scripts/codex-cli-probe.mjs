import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { PROBE_INSTRUCTIONS } from './probe-catalog.mjs';

const arg = flag => { const i = process.argv.indexOf(flag); return i < 0 ? undefined : process.argv[i + 1]; };
const required = flag => { const value = arg(flag); if (!value) throw new Error(`Missing ${flag}.`); return value; };
const dir = resolve(required('--work-dir'));
const receiptDir = resolve(required('--receipts-dir'));
const cli = required('--codex');
const installedConfig = process.argv.includes('--installed-config');
const catalogPath = resolve(required('--catalog'));
const sourceModels = JSON.parse(readFileSync(catalogPath, 'utf8')).models;
const models = arg('--model') ? sourceModels.filter(m => m.slug === arg('--model')) : sourceModels;
const session = JSON.parse(readFileSync(required('--session'), 'utf8'));
const local = new URL(session.baseUrl);
if (local.protocol !== 'http:' || local.hostname !== '127.0.0.1' || local.username || local.password || local.search || local.hash || typeof session.token !== 'string' || session.token.length < 24) throw new Error('Expected a private loopback gateway session.');
if (!Array.isArray(models) || !models.length || models.length > 8) throw new Error('Expected a bounded probe catalog.');
mkdirSync(dir, { recursive: true, mode: 0o700 });
writeFileSync(join(dir, 'probe.txt'), 'CODEX_BRIDGE_TOOL_OK\n');
const instructionsPath = join(dir, 'instructions.txt');
writeFileSync(instructionsPath, PROBE_INSTRUCTIONS);
const toml = value => JSON.stringify(value);
const report = { began: new Date().toISOString(), scope: installedConfig ? 'ephemeral CLI; installed user provider, catalog and credential helper; bounded instructions; read-only shell' : 'ephemeral CLI; isolated probe catalog and instructions; read-only shell', results: [], creditSource: 'unverified-check-organization-billing' };
for (const model of models) {
  const args = ['exec', ...(!installedConfig ? ['--ignore-user-config'] : []), '--ignore-rules', '--ephemeral', '--skip-git-repo-check',
    '--sandbox', 'read-only', '--json', '-C', dir, '-m', model.slug,
    ...(!installedConfig ? ['-c', 'model_provider="bridge-probe"',
    '-c', `model_providers.bridge-probe={name="Local Model Bridge Probe",base_url=${toml(session.baseUrl + '/v1')},env_key="CODEX_BRIDGE_TOKEN",wire_api="responses",supports_websockets=false,request_max_retries=0,stream_max_retries=0}`,
    '-c', `model_catalog_json=${toml(catalogPath)}`] : []), '-c', `model_instructions_file=${toml(instructionsPath)}`,
    '-c', 'model_reasoning_effort="low"', '-c', 'web_search="disabled"',
    '-c', 'features.multi_agent=false', '-c', 'features.plugins=false', '-c', 'features.apps=false',
    '-c', 'mcp_servers={}', '-c', 'hooks={}',
    '-c', 'skills.max_context_tokens=1', '-c', 'project_doc_max_bytes=0',
    '-c', 'shell_environment_policy.inherit="core"',
    '-c', 'shell_environment_policy.exclude=["CODEX_BRIDGE_TOKEN","OPENAI_API_KEY","DEEPSEEK_API_KEY"]',
    'Read probe.txt using the shell tool, then return exactly its content. Do not infer or guess its content.'];
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => ['HOME','USER','LOGNAME','PATH','TMPDIR','LANG','LC_ALL','SHELL'].includes(k)));
  env.NO_PROXY = '127.0.0.1,localhost'; if (!installedConfig) env.CODEX_BRIDGE_TOKEN = session.token;
  const result = await new Promise(resolveRun => {
    const child = spawn(cli, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', timeout = false;
    const timer = setTimeout(() => { timeout = true; child.kill('SIGTERM'); }, 150000);
    child.stdout.on('data', chunk => { if (out.length < 2e6) out += chunk; else child.kill('SIGTERM'); });
    // Drain stderr privately: raw model/upstream errors never enter the receipt.
    child.stderr.resume();
    child.on('error', () => { clearTimeout(timer); resolveRun({ exitCode: null, spawnError: true }); });
    child.on('close', code => {
      clearTimeout(timer);
      const events = out.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      const items = events.filter(e => e.type === 'item.completed').map(e => e.item);
      const commands = items.filter(i => i?.type === 'command_execution');
      const answers = items.filter(i => i?.type === 'agent_message').map(i => i.text ?? '').join('');
      const failures = events.filter(e => ['error','turn.failed'].includes(e.type));
      const diagnostic = failures.map(e => String(e.message ?? e.error?.message ?? '')).join(' ');
      resolveRun({ exitCode: code, timeout, eventTypes: events.map(e => e.type).filter(x => /^[a-z_.]{1,80}$/.test(x)),
        toolExecutions: commands.length, toolsSucceeded: commands.some(i => i.exit_code === 0 && i.aggregated_output?.includes('CODEX_BRIDGE_TOOL_OK')),
        expectedText: answers.trim() === 'CODEX_BRIDGE_TOOL_OK',
        clientErrorCount: failures.length,
        errorCategory: diagnostic.includes('upstream_transport_error') ? 'upstream_transport_error' : failures.length ? 'client_or_upstream_error' : null,
        usage: events.find(e => e.type === 'turn.completed')?.usage ?? null });
    });
  });
  const row = { alias: model.slug, time: new Date().toISOString(), ...result };
  row.passed = row.exitCode === 0 && row.expectedText && row.toolsSucceeded;
  report.results.push(row); console.log(JSON.stringify(row));
}
report.completed = new Date().toISOString();
mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
const path = join(receiptDir, `codex-cli-${Date.now()}.json`);
writeFileSync(path, JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ report: path, passed: report.results.filter(r => r.passed).length, checks: report.results.length }));
if (report.results.some(r => !r.passed)) process.exitCode = 1;
