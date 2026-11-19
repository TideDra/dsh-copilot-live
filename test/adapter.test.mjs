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
test('prepared call clamps maxTokens above the online maximum instead of throwing', async () => {
  const adapter = makeAdapter();
  const captured = [];
  adapter.delegateFor = () => ({
    prepareCall: async () => ({
      model: { provider: 'github-copilot', id: 'gemini-4-carbon', name: 'Gemini 4 Carbon', inputModalities: ['text', 'image'], context: { contextWindow: 1000000 } },
      stream: async function* (opts) {
        captured.push(opts.maxTokens);
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    }),
  });
  const call = await adapter.prepareCall(LIVE_PROVIDER, 'gemini-4-carbon');
  const overInput = Object.freeze({ provider: LIVE_PROVIDER, model: 'gemini-4-carbon', messages: Object.freeze([]), maxTokens: 128000 });
  await Array.fromAsync(call.stream(overInput));
  assert.equal(overInput.maxTokens, 128000);
  await Array.fromAsync(call.stream({ provider: LIVE_PROVIDER, model: 'gemini-4-carbon', messages: [], maxTokens: 32000 }));
  await Array.fromAsync(call.stream({ provider: LIVE_PROVIDER, model: 'gemini-4-carbon', messages: [] }));
  assert.deepEqual(captured, [64000, 32000, undefined]);
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
  const model = { id: 'gemini-4-carbon', provider: 'github-copilot', api: 'openai-completions' };
  const context = { messages: [{ role: 'assistant', provider: 'github-copilot', api: 'openai-completions', model: 'gemini-4-carbon', content: [{ type: 'toolCall', id: 'old-1', thoughtSignature: 'original-opaque-signature', name: 'echo', arguments: {} }] }] };
  const { incoming, options } = geminiSignatureOptions(context, {}, model);
  await options.onProviderStreamEvent({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'new-1', function: { name: 'echo' } }] } }] });
  await options.onProviderStreamEvent({ choices: [{ delta: { tool_calls: [{ index: 0, extra_content: {google:{thought_signature:'new-opaque-signature'}} }] } }] });
  assert.equal(incoming.get('new-1'), 'new-opaque-signature');
  const payload = { messages: [{ role: 'assistant', tool_calls: [{ id: 'old-1', type: 'function', function: {name:'echo',arguments:'{}'}, extra_content:{other:'keep'} }] }] };
  const result = await options.onPayload(payload, model);
  assert.equal(result.messages[0].tool_calls[0].extra_content.google.thought_signature, 'original-opaque-signature');
  assert.equal(result.messages[0].tool_calls[0].extra_content.other, 'keep');
  assert.equal(payload.messages[0].tool_calls[0].extra_content.google, undefined);
  const message = { content: [{ type: 'toolCall', id: 'new-1', arguments: {} }] };
  assert.equal(attachGeminiSignatures(message, incoming).content[0].thoughtSignature, 'new-opaque-signature');
  assert.equal(message.content[0].thoughtSignature, undefined);
  const wrapped = wrapGeminiStream((async function* () { yield {type:'done',reason:'toolUse',message}; })(), incoming, model);
  const events = await Array.fromAsync(wrapped);
  assert.equal(events[0].message.content[0].thoughtSignature, 'new-opaque-signature');
  assert.equal((await wrapped.result()).content[0].thoughtSignature, 'new-opaque-signature');
});
test('gemini-4-hydrogen reasoning_opaque is captured, preserved across mid-turn steer/time injections, and stripped after turn completion', async () => {
  const hydrogen = { id: 'gemini-4-hydrogen', provider: 'github-copilot', api: 'openai-completions' };

  // 1) Stream capture: reasoning_opaque replaces literal "reasoning_text" on thinking block;
  //    when no thinking block exists (tool-call only or text only), attaches without changing block count.
  const capture1 = geminiSignatureOptions({ messages: [] }, {}, hydrogen);
  await capture1.options.onProviderStreamEvent({ choices: [{ delta: { reasoning_text: 'Let me think...', reasoning_opaque: 'first-opaque' } }] });
  await capture1.options.onProviderStreamEvent({ choices: [{ delta: { content: 'Answer', reasoning_opaque: 'final-opaque-blob' } }] });
  assert.equal(capture1.incoming.reasoningOpaque, 'final-opaque-blob');

  const withThinking = attachGeminiSignatures({
    content: [{ type: 'thinking', thinking: 'Let me think...', thinkingSignature: 'reasoning_text' }, { type: 'text', text: 'Answer' }],
  }, capture1.incoming);
  assert.equal(withThinking.content.length, 2);
  assert.equal(withThinking.content[0].thinkingSignature, 'copilot-reasoning-opaque:final-opaque-blob');

  const toolOnly = attachGeminiSignatures({
    content: [{ type: 'toolCall', id: 'call_1', name: 'ping', arguments: { x: 'hello' } }],
  }, capture1.incoming);
  assert.equal(toolOnly.content.length, 1);
  assert.equal(toolOnly.content[0].thoughtSignature, 'copilot-reasoning-opaque:final-opaque-blob');

  const textOnly = attachGeminiSignatures({
    content: [{ type: 'text', text: 'Direct reply' }],
  }, capture1.incoming);
  assert.equal(textOnly.content.length, 1);
  assert.equal(textOnly.content[0].textSignature, 'copilot-reasoning-opaque:final-opaque-blob');

  // 2) New-session multi-turn & mid-turn injection behavior:
  //    - Turn 1 completed (toolCall -> toolResult -> final text reply), followed by Turn 2 user message -> historical, stripped on Gemini!
  //    - Turn 2 active tool-call loop with a mid-turn user injection (e.g. DSH time-context or steer message) after toolResult -> still active task, MUST preserve reasoning_opaque + reasoning_text!
  const context = {
    messages: [
      { role: 'user', content: 'Turn 1' },
      {
        role: 'assistant', provider: 'github-copilot', api: 'openai-completions', model: 'gemini-4-hydrogen',
        content: [
          { type: 'thinking', thinking: 'Turn 1 step 1 thinking', thinkingSignature: 'copilot-reasoning-opaque:t1-step1-opaque' },
          { type: 'toolCall', id: 'call_t1', name: 'ping', arguments: { x: '1' } },
        ],
      },
      { role: 'toolResult', toolCallId: 'call_t1', toolName: 'ping', content: [{ type: 'text', text: 'pong1' }] },
      {
        role: 'assistant', provider: 'github-copilot', api: 'openai-completions', model: 'gemini-4-hydrogen',
        content: [
          { type: 'thinking', thinking: 'Turn 1 final thinking', thinkingSignature: 'copilot-reasoning-opaque:t1-final-opaque' },
          { type: 'text', text: 'Turn 1 done' },
        ],
      },
      { role: 'user', content: 'Turn 2 with tool and mid-turn time-context' },
      {
        role: 'assistant', provider: 'github-copilot', api: 'openai-completions', model: 'gemini-4-hydrogen',
        content: [
          { type: 'toolCall', id: 'call_ping', name: 'ping', arguments: { x: 'hello' }, thoughtSignature: 'copilot-reasoning-opaque:active-tool-opaque' },
        ],
      },
      { role: 'toolResult', toolCallId: 'call_ping', toolName: 'ping', content: [{ type: 'text', text: 'pong' }] },
      { role: 'user', content: 'Time sampled while preparing turn 2, step 2: 2026-11-16T21:50:00+08:00' },
    ],
  };
  const replay = geminiSignatureOptions(context, {}, hydrogen);
  const wirePayload = {
    messages: [
      { role: 'user', content: 'Turn 1' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_t1', type: 'function', function: { name: 'ping', arguments: '{"x":"1"}' } }] },
      { role: 'tool', tool_call_id: 'call_t1', content: 'pong1' },
      { role: 'assistant', content: 'Turn 1 done' },
      { role: 'user', content: 'Turn 2 with tool and mid-turn time-context' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_ping', type: 'function', function: { name: 'ping', arguments: '{"x":"hello"}' } }] },
      { role: 'tool', tool_call_id: 'call_ping', content: 'pong' },
      { role: 'user', content: 'Time sampled while preparing turn 2, step 2: 2026-11-16T21:50:00+08:00' },
    ],
  };
  const patched = await replay.options.onPayload(wirePayload, hydrogen);
  const assistants = patched.messages.filter(m => m.role === 'assistant');
  assert.equal(assistants.length, 3);
  // Gemini preserves signed historical thinking + reasoning_opaque across turns (matching native agy 1.5.9+)
  assert.equal(assistants[0].reasoning_opaque, 't1-step1-opaque');
  assert.equal(assistants[0].reasoning_text, 'Turn 1 step 1 thinking');
  assert.equal(assistants[1].reasoning_opaque, 't1-final-opaque');
  assert.equal(assistants[1].reasoning_text, 'Turn 1 final thinking');
  // Active Turn 2 tool-call step keeps reasoning_opaque + reasoning_text: "" even across mid-turn user injection
  assert.equal(assistants[2].reasoning_opaque, 'active-tool-opaque');
  assert.equal(assistants[2].reasoning_text, '');
  assert.equal(assistants[2].tool_calls[0].extra_content, undefined);

  // 3) If an interrupted/truncated response ever lacks reasoning_opaque, orphan reasoning_text is never emitted
  const truncatedContext = {
    messages: [
      { role: 'user', content: 'Truncated turn' },
      {
        role: 'assistant', provider: 'github-copilot', api: 'openai-completions', model: 'gemini-4-hydrogen',
        content: [
          { type: 'thinking', thinking: 'Partial summary', thinkingSignature: 'reasoning_text' },
          { type: 'toolCall', id: 'call_2', name: 'ping', arguments: { x: '2' } },
        ],
      },
      { role: 'toolResult', toolCallId: 'call_2', toolName: 'ping', content: [{ type: 'text', text: 'pong' }] },
    ],
  };
  const truncatedPatched = await geminiSignatureOptions(truncatedContext, {}, hydrogen).options.onPayload({
    messages: [
      { role: 'user', content: 'Truncated turn' },
      { role: 'assistant', content: null, reasoning_text: 'Partial summary', tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'ping', arguments: '{"x":"2"}' } }] },
      { role: 'tool', tool_call_id: 'call_2', content: 'pong' },
    ],
  }, hydrogen);
  assert.equal('reasoning_text' in truncatedPatched.messages[1], false);
  assert.equal('reasoning_opaque' in truncatedPatched.messages[1], false);

  // 4) Kimi K3+ preserves signed historical thinking across user turns
  const kimi = { id: 'kimi-k3', provider: 'github-copilot', api: 'openai-completions' };
  const kimiContext = {
    messages: [
      { role: 'user', content: 'Turn 1' },
      {
        role: 'assistant', provider: 'github-copilot', api: 'openai-completions', model: 'kimi-k3',
        content: [
          { type: 'thinking', thinking: 'Kimi reasoning', thinkingSignature: 'copilot-reasoning-opaque:kimi-opaque' },
          { type: 'text', text: 'Kimi reply' },
        ],
      },
      { role: 'user', content: 'Turn 2' },
    ],
  };
  const kimiReplay = geminiSignatureOptions(kimiContext, {}, kimi);
  const kimiPatched = await kimiReplay.options.onPayload({
    messages: [
      { role: 'user', content: 'Turn 1' },
      { role: 'assistant', content: 'Kimi reply' },
      { role: 'user', content: 'Turn 2' },
    ],
  }, kimi);
  assert.equal(kimiPatched.messages[1].reasoning_opaque, 'kimi-opaque');
  assert.equal(kimiPatched.messages[1].reasoning_text, 'Kimi reasoning');
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
