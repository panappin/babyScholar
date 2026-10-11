import assert from "node:assert/strict";
import worker, { handlePaperSearchRequest } from "../.wrangler/check-worker/index.js";
import { createArxivSearchService, PaperSearchError } from "../.wrangler/check-worker/arxiv.js";

const multiEntryFeed = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2401.01234v2</id>
    <updated>2025-02-03T00:00:00Z</updated>
    <published>2024-01-04T00:00:00Z</published>
    <title> First &amp; Second </title>
    <summary> First line\n      with &lt;entities&gt; and Unicode 测试. </summary>
    <author><name>Ada &amp; Bob</name></author>
    <author><name>李 雷</name></author>
    <link rel="alternate" href="http://arxiv.org/abs/2401.01234v2" type="text/html" />
    <link rel="related" title="pdf" href="http://www.arxiv.org/pdf/2401.01234v2.pdf" type="application/pdf" />
  </entry>
  <entry>
    <id>http://arxiv.org/abs/cond-mat/0011267v1</id>
    <updated>2026-01-01T00:00:00Z</updated>
    <published>2000-11-14T00:00:00Z</published>
    <title> Legacy identifier </title>
    <summary />
    <author><name>Legacy Author</name></author>
  </entry>
</feed>`;

const emptyFeed = `<?xml version="1.0"?><atom:feed xmlns:atom="http://www.w3.org/2005/Atom"></atom:feed>`;
const errorFeed = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Error</title><summary>upstream diagnostic</summary></entry></feed>`;

async function expectKind(operation, kind) {
  await assert.rejects(operation, (error) => error instanceof PaperSearchError && error.kind === kind);
}

let metadataFetches = 0;
let capturedUrl;
const metadataService = createArxivSearchService({
  fetchImplementation: async (url) => {
    metadataFetches++;
    capturedUrl = new URL(String(url));
    return new Response(multiEntryFeed, { status: 200, headers: { "content-type": "application/atom+xml" } });
  },
  requestSpacingMs: 0,
});
const metadata = await metadataService.search('  quantum: "测试" OR all:*  ');
assert.equal(metadata.provider, "arxiv");
assert.equal(metadata.query, 'quantum: "测试" OR all:*');
assert.equal(metadata.papers.length, 2);
assert.deepEqual(metadata.papers[0], {
  id: "2401.01234",
  title: "First & Second",
  authors: ["Ada & Bob", "李 雷"],
  year: 2024,
  abstract: "First line with <entities> and Unicode 测试.",
  url: "https://arxiv.org/abs/2401.01234v2",
  pdfUrl: "https://arxiv.org/pdf/2401.01234v2.pdf",
});
assert.deepEqual(metadata.papers[1], {
  id: "cond-mat/0011267",
  title: "Legacy identifier",
  authors: ["Legacy Author"],
  year: 2000,
  abstract: "",
  url: null,
  pdfUrl: null,
});
assert.equal(capturedUrl.hostname, "export.arxiv.org");
assert.equal(capturedUrl.searchParams.get("max_results"), "10");
assert.equal(capturedUrl.searchParams.get("sortBy"), "relevance");
assert.equal(capturedUrl.searchParams.get("search_query"), 'all:"quantum" AND all:"测试" AND all:"OR" AND all:"all"');

let invalidFetches = 0;
const invalidService = createArxivSearchService({
  fetchImplementation: async () => {
    invalidFetches++;
    return new Response(multiEntryFeed);
  },
});
for (const query of [null, "\t \n", "!@#$", "a".repeat(201)]) {
  await expectKind(() => invalidService.search(query), "invalid_query");
}
assert.equal(invalidFetches, 0);
const invalidEndpoint = await worker.fetch(new Request("https://check.invalid/api/papers/search?q=%20%20"));
assert.equal(invalidEndpoint.status, 400);
assert.deepEqual(await invalidEndpoint.json(), { error: { kind: "invalid_query", message: "Query parameter q must not be blank." } });
assert.equal((await worker.fetch(new Request("https://check.invalid/api/papers/search", { method: "POST" }))).status, 405);
for (const [kind, expectedStatus] of [["timeout", 504], ["upstream", 502]]) {
  const response = await handlePaperSearchRequest(
    new Request("https://check.invalid/api/papers/search?q=fixture"),
    async () => { throw new PaperSearchError(kind, `fixture ${kind}`); },
  );
  assert.equal(response.status, expectedStatus);
  assert.deepEqual(await response.json(), { error: { kind, message: `fixture ${kind}` } });
}

const emptyService = createArxivSearchService({
  fetchImplementation: async () => new Response(emptyFeed, { status: 200 }),
  requestSpacingMs: 0,
});
assert.deepEqual((await emptyService.search("empty results")).papers, []);

for (const [label, fetchImplementation] of [
  ["Atom error feed", async () => new Response(errorFeed, { status: 200 })],
  ["malformed XML", async () => new Response("<feed><entry></feed>", { status: 200 })],
  ["HTTP failure", async () => new Response("upstream unavailable", { status: 503 })],
  ["network failure", async () => { throw new Error("network unavailable"); }],
]) {
  const service = createArxivSearchService({ fetchImplementation, requestSpacingMs: 0 });
  await expectKind(() => service.search(label), "upstream");
}

const hangingBody = {
  getReader() {
    return {
      read: () => new Promise(() => undefined),
      cancel: async () => undefined,
      releaseLock: () => undefined,
    };
  },
};
const timeoutService = createArxivSearchService({
  fetchImplementation: async () => ({ ok: true, status: 200, headers: new Headers(), body: hangingBody }),
  timeoutMs: 10,
  requestSpacingMs: 0,
});
await expectKind(() => timeoutService.search("body timeout"), "timeout");

const tooLargeService = createArxivSearchService({
  fetchImplementation: async () => new Response(multiEntryFeed, { status: 200 }),
  maxResponseBytes: 32,
  requestSpacingMs: 0,
});
await expectKind(() => tooLargeService.search("bounded body"), "upstream");

let clock = 0;
let spacedFetches = 0;
const starts = [];
const spacedService = createArxivSearchService({
  fetchImplementation: async () => {
    spacedFetches++;
    starts.push(clock);
    return new Response(multiEntryFeed, { status: 200 });
  },
  now: () => clock,
  sleep: async (milliseconds) => { clock += milliseconds; },
  requestSpacingMs: 3_000,
});
await spacedService.search("first");
await spacedService.search("first");
await spacedService.search("second");
assert.equal(spacedFetches, 2, "a successful query is cached");
assert.deepEqual(starts, [0, 3_000], "distinct requests are serialised and spaced by three seconds");

let dedupeFetches = 0;
let resolveDedupe;
const dedupeService = createArxivSearchService({
  fetchImplementation: async () => {
    dedupeFetches++;
    return new Promise((resolve) => { resolveDedupe = resolve; });
  },
  requestSpacingMs: 0,
});
const first = dedupeService.search("same request");
const second = dedupeService.search("same request");
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(dedupeFetches, 1, "identical concurrent requests share one upstream request");
resolveDedupe(new Response(multiEntryFeed, { status: 200 }));
await Promise.all([first, second]);

assert.equal(metadataFetches, 1);
console.log("Paper search checks: metadata parsing, input validation, failures, bounded bodies, cache, deduplication, and arXiv spacing: PASS");
