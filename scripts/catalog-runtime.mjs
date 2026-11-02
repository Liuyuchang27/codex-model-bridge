import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { withCodexRpc } from './codex-rpc.mjs';

const exec = promisify(execFile);
export async function clientVersion(cli) {
  const { stdout } = await exec(cli,['--version'],{timeout:10000,maxBuffer:8192});
  const version = stdout.match(/codex-cli (\d+\.\d+\.\d+(?:-[\w.-]+)?)/)?.[1];
  if (!version) throw new Error('Could not determine the installed Codex version.');
  return version;
}

export function matchingCache(cache,version) {
  return !!cache?.client_version && cache.client_version.split('-')[0] === version.split('-')[0]
    && Array.isArray(cache.models) && cache.models.length > 0;
}

export async function loadClientCatalog(cli,cachePath,{explicit=false}={}) {
  const version = await clientVersion(cli);
  let cache; try { cache = JSON.parse(readFileSync(cachePath,'utf8')); } catch {}
  if (matchingCache(cache,version)) return {catalog:cache,version,source:'matching-local-cache'};
  if (explicit) throw new Error('The supplied catalog must declare a client_version matching the installed Codex.');
  // A version-mismatched cache is never the default. The binary supplies its own
  // schema-compatible release snapshot; this does not certify account access.
  let stdout;
  try { ({stdout} = await exec(cli,['debug','models','--bundled'],{timeout:20000,maxBuffer:16*1024*1024})); }
  catch { throw new Error('Refresh the Codex model cache or supply a version-matched catalog; this client cannot export bundled defaults.'); }
  const catalog = JSON.parse(stdout);
  if (!Array.isArray(catalog.models) || !catalog.models.length) throw new Error('The installed Codex returned no bundled models.');
  return {catalog,version,source:'installed-client-bundled-snapshot'};
}

export async function validateCatalog(cli,path,aliases,{runRpc=withCodexRpc}={}) {
  const version = await clientVersion(cli);
  const data = readFileSync(path);
  try {
    await runRpc(cli,async rpc => {
      const result = await rpc('model/list',{includeHidden:true});
      const found = new Set(result.data.map(m=>m.model));
      if (!aliases.every(alias=>found.has(alias))) throw new Error('The installed Codex did not expose every configured model alias.');
    },{overrides:[`model_catalog_json=${JSON.stringify(path)}`,'model_provider="openai"']});
  } catch(error) {
    const field = error.rpcMessage?.match(/missing field `([a-zA-Z_][\w]*)`/)?.[1];
    throw new Error('Model catalog rejected by Codex '+version+(field?`: missing field ${field}.`:'. Refresh the model metadata before enabling the bridge.'));
  }
  return {clientVersion:version,sha256:createHash('sha256').update(data).digest('hex'),aliases:[...aliases],validatedAt:new Date().toISOString()};
}

export async function publishCatalog(cli,path,catalog,{validate=validateCatalog}={}) {
  const candidate=path+'.candidate-'+randomBytes(6).toString('hex');
  try {
    writeFileSync(candidate,JSON.stringify(catalog,null,2),{mode:0o600,flag:'wx'});
    const receipt=await validate(cli,candidate,catalog.models.map(m=>m.slug));
    renameSync(candidate,path);
    return receipt;
  } finally { rmSync(candidate,{force:true}); }
}
