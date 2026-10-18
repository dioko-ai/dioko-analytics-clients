import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnalytics } from '../dist/index.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function browser(t) {
  const entries = new Map();
  const storage = {
    get length() { return entries.size; },
    key: index => [...entries.keys()][index] ?? null,
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: key => entries.delete(key),
  };
  const window = new EventTarget();
  Object.assign(window, { localStorage: storage, location: new URL('https://shop.example/start'), history: { pushState() {}, replaceState() {} } });
  const previous = new Map();
  for (const [key, value] of Object.entries({ window, localStorage: storage })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  t.after(() => { for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  return { window, storage, entries };
}
function setup(t, extra = {}) {
  const events = [], errors = [];
  const client = createAnalytics({ endpoint: 'https://collect.example', sourceKey: 'pk_test_public_source_1234567890',
    flushIntervalMs: 0, batchSize: 100, maxRetries: 0,
    fetch: async (_url, init) => { events.push(...JSON.parse(init.body).events); return new Response('{}', { status: 202 }); },
    onError: error => errors.push(error), ...extra });
  t.after(() => client.destroy());
  return { client, events, errors };
}
async function track(result, options) {
  result.client.track('manual', {}, options);
  await result.client.flush();
  return result.events.at(-1);
}

test('identity defaults off and does not even access browser storage', async t => {
  const { window } = browser(t);
  let accesses = 0;
  for (const target of [window, globalThis]) Object.defineProperty(target, 'localStorage', { configurable: true, get() { accesses++; throw new Error('must not access'); } });
  const result = setup(t);
  assert.equal((await track(result)).anonymous_id, undefined);
  assert.equal(accesses, 0);
  assert.deepEqual(result.errors, []);
});

test('enabled identity is lazy, stable across events and reloads, and independent of queue persistence', async t => {
  const { entries } = browser(t);
  const first = setup(t, { autoAnonymousId: true });
  assert.equal(entries.size, 0);
  const id = (await track(first)).anonymous_id;
  assert.match(id, uuid);
  assert.equal((await track(first)).anonymous_id, id);
  assert.equal(entries.size, 1, 'identity persists even when queue persistence is off');
  first.client.destroy();
  const second = setup(t, { autoAnonymousId: true });
  assert.equal((await track(second)).anonymous_id, id);
});

test('explicit per-event identity neither creates nor replaces the stored default', async t => {
  const { entries } = browser(t);
  const result = setup(t, { autoAnonymousId: true });
  assert.equal((await track(result, { anonymousId: 'caller-first' })).anonymous_id, 'caller-first');
  assert.equal(entries.size, 0);
  const generated = (await track(result)).anonymous_id;
  assert.equal((await track(result, { anonymousId: 'caller-second' })).anonymous_id, 'caller-second');
  assert.equal((await track(result)).anonymous_id, generated);
  assert.deepEqual([...entries.values()], [generated]);
});

test('endpoint, source, and storageKey independently isolate anonymous identities', async t => {
  browser(t);
  const configs = [{}, { endpoint: 'https://other.example' }, { sourceKey: 'pk_another_public_source_123456789' }, { storageKey: 'custom' }];
  const ids = [];
  for (const config of configs) ids.push((await track(setup(t, { autoAnonymousId: true, ...config }))).anonymous_id);
  assert.equal(new Set(ids).size, configs.length);
  for (const [index, config] of configs.entries()) assert.equal((await track(setup(t, { autoAnonymousId: true, ...config }))).anonymous_id, ids[index]);
});

test('disabled collection leaves identity storage unread and resumes with a fresh identity', async t => {
  const { entries, storage } = browser(t);
  const old = setup(t, { autoAnonymousId: true });
  const oldId = (await track(old)).anonymous_id;
  old.client.destroy();
  let reads = 0;
  const getItem = storage.getItem;
  storage.getItem = key => { reads++; return getItem(key); };
  const next = setup(t, { autoAnonymousId: true, enabled: false });
  assert.equal(reads, 0);
  assert.equal(next.client.track('disabled'), null);
  assert.equal(entries.size, 0);
  next.client.setEnabled(true);
  const fresh = (await track(next)).anonymous_id;
  assert.match(fresh, uuid);
  assert.notEqual(fresh, oldId);
  next.client.setEnabled(false);
  assert.equal(entries.size, 0);
  next.client.setEnabled(true);
  assert.notEqual((await track(next)).anonymous_id, fresh);
});

test('autoTrack forces identity on even when autoAnonymousId is explicitly false', async t => {
  browser(t);
  const result = setup(t, { autoTrack: true, autoAnonymousId: false });
  await result.client.flush();
  assert.equal(result.events[0].event_name, 'page_view');
  assert.match(result.events[0].anonymous_id, uuid);
  assert.equal((await track(result)).anonymous_id, result.events[0].anonymous_id);
});

for (const failure of ['unavailable', 'getter', 'read', 'write']) {
  test(`identity uses stable memory fallback and reports ${failure} storage`, async t => {
    const { window, storage } = browser(t);
    if (failure === 'unavailable') { delete window.localStorage; delete globalThis.localStorage; }
    if (failure === 'getter') for (const target of [window, globalThis]) Object.defineProperty(target, 'localStorage', { configurable: true, get() { throw new Error('blocked'); } });
    if (failure === 'read') storage.getItem = () => { throw new Error('read blocked'); };
    if (failure === 'write') storage.setItem = () => { throw new Error('quota'); };
    const result = setup(t, { autoAnonymousId: true });
    const id = (await track(result)).anonymous_id;
    assert.match(id, uuid);
    assert.equal((await track(result)).anonymous_id, id);
    assert.ok(result.errors.length > 0);
    result.client.setEnabled(false);
    result.client.setEnabled(true);
    assert.notEqual((await track(result)).anonymous_id, id);
  });
}

test('identity survives durable queue acceptance and restored events retain their identity', async t => {
  const { entries } = browser(t);
  const first = setup(t, { autoAnonymousId: true, storage: 'localStorage' });
  first.client.track('persisted');
  assert.equal(entries.size, 2);
  first.client.destroy();
  const second = setup(t, { autoAnonymousId: true, storage: 'localStorage' });
  await second.client.flush();
  const restored = second.events[0];
  assert.match(restored.anonymous_id, uuid);
  assert.equal(entries.size, 1, 'successful queue delivery preserves identity');
  assert.equal((await track(second)).anonymous_id, restored.anonymous_id);
  second.client.setEnabled(false);
  assert.equal(entries.size, 0);
});

test('SSR never generates anonymous identity and rejects nonboolean configuration', async t => {
  const result = setup(t, { autoAnonymousId: true });
  assert.equal((await track(result)).anonymous_id, undefined);
  assert.deepEqual(result.errors, []);
  for (const value of ['true', 1, null]) assert.throws(() => setup(t, { autoAnonymousId: value }), /boolean/i);
});
