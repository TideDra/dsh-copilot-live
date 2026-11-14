import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { Context, Service } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import * as plugin from '../index.js';
import { LIVE_PROVIDER } from '../catalog.js';
import { COPILOT_RECORD } from '../auth.js';

async function harness() {
  const root = new Context();
  const commands = new Map();
  const routes = new Map();
  let reads = 0;
  class Credentials extends Service {
    constructor(ctx) { super(ctx, 'credentials'); }
    async readRecord() { reads++; return undefined; }
    async resolve() { reads++; return undefined; }
    async describeRecord() { return { configured: false, writable: true }; }
  }
  class Commands extends Service {
    constructor(ctx) { super(ctx, 'commands'); }
    register(definition) { commands.set(definition.name, definition); return () => commands.delete(definition.name); }
  }
  class Connection extends Service {
    constructor(ctx) { super(ctx, 'connection'); this.fetch = { register: definition => {
      routes.set(definition.path, definition); return async () => { routes.delete(definition.path); };
    } }; }
  }
  await root.plugin(Credentials);
  await root.plugin(LlmRuntime);
  await root.plugin(Commands);
  await root.plugin(Connection);
  let providers = {};
  let bound;
  const config = { ...plugin.Config({}), providers: { get: () => providers } };
  const fiber = await root.plugin({ inject: plugin.inject, apply(ctx) { bound = ctx; plugin.apply(ctx, config); } });
  return { root, fiber, commands, routes, reads: () => reads,
    configure(next) { providers = next; bound.emit('loader/volatile-update', [['providers']]); },
    async dispose() { await root.fiber.dispose(); },
  };
}

test('schema and shipped patch install with no manually added provider', async () => {
  assert.deepEqual(plugin.Config({}).providers.get(), {});
  assert.throws(() => plugin.Config({ providers: { 'unexpected-route': {} } }));
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  assert.match(patch, /providers: \{\}/);
  assert.doesNotMatch(patch, /github-copilot-live:\s*\{/);
});
test('dormant plugin declares the native Add candidate without registering a route or reading credentials', async () => {
  const h = await harness();
  try {
    assert(!h.root.llm.listProviders().some(provider => provider.id === LIVE_PROVIDER));
    const directory = h.root.llm.listConfigurableProviders().find(provider => provider.provider === LIVE_PROVIDER);
    assert.equal(directory.displayName, 'github-copilot-live');
    assert.equal(directory.settingsNs, plugin.SETTINGS_NS);
    assert.deepEqual(directory.settingsPath, ['providers', LIVE_PROVIDER]);
    assert.deepEqual(directory.nativeAuth, { env: [], oauth: true });
    assert.equal(h.reads(), 0);
    const status = await h.routes.get('/api/copilot-live/status').fetch(new Request('http://test/api/copilot-live/status'));
    const body = await status.json();
    assert.equal(body.value.configured, false);
    assert.equal(body.value.provider, null);
    assert.equal(body.value.state, 'not-added');
    assert.deepEqual(body.value.registeredModels, []);
    assert.equal(h.reads(), 0);
  } finally { await h.dispose(); }
});
test('status and refresh routes cannot silently add a dormant provider, and no slash commands are registered', async () => {
  const h = await harness();
  try {
    assert.equal(h.commands.size, 0, 'plugin must not register any slash commands');
    const statusRes = await h.routes.get('/api/copilot-live/status').fetch(new Request('http://test/api/copilot-live/status'));
    assert.equal((await statusRes.json()).value.configured, false);
    const response = await h.routes.get('/api/copilot-live/refresh').fetch(new Request('http://test/api/copilot-live/refresh', { method: 'POST' }));
    assert.equal(response.status, 409);
    assert.equal(h.reads(), 0);
    assert(!h.root.llm.listProviders().some(provider => provider.id === LIVE_PROVIDER));
  } finally { await h.dispose(); }
});
test('explicit configuration adds the route; native unset removes it and leaves the Add candidate', async () => {
  const h = await harness();
  try {
    for (let cycle = 0; cycle < 3; cycle++) {
      h.configure({ [LIVE_PROVIDER]: {} });
      assert.equal(h.root.llm.listProviders().find(provider => provider.id === LIVE_PROVIDER).name, 'github-copilot-live');
      assert.equal(h.root.llm.listProviders().filter(provider => provider.id === LIVE_PROVIDER).length, 1);
      h.configure({ [LIVE_PROVIDER]: {} });
      assert.equal(h.root.llm.listProviders().filter(provider => provider.id === LIVE_PROVIDER).length, 1);
      h.configure({});
      assert(!h.root.llm.listProviders().some(provider => provider.id === LIVE_PROVIDER));
      assert(h.root.llm.listConfigurableProviders().some(provider => provider.provider === LIVE_PROVIDER));
    }
    const before = h.reads();
    h.root.emit('credentials/record-updated', COPILOT_RECORD);
    assert.equal(h.reads(), before);
  } finally { await h.dispose(); }
});
test('unloading the plugin removes its directory and diagnostic routes', async () => {
  const h = await harness();
  try {
    h.configure({ [LIVE_PROVIDER]: {} });
    assert.equal(h.commands.size, 0);
    await h.fiber.dispose();
    assert(!h.root.llm.listProviders().some(provider => provider.id === LIVE_PROVIDER));
    assert(!h.root.llm.listConfigurableProviders().some(provider => provider.provider === LIVE_PROVIDER));
    assert.equal(h.commands.size, 0);
    assert.equal(h.routes.size, 0);
  } finally { await h.dispose(); }
});

// Unit-test only the public save operation, not a mock DOM or a visual renderer.
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
let definition;
vm.runInNewContext(source, { window: { __ModuleLoader__: { load: value => { definition = value; } } } });
const client = definition.factory(id => { assert.equal(id, 'react'); return {}; });
const provider = { provider: LIVE_PROVIDER, settingsNs: plugin.SETTINGS_NS, settingsPath: ['providers', LIVE_PROVIDER] };
function remoteMock(value = { providers: {} }, writable = true) {
  const writes = [];
  const remote = {
    async describe() { return { ok: true, value: { writable, namespaces: [{ ns: plugin.SETTINGS_NS, value, revision: 27 }] } }; },
    async mutate(ns, ops, revision) { writes.push(JSON.parse(JSON.stringify({ ns, ops, revision }))); return { ok: true, value: {} }; },
  };
  return { remote, writes };
}
test('Client module activation has no settings side effect and uses only React from shared modules', () => {
  assert.equal(definition.id, '@local/dsh-copilot-live');
  assert.equal(typeof client.apply, 'function');
  assert.equal(typeof client.addProvider, 'function');
  assert.doesNotMatch(source, /require\(['"]@deepseek-ai\//);
  assert.doesNotMatch(source, /document\./);
  assert.match(source, /method: 'GET', credentials: 'same-origin'/);
});
test('manual Add and save uses the same revisioned path mutation as native provider configuration', async () => {
  const h = remoteMock();
  assert.equal((await client.addProvider(h.remote, provider)).ok, true);
  assert.deepEqual(h.writes, [{ ns: plugin.SETTINGS_NS, ops: [{ op: 'set', path: ['providers', LIVE_PROVIDER], value: {} }], revision: 27 }]);
});
test('already added, read-only and wrong provider requests do not create or overwrite configuration', async () => {
  const existing = remoteMock({ providers: { [LIVE_PROVIDER]: {} } });
  assert.equal((await client.addProvider(existing.remote, provider)).ok, true);
  assert.equal(existing.writes.length, 0);
  const readOnly = remoteMock({ providers: {} }, false);
  assert.equal((await client.addProvider(readOnly.remote, provider)).key, 'readOnly');
  assert.equal(readOnly.writes.length, 0);
  const wrong = remoteMock();
  assert.equal((await client.addProvider(wrong.remote, { ...provider, settingsNs: 'llm-pi-ai' })).key, 'unavailable');
  assert.equal(wrong.writes.length, 0);
});
test('explicit price preview can read account metadata but never adds a provider, even when sign-in is missing', async () => {
  const h = await harness();
  try {
    assert.equal(h.reads(), 0);
    const response = await h.routes.get('/api/copilot-live/prices').fetch(new Request('http://test/api/copilot-live/prices'));
    assert.equal(response.status, 502);
    assert.equal((await response.json()).ok, false);
    assert(h.reads() > 0, 'only this explicit read starts credential discovery');
    assert(!h.root.llm.listProviders().some(provider => provider.id === LIVE_PROVIDER));
    assert(h.root.llm.listConfigurableProviders().some(provider => provider.provider === LIVE_PROVIDER));
    const status = await h.routes.get('/api/copilot-live/status').fetch(new Request('http://test/api/copilot-live/status'));
    assert.equal((await status.json()).value.configured, false);
  } finally { await h.dispose(); }
});
test('manual save reports Host conflicts and redacts unexpected transport errors', async () => {
  const h = remoteMock();
  h.remote.mutate = async () => ({ ok: false, error: { code: 'settings/conflict', message: 'Revision conflict' } });
  assert.equal((await client.addProvider(h.remote, provider)).message, 'Revision conflict');
  h.remote.describe = async () => { throw new Error('synthetic-sensitive-value'); };
  const result = await client.addProvider(h.remote, provider);
  assert.equal(result.key, 'failed');
  assert(!JSON.stringify(result).includes('synthetic-sensitive-value'));
});
