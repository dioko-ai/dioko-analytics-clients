import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { createAnalytics } from '../dist/index.js';
import { AnalyticsProvider, useAnalytics } from '../dist/react.js';

test('React provider exposes supplied client and SSR never records an event', async () => {
  let requests = 0;
  const client = createAnalytics({ endpoint: 'https://collect.example', sourceKey: 'pk_test_public_source_1234567890', flushIntervalMs: 0,
    fetch: async () => { requests++; return new Response('{}', { status: 202 }); } });
  try {
    function Child() { assert.equal(useAnalytics(), client); return React.createElement('span', null, 'ready'); }
    const element = React.createElement(React.StrictMode, null, React.createElement(AnalyticsProvider, { client }, React.createElement(Child)));
    assert.equal(renderToString(element), '<span>ready</span>');
    assert.equal(renderToString(element), '<span>ready</span>');
    await client.flush();
    assert.equal(requests, 0);
  } finally { client.destroy(); }
});

test('hook outside provider reports an actionable error', () => {
  function Child() { useAnalytics(); return null; }
  assert.throws(() => renderToString(React.createElement(Child)), /AnalyticsProvider/);
});
