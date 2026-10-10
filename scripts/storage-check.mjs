import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = resolve(root, "node_modules/wrangler/bin/wrangler.js");
const vite = resolve(root, "node_modules/vite/bin/vite.js");
const id = randomUUID();
const state = resolve(root, ".wrangler/storage-check", id);
// Keep an absolute path for owned-state safety checks, but pass its
// project-relative spelling to the local CLI.
const stateArgument = relative(root, state).split(sep).join("/") || ".";
const probePath = `/api/__local/storage-probe/${id}`;
const value = `persistent D1 probe ${id}: quotes ' and Unicode λ`;
const bytes = [0, 1, 2, 127, 128, 254, 255, ...Buffer.from(`R2 probe ${id}\n`)];
const evidence = {
  id, state, flag: "LOCAL_STORAGE_PROBE:true", value, bytes,
  sha256: createHash("sha256").update(Buffer.from(bytes)).digest("hex"),
  startedAt: new Date().toISOString(), steps: [],
};
const children = new Set();
let worker;
let frontend;
let base;
let probeMayExist = false;

function record(step, details = {}) {
  evidence.steps.push({ step, ...details });
  console.log(JSON.stringify({ step, ...details }));
}

async function availablePort() {
  const server = createServer();
  await new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", ok);
  });
  const port = server.address().port;
  await new Promise((ok, fail) => server.close((error) => error ? fail(error) : ok()));
  return port;
}

function launch(entry, args, extraEnv = {}) {
  const child = spawn(process.execPath, [entry, ...args], {
    cwd: root,
    windowsHide: true,
    // Own process group on POSIX; Windows cleanup targets this exact PID tree.
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", ...extraEnv },
  });
  child.log = "";
  child.done = new Promise((ok) => {
    child.once("error", (error) => { child.launchError = error; ok(); });
    child.once("close", () => ok());
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => { child.log = (child.log + chunk.toString()).slice(-24000); });
  }
  children.add(child);
  return child;
}

async function stop(child) {
  if (!child || !children.has(child)) return;
  if (child.exitCode === null && child.signalCode === null && !child.launchError) {
    if (process.platform === "win32") {
      // Only this script's recorded child, never a process found by port/name.
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true, stdio: "pipe",
      });
      await new Promise((ok, fail) => {
        killer.once("error", fail);
        killer.once("exit", (code) => code === 0 || child.exitCode !== null ? ok() : fail(new Error(`taskkill exited ${code}`)));
      });
    } else {
      process.kill(-child.pid, "SIGTERM");
    }
    await Promise.race([
      child.done,
      delay(10000, undefined, { ref: false }).then(() => { throw new Error(`PID ${child.pid} did not stop`); }),
    ]);
  }
  children.delete(child);
  record("stopped-owned-process", { pid: child.pid });
}

async function waitForServer(child, url) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (child.launchError || child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Server exited: ${child.launchError ?? ""}\n${child.log}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (response.ok) { await response.text(); return; }
      await response.body?.cancel();
    } catch { /* Server may still be starting. */ }
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${url}\n${child.log}`);
}

async function migrate() {
  const args = ["d1", "migrations", "apply", "DB", "--config", "wrangler.jsonc", "--local", "--persist-to", stateArgument];
  record("migrate-command", { command: `node node_modules/wrangler/bin/wrangler.js ${args.join(" ")}` });
  const child = launch(wrangler, args);
  child.stdin.end(); // Noninteractive Wrangler confirms local migration application.
  await Promise.race([
    child.done,
    delay(45000, undefined, { ref: false }).then(() => { throw new Error("Local migration timed out"); }),
  ]);
  if (child.launchError || child.exitCode !== 0) throw new Error(child.log || String(child.launchError));
  children.delete(child);
  console.log(child.log.trim());
  record("migration-applied", { exitCode: child.exitCode });
}

async function startWorker(port, enableProbe) {
  const args = ["dev", "--config", "wrangler.jsonc", "--local", "--persist-to", stateArgument,
    "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", "0",
    "--show-interactive-dev-session=false"];
  if (enableProbe) args.push("--var", "LOCAL_STORAGE_PROBE:true");
  const child = launch(wrangler, args);
  worker = child;
  await waitForServer(child, `${base}/api/health`);
  record("worker-started", { pid: child.pid, url: base, state, probeFlagPresent: enableProbe });
  return child;
}

async function request(url, expectedStatus, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
  const text = await response.text();
  assert.equal(response.status, expectedStatus, `${init?.method ?? "GET"} ${url}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function checkHttp(origin) {
  assert.deepEqual(await request(`${origin}/api/health`, 200), { status: "ok" });
  assert.deepEqual(await request(`${origin}/api/storage/status`, 200), {
    status: "ok", d1: { status: "ok" }, r2: { status: "ok" },
  });
  record("http-health-and-storage-passed", { origin });
}

async function readAndCompare(stage) {
  const actual = await request(`${base}${probePath}`, 200);
  assert.deepEqual(actual, { row: { id, value }, bytes });
  record(stage, { row: actual.row, bytes: actual.bytes, sha256: evidence.sha256 });
}

async function cleanupProbe() {
  await request(`${base}${probePath}`, 204, { method: "DELETE" });
  assert.deepEqual(await request(`${base}${probePath}`, 200), { row: null, bytes: null });
  probeMayExist = false;
  record("own-row-and-object-deleted", { id, objectKey: `__storage_probes/${id}.bin` });
}

async function main() {
  await mkdir(state, { recursive: true });
  console.log(`Isolated local state: ${state}`);
  const workerPort = await availablePort();
  base = `http://127.0.0.1:${workerPort}`;
  await migrate();

  await startWorker(workerPort, false);
  await checkHttp(base);
  for (const method of ["GET", "PUT", "DELETE"]) {
    const response = await fetch(`${base}${probePath}`, { method, signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 404, `${method} probe route must be absent without the local flag`);
    await response.text();
  }
  record("probe-routes-disabled-without-flag", { methods: ["GET", "PUT", "DELETE"], status: 404 });

  const frontendPort = await availablePort();
  const frontendOrigin = `http://127.0.0.1:${frontendPort}`;
  frontend = launch(vite, ["--host", "127.0.0.1", "--port", String(frontendPort), "--strictPort"], {
    LOCAL_WORKER_ORIGIN: base,
  });
  await waitForServer(frontend, frontendOrigin);
  const html = await (await fetch(frontendOrigin)).text();
  assert.match(html, /<title>AI Research Assistant<\/title>/);
  assert.match(html, /\/src\/main.tsx/);
  record("frontend-html-served", { origin: frontendOrigin, status: 200 });
  await checkHttp(frontendOrigin);
  await stop(frontend);
  await stop(worker);

  await startWorker(workerPort, true);
  assert.deepEqual(await request(`${base}${probePath}`, 200), { row: null, bytes: null });
  probeMayExist = true; // Also clean up if only one of the two writes succeeds.
  await request(`${base}${probePath}`, 201, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value, bytes }),
  });
  record("single-probe-write", { id });
  await readAndCompare("initial-read-matches");
  const firstPid = worker.pid;
  await stop(worker);

  await startWorker(workerPort, true);
  assert.notEqual(worker.pid, firstPid);
  // This is the first probe operation in the replacement process: GET only.
  await readAndCompare("after-restart-read-before-any-rewrite-matches");
  await stop(worker);
  await migrate();
  await startWorker(workerPort, true);
  await readAndCompare("after-migration-reapply-matches");
  await cleanupProbe();
  evidence.result = "passed";
}

try {
  await main();
} catch (error) {
  evidence.result = "failed";
  evidence.error = String(error.stack ?? error);
  console.error(evidence.error);
  if (worker?.log) console.error(worker.log);
  process.exitCode = 1;
} finally {
  if (probeMayExist && worker?.exitCode === null) {
    try { await cleanupProbe(); }
    catch (error) { console.error(`Probe cleanup failed; retained state at ${state}: ${error}`); process.exitCode = 1; }
  }
  for (const child of [...children]) {
    try { await stop(child); }
    catch (error) { console.error(`Process cleanup failed for owned PID ${child.pid}: ${error}`); process.exitCode = 1; }
  }
  if (process.exitCode) evidence.result = "failed";
  evidence.finishedAt = new Date().toISOString();
  await writeFile(resolve(state, "result.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`Storage check ${evidence.result}. Evidence: ${resolve(state, "result.json")}`);
}
