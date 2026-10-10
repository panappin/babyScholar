import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { dirname, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import workerArtifact from "../dist/worker/index.js";
import { createMetadataPdfFixture, createSummaryClippedPdfFixture, createSummaryPdfFixture } from "./fixtures/pdf-fixtures.mjs";

const root = resolve(import.meta.dirname, "..");
const wrangler = resolve(root, "node_modules/wrangler/bin/wrangler.js");
const id = randomUUID();
const evidenceDirectory = resolve(root, ".wrangler/summary-check", id);
const state = resolve(evidenceDirectory, "state");
const stateArgument = relative(root, state).split(sep).join("/") || ".";
const children = new Set();
const fixture = createSummaryPdfFixture();
const expected = fixture.expected;
const multibyteFixture = createMetadataPdfFixture();
const clippedFixture = createSummaryClippedPdfFixture();
const evidence = {
  id,
  state,
  startedAt: new Date().toISOString(),
  fixture: { source: "scripts/fixtures/pdf-fixtures.mjs", license: "CC0-1.0" },
  steps: [],
  providerRequests: [],
};
let worker;
let origin;
let provider;
let providerOrigin;
let summaryMode = "valid";
let summaryProviderCalls = 0;
let metadataProviderCalls = 0;
let summaryProviderStarted;

const record = (step, details = {}) => {
  evidence.steps.push({ step, ...details });
  console.log(JSON.stringify({ step, ...details }));
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function uploadBody(bytes, filename) {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "application/pdf" }), filename);
  return form;
}

function validMetadataOutput() {
  return {
    title: expected.title,
    authors: expected.authors,
    year: expected.year,
    abstract: expected.abstract,
    evidence: {
      title: [{ pageNumber: 1, quote: expected.title }],
      authors: [{ pageNumber: 1, quote: "Avery Example; Bao Example" }],
      year: [{ pageNumber: 1, quote: "Published: 2024" }],
      abstract: [{ pageNumber: 1, quote: `Abstract: ${expected.abstract}` }],
    },
    warnings: [],
  };
}

function validSummaryOutput() {
  return {
    overview: {
      text: "The paper evaluates a staged approach to creating summaries from persisted paper text while retaining page-level support.",
      evidence: [{ pageNumber: 1, referenceId: 5 }],
    },
    contributions: [{
      text: "Its stated contribution separates selecting retained source text from generating the summary.",
      evidence: [{ pageNumber: 2, referenceId: 1 }],
    }],
    methods: [{
      text: "The method processes pages in order and retains page-numbered supporting excerpts.",
      evidence: [{ pageNumber: 3, referenceId: 1 }],
    }],
    findings: [{
      text: "The reported result is that findings from later selected pages can remain represented in the summary.",
      evidence: [{ pageNumber: 4, referenceId: 1 }],
    }],
    limitations: [{
      text: "The stated limitation is that quotations do not establish every implication of a paraphrase.",
      evidence: [{ pageNumber: 4, referenceId: 2 }],
    }],
    warnings: [],
  };
}

function clippedSummaryOutput() {
  const evidence = [{ pageNumber: 1, referenceId: 1 }];
  return {
    overview: { text: "The bounded source begins with a clipping marker before a large first page.", evidence },
    contributions: [{ text: "The fixture demonstrates a bounded ordered source selection.", evidence }],
    methods: [{ text: "The source budget stops within the first persisted page.", evidence }],
    findings: [{ text: "The final selected page is partial after source truncation.", evidence }],
    limitations: [{ text: "Only partial source coverage is available for this summary.", evidence }],
    warnings: [],
  };
}

function multibyteSummaryOutput() {
  return {
    overview: { text: "The stored extraction includes multibyte source text used for an exact evidence-boundary check.", evidence: [{ pageNumber: 1, referenceId: 1 }] },
    contributions: [], methods: [], findings: [], limitations: [],
    warnings: [
      "contributions are unavailable in the selected source.",
      "methods are unavailable in the selected source.",
      "findings are unavailable in the selected source.",
      "limitations are unavailable in the selected source.",
    ],
  };
}

function providerResponse(output) {
  return { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }] };
}

function summaryOutputForMode() {
  const output = validSummaryOutput();
  if (summaryMode === "unissued_reference") output.overview.evidence = [{ pageNumber: 2, referenceId: 999 }];
  else if (summaryMode === "invented_evidence") output.overview.evidence = [{ pageNumber: 1, quote: "Invented summary evidence." }];
  else if (summaryMode === "too_many_words") output.overview.text = Array.from({ length: 501 }, () => "word").join(" ");
  else if (summaryMode === "multibyte_600") return multibyteSummaryOutput();
  else if (summaryMode === "clipped") return clippedSummaryOutput();
  return output;
}

async function readRequestBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > 160 * 1024) throw new Error("Mock provider request exceeded its check limit.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function startProvider() {
  provider = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.url !== "/v1/responses" || !["Bearer local-summary-test-key", "Bearer local-metadata-test-key"].includes(request.headers.authorization)) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "unexpected mock request" } }));
        return;
      }
      const body = await readRequestBody(request);
      const format = body.text?.format;
      const input = body.input?.[1]?.content;
      const pageMarkers = typeof input === "string"
        ? [...new Set([...input.matchAll(/\[Page (\d+); evidence \d+\]/gu)].map((match) => Number(match[1])))]
        : [];
      const isSummary = format?.name === "document_summary";
      evidence.providerRequests.push({
        kind: isSummary ? "summary" : "metadata",
        mode: isSummary ? summaryMode : "valid",
        model: body.model,
        store: body.store,
        maxOutputTokens: body.max_output_tokens,
        hasTools: Object.hasOwn(body, "tools"),
        strictSchema: format?.type === "json_schema" && format?.strict === true && format?.schema?.additionalProperties === false,
        pageMarkers,
        hasSummaryInstructions: !isSummary || (typeof input === "string"
          && input.includes("all supplied pages in their given order")
          && input.includes("300 to 500 words")
          && input.includes("Return only the pageNumber and evidence referenceId")),
        usesServerEvidenceReferences: !isSummary || (
          format?.schema?.properties?.overview?.properties?.evidence?.items?.properties?.referenceId?.type === "integer"
          && format?.schema?.properties?.overview?.properties?.evidence?.items?.properties?.quote === undefined
        ),
      });
      if (!isSummary) {
        metadataProviderCalls += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(providerResponse(validMetadataOutput())));
        return;
      }
      summaryProviderCalls += 1;
      summaryProviderStarted?.();
      summaryProviderStarted = undefined;
      if (summaryMode === "slow") await delay(350);
      if (summaryMode === "timeout") {
        await delay(26_000);
        if (!response.destroyed) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(providerResponse(validSummaryOutput())));
        }
        return;
      }
      if (summaryMode === "http_error") {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "mock upstream failure" } }));
        return;
      }
      let payload;
      if (summaryMode === "malformed") payload = { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "{" }] }] };
      else if (summaryMode === "refusal") payload = { status: "completed", output: [{ content: [{ type: "refusal", refusal: "mock refusal" }] }] };
      else if (summaryMode === "incomplete") payload = { status: "incomplete" };
      else payload = providerResponse(summaryOutputForMode());
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    } catch {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "mock failure" } }));
    }
  });
  await new Promise((done, fail) => { provider.once("error", fail); provider.listen(0, "127.0.0.1", done); });
  const address = provider.address();
  assert.ok(address && typeof address !== "string");
  providerOrigin = `http://127.0.0.1:${address.port}/v1/responses`;
}

async function stopProvider() {
  if (!provider) return;
  await new Promise((done, fail) => provider.close((error) => error ? fail(error) : done()));
  provider = undefined;
}

function launch(args, label) {
  const child = spawn(process.execPath, [wrangler, ...args], {
    cwd: root, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  child.log = "";
  child.stdout.on("data", (value) => { child.log += value; });
  child.stderr.on("data", (value) => { child.log += value; });
  child.done = new Promise((done) => { child.once("error", (error) => { child.launchError = error; done(); }); child.once("close", done); });
  child.label = label;
  children.add(child);
  return child;
}

async function stop(child) {
  if (!child || !children.has(child)) return;
  if (child.exitCode === null && child.signalCode === null && !child.launchError) {
    if (process.platform === "win32") {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      const code = await new Promise((done, fail) => { killer.once("error", fail); killer.once("exit", done); });
      if (code !== 0 && child.exitCode === null && child.signalCode === null) throw new Error(`Could not stop owned ${child.label} process ${child.pid}.`);
    } else process.kill(-child.pid, "SIGTERM");
    await Promise.race([child.done, delay(10_000, undefined, { ref: false }).then(() => { throw new Error("Owned process did not stop."); })]);
  }
  children.delete(child);
  record("stopped-owned-process", { label: child.label, pid: child.pid });
}

async function availablePort() {
  const server = createTcpServer();
  await new Promise((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", done); });
  const port = server.address().port;
  await new Promise((done, fail) => server.close((error) => error ? fail(error) : done()));
  return port;
}

async function migrate() {
  const child = launch(["d1", "migrations", "apply", "DB", "--config", "wrangler.jsonc", "--local", "--persist-to", stateArgument], "migration");
  await Promise.race([child.done, delay(45_000, undefined, { ref: false }).then(() => { throw new Error("Local migration timed out."); })]);
  assert.equal(child.exitCode, 0, `Isolated migration failed: ${child.log}`);
  await stop(child);
  record("migrations-applied", { exitCode: child.exitCode });
}

async function startWorker() {
  const port = await availablePort();
  origin = `http://127.0.0.1:${port}`;
  worker = launch(["dev", "--config", "wrangler.jsonc", "--local", "--persist-to", stateArgument,
    // The mock endpoints use fixed sentinel authorization internally. Supply a
    // non-secret binding only to satisfy the application's configuration gate;
    // this isolated check must never depend on a developer's .dev.vars file.
    "--var", "OPENAI_API_KEY:offline-summary-test-key", "--var", `LOCAL_SUMMARY_PROVIDER_URL:${providerOrigin}`, "--var", `LOCAL_METADATA_PROVIDER_URL:${providerOrigin}`,
    "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", "0", "--show-interactive-dev-session=false"], "Worker");
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (worker.launchError || worker.exitCode !== null || worker.signalCode !== null) throw new Error(`Owned Worker exited before readiness: ${worker.log}`);
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        assert.deepEqual(await response.json(), { status: "ok" });
        record("worker-started", { pid: worker.pid, origin });
        return;
      }
      await response.body?.cancel();
    } catch { /* Worker may still be starting. */ }
    await delay(200);
  }
  throw new Error("Owned Worker did not become ready.");
}

async function jsonRequest(path, init, expectedStatus) {
  const response = await fetch(`${origin}${path}`, { ...init, signal: AbortSignal.timeout(45_000) });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-type") ?? "", /application\/json/u);
  const body = await response.json();
  if (expectedStatus !== undefined) assert.equal(response.status, expectedStatus, JSON.stringify(body));
  return { response, body };
}

async function uploadAndExtract(bytes = fixture.bytes, filename = "summary-fixture.pdf") {
  const uploaded = await jsonRequest("/api/documents", { method: "POST", body: uploadBody(bytes, filename) }, 201);
  assert.equal(uploaded.body.document.sha256, sha256(bytes));
  const extracted = await jsonRequest(`/api/documents/${uploaded.body.document.id}/extract`, { method: "POST" }, 201);
  return { document: uploaded.body.document, extraction: extracted.body.extraction };
}

async function download(document, bytes) {
  const response = await fetch(`${origin}/api/documents/${document.id}/pdf`, { signal: AbortSignal.timeout(30_000) });
  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
}

function artifactRequest(path) {
  return new Request(`https://summary-check.invalid${path}`, { method: "POST" });
}

function artifactDocumentRow(documentId) {
  return { id: documentId, filename: "fixture.pdf", byte_count: 1, sha256: "a".repeat(64), object_key: `uploaded_documents/${documentId}.pdf`, uploaded_at: "2026-10-09T00:00:00.000Z", status: "stored" };
}

function artifactExtractionRow(documentId) {
  return { document_id: documentId, source_sha256: "a".repeat(64), parser: "unpdf", parser_version: "unpdf@1.8.1/pdfjs@6.1.200", extracted_at: "2026-10-09T00:00:00.000Z", page_count: 1, pages_json: JSON.stringify([{ pageNumber: 1, text: "fixture text" }]) };
}

async function artifactFailureChecks() {
  const documentId = "11111111-1111-4111-8111-111111111111";
  const missingStorage = await workerArtifact.fetch(artifactRequest(`/api/documents/${documentId}/summary`), {});
  assert.equal(missingStorage.status, 503);
  assert.equal((await missingStorage.json()).error.kind, "storage_unavailable");
  const db = { prepare(sql) { return { bind() { return { async first() { return sql.includes("uploaded_documents") ? artifactDocumentRow(documentId) : sql.includes("document_extractions") ? artifactExtractionRow(documentId) : null; } }; } }; } };
  const missingConfiguration = await workerArtifact.fetch(artifactRequest(`/api/documents/${documentId}/summary`), { DB: db, PAPER_BUCKET: {} });
  assert.equal(missingConfiguration.status, 424);
  assert.equal((await missingConfiguration.json()).error.kind, "summary_missing_configuration");
  record("built-worker-summary-storage-and-configuration-failures-passed", { missingStorage: 503, missingConfiguration: 424 });
}

async function expectSummaryFailure(mode, kind, status, bytes = fixture.bytes) {
  const prepared = await uploadAndExtract(bytes, `${mode}.pdf`);
  summaryMode = mode;
  const beforeCalls = summaryProviderCalls;
  const failed = await jsonRequest(`/api/documents/${prepared.document.id}/summary`, { method: "POST" }, status);
  assert.equal(failed.body.error.kind, kind);
  assert.equal(summaryProviderCalls, beforeCalls + 1);
  const get = await jsonRequest(`/api/documents/${prepared.document.id}/summary`, undefined, 404);
  assert.equal(get.body.error.kind, "summary_not_found");
  summaryMode = "valid";
}

async function main() {
  await mkdir(state, { recursive: true });
  await startProvider();
  await artifactFailureChecks();
  await migrate();
  await startWorker();

  const missingText = await jsonRequest("/api/documents", { method: "POST", body: uploadBody(fixture.bytes, "summary-not-extracted.pdf") }, 201);
  const noText = await jsonRequest(`/api/documents/${missingText.body.document.id}/summary`, { method: "POST" }, 404);
  assert.equal(noText.body.error.kind, "extraction_not_found");

  const primary = await uploadAndExtract();
  const before = await jsonRequest(`/api/documents/${primary.document.id}/summary`, undefined, 404);
  assert.equal(before.body.error.kind, "summary_not_found");
  const bodyRejected = await jsonRequest(`/api/documents/${primary.document.id}/summary`, { method: "POST", body: "client summary is never accepted" }, 400);
  assert.equal(bodyRejected.body.error.kind, "invalid_request");
  const metadata = await jsonRequest(`/api/documents/${primary.document.id}/metadata`, { method: "POST" }, 201);
  const textBeforeSummary = await jsonRequest(`/api/documents/${primary.document.id}/text`, undefined, 200);
  await download(primary.document, fixture.bytes);
  summaryMode = "valid";
  const first = await jsonRequest(`/api/documents/${primary.document.id}/summary`, { method: "POST" }, 201);
  assert.equal(first.body.created, true);
  assert.deepEqual(first.body.summary.includedPageNumbers, [1, 2, 3, 4]);
  assert.deepEqual(first.body.summary.includedPageRanges, [{ startPage: 1, endPage: 4 }]);
  assert.equal(first.body.summary.totalPageCount, 4);
  assert.equal(first.body.summary.sourceExcerptTruncated, false);
  assert.match(first.body.summary.sourceCoverageWarning, /all 4 extracted page/u);
  assert.equal(first.body.summary.overview.evidence[0].pageNumber, 1);
  assert.equal(first.body.summary.findings[0].evidence[0].pageNumber, 4);
  assert.notEqual(first.body.summary.overview.text, expected.overviewQuote, "summary prose may paraphrase");
  assert.match(first.body.summary.model, /\S/u);
  assert.equal(first.body.summary.promptVersion, "document-summary-v2");
  assert.equal(first.body.summary.schemaVersion, "document-summary-schema-v2");
  assert.deepEqual((await jsonRequest(`/api/documents/${primary.document.id}/metadata`, undefined, 200)).body.metadata, metadata.body.metadata);
  assert.deepEqual((await jsonRequest(`/api/documents/${primary.document.id}/text`, undefined, 200)).body.extraction, textBeforeSummary.body.extraction);
  await download(primary.document, fixture.bytes);
  const summaryCallsAfterFirst = summaryProviderCalls;
  const cached = await jsonRequest(`/api/documents/${primary.document.id}/summary`, { method: "POST" }, 200);
  assert.equal(cached.body.created, false);
  assert.deepEqual(cached.body.summary, first.body.summary);
  assert.equal(summaryProviderCalls, summaryCallsAfterFirst, "cached summary POST must not call provider");
  assert.deepEqual((await jsonRequest(`/api/documents/${primary.document.id}/summary`, undefined, 200)).body.summary, first.body.summary);
  assert.equal(summaryProviderCalls, summaryCallsAfterFirst, "summary GET must not call provider");
  assert.deepEqual(evidence.providerRequests.find((request) => request.kind === "summary" && request.mode === "valid").pageMarkers, [1, 2, 3, 4]);
  record("actual-worker-summary-includes-opening-and-later-pages-evidence-cache-and-unchanged-metadata-text-pdf", { documentId: primary.document.id, summaryProviderCalls: summaryCallsAfterFirst, metadataProviderCalls });

  const concurrent = await uploadAndExtract();
  summaryMode = "slow";
  const started = new Promise((done) => { summaryProviderStarted = done; });
  const firstConcurrent = jsonRequest(`/api/documents/${concurrent.document.id}/summary`, { method: "POST" });
  await started;
  const secondConcurrent = await jsonRequest(`/api/documents/${concurrent.document.id}/summary`, { method: "POST" }, 409);
  assert.equal(secondConcurrent.body.error.kind, "summary_in_progress");
  assert.equal((await firstConcurrent).response.status, 201);
  assert.equal(summaryProviderCalls, summaryCallsAfterFirst + 1, "only one concurrent summary provider call is allowed");
  summaryMode = "valid";
  record("concurrent-summary-request-used-one-provider-call", { documentId: concurrent.document.id });

  const firstPid = worker.pid;
  await stop(worker);
  await startWorker();
  assert.notEqual(worker.pid, firstPid);
  assert.deepEqual((await jsonRequest(`/api/documents/${primary.document.id}/summary`, undefined, 200)).body.summary, first.body.summary);
  assert.deepEqual((await jsonRequest(`/api/documents/${primary.document.id}/metadata`, undefined, 200)).body.metadata, metadata.body.metadata);
  assert.deepEqual((await jsonRequest(`/api/documents/${primary.document.id}/text`, undefined, 200)).body.extraction, textBeforeSummary.body.extraction);
  await download(primary.document, fixture.bytes);
  record("restart-read-summary-before-another-provider-call-preserves-metadata-text-and-pdf", { documentId: primary.document.id });

  await stop(worker);
  await migrate();
  await startWorker();
  assert.deepEqual((await jsonRequest(`/api/documents/${primary.document.id}/summary`, undefined, 200)).body.summary, first.body.summary);
  assert.deepEqual((await jsonRequest(`/api/documents/${primary.document.id}/metadata`, undefined, 200)).body.metadata, metadata.body.metadata);
  await download(primary.document, fixture.bytes);
  record("migration-reapply-preserves-summary-metadata-and-original-bytes", { documentId: primary.document.id });

  const clipped = await uploadAndExtract(clippedFixture.bytes, "summary-source-budget.pdf");
  summaryMode = "clipped";
  const clippedSummary = await jsonRequest(`/api/documents/${clipped.document.id}/summary`, { method: "POST" }, 201);
  assert.equal(clippedSummary.body.summary.sourceExcerptTruncated, true);
  assert.equal(clippedSummary.body.summary.totalPageCount, 4);
  assert.deepEqual(clippedSummary.body.summary.includedPageNumbers, [1, 2, 3, 4]);
  assert.deepEqual(clippedSummary.body.summary.includedPageRanges, [{ startPage: 1, endPage: 4 }]);
  assert.ok(clippedSummary.body.summary.sourceExcerptByteCount <= 96 * 1024);
  assert.match(clippedSummary.body.summary.sourceCoverageWarning, /Partial source coverage/u);
  assert.ok(clippedSummary.body.summary.warnings.includes(clippedSummary.body.summary.sourceCoverageWarning));
  assert.equal(clippedSummary.body.summary.overview.evidence[0].quote, clippedFixture.expected.quote);
  const clippedRequest = evidence.providerRequests.at(-1);
  assert.deepEqual(clippedRequest.pageMarkers, [1, 2, 3, 4]);
  assert.deepEqual((await jsonRequest(`/api/documents/${clipped.document.id}/text`, undefined, 200)).body.extraction.pages.map((page) => page.pageNumber), [1, 2, 3, 4]);
  record("summary-source-budget-truncates-at-a-page-aware-utf8-boundary", { documentId: clipped.document.id, byteBudget: 96 * 1024, includedPages: [1, 2, 3, 4], totalPages: 4 });
  summaryMode = "valid";

  assert.equal(new TextEncoder().encode(multibyteFixture.multibyteEvidenceQuote).byteLength, 600);
  const unicodeLimit = await uploadAndExtract(multibyteFixture.bytes, "summary-evidence-600-utf8-bytes.pdf");
  summaryMode = "multibyte_600";
  const unicodeAccepted = await jsonRequest(`/api/documents/${unicodeLimit.document.id}/summary`, { method: "POST" }, 201);
  assert.ok(new TextEncoder().encode(unicodeAccepted.body.summary.overview.evidence[0].quote).byteLength <= 600);
  await expectSummaryFailure("unissued_reference", "summary_invalid_response", 502);
  await expectSummaryFailure("invented_evidence", "summary_invalid_response", 502);
  await expectSummaryFailure("too_many_words", "summary_invalid_response", 502);
  assert.match(worker.log, /"event":"summary_evidence_rejected"[^\n]*"reason":"reference_not_issued"/u);
  assert.match(worker.log, /"event":"summary_evidence_rejected"[^\n]*"reason":"reference_shape"/u);
  record("summary-evidence-server-references-invalid-reference-diagnostics-and-utf8-output-limits-passed", { maximumResolvedQuoteBytes: 600, proseWordLimit: 500 });

  await expectSummaryFailure("malformed", "summary_invalid_response", 502);
  await expectSummaryFailure("refusal", "summary_refusal", 422);
  await expectSummaryFailure("incomplete", "summary_incomplete", 502);
  await expectSummaryFailure("http_error", "summary_provider_failure", 502);
  await expectSummaryFailure("timeout", "summary_timeout", 504);
  record("summary-malformed-refusal-incomplete-provider-timeout-failures-leave-no-summary", { failureModes: 5 });

  for (const request of evidence.providerRequests.filter((request) => request.kind === "summary")) {
    assert.equal(request.store, false);
    assert.equal(request.maxOutputTokens, 2048);
    assert.equal(request.hasTools, false);
    assert.equal(request.strictSchema, true);
    assert.equal(request.hasSummaryInstructions, true);
    assert.equal(request.usesServerEvidenceReferences, true);
  }
  evidence.result = "passed";
}

try {
  await main();
} catch (error) {
  evidence.result = "failed";
  evidence.error = String(error.stack ?? error);
  console.error(evidence.error);
  process.exitCode = 1;
} finally {
  for (const child of [...children]) {
    try { await stop(child); } catch (error) { console.error(`Owned process cleanup failed: ${error}`); process.exitCode = 1; }
  }
  try { await stopProvider(); } catch (error) { console.error(`Owned provider cleanup failed: ${error}`); process.exitCode = 1; }
  if (process.exitCode) evidence.result = "failed";
  if (evidence.result === "passed") {
    try {
      const actual = await realpath(state);
      const owner = await realpath(evidenceDirectory);
      assert.equal(dirname(actual), owner);
      assert.equal(actual, resolve(owner, "state"));
      assert.ok(owner.startsWith(resolve(root, ".wrangler/summary-check") + sep));
      await rm(actual, { recursive: true, force: false, maxRetries: 8, retryDelay: 250 });
      record("removed-owned-test-state", { state });
    } catch (error) {
      evidence.result = "failed";
      console.error(`Owned state cleanup failed: ${error}`);
      process.exitCode = 1;
    }
  }
  evidence.finishedAt = new Date().toISOString();
  await writeFile(resolve(evidenceDirectory, "result.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log(`Summary check ${evidence.result}. Evidence: ${resolve(evidenceDirectory, "result.json")}`);
}
