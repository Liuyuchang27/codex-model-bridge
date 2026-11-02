import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PROBE_INSTRUCTIONS = 'You are a coding assistant running a bounded connectivity test. Follow the user exact-output instructions. Use the shell tool only when explicitly asked to read probe.txt in the working directory. Never inspect other files, environment variables, credentials, or network resources. Do not delegate.';

// This deliberately generates a small test catalog. It does not certify the
// original model's full tool suite, native instructions, or long-context use.
export function buildProbeCatalog(config, catalogs) {
  const routes = Object.entries(config.routes ?? {});
  if (!routes.length) throw new Error('At least one explicit model route is required.');
  return { models: routes.map(([alias, route], i) => {
    const native = catalogs[route.provider]?.models?.find(m => m.slug === route.model);
    if (!native) throw new Error(`Missing native catalog model for route ${alias}.`);
    return { ...structuredClone(native), slug: alias, display_name: alias, priority: i + 1,
      visibility: 'list', upgrade: null, prefer_websockets: false, use_responses_lite: false,
      shell_type: 'shell_command', tool_mode: null, experimental_supported_tools: [],
      supports_search_tool: false, additional_speed_tiers: [], service_tiers: [], default_service_tier: null,
      available_access_programs: null, model_messages: null, base_instructions: PROBE_INSTRUCTIONS };
  }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const arg = flag => { const i = process.argv.indexOf(flag); return i < 0 ? undefined : process.argv[i + 1]; };
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const config = JSON.parse(readFileSync(arg('--config') ?? join(root,'config.example.json'), 'utf8'));
    const catalogs = { deepseek: JSON.parse(readFileSync(arg('--deepseek-catalog') ?? join(root,'vendor/cc-switch/codex_deepseek_catalog_template.json'), 'utf8')) };
    if (Object.values(config.routes).some(r => r.provider === 'openai')) {
      if (!arg('--openai-catalog')) throw new Error('Provide --openai-catalog with a current native Codex catalog or models_cache.json.');
      catalogs.openai = JSON.parse(readFileSync(arg('--openai-catalog'), 'utf8'));
    }
    if (!arg('--out-dir')) throw new Error('Provide --out-dir for generated probe-only files.');
    const version = arg('--client-version');
    if (version && catalogs.openai?.client_version && version.split('-')[0] !== catalogs.openai.client_version.split('-')[0]) throw new Error('OpenAI model catalog client version does not match the requested Codex version. Refresh it before testing.');
    const catalog = buildProbeCatalog(config, catalogs);
    const out = resolve(arg('--out-dir'));
    mkdirSync(out, { recursive: true, mode: 0o700 });
    const path = join(out, 'models.json');
    writeFileSync(path, JSON.stringify(catalog, null, 2), { mode: 0o600 });
    writeFileSync(join(out,'manifest.json'), JSON.stringify({ purpose: 'bounded-probe-only', clientVersion: version ?? null, openaiCatalogVersion: catalogs.openai?.client_version ?? null, aliases: catalog.models.map(m => m.slug), providerCredentialsIncluded: false }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ status: 'probe_catalog_prepared', catalog: path, aliases: catalog.models.map(m => m.slug), fullModelCapabilitiesVerified: false }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
