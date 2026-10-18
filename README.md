# Dioko Analytics

Browser and backend analytics with TypeScript support and React bindings. Track page views, product events, campaign attribution, and customer context with one client library.

## Install

```sh
npm install @dioko/analytics
```

## Browser quick start

Create a browser source in your Dioko dashboard, add your website's origin, and initialize the client once:

```ts
import { createAnalytics } from '@dioko/analytics';

export const analytics = createAnalytics({
  endpoint: 'https://analytics.example.com',
  sourceKey: 'pk_YOUR_PUBLIC_SOURCE_KEY',
  autoTrack: true,
  fullContext: true,
});

analytics.track('signup_started', { plan: 'team' });
```

`autoTrack` records the initial page view and subsequent URL changes, including single-page app navigation through `pushState`, `replaceState`, back/forward navigation, and hash changes. Repeated navigation to the same URL does not create another automatic page view. It also assigns a persistent anonymous visitor ID and adds website, page URL, referrer, and UTM attribution to every event.

`fullContext` adds detailed browser context to every event. The two flags are independent and default to `false`, so you can choose automatic page tracking, richer context, or both.

The client is bundled with your application and sends events directly to your collector. Use your public `pk_` source key in the browser. If your site uses a Content Security Policy, include your collector in `connect-src`.

## Page views and attribution

With `autoTrack: true`, events include these context fields:

| Field | Value |
| --- | --- |
| `website` | Current website origin, such as `https://example.com` |
| `page_url` | Current page URL, including query and fragment |
| `referrer` | Document referrer when available |
| `utm_source` | Campaign source |
| `utm_medium` | Campaign medium |
| `utm_campaign` | Campaign name |
| `utm_term` | Campaign keyword |
| `utm_content` | Campaign content |

Campaign attribution stays in memory across navigation for the client's lifetime. A URL containing new UTM parameters replaces the previous campaign. Reloading the page starts attribution from the new page URL.

To control page tracking through your router, leave `autoTrack` off and call `page()` after navigation:

```ts
analytics.page({ section: 'pricing' });
```

Manual `page()` calls record a `page_view` event and capture the current URL and document referrer. You can also call `page()` with `autoTrack` enabled to record an additional view explicitly.

## Anonymous visitor IDs

`autoTrack: true` automatically enables anonymous visitor IDs. To assign IDs without automatic page tracking, enable `autoAnonymousId` on its own:

```ts
const analytics = createAnalytics({
  endpoint: 'https://analytics.example.com',
  sourceKey: 'pk_YOUR_PUBLIC_SOURCE_KEY',
  autoAnonymousId: true,
});

analytics.track('signup_started');
```

The browser generates a UUID and attaches it as `anonymous_id` to events, including automatic page views. The ID is saved in localStorage across reloads and client instances, scoped by collector URL, source key, and `storageKey`. This works independently of pending-event persistence. If browser storage is unavailable, the client keeps the ID in memory and reports storage errors through `onError`.

An explicit event option such as `{ anonymousId: 'visitor-456' }` overrides the ID for that event without changing the saved visitor ID. With `autoTrack: true`, anonymous IDs stay enabled even if `autoAnonymousId` is `false`. With both options off, events only include anonymous IDs supplied by your application. `fullContext` alone does not enable IDs.

No ID is created or read while the client is disabled or during server rendering. `setEnabled(false)` clears the saved ID; resuming collection creates a new one. `destroy()` preserves the ID for the next browser client. The server client accepts application-supplied IDs and does not generate browser visitor IDs.

## Full context

Enable `fullContext: true` to attach structured browser context:

| Field | Automatically captured |
| --- | --- |
| `page` | `url`, `path`, `search`, `title`, `referrer` |
| `campaign` | UTM parameters, with `utm_campaign` mapped to `name`; custom UTM parameters are included |
| `library` | Package name and version |
| `locale` | Browser language |
| `userAgent` | Browser user agent |
| `userAgentData` | Brands, mobile status, and platform when the browser exposes Client Hints |
| `screen` | Width, height, and pixel density |
| `timezone` | IANA timezone when available |
| `channel` | `browser` |
| `referrer` | `{ url }` when a document referrer is available |

Full context also includes the flat website, page URL, and UTM fields. In this mode, `referrer` is an object containing `url`; the referrer string is available at `page.referrer`.

Add application-specific context at initialization or per event:

```ts
const analytics = createAnalytics({
  endpoint: 'https://analytics.example.com',
  sourceKey: 'pk_YOUR_PUBLIC_SOURCE_KEY',
  autoTrack: true,
  fullContext: true,
  context: {
    app: { name: 'Storefront', version: '2.1.0' },
  },
});

analytics.track('checkout_started', { items: 2 }, {
  userId: 'customer-123',
  anonymousId: 'visitor-456',
  sessionId: 'session-789',
  context: {
    groupId: 'company-123',
    traits: { plan: 'team' },
    page: { title: 'Checkout' },
  },
});
```

Per-event values override initialization values, which override automatic context. Nested dictionaries merge one level deep, so overriding `page.title` keeps the captured page URL and path. Context supports `app`, `device`, `network`, `os`, `traits`, `ip`, and custom JSON fields. Supply fields that your application owns; browser collection does not infer device identifiers or make an external IP lookup.

## React

Use the same client throughout your application:

```tsx
import { AnalyticsProvider, useAnalytics } from '@dioko/analytics/react';
import { analytics } from './analytics';

function SignupButton() {
  const analytics = useAnalytics();
  return (
    <button onClick={() => analytics.track('signup_started')}>
      Sign up
    </button>
  );
}

export function App() {
  return (
    <AnalyticsProvider client={analytics}>
      <SignupButton />
    </AnalyticsProvider>
  );
}
```

Create the client once outside component rendering. With `autoTrack: true`, navigation tracking works independently of the provider. The provider supplies the client through React context; your application owns its lifetime. React is an optional peer dependency for the `/react` entry point.

For server-rendered applications, initialize the browser client in your browser entry point. Package imports and provider rendering work during server rendering; automatic browser collection starts when the client is created in a browser.

## Backend TypeScript

Create a server source in the Dioko dashboard and store its secret in your environment:

```ts
import { createServerAnalytics } from '@dioko/analytics/server';

const analytics = createServerAnalytics({
  endpoint: 'https://analytics.example.com',
  secretKey: process.env.DIOKO_ANALYTICS_SECRET!,
  context: { app: { name: 'Billing' } },
});

analytics.track('invoice.paid', { amount: 4900, currency: 'USD' }, {
  userId: 'customer-123',
});

await analytics.flush();
```

Reuse one client per backend process and provide user/session identifiers per event. The server client authenticates with a bearer header and supports application-supplied context. Automatic browser tracking and browser storage are browser-client options.

Await `flush()` before a job or serverless handler finishes. At application shutdown, use `await analytics.shutdown()` to flush and release the client. Server `flush()` rejects on delivery failure. Retryable failures retain events in memory for a later flush; permanent rejections discard that batch. `shutdown()` releases the client after attempting the final flush and propagates delivery errors.

## Event delivery and storage

The client batches events and retries network errors, rate limits, and server errors. Event IDs and payloads stay the same during retries.

Enable browser persistence to retain pending events across reloads:

```ts
const analytics = createAnalytics({
  endpoint: 'https://analytics.example.com',
  sourceKey: 'pk_YOUR_PUBLIC_SOURCE_KEY',
  autoTrack: true,
  storage: 'localStorage',
  onError: (error) => console.warn('Analytics delivery failed', error),
});
```

Pending events remain in localStorage until delivery or expiry. The client retries on its timer and when the browser comes online. Storage is scoped by collector URL, source key, and optional `storageKey`. Multiple tabs keep separate event records; duplicate delivery uses the original event IDs for collector deduplication.

The default queue is in memory. Use a backend outbox when events need to survive process restarts. Browser persistence depends on available browser storage; storage errors are reported through `onError` and collection continues in memory.

## Configuration

| Option | Default | Description |
| --- | --- | --- |
| `endpoint` | Required | Collector origin or `/v1/batch` URL |
| `sourceKey` | Required in browser | Public browser source key |
| `secretKey` | Required on server | Server source secret; use the `/server` entry point |
| `autoTrack` | `false` | Browser: automatic page views, anonymous visitor IDs, and website/referrer/UTM capture |
| `autoAnonymousId` | `false` | Browser: persistent anonymous visitor IDs; always enabled by `autoTrack` |
| `fullContext` | `false` | Browser: detailed context on all events |
| `context` | `{}` | Default event context |
| `enabled` | `true` | Whether the client collects and delivers events |
| `batchSize` | Browser `20`, server `100` | Flush threshold and maximum events per request (1–100) |
| `flushIntervalMs` | `5000` | Partial-batch delay; `0` disables this timer; retained failures still schedule retries |
| `maxQueueSize` | `1000` | Maximum queued and in-flight events |
| `maxRetries` | `3` | Additional delivery attempts |
| `retryDelayMs` | `1000` | Initial exponential backoff; collector `Retry-After` is honored |
| `timeoutMs` | `10000` | Timeout per request |
| `storage` | In memory | Browser: `'localStorage'` retains pending events across reloads |
| `storageKey` | `'dioko-analytics'` | Browser storage namespace prefix |
| `retentionMs` | `604800000` (7 days) | Persisted-event lifetime, up to 30 days |
| `onError` | — | Delivery, storage, and automatic collection error callback |
| `fetch` | Global Fetch | Custom Fetch implementation |

## Client methods

| Method | Behavior |
| --- | --- |
| `track(name, properties?, options?)` | Queue an event; return its UUID, or `null` when disabled, destroyed, or full |
| `page(properties?, options?)` | Browser: queue a `page_view` event |
| `flush()` | Send pending events; await completion of delivery attempts |
| `setEnabled(false)` | Stop collection, remove automatic navigation listeners, discard queued events, clear persisted events and the anonymous visitor ID, and abort pending delivery |
| `setEnabled(true)` | Resume collection; automatic tracking records the current page when resumed |
| `destroy()` | Stop timers/listeners and discard the in-memory queue; preserve browser persisted events for the next client |
| `shutdown()` | Server: flush and destroy the client |

Call `await analytics.flush()` before `destroy()` to send pending events immediately. Browser `flush()` reports delivery errors through `onError`; server `flush()` also rejects. Automatic collection errors reach `onError`. Invalid explicit event data throws synchronously. Events accept finite JSON values and are limited to 32 KiB each, with batches up to 256 KiB.

Collection can be switched at runtime through `setEnabled()`. Initialize with `enabled: false` when your application needs to wait before starting analytics. Automatic collection includes page URLs and query parameters; use context overrides to customize what your application sends. User and session identifiers come from your application.

## Compatibility

ESM with TypeScript declarations. Browser clients use Fetch, AbortController, and `crypto.randomUUID()` on HTTPS or localhost. Backend clients support Node.js 22 and later. React bindings support React 18 and 19.

## License

[MIT](LICENSE).
