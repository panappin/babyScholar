import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(import.meta.dirname, "..");
const wrangler = resolve(root, "node_modules/wrangler/bin/wrangler.js");
const state = resolve(root, ".wrangler/paper-search-check", randomUUID());
let worker;

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

async function stopOwnedWorker() {
  if (!worker || worker.exitCode !== null || worker.signalCode !== null) return;
  const killer = spawn("taskkill.exe", ["/PID", String(worker.pid), "/T", "/F"], { windowsHide: true, stdio: "pipe" });
  await new Promise((resolveKill, reject) => {
    killer.once("error", reject);
    killer.once("exit", (code) => code === 0 ? resolveKill() : reject(new Error(`taskkill exited ${code}`)));
  });
  await Promise.race([
    worker.done,
    delay(10_000, undefined, { ref: false }).then(() => { throw new Error(`Owned Worker ${worker.pid} did not stop.`); }),
  ]);
}

async function waitForHealth(origin) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (worker.launchError || worker.exitCode !== null || worker.signalCode !== null) {
      throw new Error(`Worker exited before health check.\n${worker.log}`);
    }
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1_500) });
      if (response.status === 200) return;
    } catch { /* The Worker may still be starting. */ }
    await delay(200);
  }
  throw new Error(`Timed out waiting for the local Worker.\n${worker.log}`);
}

try {
  await mkdir(state, { recursive: true });
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  worker = spawn(process.execPath, [wrangler, "dev", "--config", "wrangler.jsonc", "--local", "--persist-to", state,
    "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", "0", "--show-interactive-dev-session=false"], {
    cwd: root,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  worker.log = "";
  worker.done = new Promise((resolveDone) => {
    worker.once("error", (error) => { worker.launchError = error; resolveDone(); });
    worker.once("close", () => resolveDone());
  });
  for (const stream of [worker.stdout, worker.stderr]) {
    stream.on("data", (chunk) => { worker.log = (worker.log + chunk.toString()).slice(-24_000); });
  }
  await waitForHealth(origin);

  // This is the sole external request made by this command. The Worker applies its per-isolate arXiv pacing.
  const response = await fetch(`${origin}/api/papers/search?q=${encodeURIComponent("graph neural networks")}`, {
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.provider, "arxiv");
  assert.equal(body.query, "graph neural networks");
  assert.ok(Array.isArray(body.papers) && body.papers.length > 0 && body.papers.length <= 10);
  assert.equal(typeof body.papers[0].title, "string");
  assert.equal(typeof body.papers[0].id, "string");
  console.log(JSON.stringify({
    result: "passed",
    origin,
    query: body.query,
    firstPaper: { id: body.papers[0].id, title: body.papers[0].title, url: body.papers[0].url },
    state,
  }));
} finally {
  try {
    await stopOwnedWorker();
  } catch (error) {
    console.error(`Owned Worker cleanup failed: ${error}`);
    process.exitCode = 1;
  }
}
