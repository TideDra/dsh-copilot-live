window.__ModuleLoader__.load({
  id: '@local/dsh-copilot-live',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'local-copilot-live';
    const ROUTE = 'github-copilot-live';

    // Resolve every runtime accessor inside the guarded operation. The old
    // click handler evaluated ctx.remote.settings before reaching this try.
    async function addProvider(remoteOrResolve, provider, options = {}) {
      try {
        if (options.signal?.aborted) return { ok: false, key: 'timedOut' };
        if (provider.provider !== ROUTE || provider.settingsNs !== NS
            || JSON.stringify(provider.settingsPath) !== JSON.stringify(['providers', ROUTE])) {
          return { ok: false, key: 'unavailable' };
        }
        const remote = typeof remoteOrResolve === 'function' ? remoteOrResolve() : remoteOrResolve;
        const described = await remote.describe();
        if (!described.ok) return { ok: false, message: described.error.message };
        if (!described.value.writable) return { ok: false, key: 'readOnly' };
        const view = described.value.namespaces.find(candidate => candidate.ns === provider.settingsNs);
        if (!view) return { ok: false, key: 'unavailable' };
        if (Object.hasOwn(view.value?.providers ?? {}, ROUTE)) return { ok: true };
        if (options.signal?.aborted) return { ok: false, key: 'timedOut' };
        const written = await remote.mutate(provider.settingsNs, [{
          op: 'set', path: [...provider.settingsPath], value: {},
        }], view.revision);
        return written.ok ? { ok: true } : { ok: false, message: written.error.message };
      } catch { return { ok: false, key: 'failed' }; }
    }

    // One bounded, deduplicated operation for the actual click entry point.
    // Timing out does not claim that a possibly already-admitted write rolled
    // back; the user must refresh and inspect Host state before retrying.
    function createAddOperation(remoteOrResolve, options = {}) {
      const schedule = options.schedule ?? setTimeout;
      const cancel = options.cancel ?? clearTimeout;
      const timeoutMs = options.timeoutMs ?? 20000;
      let pending;
      let stopPending;
      let closed = false;
      return {
        dispose() { closed = true; stopPending?.(); },
        run(provider) {
          if (closed) return Promise.resolve({ ok: false, key: 'unavailable' });
          if (pending) return pending;
          let timer;
          const cancellation = new AbortController();
          const work = Promise.resolve().then(() => addProvider(remoteOrResolve, provider, { signal: cancellation.signal }));
          const deadline = new Promise(resolve => {
            const stop = key => { cancel(timer); cancellation.abort(); resolve({ ok: false, key }); };
            stopPending = () => stop('unavailable');
            timer = schedule(() => stop('timedOut'), timeoutMs);
          });
          const request = Promise.race([work, deadline]).catch(() => ({ ok: false, key: 'failed' }));
          pending = request.finally(() => {
            cancel(timer);
            if (pending === settled) { pending = undefined; stopPending = undefined; }
          });
          const settled = pending;
          return settled;
        },
      };
    }
    async function fetchPrices(fetchImpl, options = {}) {
      try {
        const response = await fetchImpl(`/api/copilot-live/prices${options.force ? '?refresh=1' : ''}`, {
          method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: options.signal,
        });
        const result = await response.json();
        if (!response.ok || !result.ok) return { ok: false, message: typeof result.error === 'string' ? result.error : undefined, key: 'priceFailed' };
        if (!result.value || !Array.isArray(result.value.models)) return { ok: false, key: 'priceFailed' };
        return { ok: true, value: result.value };
      } catch {
        return { ok: false, key: options.signal?.reason === 'price-timeout' ? 'priceTimedOut' : 'priceFailed' };
      }
    }
    return {
      inject: ['slots', 'locale', 'remote', 'remote.settings'],
      addProvider,
      createAddOperation,
      fetchPrices,
      apply(ctx) {
        // Capture owned services during apply, not during a React event. This
        // matches the native page's apply-world operation boundary.
        const locale = ctx.locale;
        const settings = ctx.remote.settings;
        const remote = {
          describe: settings.describe.bind(settings),
          mutate: settings.mutate.bind(settings),
        };
        const operation = createAddOperation(remote);
        ctx.effect(() => () => operation.dispose());
        ctx.effect(() => locale.register(NS, {
          zh: {
            add: '启用 Copilot 实时模型', adding: '正在启用…', added: '已启用，模型选择器现在可以使用 github-copilot-live。',
            explanation: '复用已有 GitHub Copilot 登录，无需填写 API 地址或密钥。请点下方“启用 Copilot 实时模型”按钮；上方灰色“保存”不是本插件的操作入口。',
            active: '此入口已手动启用；模型与参数自动同步。可使用本行的“移除”按钮删除，不影响 Copilot 登录。',
            close: '可点上方“取消”关闭添加面板，这不会撤销此处已完成的保存。',
            failed: '未能完成启用请求，请检查连接后重试；若仍失败，请提供此处的错误提示。',
            timedOut: '启用请求超时，结果尚未确认。请先刷新模型设置检查是否已添加，再决定是否重试。',
            readOnly: '当前设置不可写，未添加提供商。', unavailable: '实时提供商配置尚未就绪，请刷新页面。',
            priceTitle: 'Copilot 模型价格', priceShow: '查看各模型价格', priceHide: '收起价格', priceRefresh: '刷新价格',
            priceLoading: '正在读取官方目录报价…', priceFailed: '无法读取价格，请检查 Copilot 登录与网络后重试。',
            priceTimedOut: '读取价格超时，请重试。', priceEmpty: '当前账号目录没有返回可选聊天模型。',
            priceUnit: 'USD 等值 / 每百万 tokens（1 AI credit = $0.01）', priceModel: '模型 / 价格档',
            priceInput: '输入', priceOutput: '输出', priceCacheRead: '缓存读', priceCacheWrite: '缓存写',
            priceDefault: '默认档', priceLong: '长上下文档', priceMissing: '—', priceUnknown: '接口未提供完整价格',
            priceLegacy: '旧制高级请求倍率 ×{n}（不是 token 单价）',
            priceUpper: '输入 ≤ {max} tokens', priceLower: '输入 > {min} tokens', priceRange: '输入 > {min} 且 ≤ {max} tokens',
            priceFetched: '报价获取于：', priceStale: '当前显示上次成功缓存，可能已过期。',
            priceInvalid: '部分价格字段或计价批次缺失，未猜测为免费；— 表示未知。',
            priceServerWarning: 'GitHub 返回了客户端版本/计费提示；此处展示当前 API 原值换算，请结合官方价格页核对。',
            priceFootnote: '这是账号 API 当前标价，不是最终账单；套餐额度、促销、缓存、上下文档位及折扣仍会影响计费。API 与网页可能存在取整或促销差异，不按网页偷偷覆盖接口值。查看价格不会添加或切换提供商。',
            priceDocs: '官方模型价格表', priceCredits: 'AI credits 计费说明',
          },
          en: {
            add: 'Enable Copilot live models', adding: 'Enabling…', added: 'Enabled. github-copilot-live is now available in the model selector.',
            explanation: 'Reuses the existing Copilot sign-in; no API URL or key is required. Use Enable Copilot live models below, not the disabled native Save button above.',
            active: 'Manually enabled. Models and capabilities sync automatically. Remove this row to deactivate it without signing out of Copilot.',
            close: 'Use Cancel above to close the add panel; it will not undo this completed save.',
            failed: 'Could not complete the request. Check the connection and retry; report this message if it persists.',
            timedOut: 'The request timed out and its result is unconfirmed. Refresh Models settings to check whether the provider was added before retrying.',
            readOnly: 'Settings are read-only. The provider was not added.', unavailable: 'Live provider settings are unavailable. Refresh the page.',
            priceTitle: 'Copilot model prices', priceShow: 'View model prices', priceHide: 'Hide prices', priceRefresh: 'Refresh prices',
            priceLoading: 'Reading prices from the official catalog…', priceFailed: 'Could not load prices. Check Copilot sign-in and the connection.',
            priceTimedOut: 'The price request timed out. Retry.', priceEmpty: 'The account catalog returned no selectable chat models.',
            priceUnit: 'USD equivalent per 1 million tokens (1 AI credit = $0.01)', priceModel: 'Model / pricing tier',
            priceInput: 'Input', priceOutput: 'Output', priceCacheRead: 'Cached input', priceCacheWrite: 'Cache write',
            priceDefault: 'Default', priceLong: 'Long context', priceMissing: '—', priceUnknown: 'The API did not supply a complete price',
            priceLegacy: 'Legacy premium request multiplier ×{n} (not a token rate)',
            priceUpper: 'Input ≤ {max} tokens', priceLower: 'Input > {min} tokens', priceRange: 'Input > {min} and ≤ {max} tokens',
            priceFetched: 'Fetched at: ', priceStale: 'Showing the last successful cache; prices may be stale.',
            priceInvalid: 'Some price fields or the token batch size are missing. — means unknown, not free.',
            priceServerWarning: 'GitHub returned a client-version/billing notice. These values reflect the current API; cross-check the official price page.',
            priceFootnote: 'Current account API list prices, not an invoice. Allowances, promotions, caching, context tiers and discounts still affect billing. API rounding or promotional prices may differ from the website; API values are not silently replaced. Viewing prices never adds or switches a provider.',
            priceDocs: 'Official model prices', priceCredits: 'AI credits billing',
          },
        }));
        const t = locale.bind(NS);
        const subscribe = callback => locale.subscribe(callback);
        const snapshot = () => locale.getSnapshot();
        const pricingDocs = 'https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing';
        const creditDocs = 'https://docs.github.com/en/copilot/concepts/billing-and-usage/individuals/billing';
        const smallButton = { padding: '5px 10px', borderRadius: 6, font: 'inherit', cursor: 'pointer',
          border: '1px solid var(--dsw-alias-border-l1)', color: 'var(--dsw-alias-label-primary)',
          background: 'var(--dsw-alias-bg-layer-2)' };
        function PricePanel({ configured }) {
          const [open, setOpen] = React.useState(() => configured);
          const [revision, setRevision] = React.useState(0);
          const [loading, setLoading] = React.useState(false);
          const [data, setData] = React.useState(null);
          const [error, setError] = React.useState(null);
          React.useEffect(() => {
            if (!open) return;
            const controller = new AbortController();
            let alive = true;
            const timer = setTimeout(() => controller.abort('price-timeout'), 25000);
            setLoading(true); setError(null);
            void fetchPrices((...args) => globalThis.fetch(...args), { force: revision > 0, signal: controller.signal }).then(result => {
              if (!alive) return;
              if (result.ok) setData(result.value);
              else setError(result.message ?? t(result.key));
            }).finally(() => { clearTimeout(timer); if (alive) setLoading(false); });
            return () => { alive = false; clearTimeout(timer); controller.abort('view-closed'); };
          }, [open, revision]);
          const number = value => new Intl.NumberFormat('en-US').format(value);
          const context = tier => {
            if (tier.contextMinExclusive !== null && tier.contextMax !== null) return t('priceRange').replace('{min}', number(tier.contextMinExclusive)).replace('{max}', number(tier.contextMax));
            if (tier.contextMinExclusive !== null) return t('priceLower').replace('{min}', number(tier.contextMinExclusive));
            if (tier.contextMax !== null) return t('priceUpper').replace('{max}', number(tier.contextMax));
            return '';
          };
          const cell = { padding: '8px 7px', borderBottom: '1px solid var(--dsw-alias-border-l1)', verticalAlign: 'top', textAlign: 'left' };
          const caption = { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: '18px' };
          const rows = [];
          for (const model of (data?.models ?? []).filter(item => item.selectable !== false)) {
            const identity = tier => h('td', { style: { ...cell, minWidth: 180, maxWidth: 230, overflowWrap: 'anywhere' } },
              h('div', null, model.name),
              h('div', { style: caption }, model.id),
              tier ? h('div', { style: caption }, `${t(tier.id === 'long_context' ? 'priceLong' : 'priceDefault')} ${context(tier)}`) : null);
            if (model.pricing?.kind === 'tokens' && model.displayTiers?.length) {
              for (const tier of model.displayTiers) rows.push(h('tr', { key: `${model.id}:${tier.id}` }, identity(tier),
                ...['input', 'output', 'cacheRead', 'cacheWrite'].map(field => h('td', { key: field, style: { ...cell, whiteSpace: 'nowrap' } }, tier.prices[field] ?? t('priceMissing')))));
            } else rows.push(h('tr', { key: model.id }, identity(null), h('td', { colSpan: 4, style: cell },
              model.pricing?.kind === 'legacy-requests' ? t('priceLegacy').replace('{n}', String(model.pricing.legacyMultiplier)) : t('priceUnknown'))));
          }
          return h('section', { 'data-copilot-live-prices': true, style: { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 } },
            h('div', { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 } },
              h('strong', null, t('priceTitle')),
              h('button', { type: 'button', style: smallButton, 'aria-expanded': open, onClick: () => setOpen(value => !value) }, t(open ? 'priceHide' : 'priceShow')),
              open ? h('button', { type: 'button', style: smallButton, disabled: loading, onClick: () => setRevision(value => value + 1) }, t('priceRefresh')) : null),
            !open ? null : h(React.Fragment, null,
              h('p', { style: caption }, t('priceUnit')),
              loading ? h('p', { role: 'status', style: caption }, t('priceLoading')) : null,
              error ? h('p', { role: 'alert', style: { ...caption, color: 'var(--dsw-alias-state-error-primary)' } }, error) : null,
              data?.stale ? h('p', { role: 'status', style: caption }, t('priceStale')) : null,
              data?.fetchedAt ? h('p', { style: caption }, `${t('priceFetched')}${new Date(data.fetchedAt).toLocaleString()}`) : null,
              rows.length ? h('div', { tabIndex: 0, 'aria-label': t('priceTitle'), style: { maxHeight: 380, overflow: 'auto', maxWidth: '100%' } },
                h('table', { style: { width: '100%', minWidth: 600, borderCollapse: 'collapse', fontSize: 12, lineHeight: '18px' } },
                  h('thead', null, h('tr', null, ...['priceModel', 'priceInput', 'priceOutput', 'priceCacheRead', 'priceCacheWrite'].map(key => h('th', { key, scope: 'col', style: { ...cell, whiteSpace: 'nowrap', fontWeight: 600 } }, t(key))))),
                  h('tbody', null, ...rows))) : data && !loading ? h('p', { style: caption }, t('priceEmpty')) : null,
              data?.models.some(model => model.pricing?.warnings?.length) ? h('p', { style: caption }, t('priceInvalid')) : null,
              data?.models.some(model => model.apiWarningCodes?.includes('client_version_deprecated')) ? h('p', { style: caption }, t('priceServerWarning')) : null,
              h('p', { style: caption }, t('priceFootnote')),
              h('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap' } },
                h('a', { href: pricingDocs, target: '_blank', rel: 'noopener noreferrer', style: { color: 'var(--dsw-alias-brand-primary)' } }, t('priceDocs')),
                h('a', { href: creditDocs, target: '_blank', rel: 'noopener noreferrer', style: { color: 'var(--dsw-alias-brand-primary)' } }, t('priceCredits')))));
        }
        function ProviderCard(props) {
          React.useSyncExternalStore(subscribe, snapshot, snapshot);
          const [busy, setBusy] = React.useState(false);
          const [failure, setFailure] = React.useState(null);
          const [saved, setSaved] = React.useState(false);
          const alive = React.useRef(true);
          const submitting = React.useRef(false);
          React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
          if (props.provider.provider !== ROUTE) return null;
          const add = async () => {
            if (submitting.current) return;
            submitting.current = true;
            setBusy(true); setFailure(null);
            try {
              const result = await operation.run(props.provider);
              if (!alive.current) return;
              if (result.ok) setSaved(true);
              else setFailure(result.message ?? t(result.key));
            } catch {
              if (alive.current) setFailure(t('failed'));
            } finally {
              submitting.current = false;
              if (alive.current) setBusy(false);
            }
          };
          return h('div', { 'data-copilot-live-card': true, style: {
            display: 'flex', flexDirection: 'column', gap: 8, padding: 12, borderRadius: 8,
            border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)',
            color: 'var(--dsw-alias-label-primary)', fontSize: 13, lineHeight: '20px',
          } },
          h('p', { style: { margin: 0, color: 'var(--dsw-alias-label-secondary)' } }, t(props.configured ? 'active' : 'explanation')),
          !props.configured && !saved ? h('button', { type: 'button', name: 'copilot-live-enable',
            'data-copilot-live-action': 'enable', 'aria-label': t('add'), disabled: busy, 'aria-busy': busy,
            onClick: () => { void add(); }, style: { alignSelf: 'flex-start', padding: '7px 14px', borderRadius: 6,
              border: 'none', background: 'var(--dsw-alias-label-primary)',
              color: 'var(--dsw-alias-bg-base)', font: 'inherit', cursor: busy ? 'default' : 'pointer',
              opacity: busy ? 0.6 : 1,
            } }, t(busy ? 'adding' : 'add')) : null,
          saved ? h('p', { role: 'status', style: { margin: 0, color: 'var(--dsw-alias-state-success-primary)' } }, `${t('added')} ${t('close')}`) : null,
          failure ? h('p', { role: 'alert', style: { margin: 0, color: 'var(--dsw-alias-state-error-primary)' } }, failure) : null,
          h(PricePanel, { configured: props.configured }));
        }
        function badgeStyle(tone) {
          const base = {
            flex: 'none', display: 'inline-flex', alignItems: 'center', borderRadius: 999,
            padding: '1px 8px', fontSize: 11, lineHeight: '17px', fontWeight: 500, whiteSpace: 'nowrap',
          };
          if (tone === 'warning') return { ...base, background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent)', color: 'var(--dsw-alias-state-warn-primary)' };
          if (tone === 'success') return { ...base, background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent)', color: 'var(--dsw-alias-state-success-primary)' };
          if (tone === 'info') return { ...base, background: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent)', color: 'var(--dsw-alias-brand-primary)' };
          return { ...base, background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)' };
        }
        function resolveBadgeText(text) {
          if (typeof locale.resolveText === 'function') return locale.resolveText(text);
          if (typeof text === 'string') return text;
          const active = locale.getSnapshot?.()?.active ?? 'en';
          return text?.[active] ?? text?.[active.split('-')[0]] ?? text?.en ?? '';
        }
        function ModelLabel(props) {
          React.useSyncExternalStore(subscribe, snapshot, snapshot);
          const { provider, model, placement } = props;
          const badge = model?.badge;
          // Once a Copilot live model is selected, hide its neutral price badge in
          // the trigger and root menu; keep badges on option rows and other providers.
          if (!badge || (provider?.id === ROUTE && placement !== 'option' && badge.tone === 'neutral')) {
            return model?.name ?? '';
          }
          const badgeEl = h('span', { style: badgeStyle(badge.tone) }, resolveBadgeText(badge.text));
          const nameEl = h('span', { style: { textOverflow: 'ellipsis', minWidth: 0, overflow: 'hidden' } }, model.name);
          return h('span', { style: { verticalAlign: 'baseline', whiteSpace: 'nowrap', alignItems: 'center', gap: 4, maxWidth: '100%', display: 'inline-flex' } },
            placement === 'trigger' ? badgeEl : null,
            placement === 'trigger' ? ' ' : null,
            nameEl,
            placement === 'trigger' ? null : ' ',
            placement === 'trigger' ? null : badgeEl);
        }
        ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
          name: 'settings.models.provider-card', key: NS,
        }, ProviderCard));
        ctx.slots.inject('conversation.input.model.label', () => ctx.slots.register({
          name: 'conversation.input.model.label',
        }, ModelLabel));
      },
    };
  },
});
