import { createClient, type AnalyticsOptions, type Analytics } from './internal.js';
export type { JsonValue, Properties, EventContext, TrackOptions } from './internal.js';
export interface ServerAnalyticsOptions extends Omit<AnalyticsOptions, 'sourceKey' | 'storage' | 'storageKey' | 'retentionMs' | 'autoTrack' | 'autoAnonymousId' | 'fullContext'> { secretKey: string }
export interface ServerAnalytics extends Omit<Analytics, 'page' | 'createForm'> { shutdown(): Promise<void> }
/** Server-only entry point. Never expose the secret key in browser bundles. */
export function createServerAnalytics(options: ServerAnalyticsOptions): ServerAnalytics {
  if (typeof window !== 'undefined') throw new Error('Server analytics cannot run in a browser');
  if (!/^sk_[A-Za-z0-9_-]+$/.test(options.secretKey) || options.secretKey.length < 20 || options.secretKey.length > 200) throw new TypeError('Use a secret server source key (sk_)');
  // Explicitly omit persistence even when called from untyped JavaScript.
  const client = createClient({ ...options, batchSize: options.batchSize ?? 100, sourceKey: '', autoTrack: false, autoAnonymousId: false, fullContext: false, storage: undefined, storageKey: undefined, retentionMs: undefined }, { headers: { Authorization: `Bearer ${options.secretKey}` }, batchPrefix: '', rejectFailures: true });
  return { track: client.track, flush: client.flush, setEnabled: client.setEnabled, destroy: client.destroy,
    async shutdown() { try { await client.flush(); } finally { client.destroy(); } },
  };
}
