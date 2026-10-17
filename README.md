# Dioko Analytics clients

TypeScript clients for browsers and backends, with optional React bindings. Import it into your application bundle: no hosted script, runtime loader, or CDN dependency. Events are sent to your configured Dioko collector.

This repository is independent of the private analytics backend. The proposed npm name is `@dioko/analytics`; it is not published yet and scope ownership must be confirmed before release.

## Usage

After publication, install with `npm install @dioko/analytics`. For local evaluation, build and pack this repository and install the resulting tarball in your application.

```ts
import { createAnalytics } from '@dioko/analytics';

export const analytics = createAnalytics({
  endpoint: 'https://analytics.example.com',
  sourceKey: 'pk_YOUR_PUBLIC_SOURCE_KEY',
  enabled: false, // Enable when your application's consent policy permits.
  storage: 'localStorage', // Optional: retain pending events across reloads.
  onError: (error) => console.warn('Analytics delivery failed', error),
});

analytics.setEnabled(true);
analytics.page();
analytics.track('signup_started', { plan: 'team' });
await analytics.flush();
```

Create a browser source in the Dioko dashboard and allow your application's exact origin (including the development port). Public source keys are intended for browser bundles; never use a server secret. Configure your Content Security Policy to allow the collector in `connect-src`. A same-origin reverse proxy is also possible.

## Backend TypeScript

Use a server source created in the dashboard. Keep its secret in your environment or secret manager, and import this entry point only in backend code:

```ts
import { createServerAnalytics } from '@dioko/analytics/server';

const analytics = createServerAnalytics({
  endpoint: 'https://analytics.example.com',
  secretKey: process.env.DIOKO_ANALYTICS_SECRET!,
  onError: (error) => console.error('Analytics delivery failed', error),
});

analytics.track('invoice.paid', { amount: 4900, currency: 'USD' }, {
  userId: 'customer-123',
});

// Await before a job exits or a serverless request finishes.
await analytics.flush();
// At application shutdown, flush pending events and dispose the client:
await analytics.shutdown();
```

The server client sends the secret as a bearer header, omits the public source key, and never adds browser Origin or visitor context. It uses batches of up to 100 events by default. Reuse one client per backend process; supply user/session identifiers per event. It has no React dependency or browser storage. Idle batching timers do not keep a Node process alive, so await `flush()` in jobs and serverless handlers. Active requests and retry waits remain alive until completion or cancellation.

Server `flush()` rejects on delivery failure. Retryable failures retain events in memory for a later flush with the same IDs; permanent rejections discard that batch. Automatic flush failures also reach `onError`. `shutdown()` flushes and then destroys the client even if delivery fails, propagating the error. A collector `Retry-After` can extend flush/shutdown beyond the request timeout; call `destroy()` to cancel pending work if your shutdown deadline expires. This is an in-memory backend queue, not a durable job queue; use your application's outbox when delivery must survive process termination.

## React

React is an optional peer dependency; applications using only the core client do not import it.

```tsx
import { AnalyticsProvider, useAnalytics } from '@dioko/analytics/react';
import { analytics } from './analytics';

function SignupButton() {
  const analytics = useAnalytics();
  return <button onClick={() => analytics.track('signup_started')}>Sign up</button>;
}

export function App() {
  return <AnalyticsProvider client={analytics}><SignupButton /></AnalyticsProvider>;
}
```

The provider does not record events or own the client's lifetime. Call `page()` explicitly from your router's navigation callback, once per completed navigation. This avoids assuming a router or generating page views during React rendering. Imports and provider rendering are safe during server rendering; do not track events from server renders or share visitor identity through a server singleton.

## Privacy and lifecycle

There is no automatic tracking, cookie, fingerprinting, or identity creation. Storage is in memory by default; enabling `storage: 'localStorage'` writes pending event data to the browser until delivery or expiry. Other scripts on the same origin can read localStorage, so send only intended analytics data. `track()` sends only the supplied data. `page()` additionally reads the current page URL and referrer in a browser. URLs can contain sensitive query parameters: although the collector strips them before persistence, they travel to the collector. Supply sanitized URLs through `context` when needed. Properties are not automatically scrubbed.

Optional identity and context fields are passed as the third argument:

```ts
analytics.track('checkout_started', { items: 2 }, {
  anonymousId: 'application-managed-id',
  context: { page_url: 'https://example.com/checkout' },
});
```

`setEnabled(false)` discards queued events, clears this client's persisted namespace, and aborts pending delivery. It cannot undo events already received by the server. Application consent must be coordinated across tabs; disabling one client does not disable an already-running client in another tab.

Browser `destroy()` stops timers/listeners and discards the in-memory queue, but preserves persisted events for the next client instance. Call and await `flush()` first when immediate delivery is desired. There is no unload-delivery guarantee.

## Browser offline persistence

With `storage: 'localStorage'`, the client saves events before sending and retains them during requests. Successful delivery removes them; network errors, HTTP 429, and server errors retain them after the immediate retry budget is exhausted. The client retries later on a timer or when the browser emits an `online` event, and restores pending events on the next enabled client instance. Permanent collector rejections remove the rejected batch.

Events retain their original IDs and timestamps. Separate per-event storage records avoid one tab overwriting another tab's queue. Multiple tabs may deliver the same event, which the collector deduplicates in reports. Storage is scoped by collector URL, source key, and optional `storageKey` prefix.

`retentionMs` defaults to seven days and cannot exceed thirty days. Expired or malformed records are discarded. The queue remains bounded by `maxQueueSize`. Browser storage can be blocked, cleared, or exhausted; storage errors reach `onError`, with an in-memory fallback. Persistence improves recovery but cannot guarantee delivery. Initialize with `enabled: false` when consent is required; this clears any previous backlog in that namespace and does not restore or send stored events.

## Delivery options

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Allow collection; initialize with `false` when consent is required |
| `batchSize` | Browser `20`, server `100` | Flush threshold and maximum events per request (1–100) |
| `flushIntervalMs` | `5000` | Delay before sending a partial batch; `0` disables the partial-batch timer; retained failures still schedule retries |
| `maxQueueSize` | `1000` | Maximum queued and in-flight events; new events are dropped when full |
| `maxRetries` | `3` | Additional attempts for network errors, rate limits, and server errors |
| `retryDelayMs` | `1000` | Initial exponential backoff; `Retry-After` can extend the delay |
| `timeoutMs` | `10000` | Timeout per request |
| `storage` | In memory | Browser only: `'localStorage'` enables persistence |
| `storageKey` | `'dioko-analytics'` | Browser storage namespace prefix |
| `retentionMs` | `604800000` (7 days) | Browser persisted-event lifetime |

`track()` returns the event UUID, or `null` when disabled, destroyed, or full. Invalid data throws synchronously. Transport failures and dropped events are reported to `onError`; browser `flush()` resolves after attempts finish and does **not** guarantee acceptance. Server `flush()` rejects on delivery failure. Retries reuse the original event IDs and payload. The collector deduplicates reports by event ID.

The client targets modern browsers with Fetch, AbortController, and `crypto.randomUUID()` (HTTPS or localhost). The package ships ESM and TypeScript declarations; CommonJS is not provided. Use the `/server` entry point for server-source credentials.

## Development

```sh
npm ci
npm run check
npm pack --dry-run
```

See [RELEASING.md](RELEASING.md) before making this repository public or publishing a package.

## License

[MIT](LICENSE).
