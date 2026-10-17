import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnalytics } from '../dist/index.js';
const sourceKey = 'pk_test_public_source_1234567890';
class MemoryStorage {
  entries = new Map();
  get length() { return this.entries.size; }
  key(index) { return [...this.entries.keys()][index] ?? null; }
  getItem(key) { return this.entries.get(String(key)) ?? null; }
  setItem(key, value) { this.entries.set(String(key), String(value)); }
  removeItem(key) { this.entries.delete(String(key)); }
  clear() { this.entries.clear(); }
}
function environment(t, storage = new MemoryStorage()) {
  const window = new EventTarget();
  window.localStorage = storage;
  const previous = new Map();
  for (const [key, value] of Object.entries({ window, localStorage: storage })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  t.after(() => { for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  return { storage, window };
}
function setup(t, extra = {}) {
  const calls = [], errors = [];
  const client = createAnalytics({ endpoint: 'https://collect.example', sourceKey, storage: 'localStorage', flushIntervalMs: 0, batchSize: 100, maxRetries: 0,
    fetch: async (_url, init) => { calls.push(init); return new Response('{}', { status: 202 }); }, onError: error => errors.push(error), ...extra });
  t.after(() => client.destroy());
  return { client, calls, errors };
}
test('opt-in queue survives reload with its original ID, timestamp, and properties', async t => {
  const { storage } = environment(t);
  const first = setup(t);
  const id = first.client.track('persisted', { value: 'original' });
  assert.ok(storage.length > 0);
  const stored = [...storage.entries.values()].join('');
  first.client.destroy();
  assert.ok(storage.length > 0);
  const second = setup(t);
  await second.client.flush();
  const event = JSON.parse(second.calls[0].body).events[0];
  assert.equal(event.event_id, id);
  assert.ok(stored.includes(event.occurred_at));
  assert.deepEqual(event.properties, { value: 'original' });
  assert.equal(storage.length, 0);
});
test('failed delivery preserves durable queue while later success removes it', async t => {
  const { storage } = environment(t);
  let online = false;
  const bodies = [];
  const { client } = setup(t, { fetch: async (_url, init) => { bodies.push(init.body); return new Response('{}', { status: online ? 202 : 503 }); } });
  client.track('retry_later');
  await client.flush();
  assert.ok(storage.length > 0);
  online = true;
  await client.flush();
  assert.equal(storage.length, 0);
  assert.deepEqual(bodies, [bodies[0], bodies[0]]);
});
test('persistence is opt-in and normal clients never write browser storage', async t => {
  const { storage } = environment(t);
  const { client } = setup(t, { storage: undefined });
  client.track('memory_only');
  assert.equal(storage.length, 0);
  await client.flush();
});
test('disabling clears stored events and disabled construction never restores them', async t => {
  const { storage } = environment(t);
  const first = setup(t);
  first.client.track('before_consent_revoked');
  first.client.destroy();
  let storedReads = 0;
  const getItem = storage.getItem.bind(storage);
  storage.getItem = key => { storedReads++; return getItem(key); };
  const second = setup(t, { enabled: false });
  assert.equal(storedReads, 0, 'disabled construction must not read saved event content');
  await second.client.flush();
  assert.equal(second.calls.length, 0);
  second.client.setEnabled(true);
  await second.client.flush();
  assert.equal(second.calls.length, 0);
  second.client.track('after_consent');
  assert.ok(storage.length > 0);
  second.client.setEnabled(false);
  assert.equal(storage.length, 0);
});
test('storage quota failure is reported and events can still be delivered from memory', async t => {
  const storage = new MemoryStorage();
  storage.setItem = () => { throw new Error('QuotaExceededError'); };
  environment(t, storage);
  const { client, calls, errors } = setup(t);
  assert.ok(client.track('quota'));
  await client.flush();
  assert.equal(calls.length, 1);
  assert.ok(errors.length > 0);
});
test('a throwing localStorage getter does not break tracking', async t => {
  const { window } = environment(t);
  Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('storage blocked'); } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('storage blocked'); } });
  const { client, calls } = setup(t);
  assert.ok(client.track('blocked_storage'));
  await client.flush();
  assert.equal(calls.length, 1);
});
test('corrupt saved records are discarded safely without dropping unrelated storage', async t => {
  const { storage } = environment(t);
  const first = setup(t);
  first.client.track('valid');
  first.client.destroy();
  for (const key of storage.entries.keys()) storage.setItem(key, '{invalid-json');
  storage.setItem('other-application', 'keep');
  const second = setup(t);
  await second.client.flush();
  assert.equal(second.calls.length, 0);
  assert.equal(storage.getItem('other-application'), 'keep');
});
test('retention expires old events before restoration', async t => {
  const { storage } = environment(t);
  const first = setup(t, { retentionMs: 1 });
  first.client.track('expired');
  first.client.destroy();
  await new Promise(resolve => setTimeout(resolve, 10));
  const second = setup(t, { retentionMs: 1 });
  await second.client.flush();
  assert.equal(second.calls.length, 0);
  assert.equal(storage.length, 0);
});
test('concurrent clients cannot overwrite or delete another client newly queued event', async t => {
  const { storage } = environment(t);
  let finish, started;
  const ready = new Promise(resolve => { started = resolve; });
  const one = setup(t, { fetch: async () => { started(); return new Promise(resolve => { finish = resolve; }); } });
  const two = setup(t);
  const firstId = one.client.track('tab_one');
  const flushing = one.client.flush();
  await ready;
  const secondId = two.client.track('tab_two');
  finish(new Response('{}', { status: 202 }));
  await flushing;
  assert.ok([...storage.entries.values()].join('').includes(secondId));
  assert.equal([...storage.entries.values()].join('').includes(firstId), false);
  await two.client.flush();
  assert.equal(storage.length, 0);
});
test('collector/source namespaces isolate stored queues', async t => {
  const { storage } = environment(t);
  const one = setup(t);
  const firstId = one.client.track('source_one');
  one.client.destroy();
  const two = setup(t, { sourceKey: 'pk_another_public_source_123456789' });
  await two.client.flush();
  assert.equal(two.calls.length, 0);
  two.client.setEnabled(false);
  assert.ok([...storage.entries.values()].join('').includes(firstId));
});
test('online events retry previously failed durable delivery', async t => {
  const { window } = environment(t);
  let online = false, delivered;
  const result = new Promise(resolve => { delivered = resolve; });
  const deadline = setTimeout(() => delivered(false), 3000);
  t.after(() => clearTimeout(deadline));
  const { client } = setup(t, { fetch: async () => { if (online) delivered(true); return new Response('{}', { status: online ? 202 : 503 }); } });
  client.track('offline');
  await client.flush();
  online = true;
  window.dispatchEvent(new Event('online'));
  assert.equal(await result, true);
});
test('scheduled flush retries durable delivery after failures', async t => {
  environment(t);
  let attempts = 0, delivered;
  const result = new Promise(resolve => { delivered = resolve; });
  const deadline = setTimeout(() => delivered(false), 3000);
  t.after(() => clearTimeout(deadline));
  const { client } = setup(t, { flushIntervalMs: 10, fetch: async () => { attempts++; if (attempts > 1) delivered(true); return new Response('{}', { status: attempts > 1 ? 202 : 503 }); } });
  client.track('eventual');
  assert.equal(await result, true);
  assert.equal(attempts, 2);
});
test('in-flight events remain persisted until collector acceptance', async t => {
  const { storage } = environment(t);
  let finish, started;
  const ready = new Promise(resolve => { started = resolve; });
  const { client } = setup(t, { fetch: async () => { started(); return new Promise(resolve => { finish = resolve; }); } });
  const id = client.track('in_flight');
  const flushing = client.flush();
  await ready;
  assert.ok([...storage.entries.values()].join('').includes(id));
  finish(new Response('{}', { status: 202 }));
  await flushing;
  assert.equal(storage.length, 0);
});
test('malformed persisted event cannot poison an otherwise valid restored batch', async t => {
  const { storage } = environment(t);
  const first = setup(t);
  const badId = first.client.track('bad');
  const goodId = first.client.track('good');
  first.client.destroy();
  const badKey = [...storage.entries.keys()].find(key => key.endsWith(badId));
  const malformed = JSON.parse(storage.getItem(badKey));
  malformed.event_name = 'invalid event name';
  malformed.context = { forbidden: 'value' };
  storage.setItem(badKey, JSON.stringify(malformed));
  const second = setup(t);
  await second.client.flush();
  assert.equal(second.calls.length, 1);
  assert.deepEqual(JSON.parse(second.calls[0].body).events.map(event => event.event_id), [goodId]);
  assert.equal(storage.length, 0);
});
test('an existing client expires old memory events while delivering fresh events', async t => {
  const { storage } = environment(t);
  const { client, calls } = setup(t, { retentionMs: 30 });
  client.track('stale');
  await new Promise(resolve => setTimeout(resolve, 50));
  const id = client.track('fresh');
  await client.flush();
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].body).events.map(event => event.event_id), [id]);
  assert.equal(storage.length, 0);
});
test('invalid persisted timestamp and null context do not reach the collector', async t => {
  const { storage } = environment(t);
  const first = setup(t);
  const malformedTimestampId = first.client.track('timestamp');
  const nullContextId = first.client.track('context');
  const goodId = first.client.track('valid');
  first.client.destroy();
  for (const [key, value] of storage.entries) {
    const event = JSON.parse(value);
    if (event.event_id === malformedTimestampId) event.occurred_at = new Date().toDateString();
    if (event.event_id === nullContextId) event.context = null;
    storage.setItem(key, JSON.stringify(event));
  }
  const second = setup(t);
  await second.client.flush();
  assert.equal(second.calls.length, 1);
  assert.deepEqual(JSON.parse(second.calls[0].body).events.map(event => event.event_id), [goodId]);
});
test('destroy immediately after a deferred retry flush does not leave a cooldown wait', async t => {
  environment(t);
  const { client } = setup(t, { fetch: async () => new Response('{}', { status: 429, headers: { 'Retry-After': '60' } }) });
  client.track('rate_limited');
  await client.flush();
  const retry = client.flush();
  client.destroy();
  let deadline;
  try {
    const outcome = await Promise.race([retry.then(() => 'settled'), new Promise(resolve => { deadline = setTimeout(() => resolve('timeout'), 100); })]);
    assert.equal(outcome, 'settled');
  } finally { clearTimeout(deadline); client.destroy(); }
});
