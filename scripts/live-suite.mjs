// Returns only bounded diagnostics. Keys, prompts and raw upstream error bodies
// are intentionally excluded from receipts and logs.
export function outputText(payload) {
  return (payload?.output ?? []).flatMap(item => item.content ?? []).filter(part => part.type === 'output_text').map(part => part.text).join('');
}

export async function readSSE(response) {
  const decoder = new TextDecoder();
  let pending = '';
  let text = '';
  let final;
  let events = 0;
  const consume = block => {
    const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    const item = JSON.parse(data);
    events++;
    if (item.type === 'response.output_text.delta') text += item.delta ?? '';
    if (['response.completed', 'response.failed', 'response.incomplete'].includes(item.type)) final = item.response ?? { status: item.type.slice(9), error: item.error };
  };
  for await (const chunk of response.body) {
    pending += decoder.decode(chunk, { stream: true });
    pending = pending.replace(/\r\n/g, '\n');
    let index;
    while ((index = pending.indexOf('\n\n')) >= 0) {
      consume(pending.slice(0, index));
      pending = pending.slice(index + 2);
    }
    if (pending.length > 2 * 1024 * 1024) throw new Error('sse_event_too_large');
  }
  pending += decoder.decode();
  if (pending.trim()) consume(pending);
  return { text, final, events };
}

function usageOnly(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const result = {};
  for (const name of ['input_tokens', 'output_tokens', 'total_tokens']) if (Number.isFinite(usage[name])) result[name] = usage[name];
  if (Number.isFinite(usage.output_tokens_details?.reasoning_tokens)) result.reasoning_tokens = usage.output_tokens_details.reasoning_tokens;
  return result;
}

export async function runLiveSuite({ baseUrl, token, aliases, onResult = () => {} }) {
  const report = { began: new Date().toISOString(), results: [], creditSource: 'unverified-check-organization-billing' };
  const call = async (alias, body, streaming = false) => {
    try {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: 'POST', redirect: 'error',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: alias, store: false, max_output_tokens: 256, reasoning: { effort: 'low' }, ...body }),
        signal: AbortSignal.timeout(180000),
      });
      const meta = { httpStatus: response.status, requestId: response.headers.get('x-request-id') };
      if (streaming && response.ok && (response.headers.get('content-type') ?? '').includes('text/event-stream')) {
        const stream = await readSSE(response);
        return { ...meta, payload: stream.final, text: stream.text, events: stream.events };
      }
      let payload;
      try { payload = await response.json(); } catch { return { ...meta, transportError: 'non_json_response' }; }
      return { ...meta, payload, text: outputText(payload) };
    } catch {
      return { httpStatus: null, transportError: 'transport_or_timeout' };
    }
  };
  const record = (alias, test, response, passed, detail) => {
    const candidate = response.payload?.error?.code;
    const errorCode = typeof candidate === 'string' && /^[a-z_]{1,80}$/.test(candidate) ? candidate : null;
    const row = {
      alias, test, passed, detail, time: new Date().toISOString(),
      httpStatus: response.httpStatus, requestId: response.requestId ?? null,
      responseStatus: response.payload?.status ?? null, usage: usageOnly(response.payload?.usage),
      errorCode, transportError: response.transportError ?? null,
    };
    report.results.push(row);
    onResult(row);
  };
  for (const alias of aliases) {
    const plain = await call(alias, { input: 'Reply with exactly BRIDGE_OK.', stream: false });
    const plainOK = plain.httpStatus === 200 && plain.text?.trim() === 'BRIDGE_OK';
    record(alias, 'text', plain, plainOK, plainOK ? 'expected_text' : 'text_or_access_check_failed');
    if (!plainOK) continue;

    const stream = await call(alias, { input: 'Reply with exactly BRIDGE_OK.', stream: true }, true);
    const streamOK = stream.httpStatus === 200 && stream.events > 0 && stream.payload?.status === 'completed' && stream.text?.trim() === 'BRIDGE_OK';
    record(alias, 'stream', stream, Boolean(streamOK), streamOK ? 'sse_completed' : 'stream_check_failed');
    if (!streamOK) continue;

    const prompt = { role: 'user', content: 'Call report_probe once with ping equal to BRIDGE_OK. After its result, reply with exactly BRIDGE_OK.' };
    const tools = [{ type: 'function', name: 'report_probe', description: 'A harmless connectivity test returning its input.', parameters: { type: 'object', properties: { ping: { type: 'string' } }, required: ['ping'], additionalProperties: false }, strict: true }];
    const first = await call(alias, { input: [prompt], tools, tool_choice: 'auto', stream: false, max_output_tokens: 512 });
    const calls = (first.payload?.output ?? []).filter(item => item.type === 'function_call');
    let valid = first.httpStatus === 200 && calls.length === 1 && calls[0].name === 'report_probe' && typeof calls[0].call_id === 'string';
    try { valid = valid && JSON.parse(calls[0].arguments).ping === 'BRIDGE_OK'; } catch { valid = false; }
    record(alias, 'tool_call', first, valid, valid ? 'expected_function_and_arguments' : 'tool_request_failed');
    if (!valid) continue;
    // Preserve same-backend reasoning output and exact call_id; no decryption.
    const second = await call(alias, {
      input: [prompt, ...first.payload.output, { type: 'function_call_output', call_id: calls[0].call_id, output: '{"ping":"BRIDGE_OK"}' }],
      tools, tool_choice: 'none', stream: false,
    });
    const toolOK = second.httpStatus === 200 && second.text?.trim() === 'BRIDGE_OK';
    record(alias, 'tool_result_continuation', second, toolOK, toolOK ? 'call_id_roundtrip_completed' : 'tool_continuation_failed');
  }
  report.completed = new Date().toISOString();
  return report;
}
