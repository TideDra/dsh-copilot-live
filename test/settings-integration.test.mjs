import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Context, Service, resolveConfig } from '@deepseek-ai/cordis';
import SettingsForms from '@deepseek-ai/dsh-settings';
import SettingsController from '@deepseek-ai/dsh-api-settings-controller';
import z from '@deepseek-ai/schemastery';
import { Config, SETTINGS_NS } from '../index.js';
import { LIVE_PROVIDER } from '../catalog.js';

// Real Settings projection/path mutation and real API error classification.
// Only the Loader/config-editor persistence boundary is an in-memory adapter.
// No Copilot plugin apply(), credential provider, network request, DOM or React
// is involved. The temporary home is empty and owned by this individual test.
const providerPath = ['providers', LIVE_PROVIDER];
const setProvider = { op: 'set', path: providerPath, value: {} };
const unsetProvider = { op: 'unset', path: providerPath };
const clone = value => structuredClone(value);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function merge(under, over) {
  if (!isRecord(under) || !isRecord(over)) return clone(over);
  const result = clone(under);
  for (const [key, value] of Object.entries(over)) {
    result[key] = Object.hasOwn(result, key) ? merge(result[key], value) : clone(value);
  }
  return result;
}

async function harness(t) {
  const parent = await realpath(tmpdir());
  const home = await mkdtemp(join(parent, 'dsh-copilot-settings-integration-'));
  const owned = await realpath(home);
  assert.equal(dirname(owned), parent);
  assert.ok(basename(owned).startsWith('dsh-copilot-settings-integration-'));
  const root = new Context();
  t.after(async () => {
    try { await root.fiber.dispose(); }
    finally {
      // Verify the exact absolute owned target before deleting even an empty dir.
      assert.equal(await realpath(home), owned);
      assert.equal(dirname(owned), parent);
      assert.ok(basename(owned).startsWith('dsh-copilot-settings-integration-'));
      await rmdir(owned);
    }
  });

  class Profile extends Service {
    constructor(ctx) {
      super(ctx, 'profileContext');
      this.name = 'isolated-settings-integration';
      this.home = owned;
      this.dir = owned;
    }
  }
  class LoaderBoundary extends Service {
    constructor(ctx) { super(ctx, 'loader'); }
    async await() { /* No real loader tree or profile is opened. */ }
  }
  await root.plugin(Profile);
  await root.plugin(LoaderBoundary);

  const inherited = {
    providers: {}, refreshIntervalSeconds: 300, cacheTtlSeconds: 60,
    requestTimeoutMs: 20000, streamIdleTimeoutMs: 300000,
    apiVersion: '2026-06-01', includeHiddenModels: false,
    fallbackContextWindow: 128000, fallbackMaxTokens: 8192,
  };
  let override = { refreshIntervalSeconds: 777, requestTimeoutMs: 12345 };
  let raw = merge(inherited, override);
  const fixture = {
    name: 'copilot-real-settings-config-fixture', Config,
    apply() { /* Validate the real plugin schema without activating Copilot. */ },
  };
  const fiber = await root.plugin(fixture, raw);
  const entry = {
    id: `include:${SETTINGS_NS}`,
    options: { id: SETTINGS_NS, name: '@local/dsh-copilot-live', config: raw },
    fiber,
  };
  const commits = [];
  let queue = Promise.resolve();
  class MemoryConfigEditor extends Service {
    constructor(ctx) {
      super(ctx, 'configEditor');
      this.documentPath = join(owned, 'cordis.patch.yml');
    }
    entries() { return [entry]; }
    configuration() { return [{ entry, inherited: clone(inherited), override: clone(override) }]; }
    edit(target, change) {
      const operation = queue.then(async () => {
        assert.equal(target, entry);
        const next = change(clone(raw), clone(inherited));
        // Same full-schema admission required at the config-editor boundary.
        resolveConfig(fiber.runtime, next);
        await fiber.update(next);
        assert.equal(fiber.state, 2);
        raw = clone(next);
        // This fixture deliberately stores the complete admitted candidate,
        // rather than pretending to test the real editor's YAML layer compaction.
        override = clone(next);
        entry.options.config = clone(next);
        commits.push(clone(next));
      });
      queue = operation.catch(() => {});
      return operation;
    }
  }
  await root.plugin(MemoryConfigEditor);
  await root.plugin(SettingsForms);
  await root.plugin(SettingsController, {
    openTextFile() { throw new Error('Tests must never open a native settings file'); },
  });
  const settings = root.settings;
  const controller = root.settingsController;
  const view = () => controller.describe().namespaces.find(row => row.ns === SETTINGS_NS);
  return {
    root, settings, controller, view, fiber, entry, commits,
    raw: () => clone(raw),
    override: () => clone(override),
  };
}

function assertHasEmptyProfile(value) {
  assert.ok(Object.hasOwn(value.providers, LIVE_PROVIDER), 'explicit empty provider must remain present');
  assert.deepEqual(value.providers[LIVE_PROVIDER], {});
}

test('real Settings/API describe exposes own namespace and live providers, not ordinary fields', async t => {
  const h = await harness(t);
  const described = h.controller.describe();
  assert.equal(described.writable, true);
  const view = h.view();
  assert.equal(view.ns, SETTINGS_NS);
  assert.notEqual(view.ns, h.entry.id, 'wire namespace uses the raw entry id, not include: prefix');
  assert.deepEqual(view.value, { providers: {} });
  // Settings sends Schemastery's { uid, refs } wire form, not a flat node.
  // Rehydrate through the same public constructor used by the real Settings
  // implementation, then inspect the actual editable object/dict structure.
  const form = new z(view.schema);
  assert.equal(form.type, 'object');
  assert.ok(form.dict.providers);
  assert.equal(form.dict.providers.type, 'dict');
  assert.deepEqual(form.dict.providers.meta.default, {});
  assert.equal(form.dict.providers.meta.volatile, undefined, 'wire form strips runtime reference metadata');
  assert.equal(form.dict.refreshIntervalSeconds, undefined);
  assert.equal(view.value.requestTimeoutMs, undefined);
  assert.equal(typeof view.revision, 'number');
  assert.equal(h.commits.length, 0);
});

test('real mutate set of an empty profile survives wire projection, validation and re-read', async t => {
  const h = await harness(t);
  const before = h.view();
  const added = await h.controller.mutate(SETTINGS_NS, [setProvider], before.revision);
  assertHasEmptyProfile(added.value);
  assertHasEmptyProfile(added.user);
  assertHasEmptyProfile(h.raw());
  assertHasEmptyProfile(h.override());
  assert.ok(Object.hasOwn(h.fiber.effectiveConfig.providers.get(), LIVE_PROVIDER));
  assertHasEmptyProfile(h.view().value);
  // JSON storage/transport itself must not collapse this presence marker.
  assertHasEmptyProfile(JSON.parse(JSON.stringify(added.value)));
  assert.ok(added.revision > before.revision);
  assert.equal(h.commits.length, 1);
});

test('real API classifies a stale revision as settings/conflict without committing', async t => {
  const h = await harness(t);
  const stale = h.view().revision;
  const added = await h.controller.mutate(SETTINGS_NS, [setProvider], stale);
  const snapshot = h.raw();
  await assert.rejects(
    h.controller.mutate(SETTINGS_NS, [unsetProvider], stale),
    error => error.code === 'settings/conflict',
  );
  assert.deepEqual(h.raw(), snapshot);
  assert.equal(h.commits.length, 1);
  assert.equal(h.view().revision, added.revision);
  assertHasEmptyProfile(h.view().value);
});

test('real unset removes only the explicit profile and returns to an empty providers dictionary', async t => {
  const h = await harness(t);
  const added = await h.controller.mutate(SETTINGS_NS, [setProvider], h.view().revision);
  const removed = await h.controller.mutate(SETTINGS_NS, [unsetProvider], added.revision);
  assert.deepEqual(removed.value, { providers: {} });
  assert.deepEqual(h.fiber.effectiveConfig.providers.get(), {});
  assert.equal(Object.hasOwn(h.raw().providers, LIVE_PROVIDER), false);
  assert.deepEqual(removed.base, { providers: {} });
  assert.ok(removed.revision > added.revision);
});

test('ordinary configuration survives real add/remove path writes unchanged', async t => {
  const h = await harness(t);
  const ordinaryBefore = h.raw();
  delete ordinaryBefore.providers;
  const added = await h.controller.mutate(SETTINGS_NS, [setProvider], h.view().revision);
  await h.controller.mutate(SETTINGS_NS, [unsetProvider], added.revision);
  const ordinaryAfter = h.raw();
  delete ordinaryAfter.providers;
  assert.deepEqual(ordinaryAfter, ordinaryBefore);
  assert.equal(ordinaryAfter.refreshIntervalSeconds, 777);
  assert.equal(ordinaryAfter.requestTimeoutMs, 12345);
});

test('real Settings replace also preserves ordinary configuration while resetting live providers', async t => {
  const h = await harness(t);
  const ordinaryBefore = h.raw();
  delete ordinaryBefore.providers;
  const added = await h.controller.replace(SETTINGS_NS, { providers: { [LIVE_PROVIDER]: {} } }, h.view().revision);
  assertHasEmptyProfile(added.value);
  const removed = await h.controller.replace(SETTINGS_NS, {}, added.revision);
  assert.deepEqual(removed.value, { providers: {} });
  const ordinaryAfter = h.raw();
  delete ordinaryAfter.providers;
  assert.deepEqual(ordinaryAfter, ordinaryBefore);
});

test('real API rejects writes to nonvolatile ordinary settings without changing configuration', async t => {
  const h = await harness(t);
  const before = h.raw();
  await assert.rejects(
    h.controller.mutate(SETTINGS_NS, [{ op: 'set', path: ['refreshIntervalSeconds'], value: 888 }], h.view().revision),
    error => error.code === 'settings/rejected' && error.message.includes('not volatile'),
  );
  assert.deepEqual(h.raw(), before);
  assert.equal(h.commits.length, 0);
});

test('real full-schema admission rejects an unknown provider key without persisting it', async t => {
  const h = await harness(t);
  const before = h.raw();
  await assert.rejects(
    h.controller.mutate(SETTINGS_NS, [{ op: 'set', path: ['providers', 'not-the-copilot-route'], value: {} }], h.view().revision),
    error => error.code === 'settings/rejected',
  );
  assert.deepEqual(h.raw(), before);
  assert.equal(h.commits.length, 0);
});

test('the actual guarded Client click operation saves through JSON wire and real Settings, then supports removal and re-add', async t => {
  const h = await harness(t);
  const { readFile } = await import('node:fs/promises');
  const { default: vm } = await import('node:vm');
  let definition;
  vm.runInNewContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: value => { definition = value; } } },
    AbortController, setTimeout, clearTimeout,
  });
  const client = definition.factory(id => { assert.equal(id, 'react'); return {}; });
  // Only JSON serialization and the generated RemoteResult envelope are
  // adapted here. Settings mutation/admission/revisions are the real services.
  const wire = value => JSON.parse(JSON.stringify(value));
  const remote = {
    async describe() { return { ok: true, value: wire(h.controller.describe()) }; },
    async mutate(ns, ops, revision) {
      try { return { ok: true, value: wire(await h.controller.mutate(ns, wire(ops), revision)) }; }
      catch (error) { return { ok: false, error: { code: error.code, message: error.message } }; }
    },
  };
  const action = client.createAddOperation(remote);
  try {
    const provider = { provider: LIVE_PROVIDER, settingsNs: SETTINGS_NS, settingsPath: providerPath };
    assert.equal((await action.run(provider)).ok, true);
    assertHasEmptyProfile(h.raw());
    assertHasEmptyProfile(h.view().value);
    assert.equal(h.commits.length, 1);
    assert.equal((await action.run(provider)).ok, true);
    assert.equal(h.commits.length, 1, 'already-added is an idempotent success');
    await h.controller.mutate(SETTINGS_NS, [unsetProvider], h.view().revision);
    assert.deepEqual(h.view().value, { providers: {} });
    assert.equal((await action.run(provider)).ok, true);
    assertHasEmptyProfile(h.view().value);
    assert.equal(h.commits.length, 3);
    assert.equal(h.raw().refreshIntervalSeconds, 777);
    assert.equal(h.raw().requestTimeoutMs, 12345);
  } finally { action.dispose(); }
});
