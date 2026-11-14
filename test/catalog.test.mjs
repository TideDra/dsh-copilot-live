import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import {
  advertisedInfo,
  COPILOT_HEADERS,
  LIVE_PROVIDER,
  parseCatalog,
  THINKING_LEVELS,
  trustedCopilotBaseURL,
} from '../catalog.js';

// Offline, account-scoped API snapshot. No auth module, environment credentials,
// runtime loader, third-party packages, or network access are needed by this suite.
const liveCatalog = JSON.parse(await readFile(
  new URL('./fixtures/live-catalog.json', import.meta.url), 'utf8',
));
const DEFAULT_BASE = 'https://api.individual.githubcopilot.com';
const CARBON_ID = 'gemini-4-carbon';
const carbonEntry = liveCatalog.data.find(item => item.id === CARBON_ID);

function entry(id = 'unit-model', overrides = {}) {
  return {
    id,
    name: id,
    model_picker_enabled: true,
    capabilities: { type: 'chat', supports: { tool_calls: true } },
    supported_endpoints: ['/chat/completions'],
    ...overrides,
  };
}

function knownModel(id = 'unit-model', overrides = {}) {
  return {
    id,
    name: `Installed ${id}`,
    api: 'openai-completions',
    provider: 'github-copilot',
    baseUrl: DEFAULT_BASE,
    input: ['text'],
    contextWindow: 128000,
    maxTokens: 8192,
    reasoning: false,
    compat: {},
    headers: {},
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  };
}

function parseOne(item, options = {}) {
  const result = parseCatalog({ data: [item] }, options);
  assert.equal(result.models.length, 1, JSON.stringify(result.excluded));
  assert.equal(result.details.length, 1);
  return { ...result, model: result.models[0], detail: result.details[0] };
}

function nullThinkingMap() {
  return Object.fromEntries(THINKING_LEVELS.map(level => [level, null]));
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

deepFreeze(liveCatalog);

describe('live API discovery and Gemini 4 Carbon', () => {
  it('discovers Carbon without a static or installed model entry', () => {
    assert.ok(carbonEntry, 'the official directory fixture must contain Carbon');
    const result = parseCatalog(liveCatalog);
    const model = result.models.find(item => item.id === CARBON_ID);
    const detail = result.details.find(item => item.id === CARBON_ID);
    assert.ok(model, 'Carbon must be discovered from the API data[]');
    assert.ok(detail);
    assert.equal(result.rawCount, liveCatalog.data.length);
    assert.equal(model.name, 'Gemini 4 Carbon');
    assert.equal(model.provider, 'github-copilot');
    assert.equal(model.baseUrl, DEFAULT_BASE);
    assert.equal(model.api, 'openai-completions');
    assert.equal(model.contextWindow, 1000000);
    assert.equal(model.maxTokens, 64000);
    assert.equal(detail.maxPromptTokens, 936000);
    assert.deepEqual(detail.limitsSource, { context: 'live-api', output: 'live-api' });
    assert.deepEqual(detail.warnings, []);
    assert.deepEqual(model.input, ['text', 'image']);
    assert.equal(detail.toolCalls, true);
    assert.equal(detail.parallelToolCalls, true);
    assert.deepEqual(detail.vision, {
      maxPromptImages: 10,
      maxImageBytes: 3145728,
      supportedMediaTypes: [
        'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf',
      ],
    });
    assert.equal(detail.policy, 'unspecified');
  });

  it('does not inject Carbon, or any known model, when the API does not return it', () => {
    const knownModels = new Map([
      [CARBON_ID, knownModel(CARBON_ID)],
      ['installed-only-model', knownModel('installed-only-model')],
    ]);
    assert.deepEqual(parseCatalog({ data: [] }, { knownModels }), {
      models: [], details: [], excluded: [], priceModels: [], rawCount: 0,
    });
    const withoutCarbon = {
      data: liveCatalog.data.filter(item => item.id !== CARBON_ID),
    };
    const result = parseCatalog(withoutCarbon, { knownModels });
    assert.equal(result.models.some(item => item.id === CARBON_ID), false);
    assert.equal(result.models.some(item => item.id === 'installed-only-model'), false);
    const returnedIds = new Set(withoutCarbon.data.map(item => item.id));
    for (const model of result.models) assert.ok(returnedIds.has(model.id));
  });

  it('discovers an unfamiliar returned ID rather than relying on a Gemini allowlist', () => {
    const id = 'unlisted-api-model-for-unit-test';
    const { model, detail } = parseOne({
      ...carbonEntry, id, name: 'API supplied model name',
    });
    assert.equal(model.id, id);
    assert.equal(model.name, 'API supplied model name');
    assert.equal(model.contextWindow, 1000000);
    assert.equal(model.maxTokens, 64000);
    assert.equal(detail.maxPromptTokens, 936000);
  });

  it('takes all three Carbon limits from the live response, not an installed match', () => {
    const knownModels = new Map([[CARBON_ID, knownModel(CARBON_ID, {
      contextWindow: 32768, maxTokens: 4096,
    })]]);
    const { model, detail } = parseOne(carbonEntry, { knownModels });
    assert.equal(model.contextWindow, 1000000);
    assert.equal(model.maxTokens, 64000);
    assert.equal(detail.maxPromptTokens, 936000);
    assert.deepEqual(detail.limitsSource, { context: 'live-api', output: 'live-api' });
  });

  it('exposes exactly the advertised low, medium, high wire parameters', () => {
    const { model, detail } = parseOne(carbonEntry);
    assert.equal(model.reasoning, true);
    assert.deepEqual(detail.reasoning, {
      mode: 'selectable', efforts: ['low', 'medium', 'high'],
    });
    assert.deepEqual(model.thinkingLevelMap, {
      ...nullThinkingMap(), low: 'low', medium: 'medium', high: 'high',
    });
    assert.equal(model.compat.supportsReasoningEffort, true);
    assert.equal(model.compat.supportsStore, false);
    assert.equal(model.compat.supportsDeveloperRole, false);
    assert.equal(model.compat.maxTokensField, 'max_tokens');
    assert.equal(model.api === 'google-generative-ai', false);
  });

  it('preserves mixed protocols and filters hidden/non-chat entries in the fixture', () => {
    const result = parseCatalog(liveCatalog);
    const models = new Map(result.models.map(model => [model.id, model]));
    const exclusions = new Map(result.excluded.map(item => [item.id, item.reason]));
    assert.equal(models.get('gemini-4-carbon')?.api, 'openai-completions');
    assert.equal(models.get('gpt-5.3-codex')?.api, 'openai-responses');
    assert.equal(models.get('mai-code-2-flash')?.api, 'openai-responses');
    assert.equal(exclusions.get('gpt-5.4-nano'), 'not-in-model-picker');
    assert.equal(exclusions.get('gpt-4.1'), 'not-in-model-picker');
    assert.equal(exclusions.get('gpt-6-luna-decisions'), 'not-chat');
    assert.equal(exclusions.get('gpt-image-2.5-flare'), 'not-chat');
    assert.equal(exclusions.get('text-embedding-3-small'), 'not-chat');
    assert.equal(models.size, result.models.length);
    for (const model of result.models) {
      assert.equal(model.type, 'chat');
      assert.deepEqual(model.headers, COPILOT_HEADERS);
    }
  });
});

describe('endpoint and protocol selection', () => {
  const cases = [
    ['ordinary-chat', ['/chat/completions'], 'openai-completions'],
    ['versioned-chat', ['/v1/chat/completions/'], 'openai-completions'],
    ['ordinary-responses', ['/responses'], 'openai-responses'],
    ['versioned-responses', ['/v1/responses/'], 'openai-responses'],
    ['ordinary-messages', ['/messages'], 'anthropic-messages'],
    ['versioned-messages', ['/v1/messages/'], 'anthropic-messages'],
    ['claude-future', ['/responses', '/chat/completions', '/v1/messages'], 'anthropic-messages'],
    ['gemini-future', ['/responses', '/chat/completions', '/v1/messages'], 'openai-completions'],
    ['new-family', ['/chat/completions', '/responses', '/v1/messages'], 'openai-responses'],
    ['mixed-rest-ws', ['ws:/responses', '/responses'], 'openai-responses'],
  ];
  for (const [family, endpoints, expected] of cases) {
    it(`selects ${expected} for ${family}`, () => {
      const { model, detail } = parseOne(entry(family, {
        capabilities: { family, type: 'chat', supports: { tool_calls: true } },
        supported_endpoints: endpoints,
      }));
      assert.equal(model.api, expected);
      assert.deepEqual(detail.supportedEndpoints, endpoints.map(value => value.replace(/\/+$/, '')));
    });
  }

  it('also recognizes endpoints nested in capabilities', () => {
    const { model } = parseOne(entry('nested-endpoint', {
      supported_endpoints: undefined,
      capabilities: {
        type: 'chat', supports: { tool_calls: true },
        supported_endpoints: ['/v1/messages'],
      },
    }));
    assert.equal(model.api, 'anthropic-messages');
  });

  it('prefers top-level endpoint declarations over nested declarations', () => {
    const { model } = parseOne(entry('top-level-endpoint', {
      supported_endpoints: ['/responses'],
      capabilities: { supported_endpoints: ['/v1/messages'] },
    }));
    assert.equal(model.api, 'openai-responses');
  });

  it('retains compatible quirks from an exact installed model', () => {
    const known = knownModel('known-protocol', {
      compat: { maxTokensField: 'max_completion_tokens', supportsReasoningEffort: true },
      headers: { 'X-Unit-Test': 'installed-quirk' },
    });
    const { model } = parseOne(entry(known.id, {
      supported_endpoints: ['/responses', '/chat/completions'],
    }), { knownModels: new Map([[known.id, known]]) });
    assert.equal(model.api, 'openai-completions');
    assert.equal(model.compat.maxTokensField, 'max_completion_tokens');
    assert.equal(model.headers['X-Unit-Test'], 'installed-quirk');
  });

  it('does not let a stale installed protocol override an advertised endpoint', () => {
    const known = knownModel('changed-protocol', {
      compat: { maxTokensField: 'max_completion_tokens', staleQuirk: true },
    });
    const { model } = parseOne(entry(known.id, {
      supported_endpoints: ['/v1/messages'],
    }), { knownModels: new Map([[known.id, known]]) });
    assert.equal(model.api, 'anthropic-messages');
    assert.deepEqual(model.compat, {});
  });

  it('uses the historical Chat Completions fallback only when endpoints are absent', () => {
    const { model } = parseOne(entry('gemini-new-without-endpoints', {
      supported_endpoints: undefined,
    }));
    assert.equal(model.api, 'openai-completions');
    const result = parseCatalog({ data: [entry('unsupported', {
      supported_endpoints: ['/v1/decisions', '/v1/images/generations'],
    })] });
    assert.deepEqual(result.models, []);
    assert.equal(result.excluded[0].reason, 'unsupported-endpoint');
  });

  it('rejects a WebSocket-only declaration instead of inventing a REST endpoint', () => {
    const result = parseCatalog({ data: [entry('websocket-only', {
      supported_endpoints: ['ws:/responses'],
    })] });
    assert.deepEqual(result.models, [], 'ws:/responses alone does not advertise HTTP /responses');
    assert.equal(result.excluded[0]?.reason, 'unsupported-endpoint');
  });
});

describe('policy, capabilities, and model picker filters', () => {
  const filteredDirectory = {
    data: [
      entry('visible'),
      entry('disabled', { policy: { state: 'disabled' } }),
      entry('non-chat', { capabilities: { type: 'embeddings' } }),
      entry('no-tools', { capabilities: { type: 'chat', supports: { tool_calls: false } } }),
      entry('hidden', { model_picker_enabled: false }),
      entry('bad-endpoint', { supported_endpoints: ['/unrecognized'] }),
    ],
  };

  it('excludes disabled, non-chat, tool-incompatible, hidden, and unsupported models', () => {
    const result = parseCatalog(filteredDirectory);
    assert.deepEqual(result.models.map(model => model.id), ['visible']);
    assert.deepEqual(result.excluded.map(({ id, reason }) => [id, reason]), [
      ['disabled', 'policy-disabled'],
      ['non-chat', 'not-chat'],
      ['no-tools', 'no-tool-calls'],
      ['hidden', 'not-in-model-picker'],
      ['bad-endpoint', 'unsupported-endpoint'],
    ]);
    assert.equal(result.rawCount, 6);
  });

  it('includeHiddenModels relaxes only the picker filter', () => {
    const result = parseCatalog(filteredDirectory, { includeHiddenModels: true });
    assert.deepEqual(result.models.map(model => model.id), ['visible', 'hidden']);
    assert.deepEqual(result.excluded.map(item => item.id), [
      'disabled', 'non-chat', 'no-tools', 'bad-endpoint',
    ]);
  });

  for (const type of ['embeddings', 'completion', 'image', 'decisions']) {
    it(`does not expose capability type ${type} as chat`, () => {
      const result = parseCatalog({ data: [entry(`not-chat-${type}`, {
        capabilities: { type, supports: { tool_calls: true } },
      })] }, { includeHiddenModels: true });
      assert.deepEqual(result.models, []);
      assert.equal(result.excluded[0].reason, 'not-chat');
    });
  }

  it('does not expose explicitly non-streaming models, even with hidden models enabled', () => {
    const result = parseCatalog({ data: [entry('no-streaming', {
      capabilities: { type: 'chat', supports: { tool_calls: true, streaming: false } },
    })] }, { includeHiddenModels: true });
    assert.deepEqual(result.models, []);
    assert.equal(result.excluded[0]?.reason, 'no-streaming');
  });

  it('keeps unspecified policy and marks unconfigured policy without pretending it is disabled', () => {
    const { detail } = parseOne(entry('requires-terms', { policy: { state: 'unconfigured' } }));
    assert.equal(detail.policy, 'unconfigured');
    assert.ok(detail.warnings.includes('policy-acceptance-may-be-required'));
    const advertised = advertisedInfo(detail);
    assert.equal(advertised.provider, LIVE_PROVIDER);
    assert.equal(advertised.badge.tone, 'warning');
    assert.match(advertised.description, /GitHub/);
    assert.equal(parseOne(entry('no-policy')).detail.policy, 'unspecified');
  });

  it('applies the legacy policy-enabled fallback only to an individual account without picker support', () => {
    const legacy = { data: [
      entry('legacy-enabled', { model_picker_enabled: false, policy: { state: 'enabled' } }),
      entry('legacy-unknown', { model_picker_enabled: false }),
      entry('legacy-disabled', { model_picker_enabled: false, policy: { state: 'disabled' } }),
    ] };
    assert.deepEqual(parseCatalog(legacy).models.map(model => model.id), ['legacy-enabled']);
    assert.deepEqual(parseCatalog(legacy, {
      baseURL: 'https://api.business.githubcopilot.com',
    }).models, []);
    const modern = parseCatalog({ data: [...legacy.data, entry('picker-supported')] });
    assert.deepEqual(modern.models.map(model => model.id), ['picker-supported']);
  });

  it('does not let installed metadata resurrect a disabled or hidden model', () => {
    const knownModels = new Map(filteredDirectory.data.map(item => [item.id, knownModel(item.id)]));
    assert.deepEqual(parseCatalog(filteredDirectory, { knownModels }).models.map(model => model.id), ['visible']);
  });
});

describe('deduplication and abnormal directories', () => {
  it('deduplicates trimmed IDs and keeps first-occurrence metadata', () => {
    const result = parseCatalog({ data: [
      entry(' same-id ', { name: 'First API entry' }),
      entry('same-id', { name: 'Duplicate API entry' }),
      entry('distinct-id'),
    ] });
    assert.deepEqual(result.models.map(model => [model.id, model.name]), [
      ['same-id', 'First API entry'], ['distinct-id', 'distinct-id'],
    ]);
    assert.deepEqual(result.details.map(detail => detail.id), ['same-id', 'distinct-id']);
    assert.equal(result.rawCount, 3);
  });

  it('does not let a later duplicate re-enable an already policy-disabled ID', () => {
    const result = parseCatalog({ data: [
      entry('disabled-duplicate', { policy: { state: 'disabled' } }),
      entry('disabled-duplicate'),
    ] });
    assert.deepEqual(result.models, []);
    assert.deepEqual(result.excluded.map(({ id, reason }) => [id, reason]), [
      ['disabled-duplicate', 'policy-disabled'],
    ]);
  });

  it('ignores primitives, arrays, absent IDs, and blank or non-string IDs', () => {
    const badItems = [null, undefined, false, 5, 'model', [], {}, { id: '' }, { id: '  ' }, { id: 7 }];
    const result = parseCatalog({ data: [...badItems, entry('valid')] });
    assert.deepEqual(result.models.map(model => model.id), ['valid']);
    assert.equal(result.rawCount, badItems.length + 1);
  });

  for (const raw of [undefined, null, false, 42, 'not-a-directory', [], {}, { data: null }, { data: {} }, { data: '[]' }]) {
    it(`rejects a missing/non-array data envelope: ${JSON.stringify(raw)}`, () => {
      assert.throws(() => parseCatalog(raw), /Invalid Copilot model directory: expected data\[\]/);
    });
  }

  it('handles malformed nested capability records without throwing or gaining features', () => {
    const values = [undefined, null, [], 'bad-record', 42, false];
    const items = values.flatMap((value, index) => [
      entry(`bad-capabilities-${index}`, { capabilities: value }),
      entry(`bad-supports-${index}`, { capabilities: { supports: value, limits: value } }),
    ]);
    const result = parseCatalog({ data: items });
    assert.equal(result.models.length, items.length);
    for (const model of result.models) {
      assert.equal(model.contextWindow, 128000);
      assert.equal(model.maxTokens, 8192);
      assert.deepEqual(model.input, ['text']);
      assert.equal(model.reasoning, false);
      assert.deepEqual(model.thinkingLevelMap, nullThinkingMap());
      assert.equal(model.compat.supportsReasoningEffort, false);
    }
  });

  it('does not mutate the frozen fixture or caller-supplied installed metadata', () => {
    const known = deepFreeze(knownModel(CARBON_ID, {
      input: ['text', 'image'],
      compat: { maxTokensField: 'max_completion_tokens' },
      headers: { 'X-Unit-Test': 'unchanged' },
    }));
    const before = JSON.stringify(known);
    parseCatalog(liveCatalog, { knownModels: new Map([[CARBON_ID, known]]) });
    assert.equal(JSON.stringify(known), before);
    assert.equal(carbonEntry.capabilities.limits.max_context_window_tokens, 1000000);
  });
});

describe('conservative limits, modalities, and installed exact-match fallbacks', () => {
  it('uses conservative defaults for an unknown model with missing capabilities', () => {
    const { model, detail } = parseOne(entry('gemini-unlisted', { capabilities: undefined }));
    assert.equal(model.contextWindow, 128000);
    assert.equal(model.maxTokens, 8192);
    assert.deepEqual(model.input, ['text']);
    assert.equal(model.reasoning, false);
    assert.deepEqual(detail.reasoning, { mode: 'none', efforts: [] });
    assert.deepEqual(detail.limitsSource, { context: 'fallback', output: 'fallback' });
    assert.deepEqual(detail.warnings, [
      'context-uses-conservative-fallback', 'output-uses-conservative-fallback',
    ]);
    assert.equal(detail.maxPromptTokens, null);
    assert.equal(detail.parallelToolCalls, false);
  });

  it('does not infer capacity, vision, or reasoning enums from a nearby known Gemini family', () => {
    const known = knownModel(CARBON_ID, {
      contextWindow: 1000000, maxTokens: 64000, input: ['text', 'image'], reasoning: true,
      compat: { supportsReasoningEffort: true },
    });
    const { model } = parseOne(entry('gemini-4-carbon-new-revision', {
      capabilities: { family: CARBON_ID },
    }), { knownModels: new Map([[CARBON_ID, known]]) });
    assert.equal(model.contextWindow, 128000);
    assert.equal(model.maxTokens, 8192);
    assert.deepEqual(model.input, ['text']);
    assert.equal(model.reasoning, false);
    assert.deepEqual(model.thinkingLevelMap, nullThinkingMap());
  });

  it('uses installed capacities only for an exact API-returned ID', () => {
    const known = knownModel('exact-known', { contextWindow: 200000, maxTokens: 16384, input: ['text', 'image'] });
    const { model, detail } = parseOne(entry(known.id, { capabilities: undefined }), {
      knownModels: new Map([[known.id, known]]),
    });
    assert.equal(model.contextWindow, 200000);
    assert.equal(model.maxTokens, 16384);
    assert.deepEqual(model.input, ['text', 'image']);
    assert.deepEqual(detail.limitsSource, { context: 'installed-exact-match', output: 'installed-exact-match' });
    assert.deepEqual(detail.warnings, [
      'context-from-installed-exact-match', 'output-from-installed-exact-match',
    ]);
  });

  it('handles an installed exact match with an absent input list conservatively', () => {
    const known = knownModel('installed-without-input', { input: undefined });
    const { model } = parseOne(entry(known.id, { capabilities: undefined }), {
      knownModels: new Map([[known.id, known]]),
    });
    assert.deepEqual(model.input, ['text']);
    assert.equal(model.reasoning, false);
    assert.deepEqual(model.thinkingLevelMap, nullThinkingMap());
  });

  it('does not invent image limits when only image support is advertised', () => {
    const { detail } = parseOne(entry('vision-without-limits', {
      capabilities: { supports: { vision: true } },
    }));
    assert.deepEqual(detail.vision, {
      maxPromptImages: null, maxImageBytes: null, supportedMediaTypes: [],
    });
    assert.equal(parseOne(entry('text-only')).detail.vision, null);
  });

  it('lets explicit vision=false override an installed image capability', () => {
    const known = knownModel('vision-disabled', { input: ['text', 'image'] });
    const { model } = parseOne(entry(known.id, {
      capabilities: { type: 'chat', supports: { tool_calls: true, vision: false } },
    }), { knownModels: new Map([[known.id, known]]) });
    assert.deepEqual(model.input, ['text']);
  });

  it('supports the explicit image capability without guessing it from the family name', () => {
    const { model } = parseOne(entry('image-capability', {
      capabilities: { supports: { image: true } },
    }));
    assert.deepEqual(model.input, ['text', 'image']);
  });

  it('rejects non-positive, non-integer, unsafe, and string limits before using safe aliases', () => {
    const { model, detail } = parseOne(entry('invalid-primary-limits', {
      capabilities: {
        limits: {
          max_context_window_tokens: -1,
          max_prompt_tokens: 32000,
          max_output_tokens: '64000',
          max_completion_tokens: 4096,
        },
      },
    }));
    assert.equal(model.contextWindow, 32000);
    assert.equal(model.maxTokens, 4096);
    assert.equal(detail.maxPromptTokens, 32000);
    for (const invalid of [0, -1, 1.5, '1000000', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null]) {
      const parsed = parseOne(entry('invalid-limits', {
        capabilities: { limits: { max_context_window_tokens: invalid, max_output_tokens: invalid } },
      }));
      assert.equal(parsed.model.contextWindow, 128000, `invalid context: ${String(invalid)}`);
      assert.equal(parsed.model.maxTokens, 8192, `invalid output: ${String(invalid)}`);
    }
  });

  it('reads legacy context/output aliases when the primary limits are missing', () => {
    const first = parseOne(entry('capability-aliases', {
      capabilities: { max_context_window_tokens: 90000, max_output_tokens: 12000 },
    }));
    assert.equal(first.model.contextWindow, 90000);
    assert.equal(first.model.maxTokens, 12000);
    const second = parseOne(entry('top-level-aliases', {
      context_window: 50000, max_output_tokens: 7000,
    }));
    assert.equal(second.model.contextWindow, 50000);
    assert.equal(second.model.maxTokens, 7000);
    const third = parseOne(entry('max-tokens-alias', {
      capabilities: { limits: { max_context_window_tokens: 40000, max_tokens: 6000 } },
    }));
    assert.equal(third.model.maxTokens, 6000);
  });

  it('caps maximum output at context size and supports caller-supplied conservative defaults', () => {
    const { model } = parseOne(entry('small-context', {
      capabilities: { limits: { max_context_window_tokens: 4000, max_output_tokens: 64000 } },
    }));
    assert.equal(model.maxTokens, 4000);
    const fallback = parseOne(entry('custom-defaults'), {
      fallbackContextWindow: 24000, fallbackMaxTokens: 3000,
    });
    assert.equal(fallback.model.contextWindow, 24000);
    assert.equal(fallback.model.maxTokens, 3000);
  });
});

describe('reasoning effort enums and provider-default behavior', () => {
  const enumSources = [
    ['top-level', { supported_reasoning_efforts: ['low', 'medium', 'high'] }],
    ['capabilities', { capabilities: { supported_reasoning_efforts: ['low', 'medium', 'high'] } }],
    ['reasoning.supported_efforts', { capabilities: { reasoning: { supported_efforts: ['low', 'medium', 'high'] } } }],
    ['reasoning.efforts', { capabilities: { reasoning: { efforts: ['low', 'medium', 'high'] } } }],
    ['supports.reasoning_effort array', { capabilities: { supports: { reasoning_effort: ['low', 'medium', 'high'] } } }],
    ['supports.reasoning_effort values', { capabilities: { supports: { reasoning_effort: { supported_values: ['low', 'medium', 'high'] } } } }],
    ['limits', { capabilities: { limits: { supported_reasoning_efforts: ['low', 'medium', 'high'] } } }],
  ];
  for (const [label, overrides] of enumSources) {
    it(`reads only the advertised enum from ${label}`, () => {
      const { model, detail } = parseOne(entry('enum-model', overrides));
      assert.deepEqual(detail.reasoning, { mode: 'selectable', efforts: ['low', 'medium', 'high'] });
      assert.deepEqual(model.thinkingLevelMap, {
        ...nullThinkingMap(), low: 'low', medium: 'medium', high: 'high',
      });
    });
  }

  it('maps none to off, filters unknown values, deduplicates, and orders UI levels', () => {
    const { model, detail } = parseOne(entry('enum-filtering', {
      supported_reasoning_efforts: ['high', 'none', 'low', 'low', 'unsupported', null, 2, 'medium'],
    }));
    assert.deepEqual(detail.reasoning.efforts, ['off', 'low', 'medium', 'high']);
    assert.deepEqual(model.thinkingLevelMap, {
      ...nullThinkingMap(), off: 'none', low: 'low', medium: 'medium', high: 'high',
    });
  });

  it('does not invent adjustable levels from reasoning=true without an advertised enum', () => {
    const { model, detail } = parseOne(entry('default-reasoning', {
      capabilities: { supports: { reasoning: true, reasoning_effort: true } },
    }));
    assert.equal(model.reasoning, true);
    assert.deepEqual(detail.reasoning, { mode: 'provider-default', efforts: [] });
    assert.deepEqual(model.thinkingLevelMap, nullThinkingMap());
    assert.equal(model.compat.supportsReasoningEffort, false);
  });

  it('lets reasoning_effort=false disable both explicit enums and installed effort quirks', () => {
    const known = knownModel('no-adjustment', {
      reasoning: true, compat: { supportsReasoningEffort: true },
    });
    const { model, detail } = parseOne(entry(known.id, {
      supported_reasoning_efforts: ['low', 'medium', 'high'],
      capabilities: { supports: { reasoning: true, reasoning_effort: false } },
    }), { knownModels: new Map([[known.id, known]]) });
    assert.deepEqual(model.thinkingLevelMap, nullThinkingMap());
    assert.deepEqual(detail.reasoning, { mode: 'provider-default', efforts: [] });
    assert.equal(model.compat.supportsReasoningEffort, false);
  });

  it('does not replace an explicitly empty live enum with installed levels', () => {
    const known = knownModel('empty-enum', {
      reasoning: true, compat: { supportsReasoningEffort: true },
    });
    const { model, detail } = parseOne(entry(known.id, { supported_reasoning_efforts: [] }), {
      knownModels: new Map([[known.id, known]]),
    });
    assert.deepEqual(model.thinkingLevelMap, nullThinkingMap());
    assert.deepEqual(detail.reasoning, { mode: 'provider-default', efforts: [] });
  });

  it('preserves protocol-specific installed mappings only for an exact ID', () => {
    const known = knownModel('known-reasoner', {
      reasoning: true,
      compat: { supportsReasoningEffort: true },
      thinkingLevelMap: {
        off: null, minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null,
      },
    });
    const { model, detail } = parseOne(entry(known.id), {
      knownModels: new Map([[known.id, known]]),
    });
    assert.deepEqual(model.thinkingLevelMap, known.thinkingLevelMap);
    assert.deepEqual(detail.reasoning.efforts, ['minimal', 'low', 'medium', 'high']);
  });
});

describe('URL trust boundary and credential redaction', () => {
  const accepted = [
    [DEFAULT_BASE, DEFAULT_BASE],
    [`${DEFAULT_BASE}///`, DEFAULT_BASE],
    ['https://api.business.githubcopilot.com/', 'https://api.business.githubcopilot.com'],
    ['HTTPS://API.INDIVIDUAL.GITHUBCOPILOT.COM/', DEFAULT_BASE],
    [`${DEFAULT_BASE}/v1/`, `${DEFAULT_BASE}/v1`],
  ];
  for (const [input, expected] of accepted) {
    it(`accepts and normalizes trusted Copilot endpoint ${input}`, () => {
      assert.equal(trustedCopilotBaseURL(input), expected);
    });
  }

  const rejected = [
    'http://api.individual.githubcopilot.com',
    'ftp://api.individual.githubcopilot.com',
    'file:///api.individual.githubcopilot.com',
    'https://localhost',
    'https://127.0.0.1',
    'https://attacker.invalid',
    'https://githubcopilot.com',
    'https://evilgithubcopilot.com',
    'https://api.individual.githubcopilot.com.attacker.invalid',
    'https://api.individual.githubcopilot.com@attacker.invalid',
    `https://synthetic-user:TEST_ONLY_SECRET@api.individual.githubcopilot.com`,
    `https://synthetic-user@api.individual.githubcopilot.com`,
    `https://:TEST_ONLY_SECRET@api.individual.githubcopilot.com`,
    `${DEFAULT_BASE}:8443`,
    `${DEFAULT_BASE}/?token=TEST_ONLY_SECRET`,
    `${DEFAULT_BASE}/#TEST_ONLY_SECRET`,
    'not a URL',
  ];
  for (const input of rejected) {
    const label = input.replaceAll('TEST_ONLY_SECRET', '[synthetic secret]');
    it(`rejects untrusted or credential-bearing URL ${label}`, () => {
      assert.throws(() => trustedCopilotBaseURL(input));
    });
  }

  it('does not echo credentials in errors for otherwise well-formed rejected URLs', () => {
    const marker = 'SYNTHETIC_CREDENTIAL_MUST_NOT_LEAK';
    for (const input of [
      `https://unit-test:${marker}@api.individual.githubcopilot.com`,
      `${DEFAULT_BASE}/?token=${marker}`,
      `${DEFAULT_BASE}/#${marker}`,
    ]) {
      let error;
      try { trustedCopilotBaseURL(input); } catch (caught) { error = caught; }
      assert.ok(error instanceof Error);
      assert.equal(`${error.message}\n${error.stack}\n${JSON.stringify(error)}`.includes(marker), false);
    }
  });

  it('does not retain credentials on errors for malformed URLs either', () => {
    const marker = 'SYNTHETIC_MALFORMED_CREDENTIAL_MUST_NOT_LEAK';
    let error;
    try {
      trustedCopilotBaseURL(`https://unit-test:${marker}@[invalid-ipv6`);
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof Error);
    assert.equal(
      `${error.message}\n${error.stack}\n${JSON.stringify(error)}`.includes(marker),
      false,
      'URL parser errors must be replaced/redacted; Node TypeError.input retains the supplied URL',
    );
  });
});

describe('advertised model information', () => {
  it('advertises Carbon live limits and protocol without inventing policy requirements', () => {
    const { detail } = parseOne(carbonEntry);
    const info = advertisedInfo(detail);
    assert.equal(info.id, CARBON_ID);
    assert.equal(info.provider, LIVE_PROVIDER);
    assert.equal(info.name, 'Gemini 4 Carbon');
    assert.match(info.description, /1,000,000/);
    assert.match(info.description, /64,000/);
    assert.match(info.description, /openai-completions/);
    assert.equal(info.badge.tone, 'neutral');
    assert.equal(info.badge.text.zh, '入 $2.00 / 出 $10.00');
    assert.equal(info.badge.text.en, 'In $2.00 / Out $10.00');
    assert.doesNotMatch(info.badge.text.zh, /百万|tokens/);
    assert.doesNotMatch(info.badge.text.en, /1M|tokens/);
    assert.match(info.description, /缓存读 \$0\.10/);
    assert.deepEqual(info.inputModalities, ['text', 'image']);
    info.inputModalities.push('unit-test-only');
    assert.deepEqual(detail.inputModalities, ['text', 'image']);
  });
});
