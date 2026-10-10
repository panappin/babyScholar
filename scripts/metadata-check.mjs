import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer as createTcpServer } from "node:net";
import { dirname, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import workerArtifact from "../dist/worker/index.js";
import { createDashBoundaryPdfFixture, createMetadataClippedPdfFixture, createMetadataPdfFixture, createWrappedMetadataPdfFixture } from "./fixtures/pdf-fixtures.mjs";

const root = resolve(import.meta.dirname, "..");
const wrangler = resolve(root, "node_modules/wrangler/bin/wrangler.js");
const id = randomUUID();
const evidenceDirectory = resolve(root, ".wrangler/metadata-check", id);
const state = resolve(evidenceDirectory, "state");
const children = new Set();
const fixture = createMetadataPdfFixture();
const expected = fixture.expected;
const wrappedFixture = createWrappedMetadataPdfFixture();
const dashBoundaryFixture = createDashBoundaryPdfFixture();
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
let providerMode = "valid";
let providerCalls = 0;
let providerStarted;

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

function validOutput() {
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

function invalidEvidenceOutput(mode) {
  const output = validOutput();
  const quote = output.evidence.title[0];
  if (mode === "evidence_quote_shape") output.evidence.title = [{ pageNumber: 1 }];
  else if (mode === "evidence_page_number_type") quote.pageNumber = "1";
  else if (mode === "evidence_page_number_integer") quote.pageNumber = 1.5;
  else if (mode === "evidence_quote_type") quote.quote = 1;
  else if (mode === "evidence_quote_empty") quote.quote = "";
  else if (mode === "evidence_quote_untrimmed") quote.quote = ` ${expected.title}`;
  else if (mode === "evidence_quote_600_multibyte") quote.quote = fixture.multibyteEvidenceQuote;
  else if (mode === "evidence_quote_601_multibyte") quote.quote = `${fixture.multibyteEvidenceQuote}x`;
  return output;
}

function wrappedOutput() {
  const expectedWrapped = wrappedFixture.expected;
  return {
    title: expectedWrapped.title,
    authors: expectedWrapped.authors,
    year: expectedWrapped.year,
    abstract: expectedWrapped.abstract,
    evidence: {
      title: [{ pageNumber: 1, quote: expectedWrapped.title }],
      authors: [{ pageNumber: 1, quote: "Avery Example; Bao Example" }],
      year: [{ pageNumber: 1, quote: "Published: 2024" }],
      abstract: [{ pageNumber: 1, quote: "Abstract: This controlled interpretation evaluates state-of-the-art performance on 17 source-grounded records." }],
    },
    warnings: [],
  };
}

function wrappedLiteralOutput() {
  const output = wrappedOutput();
  output.abstract = "This controlled interpreta-\ntion evaluates state-of-the-art per-\nformance on 17 source-grounded records.";
  output.evidence.abstract = [{ pageNumber: 1, quote: `Abstract: ${output.abstract}` }];
  return output;
}

function dashRemovalOutput() {
  const expectedDash = dashBoundaryFixture.expected;
  return {
    title: expectedDash.title,
    authors: expectedDash.authors,
    year: expectedDash.year,
    abstract: "This endash and emdash remain literal.",
    evidence: {
      title: [{ pageNumber: 1, quote: expectedDash.title }],
      authors: [{ pageNumber: 1, quote: "Avery Example" }],
      year: [{ pageNumber: 1, quote: "Published: 2024" }],
      abstract: [{ pageNumber: 1, quote: "Abstract: This endash and emdash remain literal." }],
    },
    warnings: [],
  };
}

function unknownOutput() {
  return {
    title: null,
    authors: null,
    year: null,
    abstract: null,
    evidence: { title: [], authors: [], year: [], abstract: [] },
    warnings: [
      "title is unknown in the selected source.",
      "authors are unknown in the selected source.",
      "year is unknown in the selected source.",
      "abstract is unknown in the selected source.",
    ],
  };
}

function providerResponse(output) {
  return {
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }],
  };
}

async function readRequestBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > 128 * 1024) throw new Error("Mock provider request exceeded its check limit.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function startProvider() {
  provider = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.url !== "/v1/responses" || request.headers.authorization !== "Bearer local-metadata-test-key") {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "unexpected mock request" } }));
        return;
      }
      const body = await readRequestBody(request);
      const userInput = body.input?.[1]?.content;
      const markers = typeof userInput === "string" ? [...userInput.matchAll(/\[Page (\d+)\]/gu)].map((match) => Number(match[1])) : [];
      const format = body.text?.format;
      evidence.providerRequests.push({
        mode: providerMode,
        model: body.model,
        store: body.store,
        maxOutputTokens: body.max_output_tokens,
        hasTools: Object.hasOwn(body, "tools"),
        strictSchema: format?.type === "json_schema" && format?.strict === true && format?.schema?.additionalProperties === false,
        hasEvidenceQuoteLimitInstruction: typeof userInput === "string"
          && userInput.includes("at most 600 UTF-8 bytes")
          && userInput.includes("Prefer the shortest supporting excerpt"),
        pageMarkers: markers,
      });
      providerCalls += 1;
      providerStarted?.();
      providerStarted = undefined;
      if (providerMode === "slow") await delay(350);
      if (providerMode === "http_error") {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "mock upstream failure" } }));
        return;
      }
      let payload;
      if (providerMode === "unknown") payload = providerResponse(unknownOutput());
      else if (providerMode.startsWith("evidence_")) payload = providerResponse(invalidEvidenceOutput(providerMode));
      else if (providerMode === "wrapped") payload = providerResponse(wrappedOutput());
      else if (providerMode === "wrapped_literal") payload = providerResponse(wrappedLiteralOutput());
      else if (providerMode === "wrapped_compound_deleted") {
        const output = wrappedOutput();
        output.abstract = output.abstract.replace("state-of-the-art", "state of the art");
        payload = providerResponse(output);
      } else if (providerMode === "wrapped_number_changed") {
        const output = wrappedOutput();
        output.abstract = output.abstract.replace("17", "18");
        payload = providerResponse(output);
      } else if (providerMode === "wrapped_word_changed") {
        const output = wrappedOutput();
        output.abstract = output.abstract.replace("controlled", "invented");
        payload = providerResponse(output);
      } else if (providerMode === "wrapped_wrong_page") {
        const output = wrappedOutput();
        output.evidence.abstract = [{ pageNumber: 2, quote: output.evidence.abstract[0].quote }];
        payload = providerResponse(output);
      } else if (providerMode === "dash_removed") {
        payload = providerResponse(dashRemovalOutput());
      }
      else if (providerMode === "wrong_evidence") {
        const output = validOutput();
        output.evidence.title = [{ pageNumber: 1, quote: "not present in source" }];
        payload = providerResponse(output);
      } else if (providerMode === "malformed") {
        payload = { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "{" }] }] };
      }
      else if (providerMode === "refusal") payload = { status: "completed", output: [{ content: [{ type: "refusal", refusal: "mock refusal" }] }] };
      else if (providerMode === "incomplete") payload = { status: "incomplete" };
      else payload = providerResponse(validOutput());
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
    cwd: root,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  child.log = "";
  child.stdout.on("data", (value) => { child.log += value; });
  child.stderr.on("data", (value) => { child.log += value; });
  child.done = new Promise((done) => {
    child.once("error", (error) => { child.launchError = error; done(); });
    child.once("close", done);
  });
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
  const child = launch(["d1", "migrations", "apply", "DB", "--config", "wrangler.jsonc", "--local", "--persist-to", state], "migration");
  await Promise.race([child.done, delay(45_000, undefined, { ref: false }).then(() => { throw new Error("Local migration timed out."); })]);
  assert.equal(child.exitCode, 0, `Isolated migration failed: ${child.log}`);
  await stop(child);
  record("migrations-applied", { exitCode: child.exitCode });
}

async function startWorker() {
  const port = await availablePort();
  origin = `http://127.0.0.1:${port}`;
  worker = launch(["dev", "--config", "wrangler.jsonc", "--local", "--persist-to", state,
    // A fixed inert value keeps this loopback-only verifier independent from
    // the user's Worker-only .dev.vars secret.
    "--var", "OPENAI_API_KEY:offline-metadata-test-key", "--var", `LOCAL_METADATA_PROVIDER_URL:${providerOrigin}`, "--ip", "127.0.0.1", "--port", String(port),
    "--inspector-port", "0", "--show-interactive-dev-session=false"], "Worker");
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
    } catch { /* The owned Worker may still be starting. */ }
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

async function uploadAndExtract(bytes = fixture.bytes, filename = "metadata-fixture.pdf") {
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
  return new Request(`https://metadata-check.invalid${path}`, { method: "POST" });
}

function artifactDocumentRow(documentId) {
  return { id: documentId, filename: "fixture.pdf", byte_count: 1, sha256: "a".repeat(64), object_key: `uploaded_documents/${documentId}.pdf`, uploaded_at: "2026-10-08T00:00:00.000Z", status: "stored" };
}

function artifactExtractionRow(documentId) {
  return { document_id: documentId, source_sha256: "a".repeat(64), parser: "unpdf", parser_version: "unpdf@1.8.1/pdfjs@6.1.200", extracted_at: "2026-10-08T00:00:00.000Z", page_count: 1, pages_json: JSON.stringify([{ pageNumber: 1, text: "fixture text" }]) };
}

async function artifactFailureChecks() {
  const documentId = "11111111-1111-4111-8111-111111111111";
  const missingStorage = await workerArtifact.fetch(artifactRequest(`/api/documents/${documentId}/metadata`), {});
  assert.equal(missingStorage.status, 503);
  assert.equal((await missingStorage.json()).error.kind, "storage_unavailable");
  const db = {
    prepare(sql) {
      return { bind() { return { async first() { return sql.includes("uploaded_documents") ? artifactDocumentRow(documentId) : sql.includes("document_extractions") ? artifactExtractionRow(documentId) : null; } }; } };
    },
  };
  const missingConfiguration = await workerArtifact.fetch(artifactRequest(`/api/documents/${documentId}/metadata`), { DB: db, PAPER_BUCKET: {} });
  assert.equal(missingConfiguration.status, 424);
  assert.equal((await missingConfiguration.json()).error.kind, "metadata_missing_configuration");
  record("built-worker-missing-storage-and-configuration-failures-passed", { missingStorage: 503, missingConfiguration: 424 });
}

async function expectFailure(mode, kind, status) {
  const prepared = await uploadAndExtract();
  providerMode = mode;
  const beforeCalls = providerCalls;
  const failed = await jsonRequest(`/api/documents/${prepared.document.id}/metadata`, { method: "POST" }, status);
  assert.equal(failed.body.error.kind, kind);
  assert.equal(providerCalls, beforeCalls + 1);
  const get = await jsonRequest(`/api/documents/${prepared.document.id}/metadata`, undefined, 404);
  assert.equal(get.body.error.kind, "metadata_not_found");
  providerMode = "valid";
  const recovered = await jsonRequest(`/api/documents/${prepared.document.id}/metadata`, { method: "POST" }, 201);
  assert.equal(recovered.body.created, true, `${mode} must release only its own claim for a later explicit request`);
}

async function expectEvidenceFailure(mode, reason) {
  const prepared = await uploadAndExtract();
  providerMode = mode;
  const logStart = worker.log.length;
  const beforeCalls = providerCalls;
  const failed = await jsonRequest(`/api/documents/${prepared.document.id}/metadata`, { method: "POST" }, 502);
  assert.equal(failed.body.error.kind, "metadata_invalid_response");
  assert.equal(providerCalls, beforeCalls + 1);
  const diagnosticLog = worker.log.slice(logStart);
  assert.match(diagnosticLog, new RegExp(`metadata_evidence_rejected.*"field":"title","index":0,"reason":"${reason}"`, "u"));
  const get = await jsonRequest(`/api/documents/${prepared.document.id}/metadata`, undefined, 404);
  assert.equal(get.body.error.kind, "metadata_not_found");
  providerMode = "valid";
  const recovered = await jsonRequest(`/api/documents/${prepared.document.id}/metadata`, { method: "POST" }, 201);
  assert.equal(recovered.body.created, true, `${mode} must release only its own claim for a later explicit request`);
}

async function main() {
  await mkdir(state, { recursive: true });
  await startProvider();
  await artifactFailureChecks();
  await migrate();
  await startWorker();

  const missingTextUpload = await jsonRequest("/api/documents", { method: "POST", body: uploadBody(fixture.bytes, "not-extracted.pdf") }, 201);
  const noText = await jsonRequest(`/api/documents/${missingTextUpload.body.document.id}/metadata`, { method: "POST" }, 404);
  assert.equal(noText.body.error.kind, "extraction_not_found");

  const primary = await uploadAndExtract();
  const before = await jsonRequest(`/api/documents/${primary.document.id}/metadata`, undefined, 404);
  assert.equal(before.body.error.kind, "metadata_not_found");
  const bodyRejected = await jsonRequest(`/api/documents/${primary.document.id}/metadata`, { method: "POST", body: "client metadata is never accepted" }, 400);
  assert.equal(bodyRejected.body.error.kind, "invalid_request");
  providerMode = "valid";
  const first = await jsonRequest(`/api/documents/${primary.document.id}/metadata`, { method: "POST" }, 201);
  assert.equal(first.body.created, true);
  assert.deepEqual(first.body.metadata.title, expected.title);
  assert.deepEqual(first.body.metadata.authors, expected.authors);
  assert.equal(first.body.metadata.year, expected.year);
  assert.equal(first.body.metadata.abstract, expected.abstract);
  assert.deepEqual(first.body.metadata.selectedPageNumbers, [1, 2]);
  assert.equal(first.body.metadata.sourceExcerptClipped, false);
  assert.equal(first.body.metadata.sourceSha256, primary.document.sha256);
  assert.equal(first.body.metadata.extractionExtractedAt, primary.extraction.extractedAt);
  assert.match(first.body.metadata.model, /\S/u);
  assert.equal(first.body.metadata.promptVersion, "document-metadata-v2");
  for (const field of ["title", "authors", "year", "abstract"]) assert.equal(first.body.metadata.evidence[field].length, 1);
  assert.deepEqual((await jsonRequest(`/api/documents/${primary.document.id}/text`, undefined, 200)).body.extraction, primary.extraction);
  await download(primary.document, fixture.bytes);
  const callsAfterFirst = providerCalls;
  const repeated = await jsonRequest(`/api/documents/${primary.document.id}/metadata`, { method: "POST" }, 200);
  assert.equal(repeated.body.created, false);
  assert.deepEqual(repeated.body.metadata, first.body.metadata);
  assert.equal(providerCalls, callsAfterFirst, "cached POST must not call the provider");
  assert.deepEqual((await jsonRequest(`/api/documents/${primary.document.id}/metadata`, undefined, 200)).body.metadata, first.body.metadata);
  assert.equal(providerCalls, callsAfterFirst, "GET must not call the provider");
  record("actual-worker-four-fields-evidence-cache-and-original-bytes-passed", { documentId: primary.document.id, providerCalls: callsAfterFirst });

  const concurrent = await uploadAndExtract();
  providerMode = "slow";
  const started = new Promise((done) => { providerStarted = done; });
  const firstConcurrent = jsonRequest(`/api/documents/${concurrent.document.id}/metadata`, { method: "POST" });
  await started;
  const secondConcurrent = await jsonRequest(`/api/documents/${concurrent.document.id}/metadata`, { method: "POST" }, 409);
  assert.equal(secondConcurrent.body.error.kind, "metadata_in_progress");
  const completedConcurrent = await firstConcurrent;
  assert.equal(completedConcurrent.response.status, 201);
  assert.equal(providerCalls, callsAfterFirst + 1, "only one concurrent provider call is allowed");
  providerMode = "valid";
  record("concurrent-metadata-request-used-one-provider-call", { documentId: concurrent.document.id });

  const firstPid = worker.pid;
  await stop(worker);
  await startWorker();
  assert.notEqual(worker.pid, firstPid);
  const restartRead = await jsonRequest(`/api/documents/${primary.document.id}/metadata`, undefined, 200);
  assert.deepEqual(restartRead.body.metadata, first.body.metadata);
  await download(primary.document, fixture.bytes);
  assert.deepEqual((await jsonRequest(`/api/documents/${primary.document.id}/text`, undefined, 200)).body.extraction, primary.extraction);
  record("restart-read-metadata-before-another-provider-call-passed", { documentId: primary.document.id });

  await stop(worker);
  await migrate();
  await startWorker();
  assert.deepEqual((await jsonRequest(`/api/documents/${primary.document.id}/metadata`, undefined, 200)).body.metadata, first.body.metadata);
  await download(primary.document, fixture.bytes);
  record("migration-reapply-preserves-metadata-text-and-original-bytes", { documentId: primary.document.id });

  const wrapped = await uploadAndExtract(wrappedFixture.bytes, "wrapped-metadata.pdf");
  providerMode = "wrapped";
  const wrappedResult = await jsonRequest(`/api/documents/${wrapped.document.id}/metadata`, { method: "POST" }, 201);
  assert.equal(wrappedResult.body.metadata.abstract, wrappedFixture.expected.abstract);
  assert.equal(wrappedResult.body.metadata.evidence.abstract[0].quote, "Abstract: This controlled interpretation evaluates state-of-the-art performance on 17 source-grounded records.");
  const wrappedCached = await jsonRequest(`/api/documents/${wrapped.document.id}/metadata`, { method: "POST" }, 200);
  assert.equal(wrappedCached.body.created, false);
  assert.deepEqual(wrappedCached.body.metadata, wrappedResult.body.metadata);
  assert.equal((await jsonRequest(`/api/documents/${wrapped.document.id}/text`, undefined, 200)).body.extraction.pages[0].text.includes("interpreta-\ntion"), true);
  const wrappedLiteral = await uploadAndExtract(wrappedFixture.bytes, "wrapped-literal-metadata.pdf");
  providerMode = "wrapped_literal";
  const literalResult = await jsonRequest(`/api/documents/${wrappedLiteral.document.id}/metadata`, { method: "POST" }, 201);
  assert.equal(literalResult.body.metadata.abstract, "This controlled interpreta-\ntion evaluates state-of-the-art per-\nformance on 17 source-grounded records.");
  assert.equal(literalResult.body.metadata.evidence.abstract[0].quote, `Abstract: ${literalResult.body.metadata.abstract}`);
  for (const mode of ["wrapped_compound_deleted", "wrapped_number_changed", "wrapped_word_changed", "wrapped_wrong_page"]) {
    const rejected = await uploadAndExtract(wrappedFixture.bytes, `${mode}.pdf`);
    providerMode = mode;
    const response = await jsonRequest(`/api/documents/${rejected.document.id}/metadata`, { method: "POST" }, 502);
    assert.equal(response.body.error.kind, "metadata_invalid_response");
  }
  const dashBoundary = await uploadAndExtract(dashBoundaryFixture.bytes, "dash-boundary.pdf");
  assert.equal((await jsonRequest(`/api/documents/${dashBoundary.document.id}/text`, undefined, 200)).body.extraction.pages[0].text.includes("en–\ndash and em—\ndash"), true);
  providerMode = "dash_removed";
  const dashRejected = await jsonRequest(`/api/documents/${dashBoundary.document.id}/metadata`, { method: "POST" }, 502);
  assert.equal(dashRejected.body.error.kind, "metadata_invalid_response");
  providerMode = "valid";
  record("wrapped-word-literal-and-joined-comparison-preserves-dashes-compounds-numbers-evidence-and-cache", { documentId: wrapped.document.id });

  assert.equal(new TextEncoder().encode(fixture.multibyteEvidenceQuote).byteLength, 600);
  const exactLimit = await uploadAndExtract(fixture.bytes, "evidence-600-utf8-bytes.pdf");
  providerMode = "evidence_quote_600_multibyte";
  const exactLimitResult = await jsonRequest(`/api/documents/${exactLimit.document.id}/metadata`, { method: "POST" }, 201);
  assert.equal(exactLimitResult.body.metadata.evidence.title[0].quote, fixture.multibyteEvidenceQuote);
  for (const [mode, reason] of [
    ["evidence_quote_shape", "quote_shape"],
    ["evidence_page_number_type", "page_number_type"],
    ["evidence_page_number_integer", "page_number_integer"],
    ["evidence_quote_type", "quote_type"],
    ["evidence_quote_empty", "quote_empty"],
    ["evidence_quote_untrimmed", "quote_untrimmed"],
    ["evidence_quote_601_multibyte", "quote_too_large"],
  ]) {
    await expectEvidenceFailure(mode, reason);
  }
  providerMode = "valid";
  record("evidence-diagnostics-and-600-utf8-byte-boundary-passed", {
    acceptedQuoteBytes: 600,
    rejectedQuoteBytes: 601,
    rejectionReasons: ["quote_shape", "page_number_type", "page_number_integer", "quote_type", "quote_empty", "quote_untrimmed", "quote_too_large"],
  });

  const unknown = await uploadAndExtract();
  providerMode = "unknown";
  const unknownResult = await jsonRequest(`/api/documents/${unknown.document.id}/metadata`, { method: "POST" }, 201);
  assert.deepEqual(unknownResult.body.metadata.authors, null);
  assert.equal(unknownResult.body.metadata.title, null);
  assert.equal(unknownResult.body.metadata.year, null);
  assert.equal(unknownResult.body.metadata.abstract, null);
  assert.equal(unknownResult.body.metadata.warnings.length, 4);

  const clipped = await uploadAndExtract(createMetadataClippedPdfFixture(), "clipped.pdf");
  providerMode = "unknown";
  const clippedResult = await jsonRequest(`/api/documents/${clipped.document.id}/metadata`, { method: "POST" }, 201);
  assert.deepEqual(clippedResult.body.metadata.selectedPageNumbers, [1, 2, 3]);
  assert.equal(clippedResult.body.metadata.sourceExcerptClipped, true);
  assert.deepEqual(evidence.providerRequests.at(-1).pageMarkers, [1, 2, 3]);
  record("unknown-fields-and-clipped-page-selection-passed", { unknownDocumentId: unknown.document.id, clippedDocumentId: clipped.document.id });

  await expectFailure("wrong_evidence", "metadata_invalid_response", 502);
  await expectFailure("malformed", "metadata_invalid_response", 502);
  await expectFailure("refusal", "metadata_refusal", 422);
  await expectFailure("incomplete", "metadata_incomplete", 502);
  await expectFailure("http_error", "metadata_provider_failure", 502);
  record("wrong-evidence-malformed-refused-incomplete-provider-failures-and-claim-release-passed", { failureModes: 5 });

  for (const request of evidence.providerRequests) {
    assert.equal(request.store, false);
    assert.equal(request.maxOutputTokens, 4096);
    assert.equal(request.hasTools, false);
    assert.equal(request.strictSchema, true);
    assert.equal(request.hasEvidenceQuoteLimitInstruction, true);
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
      assert.ok(owner.startsWith(resolve(root, ".wrangler/metadata-check") + sep));
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
  console.log(`Metadata check ${evidence.result}. Evidence: ${resolve(evidenceDirectory, "result.json")}`);
}
