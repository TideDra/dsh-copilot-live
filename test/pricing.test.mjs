import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import {
  AI_CREDITS_PER_USD, CREDIT_DOCUMENTATION, PRICING_DOCUMENTATION,
  TOKENS_PER_PRICE_UNIT, formatUSD, parsePricing, priceView,
  pricingBadge, pricingDescription, pricingSummary,
} from '../pricing.js';
import { advertisedInfo, parseCatalog } from '../catalog.js';

// Pure offline fixtures. These tests never import auth/runtime code, read any
// credential, call fetch/inference, install dependencies, or modify core files.
const live = JSON.parse(await readFile(new URL('./fixtures/live-catalog.json', import.meta.url), 'utf8'));
const carbon = live.data.find(model => model.id === 'gemini-4-carbon');
const flash = live.data.find(model => model.id === 'gemini-3.8-flash');
const fields = ['input', 'output', 'cacheRead', 'cacheWrite'];
const clone = value => structuredClone(value);
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
function billing(tier = {}, overrides = {}) {
  return { token_prices: { batch_size: 1_000_000, default: { input_price: 200, output_price: 1000, ...tier }, ...overrides } };
}
function chat(id = 'priced-unit-model', overrides = {}) {
  return {
    id, name: id, model_picker_enabled: true,
    capabilities: { type: 'chat', supports: { tool_calls: true, streaming: true },
      limits: { max_context_window_tokens: 1_000_000, max_prompt_tokens: 936_000, max_output_tokens: 64_000 } },
    supported_endpoints: ['/chat/completions'],
    billing: billing({ cache_price: 10, cache_write_price: 0, context_max: 936_000 }),
    ...overrides,
  };
}
function first(value) { return parsePricing(value).tiers[0]; }
function close(actual, expected) {
  assert.ok(typeof actual === 'number' && Math.abs(actual - expected) <= Math.max(1e-12, Math.abs(expected) * 1e-12), `${actual} should equal ${expected}`);
}
function assertNoNonFinite(pricing) {
  for (const tier of pricing.tiers) for (const map of ['rawAmountsPerBatch', 'creditsPerBatch', 'creditsPerMillion', 'usdPerMillion']) {
    for (const value of Object.values(tier[map])) assert.ok(value === null || Number.isFinite(value), `${map} must not expose Infinity/NaN`);
  }
}
function assertUnknown(pricing) {
  assertNoNonFinite(pricing);
  assert.match(pricingSummary(pricing), /价格未提供/);
  assert.match(pricingSummary(pricing, 'en'), /unavailable/i);
  assert.doesNotMatch(pricingSummary(pricing), /免费|\$0(?:\.00)?(?:\b|\s|$)/);
}

deepFreeze(live);

describe('live API prices and native display integration', () => {
  it('converts the live Carbon 200/1000/10 AI-credit fields to USD 2/10/0.1 per million', () => {
    assert.ok(carbon);
    assert.equal(carbon.billing.token_prices.batch_size, 1_000_000);
    assert.equal(carbon.billing.token_prices.default.input_price, 200);
    assert.equal(carbon.billing.token_prices.default.output_price, 1000);
    assert.equal(carbon.billing.token_prices.default.cache_price, 10);
    const parsed = parsePricing(carbon.billing);
    assert.equal(parsed.kind, 'tokens');
    assert.equal(parsed.source, 'copilot-api');
    assert.equal(parsed.apiFormat, 'tiered-ai-credits');
    assert.equal(parsed.perTokens, 1_000_000);
    assert.equal(parsed.batchSize, 1_000_000);
    assert.equal(parsed.batchSizeSource, 'api');
    assert.equal(parsed.creditsPerUSD, 100);
    assert.deepEqual(parsed.tiers[0].creditsPerMillion, { input: 200, output: 1000, cacheRead: 10, cacheWrite: 0 });
    assert.deepEqual(parsed.tiers[0].usdPerMillion, { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 });
    assert.equal(parsed.tiers[0].contextMax, 936_000);
    assert.equal(parsed.legacyMultiplier, null);
    assert.deepEqual(parsed.warnings, []);
  });
  it('uses the captured API cache rate rather than silently replacing it with a documentation table rate', () => {
    assert.ok(flash);
    const raw = flash.billing.token_prices.default.cache_price;
    assert.equal(raw, 7);
    assert.equal(first(flash.billing).usdPerMillion.cacheRead, 0.07);
    assert.notEqual(first(flash.billing).usdPerMillion.cacheRead, 0.075);
  });
  it('keeps Carbon model total context distinct from the pricing prompt boundary', () => {
    const parsed = parseCatalog({ data: [carbon] });
    assert.equal(parsed.models[0].contextWindow, 1_000_000);
    assert.equal(parsed.details[0].contextWindow, 1_000_000);
    assert.equal(parsed.details[0].maxPromptTokens, 936_000);
    assert.equal(parsed.details[0].pricing.tiers[0].contextMax, 936_000);
    assert.equal(parsed.details[0].maxTokens, 64_000);
    const info = advertisedInfo(parsed.details[0]);
    assert.match(info.description, /1,000,000/);
    assert.match(info.description, /\$2\.00/);
    assert.match(info.description, /\$10\.00/);
    assert.match(info.description, /\$0\.10/);
    assert.equal(info.badge.text.zh, '入 $2.00 / 出 $10.00');
    assert.equal(info.badge.text.en, 'In $2.00 / Out $10.00');
    assert.doesNotMatch(info.badge.text.zh, /百万|tokens/);
    assert.doesNotMatch(info.badge.text.en, /1M|tokens/);
    assert.equal(pricingBadge(parsed.details[0].pricing, 'zh'), '入 $2.00 / 出 $10.00');
    assert.equal(info.badge.tone, 'neutral');
  });
  it('policy acceptance warning takes precedence over a price badge without deleting the quoted price', () => {
    const result = parseCatalog({ data: [chat('policy-pending', { policy: { state: 'unconfigured' } })] });
    const info = advertisedInfo(result.details[0]);
    assert.equal(info.badge.tone, 'warning');
    assert.equal(info.badge.text.zh, '需确认条款');
    assert.equal(info.badge.text.en, 'Policy required');
    assert.match(info.description, /\$2\.00/);
    assert.match(info.description, /GitHub.*条款/);
    assert.deepEqual(result.details[0].pricing.tiers[0].usdPerMillion.input, 2);
  });
  it('exposes price-view rows only for selectable chat models and excludes non-selectable ones', () => {
    const raw = { data: [
      chat('allowed'),
      chat('policy-disabled', { policy: { state: 'disabled' } }),
      chat('hidden', { model_picker_enabled: false }),
      chat('no-tools', { capabilities: { type: 'chat', supports: { tool_calls: false } } }),
      chat('no-stream', { capabilities: { type: 'chat', supports: { streaming: false } } }),
      chat('unsupported', { supported_endpoints: ['/some-unimplemented-api'] }),
      chat('embedding', { capabilities: { type: 'embeddings' } }),
      chat('image', { capabilities: { type: 'image' } }),
    ] };
    const parsed = parseCatalog(raw);
    assert.deepEqual(parsed.models.map(model => model.id), ['allowed']);
    assert.deepEqual(parsed.priceModels.map(model => model.id), ['allowed']);
    assert.equal(parsed.priceModels[0].selectable, true);
    assert.equal(parsed.priceModels[0].unavailableReason, null);
    assert.equal(parsed.priceModels[0].pricing.tiers[0].usdPerMillion.input, 2);
  });
  it('does not use an installed model cost or a nearby family as a missing API quote', () => {
    const known = { id: 'known-price', api: 'openai-completions', input: ['text'], contextWindow: 128000, maxTokens: 8192,
      cost: { input: 999, output: 999, cacheRead: 999, cacheWrite: 999 } };
    const parsed = parseCatalog({ data: [chat('known-price', { billing: undefined })] }, { knownModels: new Map([[known.id, known]]) });
    assert.equal(parsed.details[0].pricing.kind, 'unavailable');
    const info = advertisedInfo(parsed.details[0]);
    assert.equal(info.badge.text.zh, '价格未提供');
    assert.doesNotMatch(info.description, /免费|\$0\.00|999.*USD/);
  });
  it('deduplicates price rows with the same request ID and never inserts a missing model', () => {
    const parsed = parseCatalog({ data: [chat('one'), chat('one', { billing: billing({ input_price: 999 }) })] });
    assert.equal(parsed.priceModels.length, 1);
    assert.equal(parsed.priceModels[0].pricing.tiers[0].usdPerMillion.input, 2);
    assert.deepEqual(parseCatalog({ data: [] }).priceModels, []);
  });
});

describe('tiered AI-credit normalization and batch sizes', () => {
  it('exports the verified denomination and official references, not model-specific hardcoded rates', () => {
    assert.equal(TOKENS_PER_PRICE_UNIT, 1_000_000);
    assert.equal(AI_CREDITS_PER_USD, 100);
    assert.equal(PRICING_DOCUMENTATION, 'https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing');
    assert.equal(CREDIT_DOCUMENTATION, 'https://docs.github.com/en/copilot/concepts/billing-and-usage/individuals/billing');
  });
  for (const batchSize of [1, 1000, 250_000, 500_000, 2_000_000, 3_000_000]) {
    it(`normalizes a ${batchSize}-token batch without assuming one million`, () => {
      const pricing = parsePricing(billing({ input_price: 7.5, output_price: 12.25, cache_price: 1.5, cache_write_price: 0 }, { batch_size: batchSize }));
      const tier = pricing.tiers[0];
      for (const [field, raw] of [['input', 7.5], ['output', 12.25], ['cacheRead', 1.5], ['cacheWrite', 0]]) {
        close(tier.creditsPerBatch[field], raw);
        close(tier.creditsPerMillion[field], raw * 1_000_000 / batchSize);
        close(tier.usdPerMillion[field], raw * 1_000_000 / batchSize / 100);
      }
      assert.equal(pricing.batchSizeSource, 'api');
      assertNoNonFinite(pricing);
    });
  }
  for (const missing of [undefined, null]) {
    it(`treats a ${String(missing)} batch as the official nullish one-million default`, () => {
      const raw = billing();
      if (missing === undefined) delete raw.token_prices.batch_size;
      else raw.token_prices.batch_size = null;
      const pricing = parsePricing(raw);
      assert.equal(pricing.batchSize, 1_000_000);
      assert.equal(pricing.batchSizeSource, 'default');
      assert.equal(pricing.tiers[0].usdPerMillion.input, 2);
    });
  }
  for (const [label, invalid] of [['zero', 0], ['negative', -1], ['fraction', 1.5], ['string', '1000000'], ['NaN', NaN], ['Infinity', Infinity], ['minusInfinity', -Infinity], ['unsafeInteger', Number.MAX_SAFE_INTEGER + 1], ['false', false], ['object', {}]]) {
    it(`does not normalize an explicitly invalid ${label} batch`, () => {
      const pricing = parsePricing(billing({ cache_price: 0, cache_write_price: 0 }, { batch_size: invalid }));
      assert.equal(pricing.kind, 'tokens');
      assert.equal(pricing.batchSize, null);
      assert.equal(pricing.batchSizeSource, 'invalid');
      assert(pricing.warnings.includes('invalid-token-batch-size'));
      for (const field of fields) {
        assert.equal(pricing.tiers[0].creditsPerMillion[field], null);
        assert.equal(pricing.tiers[0].usdPerMillion[field], null);
      }
      assert.equal(pricing.tiers[0].rawAmountsPerBatch.input, 200);
      assertUnknown(pricing);
    });
  }
  it('does not call an all-zero internal response with a zero batch free per million', () => {
    const pricing = parsePricing(billing({ input_price: 0, output_price: 0, cache_price: 0, cache_write_price: 0 }, { batch_size: 0 }));
    assert.deepEqual(pricing.tiers[0].rawAmountsPerBatch, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.deepEqual(pricing.tiers[0].usdPerMillion, { input: null, output: null, cacheRead: null, cacheWrite: null });
    assertUnknown(pricing);
  });
  it('keeps fractional raw credits rather than silently rounding them to integers', () => {
    const pricing = parsePricing(billing({ input_price: 7.5, output_price: 12.25, cache_price: 0.375, cache_write_price: 0.125 }));
    assert.deepEqual(pricing.tiers[0].rawAmountsPerBatch, { input: 7.5, output: 12.25, cacheRead: 0.375, cacheWrite: 0.125 });
    close(pricing.tiers[0].usdPerMillion.cacheRead, 0.00375);
    close(pricing.tiers[0].usdPerMillion.cacheWrite, 0.00125);
  });
});

describe('legacy flat nano-credits and request multipliers', () => {
  it('divides flat legacy input, output and cache prices by one billion before credit and USD conversion', () => {
    const parsed = parsePricing({ token_prices: { batch_size: 1_000_000, input_price: 3_000_000_000, output_price: 15_000_000_000, cache_price: 375_000_000 } });
    assert.equal(parsed.apiFormat, 'flat-nano-ai-credits');
    close(parsed.tiers[0].creditsPerMillion.input, 3);
    close(parsed.tiers[0].creditsPerMillion.output, 15);
    close(parsed.tiers[0].creditsPerMillion.cacheRead, 0.375);
    assert.equal(parsed.tiers[0].creditsPerMillion.cacheWrite, null);
    close(parsed.tiers[0].usdPerMillion.input, 0.03);
    close(parsed.tiers[0].usdPerMillion.output, 0.15);
    close(parsed.tiers[0].usdPerMillion.cacheRead, 0.00375);
    assert.equal(parsed.tiers[0].contextMax, null);
  });
  it('scales a legacy half-million batch and defaults a missing batch without mixing tiered units', () => {
    const raw = { input_price: 1_500_000_000, output_price: 7_500_000_000 };
    const half = parsePricing({ token_prices: { ...raw, batch_size: 500_000 } });
    close(half.tiers[0].usdPerMillion.input, 0.03);
    close(half.tiers[0].usdPerMillion.output, 0.15);
    const missing = parsePricing({ token_prices: raw });
    close(missing.tiers[0].usdPerMillion.input, 0.015);
    assert.equal(missing.batchSizeSource, 'default');
  });
  it('gives a real tiered default precedence over ambiguous top-level flat fields', () => {
    const parsed = parsePricing(billing({}, { input_price: 999_000_000_000, output_price: 999_000_000_000 }));
    assert.equal(parsed.apiFormat, 'tiered-ai-credits');
    assert.equal(parsed.tiers[0].usdPerMillion.input, 2);
    assert.equal(parsed.tiers[0].usdPerMillion.output, 10);
  });
  it('does not assign undocumented flat cache-write fields the tiered or nano-credit currency', () => {
    // Microsoft's legacy flat branch explicitly sets cacheWritePrice undefined.
    const parsed = parsePricing({ token_prices: { batch_size: 1_000_000, input_price: 3e9, output_price: 15e9, cache_write_price: 1.5e9 } });
    assert.equal(parsed.tiers[0].usdPerMillion.cacheWrite, null);
  });
  for (const multiplier of [0, 0.5, 1, 3.25]) {
    it(`shows request multiplier ${multiplier} only as legacy requests, not token dollars`, () => {
      const parsed = parsePricing({ multiplier });
      assert.equal(parsed.kind, 'legacy-requests');
      assert.equal(parsed.legacyMultiplier, multiplier);
      assert.deepEqual(parsed.tiers, []);
      assert.match(pricingSummary(parsed, 'zh'), /旧制高级请求/);
      assert.match(pricingSummary(parsed, 'en'), /Legacy premium requests/);
      assert.doesNotMatch(pricingSummary(parsed), /\$|百万|USD/);
    });
  }
  it('never falls back to request multipliers when token pricing is explicitly invalid or unknown', () => {
    for (const token_prices of [null, {}, [], 'unknown', { future_price: 200 }]) {
      const parsed = parsePricing({ token_prices, multiplier: 5 });
      assert.equal(parsed.kind, 'unavailable');
      assert.equal(parsed.legacyMultiplier, null);
      assertUnknown(parsed);
    }
  });
});

describe('amount validation, missing prices and arithmetic integrity', () => {
  for (const [label, invalid] of [['null', null], ['string', '200'], ['emptyString', ''], ['negative', -1], ['NaN', NaN], ['Infinity', Infinity], ['minusInfinity', -Infinity], ['false', false], ['object', {}], ['array', []]]) {
    it(`keeps invalid ${label} amounts unknown without coercion or a false zero price`, () => {
      const pricing = parsePricing(billing({ input_price: invalid, output_price: invalid, cache_price: invalid, cache_write_price: invalid }));
      assert.deepEqual(pricing.tiers[0].rawAmountsPerBatch, { input: null, output: null, cacheRead: null, cacheWrite: null });
      assert.deepEqual(pricing.tiers[0].usdPerMillion, { input: null, output: null, cacheRead: null, cacheWrite: null });
      assert(pricing.warnings.includes('incomplete-token-pricing'));
      assertUnknown(pricing);
    });
  }
  for (const value of [undefined, null, false, 1, 'billing', [], {}, { arbitrary: 1 }]) {
    it(`handles missing or unrecognized billing ${JSON.stringify(value)} without claiming free service`, () => {
      const parsed = parsePricing(value);
      assert.equal(parsed.kind, 'unavailable');
      assertUnknown(parsed);
    });
  }
  it('distinguishes missing optional cache fields from explicitly zero cache prices', () => {
    const absent = first(billing());
    assert.equal(absent.usdPerMillion.cacheRead, null);
    assert.equal(absent.usdPerMillion.cacheWrite, null);
    const zero = first(billing({ cache_price: 0, cache_write_price: 0 }));
    assert.equal(zero.usdPerMillion.cacheRead, 0);
    assert.equal(zero.usdPerMillion.cacheWrite, 0);
    assert.match(pricingDescription(parsePricing(billing())), /缓存读 — \/ 缓存写 —/);
    assert.match(pricingDescription(parsePricing(billing({ cache_price: 0, cache_write_price: 0 }))), /缓存读 \$0\.00 \/ 缓存写 \$0\.00/);
  });
  it('keeps a missing input price unknown even when an output quote exists', () => {
    const parsed = parsePricing({ token_prices: { batch_size: 1_000_000, default: { output_price: 1000 } } });
    assert.equal(parsed.tiers[0].usdPerMillion.input, null);
    assert.equal(parsed.tiers[0].usdPerMillion.output, 10);
    assert.match(pricingSummary(parsed), /入 — \/ 出 \$10\.00/);
    assert.doesNotMatch(pricingSummary(parsed), /免费|\$0\.00/);
  });
  it('does not invent prices from unrecognized nested fields', () => {
    const parsed = parsePricing({ token_prices: { batch_size: 1_000_000, default: { future_input_price: 200, future_output_price: 1000 } } });
    assertUnknown(parsed);
  });
  it('does not mutate frozen raw billing data or unrelated metadata', () => {
    const raw = deepFreeze({ token_prices: { batch_size: 500_000, default: { input_price: 200, output_price: 1000, currency: 'untrusted-extra-field' }, future: { rate: 1 } }, arbitrary: { untouched: true } });
    const before = JSON.stringify(raw);
    parsePricing(raw);
    assert.equal(JSON.stringify(raw), before);
  });
  it('turns multiplication overflow into an unknown amount rather than Infinity', () => {
    const pricing = parsePricing(billing({ input_price: Number.MAX_VALUE, output_price: Number.MAX_VALUE }, { batch_size: 1 }));
    assert.equal(pricing.tiers[0].usdPerMillion.input, null);
    assert.equal(pricing.tiers[0].usdPerMillion.output, null);
    assertUnknown(pricing);
  });
  it('never turns a strictly positive raw quote into a zero-dollar quote through numeric underflow', () => {
    const pricing = parsePricing(billing({ input_price: Number.MIN_VALUE, output_price: Number.MIN_VALUE }));
    for (const field of ['input', 'output']) {
      const value = pricing.tiers[0].usdPerMillion[field];
      assert.ok(value === null || value > 0, 'a positive source that underflows must stay unknown, never become a free quote');
    }
    assert.doesNotMatch(pricingSummary(pricing), /\$0\.00/);
  });
});

describe('field aliases, context tiers and view models', () => {
  it('prefers modern cache_read_price over earlier cache_price, including explicit zero', () => {
    assert.equal(first(billing({ cache_read_price: 7.5, cache_price: 999 })).usdPerMillion.cacheRead, 0.075);
    assert.equal(first(billing({ cache_read_price: 0, cache_price: 999 })).usdPerMillion.cacheRead, 0);
    assert.equal(first(billing({ cache_read_price: null, cache_price: 10 })).usdPerMillion.cacheRead, 0.1);
    assert.equal(first(billing({ cache_read_price: 'bad', cache_price: 10 })).usdPerMillion.cacheRead, null);
  });
  it('prefers modern price-tier max_prompt_tokens without changing the model context window', () => {
    const result = parseCatalog({ data: [chat('tier-context', { billing: billing({ max_prompt_tokens: 100_000, context_max: 200_000 }, { long_context: { input_price: 400, output_price: 2000, max_prompt_tokens: 900_000, context_max: 950_000 } }) })] });
    const pricing = result.details[0].pricing;
    assert.equal(pricing.tiers[0].contextMax, 100_000);
    assert.equal(pricing.tiers[1].contextMinExclusive, 100_000);
    assert.equal(pricing.tiers[1].contextMax, 900_000);
    assert.equal(result.details[0].contextWindow, 1_000_000);
    assert.equal(result.models[0].contextWindow, 1_000_000);
    assert.equal(result.details[0].maxPromptTokens, 936_000);
    assert.match(pricingDescription(pricing), /长上下文 >100000 入 \$4\.00 \/ 出 \$20\.00/);
  });
  it('retains legacy context_max boundaries and both long-tier cache rates', () => {
    const parsed = parsePricing(billing({ cache_price: 10, cache_write_price: 125, context_max: 200_000 }, { long_context: { input_price: 400, output_price: 2000, cache_price: 20, cache_write_price: 250, context_max: 936_000 } }));
    assert.equal(parsed.tiers[1].contextMinExclusive, 200_000);
    assert.equal(parsed.tiers[1].contextMax, 936_000);
    assert.deepEqual(parsed.tiers[1].usdPerMillion, { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 2.5 });
  });
  it('marks inconsistent tier bounds without inventing a reversed price interval', () => {
    const parsed = parsePricing(billing({ context_max: 200_000 }, { long_context: { input_price: 400, output_price: 2000, context_max: 100_000 } }));
    assert(parsed.warnings.includes('inconsistent-context-range'));
    assert.equal(parsed.tiers[1].contextMinExclusive, null);
  });
  it('does not invent a long-context tier or a lower boundary when metadata is missing', () => {
    const onlyDefault = parsePricing(billing({ context_max: 936_000 }));
    assert.equal(onlyDefault.tiers.length, 1);
    assert.equal(onlyDefault.tiers[0].contextMinExclusive, null);
    assert.doesNotMatch(pricingDescription(onlyDefault), /长上下文|long context/);
    const onlyLong = parsePricing({ token_prices: { batch_size: 1_000_000, long_context: { input_price: 400, output_price: 2000 } } });
    assert.equal(onlyLong.tiers[0].contextMinExclusive, null);
    assert.equal(onlyLong.tiers[0].contextMax, null);
    assertNoNonFinite(onlyLong);
  });
  it('formats a price-view row while preserving nonselectable state and unknown cache values', () => {
    const parsed = parsePricing(billing());
    const view = priceView({ id: 'priced', name: 'Priced', selectable: false, unavailableReason: 'policy-disabled', pricing: parsed });
    assert.equal(view.id, 'priced');
    assert.equal(view.selectable, false);
    assert.equal(view.unavailableReason, 'policy-disabled');
    assert.deepEqual(view.displayTiers[0].prices, { input: '$2.00', output: '$10.00', cacheRead: null, cacheWrite: null });
    assert.match(view.summaries.zh, /USD|百万 tokens/);
    assert.match(view.summaries.en, /per 1M tokens/);
  });
  it('gives a model with no quote an unavailable view rather than a free view', () => {
    const view = priceView({ id: 'unknown', name: 'Unknown' });
    assert.equal(view.pricing.kind, 'unavailable');
    assert.deepEqual(view.displayTiers, []);
    assert.equal(view.summaries.zh, '价格未提供');
    assert.equal(view.summaries.en, 'Price unavailable');
    assert.doesNotMatch(JSON.stringify(view), /免费|\$0\.00/);
  });
});

describe('USD display precision', () => {
  for (const [value, expected] of [[0, '$0.00'], [2, '$2.00'], [10, '$10.00'], [0.1, '$0.10'], [0.075, '$0.075'], [0.07, '$0.07'], [0.00375, '$0.00375'], [0.00125, '$0.00125'], [0.00000001, '$0.00000001'], [1234.5, '$1,234.50']]) {
    it(`preserves the intended decimal value ${value}`, () => assert.equal(formatUSD(value), expected));
  }
  for (const value of [1e-9, 1e-12, 1e-100, Number.MIN_VALUE]) {
    it(`does not round a representable nonzero USD ${value} to zero`, () => {
      const formatted = formatUSD(value);
      assert.match(formatted, /^\$[\d.]+e-\d+$/);
      assert(Number(formatted.slice(1)) > 0);
      assert.notEqual(formatted, '$0.00');
    });
  }
  for (const [label, value] of [['null', null], ['undefined', undefined], ['string', '2'], ['negative', -1], ['Infinity', Infinity], ['NaN', NaN], ['boolean', false]]) {
    it(`does not format invalid ${label} money as a quote`, () => assert.equal(formatUSD(value), null));
  }
  it('formats negative zero as economic zero, not a negative fee', () => assert.equal(formatUSD(-0), '$0.00'));
});
