import { createClient, type AnalyticsOptions, type Analytics } from './internal.js';
export type { JsonValue, Properties, EventContext, TrackOptions, FormOptions, FormResult, AnalyticsForm, AnalyticsOptions, Analytics } from './internal.js';
/** Browser analytics; persistent storage is opt-in. */
export function createAnalytics(options: AnalyticsOptions): Analytics { return createClient(options); }
