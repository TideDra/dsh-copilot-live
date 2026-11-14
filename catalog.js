import { parsePricing, pricingBadge, pricingDescription } from './pricing.js';

export const LIVE_PROVIDER = 'github-copilot-live';
export const LIVE_NAME = 'github-copilot-live';
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const COPILOT_HEADERS = Object.freeze({
  'User-Agent': 'GitHubCopilotChat/0.35.0',
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat',
});
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const positive = (...values) => values.find(value => Number.isSafeInteger(value) && value > 0);
const text = (...values) => values.find(value => typeof value === 'string' && value.trim().length > 0);

export function trustedCopilotBaseURL(value) {
  const url = typeof value === 'string' ? URL.parse(value) : null;
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || url.port || !url.hostname.endsWith('.githubcopilot.com')) {
    throw new Error('Copilot returned an untrusted API endpoint');
  }
  return url.href.replace(/\/+$/, '');
}

function endpointsOf(item) {
  const endpoints = item.supported_endpoints ?? record(item.capabilities).supported_endpoints;
  return Array.isArray(endpoints) ? endpoints.filter(e => typeof e === 'string').map(e => e.replace(/\/+$/, '')) : [];
}
function chooseApi(item, known) {
  const endpoints = endpointsOf(item);
  const supported = new Set(endpoints.map(endpoint => {
    if (!endpoint.startsWith('/') && !endpoint.startsWith('https://')) return undefined;
    if (/\/(?:v1\/)?messages$/.test(endpoint)) return 'anthropic-messages';
    if (/\/responses$/.test(endpoint)) return 'openai-responses';
    if (/\/chat\/completions$/.test(endpoint)) return 'openai-completions';
    return undefined;
  }));
  if (known && (!endpoints.length || supported.has(known.api))) return known.api;
  const family = text(record(item.capabilities).family, item.id) ?? '';
  if (/claude/i.test(family) && supported.has('anthropic-messages')) return 'anthropic-messages';
  if (/gemini/i.test(family) && supported.has('openai-completions')) return 'openai-completions';
  if (supported.has('openai-responses')) return 'openai-responses';
  if (supported.has('openai-completions')) return 'openai-completions';
  if (supported.has('anthropic-messages')) return 'anthropic-messages';
  // Older Copilot catalog responses omit endpoint declarations. Copilot's
  // historical public chat endpoint is Chat Completions, not the Gemini API.
  return endpoints.length === 0 ? 'openai-completions' : undefined;
}
function explicitEfforts(item) {
  const capabilities = record(item.capabilities);
  const supports = record(capabilities.supports);
  const reasoning = record(capabilities.reasoning);
  const effort = supports.reasoning_effort;
  const values = item.supported_reasoning_efforts ?? capabilities.supported_reasoning_efforts
    ?? reasoning.supported_efforts ?? reasoning.efforts
    ?? (Array.isArray(effort) ? effort : record(effort).supported_values)
    ?? record(capabilities.limits).supported_reasoning_efforts;
  return Array.isArray(values) ? values.filter(value => typeof value === 'string') : undefined;
}
function reasoningOf(item, known, api) {
  const supports = record(record(item.capabilities).supports);
  const explicit = explicitEfforts(item);
  const disabled = supports.reasoning_effort === false;
  let efforts = [];
  const thinkingLevelMap = Object.fromEntries(THINKING_LEVELS.map(level => [level, null]));
  if (!disabled && explicit) {
    for (const wire of explicit) {
      const level = ['none', 'disabled', 'off'].includes(wire) ? 'off' : wire;
      if (!THINKING_LEVELS.includes(level)) continue;
      thinkingLevelMap[level] = wire;
    }
    efforts = THINKING_LEVELS.filter(level => thinkingLevelMap[level] !== null);
  } else if (!disabled && known?.reasoning) {
    // Exact catalog matches keep protocol-specific effort quirks. New models
    // without an advertised enum stay on the provider default, not guessed levels.
    const adjustable = api === 'anthropic-messages' || api === 'openai-responses'
      || known.compat?.supportsReasoningEffort === true;
    if (adjustable) {
      for (const level of THINKING_LEVELS) {
        const mapped = known.thinkingLevelMap?.[level];
        if (mapped === null || (['xhigh', 'max'].includes(level) && mapped === undefined)) continue;
        thinkingLevelMap[level] = mapped ?? level;
      }
      efforts = THINKING_LEVELS.filter(level => thinkingLevelMap[level] !== null);
    }
  }
  return {
    reasoning: supports.reasoning === true || supports.thinking === true || efforts.length > 0 || known?.reasoning === true,
    thinkingLevelMap,
    efforts,
  };
}

/** Parse only models returned by the account API: known models supply quirks,
 * never membership. No synthetic Gemini ID or per-family capacity is inserted. */
export function parseCatalog(raw, options = {}) {
  if (!raw || !Array.isArray(raw.data)) throw new Error('Invalid Copilot model directory: expected data[]');
  const knownModels = options.knownModels ?? new Map();
  const baseURL = options.baseURL ?? 'https://api.individual.githubcopilot.com';
  const fallbackContextWindow = options.fallbackContextWindow ?? 128000;
  const fallbackMaxTokens = options.fallbackMaxTokens ?? 8192;
  const hasPicker = raw.data.some(item => record(item).model_picker_enabled === true);
  const policyFallback = !hasPicker && new URL(baseURL).hostname === 'api.individual.githubcopilot.com';
  const models = [];
  const details = [];
  const excluded = [];
  const priceModels = [];
  const seen = new Set();
  for (const value of raw.data) {
    const item = record(value);
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const capabilities = record(item.capabilities);
    const supports = record(capabilities.supports);
    const limits = record(capabilities.limits);
    const known = knownModels.get(id);
    const policy = record(item.policy).state;
    let exclusion;
    if (policy === 'disabled') exclusion = 'policy-disabled';
    else if (capabilities.type && capabilities.type !== 'chat') exclusion = 'not-chat';
    else if (supports.tool_calls === false) exclusion = 'no-tool-calls';
    else if (supports.streaming === false) exclusion = 'no-streaming';
    else if (!options.includeHiddenModels && item.model_picker_enabled === false
      && !(policyFallback && policy === 'enabled')) exclusion = 'not-in-model-picker';
    const api = chooseApi(item, known);
    if (!api && !exclusion) exclusion = 'unsupported-endpoint';
    const pricing = parsePricing(item.billing);
    const apiWarningCodes = Array.isArray(item.warning_messages) ? [...new Set(item.warning_messages
      .map(value => record(value).code).filter(code => typeof code === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(code)))] : [];
    if (exclusion) { excluded.push({ id, name: item.name ?? id, reason: exclusion }); continue; }
    priceModels.push({
      id, name: text(item.name, item.display_name, id), pricing, apiWarningCodes, selectable: true,
      unavailableReason: null,
    });
    const warnings = [];
    const liveContext = positive(limits.max_context_window_tokens, limits.max_prompt_tokens,
      capabilities.max_context_window_tokens, item.context_window);
    const liveOutput = positive(limits.max_output_tokens, limits.max_completion_tokens,
      limits.max_tokens, capabilities.max_output_tokens, item.max_output_tokens);
    const contextWindow = liveContext ?? known?.contextWindow ?? fallbackContextWindow;
    const maxTokens = Math.min(liveOutput ?? known?.maxTokens ?? fallbackMaxTokens, contextWindow);
    if (!liveContext) warnings.push(known ? 'context-from-installed-exact-match' : 'context-uses-conservative-fallback');
    if (!liveOutput) warnings.push(known ? 'output-from-installed-exact-match' : 'output-uses-conservative-fallback');
    const input = ['text'];
    if (supports.vision === true || supports.image === true
      || (supports.vision === undefined && known?.input?.includes('image'))) input.push('image');
    const { reasoning, thinkingLevelMap, efforts } = reasoningOf(item, known, api);
    const compat = api === known?.api ? { ...known.compat } : {};
    if (api === 'openai-completions') Object.assign(compat, {
      supportsStore: false,
      supportsDeveloperRole: supports.developer_role === true,
      supportsReasoningEffort: efforts.length > 0,
      maxTokensField: compat.maxTokensField ?? 'max_tokens',
    });
    if (policy === 'unconfigured') warnings.push('policy-acceptance-may-be-required');
    const model = {
      ...(known && known.api === api ? known : {}),
      id, name: text(item.name, item.display_name, id), type: 'chat',
      api, provider: 'github-copilot', baseUrl: baseURL,
      headers: { ...COPILOT_HEADERS, ...(known?.headers ?? {}) },
      input, contextWindow, maxTokens,
      cost: known?.cost ?? { ...ZERO_COST },
      reasoning, thinkingLevelMap, compat,
    };
    const detail = {
      id, name: model.name, api, contextWindow, maxTokens,
      maxPromptTokens: positive(limits.max_prompt_tokens) ?? null,
      inputModalities: input, toolCalls: supports.tool_calls !== false,
      parallelToolCalls: supports.parallel_tool_calls === true,
      vision: input.includes('image') ? {
        maxPromptImages: positive(record(limits.vision).max_prompt_images) ?? null,
        maxImageBytes: positive(record(limits.vision).max_prompt_image_size) ?? null,
        supportedMediaTypes: Array.isArray(record(limits.vision).supported_media_types)
          ? record(limits.vision).supported_media_types.filter(value => typeof value === 'string') : [],
      } : null,
      reasoning: reasoning ? { mode: efforts.length ? 'selectable' : 'provider-default', efforts } : { mode: 'none', efforts: [] },
      policy: policy ?? 'unspecified', preview: item.preview === true,
      supportedEndpoints: endpointsOf(item),
      premiumMultiplier: record(item.billing).multiplier ?? null,
      pricing, apiWarningCodes,
      limitsSource: { context: liveContext ? 'live-api' : known ? 'installed-exact-match' : 'fallback',
        output: liveOutput ? 'live-api' : known ? 'installed-exact-match' : 'fallback' },
      warnings,
    };
    models.push(model);
    details.push(detail);
  }
  return { models, details, excluded, priceModels, rawCount: raw.data.length };
}

export function advertisedInfo(detail) {
  const suffix = detail.policy === 'unconfigured' ? '；可能需要先在 GitHub 接受模型条款' : '';
  return {
    provider: LIVE_PROVIDER, id: detail.id, name: detail.name,
    inputModalities: [...detail.inputModalities],
    description: `在线目录 · 上下文 ${detail.contextWindow.toLocaleString('en-US')} · 最大输出 ${detail.maxTokens.toLocaleString('en-US')} · ${detail.api} · ${pricingDescription(detail.pricing, 'zh')}${suffix}`,
    badge: detail.policy === 'unconfigured'
      ? { text: { en: 'Policy required', zh: '需确认条款' }, tone: 'warning' }
      : { text: { en: pricingBadge(detail.pricing, 'en'), zh: pricingBadge(detail.pricing, 'zh') }, tone: 'neutral' },
  };
}
