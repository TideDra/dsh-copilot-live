import { LlmAdapter, LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { githubCopilotProvider } from '@earendil-works/pi-ai/providers/github-copilot';
import { LIVE_PROVIDER, LIVE_NAME, advertisedInfo } from './catalog.js';
import { NATIVE_PROVIDER } from './auth.js';
import { geminiSignatureOptions, wrapGeminiStream } from './gemini-signatures.js';

/** Route rebasing is request-local. Durable content and the opaque replay blocks
 * are never rewritten in the Session; signatures still reach the exact model. */
export function rebaseReplay(replay, from, to) {
  if (replay?.response?.kind !== 'pi-ai' || replay.response.provider !== from) return replay;
  return { ...replay, response: { ...replay.response, provider: to } };
}
export function nativeOptions(options) {
  return {
    ...options, provider: NATIVE_PROVIDER,
    messages: options.messages.map(message => {
      if (message.role !== 'assistant' || message.source?.provider !== LIVE_PROVIDER) return message;
      return { ...message, source: { ...message.source, provider: NATIVE_PROVIDER,
        ...(message.source.replayState === undefined ? {} : { replayState: rebaseReplay(message.source.replayState, LIVE_PROVIDER, NATIVE_PROVIDER) }) } };
    }),
  };
}
export async function* externalChunks(chunks) {
  for await (const chunk of chunks) {
    yield chunk.type === 'finish' && chunk.replayState
      ? { ...chunk, replayState: rebaseReplay(chunk.replayState, NATIVE_PROVIDER, LIVE_PROVIDER) } : chunk;
  }
}

export class CopilotLiveAdapter extends LlmAdapter {
  constructor({ controller, auth, config, prepareHeaders, resolveAttachments, onReplayDegrade }) {
    super(); this.controller = controller; this.auth = auth; this.config = config;
    this.prepareHeaders = prepareHeaders; this.resolveAttachments = resolveAttachments;
    this.onReplayDegrade = onReplayDegrade;
    this.retryPolicy = resolveRetryPolicy(undefined, 'copilot-live');
    this.delegates = new WeakMap();
  }
  providerInfo() { return { id: LIVE_PROVIDER, name: LIVE_NAME }; }
  providerRetryPolicy() { return this.retryPolicy; }
  assertProvider(provider) {
    if (provider !== LIVE_PROVIDER) throw new LlmError('Copilot live does not own this route', 'NO_ADAPTER');
  }
  async listModels(provider) {
    this.assertProvider(provider);
    try { return (await this.controller.refresh()).details.map(advertisedInfo); }
    catch { return []; } // Catalog failures are visible through /api/copilot-live/status.
  }
  async snapshotFor(provider, model, signal) {
    this.assertProvider(provider);
    let snapshot;
    try { snapshot = await this.controller.refresh(false, signal); }
    catch (error) { throw new LlmError(error.message, error.code ?? 'CATALOG_UNAVAILABLE'); }
    const detail = snapshot.details.find(item => item.id === model);
    if (!detail) throw new LlmError(`Copilot 在线目录未提供模型 "${model}"；请刷新目录并检查账号/组织策略。`, 'UNKNOWN_MODEL');
    return { snapshot, detail };
  }
  delegateFor(snapshot, detail) {
    let cache = this.delegates.get(snapshot);
    if (!cache) { cache = new Map(); this.delegates.set(snapshot, cache); }
    if (cache.has(detail.id)) return cache.get(detail.id);
    const base = githubCopilotProvider();
    const stream = (method, model, context, options) => {
      if (model.api !== 'openai-completions' || !/^gemini-/i.test(model.id)) return base[method](model, context, options);
      const signature = geminiSignatureOptions(context, options);
      return wrapGeminiStream(base[method](model, context, signature.options), signature.incoming, model);
    };
    // Native Copilot remains the transport identity so X-Initiator, vision,
    // mixed protocols, OAuth refresh and provider serialization stay native.
    const piProvider = {
      id: NATIVE_PROVIDER, name: LIVE_NAME, baseUrl: snapshot.baseURL, auth: base.auth,
      getModels: () => snapshot.models,
      stream: (model, context, options) => stream('stream', model, context, options),
      streamSimple: (model, context, options) => stream('streamSimple', model, context, options),
    };
    const maxRequestImages = detail.vision?.maxPromptImages ?? 10;
    const profile = {
      provider: NATIVE_PROVIDER, displayName: LIVE_NAME, piProvider,
      modelErrors: new Map(), configuredMaxTokens: new Map([[detail.id, detail.maxTokens]]),
      streamIdleTimeoutMs: this.config.streamIdleTimeoutMs,
      maxRequestImageBytes: 20 * 1024 * 1024,
      maxRequestImages, imageOffloadCountQuantum: Math.min(10, maxRequestImages),
      requestImagePixelBudget: 2000 * 2000,
      requestImageMaxBytes: Math.min(1024 * 1024, detail.vision?.maxImageBytes ?? 1024 * 1024),
      retryPolicy: this.retryPolicy,
      headers: { 'X-GitHub-Api-Version': this.config.apiVersion },
    };
    const profiles = new Map([[NATIVE_PROVIDER, profile]]);
    const delegate = new PiAiAdapter({
      profiles: () => profiles, resolveApiKey: async () => undefined, auth: this.auth.injection,
      prepareHeaders: (request, headers) => this.prepareHeaders?.({ ...request, provider: LIVE_PROVIDER }, headers) ?? headers,
      resolveAttachments: this.resolveAttachments, onReplayDegrade: this.onReplayDegrade,
    });
    cache.set(detail.id, delegate);
    return delegate;
  }
  externalInfo(info, detail) {
    const { reasoning, ...rest } = info;
    return { ...rest, ...advertisedInfo(detail),
      ...(detail.reasoning.efforts.length ? { reasoning: { efforts: detail.reasoning.efforts.map(id => ({ id,
        name: id === 'off' ? 'Off' : `${id.charAt(0).toUpperCase()}${id.slice(1)}` })) } } : {}),
    };
  }
  async resolveModel(provider, model, signal) {
    const { snapshot, detail } = await this.snapshotFor(provider, model, signal);
    return this.externalInfo(await this.delegateFor(snapshot, detail).resolveModel(NATIVE_PROVIDER, model, signal), detail);
  }
  async prepareCall(provider, model, signal) {
    const { snapshot, detail } = await this.snapshotFor(provider, model, signal);
    const prepared = await this.delegateFor(snapshot, detail).prepareCall(NATIVE_PROVIDER, model, signal);
    return {
      model: this.externalInfo(prepared.model, detail),
      stream: options => {
        if (options.maxTokens !== undefined && options.maxTokens > detail.maxTokens) {
          throw new LlmError(`模型 "${model}" 最大输出为 ${detail.maxTokens} tokens。`, 'UNSUPPORTED_OPTION');
        }
        return externalChunks(prepared.stream(nativeOptions(options)));
      },
    };
  }
  imageRequestTarget(provider, model, image) {
    this.assertProvider(provider);
    const snapshot = this.controller.snapshot;
    const detail = snapshot?.details.find(item => item.id === model);
    if (!detail) return super.imageRequestTarget(provider, model, image);
    return this.delegateFor(snapshot, detail).imageRequestTarget(NATIVE_PROVIDER, model, image);
  }
  async *stream(options) {
    const prepared = await this.prepareCall(options.provider, options.model, options.signal);
    yield* prepared.stream(options);
  }
}
