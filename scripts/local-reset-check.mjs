import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "node:net";
import { root, resetStorage, stopSession, windowsProcesses } from "./local-dev.mjs";

const directory = resolve(root, ".wrangler/local-reset-check", randomUUID());
const statePath = resolve(directory, "state");
const backupRoot = resolve(directory, "backups");
const evidence = { result: "running", steps: [], liveProviderRequests: 0 };
let manager;
async function availablePort() {
  const server = createServer();
  await new Promise((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", done); });
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}
try {
  await mkdir(statePath, { recursive: true });
  await writeFile(resolve(statePath, "owned-record"), "fixture data");
  let migrations = 0;
  const migrate = async (target) => {
    migrations += 1;
    const child = spawn(process.execPath, [resolve(root, "node_modules/wrangler/bin/wrangler.js"), "d1", "migrations", "apply", "DB", "--config", "wrangler.jsonc", "--local", "--persist-to", relative(root, target)], { cwd: root, windowsHide: true, stdio: "ignore", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
    const code = await new Promise((done, fail) => { child.once("error", fail); child.once("exit", done); });
    assert.equal(code, 0);
  };
  await assert.rejects(resetStorage({ statePath, backupRoot, assertStopped: async () => { throw new Error("server running"); }, migrate }), /server running/u);
  await assert.rejects(resetStorage({ statePath, backupRoot, assertStopped: async () => {}, migrate, move: async () => { throw new Error("Access denied"); } }), /Access denied/u);
  assert.equal(migrations, 0);
  assert.equal(await readFile(resolve(statePath, "owned-record"), "utf8"), "fixture data");
  const reset = await resetStorage({ statePath, backupRoot, assertStopped: async () => {}, migrate });
  assert.equal(migrations, 1);
  assert.equal(await readFile(resolve(reset.backup, "owned-record"), "utf8"), "fixture data");
  await assert.rejects(access(resolve(statePath, "owned-record")));
  await access(resolve(statePath, "v3/d1"));
  evidence.steps.push("running-server-and-failed-backup-stop-before-migration", "backup-preserves-record-and-fresh-isolated-migrations-pass");
  if (process.platform === "win32") {
    const sessionFile = resolve(directory, "session.json");
    const workerPort = await availablePort(), vitePort = await availablePort();
    manager = spawn(process.execPath, [resolve(root, "scripts/local-dev.mjs"), "run", `--session=${randomUUID()}`, `--check-registry=${sessionFile}`, `--check-worker-port=${workerPort}`, `--check-vite-port=${vitePort}`], { cwd: root, windowsHide: true, stdio: "ignore", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
    for (let i = 0; i < 50; i += 1) { try { await access(sessionFile); break; } catch { await delay(100); } }
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        const response = await fetch(`http://127.0.0.1:${vitePort}/api/storage/status`, { signal: AbortSignal.timeout(500) });
        if (response.ok && (await response.json()).status === "ok") { ready = true; break; }
      } catch { /* Owned Worker/Vite startup only, no provider call. */ }
      await delay(200);
    }
    assert.ok(ready, "owned dev manager starts actual Worker/Vite with disposable D1/R2");
    const owned = await windowsProcesses();
    const ownedIds = new Set([manager.pid]);
    for (let i = 0; i < owned.length; i++) for (const entry of owned) if (ownedIds.has(entry.ParentProcessId)) ownedIds.add(entry.ProcessId);
    const descendants = owned.filter((entry) => ownedIds.has(entry.ProcessId) && entry.ProcessId !== manager.pid);
    assert.ok(descendants.length);
    await stopSession(sessionFile);
    const remaining = await windowsProcesses();
    assert.ok(!remaining.some((entry) => entry.ProcessId === manager.pid || descendants.some((child) => child.ProcessId === entry.ProcessId)));
    await resetStorage({ statePath, backupRoot, assertStopped: async () => {
      assert.ok(!(await windowsProcesses()).some((entry) => ownedIds.has(entry.ProcessId)));
    }, migrate });
    evidence.steps.push("windows-actual-worker-vite-storage-startup-and-owned-tree-cleanup-verified", "state-rename-and-migrations-after-owned-runtime-shutdown-passed");
  }
  evidence.result = "passed";
} catch (error) { evidence.result = "failed"; evidence.error = String(error.stack ?? error); process.exitCode = 1; }
finally { if (manager && manager.exitCode === null) await stopSession(resolve(directory, "session.json")).catch(() => {}); await writeFile(resolve(directory, "result.json"), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify({ ...evidence, evidence: resolve(directory, "result.json") })); }
