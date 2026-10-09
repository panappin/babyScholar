import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import workerArtifact from "../dist/worker/index.js";

const root = resolve(import.meta.dirname, "..");
const wrangler = resolve(root, "node_modules/wrangler/bin/wrangler.js");
const id = randomUUID();
const evidenceDirectory = resolve(root, ".wrangler/document-check", id);
const state = resolve(evidenceDirectory, "state");
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const MAX_BODY_BYTES = MAX_FILE_BYTES + MULTIPART_OVERHEAD_BYTES;
const children = new Set();
const evidence = {
  id,
  state,
  startedAt: new Date().toISOString(),
  fixture: {
    source: "Repository-authored minimal one-page PDF test vector in scripts/document-check.mjs",
    license: "CC0-1.0",
  },
  steps: [],
};
let worker;
let origin;

const record = (step, details = {}) => {
  evidence.steps.push({ step, ...details });
  console.log(JSON.stringify({ step, ...details }));
};

// The PDF fixture is original test data, released as CC0-1.0. It has a real
// catalog, page tree, empty page content stream, xref table, and trailer; this
// phase only validates the header and deliberately does not parse PDF content.
function fixturePdf(title) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Resources << >> /Contents 4 0 R >>",
    "<< /Length 0 >>\nstream\n\nendstream",
    `<< /Title (${title}) >>`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}

const firstPdf = fixturePdf("Phase 3A fixture one");
const secondPdf = fixturePdf("Phase 3A fixture two");
assert.notDeepEqual(firstPdf, secondPdf);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function uploadBody(bytes, filename = "fixture.pdf", type = "application/pdf") {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type }), filename);
  return form;
}

function missingFileBody() {
  const form = new FormData();
  form.append("other", "value");
  return form;
}

function multipleFileBody() {
  const form = new FormData();
  form.append("file", new Blob([firstPdf], { type: "application/pdf" }), "first.pdf");
  form.append("file", new Blob([secondPdf], { type: "application/pdf" }), "second.pdf");
  return form;
}

function launch(args) {
  const child = spawn(process.execPath, [wrangler, ...args], {
    cwd: root,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  child.done = new Promise((done) => {
    child.once("error", (error) => { child.launchError = error; done(); });
    child.once("close", done);
  });
  children.add(child);
  return child;
}

async function stop(child) {
  if (!child || !children.has(child)) return;
  if (child.exitCode === null && child.signalCode === null && !child.launchError) {
    if (process.platform === "win32") {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      const code = await new Promise((done, fail) => { killer.once("error", fail); killer.once("exit", done); });
      if (code !== 0 && child.exitCode === null && child.signalCode === null) {
        let running = true;
        try { process.kill(child.pid, 0); } catch (error) { if (error.code === "ESRCH") running = false; else throw error; }
        if (running) throw new Error(`Could not stop owned process ${child.pid} (taskkill ${code}).`);
      }
    } else process.kill(-child.pid, "SIGTERM");
    await Promise.race([child.done, delay(10_000, undefined, { ref: false }).then(() => { throw new Error("Owned process did not stop."); })]);
  }
  children.delete(child);
  record("stopped-owned-process", { pid: child.pid });
}

async function availablePort() {
  const server = createServer();
  await new Promise((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", done); });
  const port = server.address().port;
  await new Promise((done, fail) => server.close((error) => error ? fail(error) : done()));
  return port;
}

async function migrate() {
  const child = launch(["d1", "migrations", "apply", "DB", "--config", "wrangler.jsonc", "--local", "--persist-to", state]);
  child.stdin.end();
  await Promise.race([child.done, delay(45_000, undefined, { ref: false }).then(() => { throw new Error("Local migration timed out."); })]);
  assert.equal(child.exitCode, 0, "Isolated local migration failed.");
  children.delete(child);
  record("migrations-applied", { exitCode: child.exitCode });
}

async function startWorker() {
  const port = await availablePort();
  origin = `http://127.0.0.1:${port}`;
  worker = launch(["dev", "--config", "wrangler.jsonc", "--local", "--persist-to", state,
    "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", "0", "--show-interactive-dev-session=false"]);
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (worker.launchError || worker.exitCode !== null || worker.signalCode !== null) throw new Error("Owned Worker exited before readiness.");
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
  const response = await fetch(`${origin}${path}`, { ...init, signal: AbortSignal.timeout(30_000) });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-type") ?? "", /application\/json/u);
  const body = await response.json();
  if (expectedStatus !== undefined) assert.equal(response.status, expectedStatus, JSON.stringify(body));
  return { response, body };
}

const list = async () => (await jsonRequest("/api/documents", undefined, 200)).body;

async function download(document, bytes) {
  const response = await fetch(`${origin}/api/documents/${document.id}/pdf`, { signal: AbortSignal.timeout(30_000) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.equal(response.headers.get("content-disposition"), `attachment; filename="document-${document.id}.pdf"`);
  assert.equal(response.headers.get("content-length"), String(bytes.byteLength));
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
}

function artifactRequest(path, init) {
  return new Request(`https://document-check.invalid${path}`, init);
}

async function artifactFailureChecks() {
  const valid = () => artifactRequest("/api/documents", { method: "POST", body: uploadBody(firstPdf, "artifact.pdf") });
  const missingStorage = await workerArtifact.fetch(valid(), {});
  assert.equal(missingStorage.status, 503);
  assert.deepEqual(await missingStorage.json(), { error: { kind: "storage_unavailable", message: "The document storage is unavailable." } });

  let databaseTouched = false;
  const bucketFailure = await workerArtifact.fetch(valid(), {
    DB: { prepare() { databaseTouched = true; throw new Error("database should not run when R2 write fails"); } },
    PAPER_BUCKET: { async put() { throw new Error("private R2 failure"); } },
  });
  assert.equal(bucketFailure.status, 503);
  assert.deepEqual(await bucketFailure.json(), { error: { kind: "storage_unavailable", message: "The document storage is unavailable." } });
  assert.equal(databaseTouched, false);

  const putKeys = [];
  const deletedKeys = [];
  const databaseFailure = await workerArtifact.fetch(valid(), {
    DB: { prepare() { throw new Error("private database failure"); } },
    PAPER_BUCKET: {
      async put(key) { putKeys.push(key); return { key }; },
      async delete(key) { deletedKeys.push(key); },
    },
  });
  assert.equal(databaseFailure.status, 503);
  assert.deepEqual(await databaseFailure.json(), { error: { kind: "database_failure", message: "The document database operation failed." } });
  assert.equal(putKeys.length, 1);
  assert.deepEqual(deletedKeys, putKeys, "a failed D1 insert must attempt to delete only that request's R2 key");

  let touchedStorage = false;
  const untouched = {
    DB: { prepare() { touchedStorage = true; throw new Error("invalid request must not query D1"); } },
    PAPER_BUCKET: { async put() { touchedStorage = true; throw new Error("invalid request must not write R2"); } },
  };
  const oversized = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(MAX_BODY_BYTES + 1)); controller.close(); },
  });
  const overflowRequest = artifactRequest("/api/documents", {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=check", "content-length": "1" },
    body: oversized,
    duplex: "half",
  });
  const overflow = await workerArtifact.fetch(overflowRequest, untouched);
  assert.equal(overflow.status, 413, "actual streamed bytes must override a dishonest Content-Length");
  assert.equal((await overflow.json()).error.kind, "body_too_large");
  assert.equal(oversized.locked, false, "the over-limit reader must release the inbound stream");
  assert.equal(touchedStorage, false);

  const hanging = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode("--check\r\n")); },
  });
  const timeout = await workerArtifact.fetch(artifactRequest("/api/documents", {
    method: "POST", headers: { "content-type": "multipart/form-data; boundary=check" }, body: hanging, duplex: "half",
  }), untouched);
  assert.equal(timeout.status, 408);
  assert.equal((await timeout.json()).error.kind, "request_timeout");
  assert.equal(hanging.locked, false, "the timed-out reader must release the inbound stream");
  assert.equal(touchedStorage, false);

  const stored = {
    id: "11111111-1111-4111-8111-111111111111",
    filename: "missing-object.pdf",
    byte_count: 10,
    sha256: "a".repeat(64),
    object_key: "uploaded_documents/11111111-1111-4111-8111-111111111111.pdf",
    uploaded_at: "2026-10-08T00:00:00.000Z",
    status: "stored",
  };
  const missingObject = await workerArtifact.fetch(artifactRequest(`/api/documents/${stored.id}/pdf`), {
    DB: { prepare() { return { bind() { return { async first() { return stored; } }; } }; } },
    PAPER_BUCKET: { async get() { return null; } },
  });
  assert.equal(missingObject.status, 404);
  assert.deepEqual(await missingObject.json(), { error: { kind: "object_missing", message: "The uploaded document bytes are unavailable." } });
  record("built-worker-validation-and-storage-failures-passed", {
    missingStorage: 503, bucketFailure: 503, databaseCleanup: deletedKeys.length,
    dishonestLength: 413, stalledBody: 408, missingObject: 404,
  });
}

function expectedOrder(documents) {
  return [...documents].sort((left, right) => right.uploadedAt.localeCompare(left.uploadedAt) || right.id.localeCompare(left.id));
}

async function assertRejected(label, body, status, kind, expected) {
  const result = await jsonRequest("/api/documents", { method: "POST", body }, status);
  assert.equal(result.body.error.kind, kind, label);
  assert.deepEqual(await list(), { documents: expected }, `${label} must not create a document record`);
}

async function main() {
  await mkdir(state, { recursive: true });
  await artifactFailureChecks();
  await migrate();
  await startWorker();
  assert.deepEqual(await list(), { documents: [] });
  record("empty-list-passed");

  for (const method of ["PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const response = await jsonRequest("/api/documents", { method }, 405);
    assert.equal(response.response.headers.get("allow"), "GET, POST");
    assert.equal(response.body.error.kind, "method_not_allowed");
  }

  const first = (await jsonRequest("/api/documents", {
    method: "POST", body: uploadBody(firstPdf, "fixture-one.pdf"),
  }, 201)).body.document;
  assert.deepEqual(first, {
    id: first.id,
    filename: "fixture-one.pdf",
    byteCount: firstPdf.byteLength,
    sha256: sha256(firstPdf),
    uploadedAt: first.uploadedAt,
    status: "stored",
  });
  assert.match(first.id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
  assert.equal(new Date(first.uploadedAt).toISOString(), first.uploadedAt);
  await download(first, firstPdf);
  record("first-upload-metadata-hash-and-exact-download-passed", { id: first.id, bytes: first.byteCount, sha256: first.sha256 });

  const second = (await jsonRequest("/api/documents", {
    method: "POST", body: uploadBody(secondPdf, "fixture-two.pdf"),
  }, 201)).body.document;
  assert.notEqual(second.id, first.id);
  assert.deepEqual(second, {
    id: second.id,
    filename: "fixture-two.pdf",
    byteCount: secondPdf.byteLength,
    sha256: sha256(secondPdf),
    uploadedAt: second.uploadedAt,
    status: "stored",
  });
  await download(second, secondPdf);
  const expected = expectedOrder([first, second]);
  assert.deepEqual(await list(), { documents: expected });
  record("second-distinct-upload-and-newest-first-list-passed", { firstId: first.id, secondId: second.id, rowCount: 2 });

  const firstPid = worker.pid;
  await stop(worker);
  await startWorker();
  assert.notEqual(worker.pid, firstPid);
  // The replacement Worker's first document operation is read-only.
  assert.deepEqual(await list(), { documents: expected });
  await download(first, firstPdf);
  await download(second, secondPdf);
  record("restart-read-before-any-new-upload-passed", { rowCount: 2, firstId: first.id, secondId: second.id });

  await stop(worker);
  await migrate();
  await startWorker();
  assert.deepEqual(await list(), { documents: expected });
  await download(first, firstPdf);
  await download(second, secondPdf);
  record("migration-reapply-preserves-document-rows-and-bytes", { rowCount: 2, firstSha256: first.sha256, secondSha256: second.sha256 });

  await assertRejected("missing file", missingFileBody(), 400, "invalid_request", expected);
  await assertRejected("multiple files", multipleFileBody(), 400, "invalid_request", expected);
  await assertRejected("non-PDF bytes", uploadBody(Buffer.from("not a PDF"), "misleading.pdf", "application/pdf"), 400, "invalid_request", expected);
  await assertRejected("empty file", uploadBody(new Uint8Array(), "empty.pdf"), 400, "invalid_request", expected);
  await assertRejected("long filename", uploadBody(firstPdf, `${"x".repeat(252)}.pdf`), 400, "invalid_request", expected);
  const oversizedFile = new Uint8Array(MAX_FILE_BYTES + 1);
  oversizedFile.set(firstPdf.subarray(0, Math.min(firstPdf.byteLength, oversizedFile.byteLength)));
  await assertRejected("file limit", uploadBody(oversizedFile, "too-large.pdf"), 413, "body_too_large", expected);
  record("missing-multiple-nonpdf-empty-filename-and-file-limit-rejected-without-records", { rowCount: 2 });

  // This body-limit case uses a fixed byte body rather than the known chunked
  // stress sequence. The direct artifact case above also verifies a chunked
  // dishonest Content-Length without touching D1/R2.
  const oversizedBody = new Uint8Array(MAX_BODY_BYTES + 1);
  const bodyLimit = await jsonRequest("/api/documents", {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=body-limit" },
    body: oversizedBody,
  }, 413);
  assert.equal(bodyLimit.body.error.kind, "body_too_large");
  assert.deepEqual(await list(), { documents: expected });
  record("actual-local-body-limit-rejected-without-records", { maxBodyBytes: MAX_BODY_BYTES, rowCount: 2 });

  const invalidId = await jsonRequest("/api/documents/not-an-id/pdf", undefined, 400);
  assert.equal(invalidId.body.error.kind, "invalid_request");
  const missingId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const missing = await jsonRequest(`/api/documents/${missingId}/pdf`, undefined, 404);
  assert.equal(missing.body.error.kind, "document_not_found");
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
      assert.ok(owner.startsWith(resolve(root, ".wrangler/document-check") + sep));
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
  console.log(`Document check ${evidence.result}. Evidence: ${resolve(evidenceDirectory, "result.json")}`);
}
