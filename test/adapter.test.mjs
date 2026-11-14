import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import { CopilotLiveAdapter, nativeOptions, externalChunks, rebaseReplay } from '../adapter.js';
import { parseCatalog, LIVE_PROVIDER } from '../catalog.js';
import { geminiSignatureOptions, attachGeminiSignatures, wrapGeminiStream } from '../gemini-signatures.js';

const raw = JSON.parse(await readFile(new URL('./fixtures/live-catalog.json', import.meta.url), 'utf8'));
const config = { streamIdleTimeoutMs: 300000, apiVersion: '2026-06-01' };
const snapshot = { ...parseCatalog(raw, { baseURL: 'https://api.enterprise.githubcopilot.com' }), baseURL: 'https://api.enterprise.githubcopilot.com' };
const auth = { injection: {
  credentials: { read: async () => ({ type: 'api_key', key: 'test-only-not-a-real-token' }), list: async () => [], modify: async () => undefined, delete: async () => {} },
  authContext: { env: async () => undefined, fileExists: async () => false },
} };
function makeAdapter() { return new CopilotLiveAdapter({ config, auth, controller: { snapshot, refresh: async () => snapshot } }); }

test('native DSH registry lists and resolves a live model without static membership', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(LlmRuntime);
    ctx.llm.registerAdapter([LIVE_PROVIDER], makeAdapter());
    assert(ctx.llm.listProviders().some(provider => provider.id === LIVE_PROVIDER));
    assert((await ctx.llm.listModels(LIVE_PROVIDER)).some(model => model.id === 'gemini-4-carbon'));
    const model = await ctx.llm.resolveModelInfo(LIVE_PROVIDER, 'gemini-4-carbon');
    assert.equal(model.context.contextWindow, 1000000);
    assert.equal(model.defaultMaxTokens, 64000);
    assert.deepEqual(model.reasoning.efforts.map(e => e.id), ['low', 'medium', 'high']);
    assert.deepEqual(model.inputModalities, ['text', 'image']);
    const prepared = await ctx.llm.prepareCall({ provider: LIVE_PROVIDER, model: 'gemini-4-carbon', reasoningEffort: 'low' });
    assert.equal(prepared.config.maxTokens, 64000);
    assert.equal(prepared.config.reasoningEffort, 'low');
    await assert.rejects(() => ctx.llm.prepareCall({ provider: LIVE_PROVIDER, model: 'gemini-4-carbon', reasoningEffort: 'xhigh' }), { code: 'UNSUPPORTED_REASONING_EFFORT' });
  } finally { await ctx.fiber.dispose(); }
});
test('prepared call rejects an output budget above the online maximum', async () => {
  const call = await makeAdapter().prepareCall(LIVE_PROVIDER, 'gemini-4-carbon');
  assert.throws(() => call.stream({ provider: LIVE_PROVIDER, model: 'gemini-4-carbon', messages: [], maxTokens: 64001 }), { code: 'UNSUPPORTED_OPTION' });
});
test('unknown live IDs fail before inference', async () => {
  await assert.rejects(() => makeAdapter().resolveModel(LIVE_PROVIDER, 'model-not-returned-by-api'), { code: 'UNKNOWN_MODEL' });
});
test('per-model image limits and output caps use the live model snapshot', () => {
  const adapter = makeAdapter();
  const carbon = snapshot.details.find(m => m.id === 'gemini-4-carbon');
  const gpt = snapshot.details.find(m => m.id === 'gpt-5.3-codex');
  assert.equal(adapter.delegateFor(snapshot, carbon).config.profiles().get('github-copilot').maxRequestImages, 10);
  assert.equal(adapter.delegateFor(snapshot, gpt).config.profiles().get('github-copilot').maxRequestImages, 1);
  assert.equal(adapter.delegateFor(snapshot, carbon), adapter.delegateFor(snapshot, carbon));
});
test('native route rebasing preserves opaque replay and does not mutate logged input', async () => {
  const replay = { response: { kind: 'pi-ai', version: 2, provider: LIVE_PROVIDER, model: 'gemini-4-carbon' }, blocks: [{ type: 'tool-call', thoughtSignature: 'opaque-signature' }] };
  const message = { role: 'assistant', source: { kind: 'model', provider: LIVE_PROVIDER, model: 'gemini-4-carbon', replayState: replay }, content: [{ type: 'tool-call', id: 'tool-1', name: 'echo', arguments: '{}' }] };
  const input = { provider: LIVE_PROVIDER, model: 'gemini-4-carbon', messages: [message] };
  const frozen = JSON.stringify(input);
  const native = nativeOptions(input);
  assert.equal(native.provider, 'github-copilot');
  assert.equal(native.messages[0].source.replayState.response.provider, 'github-copilot');
  assert.equal(native.messages[0].source.replayState.blocks[0].thoughtSignature, 'opaque-signature');
  assert.equal(JSON.stringify(input), frozen);
  const chunks = await Array.fromAsync(externalChunks((async function* () { yield { type: 'finish', replayState: native.messages[0].source.replayState, reason: {kind:'tool-calls'} }; })()));
  assert.equal(chunks[0].replayState.response.provider, LIVE_PROVIDER);
  assert.equal(rebaseReplay({ response: { kind: 'foreign', provider: LIVE_PROVIDER } }, LIVE_PROVIDER, 'github-copilot').response.provider, LIVE_PROVIDER);
});
test('Google signatures survive streamed id/index split deltas and outgoing replay', async () => {
  const context = { messages: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'old-1', thoughtSignature: 'original-opaque-signature', name: 'echo', arguments: {} }] }] };
  const { incoming, options } = geminiSignatureOptions(context);
  await options.onProviderStreamEvent({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'new-1', function: { name: 'echo' } }] } }] });
  await options.onProviderStreamEvent({ choices: [{ delta: { tool_calls: [{ index: 0, extra_content: {google:{thought_signature:'new-opaque-signature'}} }] } }] });
  assert.equal(incoming.get('new-1'), 'new-opaque-signature');
  const payload = { messages: [{ role: 'assistant', tool_calls: [{ id: 'old-1', type: 'function', function: {name:'echo',arguments:'{}'}, extra_content:{other:'keep'} }] }] };
  const result = await options.onPayload(payload);
  assert.equal(result.messages[0].tool_calls[0].extra_content.google.thought_signature, 'original-opaque-signature');
  assert.equal(result.messages[0].tool_calls[0].extra_content.other, 'keep');
  assert.equal(payload.messages[0].tool_calls[0].extra_content.google, undefined);
  const message = { content: [{ type: 'toolCall', id: 'new-1', arguments: {} }] };
  assert.equal(attachGeminiSignatures(message, incoming).content[0].thoughtSignature, 'new-opaque-signature');
  assert.equal(message.content[0].thoughtSignature, undefined);
  const wrapped = wrapGeminiStream((async function* () { yield {type:'done',reason:'toolUse',message}; })(), incoming, {id:'gemini-4-carbon',provider:'github-copilot',api:'openai-completions'});
  const events = await Array.fromAsync(wrapped);
  assert.equal(events[0].message.content[0].thoughtSignature, 'new-opaque-signature');
  assert.equal((await wrapped.result()).content[0].thoughtSignature, 'new-opaque-signature');
});
test('caller provider hooks are preserved and existing signatures are not erased', async () => {
  let observed = 0;
  const { options } = geminiSignatureOptions({messages:[]}, {
    onPayload: async payload => ({...payload, marker: true}),
    onProviderStreamEvent: async () => { observed++; },
  });
  const payload = { messages: [{role:'assistant',tool_calls:[{id:'unchanged',extra_content:{google:{thought_signature:'native'}}}]}] };
  const result = await options.onPayload(payload);
  await options.onProviderStreamEvent({choices:[]});
  assert.equal(observed, 1);
  assert.equal(result.marker, true);
  assert.equal(result.messages[0].tool_calls[0].extra_content.google.thought_signature, 'native');
});
