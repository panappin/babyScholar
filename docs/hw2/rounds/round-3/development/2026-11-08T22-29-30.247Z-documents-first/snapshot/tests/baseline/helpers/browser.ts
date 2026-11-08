import { afterEach, expect, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});
export const failure = (kind: string, message = kind, status = 503) => json({ error: { kind, message } }, status);
export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export function abortedRequest(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (!signal) throw new Error('Expected request cancellation signal');
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}
type Handler = (init: RequestInit, url: URL) => Response | Promise<Response>;
const unexpected: string[] = [];
/** Every route is explicit; unhandled traffic fails the test even if the UI catches it. */
export function mockApi(routes: Record<string, Handler>) {
  const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
    const url = new URL(String(input), 'http://localhost');
    const key = `${init.method ?? 'GET'} ${url.pathname}`;
    const route = routes[key];
    if (!route) { unexpected.push(key); throw new Error(`Unexpected request: ${key}`); }
    return route(init, url);
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
export function requests(fetcher: ReturnType<typeof mockApi>, method: string, path?: string) {
  return fetcher.mock.calls.filter(([input, init]) => (init?.method ?? 'GET') === method
    && (!path || new URL(String(input), 'http://localhost').pathname === path));
}
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  const missed = unexpected.splice(0);
  expect(missed, 'All component requests must use explicitly mocked boundary routes').toEqual([]);
});
