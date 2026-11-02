import { randomBytes } from 'node:crypto';
import { createBridge } from './bridge.mjs';

// Credentials arrive explicitly from the native form, not process.env.
export function createInMemoryTestSession(rawConfig, keys, options = {}) {
  const config = structuredClone(rawConfig);
  config.port = 0;
  const token = randomBytes(32).toString('hex');
  const env = { [config.accessTokenEnv]: token };
  config.providers = Object.fromEntries(Object.entries(config.providers).filter(([id, provider]) => {
    if (typeof keys[id] !== 'string' || !keys[id].trim()) return false;
    env[provider.apiKeyEnv] = keys[id].trim();
    return true;
  }));
  config.routes = Object.fromEntries(Object.entries(config.routes).filter(([, route]) => Object.hasOwn(config.providers, route.provider)));
  if (!Object.keys(config.routes).length) throw new Error('Provide at least one configured provider key.');
  return {
    server: createBridge(config, { ...options, env }),
    token,
    aliases: Object.keys(config.routes),
    providers: Object.keys(config.providers),
  };
}
