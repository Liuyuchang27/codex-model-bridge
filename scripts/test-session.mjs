import { execFile } from 'node:child_process';
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createInMemoryTestSession } from './session-core.mjs';
import { runLiveSuite } from './live-suite.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = flag => { const i = process.argv.indexOf(flag); return i < 0 ? undefined : process.argv[i + 1]; };
let dialog;
let server;
let directory;
let lifetime;
function cleanup() {
  if (dialog) { dialog.kill(); dialog = undefined; }
  if (lifetime) clearTimeout(lifetime);
  if (server) {
    const closing = server;
    server = undefined;
    closing.close();
    closing.closeAllConnections();
  }
  if (directory) {
    try { unlinkSync(join(directory, 'session.json')); } catch {}
    try { rmdirSync(directory); } catch {}
    directory = undefined;
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { cleanup(); process.exit(0); });
process.on('exit', cleanup);

try {
  if (process.platform !== 'darwin') throw new Error('The native credential window currently requires macOS.');
  const sessionRoot = arg('--session-dir');
  const receiptRoot = arg('--receipts-dir');
  if (!sessionRoot || !receiptRoot) throw new Error('Provide --session-dir and --receipts-dir.');
  const values = await new Promise((resolve, reject) => {
    dialog = execFile('/usr/bin/osascript', ['-l', 'JavaScript', join(root, 'scripts/key-window.jxa')], {
      encoding: 'utf8', maxBuffer: 32 * 1024,
    }, (error, stdout) => {
      dialog = undefined;
      if (error) return reject(new Error('Native credential window did not complete. No key was logged or saved.'));
      try { resolve(JSON.parse(stdout.trim())); } catch { reject(new Error('Could not read the credential window result.')); }
    });
  });
  if (values.canceled) {
    console.log(JSON.stringify({ status: 'canceled' }));
  } else {
    const config = JSON.parse(readFileSync(join(root, 'config.example.json'), 'utf8'));
    const session = createInMemoryTestSession(config, values);
    delete values.openai;
    delete values.deepseek;
    server = session.server;
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    mkdirSync(resolve(sessionRoot), { recursive: true, mode: 0o700 });
    directory = mkdtempSync(join(resolve(sessionRoot), 'session-'));
    writeFileSync(join(directory, 'session.json'), JSON.stringify({ baseUrl, token: session.token }), { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ status: 'keys_received', providers: session.providers, sessionDirectory: directory, apiKeysWrittenToDisk: false }));
    const report = await runLiveSuite({ baseUrl, token: session.token, aliases: session.aliases, onResult: result => console.log(JSON.stringify(result)) });
    mkdirSync(resolve(receiptRoot), { recursive: true, mode: 0o700 });
    const receipt = join(resolve(receiptRoot), `probe-${Date.now()}.json`);
    writeFileSync(receipt, JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ status: 'tests_completed', report: receipt, passed: report.results.filter(row => row.passed).length, checks: report.results.length, apiKeysWrittenToDisk: false }));
    // Keep the same in-memory credentials available for follow-up tests, bounded.
    lifetime = setTimeout(() => { cleanup(); process.exit(0); }, 30 * 60 * 1000);
  }
} catch (error) {
  cleanup();
  console.error(error.message);
  process.exitCode = 1;
}
