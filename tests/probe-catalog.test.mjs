import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProbeCatalog } from '../scripts/probe-catalog.mjs';

test('probe catalog selects explicit native models and never copies account identity or unrelated models', () => {
  const native = { slug: 'native', context_window: 1234, model_messages: { instructions_template: 'large native prompt' }, tool_mode: 'code_mode_only' };
  const upstream = { identity: { private: 'not-model-data' }, models: [native, { slug: 'unrelated' }] };
  const result = buildProbeCatalog({ routes: { 'provider/native': { provider: 'p', model: 'native' } } }, { p: upstream });
  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].slug, 'provider/native');
  assert.equal(result.models[0].context_window, 1234);
  assert.equal(result.models[0].use_responses_lite, false);
  assert.equal(result.models[0].model_messages, null);
  assert.equal(result.identity, undefined);
  assert.equal(native.tool_mode, 'code_mode_only');
});

test('a missing provider or native model fails instead of borrowing another model metadata', () => {
  const config = { routes: { alias: { provider: 'missing', model: 'native' } } };
  assert.throws(() => buildProbeCatalog(config, { other: { models: [{ slug: 'native' }] } }), /Missing native/);
  assert.throws(() => buildProbeCatalog({ routes: {} }, {}), /At least one/);
});
