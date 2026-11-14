import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CatalogController, CatalogError, waitWithSignal } from '../controller.js';
import { COPILOT_HEADERS } from '../catalog.js';

// All identities, tokens, responses, and times here are synthetic. Dependencies
// are injected: this file never imports auth.js or invokes globalThis.fetch.
const START_TIME = 1800000000000;
const BASE_URL = 'https://api.individual.githubcopilot.com';
const SECRET = 'UNIT_TEST_ONLY_SECRET_DO_NOT_EXPOSE';
const CONFIG = {
  cacheTtlSeconds: 30,
  refreshIntervalSeconds: 60,
  requestTimeoutMs: 60000,
  apiVersion: '2025-04-01',
  fallbackContextWindow: 128000,
  fallbackMaxTokens: 8192,
  includeHiddenModels: false,
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function directory(id = 'api-model') {
  return { data: [{
    id,
    name: id,
    model_picker_enabled: true,
    capabilities: {
      type: 'chat',
      supports: { tool_calls: true, streaming: true },
      limits: { max_context_window_tokens: 1000000, max_output_tokens: 64000, max_prompt_tokens: 936000 },
    },
    supported_endpoints: ['/chat/completions'],
  }] };
}

function response(raw = directory(), status = 200) {
  const result = {
    ok: status >= 200 && status < 300,
    status,
    statusText: SECRET,
    jsonReads: 0,
    textReads: 0,
    bodyCancellations: 0,
    async json() { result.jsonReads++; return raw; },
    async text() { result.textReads++; return SECRET; },
    body: { async cancel() { result.bodyCancellations++; } },
  };
  return result;
}

function harness(t, overrides = {}) {
  let identity = overrides.identity === undefined ? 'account-a' : overrides.identity;
  let clock = START_TIME;
  const pendingResponses = [];
  const fetchCalls = [];
  const resolveCalls = [];
  const fingerprintCalls = [];
  const changes = [];
  const auth = {
    async fingerprint() { fingerprintCalls.push(identity); return identity; },
    async resolve(signal) {
      resolveCalls.push(signal);
      return { apiKey: SECRET, baseUrl: BASE_URL, headers: { 'X-Offline-Test': 'yes' } };
    },
  };
  const controller = new CatalogController({
    auth,
    knownModels: new Map(),
    config: { ...CONFIG, ...overrides.config },
    changed: () => { changes.push(controller.snapshot); },
    now: () => clock,
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, options });
      assert.ok(pendingResponses.length, 'unexpected offline fetch: enqueue a synthetic response');
      const next = pendingResponses.shift();
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next(url, options) : next;
    },
  });
  t.after(() => controller.dispose());
  return {
    controller, auth, fetchCalls, resolveCalls, fingerprintCalls, changes,
    enqueue(value) { pendingResponses.push(value); },
    setIdentity(value) { identity = value; },
    now() { return clock; },
    advance(milliseconds) { clock += milliseconds; },
  };
}

function holdFetch(h) {
  const started = deferred();
  const result = deferred();
  h.enqueue((url, options) => {
    started.resolve({ url, options });
    // Deliberately ignore abort in the mock: late server replies must still be
    // rejected by the controller's generation/identity checks.
    return result.promise;
  });
  return { started: started.promise, resolve: result.resolve, reject: result.reject };
}

async function seed(h, id = 'cached-model') {
  h.enqueue(response(directory(id)));
  return h.controller.refresh();
}

function assertSafe(error, code = 'CATALOG_UNAVAILABLE') {
  assert.ok(error instanceof CatalogError);
  assert.equal(error.code, code);
  assert.equal(`${error.message}\n${error.stack}\n${JSON.stringify(error)}`.includes(SECRET), false);
  return true;
}

async function joined(h) {
  // This deterministic async boundary lets a just-started refresh finish its
  // identity reconciliation before a held fetch is released. No sleeps/polling.
  await h.controller.reconcileIdentity();
}

describe('waitWithSignal isolates cancellation from shared work', () => {
  it('returns the original promise when there is no caller signal', async () => {
    const original = Promise.resolve('ready');
    assert.equal(waitWithSignal(original), original);
    assert.equal(await original, 'ready');
  });

  it('rejects only the aborted waiter while another waiter gets the result', async () => {
    const shared = deferred();
    const caller = new AbortController();
    const reason = new Error('synthetic caller cancelled');
    const cancelled = assert.rejects(waitWithSignal(shared.promise, caller.signal), error => error === reason);
    const survivor = waitWithSignal(shared.promise);
    caller.abort(reason);
    await cancelled;
    shared.resolve('shared-success');
    assert.equal(await survivor, 'shared-success');
  });

  it('honors an already aborted signal without affecting the original promise', async () => {
    const caller = new AbortController();
    const reason = new Error('already cancelled');
    caller.abort(reason);
    const original = Promise.resolve('unaffected');
    await assert.rejects(waitWithSignal(original, caller.signal), error => error === reason);
    assert.equal(await original, 'unaffected');
  });
});

describe('authentication, trusted requests, and safe public errors', () => {
  it('does not fetch without an account identity', async t => {
    const h = harness(t);
    h.setIdentity(undefined);
    await assert.rejects(h.controller.refresh(), error => assertSafe(error, 'MISSING_CREDENTIAL'));
    assert.equal(h.fetchCalls.length, 0);
    assert.equal(h.resolveCalls.length, 0);
    assert.equal(h.controller.status().state, 'signed-out');
    assert.equal(h.controller.snapshot, undefined);
  });

  it('builds a trusted /models GET and keeps synthetic credentials out of snapshots/status', async t => {
    const h = harness(t);
    const snapshot = await seed(h);
    const [{ url, options }] = h.fetchCalls;
    assert.equal(url, `${BASE_URL}/models`);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${SECRET}`);
    assert.equal(options.headers.Accept, 'application/json');
    assert.equal(options.headers['X-GitHub-Api-Version'], CONFIG.apiVersion);
    assert.equal(options.headers['X-Offline-Test'], 'yes');
    for (const [name, value] of Object.entries(COPILOT_HEADERS)) assert.equal(options.headers[name], value);
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(snapshot.baseURL, BASE_URL);
    assert.equal(JSON.stringify(snapshot).includes(SECRET), false);
    assert.equal(JSON.stringify(h.controller.status()).includes(SECRET), false);
  });

  it('rejects an untrusted auth endpoint before making any request', async t => {
    const h = harness(t);
    h.auth.resolve = async () => ({ apiKey: SECRET, baseUrl: `https://${SECRET}.attacker.invalid` });
    await assert.rejects(h.controller.refresh(true), error => assertSafe(error));
    assert.equal(h.fetchCalls.length, 0);
    assert.equal(JSON.stringify(h.controller.status()).includes(SECRET), false);
  });

  it('redacts auth resolution exceptions instead of forwarding their messages', async t => {
    const h = harness(t);
    h.auth.resolve = async () => { throw new Error(`auth failure ${SECRET}`); };
    await assert.rejects(h.controller.refresh(true), error => assertSafe(error));
    assert.equal(h.fetchCalls.length, 0);
    assert.equal(JSON.stringify(h.controller.status()).includes(SECRET), false);
  });

  it('redacts identity fingerprint exceptions before the refresh starts', async t => {
    const h = harness(t);
    h.auth.fingerprint = async () => { throw new Error(`fingerprint failure ${SECRET}`); };
    await assert.rejects(h.controller.refresh(true), error => assertSafe(error));
    assert.equal(h.fetchCalls.length, 0);
    assert.equal(h.resolveCalls.length, 0);
  });

  it('redacts network errors and JSON parse errors', async t => {
    const h = harness(t);
    h.enqueue(new Error(`network failure with Bearer ${SECRET}`));
    await assert.rejects(h.controller.refresh(true), error => assertSafe(error));
    h.enqueue({
      ok: true,
      async json() { throw new SyntaxError(`invalid JSON ${SECRET}`); },
    });
    await assert.rejects(h.controller.refresh(true), error => assertSafe(error));
    assert.equal(JSON.stringify(h.controller.status()).includes(SECRET), false);
  });

  it('redacts a post-fetch fingerprint failure as well', async t => {
    const h = harness(t);
    let calls = 0;
    h.auth.fingerprint = async () => {
      if (++calls === 1) return 'account-a';
      throw new Error(`late identity failure ${SECRET}`);
    };
    h.enqueue(response());
    await assert.rejects(h.controller.refresh(true), error => assertSafe(error));
    assert.equal(h.controller.snapshot, undefined);
  });

  for (const status of [401, 403, 429, 500]) {
    it(`exposes safe HTTP ${status} metadata without reading a server error body`, async t => {
      const h = harness(t);
      const failed = response({ token: SECRET, error: SECRET }, status);
      h.enqueue(failed);
      await assert.rejects(h.controller.refresh(true), error => {
        assertSafe(error, 'CATALOG_HTTP');
        assert.equal(error.status, status);
        assert.match(error.message, new RegExp(`HTTP ${status}`));
        return true;
      });
      assert.equal(failed.bodyCancellations, 1);
      assert.equal(failed.jsonReads, 0);
      assert.equal(failed.textReads, 0);
      const state = h.controller.status();
      assert.equal(state.error.code, 'CATALOG_HTTP');
      assert.equal(state.error.status, status);
      assert.equal(JSON.stringify(state).includes(SECRET), false);
    });
  }
});

describe('shared refreshes, TTL, and error retention', () => {
  it('coalesces concurrent initial refreshes into a single auth resolution/fetch', async t => {
    const h = harness(t);
    const held = holdFetch(h);
    const first = h.controller.refresh();
    const second = h.controller.refresh();
    const forced = h.controller.refresh(true);
    await held.started;
    assert.equal(h.fetchCalls.length, 1);
    assert.equal(h.resolveCalls.length, 1);
    assert.equal(h.controller.status().refreshing, true);
    assert.equal(h.controller.status().state, 'loading');
    held.resolve(response(directory('coalesced')));
    const results = await Promise.all([first, second, forced]);
    assert.equal(results[0], results[1]);
    assert.equal(results[1], results[2]);
    assert.equal(h.controller.status().refreshing, false);
    assert.equal(h.controller.status().state, 'ready');
  });

  it('uses completion time for TTL and refreshes exactly at the expiry boundary', async t => {
    const h = harness(t);
    const held = holdFetch(h);
    const initial = h.controller.refresh();
    await held.started;
    h.advance(5000);
    held.resolve(response(directory('first')));
    const original = await initial;
    assert.equal(original.fetchedAt, START_TIME + 5000);
    h.advance(CONFIG.cacheTtlSeconds * 1000 - 1);
    assert.equal(await h.controller.refresh(), original);
    assert.equal(h.fetchCalls.length, 1);
    assert.equal(h.controller.status().stale, false);
    h.advance(1);
    assert.equal(h.controller.status().stale, true);
    h.enqueue(response(directory('at-boundary')));
    const refreshed = await h.controller.refresh();
    assert.notEqual(refreshed, original);
    assert.equal(refreshed.models[0].id, 'at-boundary');
    assert.equal(h.fetchCalls.length, 2);
    assert.equal(h.controller.status().stale, false);
  });

  it('force bypasses an otherwise fresh cache', async t => {
    const h = harness(t);
    const original = await seed(h);
    h.enqueue(response(directory('forced-new-model')));
    const forced = await h.controller.refresh(true);
    assert.notEqual(forced, original);
    assert.equal(forced.models[0].id, 'forced-new-model');
    assert.equal(h.fetchCalls.length, 2);
  });

  it('keeps a stale snapshot after ordinary refresh failure and retries after cooldown', async t => {
    const h = harness(t);
    const original = await seed(h);
    const changesBeforeFailure = h.changes.length;
    h.advance(CONFIG.cacheTtlSeconds * 1000);
    h.enqueue(response(undefined, 500));
    assert.equal(await h.controller.refresh(), original);
    assert.equal(h.controller.snapshot, original);
    assert.equal(h.changes.length, changesBeforeFailure);
    const stale = h.controller.status();
    assert.equal(stale.state, 'stale');
    assert.equal(stale.stale, true);
    assert.equal(stale.error.status, 500);
    assert.equal(stale.lastSuccessfulAt, new Date(START_TIME).toISOString());
    assert.equal(stale.lastAttemptAt, new Date(h.now()).toISOString());
    h.advance(14999);
    assert.equal(await h.controller.refresh(), original);
    assert.equal(h.fetchCalls.length, 2);
    h.advance(1);
    h.enqueue(response(directory('recovered')));
    const recovered = await h.controller.refresh();
    assert.equal(recovered.models[0].id, 'recovered');
    assert.equal(h.fetchCalls.length, 3);
    assert.equal(h.controller.status().error, null);
    assert.equal(h.controller.status().stale, false);
  });

  it('rejects a failed forced refresh without losing the last successful snapshot', async t => {
    const h = harness(t);
    const original = await seed(h);
    h.enqueue(response(undefined, 503));
    await assert.rejects(h.controller.refresh(true), error => assertSafe(error, 'CATALOG_HTTP'));
    assert.equal(h.controller.snapshot, original);
    assert.equal(h.controller.status().state, 'stale');
    assert.equal(h.controller.status().models[0].id, 'cached-model');
    assert.equal(await h.controller.refresh(), original);
    assert.equal(h.fetchCalls.length, 2);
  });

  it('allows force to bypass error cooldown without discarding the cache', async t => {
    const h = harness(t);
    const original = await seed(h);
    h.enqueue(response(undefined, 500));
    await assert.rejects(h.controller.refresh(true), error => assertSafe(error, 'CATALOG_HTTP'));
    assert.equal(h.controller.snapshot, original);
    h.enqueue(response(directory('manual-retry')));
    assert.equal((await h.controller.refresh(true)).models[0].id, 'manual-retry');
    assert.equal(h.fetchCalls.length, 3);
    assert.equal(h.controller.status().error, null);
  });

  it('rate-limits retries for 60 seconds after HTTP 429 even without a snapshot', async t => {
    const h = harness(t);
    h.enqueue(response(undefined, 429));
    let firstError;
    await assert.rejects(h.controller.refresh(), error => {
      firstError = error;
      return assertSafe(error, 'CATALOG_HTTP');
    });
    h.advance(59999);
    await assert.rejects(h.controller.refresh(), error => error === firstError);
    assert.equal(h.fetchCalls.length, 1);
    h.advance(1);
    h.enqueue(response(directory('rate-limit-cleared')));
    assert.equal((await h.controller.refresh()).models[0].id, 'rate-limit-cleared');
    assert.equal(h.fetchCalls.length, 2);
  });

  it('retains the snapshot when an otherwise successful response has an invalid directory', async t => {
    const h = harness(t);
    const original = await seed(h);
    h.advance(CONFIG.cacheTtlSeconds * 1000);
    h.enqueue(response({ data: 'invalid' }));
    assert.equal(await h.controller.refresh(), original);
    assert.equal(h.controller.snapshot, original);
    assert.equal(h.controller.status().error.code, 'CATALOG_UNAVAILABLE');
  });

  it('a forced joiner still gets the error when the shared refresh was started normally', async t => {
    const h = harness(t);
    const original = await seed(h);
    h.advance(CONFIG.cacheTtlSeconds * 1000);
    const held = holdFetch(h);
    const normal = h.controller.refresh();
    await held.started;
    const forced = assert.rejects(h.controller.refresh(true), error => assertSafe(error, 'CATALOG_HTTP'));
    await joined(h);
    held.resolve(response(undefined, 500));
    assert.equal(await normal, original);
    await forced;
    assert.equal(h.controller.snapshot, original);
    assert.equal(h.fetchCalls.length, 2);
  });

  it('a normal joiner retains stale fallback when the shared refresh was started forcibly', async t => {
    const h = harness(t);
    const original = await seed(h);
    h.advance(CONFIG.cacheTtlSeconds * 1000);
    const held = holdFetch(h);
    const forced = assert.rejects(h.controller.refresh(true), error => assertSafe(error, 'CATALOG_HTTP'));
    await held.started;
    const normal = h.controller.refresh();
    await joined(h);
    held.resolve(response(undefined, 500));
    await forced;
    assert.equal(await normal, original);
    assert.equal(h.controller.snapshot, original);
    assert.equal(h.fetchCalls.length, 2);
  });
});

describe('directory removal, account switching, and stale in-flight work', () => {
  it('a successful empty directory really replaces the old models and notifies consumers', async t => {
    const h = harness(t);
    const original = await seed(h);
    const changesBefore = h.changes.length;
    h.enqueue(response({ data: [] }));
    const empty = await h.controller.refresh(true);
    assert.notEqual(empty, original);
    assert.equal(h.controller.snapshot, empty);
    assert.deepEqual(empty.models, []);
    assert.deepEqual(empty.details, []);
    assert.equal(empty.rawCount, 0);
    assert.equal(h.controller.status().modelCount, 0);
    assert.equal(h.controller.status().rawModelCount, 0);
    assert.equal(h.controller.status().state, 'ready');
    assert.equal(h.changes.length, changesBefore + 1);
  });

  it('a new account clears fresh cached models before its request finishes', async t => {
    const h = harness(t);
    await seed(h, 'account-a-model');
    h.setIdentity('account-b');
    const held = holdFetch(h);
    const pending = h.controller.refresh();
    await held.started;
    assert.equal(h.controller.snapshot, undefined);
    assert.equal(h.controller.status().modelCount, 0);
    assert.equal(h.controller.status().state, 'loading');
    held.resolve(response(directory('account-b-model')));
    assert.equal((await pending).models[0].id, 'account-b-model');
    assert.equal(h.controller.status().models.some(model => model.id === 'account-a-model'), false);
  });

  it('credentialsChanged refreshes a different account and logout clears everything', async t => {
    const h = harness(t);
    await seed(h, 'account-a-model');
    h.setIdentity('account-b');
    h.enqueue(response(directory('account-b-model')));
    await h.controller.credentialsChanged();
    assert.equal(h.controller.snapshot.models[0].id, 'account-b-model');
    h.setIdentity(undefined);
    await h.controller.credentialsChanged();
    const signedOut = h.controller.status();
    assert.equal(h.controller.snapshot, undefined);
    assert.equal(signedOut.state, 'signed-out');
    assert.equal(signedOut.source, null);
    assert.equal(signedOut.modelCount, 0);
    assert.equal(signedOut.rawModelCount, 0);
    assert.equal(signedOut.lastSuccessfulAt, null);
    assert.equal(signedOut.lastAttemptAt, null);
    assert.equal(signedOut.error, null);
    await assert.rejects(h.controller.refresh(), error => assertSafe(error, 'MISSING_CREDENTIAL'));
    assert.equal(h.fetchCalls.length, 2);
  });

  it('does not inherit a previous account snapshot when the new account refresh fails', async t => {
    const h = harness(t);
    await seed(h, 'account-a-model');
    h.setIdentity('account-b');
    h.enqueue(response(undefined, 500));
    await assert.rejects(h.controller.refresh(), error => assertSafe(error, 'CATALOG_HTTP'));
    assert.equal(h.controller.snapshot, undefined);
    assert.equal(h.controller.status().modelCount, 0);
    assert.equal(h.controller.status().state, 'unavailable');
  });

  it('does not let completion/finally from the old account clear a new in-flight request', async t => {
    const h = harness(t);
    const old = holdFetch(h);
    const oldRequest = assert.rejects(h.controller.refresh(), error => error instanceof CatalogError);
    const oldStarted = await old.started;
    h.setIdentity('account-b');
    const current = holdFetch(h);
    const currentRequest = h.controller.refresh();
    await current.started;
    assert.equal(oldStarted.options.signal.aborted, true);
    old.resolve(response(directory('late-account-a-model')));
    await oldRequest;
    assert.equal(h.controller.snapshot, undefined);
    assert.equal(h.controller.status().refreshing, true);
    assert.equal(h.controller.status().state, 'loading');
    current.resolve(response(directory('account-b-model')));
    assert.equal((await currentRequest).models[0].id, 'account-b-model');
  });

  it('ignores a late old-account reply after the new account already has a snapshot', async t => {
    const h = harness(t);
    const old = holdFetch(h);
    const oldRequest = assert.rejects(h.controller.refresh(), error => error instanceof CatalogError);
    await old.started;
    h.setIdentity('account-b');
    h.enqueue(response(directory('account-b-model')));
    const current = await h.controller.refresh();
    old.resolve(response(directory('late-account-a-model')));
    await oldRequest;
    assert.equal(h.controller.snapshot, current);
    assert.equal(h.controller.status().models[0].id, 'account-b-model');
    assert.equal(h.controller.status().error, null);
  });

  for (const [label, nextIdentity] of [['switch-account', 'account-b'], ['logout', undefined]]) {
    for (const force of [false, true]) {
      it(`discards cached account A on silent ${label} during ${force ? 'forced' : 'ordinary'} refresh`, async t => {
        const h = harness(t);
        await seed(h, 'account-a-model');
        h.advance(CONFIG.cacheTtlSeconds * 1000);
        const held = holdFetch(h);
        const outcome = h.controller.refresh(force).then(value => ({ value }), error => ({ error }));
        await held.started;
        // No credentialsChanged event: the final fingerprint check itself must
        // invalidate the old identity and prevent stale-cache fallback.
        h.setIdentity(nextIdentity);
        held.resolve(response(directory('late-account-a-model')));
        const result = await outcome;
        assert.equal(result.value, undefined, 'a changed account must never receive the old snapshot');
        assert.ok(result.error instanceof CatalogError);
        assert.equal(result.error.code, 'ACCOUNT_CHANGED');
        assert.equal(h.controller.snapshot, undefined, 'observed identity changes must also remove cached models');
        assert.equal(h.controller.status().modelCount, 0);
        assert.equal(h.controller.status().state, nextIdentity ? 'unavailable' : 'signed-out');
      });
    }
  }

  for (const [label, nextIdentity] of [['switch-account', 'account-b'], ['logout', undefined]]) {
    for (const failure of ['http', 'network']) {
      for (const force of [false, true]) {
        it(`does not retain account A after silent ${label} and ${failure} failure (${force ? 'forced' : 'ordinary'})`, async t => {
          const h = harness(t);
          await seed(h, 'account-a-model');
          h.advance(CONFIG.cacheTtlSeconds * 1000);
          const held = holdFetch(h);
          const outcome = h.controller.refresh(force).then(value => ({ value }), error => ({ error }));
          await held.started;
          h.setIdentity(nextIdentity);
          if (failure === 'http') held.resolve(response(undefined, 500));
          else held.reject(new Error(`old account request failed ${SECRET}`));
          const result = await outcome;
          assert.equal(result.value, undefined, 'failed old-account requests must not serve stale account A data');
          assert.ok(result.error instanceof CatalogError);
          assert.equal(JSON.stringify(result.error).includes(SECRET), false);
          assert.equal(h.controller.snapshot, undefined, 'failure paths must also invalidate an observed identity change');
          assert.equal(h.controller.status().modelCount, 0);
          assert.equal(h.controller.status().state, nextIdentity ? 'unavailable' : 'signed-out');
        });
      }
    }
  }

  it('clears cached models when identity verification itself fails', async t => {
    const h = harness(t);
    await seed(h, 'account-a-model');
    h.auth.fingerprint = async () => { throw new Error(`storage failure ${SECRET}`); };
    await assert.rejects(h.controller.refresh(), error => assertSafe(error));
    assert.equal(h.controller.snapshot, undefined);
    assert.equal(h.controller.status().modelCount, 0);
    assert.equal(h.controller.status().state, 'unavailable');
    assert.equal(JSON.stringify(h.controller.status()).includes(SECRET), false);
  });

  it('notifies only when directory contents change, not for identical successful refreshes', async t => {
    const h = harness(t);
    const original = await seed(h);
    const changesBefore = h.changes.length;
    h.advance(1000);
    h.enqueue(response(directory('cached-model')));
    const identical = await h.controller.refresh(true);
    assert.notEqual(identical, original);
    assert.equal(identical.signature, original.signature);
    assert.equal(h.changes.length, changesBefore);
  });
});

describe('caller cancellation, timeout, and disposal', () => {
  it('does not start auth/fetch for an already cancelled caller', async t => {
    const h = harness(t);
    const caller = new AbortController();
    const reason = new Error('caller already cancelled');
    caller.abort(reason);
    await assert.rejects(h.controller.refresh(false, caller.signal), error => error === reason);
    assert.equal(h.fingerprintCalls.length, 0);
    assert.equal(h.resolveCalls.length, 0);
    assert.equal(h.fetchCalls.length, 0);
  });

  for (const cancelFirst of [true, false]) {
    it(`cancelling the ${cancelFirst ? 'initiating' : 'joining'} caller does not cancel the shared refresh`, async t => {
      const h = harness(t);
      const held = holdFetch(h);
      const caller = new AbortController();
      const reason = new Error('one caller cancelled');
      let cancelled;
      let survivor;
      if (cancelFirst) {
        cancelled = assert.rejects(h.controller.refresh(false, caller.signal), error => error === reason);
        await held.started;
        survivor = h.controller.refresh();
      } else {
        survivor = h.controller.refresh();
        await held.started;
        cancelled = assert.rejects(h.controller.refresh(false, caller.signal), error => error === reason);
      }
      await joined(h);
      const { options } = await held.started;
      caller.abort(reason);
      await cancelled;
      assert.equal(options.signal.aborted, false, 'caller abort must not reach the shared fetch signal');
      assert.equal(h.controller.status().refreshing, true);
      assert.equal(h.fetchCalls.length, 1);
      held.resolve(response(directory('surviving-model')));
      assert.equal((await survivor).models[0].id, 'surviving-model');
      assert.equal(h.controller.status().state, 'ready');
      assert.equal(h.controller.status().error, null);
    });
  }

  it('rechecks caller cancellation after an asynchronous identity lookup', async t => {
    const h = harness(t);
    const fingerprint = deferred();
    h.auth.fingerprint = () => fingerprint.promise;
    const caller = new AbortController();
    const reason = new Error('cancel during identity lookup');
    const cancelled = assert.rejects(h.controller.refresh(false, caller.signal), error => error === reason);
    caller.abort(reason);
    fingerprint.resolve('account-a');
    await cancelled;
    assert.equal(h.fetchCalls.length, 0);
    assert.equal(h.resolveCalls.length, 0);
  });

  it('handles a synthetic timeout without real timers or leaking the timeout reason', async t => {
    const timeout = new AbortController();
    t.mock.method(AbortSignal, 'timeout', milliseconds => {
      assert.equal(milliseconds, CONFIG.requestTimeoutMs);
      return timeout.signal;
    });
    const h = harness(t);
    const original = await seed(h);
    h.advance(CONFIG.cacheTtlSeconds * 1000);
    const held = holdFetch(h);
    const failed = assert.rejects(h.controller.refresh(true), error => assertSafe(error, 'TIMEOUT'));
    const { options } = await held.started;
    timeout.abort(new DOMException(`timeout ${SECRET}`, 'TimeoutError'));
    assert.equal(options.signal.aborted, true);
    held.resolve(response(directory('must-not-commit')));
    await failed;
    assert.equal(h.controller.snapshot, original);
    assert.equal(JSON.stringify(h.controller.status()).includes(SECRET), false);
  });

  it('does not commit a result if shared timeout fires during final identity verification', async t => {
    const timeout = new AbortController();
    t.mock.method(AbortSignal, 'timeout', () => timeout.signal);
    const h = harness(t);
    const original = await seed(h);
    const identityStarted = deferred();
    const identityResult = deferred();
    let fingerprintCalls = 0;
    h.auth.fingerprint = async () => {
      if (++fingerprintCalls === 2) {
        identityStarted.resolve();
        return identityResult.promise;
      }
      return 'account-a';
    };
    h.enqueue(response(directory('overdue-result')));
    const outcome = h.controller.refresh(true).then(value => ({ value }), error => ({ error }));
    await identityStarted.promise;
    timeout.abort(new DOMException(`timeout during fingerprint ${SECRET}`, 'TimeoutError'));
    identityResult.resolve('account-a');
    const result = await outcome;
    assert.equal(result.value, undefined, 'a timed-out operation must not commit after the last await');
    assertSafe(result.error, 'TIMEOUT');
    assert.equal(h.controller.snapshot, original);
    assert.equal(h.controller.status().models[0].id, 'cached-model');
  });

  it('does not return a stale-cache fallback after disposal while an ordinary refresh is pending', async t => {
    const h = harness(t);
    await seed(h);
    h.advance(CONFIG.cacheTtlSeconds * 1000);
    const held = holdFetch(h);
    const outcome = h.controller.refresh().then(value => ({ value }), error => ({ error }));
    await held.started;
    h.controller.dispose();
    held.resolve(response(directory('after-disposal')));
    const result = await outcome;
    assert.equal(result.value, undefined, 'disabled controllers must not serve old cached results');
    assert.ok(result.error instanceof CatalogError);
  });

  it('disposal aborts in-flight work and prevents later refreshes or snapshot commits', async t => {
    const h = harness(t);
    const held = holdFetch(h);
    const failed = assert.rejects(h.controller.refresh(), error => error instanceof CatalogError);
    const { options } = await held.started;
    const changesBefore = h.changes.length;
    h.controller.dispose();
    assert.equal(options.signal.aborted, true);
    held.resolve(response(directory('after-disposal')));
    await failed;
    assert.equal(h.controller.snapshot, undefined);
    assert.equal(h.changes.length, changesBefore);
    const callsBefore = h.fingerprintCalls.length;
    await assert.rejects(h.controller.refresh(true), error => assertSafe(error, 'ABORTED'));
    assert.equal(h.fingerprintCalls.length, callsBefore);
  });
});
