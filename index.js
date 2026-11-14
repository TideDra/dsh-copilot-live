import z from '@deepseek-ai/schemastery';
import { githubCopilotProvider } from '@earendil-works/pi-ai/providers/github-copilot';
import { createCopilotAuth, COPILOT_RECORD } from './auth.js';
import { LIVE_PROVIDER, LIVE_NAME } from './catalog.js';
import { CatalogController, CatalogError } from './controller.js';
import { CopilotLiveAdapter } from './adapter.js';
import { PRICING_DOCUMENTATION, CREDIT_DOCUMENTATION, priceView } from './pricing.js';

export const name = 'copilot-live-models';
export const SETTINGS_NS = 'local-copilot-live';
export const inject = ['llm', 'credentials'];
export const Config = z.object({
  // Presence is the user's explicit Add operation; installation defaults empty.
  providers: z.dict(z.object({}), z.union([z.const(LIVE_PROVIDER)])).default({}).volatile(),
  refreshIntervalSeconds: z.number().min(30).max(86400).default(300),
  cacheTtlSeconds: z.number().min(5).max(3600).default(60),
  requestTimeoutMs: z.number().min(1000).max(120000).default(20000),
  streamIdleTimeoutMs: z.number().min(1000).max(1800000).default(300000),
  apiVersion: z.string().default('2026-06-01'),
  includeHiddenModels: z.boolean().default(false),
  fallbackContextWindow: z.number().min(1024).max(2000000).default(128000),
  fallbackMaxTokens: z.number().min(1).max(1000000).default(8192),
});
const json = (status, value) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});
const safeMessage = error => error instanceof CatalogError ? error.message : 'Copilot 操作失败，请检查登录和网络。';
const notAdded = '尚未添加实时提供商。请在「设置 → 模型 → 添加模型提供商」选择 github-copilot-live，点击卡片内「启用 Copilot 实时模型」。';

export function apply(ctx, config) {
  const settingsNs = ctx.fiber.entry?.options.id ?? SETTINGS_NS;
  const knownModels = new Map(githubCopilotProvider().getModels().map(model => [model.id, model]));
  let active;
  let pricePreview;
  const retiring = new Set();
  const createController = () => {
    const auth = createCopilotAuth(ctx.credentials);
    const controller = new CatalogController({ auth, config, knownModels,
      changed: () => { if (active?.controller === controller) ctx.emit('llm/models-updated', LIVE_PROVIDER); },
    });
    return { auth, controller };
  };
  const start = () => {
    const { auth, controller } = createController();
    const adapter = new CopilotLiveAdapter({ controller, auth, config,
      prepareHeaders: (request, headers) => ctx.waterfall('llm-pi-ai/request-headers', request, headers, () => headers),
      resolveAttachments: () => ctx.get('attachments'),
      onReplayDegrade: () => ctx.logger.warn('Copilot live: incompatible historical replay safely degraded.'),
    });
    const release = ctx.llm.registerAdapter([LIVE_PROVIDER], adapter);
    const refresh = () => { void controller.refresh().catch(() => {}); };
    const timer = setInterval(refresh, Math.round(config.refreshIntervalSeconds * 1000));
    timer.unref?.();
    refresh();
    let stopped = false;
    return { controller, stop() {
      if (stopped) return Promise.resolve();
      stopped = true;
      release(); clearInterval(timer); controller.dispose();
      return controller.inflight?.catch(() => {}) ?? Promise.resolve();
    } };
  };
  const stop = () => {
    const previous = active;
    active = undefined;
    if (!previous) return;
    const settled = Promise.resolve(previous.stop());
    retiring.add(settled);
    settled.finally(() => retiring.delete(settled)).catch(() => {});
  };
  const reconcile = () => {
    const configured = Object.hasOwn(config.providers.get(), LIVE_PROVIDER);
    if (configured && !active) active = start();
    if (!configured && active) stop();
  };

  ctx.inject(['settings'], settingsCtx => {
    settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber));
  });
  // Directory membership is not adapter activation. This remains addable while
  // no provider config exists and never creates that config on the user's behalf.
  ctx.effect(() => ctx.llm.registerConfigurableProviders([{
    provider: LIVE_PROVIDER, displayName: LIVE_NAME, settingsNs,
    settingsPath: ['providers', LIVE_PROVIDER], declared: false,
    nativeAuth: { env: [], oauth: true },
  }]));
  ctx.effect(() => ctx.llm.registerModelDiscovery(settingsNs, async (request, signal) => {
    if (request.provider !== undefined && request.provider !== LIVE_PROVIDER) throw new Error('Unsupported Copilot provider');
    if (request.apiKey || request.baseURL || request.api) throw new Error('Copilot live uses the existing Copilot account and native endpoint');
    const transient = active ? undefined : createController();
    const controller = active?.controller ?? transient.controller;
    try {
      const snapshot = await controller.refresh(true, signal);
      return snapshot.details.map(model => ({ id: model.id, name: model.name,
        contextWindow: model.contextWindow, maxTokens: model.maxTokens, inputModalities: model.inputModalities }));
    } finally { transient?.controller.dispose(); }
  }));
  ctx.effect(() => {
    reconcile();
    return async () => {
      stop();
      pricePreview?.controller.dispose();
      await Promise.all([...retiring, pricePreview?.controller.inflight?.catch(() => {})]);
    };
  });
  // Public Loader event; volatile refs have already committed before dispatch.
  ctx.on('loader/volatile-update', reconcile);
  ctx.on('credentials/record-updated', key => {
    if (key !== COPILOT_RECORD) return;
    void active?.controller.credentialsChanged().catch(() => {});
    // Inactive price previews only invalidate identity; they never start a poll.
    void pricePreview?.controller.reconcileIdentity().catch(() => {});
  });
  const status = () => active ? { configured: true, ...active.controller.status() } : {
    configured: false, state: 'not-added', source: null, modelCount: 0, rawModelCount: 0,
    models: [], excluded: [], refreshing: false, lastSuccessfulAt: null, stale: false, error: null,
  };
  const readPrices = async (signal, force = false) => {
    if (!active && !pricePreview) pricePreview = createController();
    const controller = active?.controller ?? pricePreview.controller;
    const snapshot = await controller.refresh(force, signal);
    const current = controller.status();
    return {
      configured: !!active, source: `${snapshot.baseURL}/models`,
      fetchedAt: new Date(snapshot.fetchedAt).toISOString(), stale: current.stale,
      error: current.error, currency: 'USD', perTokens: 1000000, creditsPerUSD: 100,
      documentationURL: PRICING_DOCUMENTATION, creditDocumentationURL: CREDIT_DOCUMENTATION,
      models: (snapshot.priceModels ?? snapshot.details).filter(model => model.selectable !== false).map(priceView),
    };
  };
  ctx.inject(['connection'], connected => {
    connected.effect(() => connected.connection.fetch.register({
      path: '/api/copilot-live/prices', methods: ['GET'], requestBody: 'buffered',
      fetch: async request => {
        try {
          const force = new URL(request.url).searchParams.get('refresh') === '1';
          return json(200, { ok: true, value: await readPrices(request.signal, force) });
        } catch (error) { return json(502, { ok: false, error: safeMessage(error) }); }
      },
    }));
    connected.effect(() => connected.connection.fetch.register({
      path: '/api/copilot-live/status', methods: ['GET'], requestBody: 'buffered',
      fetch: async request => {
        const registeredModels = active ? await ctx.llm.listModels(LIVE_PROVIDER) : [];
        const requestedModel = new URL(request.url).searchParams.get('model');
        let resolvedModel = null;
        if (active && requestedModel && requestedModel.length <= 256) {
          try { resolvedModel = await ctx.llm.resolveModelInfo(LIVE_PROVIDER, requestedModel, request.signal); }
          catch { return json(404, { ok: false, error: '该模型不在当前账号可用目录中。', value: status() }); }
        }
        return json(200, { ok: true, value: { ...status(),
          provider: ctx.llm.listProviders().find(provider => provider.id === LIVE_PROVIDER) ?? null,
          registeredModels, resolvedModel } });
      },
    }));
    connected.effect(() => connected.connection.fetch.register({
      path: '/api/copilot-live/refresh', methods: ['POST'], requestBody: 'buffered',
      fetch: async request => {
        if (!active) return json(409, { ok: false, error: notAdded, value: status() });
        try { await active.controller.refresh(true, request.signal); return json(200, { ok: true, value: status() }); }
        catch (error) { return json(502, { ok: false, error: safeMessage(error), value: status() }); }
      },
    }));
  });
}
