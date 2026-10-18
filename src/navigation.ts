type NavigationCallback = () => void;

interface NavigationState {
  subscribers: Set<NavigationCallback>;
  window: Window;
  history: History;
  url: string;
  pushState: History['pushState'];
  replaceState: History['replaceState'];
  wrappedPushState: History['pushState'];
  wrappedReplaceState: History['replaceState'];
  onNavigation: () => void;
}

let state: NavigationState | undefined;

function currentUrl(window: Window): string {
  try { return window.location.href; } catch { return ''; }
}

function notifyIfChanged(active: NavigationState): void {
  const url = currentUrl(active.window);
  if (url === active.url) return;
  active.url = url;
  for (const callback of [...active.subscribers]) callback();
}

/** Observe same-document URL changes. The caller owns the initial page view. */
export function observeNavigation(callback: NavigationCallback): () => void {
  if (typeof window === 'undefined' || !window.history || !window.location || typeof window.addEventListener !== 'function') return () => {};

  if (!state) {
    const target = window;
    const history = target.history;
    const originalPush = history.pushState;
    const originalReplace = history.replaceState;
    const active = {
      subscribers: new Set<NavigationCallback>(), window: target, history,
      url: currentUrl(target), pushState: originalPush, replaceState: originalReplace,
      wrappedPushState: undefined as unknown as History['pushState'],
      wrappedReplaceState: undefined as unknown as History['replaceState'],
      onNavigation: () => {},
    } satisfies NavigationState;
    active.onNavigation = () => notifyIfChanged(active);
    active.wrappedPushState = function(this: History, ...args: Parameters<History['pushState']>) {
      const result = Reflect.apply(originalPush, this, args);
      active.onNavigation();
      return result;
    } as History['pushState'];
    active.wrappedReplaceState = function(this: History, ...args: Parameters<History['replaceState']>) {
      const result = Reflect.apply(originalReplace, this, args);
      active.onNavigation();
      return result;
    } as History['replaceState'];
    state = active;
    history.pushState = active.wrappedPushState;
    history.replaceState = active.wrappedReplaceState;
    target.addEventListener('popstate', active.onNavigation);
    target.addEventListener('hashchange', active.onNavigation);
  }

  const active = state;
  active.subscribers.add(callback);
  let observing = true;
  return () => {
    if (!observing) return;
    observing = false;
    active.subscribers.delete(callback);
    if (active.subscribers.size) return;
    active.window.removeEventListener('popstate', active.onNavigation);
    active.window.removeEventListener('hashchange', active.onNavigation);
    if (active.history.pushState === active.wrappedPushState) active.history.pushState = active.pushState;
    if (active.history.replaceState === active.wrappedReplaceState) active.history.replaceState = active.replaceState;
    if (state === active) state = undefined;
  };
}
