import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerAnalytics } from '../dist/server.js';
const secretKey = 'sk_server_test_secret_12345678901234567890';
function setup(t, extra = {}) {
  const calls = [];
  const client = createServerAnalytics({ endpoint: 'https://collect.example', secretKey, flushIntervalMs: 0, batchSize: 100, maxRetries: 0,
    fetch: async (url, init) => { calls.push({ url, ...init }); return new Response('{}', { status: 202 }); }, ...extra });
  t.after(() => client.destroy());
  return { client, calls };
}
test('server uses a bearer credential with no browser credential or origin', async t => {
  const { client, calls } = setup(t);
  const id = client.track('purchase.completed', { amount: 100 }, { userId: 'account-1' });
  await client.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://collect.example/v1/batch');
  const headers = new Headers(calls[0].headers);
  assert.equal(headers.get('authorization'), `Bearer ${secretKey}`);
  assert.equal(headers.get('origin'), null);
  assert.equal(headers.get('content-type'), 'application/json');
  const body = JSON.parse(calls[0].body);
  assert.deepEqual(Object.keys(body), ['events']);
  assert.equal(body.events[0].event_id, id);
  assert.equal(body.events[0].user_id, 'account-1');
  assert.equal(JSON.stringify(body).includes(secretKey), false);
});
test('server rejects public keys and browser execution', () => {
  assert.throws(() => createServerAnalytics({ endpoint: 'https://collect.example', secretKey: 'pk_public_test_source_123456789' }));
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  try { assert.throws(() => createServerAnalytics({ endpoint: 'https://collect.example', secretKey }), /browser|server/i); }
  finally { if (prior) Object.defineProperty(globalThis, 'window', prior); else delete globalThis.window; }
});
test('server flush rejects transport exhaustion so applications can handle delivery failure', async t => {
  const { client } = setup(t, { fetch: async () => new Response('{}', { status: 503 }) });
  client.track('job.failed');
  await assert.rejects(client.flush());
});
test('server shutdown delivers pending events and prevents subsequent tracking', async t => {
  const { client, calls } = setup(t);
  client.track('job.completed');
  await client.shutdown();
  assert.equal(calls.length, 1);
  assert.equal(client.track('after_shutdown'), null);
});
test('server shutdown rejects on failure and still disposes the client', async t => {
  const { client } = setup(t, { fetch: async () => { throw new Error('offline'); } });
  client.track('job.completed');
  await assert.rejects(client.shutdown());
  assert.equal(client.track('after_shutdown'), null);
});
test('server retry and later flush preserve the original event identity and body', async t => {
  const bodies = [];
  let healthy = false;
  const { client } = setup(t, { maxRetries: 1, retryDelayMs: 1, fetch: async (_url, init) => { bodies.push(init.body); return new Response('{}', { status: healthy ? 202 : 503 }); } });
  client.track('durable_job');
  await assert.rejects(client.flush());
  assert.equal(bodies.length, 2);
  healthy = true;
  await client.flush();
  assert.equal(bodies.length, 3);
  assert.equal(new Set(bodies).size, 1);
});
