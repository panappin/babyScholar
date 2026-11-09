import { afterEach, describe, expect, it, vi } from 'vitest';
// Launcher JavaScript is outside application source coverage.
// @ts-expect-error JavaScript launcher has no declaration file.
import { waitForReadiness } from '../../scripts/startup-readiness.mjs';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const payload = (path: string) => path === '/api/health' ? { status: 'ok' }
  : path === '/api/storage/status' ? { status: 'ok', d1: { status: 'ok' }, r2: { status: 'ok' } }
  : path === '/api/library/papers' ? { papers: [] } : { documents: [] };
const paths = ['/api/health', '/api/storage/status', '/api/library/papers', '/api/documents'];

describe('bounded local startup readiness', () => {
  it('waits for delayed Worker and schema readiness, then separately checks every proxy endpoint', async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const calls: string[] = [];
    const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
      expect(init.method).toBe('GET');
      calls.push(url.origin + url.pathname);
      if (Date.now() - start < 30 || (url.pathname === '/api/documents' && Date.now() - start < 60)) return Response.json({}, { status: 503 });
      return Response.json(payload(url.pathname));
    });
    let done = false;
    const worker = waitForReadiness('http://worker', { timeoutMs: 100, intervalMs: 10, fetchImplementation: fetcher }).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(50);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    await worker;
    await waitForReadiness('http://proxy', { fetchImplementation: fetcher });
    expect(calls.slice(-4)).toEqual(paths.map(path => 'http://proxy' + path));
    expect(calls).toContain('http://worker/api/documents');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['HTTP error', 'wrong response', 'stalled body'])('bounds permanent %s without any writes', async mode => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async (_url: URL, init: RequestInit) => {
      expect(init.method).toBe('GET');
      if (mode === 'HTTP error') return Response.json({}, { status: 503 });
      if (mode === 'wrong response') return Response.json({ status: 'ok', papers: [] });
      return { ok: true, json: () => new Promise(() => {}) };
    });
    const result = waitForReadiness('http://proxy', { label: 'Vite proxy', timeoutMs: 100, requestTimeoutMs: 20, intervalMs: 10, fetchImplementation: fetcher });
    const assertion = expect(result).rejects.toThrow(/Vite proxy was not ready.*startup does not migrate or reset data/);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(20);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a stuck startup immediately for process shutdown', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetcher = vi.fn(() => new Promise(() => {}));
    const result = waitForReadiness('http://worker', { signal: controller.signal, fetchImplementation: fetcher });
    const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await assertion;
    expect(fetcher).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
