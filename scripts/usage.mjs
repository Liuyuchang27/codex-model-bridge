import { Transform } from 'node:stream';
import { appendFileSync, readFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { publicNetworkError } from './network.mjs';

export function normalizeUsage(raw) {
  if (!raw || !Number.isSafeInteger(raw.input_tokens) || raw.input_tokens < 0 || !Number.isSafeInteger(raw.output_tokens) || raw.output_tokens < 0) return null;
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  return { input: raw.input_tokens, output: raw.output_tokens,
    total: count(raw.total_tokens) ?? raw.input_tokens + raw.output_tokens,
    cached: count(raw.input_tokens_details?.cached_tokens), cacheWrite: count(raw.input_tokens_details?.cache_write_tokens),
    reasoning: count(raw.output_tokens_details?.reasoning_tokens) };
}

// Observe usage without changing, delaying or persisting response text. Events
// without usage remain unknown rather than being counted as zero-token calls.
export class UsageTap extends Transform {
  constructor(contentType) {
    super(); this.sse = contentType.includes('text/event-stream'); this.decoder = new TextDecoder();
    this.pending = ''; this.tooLarge = false; this.usage = null; this.responseStatus = null;
  }
  inspect(raw) {
    try {
      const item = JSON.parse(raw);
      const payload = this.sse ? item.response ?? item : item;
      const usage = normalizeUsage(payload?.usage);
      if (usage) this.usage = usage;
      if (['completed','failed','incomplete'].includes(payload?.status)) this.responseStatus = payload.status;
    } catch {}
  }
  consume(final = false) {
    if (!this.sse) { if (final && !this.tooLarge) this.inspect(this.pending); return; }
    this.pending = this.pending.replace(/\r\n/g,'\n');
    let index;
    while ((index = this.pending.indexOf('\n\n')) >= 0) {
      const block = this.pending.slice(0,index); this.pending = this.pending.slice(index+2);
      if (this.tooLarge) { this.tooLarge = false; continue; }
      const raw = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (raw && raw !== '[DONE]') this.inspect(raw);
    }
    if (final && this.pending.trim() && !this.tooLarge) {
      const raw = this.pending.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (raw && raw !== '[DONE]') this.inspect(raw);
    }
  }
  _transform(chunk, _encoding, callback) {
    this.push(chunk);
    this.pending += this.decoder.decode(chunk, { stream: true });
    // Some native gateways stream SSE while declaring a generic content type.
    if (!this.sse && /^(data:|event:)/.test(this.pending.trimStart())) this.sse = true;
    this.consume();
    if (this.pending.length > (this.sse ? 2 : 16) * 1024 * 1024) { this.tooLarge = true; this.pending = this.pending.slice(-1); }
    callback();
  }
  _flush(callback) { this.pending += this.decoder.decode(); this.consume(true); callback(); }
}

export function createUsageLedger(file) {
  const rows = [];
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  try {
    for (const line of readFileSync(file,'utf8').split('\n')) {
      try { const row = JSON.parse(line); if (row.id && row.time && typeof row.alias === 'string') rows.push(row); } catch {}
    }
    chmodSync(file,0o600);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  function record(raw) {
    // Allowlist only. Never persist request bodies, headers, errors, or keys.
    const row = { id: randomUUID(), time: new Date().toISOString(), provider: raw.provider, alias: raw.alias,
      status: raw.status, outcome: raw.outcome, retries: raw.retries ?? 0, durationMs: raw.durationMs,
      usage: raw.usage ?? null, responseStatus: raw.responseStatus ?? null };
    const network = publicNetworkError(raw.network);
    if (network) row.network = network;
    appendFileSync(file, JSON.stringify(row)+'\n', { mode: 0o600 }); rows.push(row);
  }
  function summary() {
    const empty=()=>({ requests: 0, measured: 0, unknown: 0, failed: 0, incomplete: 0, input: 0, output: 0, total: 0, cached: 0, cacheWrite: 0, reasoning: 0 });
    const totals = empty();
    const providers = Object.create(null),models=Object.create(null);
    for (const row of rows) {
      const provider = providers[row.provider] ??= empty();
      const model = models[row.alias] ??= {...empty(),provider:row.provider,alias:row.alias,lastUsed:null};
      model.lastUsed=row.time;
      for(const group of [totals,provider,model]) {
        group.requests++;
        if(row.outcome==='incomplete')group.incomplete++;
        if(row.status>=400||!['completed','incomplete'].includes(row.outcome))group.failed++;
        if(row.usage){group.measured++;for(const key of ['input','output','total','cached','cacheWrite','reasoning'])group[key]+=row.usage[key]??0;}
        else group.unknown++;
      }
    }
    return { totals, providers, models, recent: rows.slice(-50).reverse(), began: rows[0]?.time ?? null, creditSource: 'unverified', scope: 'only-requests-observed-by-this-local-gateway' };
  }
  return { record, summary };
}
