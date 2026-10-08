import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = resolve(root, "node_modules/wrangler/bin/wrangler.js");
const vite = resolve(root, "node_modules/vite/bin/vite.js");
const id = randomUUID();
const state = resolve(root, ".wrangler/integration-check", id);
const offlineMode = process.env.INTEGRATION_CHECK_OFFLINE === "true";
const evidence = {
  id,
  state,
  mode: offlineMode ? "offline" : "live",
  probeFlag: "LOCAL_INTEGRATION_PROBE:true",
  startedAt: new Date().toISOString(),
  steps: [],
};
const children = new Set();
let worker;
let frontend;
let workerOrigin;

function record(step, details = {}) {
  evidence.steps.push({ step, ...details });
  console.log(JSON.stringify({ step, ...details }));
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePort);
  });
  const port = server.address().port;
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

function launch(entry, args, extraEnv = {}) {
  const child = spawn(process.execPath, [entry, ...args], {
    cwd: root,
    windowsHide: true,
    detached: process.platform !== "win32",
    // Wrangler's local D1 command is unattended; a closed piped stdin can
    // trigger an internal error on Windows, so give children no stdin.
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", ...extraEnv },
  });
  child.log = "";
  child.done = new Promise((resolveDone) => {
    child.once("error", (error) => { child.launchError = error; resolveDone(); });
    child.once("close", () => resolveDone());
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
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "pipe",
      });
      await new Promise((resolveKill, reject) => {
        killer.once("error", reject);
        killer.once("exit", (code) => code === 0 || child.exitCode !== null
          ? resolveKill()
          : reject(new Error(`taskkill exited ${code}`)));
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
      if (response.ok) {
        await response.body?.cancel();
        return;
      }
      await response.body?.cancel();
    } catch { /* The child may still be starting. */ }
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${url}\n${child.log}`);
}

async function migrate() {
  const args = ["d1", "migrations", "apply", "DB", "--config", "wrangler.jsonc", "--local", "--persist-to", state];
  // This brief, noninteractive command is run synchronously. On Windows,
  // Wrangler can report an internal error when it is managed as an async
  // child alongside the later long-lived dev processes.
  const result = spawnSync(process.execPath, [wrangler, ...args], {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 45000,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error || result.status !== 0) throw new Error(output || String(result.error));
  record("migration-applied", { exitCode: result.status });
}

async function startWorker(port, enableProbe) {
  const args = ["dev", "--config", "wrangler.jsonc", "--local", "--persist-to", state,
    "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", "0",
    "--show-interactive-dev-session=false"];
  if (enableProbe) args.push("--var", "LOCAL_INTEGRATION_PROBE:true");
  worker = launch(wrangler, args);
  await waitForServer(worker, `${workerOrigin}/api/health`);
  record("worker-started", { pid: worker.pid, origin: workerOrigin, probeFlagPresent: enableProbe });
}

async function jsonRequest(url, expectedStatus) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const text = await response.text();
  assert.equal(response.status, expectedStatus, `${url}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function checkCoreRoutes(origin) {
  assert.deepEqual(await jsonRequest(`${origin}/api/health`, 200), { status: "ok" });
  assert.deepEqual(await jsonRequest(`${origin}/api/storage/status`, 200), {
    status: "ok", d1: { status: "ok" }, r2: { status: "ok" },
  });
  record("health-and-storage-passed", { origin });
}

async function verifyDisabledProbeRoutes() {
  for (const path of ["arxiv", "openai"]) {
    const response = await fetch(`${workerOrigin}/api/__local/integrations/${path}`, { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 404, `${path} probe must be disabled without the local flag`);
    await response.body?.cancel();
  }
  record("integration-probe-routes-disabled-without-flag", { status: 404 });
}

async function runIntegrationRoutes() {
  const arxiv = await jsonRequest(`${workerOrigin}/api/__local/integrations/arxiv`, 200);
  assert.equal(arxiv.status, "ok");
  assert.equal(arxiv.result.provider, "arxiv");
  assert.ok(arxiv.result.title);
  assert.match(arxiv.result.link, /^https:\/\/arxiv\.org\/abs\//u);
  evidence.arxiv = arxiv.result;
  record("arxiv-live-probe-passed", { title: arxiv.result.title, link: arxiv.result.link });

  // Exactly one OpenAI route request per invocation; the Worker does not retry it.
  const response = await fetch(`${workerOrigin}/api/__local/integrations/openai`, { signal: AbortSignal.timeout(30000) });
  const body = JSON.parse(await response.text());
  if (response.status === 200) {
    assert.equal(body.status, "ok");
    assert.equal(body.result.provider, "openai");
    assert.ok(typeof body.result.text === "string" && body.result.text.trim());
    evidence.openai = { status: "completed", model: body.result.model, text: body.result.text };
    record("openai-live-probe-passed", { model: body.result.model, text: body.result.text });
    return;
  }
  if (response.status === 424 && body?.error?.kind === "missing_configuration") {
    evidence.openai = { status: "skipped_missing_configuration", model: body.model, error: body.error };
    record("openai-live-probe-skipped", { model: body.model, reason: body.error.kind });
    return;
  }
  throw new Error(`OpenAI probe failed: HTTP ${response.status} ${JSON.stringify(body)}`);
}

async function main() {
  await mkdir(state, { recursive: true });
  const workerPort = await availablePort();
  workerOrigin = `http://127.0.0.1:${workerPort}`;
  await migrate();
  await startWorker(workerPort, false);
  await checkCoreRoutes(workerOrigin);
  await verifyDisabledProbeRoutes();

  const vitePort = await availablePort();
  const viteOrigin = `http://127.0.0.1:${vitePort}`;
  frontend = launch(vite, ["--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], {
    LOCAL_WORKER_ORIGIN: workerOrigin,
  });
  await waitForServer(frontend, viteOrigin);
  const html = await (await fetch(viteOrigin)).text();
  assert.match(html, /<title>AI Research Assistant<\/title>/u);
  await checkCoreRoutes(viteOrigin);
  record("frontend-proxy-passed", { origin: viteOrigin });
  await stop(frontend);
  await stop(worker);

  await startWorker(workerPort, true);
  if (offlineMode) {
    // The clean-copy reproducibility check must not contact either upstream.
    // Keeping the flag on still verifies that the Worker starts with the local
    // diagnostic binding, while deliberately not invoking either probe route.
    evidence.integrations = { status: "not_invoked", reason: "offline_mode" };
    record("integration-routes-not-invoked-in-offline-mode");
    evidence.result = "passed_offline";
    return;
  }
  await runIntegrationRoutes();
  evidence.result = evidence.openai?.status === "completed" ? "passed" : "passed_with_openai_skipped";
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
  for (const child of [...children]) {
    try { await stop(child); }
    catch (error) { console.error(`Process cleanup failed for owned PID ${child.pid}: ${error}`); process.exitCode = 1; }
  }
  if (process.exitCode) evidence.result = "failed";
  evidence.finishedAt = new Date().toISOString();
  await writeFile(resolve(state, "result.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`Integration check ${evidence.result}. Evidence: ${resolve(state, "result.json")}`);
}
