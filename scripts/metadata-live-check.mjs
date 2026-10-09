import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { createMetadataPdfFixture } from "./fixtures/pdf-fixtures.mjs";

const root = resolve(import.meta.dirname, "..");
const wrangler = resolve(root, "node_modules/wrangler/bin/wrangler.js");
const offlineArgument = process.argv.find((argument) => argument.startsWith("--offline="));
const offlineScenario = offlineArgument?.slice("--offline=".length);
const offlineScenarios = new Set(["success", "field-mismatch", "application-error"]);
if (offlineScenario !== undefined && !offlineScenarios.has(offlineScenario)) {
  throw new Error("Use --offline=success, --offline=field-mismatch, or --offline=application-error.");
}

const id = randomUUID();
const evidenceDirectory = resolve(root, ".wrangler/metadata-live-check", id);
const state = resolve(evidenceDirectory, "state");
const fixture = createMetadataPdfFixture();
const children = new Set();
let worker;
let origin;
let offlineProvider;
let offlineProviderOrigin;
let offlineProviderRequests = 0;
const evidence = {
  id,
  mode: offlineScenario ? `offline:${offlineScenario}` : "live",
  startedAt: new Date().toISOString(),
  fixture: { source: "scripts/fixtures/pdf-fixtures.mjs", license: "CC0-1.0" },
  liveProviderRequests: 0,
  offlineProviderRequests: 0,
  stage: "initialized",
  steps: [],
  diagnostics: { responses: [], fixtureFields: [], cache: null, persistence: null, lastAssertion: null },
};

function compactText(value, maximum = 600) {
  if (typeof value !== "string") return value === null ? null : "invalid";
  return value.length <= maximum ? value : `${value.slice(0, maximum)}… [${value.length} characters]`;
}

function compactAuthors(value) {
  if (value === null) return null;
  if (!Array.isArray(value)) return "invalid";
  return value.slice(0, 32).map((author) => compactText(author, 256));
}

function metadataSummary(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const metadata = value;
  const evidenceCounts = typeof metadata.evidence === "object" && metadata.evidence !== null && !Array.isArray(metadata.evidence)
    ? Object.fromEntries(["title", "authors", "year", "abstract"].map((field) => [field, Array.isArray(metadata.evidence[field]) ? metadata.evidence[field].length : null]))
    : null;
  return {
    title: compactText(metadata.title),
    authors: compactAuthors(metadata.authors),
    year: typeof metadata.year === "number" || metadata.year === null ? metadata.year : "invalid",
    abstract: compactText(metadata.abstract),
    selectedPageNumbers: Array.isArray(metadata.selectedPageNumbers) ? metadata.selectedPageNumbers.slice(0, 3) : "invalid",
    sourceExcerptClipped: typeof metadata.sourceExcerptClipped === "boolean" ? metadata.sourceExcerptClipped : "invalid",
    promptVersion: compactText(metadata.promptVersion, 128),
    modelPresent: typeof metadata.model === "string" && metadata.model.trim().length > 0,
    evidenceCounts,
  };
}

function responseDiagnostic(path, response, body, bodyIsJson) {
  const error = body && typeof body === "object" && !Array.isArray(body) && typeof body.error === "object" && body.error !== null
    ? body.error
    : undefined;
  return {
    stage: evidence.stage,
    path,
    status: response.status,
    cacheControl: response.headers.get("cache-control"),
    jsonContentType: /application\/json/u.test(response.headers.get("content-type") ?? ""),
    bodyIsJson,
    errorKind: error && typeof error.kind === "string" ? error.kind : null,
    created: body && typeof body === "object" && !Array.isArray(body) && typeof body.created === "boolean" ? body.created : null,
    metadata: body && typeof body === "object" && !Array.isArray(body) ? metadataSummary(body.metadata) : null,
  };
}

function setStage(stage, details = {}) {
  evidence.stage = stage;
  evidence.steps.push({ stage, ...details });
  console.log(JSON.stringify({ stage, ...details }));
}

function assertRecorded(name, actual, expected) {
  evidence.diagnostics.lastAssertion = { stage: evidence.stage, name, actual, expected };
  assert.deepEqual(actual, expected, name);
}

async function configuredKeyIsAvailable() {
  if (typeof process.env.OPENAI_API_KEY === "string" && process.env.OPENAI_API_KEY.trim()) return true;
  try {
    const devVars = await readFile(resolve(root, ".dev.vars"), "utf8");
    return /^OPENAI_API_KEY=.+$/mu.test(devVars);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function launch(args, label) {
  const child = spawn(process.execPath, [wrangler, ...args], {
    cwd: root,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
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
      if (code !== 0 && child.exitCode === null && child.signalCode === null) throw new Error(`Could not stop owned ${child.label} process.`);
    } else {
      process.kill(-child.pid, "SIGTERM");
    }
    await Promise.race([child.done, delay(10_000, undefined, { ref: false }).then(() => { throw new Error("Owned process did not stop."); })]);
  }
  children.delete(child);
  setStage("owned-process-stopped", { label: child.label, pid: child.pid });
}

async function availablePort() {
  const server = createTcpServer();
  await new Promise((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", done); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((done, fail) => server.close((error) => error ? fail(error) : done()));
  return address.port;
}

async function migrate() {
  setStage("migration-started");
  const child = launch(["d1", "migrations", "apply", "DB", "--config", "wrangler.jsonc", "--local", "--persist-to", state], "migration");
  await Promise.race([child.done, delay(45_000, undefined, { ref: false }).then(() => { throw new Error("Local migration timed out."); })]);
  assertRecorded("migration-exit-code", child.exitCode, 0);
  await stop(child);
  setStage("migrations-applied", { exitCode: child.exitCode });
}

async function startWorker({ localMetadataProviderUrl, disableApiKey = false } = {}) {
  const port = await availablePort();
  origin = `http://127.0.0.1:${port}`;
  const bindingArguments = [];
  if (localMetadataProviderUrl) bindingArguments.push("--var", `LOCAL_METADATA_PROVIDER_URL:${localMetadataProviderUrl}`);
  if (disableApiKey) bindingArguments.push("--var", "OPENAI_API_KEY:");
  if (offlineScenario && !disableApiKey) bindingArguments.push("--var", "OPENAI_API_KEY:offline-metadata-test-key");
  setStage("worker-starting", { localProvider: Boolean(localMetadataProviderUrl), openAiKeyDisabled: disableApiKey });
  worker = launch([
    "dev", "--config", "wrangler.jsonc", "--local", "--persist-to", state,
    ...bindingArguments,
    "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", "0", "--show-interactive-dev-session=false",
  ], "Worker");
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (worker.launchError || worker.exitCode !== null || worker.signalCode !== null) throw new Error("Owned Worker exited before readiness.");
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        const body = await response.json();
        assertRecorded("worker-health-body", body, { status: "ok" });
        setStage("worker-started", { pid: worker.pid, origin, openAiKeyDisabled: disableApiKey });
        return;
      }
      await response.body?.cancel();
    } catch { /* The owned Worker may still be starting. */ }
    await delay(200);
  }
  throw new Error("Owned Worker did not become ready.");
}

function providerOutput() {
  const expected = fixture.expected;
  if (offlineScenario === "field-mismatch") {
    return {
      title: null,
      authors: expected.authors,
      year: expected.year,
      abstract: expected.abstract,
      evidence: {
        title: [],
        authors: [{ pageNumber: 1, quote: "Avery Example; Bao Example" }],
        year: [{ pageNumber: 1, quote: "Published: 2024" }],
        abstract: [{ pageNumber: 1, quote: `Abstract: ${expected.abstract}` }],
      },
      warnings: ["title is unknown in the selected source."],
    };
  }
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

async function startOfflineProvider() {
  if (!offlineScenario) return;
  offlineProvider = createHttpServer((request, response) => {
    offlineProviderRequests += 1;
    evidence.offlineProviderRequests = offlineProviderRequests;
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "unexpected local mock request" } }));
      return;
    }
    if (offlineScenario === "application-error") {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "offline provider failure" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(providerOutput()) }] }],
    }));
  });
  await new Promise((done, fail) => { offlineProvider.once("error", fail); offlineProvider.listen(0, "127.0.0.1", done); });
  const address = offlineProvider.address();
  assert.ok(address && typeof address !== "string");
  offlineProviderOrigin = `http://127.0.0.1:${address.port}/v1/responses`;
  setStage("offline-provider-started", { scenario: offlineScenario });
}

async function stopOfflineProvider() {
  if (!offlineProvider) return;
  await new Promise((done, fail) => offlineProvider.close((error) => error ? fail(error) : done()));
  offlineProvider = undefined;
  setStage("offline-provider-stopped", { requests: offlineProviderRequests });
}

async function jsonRequest(stage, path, init) {
  setStage(stage, { path, method: init?.method ?? "GET" });
  const response = await fetch(`${origin}${path}`, { ...init, signal: AbortSignal.timeout(45_000) });
  let body;
  let bodyIsJson = true;
  try {
    body = await response.json();
  } catch {
    bodyIsJson = false;
  }
  const diagnostic = responseDiagnostic(path, response, body, bodyIsJson);
  evidence.diagnostics.responses.push(diagnostic);
  evidence.diagnostics.lastResponse = diagnostic;
  assertRecorded(`${stage}:cache-control`, diagnostic.cacheControl, "no-store");
  assertRecorded(`${stage}:json-content-type`, diagnostic.jsonContentType, true);
  assertRecorded(`${stage}:json-body`, diagnostic.bodyIsJson, true);
  return { response, body, diagnostic };
}

function uploadBody(filename = "metadata-live-fixture.pdf") {
  const form = new FormData();
  form.append("file", new Blob([fixture.bytes], { type: "application/pdf" }), filename);
  return form;
}

function normalize(value) {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function addComparison(field, expected, actual) {
  const matches = isDeepStrictEqual(actual, expected);
  evidence.diagnostics.fixtureFields.push({ field, expected, actual, matches });
  return matches;
}

function fixtureMismatches(metadata, extraction, expectedSha256) {
  const summary = metadataSummary(metadata) ?? {};
  const mismatches = [];
  for (const field of ["title", "authors", "year", "abstract"]) {
    if (!addComparison(field, fixture.expected[field], summary[field])) mismatches.push(field);
  }
  if (!addComparison("sourceSha256", expectedSha256, typeof metadata?.sourceSha256 === "string" ? metadata.sourceSha256 : "invalid")) mismatches.push("sourceSha256");
  if (!addComparison("selectedPageNumbers", [1, 2], summary.selectedPageNumbers)) mismatches.push("selectedPageNumbers");
  if (!addComparison("sourceExcerptClipped", false, summary.sourceExcerptClipped)) mismatches.push("sourceExcerptClipped");
  if (!addComparison("promptVersion", "document-metadata-v1", summary.promptVersion)) mismatches.push("promptVersion");
  if (!addComparison("modelPresent", true, summary.modelPresent)) mismatches.push("model");

  const pages = new Map(Array.isArray(extraction?.pages) ? extraction.pages.map((page) => [page.pageNumber, normalize(page.text)]) : []);
  for (const field of ["title", "authors", "year", "abstract"]) {
    const quotes = metadata && typeof metadata === "object" && metadata.evidence && typeof metadata.evidence === "object"
      ? metadata.evidence[field]
      : undefined;
    const validQuotes = Array.isArray(quotes) && quotes.length > 0 && quotes.every((quote) => typeof quote === "object" && quote !== null
      && Number.isInteger(quote.pageNumber) && typeof quote.quote === "string"
      && pages.get(quote.pageNumber)?.includes(normalize(quote.quote)));
    if (!addComparison(`${field}Evidence`, true, validQuotes)) mismatches.push(`${field}Evidence`);
  }
  evidence.diagnostics.fieldMismatch = mismatches[0] ?? null;
  return mismatches;
}

async function removeOwnedState() {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(state, { recursive: true, force: true });
      evidence.diagnostics.runtimeState = "removed";
      return;
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  evidence.diagnostics.runtimeState = "retained";
  throw lastError;
}

async function main() {
  if (!offlineScenario && !await configuredKeyIsAvailable()) {
    setStage("live-provider-check-skipped", { reason: "OPENAI_API_KEY is unavailable locally" });
    evidence.result = "skipped";
    return;
  }
  await mkdir(state, { recursive: true });
  if (offlineScenario) await startOfflineProvider();
  await migrate();
  await startWorker({ localMetadataProviderUrl: offlineProviderOrigin });

  const uploaded = await jsonRequest("upload", "/api/documents", { method: "POST", body: uploadBody() });
  assertRecorded("upload-status", uploaded.response.status, 201);
  const documentId = uploaded.body?.document?.id;
  assertRecorded("upload-document-id-present", typeof documentId === "string", true);

  const extracted = await jsonRequest("extract", `/api/documents/${documentId}/extract`, { method: "POST" });
  assertRecorded("extract-status", extracted.response.status, 201);

  setStage("metadata-post-attempt", { providerMode: offlineScenario ? "loopback-mock" : "configured-live-provider" });
  if (!offlineScenario) evidence.liveProviderRequests = 1;
  const generated = await jsonRequest("metadata-post", `/api/documents/${documentId}/metadata`, { method: "POST" });
  const initialGet = await jsonRequest("metadata-get-after-post", `/api/documents/${documentId}/metadata`);
  evidence.diagnostics.persistence = {
    postStatus: generated.response.status,
    postErrorKind: generated.diagnostic.errorKind,
    getStatus: initialGet.response.status,
    getErrorKind: initialGet.diagnostic.errorKind,
    getMatchesPostMetadata: Boolean(generated.body?.metadata) && isDeepStrictEqual(initialGet.body?.metadata, generated.body.metadata),
  };

  if (offlineScenario === "application-error") {
    assertRecorded("application-error-post-status", generated.response.status, 502);
    assertRecorded("application-error-kind", generated.diagnostic.errorKind, "metadata_provider_failure");
    assertRecorded("application-error-get-status", initialGet.response.status, 404);
    assertRecorded("application-error-get-kind", initialGet.diagnostic.errorKind, "metadata_not_found");
    assertRecorded("application-error-provider-requests", offlineProviderRequests, 1);
    evidence.result = "passed";
    setStage("offline-application-error-verified", { postStatus: generated.response.status, getStatus: initialGet.response.status });
    return;
  }

  if (generated.response.status !== 201) assertRecorded("metadata-post-status-after-persistence-read", generated.response.status, 201);
  assertRecorded("metadata-get-status-after-post", initialGet.response.status, 200);
  assertRecorded("metadata-get-matches-post", evidence.diagnostics.persistence.getMatchesPostMetadata, true);

  setStage("fixture-field-comparison");
  const mismatches = fixtureMismatches(generated.body?.metadata, extracted.body?.extraction, uploaded.body?.document?.sha256);
  if (mismatches.length > 0) assertRecorded(`fixture-field-match:${mismatches[0]}`, mismatches[0], null);

  await stop(worker);
  await startWorker({ disableApiKey: true });
  const cachedGet = await jsonRequest("cache-get-with-key-disabled", `/api/documents/${documentId}/metadata`);
  evidence.diagnostics.cache = {
    keyDisabledByCli: true,
    getStatus: cachedGet.response.status,
    getErrorKind: cachedGet.diagnostic.errorKind,
    cachedPostStatus: null,
    cachedPostErrorKind: null,
    cachedPostCreated: null,
    cachedPostMatchesInitial: null,
  };
  // Do not make a cached POST unless the restart first proved the result exists.
  assertRecorded("cache-get-status-before-post", cachedGet.response.status, 200);
  assertRecorded("cache-get-matches-initial", isDeepStrictEqual(cachedGet.body?.metadata, generated.body?.metadata), true);
  const cachedPost = await jsonRequest("cache-post-with-key-disabled", `/api/documents/${documentId}/metadata`, { method: "POST" });
  evidence.diagnostics.cache.cachedPostStatus = cachedPost.response.status;
  evidence.diagnostics.cache.cachedPostErrorKind = cachedPost.diagnostic.errorKind;
  evidence.diagnostics.cache.cachedPostCreated = cachedPost.body?.created;
  evidence.diagnostics.cache.cachedPostMatchesInitial = isDeepStrictEqual(cachedPost.body?.metadata, generated.body?.metadata);
  assertRecorded("cache-post-status", cachedPost.response.status, 200);
  assertRecorded("cache-post-created", cachedPost.body?.created, false);
  assertRecorded("cache-post-matches-initial", evidence.diagnostics.cache.cachedPostMatchesInitial, true);
  if (offlineScenario) assertRecorded("offline-provider-request-count", offlineProviderRequests, 1);

  setStage("metadata-verification-passed", {
    modelPresent: metadataSummary(generated.body?.metadata)?.modelPresent === true,
    cachedPostStatus: cachedPost.response.status,
    keyDisabledByCli: true,
  });
  evidence.result = "passed";
}

async function persistEvidence() {
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(resolve(evidenceDirectory, "result.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

try {
  await main();
} catch (error) {
  evidence.result = "failed";
  evidence.failure = { name: error instanceof Error ? error.name : "UnknownError", stage: evidence.stage };
  console.error("Metadata verifier stopped without retrying a provider request.");
  process.exitCode = 1;
} finally {
  setStage("cleanup-started", { priorResult: evidence.result ?? "unknown" });
  try {
    await persistEvidence();
    await stop(worker);
    for (const child of [...children]) await stop(child);
    await stopOfflineProvider();
    evidence.completedAt = new Date().toISOString();
    await persistEvidence();
    await removeOwnedState();
    await persistEvidence();
    console.log(`Metadata live-check evidence: ${resolve(evidenceDirectory, "result.json")}`);
  } catch {
    evidence.result = "failed";
    evidence.failure = { name: "CleanupError", stage: evidence.stage };
    process.exitCode = 1;
    try { await persistEvidence(); } catch { /* The main failure remains sanitized. */ }
    console.error("Metadata verifier cleanup failed.");
  }
}
