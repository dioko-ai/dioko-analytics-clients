import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnalytics } from '../dist/index.js';

const formId = 'form_12345678-1234-4234-8234-123456789abc';
const endpoint = `https://forms.example/v1/forms/${formId}`;
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ok = () => new Response(JSON.stringify({ submissionId: id, formId, redirectUrl: null }), { status: 201 });
const client = fetch => createAnalytics({ endpoint: 'https://analytics.example', sourceKey: 'pk_12345678901234567890', flushIntervalMs: 0, fetch });

test('immediate form request shares snapshot with event and never includes fields in event', async () => {
  const calls = []; let resolve;
  const a = client((url, init) => { calls.push([url, JSON.parse(init.body)]); return calls.length === 1 ? new Promise(r => { resolve = r; }) : Promise.resolve(new Response(null, { status: 202 })); });
  const context = { page: { title: 'Before', extra: 'discard' }, campaign: { private: 'discard' } };
  const pending = a.createForm({ endpoint }).submit({ email: 'secret' }, { submissionId: id, anonymousId: 'visitor', context });
  assert.equal(calls.length, 1); assert.equal(calls[0][0], endpoint);
  context.page.title = 'After'; resolve(ok()); await pending; await a.flush();
  const metadata = calls[0][1].metadata, event = calls[1][1].events[0];
  assert.equal(metadata.anonymous_id, 'visitor'); assert.deepEqual(metadata.context, { page: { title: 'Before' } });
  assert.deepEqual(event.context, metadata.context); assert.equal(event.anonymous_id, 'visitor');
  assert.deepEqual(event.properties, { form_id: formId, submission_id: id }); a.destroy();
});

test('disabled and revoked consent still save without a subsequent event', async () => {
  let resolve; const calls = [];
  const a = client((url, init) => { calls.push(JSON.parse(init.body)); return new Promise(r => { resolve = r; }); });
  a.setEnabled(false); const form = a.createForm({ endpoint }); const p = form.submit({ x: 1 }, { submissionId: id, anonymousId: 'ignored' });
  assert.deepEqual(calls[0].metadata, { submission_id: id }); resolve(ok()); await p;
  a.setEnabled(true); const q = form.submit({ x: 1 }, { submissionId: id }); a.setEnabled(false); resolve(ok()); await q; await a.flush(); assert.equal(calls.length, 2); a.destroy();
  await assert.rejects(form.submit({}), /destroyed/);
});

test('explicit replay emits once; errors and abort reject', async () => {
  const calls = []; const a = client(async (url, init) => { calls.push(JSON.parse(init.body)); return url === endpoint ? ok() : new Response(null, { status: 202 }); });
  const form = a.createForm({ endpoint }); await form.submit({ x: 1 }, { submissionId: id }); await form.submit({ x: 1 }, { submissionId: id }); await a.flush(); assert.equal(calls[2].events.length, 1); a.destroy();
  const b = client(async () => new Response(JSON.stringify({ error: 'Conflict' }), { status: 409 })); await assert.rejects(b.createForm({ endpoint }).submit({}, { submissionId: id }), /409.*Conflict/); b.destroy();
  const c = client(() => new Promise(() => {})); const controller = new AbortController(); const pending = c.createForm({ endpoint }).submit({}, { signal: controller.signal }); controller.abort(); await assert.rejects(pending, /aborted/); c.destroy();
  assert.throws(() => client(fetch).createForm({ endpoint: endpoint + '?x=1' }), /endpoint/);
});

test('automatic anonymous identity correlates form and analytics on a custom host', async () => {
  const priorWindow = globalThis.window, priorStorage = globalThis.localStorage;
  const values = new Map();
  globalThis.window = { location: new URL('https://site.example/'), navigator: {} };
  globalThis.localStorage = { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) };
  try {
    const calls = []; const a = createAnalytics({ endpoint: 'https://analytics.example', sourceKey: 'pk_12345678901234567890', autoAnonymousId: true, flushIntervalMs: 0, fetch: async (url, init) => { calls.push(JSON.parse(init.body)); return url === endpoint ? ok() : new Response(null, { status: 202 }); } });
    a.track('before'); await a.createForm({ endpoint }).submit({}, { submissionId: id }); await a.flush();
    assert.equal(calls[0].metadata.anonymous_id, calls[1].events[0].anonymous_id);
    assert.equal(calls[1].events[1].anonymous_id, calls[0].metadata.anonymous_id); a.destroy();
  } finally { if (priorWindow === undefined) delete globalThis.window; else globalThis.window = priorWindow; if (priorStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = priorStorage; }
});

test('form timeout rejects even when fetch ignores abort', async () => {
  const a = createAnalytics({ endpoint: 'https://analytics.example', sourceKey: 'pk_12345678901234567890', timeoutMs: 10, fetch: () => new Promise(() => {}) });
  await assert.rejects(a.createForm({ endpoint }).submit({}), /timed out/); a.destroy();
});

test('saved submission succeeds when the event queue is full or delivery fails', async () => {
  const errors = [];
  const a = createAnalytics({ endpoint: 'https://analytics.example', sourceKey: 'pk_12345678901234567890', maxQueueSize: 1, flushIntervalMs: 0, maxRetries: 0, onError: e => errors.push(e), fetch: async url => url === endpoint ? ok() : new Response(null, { status: 500 }) });
  a.track('occupy_queue');
  assert.deepEqual(await a.createForm({ endpoint }).submit({}, { submissionId: id }), { submissionId: id, formId, redirectUrl: null });
  assert.ok(errors.some(e => /queue is full/.test(e.message)));
  await a.flush();
  assert.deepEqual(await a.createForm({ endpoint }).submit({}, { submissionId: id }), { submissionId: id, formId, redirectUrl: null });
  await a.flush(); assert.ok(errors.some(e => /rejected batch/.test(e.message))); a.destroy();
});

test('rejects malformed and mismatched successful responses', async () => {
  for (const body of ['not json', JSON.stringify({ submissionId: id, formId: 'form_wrong', redirectUrl: null }), JSON.stringify({ submissionId: id, formId, redirectUrl: 42 })]) {
    const a = client(async () => new Response(body, { status: 201 }));
    await assert.rejects(a.createForm({ endpoint }).submit({}, { submissionId: id }), /Invalid form response/); a.destroy();
  }
});

test('full browser context is normalized to the backend schema and preserved for the event', async () => {
  const oldWindow = globalThis.window, oldDocument = globalThis.document;
  globalThis.window = { location: new URL('https://site.example/path?utm_source=search'), navigator: { language: 'en', userAgent: 'test' }, screen: { width: 100, height: 200 }, devicePixelRatio: 2 };
  globalThis.document = { referrer: 'https://referrer.example/path', title: 'Page' };
  try {
    const calls = []; const a = createAnalytics({ endpoint: 'https://analytics.example', sourceKey: 'pk_12345678901234567890', fullContext: true, flushIntervalMs: 0, fetch: async (url, init) => { calls.push(JSON.parse(init.body)); return url === endpoint ? ok() : new Response(null, { status: 202 }); } });
    await a.createForm({ endpoint }).submit({}, { submissionId: id }); await a.flush();
    const context = calls[0].metadata.context;
    assert.equal(context.referrer, 'https://referrer.example/path'); assert.equal(context.page.referrer, context.referrer);
    assert.equal(context.utm_source, 'search'); assert.equal(context.campaign, undefined);
    assert.deepEqual(context, calls[1].events[0].context); a.destroy();
  } finally { if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow; if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument; }
});
