import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnalytics } from '../dist/index.js';

const sourceKey = 'pk_test_public_source_1234567890';
function setup(t, extra = {}) {
  const calls = [];
  const errors = [];
  const client = createAnalytics({ endpoint: 'https://collect.example', sourceKey,
    flushIntervalMs: 0, batchSize: 100, retryDelayMs: 1,
    fetch: async (url, init) => { calls.push({ url, ...init }); return new Response('{}', { status: 202 }); },
    onError: error => errors.push(error), ...extra });
  t.after(() => client.destroy());
  return { client, calls, errors };
}

test('uses the browser collector contract and snapshots caller-owned data', async t => {
  const { client, calls } = setup(t);
  const properties = { count: 1, nested: { value: 'before' } };
  const id = client.track('checkout.started', properties, { anonymousId: 'anon', userId: 'user', sessionId: 'session', context: { utm_source: 'newsletter' } });
  properties.nested.value = 'after';
  await client.flush();
  assert.equal(calls.length, 1);
  assert.equal(String(calls[0].url), 'https://collect.example/v1/batch');
  assert.equal(calls[0].method, 'POST');
  assert.equal(new Headers(calls[0].headers).get('content-type'), 'application/json');
  assert.equal(calls[0].credentials, 'omit');
  const body = JSON.parse(calls[0].body);
  assert.deepEqual(Object.keys(body).sort(), ['events', 'source_key']);
  assert.equal(body.source_key, sourceKey);
  const event = body.events[0];
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(event.event_id, id);
  assert.equal(event.event_name, 'checkout.started');
  assert.equal(event.anonymous_id, 'anon');
  assert.equal(event.user_id, 'user');
  assert.equal(event.session_id, 'session');
  assert.equal(event.properties.nested.value, 'before');
  assert.deepEqual(event.context, { utm_source: 'newsletter' });
  assert.ok(Math.abs(Date.now() - Date.parse(event.occurred_at)) < 5000);
});

test('enforces UTF-8 event and batch byte limits while retaining all accepted events', async t => {
  const { client, calls } = setup(t);
  assert.throws(() => client.track('large', { value: '😀'.repeat(9000) }));
  const ids = Array.from({ length: 25 }, () => client.track('large', { value: '😀'.repeat(7000) }));
  await client.flush();
  const delivered = calls.flatMap(call => {
    assert.ok(Buffer.byteLength(call.body, 'utf8') <= 256 * 1024);
    const body = JSON.parse(call.body);
    assert.ok(body.events.length <= 100);
    for (const event of body.events) assert.ok(Buffer.byteLength(JSON.stringify(event)) <= 32 * 1024);
    return body.events.map(event => event.event_id);
  });
  assert.deepEqual(delivered, ids);
  assert.ok(calls.length >= 3);
});

test('retryable failures reuse the exact body and stable IDs', async t => {
  const requests = [];
  const { client } = setup(t, { fetch: async (_url, init) => {
    requests.push(init.body);
    if (requests.length === 1) throw new TypeError('network interrupted');
    return new Response('{}', { status: requests.length === 2 ? 503 : 202 });
  } });
  client.track('retry');
  await client.flush();
  assert.equal(requests.length, 3);
  assert.equal(new Set(requests).size, 1);
});

test('permanent errors are reported without retries and do not block future events', async t => {
  let attempts = 0;
  const { client, errors } = setup(t, { fetch: async () => new Response('{}', { status: ++attempts === 1 ? 401 : 202 }) });
  client.track('first');
  await client.flush();
  assert.equal(attempts, 1);
  assert.ok(errors.length >= 1);
  client.track('second');
  await client.flush();
  assert.equal(attempts, 2);
});

test('disabled clients discard pending events and require explicit reenable', async t => {
  const { client, calls } = setup(t);
  client.track('discarded');
  client.setEnabled(false);
  assert.equal(client.track('disabled'), null);
  await client.flush();
  assert.equal(calls.length, 0);
  client.setEnabled(true);
  client.track('enabled');
  await client.flush();
  assert.deepEqual(JSON.parse(calls[0].body).events.map(event => event.event_name), ['enabled']);
});

test('construction and page calls work without browser globals and create no automatic events', async t => {
  const { client, calls } = setup(t);
  await client.flush();
  assert.equal(calls.length, 0);
  client.page({ section: 'pricing' });
  await client.flush();
  assert.equal(JSON.parse(calls[0].body).events[0].event_name, 'page_view');
});

test('rejects invalid names, non-JSON properties, unknown context, and secrets', t => {
  const { client } = setup(t);
  for (const name of ['', '1event', 'event with spaces', 'a'.repeat(121)]) assert.throws(() => client.track(name));
  assert.throws(() => client.track('event', { value: BigInt(1) }));
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => client.track('event', cycle));
  assert.throws(() => client.track('event', {}, { context: { ip: '127.0.0.1' } }));
  assert.throws(() => createAnalytics({ endpoint: 'https://collect.example', sourceKey: 'sk_secret_never_in_browser_123' }));
});

test('destroy drops events and prevents later delivery', async t => {
  const { client, calls } = setup(t);
  client.track('discarded');
  client.destroy();
  assert.equal(client.track('later'), null);
  await client.flush();
  assert.equal(calls.length, 0);
});

test('rate limits honor Retry-After and preserve payload', async t => {
  const requests = [];
  const times = [];
  const { client } = setup(t, { fetch: async (_url, init) => {
    requests.push(init.body); times.push(Date.now());
    return new Response('{}', { status: requests.length === 1 ? 429 : 202, headers: { 'Retry-After': '1' } });
  } });
  client.track('rate_limited');
  await client.flush();
  assert.equal(requests.length, 2);
  assert.equal(requests[0], requests[1]);
  assert.ok(times[1] - times[0] >= 950, 'must honor the server retry interval');
});

test('opt-out aborts in-flight requests and suppresses retries', async t => {
  let signal;
  let attempts = 0;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const { client } = setup(t, { fetch: async (_url, init) => {
    attempts++; signal = init.signal; started();
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } });
  client.track('pending');
  const flushed = client.flush();
  await ready;
  client.setEnabled(false);
  await flushed;
  assert.equal(signal.aborted, true);
  assert.equal(attempts, 1);
});

test('queue bounds include in-flight events and reject overflow visibly', async t => {
  let finish;
  const { client, errors } = setup(t, { maxQueueSize: 2, fetch: () => new Promise(resolve => { finish = resolve; }) });
  assert.ok(client.track('one'));
  const flushing = client.flush();
  await Promise.resolve();
  assert.ok(client.track('two'));
  assert.equal(client.track('overflow'), null);
  assert.ok(errors.length);
  client.setEnabled(false);
  finish(new Response('{}', { status: 202 }));
  await flushing;
});

test('a flush after immediate reenable delivers only the new generation', async t => {
  const bodies = [];
  const { client } = setup(t, { fetch: async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    if (bodies.length === 1) return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    return new Response('{}', { status: 202 });
  } });
  client.track('old');
  const previous = client.flush();
  await Promise.resolve();
  client.setEnabled(false);
  client.setEnabled(true);
  client.track('new');
  await client.flush();
  await previous;
  assert.deepEqual(bodies.map(body => body.events.map(event => event.event_name)), [['old'], ['new']]);
});

test('timeouts terminate even a non-cooperating fetch and retries are bounded', async t => {
  let attempts = 0;
  const signals = [];
  const { client, errors } = setup(t, { timeoutMs: 5, maxRetries: 2,
    fetch: async (_url, init) => { attempts++; signals.push(init.signal); return new Promise(() => {}); } });
  client.track('timeout');
  await client.flush();
  assert.equal(attempts, 3);
  assert.ok(signals.every(signal => signal.aborted));
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /abort|time/i);
});

test('partial batches automatically flush after the configured interval', async t => {
  let delivered;
  const arrived = new Promise(resolve => { delivered = resolve; });
  const deadline = setTimeout(() => delivered(null), 1000);
  t.after(() => clearTimeout(deadline));
  const { client } = setup(t, { flushIntervalMs: 10,
    fetch: async (_url, init) => { delivered(JSON.parse(init.body)); return new Response('{}', { status: 202 }); } });
  client.track('automatic');
  const body = await arrived;
  assert.ok(body, 'partial batch should arrive before the deadline');
  assert.equal(body.events[0].event_name, 'automatic');
});
