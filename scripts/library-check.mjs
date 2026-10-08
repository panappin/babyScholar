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
const evidenceDirectory = resolve(root, ".wrangler/library-check", id);
const state = resolve(evidenceDirectory, "state");
const evidence = { id, state, startedAt: new Date().toISOString(), steps: [] };
const transportStress = process.argv.includes("--transport-stress");
evidence.transportStress = transportStress;
const children = new Set();
let worker;
let origin;

const fullPaper = {
  id: "2401.01234",
  title: "A paper's title & Unicode 测试",
  authors: ["李 雷", "Ada O'Author", "Bea Researcher"],
  year: 2024,
  abstract: "Full abstract: λ & <ordinary text>\n".repeat(1_500),
  url: "https://arxiv.org/abs/2401.01234v1",
  pdfUrl: "https://arxiv.org/pdf/2401.01234v1.pdf",
};
const nullPaper = { id: "2401.01235", title: "", authors: [], year: null, abstract: "", url: null, pdfUrl: null };
const post = (paper) => ({ method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify({ paper }) });
const record = (step, details = {}) => {
  evidence.steps.push({ step, ...details });
  console.log(JSON.stringify({ step, ...details }));
};

function launch(args) {
  const child = spawn(process.execPath, [wrangler, ...args], {
    cwd: root, windowsHide: true, detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  child.log = "";
  child.done = new Promise((done) => {
    child.once("error", (error) => { child.launchError = error; done(); });
    child.once("close", done);
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => { child.log = (child.log + chunk.toString()).slice(-24_000); });
  }
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
        // Account for an owned child exiting just before taskkill. Never find/kill by process name or port.
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
  assert.equal(child.exitCode, 0, "Local migration failed (no raw Wrangler/secret configuration logged).");
  children.delete(child);
  record("migrations-applied", { state, exitCode: child.exitCode });
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
    } catch { /* Allow Wrangler to start. */ }
    await delay(200);
  }
  throw new Error("Owned Worker did not become ready.");
}

async function request(init, expectedStatus) {
  const response = await fetch(`${origin}/api/library/papers`, { ...init, signal: AbortSignal.timeout(20_000) }).catch((error) => {
    throw new Error(`Local library request failed: ${error.cause?.code ?? error.name}: ${error.cause?.message ?? error.message}`);
  });
  if (response.headers.get("cache-control") !== "no-store") {
    const text = await response.text();
    // Never copy runtime stack/configuration into shareable evidence.
    const detail = text.includes("Network connection lost") ? "local proxy: Network connection lost" : "unexpected non-library response";
    throw new Error(`${init?.method ?? "GET"} HTTP ${response.status}, expected ${expectedStatus ?? "success"}: ${detail}`);
  }
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.match(response.headers.get("content-type"), /application\/json/u);
  const body = await response.json();
  if (expectedStatus !== undefined) assert.equal(response.status, expectedStatus, JSON.stringify(body));
  return { status: response.status, body, allow: response.headers.get("allow") };
}

const list = async () => (await request(undefined, 200)).body;

async function artifactFailureChecks() {
  const path = "https://library-check.invalid/api/library/papers";
  for (const init of [undefined, post(nullPaper)]) {
    const response = await workerArtifact.fetch(new Request(path, init), {});
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: { kind: "storage_unavailable", message: "The paper library database is unavailable." } });
  }
  const brokenDatabase = { prepare() { throw new Error("private database details must not leak"); } };
  for (const init of [undefined, post(nullPaper)]) {
    const response = await workerArtifact.fetch(new Request(path, init), { DB: brokenDatabase });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: { kind: "database_failure", message: "The paper library database operation failed." } });
  }
  let touchedDatabase = false;
  const untouchedDatabase = { prepare() { touchedDatabase = true; throw new Error("Invalid input must fail before database access."); } };
  const streamRequest = (body, headers = {}) => new Request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body, duplex: "half" });
  const oversized = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(262_145)); controller.close(); } });
  const oversizeResponse = await workerArtifact.fetch(streamRequest(oversized, { "content-length": "1" }), { DB: untouchedDatabase });
  assert.equal(oversizeResponse.status, 413, "actual stream size must override dishonest Content-Length");
  const hanging = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"paper":')); } });
  const timeoutResponse = await workerArtifact.fetch(streamRequest(hanging), { DB: untouchedDatabase });
  assert.equal(timeoutResponse.status, 408);
  assert.equal((await timeoutResponse.json()).error.kind, "request_timeout");
  assert.equal(hanging.locked, false, "the timed-out reader must release the inbound stream");
  assert.equal(touchedDatabase, false);
  record("built-worker-failures-passed", { missingBinding: 503, databaseFailure: 503, dishonestLength: 413, stalledBody: 408, databaseTouched: false });
}

async function main() {
  await mkdir(state, { recursive: true });
  await artifactFailureChecks();
  await migrate();
  await startWorker();
  assert.deepEqual(await list(), { papers: [] });
  record("empty-library-passed");
  for (const method of ["PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const response = await request({ method }, 405);
    assert.equal(response.allow, "GET, POST");
    assert.equal(response.body.error.kind, "method_not_allowed");
  }

  // Neither identity has been seeded. Different payloads make it observable
  // that exactly one first save wins and the other returns that same record.
  const competing = { ...fullPaper, title: "Competing first save", url: "https://arxiv.org/abs/2401.01234v2" };
  const simultaneous = await Promise.all([request(post(fullPaper)), request(post(competing))]);
  assert.deepEqual(simultaneous.map((result) => result.status).sort(), [200, 201]);
  const winnerIndex = simultaneous.findIndex((result) => result.status === 201);
  const winner = simultaneous[winnerIndex].body.paper;
  const winningInput = [fullPaper, competing][winnerIndex];
  for (const result of simultaneous) {
    assert.equal(result.body.created, result.status === 201);
    assert.deepEqual(result.body.paper, winner);
  }
  const { id: sourceId, ...metadata } = winningInput;
  assert.deepEqual(winner, { ...metadata, id: winner.id, source: "arxiv", arxivId: sourceId, savedAt: winner.savedAt });
  assert.match(winner.id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
  assert.notEqual(winner.id, sourceId);
  assert.equal(new Date(winner.savedAt).toISOString(), winner.savedAt);
  assert.deepEqual(await list(), { papers: [winner] });
  record("simultaneous-first-saves-passed", { statuses: simultaneous.map((r) => r.status), rowCount: 1, id: winner.id, arxivId: winner.arxivId, savedAt: winner.savedAt });
  record("full-metadata-round-trip-passed", { authors: winner.authors.length, abstractCharacters: [...winner.abstract].length, sha256: createHash("sha256").update(JSON.stringify(winner)).digest("hex") });

  for (const paper of [fullPaper, { ...fullPaper, id: "2401.01234v9", title: "Must not overwrite", abstract: "different", url: "http://www.arxiv.org/abs/2401.01234v9", pdfUrl: "http://arxiv.org/pdf/2401.01234v9" }]) {
    assert.deepEqual((await request(post(paper), 200)).body, { paper: winner, created: false });
  }
  assert.deepEqual(await list(), { papers: [winner] });
  const nullSaved = (await request(post(nullPaper), 201)).body.paper;
  assert.deepEqual(nullSaved, { ...nullPaper, id: nullSaved.id, source: "arxiv", arxivId: nullPaper.id, savedAt: nullSaved.savedAt });
  const legacy = { ...fullPaper, id: "cond-mat/0011267v2", title: winningInput.title, url: "http://www.arxiv.org/abs/cond-mat/0011267v2", pdfUrl: "http://arxiv.org/pdf/cond-mat/0011267v2.pdf" };
  const legacySaved = (await request(post(legacy), 201)).body.paper;
  assert.equal(legacySaved.arxivId, "cond-mat/0011267");
  assert.equal(legacySaved.url, "https://arxiv.org/abs/cond-mat/0011267v2");
  assert.equal(legacySaved.pdfUrl, "https://arxiv.org/pdf/cond-mat/0011267v2.pdf");
  assert.notEqual(legacySaved.id, winner.id, "same title must not imply same identity");
  assert.deepEqual((await request(post({ ...legacy, id: "cond-mat/0011267" }), 200)).body, { paper: legacySaved, created: false });
  const compare = (a, b) => a.savedAt === b.savedAt ? (a.id < b.id ? 1 : -1) : (a.savedAt < b.savedAt ? 1 : -1);
  const expected = { papers: [winner, nullSaved, legacySaved].sort(compare) };
  assert.deepEqual(await list(), expected);
  assert.deepEqual(await list(), expected);
  record("duplicates-nullable-legacy-and-order-passed", { rowCount: 3, originalPreserved: true });

  const invalidPapers = [null, [], {}, { ...nullPaper, id: "bad-id" }, { ...nullPaper, id: "2401.01236", title: 42 },
    { ...nullPaper, authors: "not an array" }, { ...nullPaper, authors: [" "] }, { ...nullPaper, authors: [null] },
    { ...nullPaper, year: 2024.5 }, { ...nullPaper, year: "2024" }, { ...nullPaper, year: 0 },
    { ...nullPaper, title: "x".repeat(2_001) }, { ...nullPaper, abstract: "x".repeat(100_001) },
    { ...nullPaper, authors: Array(2_001).fill("a") }, { ...nullPaper, authors: ["a".repeat(513)] },
    { ...nullPaper, abstract: "null\0character" }, { ...nullPaper, savedAt: "supplied" },
    ...["javascript:alert(1)", "https://evilarxiv.org/abs/2401.01235", "https://arxiv.org.evil.invalid/abs/2401.01235", "https://user:password@arxiv.org/abs/2401.01235", "https://arxiv.org:444/abs/2401.01235", "https://arxiv.org/abs/2401.99999", ""].map((url) => ({ ...nullPaper, url })),
    { ...nullPaper, pdfUrl: "https://evil.invalid/pdf/2401.01235" }, { ...nullPaper, url: undefined }];
  for (const paper of invalidPapers) {
    const response = await request(post(paper), 400);
    assert.equal(response.body.error.kind, "invalid_request");
  }
  for (const body of ['{"paper":', "null", "[]", '{"paper":{},"source":"other"}']) {
    await request({ method: "POST", headers: { "content-type": "application/json" }, body }, 400);
  }
  await request({ method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ paper: nullPaper }) }, 415);
  await request({ method: "POST", body: JSON.stringify({ paper: nullPaper }) }, 415);
  await request({ method: "POST", headers: { "content-type": "application/json" }, body: Uint8Array.from([0xff]) }, 400);
  // Chunked transfer provides no Content-Length: verifies the real Worker
  // counts bytes as they arrive instead of trusting a header or buffering all.
  const oversized = new ReadableStream({ start(controller) {
    for (let chunk = 0; chunk < 5; chunk++) controller.enqueue(new TextEncoder().encode(" ".repeat(64 * 1024)));
    controller.close();
  } });
  await request({ method: "POST", headers: { "content-type": "application/json" }, body: " ".repeat(262_145) }, 413);
  await request({ method: "POST", headers: { "content-type": "application/json" }, body: oversized, duplex: "half" }, 413);
  // Optional regression reproduction for the installed Miniflare transport:
  // immediate non-idempotent requests after chunked rejection can fail outside
  // the Worker handler. Do not retry or suppress a failure in this mode.
  if (transportStress) await request(post(fullPaper), 200);
  assert.deepEqual(await list(), expected);
  assert.deepEqual((await request(post(fullPaper), 200)).body, { paper: winner, created: false });
  record("invalid-unsafe-oversized-inputs-rejected-without-writes", { invalidPaperCases: invalidPapers.length, rowCount: 3 });

  const firstPid = worker.pid;
  await stop(worker);
  await startWorker();
  assert.notEqual(worker.pid, firstPid);
  // First library request in the replacement Worker is GET. No POST/reseed.
  assert.deepEqual(await list(), expected);
  record("restart-first-get-before-any-post-passed", { rowCount: 3, originalId: winner.id, savedAt: winner.savedAt });
  await stop(worker);
  await migrate();
  await startWorker();
  assert.deepEqual(await list(), expected);
  record("migration-reapply-preserves-all-records", { rowCount: 3, originalId: winner.id, savedAt: winner.savedAt });
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
    // Resolve and constrain the exact generated directory before recursive
    // removal. Retain result.json, never touch the user's .wrangler/state.
    try {
      const actual = await realpath(state);
      const owner = await realpath(evidenceDirectory);
      assert.equal(dirname(actual), owner);
      assert.equal(actual, resolve(owner, "state"));
      assert.ok(owner.startsWith(resolve(root, ".wrangler/library-check") + sep));
      await rm(actual, { recursive: true, force: false, maxRetries: 8, retryDelay: 250 });
      record("removed-owned-test-state", { state });
    } catch (error) { evidence.result = "failed"; console.error(`Owned state cleanup failed: ${error}`); process.exitCode = 1; }
  }
  evidence.finishedAt = new Date().toISOString();
  await writeFile(resolve(evidenceDirectory, "result.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log(`Library check ${evidence.result}. Evidence: ${resolve(evidenceDirectory, "result.json")}`);
}
