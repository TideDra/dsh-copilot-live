import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Exercise the exact guarded operation used by onClick; no fake DOM/renderer.
let manifest;
vm.runInNewContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load: value => { manifest = value; } } }, AbortController,
});
const client = manifest.factory(id => { assert.equal(id, 'react'); return {}; });
const provider = { provider: 'github-copilot-live', settingsNs: 'local-copilot-live', settingsPath: ['providers', 'github-copilot-live'] };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function setup() {
  let nextTimer = 0;
  const timers = new Map();
  const counts = { reads: 0, writes: 0 };
  const remote = {
    async describe() { counts.reads++; return { ok: true, value: { writable: true, namespaces: [{ ns: provider.settingsNs, value: { providers: {} }, revision: 3 }] } }; },
    async mutate(ns, ops, revision) { counts.writes++; assert.equal(ns, provider.settingsNs); assert.equal(revision, 3); return { ok: true, value: {} }; },
  };
  const options = { timeoutMs: 20000, schedule(callback) { const id = ++nextTimer; timers.set(id, callback); return id; }, cancel(id) { timers.delete(id); } };
  return { remote, counts, timers, options };
}
test('creating the UI operation does not read settings or enable a provider', () => {
  const h = setup();
  client.createAddOperation(h.remote, h.options);
  assert.deepEqual(h.counts, { reads: 0, writes: 0 });
  assert.equal(h.timers.size, 0);
});
test('a runtime context getter throwing before the old helper entry is now caught and reported', async () => {
  const h = setup();
  const action = client.createAddOperation(() => { throw new Error('synthetic-sensitive-context-error'); }, h.options);
  const result = await action.run(provider);
  assert.equal(result.ok, false);
  assert.equal(result.key, 'failed');
  assert(!JSON.stringify(result).includes('synthetic-sensitive-context-error'));
  assert.deepEqual(h.counts, { reads: 0, writes: 0 });
  assert.equal(h.timers.size, 0);
});
test('an RPC method getter throwing is also an explicit failure, not an unhandled click rejection', async () => {
  const h = setup();
  Object.defineProperty(h.remote, 'describe', { get() { throw new Error('synthetic-private-getter'); } });
  const result = await client.createAddOperation(h.remote, h.options).run(provider);
  assert.equal(result.key, 'failed');
  assert.equal(h.timers.size, 0);
});
test('rapid or concurrent clicks share a single pending read and write', async () => {
  const h = setup();
  const held = deferred();
  const started = deferred();
  const original = h.remote.describe;
  h.remote.describe = async () => { started.resolve(); await held.promise; return original(); };
  const action = client.createAddOperation(h.remote, h.options);
  const first = action.run(provider);
  const second = action.run(provider);
  assert.equal(first, second);
  await started.promise;
  assert.equal(h.timers.size, 1);
  held.resolve();
  assert.equal((await first).ok, true);
  assert.deepEqual(h.counts, { reads: 1, writes: 1 });
  assert.equal(h.timers.size, 0);
});
test('a failed attempt releases the operation so a later manual retry can succeed', async () => {
  const h = setup();
  let ready = false;
  const action = client.createAddOperation(() => { if (!ready) throw new Error('not ready'); return h.remote; }, h.options);
  assert.equal((await action.run(provider)).key, 'failed');
  ready = true;
  assert.equal((await action.run(provider)).ok, true);
  assert.deepEqual(h.counts, { reads: 1, writes: 1 });
});
test('stalled reads end in a visible timeout and cannot start a late configuration write', async () => {
  const h = setup();
  const held = deferred();
  const started = deferred();
  const original = h.remote.describe;
  h.remote.describe = async () => { started.resolve(); await held.promise; return original(); };
  const action = client.createAddOperation(h.remote, h.options);
  const result = action.run(provider);
  await started.promise;
  const [fire] = h.timers.values();
  fire();
  assert.equal((await result).key, 'timedOut');
  assert.equal(h.timers.size, 0);
  held.resolve();
  await held.promise;
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(h.counts.writes, 0);
});
test('timing out an already-admitted write reports uncertainty without retrying it', async () => {
  const h = setup();
  const held = deferred();
  const admitted = deferred();
  h.remote.mutate = async () => { h.counts.writes++; admitted.resolve(); await held.promise; return { ok: true, value: {} }; };
  const action = client.createAddOperation(h.remote, h.options);
  const request = action.run(provider);
  await admitted.promise;
  const [fire] = h.timers.values();
  fire();
  assert.equal((await request).key, 'timedOut');
  assert.equal(h.counts.writes, 1);
  held.resolve();
  await held.promise;
  assert.equal(h.counts.writes, 1);
});
test('disposed operations refuse new clicks without reading or mutating settings', async () => {
  const h = setup();
  const action = client.createAddOperation(h.remote, h.options);
  action.dispose();
  assert.equal((await action.run(provider)).key, 'unavailable');
  assert.deepEqual(h.counts, { reads: 0, writes: 0 });
  assert.equal(h.timers.size, 0);
});
test('disposing a pending read clears its timer and prevents a late write', async () => {
  const h = setup();
  const held = deferred();
  const started = deferred();
  const original = h.remote.describe;
  h.remote.describe = async () => { started.resolve(); await held.promise; return original(); };
  const action = client.createAddOperation(h.remote, h.options);
  const request = action.run(provider);
  await started.promise;
  action.dispose();
  assert.equal(h.timers.size, 0);
  assert.equal((await request).key, 'unavailable');
  held.resolve();
  await held.promise;
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(h.counts.writes, 0);
});
test('Host refusal remains visible and does not leave the operation busy', async () => {
  const h = setup();
  h.remote.mutate = async () => ({ ok: false, error: { code: 'settings/rejected', message: 'A visible Host refusal' } });
  const result = await client.createAddOperation(h.remote, h.options).run(provider);
  assert.equal(result.message, 'A visible Host refusal');
  assert.equal(h.timers.size, 0);
});
