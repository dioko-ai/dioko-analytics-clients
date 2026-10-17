export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type Properties = Record<string, JsonValue>;
export interface EventContext { page_url?: string; referrer?: string; utm_source?: string; utm_medium?: string; utm_campaign?: string; utm_term?: string; utm_content?: string }
export interface TrackOptions { anonymousId?: string; userId?: string; sessionId?: string; context?: EventContext }
export interface AnalyticsOptions {
  endpoint: string; sourceKey: string; enabled?: boolean;
  flushIntervalMs?: number; batchSize?: number; maxQueueSize?: number;
  maxRetries?: number; retryDelayMs?: number; timeoutMs?: number;
  fetch?: typeof globalThis.fetch; onError?: (error: Error) => void;
  storage?: 'localStorage'; storageKey?: string; retentionMs?: number;
}
export interface Analytics {
  track(name: string, properties?: Properties, options?: TrackOptions): string | null;
  page(properties?: Properties, options?: TrackOptions): string | null;
  flush(): Promise<void>; setEnabled(enabled: boolean): void; destroy(): void;
}
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
function integer(value: number | undefined, fallback: number, min: number, max: number): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < min || result > max) throw new TypeError(`Expected integer between ${min} and ${max}`);
  return result;
}
function validateJson(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || ancestors.has(value)) throw new TypeError('Properties must contain finite, non-circular JSON values');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError('Properties must contain plain JSON objects');
  ancestors.add(value);
  for (const entry of Array.isArray(value) ? value : Object.values(value)) validateJson(entry, ancestors);
  ancestors.delete(value);
}
export interface TransportConfig { headers: Record<string, string>; batchPrefix: string; rejectFailures: boolean }
export function createClient(config: AnalyticsOptions, transport?: TransportConfig): Analytics {
  const serverMode = transport?.rejectFailures ?? false;
  if (!serverMode && (!/^pk_[A-Za-z0-9_-]+$/.test(config.sourceKey) || config.sourceKey.length < 20 || config.sourceKey.length > 200)) throw new TypeError('Use a public browser source key (pk_), never a server secret');
  const url = new URL(config.endpoint);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new TypeError('Endpoint must be an HTTP(S) collector URL without credentials, query or fragment');
  if (url.pathname === '/') url.pathname = '/v1/batch';
  else if (url.pathname !== '/v1/batch') throw new TypeError('Endpoint must be a collector origin or /v1/batch URL');
  const endpoint = url.href;
  const sourceKey = config.sourceKey;
  const batchSize = integer(config.batchSize, 20, 1, 100);
  const maxQueue = integer(config.maxQueueSize, 1000, 1, 10000);
  const interval = integer(config.flushIntervalMs, 5000, 0, 2147483647);
  const retries = integer(config.maxRetries, 3, 0, 10);
  const delay = integer(config.retryDelayMs, 1000, 0, 2147483647);
  const timeout = integer(config.timeoutMs, 10000, 1, 2147483647);
  const fetcher = config.fetch ?? globalThis.fetch?.bind(globalThis);
  if (!fetcher) throw new TypeError('A fetch implementation is required');
  let enabled = config.enabled ?? true, destroyed = false, generation = 0;
  let queue: string[] = [], inFlight: string[] = [], inFlightCount = 0;
  let retryAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | undefined;
  let activeEpoch = 0;
  let controller: AbortController | undefined;
  let cancelWait: (() => void) | undefined;
  const report = (error: unknown) => { try { config.onError?.(error instanceof Error ? error : new Error(String(error))); } catch { /* Reporting must not break collection. */ } };
  const bodyFor = (events: string[]) => `{${transport?.batchPrefix ?? `"source_key":${JSON.stringify(sourceKey)},`}"events":[${events.join(',')}]}`;
  const clearTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const persistent = !serverMode && config.storage === 'localStorage';
  const retention = integer(config.retentionMs, 7 * 86400000, 1, 30 * 86400000);
  if (config.storage !== undefined && config.storage !== 'localStorage') throw new TypeError('Unsupported analytics storage');
  if (config.storageKey !== undefined && (typeof config.storageKey !== 'string' || !config.storageKey.length || config.storageKey.length > 200)) throw new TypeError('storageKey must be a nonempty string up to 200 characters');
  const prefix = `${config.storageKey ?? 'dioko-analytics'}:${encodeURIComponent(endpoint)}:${sourceKey}:`;
  const storage = (): Storage | undefined => {
    if (!persistent) return undefined;
    try { if (!globalThis.localStorage) throw new Error('localStorage is unavailable'); return globalThis.localStorage; }
    catch (error) { report(error); return undefined; }
  };
  const eventKey = (event: string) => prefix + (JSON.parse(event) as { event_id: string }).event_id;
  const storedKeys = (store: Storage) => {
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) { const key = store.key(i); if (key?.startsWith(prefix)) keys.push(key); }
    return keys;
  };
  const clearStored = () => { const store = storage(); if (store) try { for (const key of storedKeys(store)) store.removeItem(key); } catch (error) { report(error); } };
  const removeStored = (events: string[]) => { const store = storage(); if (store) try { for (const event of events) store.removeItem(eventKey(event)); } catch (error) { report(error); } };
  const restore = () => {
    if (!enabled || destroyed) return;
    const store = storage(); if (!store) return;
    try {
      const known = new Set([...queue, ...inFlight].map(eventKey));
      for (const key of storedKeys(store)) {
        const raw = store.getItem(key); if (raw === null) continue;
        try {
          const event = JSON.parse(raw);
          if (!event || typeof event !== 'object' || Array.isArray(event) || bytes(raw) > 32 * 1024 || typeof event.event_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(event.event_id) || prefix + event.event_id !== key) throw new Error('Invalid stored event');
          if (Object.keys(event).some(field => !['event_id', 'event_name', 'occurred_at', 'anonymous_id', 'user_id', 'session_id', 'properties', 'context'].includes(field))) throw new Error('Invalid stored event fields');
          const occurred = Date.parse(event.occurred_at);
          if (typeof event.occurred_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(event.occurred_at) || !Number.isFinite(occurred) || new Date(occurred).toISOString() !== event.occurred_at || occurred < Date.now() - retention || occurred > Date.now() + 300000) throw new Error('Stored event expired or invalid');
          if (event.context === null) throw new Error('Invalid stored context');
          validateFields(event.event_name, event.properties, { anonymousId: event.anonymous_id, userId: event.user_id, sessionId: event.session_id, context: event.context });
          if (!known.has(key) && queue.length + inFlightCount < maxQueue) { queue.push(raw); known.add(key); }
        } catch (error) { store.removeItem(key); report(error); }
      }
    } catch (error) { report(error); }
  };
  const persist = (event: string) => {
    const store = storage(); if (!store) return;
    try {
      // Per-event writes never overwrite another tab's pending events. Refuse new
      // persistence at capacity, while retaining the event in memory.
      const keys = storedKeys(store);
      if (keys.length >= maxQueue) { report(new Error('Persistent analytics queue is full; event kept in memory')); return; }
      store.setItem(eventKey(event), event);
    } catch (error) { report(error); }
  };
  const backgroundFlush = () => { void flush().catch(() => { /* Explicit server flush exposes the already-reported failure. */ }); };
  const schedule = () => {
    const pendingRetry = retryAt > 0;
    if (!destroyed && enabled && queue.length && (interval || pendingRetry) && timer === undefined && !active) {
      timer = setTimeout(() => { timer = undefined; backgroundFlush(); }, Math.min(2147483647, Math.max(pendingRetry ? Math.max(0, retryAt - Date.now()) : interval, 1)));
      (timer as unknown as { unref?: () => void }).unref?.();
    }
  };
  const wait = (ms: number) => new Promise<void>(resolve => {
    // Long Retry-After values are split to avoid timer overflow and accidental early retries.
    const end = Date.now() + ms;
    let handle: ReturnType<typeof setTimeout>;
    const finish = () => { clearTimeout(handle); cancelWait = undefined; resolve(); };
    const step = () => { const remaining = end - Date.now(); if (remaining <= 0) finish(); else handle = setTimeout(step, Math.min(remaining, 2147483647)); };
    cancelWait = finish; step();
  });
  type Delivery = { kind: 'accepted' | 'permanent' | 'retry' | 'cancelled'; error?: Error };
  async function deliver(body: string, epoch: number): Promise<Delivery> {
    let lastError = new Error('Analytics batch was not delivered');
    for (let attempt = 0; attempt <= retries && enabled && !destroyed && generation === epoch; attempt++) {
      if (persistent && inFlight.some(raw => Date.parse(JSON.parse(raw).occurred_at) < Date.now() - retention)) { retryAt = Date.now() + 1000; return { kind: 'retry', error: new Error('Pending analytics batch reached retention limit') }; }
      let retryAfter = 0;
      const current = new AbortController(); controller = current;
      let handle: ReturnType<typeof setTimeout> | undefined;
      try {
        const aborted = new Promise<never>((_, reject) => current.signal.addEventListener('abort', () => reject(new Error('Analytics request aborted or timed out')), { once: true }));
        handle = setTimeout(() => current.abort(), timeout);
        const headers: Record<string, string> = { 'Content-Type': 'application/json', ...transport?.headers };
        const response = await Promise.race([fetcher!(endpoint, { method: 'POST', headers, body, credentials: 'omit', mode: 'cors', redirect: 'error', signal: current.signal }), aborted]);
        if (generation !== epoch || !enabled || destroyed) return { kind: 'cancelled' };
        if (response.status === 202) return { kind: 'accepted' };
        lastError = new Error(`Collector rejected batch (${response.status})`);
        if (response.status !== 429 && response.status < 500) return { kind: 'permanent', error: lastError };
        const header = response.headers.get('Retry-After');
        if (header) retryAfter = /^\d+(\.\d+)?$/.test(header) ? Number(header) * 1000 : Math.max(0, Date.parse(header) - Date.now());
        if (!Number.isFinite(retryAfter)) retryAfter = 0;
      } catch (error) { lastError = error instanceof Error ? error : new Error(String(error)); }
      finally { clearTimeout(handle); if (controller === current) controller = undefined; }
      if (generation !== epoch || !enabled || destroyed) return { kind: 'cancelled' };
      const backoff = Math.max(retryAfter, Math.min(delay * 2 ** attempt, 2147483647));
      if (attempt < retries) await wait(backoff);
      else { retryAt = Date.now() + Math.max(1000, backoff); return { kind: 'retry', error: lastError }; }
    }
    return { kind: 'cancelled' };
  }
  const pruneExpired = () => {
    if (!persistent) return;
    const expired = queue.filter(raw => Date.parse(JSON.parse(raw).occurred_at) < Date.now() - retention);
    removeStored(expired);
    const expiredSet = new Set(expired); queue = queue.filter(raw => !expiredSet.has(raw));
  };
  function flush(): Promise<void> {
    if (active) return activeEpoch === generation ? active : active.catch(() => {}).then(() => flush());
    restore();
    pruneExpired();
    if (destroyed || !enabled || !queue.length) return Promise.resolve();
    clearTimer();
    const epoch = generation;
    activeEpoch = epoch;
    active = (async () => {
      await Promise.resolve(); // Assign active before fetch or user callbacks can reenter.
      if (generation !== epoch || destroyed || !enabled) return;
      if (retryAt > Date.now()) await wait(retryAt - Date.now());
      retryAt = 0;
      while (queue.length && enabled && !destroyed && generation === epoch) {
        pruneExpired();
        if (!queue.length) break;
        const events: string[] = [];
        while (queue.length && events.length < batchSize && bytes(bodyFor([...events, queue[0]!])) <= 256 * 1024) events.push(queue.shift()!);
        inFlight = events; inFlightCount = events.length;
        const result = await deliver(bodyFor(events), epoch);
        inFlight = []; inFlightCount = 0;
        if (generation !== epoch || destroyed || !enabled) break;
        if (result.kind === 'accepted' || result.kind === 'permanent') removeStored(events);
        if (result.kind === 'retry' && (persistent || serverMode)) queue.unshift(...events);
        if (result.error) report(result.error);
        if (serverMode && result.error) throw result.error;
        if (result.kind === 'retry' && persistent) break;
        if (result.kind === 'retry') retryAt = 0;
      }
    })().catch(error => { if (serverMode) throw error; report(error); }).finally(() => { active = undefined; inFlight = []; inFlightCount = 0; schedule(); });
    return active;
  }
  function validateFields(name: string, properties: Properties, options: TrackOptions): void {
    if (typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/.test(name)) throw new TypeError('Invalid event name');
    if (!properties || Array.isArray(properties) || typeof properties !== 'object') throw new TypeError('Properties must be a JSON object');
    validateJson(properties);
    const context = options.context ?? {};
    if (typeof context !== 'object' || Array.isArray(context) || (Object.getPrototypeOf(context) !== Object.prototype && Object.getPrototypeOf(context) !== null)) throw new TypeError('Context must be a plain object');
    for (const [key, value] of Object.entries(context)) {
      if (!['page_url', 'referrer', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].includes(key)) throw new TypeError('Unknown context field');
      if (value === undefined) continue;
      if (typeof value !== 'string' || value.length > (key === 'page_url' || key === 'referrer' ? 2048 : 512)) throw new TypeError('Invalid context value');
      if (key === 'page_url' || key === 'referrer') { const parsed = new URL(value); if (!['https:', 'http:'].includes(parsed.protocol)) throw new TypeError('Context URLs must use HTTP(S)'); }
    }
    for (const value of [options.anonymousId, options.userId, options.sessionId]) if (value !== undefined && (typeof value !== 'string' || value.length > 256)) throw new TypeError('Identifiers must be strings up to 256 characters');
  }
  function track(name: string, properties: Properties = {}, options: TrackOptions = {}): string | null {
    if (!enabled || destroyed) return null;
    validateFields(name, properties, options);
    const context = options.context ?? {};
    const id = globalThis.crypto.randomUUID();
    const event = JSON.stringify({ event_id: id, event_name: name, occurred_at: new Date().toISOString(), anonymous_id: options.anonymousId, user_id: options.userId, session_id: options.sessionId, properties, context });
    if (bytes(event) > 32 * 1024) throw new TypeError('Event exceeds 32 KiB');
    if (queue.length + inFlightCount >= maxQueue) { report(new Error('Analytics queue is full; event dropped')); return null; }
    queue.push(event);
    persist(event);
    if (queue.length >= batchSize) backgroundFlush(); else schedule();
    return id;
  }
  const online = () => { if (enabled && !destroyed) backgroundFlush(); };
  if (persistent && typeof window !== 'undefined') window.addEventListener('online', online);
  if (enabled) { restore(); schedule(); } else clearStored();
  return {
    track,
    page(properties, options = {}) {
      const context: EventContext = {};
      if (typeof location !== 'undefined' && /^https?:$/.test(location.protocol)) context.page_url = location.href;
      if (typeof document !== 'undefined' && document.referrer) context.referrer = document.referrer;
      return track('page_view', properties, { ...options, context: { ...context, ...options.context } });
    },
    flush,
    setEnabled(value) { enabled = value; if (!value) { generation++; queue = []; inFlight = []; inFlightCount = 0; retryAt = 0; clearTimer(); controller?.abort(); cancelWait?.(); clearStored(); } else { restore(); schedule(); } },
    destroy() { destroyed = true; retryAt = 0; generation++; queue = []; inFlight = []; inFlightCount = 0; clearTimer(); controller?.abort(); cancelWait?.(); if (persistent && typeof window !== 'undefined') window.removeEventListener('online', online); },
  };
}
