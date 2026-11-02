// Invoked privately by Codex's command-backed authentication. Its stdout is a
// credential pipe: do not run this helper directly in a visible terminal.
import { readFileSync, statSync } from 'node:fs';
try {
  const path = process.argv[2];
  if (!path || (statSync(path).mode & 0o077)) throw new Error();
  const state = JSON.parse(readFileSync(path,'utf8'));
  if (typeof state.token !== 'string' || state.token.length < 24) throw new Error();
  process.stdout.write(state.token);
} catch { process.stderr.write('Local model bridge authentication is unavailable. Start its background service.\n'); process.exitCode = 1; }
