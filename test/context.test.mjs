import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnalytics } from '../dist/index.js';
import { createServerAnalytics } from '../dist/server.js';

function browser(t) {
  const window = new EventTarget();
  const saved = new Map();
  window.localStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) };
  window.location = new URL('https://shop.example/start?utm_source=email&utm_campaign=launch&utm_content=a&utm_content=b&utm_custom=custom');
  window.history = {
    pushState(_state, _title, url) { if (url != null) window.location.href = new URL(url, window.location.href).href; },
    replaceState(_state, _title, url) { if (url != null) window.location.href = new URL(url, window.location.href).href; },
  };
  Object.assign(window, { navigator: { language: 'en-US', userAgent: 'Test Browser', userAgentData: { brands: [{ brand: 'Test', version: '1' }], mobile: false, platform: 'Test OS' } }, screen: { width: 1920, height: 1080 }, devicePixelRatio: 2 });
  const values = { window, localStorage: window.localStorage, location: window.location, document: { referrer: 'https://search.example/results', title: 'Shop' } };
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  t.after(() => { for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  return window;
}
function setup(t, config = {}) {
  const events = [], errors = [];
  const client = createAnalytics({ endpoint: 'https://collect.example', sourceKey: 'pk_test_public_source_1234567890', flushIntervalMs: 0, batchSize: 100,
    fetch: async (_url, init) => { events.push(...JSON.parse(init.body).events); return new Response('{}', { status: 202 }); },
    onError: error => errors.push(error), ...config });
  t.after(() => client.destroy());
  return { client, events, errors };
}

test('flags default off even in a browser, while explicit page still captures URL and referrer', async t => {
  const window = browser(t);
  const push = window.history.pushState;
  const { client, events } = setup(t);
  window.history.pushState({}, '', '/next');
  client.track('manual');
  client.page();
  await client.flush();
  assert.equal(window.history.pushState, push);
  assert.equal(events.length, 2);
  assert.deepEqual(events[0].context, {});
  assert.deepEqual(events[1].context, { page_url: 'https://shop.example/next', referrer: 'https://search.example/results' });
});

test('autoTrack captures initial page and SPA navigation with attribution on every event', async t => {
  const window = browser(t);
  const { client, events, errors } = setup(t, { autoTrack: true });
  window.history.pushState({}, '', '/checkout');
  window.history.replaceState({}, '', '/checkout');
  client.track('checkout_started');
  await client.flush();
  assert.deepEqual(events.map(event => event.event_name), ['page_view', 'page_view', 'checkout_started']);
  assert.equal(events[1].context.page_url, 'https://shop.example/checkout');
  for (const { context } of events) {
    assert.equal(context.website, 'https://shop.example');
    assert.equal(context.utm_source, 'email');
    assert.equal(context.utm_campaign, 'launch');
    assert.equal(context.utm_content, 'b');
    assert.equal(context.referrer, 'https://search.example/results');
    assert.equal(context.userAgent, undefined);
  }
  assert.deepEqual(errors, []);
});

test('fullContext independently enriches events using browser fields', async t => {
  browser(t);
  const { client, events } = setup(t, { fullContext: true });
  client.track('manual');
  await client.flush();
  assert.equal(events.length, 1);
  const { context } = events[0];
  assert.deepEqual(context.page, { path: '/start', referrer: 'https://search.example/results', search: '?utm_source=email&utm_campaign=launch&utm_content=a&utm_content=b&utm_custom=custom', title: 'Shop', url: globalThis.location.href });
  assert.deepEqual(context.campaign, { source: 'email', name: 'launch', content: 'b', custom: 'custom' });
  assert.deepEqual(context.referrer, { url: 'https://search.example/results' });
  assert.deepEqual(context.library, { name: '@dioko/analytics', version: '0.1.0' });
  assert.equal(context.userAgent, 'Test Browser');
  assert.equal(context.locale, 'en-US');
  assert.equal(context.channel, 'browser');
  assert.deepEqual(context.screen, { width: 1920, height: 1080, density: 2 });
  assert.deepEqual(context.userAgentData, globalThis.window.navigator.userAgentData);
  assert.equal(typeof context.timezone, 'string');
});

test('default and per-event context override automatic fields and merge nested dictionaries', async t => {
  browser(t);
  const context = { app: { name: 'Shop', version: '1' }, page: { title: 'Default title' }, traits: { plan: 'team' } };
  const { client, events } = setup(t, { autoTrack: true, fullContext: true, context });
  context.app.name = 'mutated';
  client.track('checkout', {}, { context: { app: { version: '2' }, page: { title: 'Checkout' }, referrer: { type: 'campaign' }, groupId: 'company', device: { id: 'app-device' }, ip: '127.0.0.1' } });
  client.page({}, { context: { page_url: 'https://custom.example', page: { title: 'Custom' } } });
  await client.flush();
  const event = events[1];
  assert.deepEqual(event.context.app, { name: 'Shop', version: '2' });
  assert.equal(event.context.page.title, 'Checkout');
  assert.equal(event.context.page.path, '/start');
  assert.deepEqual(event.context.referrer, { url: 'https://search.example/results', type: 'campaign' });
  assert.equal(event.context.groupId, 'company');
  assert.equal(events[2].context.page_url, 'https://custom.example');
  assert.equal(events[2].context.page.title, 'Custom');
});

test('disabled autoTrack does not observe navigation; enabling records current page exactly once', async t => {
  const window = browser(t);
  const original = window.history.pushState;
  const { client, events } = setup(t, { enabled: false, autoTrack: true, fullContext: true });
  assert.equal(window.history.pushState, original);
  window.history.pushState({}, '', '/before');
  client.setEnabled(true);
  client.setEnabled(true);
  await client.flush();
  assert.equal(events.length, 1);
  assert.equal(events[0].context.page.path, '/before');
  client.setEnabled(false);
  assert.equal(window.history.pushState, original);
  window.history.pushState({}, '', '/disabled');
  await client.flush();
  assert.equal(events.length, 1);
  client.setEnabled(true);
  await client.flush();
  assert.equal(events.length, 2);
  client.destroy();
  assert.equal(window.history.pushState, original);
  client.setEnabled(true);
  window.history.pushState({}, '', '/destroyed');
  await client.flush();
  assert.equal(events.length, 2);
});

test('campaign changes replace earlier attribution and persist across later routes', async t => {
  const window = browser(t);
  const { client, events } = setup(t, { autoTrack: true, fullContext: true });
  window.history.pushState({}, '', '/new?utm_medium=social');
  window.history.pushState({}, '', '/later');
  await client.flush();
  assert.deepEqual(events[2].context.campaign, { medium: 'social' });
  assert.equal(events[2].context.utm_source, undefined);
});

test('rich context validates JSON and still enforces event size limits', t => {
  const { client } = setup(t);
  const cycle = {}; cycle.self = cycle;
  for (const context of [{ traits: cycle }, { page: { title: NaN } }, { traits: { value: undefined } }, { referrer: [] }]) {
    assert.throws(() => client.track('invalid', {}, { context }));
  }
  assert.throws(() => client.track('large', {}, { context: { traits: { value: 'x'.repeat(33000) } } }), /32 KiB/);
  assert.throws(() => setup(t, { autoTrack: 'yes' }), /booleans/);
});

test('SSR with flags does not auto-track and accepts rich supplied context', async t => {
  const { client, events } = setup(t, { autoTrack: true, fullContext: true, context: { app: { name: 'SSR' } } });
  await client.flush();
  assert.equal(events.length, 0);
  client.track('explicit');
  await client.flush();
  assert.deepEqual(events[0].context, { app: { name: 'SSR' } });
  assert.equal(events[0].anonymous_id, undefined);
});

test('server accepts supplied rich context and ignores browser flags from untyped callers', async t => {
  const events = [];
  const client = createServerAnalytics({ endpoint: 'https://collect.example', secretKey: 'sk_test_server_secret_1234567890', autoTrack: true, autoAnonymousId: true, fullContext: true, flushIntervalMs: 0,
    context: { app: { name: 'Billing' } }, fetch: async (_url, init) => { events.push(...JSON.parse(init.body).events); return new Response('{}', { status: 202 }); } });
  t.after(() => client.destroy());
  client.track('invoice.paid', {}, { context: { groupId: 'company', traits: { plan: 'team' } } });
  await client.flush();
  assert.deepEqual(events[0].context, { app: { name: 'Billing' }, groupId: 'company', traits: { plan: 'team' } });
  assert.equal(events[0].anonymous_id, undefined);
});
