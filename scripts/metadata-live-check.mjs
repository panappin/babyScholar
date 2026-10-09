import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createMetadataPdfFixture } from "./fixtures/pdf-fixtures.mjs";

const root = resolve(import.meta.dirname, "..");
const wrangler = resolve(root, "node_modules/wrangler/bin/wrangler.js");
const id = randomUUID();
const evidenceDirectory = resolve(root, ".wrangler/metadata-live-check", id);
const state = resolve(evidenceDirectory, "state");
const fixture = createMetadataPdfFixture();
const children = new Set();
let worker;
let origin;
const evidence = {
  id,
  startedAt: new Date().toISOString(),
  fixture: { source: "scripts/fixtures/pdf-fixtures.mjs", license: "CC0-1.0" },
  liveProviderRequests: 0,
  steps: [],
};

function record(step, details = {}) {
  evidence.steps.push({ step, ...details });
  console.log(JSON.stringify({ step, ...details }));
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
  record("stopped-owned-process", { label: child.label, pid: child.pid });
}

async function availablePort() {
  const server = createServer();
  await new Promise((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", done); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((done, fail) => server.close((error) => error ? fail(error) : done()));
  return address.port;
}

async function migrate() {
  const child = launch(["d1", "migrations", "apply", "DB", "--config", "wrangler.jsonc", "--local", "--persist-to", state], "migration");
  await Promise.race([child.done, delay(45_000, undefined, { ref: false }).then(() => { throw new Error("Local migration timed out."); })]);
  assert.equal(child.exitCode, 0, "Isolated local migration failed.");
  await stop(child);
  record("migrations-applied", { exitCode: child.exitCode });
}

async function startWorker() {
  const port = await availablePort();
  origin = `http://127.0.0.1:${port}`;
  worker = launch([
    "dev", "--config", "wrangler.jsonc", "--local", "--persist-to", state,
    "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", "0", "--show-interactive-dev-session=false",
  ], "Worker");
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
  const response = await fetch(`${origin}${path}`, { ...init, signal: AbortSignal.timeout(45_000) });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-type") ?? "", /application\/json/u);
  const body = await response.json();
  if (expectedStatus !== undefined && response.status !== expectedStatus) {
    const error = body && typeof body === "object" && "error" in body ? body.error : undefined;
    const errorKind = error && typeof error === "object" && "kind" in error && typeof error.kind === "string" ? error.kind : "unspecified";
    record("unexpected-local-worker-response", { path, expectedStatus, actualStatus: response.status, errorKind });
    assert.equal(response.status, expectedStatus, "Unexpected local Worker response status.");
  }
  return { response, body };
}

function uploadBody() {
  const form = new FormData();
  form.append("file", new Blob([fixture.bytes], { type: "application/pdf" }), "metadata-live-fixture.pdf");
  return form;
}

function normalize(value) {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function evidenceMatchesSelectedText(metadata, extraction) {
  const pageText = new Map(extraction.pages
    .filter((page) => metadata.selectedPageNumbers.includes(page.pageNumber))
    .map((page) => [page.pageNumber, normalize(page.text)]));
  for (const field of ["title", "authors", "year", "abstract"]) {
    assert.ok(Array.isArray(metadata.evidence[field]) && metadata.evidence[field].length > 0, `Expected ${field} evidence.`);
    for (const quote of metadata.evidence[field]) {
      assert.ok(pageText.get(quote.pageNumber)?.includes(normalize(quote.quote)), `Expected ${field} quote to match selected extraction text.`);
    }
  }
}

async function removeOwnedState() {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(state, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  throw lastError;
}

async function main() {
  if (!await configuredKeyIsAvailable()) {
    record("live-provider-check-skipped", { reason: "OPENAI_API_KEY is unavailable locally" });
    evidence.result = "skipped";
    return;
  }
  await mkdir(state, { recursive: true });
  await migrate();
  await startWorker();
  const uploaded = await jsonRequest("/api/documents", { method: "POST", body: uploadBody() }, 201);
  const documentId = uploaded.body.document.id;
  const extracted = await jsonRequest(`/api/documents/${documentId}/extract`, { method: "POST" }, 201);

  // This is the sole endpoint invocation in this script that can contact OpenAI.
  evidence.liveProviderRequests = 1;
  const generated = await jsonRequest(`/api/documents/${documentId}/metadata`, { method: "POST" }, 201);
  const metadata = generated.body.metadata;
  assert.equal(metadata.title, fixture.expected.title);
  assert.deepEqual(metadata.authors, fixture.expected.authors);
  assert.equal(metadata.year, fixture.expected.year);
  assert.equal(metadata.abstract, fixture.expected.abstract);
  assert.equal(metadata.sourceSha256, uploaded.body.document.sha256);
  assert.deepEqual(metadata.selectedPageNumbers, [1, 2]);
  assert.equal(metadata.sourceExcerptClipped, false);
  assert.equal(metadata.promptVersion, "document-metadata-v1");
  assert.match(metadata.model, /\S/u);
  evidenceMatchesSelectedText(metadata, extracted.body.extraction);
  const readBack = await jsonRequest(`/api/documents/${documentId}/metadata`, undefined, 200);
  assert.deepEqual(readBack.body.metadata, metadata);
  record("actual-local-worker-live-metadata-request-passed", {
    documentId,
    model: metadata.model,
    sourcePages: metadata.selectedPageNumbers.length,
    evidenceFields: Object.keys(metadata.evidence).length,
  });
  evidence.result = "passed";
}

try {
  await main();
} catch (error) {
  evidence.result = "failed";
  evidence.failure = error instanceof Error ? error.name : "UnknownError";
  console.error("Live metadata check failed without retrying the provider request.");
  process.exitCode = 1;
} finally {
  try {
    await stop(worker);
    for (const child of [...children]) await stop(child);
    evidence.completedAt = new Date().toISOString();
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(resolve(evidenceDirectory, "result.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    await removeOwnedState();
    console.log(`Metadata live-check evidence: ${resolve(evidenceDirectory, "result.json")}`);
  } catch {
    process.exitCode = 1;
    console.error("Live metadata check cleanup failed.");
  }
}
