import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { dirname, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createSummaryClippedPdfFixture, createSummaryPdfFixture } from "./fixtures/pdf-fixtures.mjs";

const root = resolve(import.meta.dirname, "..");
const wrangler = resolve(root, "node_modules/wrangler/bin/wrangler.js");
const id = randomUUID();
const evidenceDirectory = resolve(root, ".wrangler/question-check", id);
const state = resolve(evidenceDirectory, "state");
const stateArgument = relative(root, state).split(sep).join("/") || ".";
const children = new Set();
const fixture = createSummaryPdfFixture();
const clippedFixture = createSummaryClippedPdfFixture();
const expected = fixture.expected;
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
let questionMode = "answered";
let questionProviderCalls = 0;
let metadataProviderCalls = 0;
let summaryProviderCalls = 0;
let questionProviderStarted;

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

function jsonQuestion(question) {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question }) };
}

function responsePayload(output) {
  return { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }] };
}

function metadataOutput() {
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

function summaryOutput() {
  return {
    // Summary evidence is now a server-issued page/reference pair; the Worker
    // resolves the exact public quote after strict validation.
    overview: { text: "The fixture retains ordered source text with page-level support.", evidence: [{ pageNumber: 1, referenceId: 5 }] },
    contributions: [{ text: "It selects stored source text before generating output.", evidence: [{ pageNumber: 2, referenceId: 1 }] }],
    methods: [{ text: "It retains ordered pages for grounded output.", evidence: [{ pageNumber: 3, referenceId: 1 }] }],
    findings: [{ text: "Later findings remain visible in selected source text.", evidence: [{ pageNumber: 4, referenceId: 1 }] }],
    limitations: [{ text: "Quotes do not prove every paraphrased implication.", evidence: [{ pageNumber: 4, referenceId: 2 }] }],
    warnings: [],
  };
}

function answeredOutput() {
  return {
    outcome: "answered",
    answerParts: [{
      text: "The included later page states that later pages remain visible.",
      evidence: [{ pageNumber: 4, quote: expected.findingQuote }],
    }],
    insufficientSourceReason: null,
    warnings: [],
  };
}

function insufficientOutput(partial = false) {
  return {
    outcome: "insufficient_source",
    answerParts: [],
    insufficientSourceReason: partial
      ? "The included excerpt does not establish information beyond the bounded source pages."
      : "The included source does not establish the requested detail.",
    warnings: [],
  };
}

function questionOutputForMode() {
  if (questionMode === "insufficient") return insufficientOutput(false);
  if (questionMode === "partial") return insufficientOutput(true);
  const output = answeredOutput();
  if (questionMode === "wrong_page") output.answerParts[0].evidence = [{ pageNumber: 3, quote: expected.findingQuote }];
  else if (questionMode === "invented_evidence") output.answerParts[0].evidence = [{ pageNumber: 4, quote: "Invented question evidence." }];
  else if (questionMode === "oversized_evidence") output.answerParts[0].evidence = [{ pageNumber: 4, quote: "x".repeat(601) }];
  else if (questionMode === "too_many_words") output.answerParts[0].text = Array.from({ length: 301 }, () => "word").join(" ");
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
      if (request.method !== "POST" || request.url !== "/v1/responses" || !["Bearer local-question-test-key", "Bearer local-summary-test-key", "Bearer local-metadata-test-key"].includes(request.headers.authorization)) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "unexpected mock request" } }));
        return;
      }
      const body = await readRequestBody(request);
      const format = body.text?.format;
      const input = body.input?.[1]?.content;
      const kind = format?.name === "document_question" ? "question" : format?.name === "document_summary" ? "summary" : "metadata";
      const pageMarkers = typeof input === "string" ? [...input.matchAll(/\[Page (\d+)\]/gu)].map((match) => Number(match[1])) : [];
      evidence.providerRequests.push({
        kind,
        mode: kind === "question" ? questionMode : "valid",
        model: body.model,
        store: body.store,
        maxOutputTokens: body.max_output_tokens,
        hasTools: Object.hasOwn(body, "tools"),
        strictSchema: format?.type === "json_schema" && format?.strict === true && format?.schema?.additionalProperties === false,
        pageMarkers,
      });
      if (kind === "metadata") {
        metadataProviderCalls += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(responsePayload(metadataOutput())));
        return;
      }
      if (kind === "summary") {
        summaryProviderCalls += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(responsePayload(summaryOutput())));
        return;
      }
      questionProviderCalls += 1;
      questionProviderStarted?.();
      questionProviderStarted = undefined;
      if (questionMode === "slow") await delay(350);
      if (questionMode === "timeout") {
        await delay(26_000);
        if (!response.destroyed) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(responsePayload(answeredOutput())));
        }
        return;
      }
      if (questionMode === "empty_http_body") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end();
        return;
      }
      if (questionMode === "non_json_http_body") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("not JSON");
        return;
      }
      if (questionMode === "invalid_rest_envelope") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "completed", output: "not an output array" }));
        return;
      }
      if (questionMode === "missing_output_text") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "completed", output: [{ type: "message", content: [] }] }));
        return;
      }
      if (questionMode === "malformed") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "{" }] }] }));
        return;
      }
      if (questionMode === "refusal") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "completed", output: [{ content: [{ type: "refusal", refusal: "mock refusal" }] }] }));
        return;
      }
      if (questionMode === "schema_invalid") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(responsePayload({ outcome: "answered" })));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(responsePayload(questionOutputForMode())));
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

async function startWorker(apiKey = "offline-question-test-key") {
  const port = await availablePort();
  origin = `http://127.0.0.1:${port}`;
  worker = launch(["dev", "--config", "wrangler.jsonc", "--local", "--persist-to", stateArgument,
    "--var", `OPENAI_API_KEY:${apiKey}`, "--var", `LOCAL_QUESTION_PROVIDER_URL:${providerOrigin}`,
    "--var", `LOCAL_SUMMARY_PROVIDER_URL:${providerOrigin}`, "--var", `LOCAL_METADATA_PROVIDER_URL:${providerOrigin}`,
    "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", "0", "--show-interactive-dev-session=false"], "Worker");
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (worker.launchError || worker.exitCode !== null || worker.signalCode !== null) throw new Error(`Owned Worker exited before readiness: ${worker.log}`);
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        assert.deepEqual(await response.json(), { status: "ok" });
        record("worker-started", { pid: worker.pid, origin, apiKeyConfigured: Boolean(apiKey) });
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

async function uploadAndExtract(bytes = fixture.bytes, filename = "question-fixture.pdf") {
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

async function expectQuestionFailure(mode, kind, status, diagnostic) {
  const prepared = await uploadAndExtract(fixture.bytes, `${mode}.pdf`);
  questionMode = mode;
  const beforeCalls = questionProviderCalls;
  const failed = await jsonRequest(`/api/documents/${prepared.document.id}/questions`, jsonQuestion(`Failure ${mode}?`), status);
  assert.equal(failed.body.error.kind, kind);
  assert.equal(questionProviderCalls, beforeCalls + 1);
  assert.deepEqual((await jsonRequest(`/api/documents/${prepared.document.id}/questions`, undefined, 200)).body.questions, []);
  if (diagnostic) {
    const expected = JSON.stringify(diagnostic);
    assert.ok(worker.log.includes(expected), `Missing sanitized diagnostic ${expected} for ${mode}.`);
    record("question-diagnostic-stage-verified", { mode, ...diagnostic });
  }
  questionMode = "answered";
}

async function main() {
  await mkdir(state, { recursive: true });
  await startProvider();
  await migrate();
  await startWorker();

  const missingText = await jsonRequest("/api/documents", { method: "POST", body: uploadBody(fixture.bytes, "question-not-extracted.pdf") }, 201);
  const noText = await jsonRequest(`/api/documents/${missingText.body.document.id}/questions`, jsonQuestion("What does the source say?"), 404);
  assert.equal(noText.body.error.kind, "extraction_not_found");

  const primary = await uploadAndExtract();
  assert.deepEqual((await jsonRequest(`/api/documents/${primary.document.id}/questions`, undefined, 200)).body.questions, []);
  const unsupported = await jsonRequest(`/api/documents/${primary.document.id}/questions`, { method: "POST", headers: { "content-type": "text/plain" }, body: "not json" }, 415);
  assert.equal(unsupported.body.error.kind, "unsupported_media_type");
  const malformed = await jsonRequest(`/api/documents/${primary.document.id}/questions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, 400);
  assert.equal(malformed.body.error.kind, "invalid_request");
  const untrimmed = await jsonRequest(`/api/documents/${primary.document.id}/questions`, jsonQuestion(" Leading whitespace is rejected"), 400);
  assert.equal(untrimmed.body.error.kind, "invalid_request");
  const oversizedQuestion = await jsonRequest(`/api/documents/${primary.document.id}/questions`, jsonQuestion("q".repeat(2_049)), 413);
  assert.equal(oversizedQuestion.body.error.kind, "body_too_large");
  const oversizedBody = await jsonRequest(`/api/documents/${primary.document.id}/questions`, jsonQuestion("q".repeat(4_000)), 413);
  assert.equal(oversizedBody.body.error.kind, "body_too_large");

  const metadata = await jsonRequest(`/api/documents/${primary.document.id}/metadata`, { method: "POST" }, 201);
  const summary = await jsonRequest(`/api/documents/${primary.document.id}/summary`, { method: "POST" }, 201);
  const textBeforeQuestions = await jsonRequest(`/api/documents/${primary.document.id}/text`, undefined, 200);
  await download(primary.document, fixture.bytes);

  const originalQuestion = "What   later findings are stated in 2024?";
  questionMode = "answered";
  const first = await jsonRequest(`/api/documents/${primary.document.id}/questions`, jsonQuestion(originalQuestion), 201);
  assert.equal(first.body.created, true);
  assert.equal(first.body.question.outcome, "answered");
  assert.equal(first.body.question.question, originalQuestion);
  assert.equal(first.body.question.normalizedQuestion, "What later findings are stated in 2024?");
  assert.equal(first.body.question.answerParts[0].evidence[0].pageNumber, 4);
  assert.equal(first.body.question.answerParts[0].evidence[0].quote, expected.findingQuote);
  assert.deepEqual(first.body.question.includedPageNumbers, [1, 2, 3, 4]);
  assert.equal(first.body.question.sourceExcerptTruncated, false);
  assert.match(first.body.question.promptVersion, /document-question-v1/u);
  assert.match(first.body.question.schemaVersion, /document-question-schema-v1/u);
  const callsAfterFirst = questionProviderCalls;
  const cached = await jsonRequest(`/api/documents/${primary.document.id}/questions`, jsonQuestion("What later findings are stated in 2024?"), 200);
  assert.equal(cached.body.created, false);
  assert.equal(cached.body.question.id, first.body.question.id);
  assert.equal(cached.body.question.createdAt, first.body.question.createdAt);
  assert.equal(cached.body.question.question, originalQuestion);
  assert.equal(questionProviderCalls, callsAfterFirst, "normalized cached POST must not call the provider");
  const punctuationVariant = await jsonRequest(`/api/documents/${primary.document.id}/questions`, jsonQuestion("What later findings are stated in 2024!"), 201);
  assert.notEqual(punctuationVariant.body.question.id, first.body.question.id, "punctuation remains part of the cache identity");
  const caseVariant = await jsonRequest(`/api/documents/${primary.document.id}/questions`, jsonQuestion("what later findings are stated in 2024?"), 201);
  assert.notEqual(caseVariant.body.question.id, first.body.question.id, "case remains part of the cache identity");
  const ordered = await jsonRequest(`/api/documents/${primary.document.id}/questions`, undefined, 200);
  assert.deepEqual(ordered.body.questions.slice(0, 3).map((entry) => entry.id), [caseVariant.body.question.id, punctuationVariant.body.question.id, first.body.question.id]);
  record("answered-question-later-page-evidence-normalized-cache-and-stable-order-passed", { documentId: primary.document.id, questionProviderCalls });

  questionMode = "insufficient";
  const insufficient = await jsonRequest(`/api/documents/${primary.document.id}/questions`, jsonQuestion("What unrecorded experiment is described?"), 201);
  assert.equal(insufficient.body.question.outcome, "insufficient_source");
  assert.deepEqual(insufficient.body.question.answerParts, []);
  assert.match(insufficient.body.question.insufficientSourceReason, /included source/u);
  questionMode = "answered";

  const partial = await uploadAndExtract(clippedFixture.bytes, "question-source-budget.pdf");
  questionMode = "partial";
  const partialQuestion = await jsonRequest(`/api/documents/${partial.document.id}/questions`, jsonQuestion("What appears after the source budget?"), 201);
  assert.equal(partialQuestion.body.question.outcome, "insufficient_source");
  assert.equal(partialQuestion.body.question.sourceExcerptTruncated, true);
  assert.match(partialQuestion.body.question.sourceCoverageWarning, /Partial source coverage/u);
  assert.match(partialQuestion.body.question.insufficientSourceReason, /^The included excerpt/u);
  assert.ok(partialQuestion.body.question.warnings.includes(partialQuestion.body.question.sourceCoverageWarning));
  questionMode = "answered";
  record("insufficient-source-and-partial-coverage-results-persisted", { documentId: partial.document.id, byteBudget: 96 * 1024 });

  await expectQuestionFailure("empty_http_body", "question_invalid_response", 502, { event: "document_question_provider_rejected", stage: "http_body_empty" });
  await expectQuestionFailure("non_json_http_body", "question_invalid_response", 502, { event: "document_question_provider_rejected", stage: "http_body_non_json" });
  await expectQuestionFailure("invalid_rest_envelope", "question_invalid_response", 502, { event: "document_question_provider_rejected", stage: "rest_envelope_invalid" });
  await expectQuestionFailure("missing_output_text", "question_invalid_response", 502, { event: "document_question_provider_rejected", stage: "output_text_missing" });
  await expectQuestionFailure("malformed", "question_invalid_response", 502, { event: "document_question_provider_rejected", stage: "structured_json_malformed" });
  await expectQuestionFailure("schema_invalid", "question_invalid_response", 502, { event: "document_question_output_rejected", stage: "schema_validation_failed" });
  await expectQuestionFailure("wrong_page", "question_invalid_response", 502, { event: "document_question_output_rejected", stage: "evidence_validation_failed" });
  await expectQuestionFailure("invented_evidence", "question_invalid_response", 502, { event: "document_question_output_rejected", stage: "evidence_validation_failed" });
  await expectQuestionFailure("oversized_evidence", "question_invalid_response", 502, { event: "document_question_output_rejected", stage: "evidence_validation_failed" });
  await expectQuestionFailure("too_many_words", "question_invalid_response", 502, { event: "document_question_output_rejected", stage: "schema_validation_failed" });
  await expectQuestionFailure("refusal", "question_refusal", 422);
  await expectQuestionFailure("timeout", "question_timeout", 504);
  record("question-response-decoding-schema-evidence-refusal-timeout-boundaries-leave-no-record", { rejectedEvidenceBytes: 601, proseWordLimit: 300, diagnosticStages: ["http_body_empty", "http_body_non_json", "rest_envelope_invalid", "output_text_missing", "structured_json_malformed", "schema_validation_failed", "evidence_validation_failed"] });

  const concurrent = await uploadAndExtract();
  questionMode = "slow";
  const callsBeforeConcurrent = questionProviderCalls;
  const started = new Promise((done) => { questionProviderStarted = done; });
  const firstConcurrent = jsonRequest(`/api/documents/${concurrent.document.id}/questions`, jsonQuestion("What later finding is stated?"));
  await started;
  const secondConcurrent = await jsonRequest(`/api/documents/${concurrent.document.id}/questions`, jsonQuestion("What later finding is stated?"), 409);
  assert.equal(secondConcurrent.body.error.kind, "question_in_progress");
  assert.equal((await firstConcurrent).response.status, 201);
  assert.equal(questionProviderCalls, callsBeforeConcurrent + 1, "only one concurrent provider call is allowed");
  questionMode = "answered";
  record("concurrent-identical-question-used-one-provider-call", { documentId: concurrent.document.id });

  assert.deepEqual((await jsonRequest(`/api/documents/${primary.document.id}/metadata`, undefined, 200)).body.metadata, metadata.body.metadata);
  assert.deepEqual((await jsonRequest(`/api/documents/${primary.document.id}/summary`, undefined, 200)).body.summary, summary.body.summary);
  assert.deepEqual((await jsonRequest(`/api/documents/${primary.document.id}/text`, undefined, 200)).body.extraction, textBeforeQuestions.body.extraction);
  await download(primary.document, fixture.bytes);
  record("questions-preserve-existing-pdf-extraction-metadata-and-summary", { documentId: primary.document.id });

  const firstPid = worker.pid;
  await stop(worker);
  await startWorker("");
  assert.notEqual(worker.pid, firstPid);
  assert.deepEqual((await jsonRequest(`/api/documents/${primary.document.id}/questions`, undefined, 200)).body.questions.find((entry) => entry.id === first.body.question.id), first.body.question);
  const cacheWithoutKey = await jsonRequest(`/api/documents/${primary.document.id}/questions`, jsonQuestion("What later findings are stated in 2024?"), 200);
  assert.equal(cacheWithoutKey.body.created, false);
  assert.equal(cacheWithoutKey.body.question.id, first.body.question.id);
  const missingConfig = await jsonRequest(`/api/documents/${primary.document.id}/questions`, jsonQuestion("A new uncached question?"), 424);
  assert.equal(missingConfig.body.error.kind, "question_missing_configuration");
  record("cached-question-get-and-post-work-with-empty-api-key", { documentId: primary.document.id });

  await stop(worker);
  await migrate();
  await startWorker();
  assert.deepEqual((await jsonRequest(`/api/documents/${primary.document.id}/questions`, undefined, 200)).body.questions.find((entry) => entry.id === first.body.question.id), first.body.question);
  assert.deepEqual((await jsonRequest(`/api/documents/${primary.document.id}/metadata`, undefined, 200)).body.metadata, metadata.body.metadata);
  assert.deepEqual((await jsonRequest(`/api/documents/${primary.document.id}/summary`, undefined, 200)).body.summary, summary.body.summary);
  assert.deepEqual((await jsonRequest(`/api/documents/${primary.document.id}/text`, undefined, 200)).body.extraction, textBeforeQuestions.body.extraction);
  await download(primary.document, fixture.bytes);
  for (const request of evidence.providerRequests.filter((request) => request.kind === "question")) {
    assert.equal(request.store, false);
    assert.equal(request.maxOutputTokens, 2048);
    assert.equal(request.hasTools, false);
    assert.equal(request.strictSchema, true);
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
      assert.ok(owner.startsWith(resolve(root, ".wrangler/question-check") + sep));
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
  console.log(`Question check ${evidence.result}. Evidence: ${resolve(evidenceDirectory, "result.json")}`);
}
