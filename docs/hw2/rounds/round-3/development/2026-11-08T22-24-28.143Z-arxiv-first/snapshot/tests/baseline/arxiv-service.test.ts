import { afterEach, describe, expect, it, vi } from 'vitest';
import { createArxivSearchService, paperSearchFailureStatus, publicPaperSearchError, probeArxiv,
  type ArxivSearchOptions } from '../../src/worker/arxiv';

const entry = `<entry><id>http://arxiv.org/abs/2401.01234v3</id>
  <title> Café &amp; learning </title><author><name>Ada Author</name></author>
  <author><name>Bea Researcher</name></author><published>2024-01-02T00:00:00Z</published>
  <summary>First line.\n Second line.</summary>
  <link rel="alternate" href="http://arxiv.org/abs/2401.01234v3"/>
  <link rel="related" title="pdf" href="https://arxiv.org/pdf/2401.01234v3"/></entry>`;
const feed = `<feed xmlns="http://www.w3.org/2005/Atom">${entry}</feed>`;
const xmlResponse = (xml = feed) => new Response(xml, { headers: { 'content-type': 'application/atom+xml' } });
function service(options: ArxivSearchOptions = {}) {
  const fetcher = vi.fn(async () => xmlResponse());
  return { fetcher, search: createArxivSearchService({ requestSpacingMs: 0, fetchImplementation: fetcher, ...options }).search };
}
afterEach(() => vi.useRealTimers());

describe('arXiv public service: independent Atom and query oracles', () => {
  it('returns ordered authors, first-submission year, normalized text and canonical links', async () => {
    const { search, fetcher } = service();
    expect(await search('  cafe\u0301\n learning  ')).toEqual({ provider: 'arxiv', query: 'café learning', papers: [{
      id: '2401.01234', title: 'Café & learning', authors: ['Ada Author', 'Bea Researcher'], year: 2024,
      abstract: 'First line. Second line.', url: 'https://arxiv.org/abs/2401.01234v3', pdfUrl: 'https://arxiv.org/pdf/2401.01234v3',
    }] });
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe('https://export.arxiv.org/api/query');
    expect(Object.fromEntries(url.searchParams)).toEqual({ search_query: 'all:"café" AND all:"learning"',
      start: '0', max_results: '10', sortBy: 'relevance', sortOrder: 'descending' });
  });

  it('treats field syntax, quotes and operators as plain text terms', async () => {
    const fetcher = vi.fn(async () => xmlResponse('<feed/>'));
    await service({ fetchImplementation: fetcher }).search('ti:"graph" OR cat:cs.AI*');
    expect(new URL(String(fetcher.mock.calls[0][0])).searchParams.get('search_query'))
      .toBe('all:"ti" AND all:"graph" AND all:"OR" AND all:"cat" AND all:"cs" AND all:"AI"');
  });

  it.each([null, '', ' \t\n ', '?!_*', 'a'.repeat(201)])('rejects invalid query %j before transport', async query => {
    const { search, fetcher } = service();
    const error = await search(query).catch(error => error);
    expect(error).toMatchObject({ kind: 'invalid_query' });
    expect(paperSearchFailureStatus(error)).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('counts Unicode code points at the inclusive 200-character limit', async () => {
    const { search, fetcher } = service();
    const query = '𐐀'.repeat(200);
    expect((await search(query)).query).toBe(query);
    await expect(search(query + '𐐀')).rejects.toMatchObject({ kind: 'invalid_query' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reads prefixed Atom, CDATA and numeric entities without requiring optional metadata', async () => {
    const xml = `<?xml version="1.0"?><!-- fixture --><a:feed xmlns:a="urn:atom"><a:entry>
      <a:id>hep-th/9901001v2</a:id><a:title><![CDATA[A < B]]></a:title>
      <a:summary>&#65; &#x1F9EA;</a:summary><a:author><a:name/></a:author>
      <a:link href="https://evil.invalid/abs/hep-th/9901001"/></a:entry></a:feed>`;
    const { search } = service({ fetchImplementation: async () => xmlResponse(xml) });
    expect((await search('physics')).papers).toEqual([{ id: 'hep-th/9901001', title: 'A < B',
      authors: [], year: null, abstract: 'A 🧪', url: null, pdfUrl: null }]);
  });

  it('accepts an empty Atom feed as a successful empty search', async () => {
    const { search } = service({ fetchImplementation: async () => xmlResponse('<feed/>') });
    expect(await search('missing')).toEqual({ provider: 'arxiv', query: 'missing', papers: [] });
  });

  it.each([
    ['empty body', ''], ['DTD', '<!DOCTYPE feed><feed/>'], ['entity declaration', '<!ENTITY foo "x"><feed/>'],
    ['outside-root text', 'oops<feed/>'], ['outside-root CDATA', '<![CDATA[oops]]><feed/>'],
    ['mismatched nesting', '<feed><entry></feed>'], ['unclosed root', '<feed>'],
    ['multiple roots', '<feed/><feed/>'], ['wrong root', '<html/>'], ['declaration', '<!OTHER><feed/>'],
    ['missing identifier', '<feed><entry><title>No identity</title></entry></feed>'],
    ['invalid character entity', '<feed><title>&#x110000;</title></feed>'],
    ['Atom error feed', '<feed><entry><title>Error</title></entry></feed>'],
  ])('rejects %s with a safe public upstream failure', async (_label, xml) => {
    const { search } = service({ fetchImplementation: async () => xmlResponse(xml) });
    const error = await search('science').catch(error => error);
    expect(publicPaperSearchError(error)).toEqual({ kind: 'upstream', message: 'arXiv could not provide a valid paper search response.' });
    expect(paperSearchFailureStatus(error)).toBe(502);
  });
});

describe('arXiv cache, coalescing and queue recovery with injected time', () => {
  it('coalesces equivalent expressions but preserves each caller query and independent records', async () => {
    let resolve!: (value: Response) => void;
    const response = new Promise<Response>(done => { resolve = done; });
    const fetcher = vi.fn(() => response);
    const { search } = service({ fetchImplementation: fetcher });
    const first = search(' graph-learning '), second = search('graph learning');
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(1);
    resolve(xmlResponse());
    const [a, b] = await Promise.all([first, second]);
    expect(a.query).toBe('graph-learning');
    expect(b.query).toBe('graph learning');
    a.papers[0].title = 'caller mutation'; a.papers[0].authors.push('caller author');
    a.papers.push({ ...a.papers[0] });
    expect(b.papers).toHaveLength(1);
    expect(b.papers[0]).toMatchObject({ title: 'Café & learning', authors: ['Ada Author', 'Bea Researcher'] });
    const cached = await search('graph learning');
    expect(cached.papers).toEqual(b.papers);
    b.papers[0].authors[0] = 'another mutation';
    expect(cached.papers[0].authors[0]).toBe('Ada Author');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('uses cache before expiry and refetches at the exact TTL boundary', async () => {
    let now = 0;
    const { search, fetcher } = service({ now: () => now, cacheTtlMs: 100 });
    await search('one'); now = 99; await search('one');
    expect(fetcher).toHaveBeenCalledTimes(1);
    now = 100; await search('one');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('starts TTL when a response completes, so time spent waiting does not consume it', async () => {
    let now = 0;
    const fetcher = vi.fn(async () => { now += 80; return xmlResponse(); });
    const { search } = service({ fetchImplementation: fetcher, now: () => now, cacheTtlMs: 100 });
    await search('one'); now = 179; await search('one');
    expect(fetcher).toHaveBeenCalledTimes(1);
    now = 180; await search('one');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('evicts the oldest inserted entry at capacity while keeping newer cached results', async () => {
    const { search, fetcher } = service({ maxCacheEntries: 2 });
    await search('one'); await search('two'); await search('three'); await search('two');
    expect(fetcher).toHaveBeenCalledTimes(3);
    await search('one'); expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('does not cache failures or poison the serialized queue, and respects injected spacing', async () => {
    let now = 0;
    const starts: number[] = [];
    const sleep = vi.fn(async (milliseconds: number) => { now += milliseconds; });
    const fetcher = vi.fn(async () => {
      starts.push(now);
      if (starts.length === 1) throw new Error('private transport detail');
      return xmlResponse();
    });
    const { search } = service({ fetchImplementation: fetcher, now: () => now, sleep, requestSpacingMs: 30 });
    const failed = search('one').catch(error => error), queued = search('two');
    expect(await failed).toMatchObject({ kind: 'upstream' });
    expect((await queued).papers).toHaveLength(1);
    expect((await search('one')).papers).toHaveLength(1);
    expect(starts).toEqual([0, 30, 60]);
    expect(sleep.mock.calls).toEqual([[30], [30]]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});

describe('arXiv transport bounds and timeout classification', () => {
  it.each([429, 500, 503])('maps HTTP %i to an upstream failure without leaking response text', async status => {
    const { search } = service({ fetchImplementation: async () => new Response('private upstream body', { status }) });
    const error = await search('topic').catch(error => error);
    expect(publicPaperSearchError(error)).toEqual({ kind: 'upstream', message: 'arXiv could not provide a valid paper search response.' });
  });

  it('accepts the exact UTF-8 byte budget even when chunks split a multibyte character', async () => {
    const bytes = new TextEncoder().encode(feed);
    const split = bytes.indexOf(0xc3) + 1;
    const { search } = service({ maxResponseBytes: bytes.length, fetchImplementation: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(bytes.slice(0, split)); controller.enqueue(bytes.slice(split)); controller.close(); },
    })) });
    expect((await search('topic')).papers[0].title).toBe('Café & learning');
  });

  it('rejects one-byte overflow despite a false low Content-Length and cancels the stream', async () => {
    const bytes = new TextEncoder().encode(feed), cancel = vi.fn();
    const { search } = service({ maxResponseBytes: bytes.length - 1, fetchImplementation: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(bytes); }, cancel,
    }), { headers: { 'content-length': '1' } }) });
    await expect(search('topic')).rejects.toMatchObject({ kind: 'upstream' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('rejects declared oversized content before trying to read a stalled body', async () => {
    const { search } = service({ maxResponseBytes: 100, fetchImplementation: async () => new Response(new ReadableStream(), {
      headers: { 'content-length': '101' },
    }) });
    await expect(search('topic')).rejects.toMatchObject({ kind: 'upstream' });
  });

  it.each(['headers', 'body'] as const)('times out stalled %s and recovers on the next explicit search', async phase => {
    vi.useFakeTimers();
    let attempt = 0;
    const fetcher: typeof fetch = async (_input, init) => {
      if (++attempt > 1) return xmlResponse();
      if (phase === 'body') return new Response(new ReadableStream());
      return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }));
    };
    const { search } = service({ timeoutMs: 20, fetchImplementation: fetcher });
    const outcome = search('one').catch(error => error);
    await vi.advanceTimersByTimeAsync(20);
    const error = await outcome;
    expect(publicPaperSearchError(error)).toEqual({ kind: 'timeout', message: 'The arXiv search timed out.' });
    expect(paperSearchFailureStatus(error)).toBe(504);
    expect((await search('one')).papers[0].id).toBe('2401.01234');
  });

  it('keeps probe requirements distinct from empty search results', async () => {
    await expect(probeArxiv(async () => xmlResponse('<feed/>'))).rejects.toMatchObject({ kind: 'malformed_response' });
    const fetcher = vi.fn(async () => xmlResponse());
    expect(await probeArxiv(fetcher)).toEqual({ provider: 'arxiv', query: 'all:electron', title: 'Café & learning', link: 'https://arxiv.org/abs/2401.01234v3' });
    expect(new URL(String(fetcher.mock.calls[0][0])).searchParams.get('max_results')).toBe('1');
  });
});
