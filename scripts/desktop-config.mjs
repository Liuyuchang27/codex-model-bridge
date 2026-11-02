import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { withCodexRpc } from './codex-rpc.mjs';
import { validateCatalog } from './catalog-runtime.mjs';

export const PROVIDER_ID = 'codex-model-bridge';
const ROOT_KEYS = ['model','model_provider','model_catalog_json','model_context_window','model_auto_compact_token_limit','model_reasoning_effort','service_tier','web_search'];
const providerPath = 'model_providers.' + PROVIDER_ID;
const valueAt = (config,key) => key === providerPath ? config.model_providers?.[PROVIDER_ID] ?? null : config[key] ?? null;

export function buildDesktopCatalog(config, catalogs) {
  return { models: Object.entries(config.routes).map(([alias,route],i) => {
    const native = catalogs[route.provider]?.models?.find(m => m.slug === route.model);
    if (!native) throw new Error(`Native model metadata is missing for ${alias}.`);
    return { ...structuredClone(native), slug: alias,
      display_name: route.displayName ?? (native.display_name ?? route.model) + ' · API',
      description: `Local gateway · ${route.provider} API key · ${route.model}`,
      visibility: 'list', priority: i + 1, upgrade: null,
      prefer_websockets: false, use_responses_lite: false,
      additional_speed_tiers: [], service_tiers: [], default_service_tier: null,
      available_access_programs: null, supports_search_tool: false };
  }) };
}

export function buildUnifiedCatalog(apiCatalog, nativeCatalog, visibleModels) {
  const visible = new Set(visibleModels);
  const native = nativeCatalog.models.filter(m=>visible.has(m.slug)).map(m=>({
    ...structuredClone(m), prefer_websockets:false, use_responses_lite:false,
    display_name:m.display_name+' · 订阅',
  }));
  if (native.length !== visible.size || !native.length) throw new Error('Official model metadata is incomplete; keep the original configuration.');
  const models = [...native,...apiCatalog.models];
  if (new Set(models.map(m=>m.slug)).size !== models.length) throw new Error('Subscription and API model aliases must be distinct.');
  return {models};
}

export function unifiedProvider(baseUrl,localToken) {
  if (typeof localToken !== 'string' || localToken.length < 24) throw new Error('A local gateway token is required.');
  return {name:'OpenAI',base_url:baseUrl+'/v1',wire_api:'responses',requires_openai_auth:true,
    supports_websockets:false,request_max_retries:0,stream_max_retries:0,
    capabilities:{remote_compaction:'unsupported'},http_headers:{'x-codex-bridge-token':localToken}};
}

export function createDesktopInstaller({ cli, root, stateDir, baseUrl, connectionFile, catalogPath, config,
  unifiedCatalogPath, officialModels = [], localToken,
  validate = validateCatalog, runRpc = withCodexRpc }) {
  const manifestFile = join(stateDir,'desktop-install.json');
  const keys = [...ROOT_KEYS,providerPath];
  let busy = false;
  const snapshot = async rpc => {
    const read = await rpc('config/read',{includeLayers:true});
    const layer = read.layers.find(l => l.name.type === 'user' && !l.name.profile);
    if (!layer) throw new Error('Codex user configuration layer could not be resolved.');
    return layer;
  };
  const desired = (model,unified=false) => ({ model, model_provider: PROVIDER_ID, model_catalog_json: unified ? unifiedCatalogPath : catalogPath,
    model_context_window: null, model_auto_compact_token_limit: null, model_reasoning_effort: 'low', service_tier: null, web_search: 'disabled',
    [providerPath]: { name: 'Codex Model Bridge', base_url: baseUrl + '/v1', wire_api: 'responses',
      supports_websockets: false, request_max_retries: 0, stream_max_retries: 0,
      capabilities: { remote_compaction: 'unsupported' },
      auth: { command: process.execPath, args: [join(root,'scripts/local-token.mjs'),connectionFile], timeout_ms: 5000, refresh_interval_ms: 30000 } },
    ...(unified ? { [providerPath]:unifiedProvider(baseUrl,localToken), web_search:null } : {}) });
  const manifest = () => { try { return JSON.parse(readFileSync(manifestFile,'utf8')); } catch { return null; } };
  async function status() {
    return runRpc(cli,async rpc => {
      const layer = await snapshot(rpc);
      return { mode: layer.config.model_provider === PROVIDER_ID ? layer.config.model_providers?.[PROVIDER_ID]?.requires_openai_auth ? 'unified' : 'api' : 'subscription-or-original',
        model: layer.config.model ?? null, catalogEnabled: [catalogPath,unifiedCatalogPath].filter(Boolean).includes(layer.config.model_catalog_json),
        configPath: layer.name.file, installed: !!manifest(), restartRequired: true };
    });
  }
  async function activate(model = Object.keys(config.routes)[0],unified=false) {
    if (!Object.hasOwn(config.routes,model) && !(unified && officialModels.includes(model))) throw new Error('Choose a configured model alias.');
    if (unified && (!unifiedCatalogPath || !officialModels.length)) throw new Error('The unified catalog is not ready.');
    if (busy) throw new Error('Another configuration update is in progress.');
    busy = true;
    try {
      // Parse with the installed client before changing any active settings.
      const validation = await validate(cli,unified ? unifiedCatalogPath : catalogPath,[...Object.keys(config.routes),...(unified?officialModels:[])]);
      if (unified) await runRpc(cli,async rpc=>{
        const account=await rpc('account/read',{refreshToken:false});
        if(account.account?.type!=='chatgpt')throw new Error('Sign in to Codex with ChatGPT before enabling the combined menu.');
      },{overrides:['model_provider="openai"']});
      return await runRpc(cli,async rpc => {
        const layer = await snapshot(rpc);
        let saved = manifest();
        if (!saved) {
          if (layer.config.model_providers?.[PROVIDER_ID]) throw new Error('A provider with this ID already exists; refusing to overwrite it.');
          mkdirSync(join(stateDir,'backups'),{recursive:true,mode:0o700});
          const backup = join(stateDir,'backups',`config-${Date.now()}.toml`);
          writeFileSync(backup,existsSync(layer.name.file) ? readFileSync(layer.name.file) : '',{mode:0o600,flag:'wx'});
          saved = { configPath: layer.name.file, backup, original: Object.fromEntries(keys.map(k=>[k,valueAt(layer.config,k)])), created: new Date().toISOString() };
        }
        const applied = desired(model,unified);
        // The loopback guard grants access to locally saved API credentials.
        // Restrict the user config before writing this local capability into it.
        if (unified && existsSync(layer.name.file)) chmodSync(layer.name.file,0o600);
        // Native Codex performs atomic TOML edits; null resets/removes a value.
        const written = await rpc('config/batchWrite',{ filePath: layer.name.file, expectedVersion: layer.version,
          edits: keys.map(keyPath=>({keyPath,value:applied[keyPath],mergeStrategy:'replace'})), reloadUserConfig:false });
        if (written.status !== 'ok') throw new Error('A managed setting overrides the requested gateway configuration.');
        saved.applied = applied; saved.lastActivated = new Date().toISOString(); saved.catalogValidation = validation;
        writeFileSync(manifestFile,JSON.stringify(saved,null,2),{mode:0o600});
        return { mode: unified ? 'unified' : 'api', model, catalogEnabled:true, catalogValidation:validation,
          configPath: layer.name.file, backup: saved.backup, restartRequired:true };
      });
    } finally { busy = false; }
  }
  async function restore() {
    if (busy) throw new Error('Another configuration update is in progress.'); busy = true;
    try {
      const saved = manifest(); if (!saved) throw new Error('No saved original configuration is available.');
      return await runRpc(cli,async rpc => {
        const layer = await snapshot(rpc);
        for (const key of keys) {
          const actual = valueAt(layer.config,key);
          if (key === 'model' && (Object.hasOwn(config.routes,actual) || (layer.config.model_provider === PROVIDER_ID && officialModels.includes(actual)))) continue;
          if (!isDeepStrictEqual(actual,saved.applied?.[key]) && !isDeepStrictEqual(actual,saved.original[key])) throw new Error(`Setting ${key} changed outside this tool. Review it before restoring.`);
        }
        const written = await rpc('config/batchWrite',{filePath:layer.name.file,expectedVersion:layer.version,
          edits:keys.map(keyPath=>({keyPath,value:saved.original[keyPath],mergeStrategy:'replace'})),reloadUserConfig:false});
        if (written.status !== 'ok') throw new Error('A managed setting prevented restoration.');
        return {mode:'subscription-or-original',model:saved.original.model,restartRequired:true};
      });
    } finally { busy = false; }
  }
  return { activate,activateUnified:model=>activate(model ?? officialModels[0],true),restore,status,
    preview: model => desired(model ?? Object.keys(config.routes)[0]) };
}
