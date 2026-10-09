import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import workerArtifact from "../dist/worker/index.js";
import {
  createCorruptPdfFixture,
  createEncryptedPdfFixture,
  createImageOnlyPdfFixture,
  createPageLimitPdfFixture,
  createSignatureOnlyPdfFixture,
  createTextLimitPdfFixture,
  createTextPdfFixture,
} from "./fixtures/pdf-fixtures.mjs";

const root = resolve(import.meta.dirname, "..");
const wrangler = resolve(root, "node_modules/wrangler/bin/wrangler.js");
const id = randomUUID();
const evidenceDirectory = resolve(root, ".wrangler/extraction-check", id);
const state = resolve(evidenceDirectory, "state");
const children = new Set();
const evidence = {
  id,
  state,
  startedAt: new Date().toISOString(),
  fixture: {
    source: "scripts/fixtures/pdf-fixtures.mjs",
    license: "CC0-1.0",
    description: "Repository-authored valid PDF 1.4 two-page text fixture; page two contains Caf\u00e9.",
  },
  steps: [],
  workerLogs: [],
};
let worker;
let origin;

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
  evidence.workerLogs.push({ label: child.label, pid: child.pid, tail: child.log.slice(-4_000) });
  children.delete(child);
  record("stopped-owned-process", { label: child.label, pid: child.pid });
}

async function availablePort() {
  const server = createServer();
  await new Promise((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", done); });
  const port = server.address().port;
  await new Promise((done, fail) => server.close((error) => error ? fail(error) : done()));
  return port;
}

async function migrate() {
  const child = launch(["d1", "migrations", "apply", "DB", "--config", "wrangler.jsonc", "--local", "--persist-to", state], "migration");
  await Promise.race([child.done, delay(45_000, undefined, { ref: false }).then(() => { throw new Error("Local migration timed out."); })]);
  assert.equal(child.exitCode, 0, `Isolated local migration failed: ${child.log}`);
  await stop(child);
  record("migrations-applied", { exitCode: child.exitCode });
}

async function startWorker() {
  const port = await availablePort();
  origin = `http://127.0.0.1:${port}`;
  worker = launch(["dev", "--config", "wrangler.jsonc", "--local", "--persist-to", state,
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

async function upload(bytes, filename) {
  const result = await jsonRequest("/api/documents", { method: "POST", body: uploadBody(bytes, filename) }, 201);
  assert.equal(result.body.document.sha256, sha256(bytes));
  return result.body.document;
}

async function download(document, bytes) {
  const response = await fetch(`${origin}/api/documents/${document.id}/pdf`, { signal: AbortSignal.timeout(30_000) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
}

function artifactRequest(path, init) {
  return new Request(`https://extraction-check.invalid${path}`, init);
}

function storedRow(id, sha) {
  return {
    id,
    filename: "fixture.pdf",
    byte_count: 100,
    sha256: sha,
    object_key: `uploaded_documents/${id}.pdf`,
    uploaded_at: "2026-10-08T00:00:00.000Z",
    status: "stored",
  };
}

function mockDbForDocument(document, extraction = null, batch) {
  return {
    prepare(sql) {
      return {
        bind() {
          return {
            async first() { return sql.includes("uploaded_documents") ? document : extraction; },
          };
        },
      };
    },
    batch,
  };
}

async function artifactFailureChecks() {
  const fixture = createTextPdfFixture();
  const documentId = "11111111-1111-4111-8111-111111111111";
  const missingObject = await workerArtifact.fetch(artifactRequest(`/api/documents/${documentId}/extract`, { method: "POST" }), {
    DB: mockDbForDocument(storedRow(documentId, sha256(fixture.bytes)), null, async () => { throw new Error("should not write"); }),
    PAPER_BUCKET: { async get() { return null; } },
  });
  assert.equal(missingObject.status, 404);
  assert.equal((await missingObject.json()).error.kind, "object_missing");

  const mismatch = await workerArtifact.fetch(artifactRequest(`/api/documents/${documentId}/extract`, { method: "POST" }), {
    DB: mockDbForDocument(storedRow(documentId, "a".repeat(64)), null, async () => { throw new Error("should not write"); }),
    PAPER_BUCKET: { async get() { return { async arrayBuffer() { return fixture.bytes.buffer.slice(fixture.bytes.byteOffset, fixture.bytes.byteOffset + fixture.bytes.byteLength); } }; } },
  });
  assert.equal(mismatch.status, 409);
  assert.equal((await mismatch.json()).error.kind, "source_hash_mismatch");

  const databaseFailure = await workerArtifact.fetch(artifactRequest(`/api/documents/${documentId}/extract`, { method: "POST" }), {
    DB: mockDbForDocument(storedRow(documentId, sha256(fixture.bytes)), null, async () => { throw new Error("private D1 failure"); }),
    PAPER_BUCKET: { async get() { return { async arrayBuffer() { return fixture.bytes.buffer.slice(fixture.bytes.byteOffset, fixture.bytes.byteOffset + fixture.bytes.byteLength); } }; } },
  });
  assert.equal(databaseFailure.status, 503);
  assert.equal((await databaseFailure.json()).error.kind, "database_failure");
  record("built-worker-offline-storage-and-database-failures-passed", { missingObject: 404, hashMismatch: 409, databaseFailure: 503 });
}

async function assertFailure(bytes, filename, expectedStatus, expectedKind) {
  const document = await upload(bytes, filename);
  const extraction = await jsonRequest(`/api/documents/${document.id}/extract`, { method: "POST" }, expectedStatus);
  assert.equal(extraction.body.error.kind, expectedKind);
  const text = await jsonRequest(`/api/documents/${document.id}/text`, undefined, 404);
  assert.equal(text.body.error.kind, "extraction_not_found");
  await download(document, bytes);
  return document;
}

async function main() {
  await mkdir(state, { recursive: true });
  await artifactFailureChecks();
  await migrate();
  await startWorker();

  const fixture = createTextPdfFixture();
  const primary = await upload(fixture.bytes, "two-page-text.pdf");
  const before = await jsonRequest(`/api/documents/${primary.id}/text`, undefined, 404);
  assert.equal(before.body.error.kind, "extraction_not_found");
  const missing = await jsonRequest("/api/documents/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/text", undefined, 404);
  assert.equal(missing.body.error.kind, "document_not_found");
  const bodyRejected = await jsonRequest(`/api/documents/${primary.id}/extract`, { method: "POST", body: "client text is never accepted" }, 400);
  assert.equal(bodyRejected.body.error.kind, "invalid_request");

  const first = await jsonRequest(`/api/documents/${primary.id}/extract`, { method: "POST" }, 201);
  assert.equal(first.body.created, true);
  assert.deepEqual(first.body.extraction, {
    documentId: primary.id,
    sourceSha256: primary.sha256,
    parser: "unpdf",
    parserVersion: first.body.extraction.parserVersion,
    extractedAt: first.body.extraction.extractedAt,
    pageCount: 2,
    pages: [
      { pageNumber: 1, text: fixture.expected.first },
      { pageNumber: 2, text: fixture.expected.second },
    ],
  });
  assert.match(first.body.extraction.parserVersion, /^unpdf@1\.8\.1\/pdfjs@/u);
  assert.equal(new Date(first.body.extraction.extractedAt).toISOString(), first.body.extraction.extractedAt);
  await download(primary, fixture.bytes);
  const get = await jsonRequest(`/api/documents/${primary.id}/text`, undefined, 200);
  assert.deepEqual(get.body.extraction, first.body.extraction);
  const repeat = await jsonRequest(`/api/documents/${primary.id}/extract`, { method: "POST" }, 200);
  assert.equal(repeat.body.created, false);
  assert.deepEqual(repeat.body.extraction, first.body.extraction);
  record("actual-worker-ordered-text-hash-get-repeat-and-original-bytes-passed", { documentId: primary.id, pageCount: 2 });

  const concurrentDocument = await upload(fixture.bytes, "concurrent-text.pdf");
  const concurrent = await Promise.all([
    jsonRequest(`/api/documents/${concurrentDocument.id}/extract`, { method: "POST" }),
    jsonRequest(`/api/documents/${concurrentDocument.id}/extract`, { method: "POST" }),
  ]);
  assert.deepEqual(concurrent.map((item) => item.response.status).sort(), [200, 201]);
  assert.equal(concurrent.filter((item) => item.body.created).length, 1);
  assert.deepEqual(concurrent[0].body.extraction, concurrent[1].body.extraction);
  await download(concurrentDocument, fixture.bytes);
  record("concurrent-extract-retains-one-authoritative-record", { documentId: concurrentDocument.id, statuses: concurrent.map((item) => item.response.status).sort() });

  const firstPid = worker.pid;
  await stop(worker);
  await startWorker();
  assert.notEqual(worker.pid, firstPid);
  const restartRead = await jsonRequest(`/api/documents/${primary.id}/text`, undefined, 200);
  assert.deepEqual(restartRead.body.extraction, first.body.extraction);
  await download(primary, fixture.bytes);
  record("restart-read-before-another-extract-passed", { documentId: primary.id });

  await stop(worker);
  await migrate();
  await startWorker();
  const migratedRead = await jsonRequest(`/api/documents/${primary.id}/text`, undefined, 200);
  assert.deepEqual(migratedRead.body.extraction, first.body.extraction);
  await download(primary, fixture.bytes);
  record("migration-reapply-preserves-extraction-and-original-bytes", { documentId: primary.id });

  await assertFailure(createCorruptPdfFixture(), "corrupt.pdf", 422, "parser_error");
  await assertFailure(createSignatureOnlyPdfFixture(), "signature-only.pdf", 422, "parser_error");
  await assertFailure(createEncryptedPdfFixture(), "encrypted.pdf", 422, "password_protected");
  await assertFailure(createImageOnlyPdfFixture(), "image-only.pdf", 422, "no_usable_text");
  await assertFailure(createPageLimitPdfFixture(), "too-many-pages.pdf", 413, "extraction_limit_exceeded");
  await assertFailure(createTextLimitPdfFixture(), "too-much-text.pdf", 413, "extraction_limit_exceeded");
  record("corrupt-signature-encrypted-image-only-and-page-text-limit-cases-preserve-originals", { cases: 6 });
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
  if (process.exitCode) evidence.result = "failed";
  if (evidence.result === "passed") {
    try {
      const actual = await realpath(state);
      const owner = await realpath(evidenceDirectory);
      assert.equal(dirname(actual), owner);
      assert.equal(actual, resolve(owner, "state"));
      assert.ok(owner.startsWith(resolve(root, ".wrangler/extraction-check") + sep));
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
  console.log(`Extraction check ${evidence.result}. Evidence: ${resolve(evidenceDirectory, "result.json")}`);
}
