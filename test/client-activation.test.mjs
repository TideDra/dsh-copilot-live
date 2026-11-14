import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { Context, Service } from '@deepseek-ai/cordis';

// Real Cordis dependency checks and the actual Client apply(). No React hooks,
// fake DOM, custom renderer or browser screenshot is used by these tests.
let manifest;
vm.runInNewContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load: value => { manifest = value; } } },
  AbortController, setTimeout, clearTimeout,
});
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: initial => ({ current: initial }),
  Fragment: Symbol('Fragment'),
};
const client = manifest.factory(id => { assert.equal(id, 'react'); return fakeReact; });
async function harness(t) {
  const root = new Context();
  t.after(() => root.fiber.dispose());
  const records = new Map();
  const dictionaries = new Map();
  let requests = 0;
  class Remote extends Service { constructor(ctx) { super(ctx, 'remote'); } }
  class RemoteSettings extends Service {
    constructor(ctx) { super(ctx, 'remote.settings'); }
    async describe() { requests++; return { ok: true, value: { writable: true, namespaces: [] } }; }
    async mutate() { requests++; return { ok: true, value: {} }; }
  }
  class Locale extends Service {
    constructor(ctx) { super(ctx, 'locale'); }
    register(ns, copy) { dictionaries.set(ns, copy); return () => dictionaries.delete(ns); }
    bind() { return key => key; }
    subscribe() { return () => {}; }
    getSnapshot() { return { active: 'zh', revision: 1 }; }
    resolveText(text) { return typeof text === 'string' ? text : text.zh ?? text.en; }
  }
  class Slots extends Service {
    constructor(ctx) { super(ctx, 'slots'); }
    inject(name, callback) { return this.ctx.effect(callback); }
    register(options, component) {
      const slotId = options.key ? `${options.name}:${options.key}` : options.name;
      records.set(slotId, { options, component });
      return () => records.delete(slotId);
    }
  }
  await root.plugin(Remote);
  await root.plugin(RemoteSettings);
  await root.plugin(Locale);
  await root.plugin(Slots);
  return { root, records, dictionaries, requests: () => requests };
}
test('regression: child-only remote.settings injection reproduces the reported silent click boundary error', async t => {
  const h = await harness(t);
  const oldInjection = client.inject.filter(name => name !== 'remote');
  await assert.rejects(async () => {
    await h.root.plugin({ inject: oldInjection, apply: client.apply });
  }, /cannot get property "remote" without inject/);
  assert.equal(h.records.size, 0);
  assert.equal(h.requests(), 0);
});
test('actual repaired Client activation binds both RPC methods and installs its button slot without any save', async t => {
  const h = await harness(t);
  assert(client.inject.includes('remote'));
  assert(client.inject.includes('remote.settings'));
  const fiber = await h.root.plugin({ inject: client.inject, apply: client.apply });
  const entry = h.records.get('settings.models.provider-card:local-copilot-live');
  assert.equal(entry.options.name, 'settings.models.provider-card');
  assert.equal(typeof entry.component, 'function');
  const labelEntry = h.records.get('conversation.input.model.label');
  assert.equal(labelEntry.options.name, 'conversation.input.model.label');
  assert.equal(typeof labelEntry.component, 'function');
  const copilotModel = { id: 'gemini-4-carbon', name: 'Gemini 4 Carbon', badge: { text: { zh: '入 $2.00 / 出 $10.00', en: 'In $2.00 / Out $10.00' }, tone: 'neutral' } };
  assert.equal(labelEntry.component({ provider: { id: 'github-copilot-live', name: 'github-copilot-live' }, model: copilotModel, placement: 'trigger', selected: true }), 'Gemini 4 Carbon');
  assert.equal(labelEntry.component({ provider: { id: 'github-copilot-live', name: 'github-copilot-live' }, model: copilotModel, placement: 'menu', selected: true }), 'Gemini 4 Carbon');
  const optionRendered = labelEntry.component({ provider: { id: 'github-copilot-live', name: 'github-copilot-live' }, model: copilotModel, placement: 'option', selected: false });
  assert.equal(JSON.stringify(optionRendered).includes('入 $2.00 / 出 $10.00'), true);
  const policyModel = { id: 'policy-model', name: 'Policy Model', badge: { text: { zh: '需确认条款', en: 'Policy required' }, tone: 'warning' } };
  assert.equal(JSON.stringify(labelEntry.component({ provider: { id: 'github-copilot-live', name: 'github-copilot-live' }, model: policyModel, placement: 'trigger', selected: true })).includes('需确认条款'), true);
  const otherProviderModel = { id: 'other', name: 'Other Model', badge: { text: { zh: 'Beta', en: 'Beta' }, tone: 'neutral' } };
  assert.equal(JSON.stringify(labelEntry.component({ provider: { id: 'other-provider', name: 'Other' }, model: otherProviderModel, placement: 'trigger', selected: true })).includes('Beta'), true);
  assert.equal(h.dictionaries.get('local-copilot-live').zh.add, '启用 Copilot 实时模型');
  assert.equal(h.requests(), 0, 'activation must never add a provider or read settings by itself');
  await fiber.dispose();
  assert.equal(h.records.size, 0);
  assert.equal(h.dictionaries.size, 0);
  assert.equal(h.requests(), 0);
});
