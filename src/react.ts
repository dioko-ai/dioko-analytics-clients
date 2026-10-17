'use client';
import { createContext, createElement, useContext, type ReactNode } from 'react';
import type { Analytics } from './index.js';
const AnalyticsContext = createContext<Analytics | null>(null);
export interface AnalyticsProviderProps { client: Analytics; children?: ReactNode }
/** Supply a stable client created outside render. The caller owns its lifecycle. */
export function AnalyticsProvider({ client, children }: AnalyticsProviderProps) {
  return createElement(AnalyticsContext.Provider, { value: client }, children);
}
export function useAnalytics(): Analytics {
  const client = useContext(AnalyticsContext);
  if (!client) throw new Error('useAnalytics must be used within AnalyticsProvider');
  return client;
}
