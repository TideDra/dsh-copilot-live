// Units follow Microsoft's official normalizeTokenPrices implementation:
// https://github.com/microsoft/vscode/blob/b37ee54558593263e8e1a61bd4c102ad82dceefd/extensions/copilot/src/extension/conversation/common/languageModelAccess.ts
// Tiered API 2026-06-01+: AI credits / batch; legacy flat: nano AI credits / batch.
// GitHub documents 1 AI credit = USD 0.01. No model-specific price is hardcoded.
export const PRICING_DOCUMENTATION = 'https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing';
export const CREDIT_DOCUMENTATION = 'https://docs.github.com/en/copilot/concepts/billing-and-usage/individuals/billing';
export const TOKENS_PER_PRICE_UNIT = 1000000;
export const AI_CREDITS_PER_USD = 100;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? (value === 0 ? 0 : value) : null;
const positiveInteger = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const valuesOf = value => ({ input: amount(value.input_price), output: amount(value.output_price),
  cacheRead: amount(value.cache_read_price ?? value.cache_price), cacheWrite: amount(value.cache_write_price) });
const mapAmounts = (values, scale) => Object.fromEntries(Object.entries(values).map(([field, value]) => {
  const converted = value === null || scale === null ? null : value * scale;
  return [field, converted !== null && Number.isFinite(converted) && !(value > 0 && converted === 0) ? converted : null];
}));
const contextOf = tier => positiveInteger(tier.max_prompt_tokens ?? tier.context_max);

export function parsePricing(billing) {
  const source = record(billing);
  const prices = record(source.token_prices);
  const batchSize = prices.batch_size === undefined || prices.batch_size === null
    ? TOKENS_PER_PRICE_UNIT : positiveInteger(prices.batch_size);
  const batchSizeSource = prices.batch_size === undefined || prices.batch_size === null ? 'default' : batchSize === null ? 'invalid' : 'api';
  const recognized = ['default', 'long_context'].filter(id => Object.keys(record(prices[id])).length > 0);
  const flat = recognized.length === 0 && [amount(prices.input_price), amount(prices.output_price), amount(prices.cache_price)].some(value => value !== null);
  const format = flat ? 'flat-nano-ai-credits' : 'tiered-ai-credits';
  const unitScale = flat ? 1e-9 : 1;
  const tiers = [];
  const warnings = [];
  for (const id of flat ? ['default'] : recognized) {
    const tier = flat ? prices : record(prices[id]);
    const raw = flat ? { input: amount(tier.input_price), output: amount(tier.output_price), cacheRead: amount(tier.cache_price), cacheWrite: null } : valuesOf(tier);
    const creditsPerBatch = mapAmounts(raw, unitScale);
    const creditsPerMillion = mapAmounts(creditsPerBatch, batchSize === null ? null : TOKENS_PER_PRICE_UNIT / batchSize);
    const usdPerMillion = mapAmounts(creditsPerMillion, 1 / AI_CREDITS_PER_USD);
    const contextMax = flat ? null : contextOf(tier);
    const defaultMax = contextOf(record(prices.default));
    const contextMinExclusive = id === 'long_context' && defaultMax !== null && (contextMax === null || contextMax > defaultMax) ? defaultMax : null;
    if (id === 'long_context' && contextMax !== null && defaultMax !== null && contextMax <= defaultMax) warnings.push('inconsistent-context-range');
    tiers.push({ id, contextMax, contextMinExclusive, rawAmountsPerBatch: raw, creditsPerBatch, creditsPerMillion, usdPerMillion });
  }
  if (tiers.length) {
    if (batchSize === null) warnings.push('invalid-token-batch-size');
    if (tiers.some(tier => tier.usdPerMillion.input === null || tier.usdPerMillion.output === null)) warnings.push('incomplete-token-pricing');
    return { kind: 'tokens', source: 'copilot-api', apiFormat: format, displayCurrency: 'USD',
      perTokens: TOKENS_PER_PRICE_UNIT, batchSize, batchSizeSource, creditsPerUSD: AI_CREDITS_PER_USD,
      tiers, legacyMultiplier: null, warnings, documentationURL: PRICING_DOCUMENTATION };
  }
  // An explicitly token-billed model never silently falls back to request multipliers.
  if (Object.hasOwn(source, 'token_prices')) return { kind: 'unavailable', source: 'copilot-api', tiers: [], legacyMultiplier: null,
    warnings: ['unrecognized-token-pricing'], documentationURL: PRICING_DOCUMENTATION };
  const multiplier = amount(source.multiplier);
  if (multiplier !== null) return { kind: 'legacy-requests', source: 'copilot-api', tiers: [],
    legacyMultiplier: multiplier, warnings: [], documentationURL: PRICING_DOCUMENTATION };
  return { kind: 'unavailable', source: 'copilot-api', tiers: [], legacyMultiplier: null,
    warnings: ['pricing-not-provided'], documentationURL: PRICING_DOCUMENTATION };
}

export function formatUSD(value) {
  value = amount(value);
  if (value === null) return null;
  if (value > 0 && value < 1e-8) return `$${value.toExponential(3)}`;
  return `$${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 8 }).format(value)}`;
}
export function pricingBadge(pricing, locale = 'zh') {
  const zh = locale.startsWith('zh');
  if (pricing?.kind === 'legacy-requests') return zh
    ? `旧制请求 ×${pricing.legacyMultiplier}` : `Legacy ×${pricing.legacyMultiplier}`;
  const tier = pricing?.tiers?.find(item => item.id === 'default') ?? pricing?.tiers?.[0];
  if (pricing?.kind !== 'tokens' || !tier) return zh ? '价格未提供' : 'Price unavailable';
  const input = formatUSD(tier.usdPerMillion.input);
  const output = formatUSD(tier.usdPerMillion.output);
  if (input === null && output === null) return zh ? '价格未提供' : 'Price unavailable';
  return zh ? `入 ${input ?? '—'} / 出 ${output ?? '—'}` : `In ${input ?? '—'} / Out ${output ?? '—'}`;
}
export function pricingSummary(pricing, locale = 'zh') {
  const zh = locale.startsWith('zh');
  if (pricing?.kind === 'legacy-requests') return zh
    ? `旧制高级请求 ×${pricing.legacyMultiplier}` : `Legacy premium requests ×${pricing.legacyMultiplier}`;
  const tier = pricing?.tiers?.find(item => item.id === 'default') ?? pricing?.tiers?.[0];
  if (pricing?.kind !== 'tokens' || !tier) return zh ? '价格未提供' : 'Price unavailable';
  const input = formatUSD(tier.usdPerMillion.input);
  const output = formatUSD(tier.usdPerMillion.output);
  if (input === null && output === null) return zh ? '价格未提供' : 'Price unavailable';
  return zh ? `入 ${input ?? '—'} / 出 ${output ?? '—'} /百万 tokens`
    : `In ${input ?? '—'} / Out ${output ?? '—'} per 1M tokens`;
}
export function pricingDescription(pricing, locale = 'zh') {
  const zh = locale.startsWith('zh');
  const summary = pricingSummary(pricing, locale);
  if (pricing?.kind !== 'tokens') return summary;
  const tier = pricing.tiers.find(item => item.id === 'default') ?? pricing.tiers[0];
  if (!tier) return summary;
  const read = formatUSD(tier.usdPerMillion.cacheRead);
  const write = formatUSD(tier.usdPerMillion.cacheWrite);
  const long = pricing.tiers.find(item => item.id === 'long_context');
  const longText = long ? zh
    ? `；长上下文${long.contextMinExclusive === null ? '' : ` >${long.contextMinExclusive}`} 入 ${formatUSD(long.usdPerMillion.input) ?? '—'} / 出 ${formatUSD(long.usdPerMillion.output) ?? '—'}`
    : `; long context${long.contextMinExclusive === null ? '' : ` >${long.contextMinExclusive}`} In ${formatUSD(long.usdPerMillion.input) ?? '—'} / Out ${formatUSD(long.usdPerMillion.output) ?? '—'}` : '';
  return `${summary}${zh ? `；缓存读 ${read ?? '—'} / 缓存写 ${write ?? '—'}（USD/百万 tokens）` : `; cache read ${read ?? '—'} / write ${write ?? '—'} (USD/1M tokens)`}${longText}`;
}
export function priceView(model) {
  const pricing = model.pricing ?? parsePricing(undefined);
  return { id: model.id, name: model.name, selectable: model.selectable ?? true,
    unavailableReason: model.unavailableReason ?? null, apiWarningCodes: [...(model.apiWarningCodes ?? [])], pricing,
    displayTiers: pricing.tiers.map(tier => ({ id: tier.id, contextMax: tier.contextMax,
      contextMinExclusive: tier.contextMinExclusive,
      prices: Object.fromEntries(Object.entries(tier.usdPerMillion).map(([field, value]) => [field, formatUSD(value)])),
    })),
    summaries: { zh: pricingSummary(pricing, 'zh'), en: pricingSummary(pricing, 'en') } };
}
