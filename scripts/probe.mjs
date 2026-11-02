import { readFileSync } from 'node:fs';

// Run one small request. A successful response proves connectivity, never grant
// eligibility. Credentials are read only from environment variables, not argv.
try {
  const args = process.argv.slice(2);
  const value = (flag, fallback) => {
    const index = args.indexOf(flag);
    if (index < 0) return fallback;
    if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${flag}`);
    return args[index + 1];
  };
  if (args.includes('--help')) {
    console.log('node scripts/probe.mjs --config config.json --model <configured-alias> [--direct]');
    console.log('Default: one request through the local bridge. --direct: one baseline API request.');
    process.exit(0);
  }
  const config = JSON.parse(readFileSync(value('--config', 'config.json'), 'utf8'));
  const alias = value('--model', 'openai-api/gpt-6.1-sol');
  const route = Object.hasOwn(config.routes, alias) ? config.routes[alias] : undefined;
  if (!route) throw new Error('Model alias is not in the chosen config.');
  const direct = args.includes('--direct');
  const provider = config.providers[route.provider];
  const endpoint = direct ? `${provider.baseUrl.replace(/\/+$/, '')}/responses` : `http://127.0.0.1:${config.port ?? 17631}/v1/responses`;
  const credentialEnv = direct ? provider.apiKeyEnv : config.accessTokenEnv;
  if (!process.env[credentialEnv]) throw new Error(`Set ${credentialEnv} locally; do not paste the key into chat.`);
  const began = new Date().toISOString();
  const response = await fetch(endpoint, {
    method: 'POST',
    redirect: 'error',
    headers: {
      authorization: `Bearer ${process.env[credentialEnv]}`,
      'content-type': 'application/json',
      'user-agent': 'codex-model-bridge-probe/0.1 (Codex local gateway)',
    },
    body: JSON.stringify({
      model: direct ? route.model : alias,
      input: 'Reply with exactly BRIDGE_OK.',
      max_output_tokens: 256,
      reasoning: { effort: 'low' },
      store: false,
      stream: false,
    }),
    signal: AbortSignal.timeout(180000),
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error(`Non-JSON response (HTTP ${response.status}).`); }
  const output = (payload.output ?? []).flatMap(item => item.content ?? []).filter(part => part.type === 'output_text').map(part => part.text).join('');
  console.log(JSON.stringify({
    began, completed: new Date().toISOString(), mode: direct ? 'direct' : 'bridge',
    provider: route.provider, alias, model: route.model,
    status: response.status, requestId: response.headers.get('x-request-id'),
    responseStatus: payload.status ?? null, expectedTextReceived: output.trim() === 'BRIDGE_OK',
    usage: payload.usage ?? null, errorCode: payload.error?.code ?? null,
    creditSource: 'unverified-check-organization-billing',
  }, null, 2));
  if (!response.ok || output.trim() !== 'BRIDGE_OK') process.exitCode = 1;
} catch (error) {
  console.error(error.name === 'AbortError' || error.name === 'TimeoutError' ? 'Probe timed out.' : error.message);
  process.exitCode = 1;
}
