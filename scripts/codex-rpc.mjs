import { spawn } from 'node:child_process';

export async function withCodexRpc(cli, callback, { overrides = [], onNotification = () => {} } = {}) {
  const args = ['app-server', '--stdio', '-c', 'features.plugins=false', '-c', 'features.apps=false', '-c', 'mcp_servers={}', '-c', 'hooks={}', ...overrides.flatMap(value => ['-c', value])];
  const child = spawn(cli, args, { stdio: ['pipe','pipe','pipe'] });
  child.stderr.resume();
  const pending = new Map(); let id = 0, buffer = '';
  const fail = () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Codex configuration service closed.')); } pending.clear(); };
  child.on('error', fail); child.on('close', fail);
  const send = msg => child.stdin.write(JSON.stringify(msg) + '\n');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 8 * 1024 * 1024) { child.kill(); fail(); return; }
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0,index); buffer = buffer.slice(index+1);
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && !msg.method) {
        const p = pending.get(msg.id);
        if (p) { clearTimeout(p.timer); pending.delete(msg.id); msg.error ? p.reject(Object.assign(new Error('Codex RPC rejected the configuration request.'), { rpcCode: msg.error.code, rpcMessage: msg.error.message })) : p.resolve(msg.result); }
      } else if (msg.id != null && msg.method) send({ id: msg.id, error: { code: -32601, message: 'Interactive actions are not available in the local configuration helper.' } });
      else if (msg.method) onNotification(msg);
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Codex configuration request timed out.')); }, 20000);
    pending.set(requestId,{ resolve,reject,timer }); send({ id: requestId, method, params });
  });
  try {
    await rpc('initialize', { clientInfo: { name: 'codex_model_bridge_setup', title: 'Codex Model Bridge Setup', version: '0.2.0' }, capabilities: { experimentalApi: true } });
    send({ method: 'initialized', params: {} });
    return await callback(rpc);
  } finally { for (const p of pending.values()) clearTimeout(p.timer); child.kill('SIGTERM'); }
}
