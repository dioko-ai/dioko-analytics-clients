import test from 'node:test';
import assert from 'node:assert/strict';
import { observeNavigation } from '../dist/navigation.js';

function environment(t) {
  const target = new EventTarget();
  const location = { href: 'https://site.test/start' };
  const history = {
    pushState(state, title, url) { if (url !== undefined) location.href = new URL(url, location.href).href; return `push:${title}`; },
    replaceState(state, title, url) { if (url !== undefined) location.href = new URL(url, location.href).href; return `replace:${title}`; },
  };
  Object.assign(target, { location, history });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: target });
  t.after(() => {
    for (const callback of cleanup.splice(0)) callback();
    if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window;
  });
  const cleanup = [];
  return { window: target, location, history, cleanup };
}

test('observes changed push, replace, pop, and hash URLs without an initial call', t => {
  const { window, history, location, cleanup } = environment(t);
  let calls = 0;
  cleanup.push(observeNavigation(() => calls++));
  assert.equal(calls, 0);
  assert.equal(history.pushState({}, 'page', '/next'), 'push:page');
  assert.equal(calls, 1);
  history.pushState({}, 'same', '/next');
  history.replaceState({}, 'replace', '/other#section');
  assert.equal(calls, 2);
  location.href = 'https://site.test/back';
  window.dispatchEvent(new Event('popstate'));
  window.dispatchEvent(new Event('popstate'));
  assert.equal(calls, 3);
  location.href = 'https://site.test/back#hash';
  window.dispatchEvent(new Event('hashchange'));
  assert.equal(calls, 4);
});

test('subscribers coexist and last cleanup restores original history methods', t => {
  const { history, cleanup } = environment(t);
  const originalPush = history.pushState;
  const originalReplace = history.replaceState;
  let first = 0, second = 0;
  const removeFirst = observeNavigation(() => first++);
  const removeSecond = observeNavigation(() => second++);
  cleanup.push(removeFirst, removeSecond);
  history.pushState({}, '', '/one');
  assert.deepEqual([first, second], [1, 1]);
  removeFirst();
  history.pushState({}, '', '/two');
  assert.deepEqual([first, second], [1, 2]);
  removeSecond();
  assert.equal(history.pushState, originalPush);
  assert.equal(history.replaceState, originalReplace);
});

test('wrappers preserve receiver, arguments, return values, and original exceptions', t => {
  const { history, cleanup } = environment(t);
  const calls = [];
  history.pushState = function(...args) { calls.push([this, args]); return 42; };
  history.replaceState = function() { throw new Error('history failed'); };
  const push = history.pushState, replace = history.replaceState;
  cleanup.push(observeNavigation(() => {}));
  assert.equal(history.pushState({ x: 1 }, 'title', '/a'), 42);
  assert.equal(calls[0][0], history);
  assert.deepEqual(calls[0][1], [{ x: 1 }, 'title', '/a']);
  assert.throws(() => history.replaceState({}, '', '/b'), /history failed/);
  cleanup.at(-1)();
  assert.equal(history.pushState, push);
  assert.equal(history.replaceState, replace);
});

test('cleanup does not overwrite a wrapper installed later by another library', t => {
  const { history, cleanup } = environment(t);
  const remove = observeNavigation(() => {});
  const observerWrapper = history.pushState;
  const laterWrapper = function(...args) { return observerWrapper.apply(this, args); };
  history.pushState = laterWrapper;
  cleanup.push(remove);
  remove();
  assert.equal(history.pushState, laterWrapper);
});

test('is safe when window is unavailable', t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  delete globalThis.window;
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); });
  assert.doesNotThrow(() => observeNavigation(() => {})());
});
