import type { JsonValue, Properties } from './internal.js';

/** Detailed event context fields, plus flat website attribution fields. */
export interface EventContext {
  [key: string]: JsonValue | undefined;
  page_url?: string;
  website?: string;
  referrer?: string | Properties;
  utm_source?: string; utm_medium?: string; utm_campaign?: string; utm_term?: string; utm_content?: string;
  active?: boolean; app?: Properties; campaign?: Properties; device?: Properties;
  ip?: string; library?: Properties; locale?: string; network?: Properties; os?: Properties;
  page?: Properties; screen?: Properties; timezone?: string; groupId?: string;
  traits?: Properties; userAgent?: string; userAgentData?: Properties; channel?: string;
}

/** Merge nested context dictionaries one level deep; explicit values win. */
export function mergeContext(...contexts: (EventContext | undefined)[]): EventContext {
  const result: EventContext = {};
  for (const context of contexts) {
    for (const [key, value] of Object.entries(context ?? {})) {
      if (value === undefined) continue;
      const previous = result[key];
      const merged = value && typeof value === 'object' && !Array.isArray(value) && previous && typeof previous === 'object' && !Array.isArray(previous)
        ? { ...previous, ...value } : value;
      Object.defineProperty(result, key, { value: merged, enumerable: true, configurable: true, writable: true });
    }
  }
  return result;
}

export function createBrowserContext() {
  let campaign: Properties = {};
  return (full: boolean): EventContext => {
    if (typeof window === 'undefined') return {};
    const location = window.location;
    if (!location || !/^https?:$/.test(location.protocol)) return {};
    const url = new URL(location.href);
    const referrer = typeof document === 'undefined' ? '' : document.referrer;
    const current: Properties = {};
    for (const [key, value] of url.searchParams) {
      if (key.startsWith('utm_') && key.length > 4) Object.defineProperty(current, key === 'utm_campaign' ? 'name' : key.slice(4), { value, enumerable: true, configurable: true });
    }
    if (Object.keys(current).length) campaign = current;
    const context: EventContext = { page_url: url.href, website: url.origin };
    if (referrer && /^https?:\/\//i.test(referrer)) context.referrer = referrer;
    for (const key of ['source', 'medium', 'name', 'term', 'content']) {
      if (campaign[key] !== undefined) context[key === 'name' ? 'utm_campaign' : `utm_${key}`] = campaign[key];
    }
    if (!full) return context;
    context.page = { path: url.pathname, referrer, search: url.search, title: typeof document === 'undefined' ? '' : document.title, url: url.href };
    if (Object.keys(campaign).length) context.campaign = { ...campaign };
    if (context.referrer) context.referrer = { url: referrer };
    context.library = { name: '@dioko/analytics', version: '0.1.0' };
    context.channel = 'browser';
    const nav = window.navigator;
    if (nav) {
      if (nav.language) context.locale = nav.language;
      if (nav.userAgent) context.userAgent = nav.userAgent;
      const hints = (nav as Navigator & { userAgentData?: { brands: { brand: string; version: string }[]; mobile: boolean; platform: string } }).userAgentData;
      if (hints) context.userAgentData = { brands: hints.brands.map(({ brand, version }) => ({ brand, version })), mobile: hints.mobile, platform: hints.platform };
    }
    if (window.screen) context.screen = { width: window.screen.width, height: window.screen.height, density: window.devicePixelRatio || 1 };
    try { const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone; if (timezone) context.timezone = timezone; } catch { /* Optional browser capability. */ }
    return context;
  };
}
