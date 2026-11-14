import { parseCatalog, trustedCopilotBaseURL, COPILOT_HEADERS } from './catalog.js';

export class CatalogError extends Error {
  constructor(message, code = 'CATALOG_UNAVAILABLE', status) {
    super(message); this.code = code; if (status !== undefined) this.status = status;
  }
}
function aborted(signal) { signal?.throwIfAborted(); }
export function waitWithSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function publicFailure(error, signal) {
  if (error instanceof CatalogError) return error;
  if (signal?.aborted || ['TimeoutError', 'AbortError'].includes(error?.name)) {
    return new CatalogError('Copilot 模型目录请求超时或已取消，保留上一次成功的目录。', 'TIMEOUT');
  }
  if (error?.code === 'MISSING_CREDENTIAL') return new CatalogError('请先在「设置 → GitHub Copilot」登录。', 'MISSING_CREDENTIAL');
  // SDK exceptions and server bodies may echo secrets. Never expose their text.
  return new CatalogError('无法读取 Copilot 在线目录，请检查网络和 Copilot 登录状态。', 'CATALOG_UNAVAILABLE');
}

export class CatalogController {
  constructor({ auth, knownModels = new Map(), config, changed = () => {}, fetchImpl = globalThis.fetch, now = Date.now }) {
    this.auth = auth; this.knownModels = knownModels; this.config = config;
    this.changed = changed; this.fetchImpl = fetchImpl; this.now = now;
    this.lifetime = new AbortController(); this.account = new AbortController();
    this.identity = undefined; this.generation = 0; this.snapshot = undefined;
    this.inflight = undefined; this.lastSuccess = 0; this.lastAttempt = 0;
    this.nextAttempt = 0; this.lastError = undefined; this.closed = false;
  }
  async reconcileIdentity() {
    let identity;
    try { identity = await this.auth.fingerprint(); }
    catch (error) {
      // Identity is unverified: fail closed instead of serving a possibly
      // different account's cached directory or leaking a storage exception.
      const hadState = !!this.identity || !!this.snapshot;
      this.identity = undefined; this.generation++;
      this.account.abort(); this.account = new AbortController();
      this.snapshot = undefined; this.inflight = undefined; this.lastSuccess = 0;
      this.lastError = publicFailure(error);
      if (hadState && !this.closed) this.changed();
      throw this.lastError;
    }
    if (this.closed || identity === this.identity) return false;
    this.identity = identity; this.generation++;
    this.account.abort(); this.account = new AbortController();
    this.snapshot = undefined; this.lastSuccess = 0; this.lastAttempt = 0;
    this.nextAttempt = 0; this.lastError = undefined;
    // Do not keep another account's in-flight result as the new account's work.
    this.inflight = undefined;
    if (!this.closed) this.changed();
    return true;
  }
  async credentialsChanged() {
    if (this.closed) return;
    if (await this.reconcileIdentity() && this.identity) await this.refresh(true);
  }
  async refresh(force = false, callerSignal) {
    aborted(callerSignal);
    if (this.closed) throw new CatalogError('插件已停用。', 'ABORTED');
    await this.reconcileIdentity();
    aborted(callerSignal);
    if (this.closed) throw new CatalogError('插件已停用。', 'ABORTED');
    if (!this.identity) throw new CatalogError('请先在「设置 → GitHub Copilot」登录。', 'MISSING_CREDENTIAL');
    const generation = this.generation;
    const forCaller = operation => waitWithSignal(operation, callerSignal).catch(async error => {
      aborted(callerSignal);
      if (this.closed) throw new CatalogError('插件已停用。', 'ABORTED');
      // Failed HTTP/transport requests also race login/logout. Verify identity
      // before considering stale fallback, not only after successful responses.
      await this.reconcileIdentity();
      aborted(callerSignal);
      if (this.closed) throw new CatalogError('插件已停用。', 'ABORTED');
      if (!force && this.snapshot && generation === this.generation) return this.snapshot;
      throw error;
    });
    if (this.inflight) return forCaller(this.inflight);
    const now = this.now();
    if (!force && this.snapshot && now - this.lastSuccess < this.config.cacheTtlSeconds * 1000) return this.snapshot;
    if (!force && now < this.nextAttempt) {
      if (this.snapshot) return this.snapshot;
      throw this.lastError ?? new CatalogError('在线目录暂不可用，请稍后刷新。');
    }
    const signal = AbortSignal.any([this.lifetime.signal, this.account.signal, AbortSignal.timeout(this.config.requestTimeoutMs)]);
    this.lastAttempt = now;
    const operation = this.fetchSnapshot(generation, signal).catch(error => {
      const safe = publicFailure(error, signal);
      if (generation === this.generation && !this.closed) {
        this.lastError = safe;
        this.nextAttempt = this.now() + (safe.status === 429 ? 60000 : 15000);
      }
      throw safe;
    });
    this.inflight = operation;
    operation.finally(() => { if (this.inflight === operation) this.inflight = undefined; }).catch(() => {});
    return forCaller(operation);
  }
  async fetchSnapshot(generation, signal) {
    const auth = await this.auth.resolve(signal);
    aborted(signal);
    const baseURL = trustedCopilotBaseURL(auth.baseUrl ?? 'https://api.individual.githubcopilot.com');
    const response = await this.fetchImpl(`${baseURL}/models`, {
      method: 'GET', redirect: 'error', signal,
      headers: { ...auth.headers, ...COPILOT_HEADERS, Accept: 'application/json',
        Authorization: `Bearer ${auth.apiKey}`, 'X-GitHub-Api-Version': this.config.apiVersion },
    });
    if (!response.ok) {
      await response.body?.cancel();
      const guidance = response.status === 401 || response.status === 403
        ? '，请检查登录、订阅或组织模型策略' : response.status === 429 ? '，稍后再刷新' : '';
      throw new CatalogError(`Copilot 模型目录返回 HTTP ${response.status}${guidance}。`, 'CATALOG_HTTP', response.status);
    }
    const raw = await response.json();
    const parsed = parseCatalog(raw, { ...this.config, baseURL, knownModels: this.knownModels });
    aborted(signal);
    // A login/logout may race the request without its update event reaching us yet.
    await this.reconcileIdentity();
    if (this.closed) throw new CatalogError('插件已停用。', 'ABORTED');
    if (generation !== this.generation) {
      throw new CatalogError('账号已变化，旧目录结果已丢弃。', 'ACCOUNT_CHANGED');
    }
    aborted(signal);
    const signature = JSON.stringify([baseURL, parsed.details, parsed.excluded]);
    const changed = signature !== this.snapshot?.signature;
    const snapshot = { ...parsed, baseURL, signature, fetchedAt: this.now(), generation };
    this.snapshot = snapshot; this.lastSuccess = snapshot.fetchedAt;
    this.lastError = undefined; this.nextAttempt = 0;
    if (changed) this.changed();
    return snapshot;
  }
  status() {
    return {
      state: this.lastError && !this.snapshot ? 'unavailable' : !this.identity ? 'signed-out' : this.snapshot ? this.lastError ? 'stale' : 'ready' : this.inflight ? 'loading' : 'unavailable',
      source: this.snapshot ? `${this.snapshot.baseURL}/models` : null,
      lastSuccessfulAt: this.lastSuccess ? new Date(this.lastSuccess).toISOString() : null,
      lastAttemptAt: this.lastAttempt ? new Date(this.lastAttempt).toISOString() : null,
      stale: !!this.snapshot && (!!this.lastError || this.now() - this.lastSuccess >= this.config.cacheTtlSeconds * 1000),
      refreshing: !!this.inflight,
      refreshIntervalSeconds: this.config.refreshIntervalSeconds,
      cacheTtlSeconds: this.config.cacheTtlSeconds,
      error: this.lastError ? { code: this.lastError.code, message: this.lastError.message,
        ...this.lastError.status === undefined ? {} : { status: this.lastError.status } } : null,
      rawModelCount: this.snapshot?.rawCount ?? 0,
      modelCount: this.snapshot?.details.length ?? 0,
      models: this.snapshot?.details ?? [], excluded: this.snapshot?.excluded ?? [],
    };
  }
  dispose() {
    this.closed = true; this.lifetime.abort(); this.account.abort();
  }
}
