// Offline diagnostic, not a green-by-construction test. Unexpected transport
// failures are retained and cause exit 1 after independent integrity checks.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { createServer } from "node:net";
import { dirname, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(import.meta.dirname, "..");
const fixture = (id) => ({ id, title: "Transport fixture", authors: ["Fixture Author"], year: null, abstract: "Offline fixture", url: null, pdfUrl: null });
let sequence = 0;
const wireEvents = [];
const socketIds = new WeakMap();
let socketSequence = 0;

// Native HTTP never retries. agent:false creates a new TCP connection; the
// keep-alive Agent below has only one socket, whose identity/ports we record.
function send(origin, { label, method = "GET", path = "/api/library/papers", agent = false, paper, oversized = false }) {
  const trace = label;
  const body = paper ? JSON.stringify({ paper }) : undefined;
  const payload = oversized ? (body ?? "").padEnd(5 * 64 * 1024, " ") : body;
  const event = { label, method, path, clientPid: process.pid, startedAt: new Date().toISOString(), requestedConnection: agent ? "keep-alive" : "fresh" };
  return new Promise((done) => {
    const headers = { "x-transport-trace": trace };
    if (payload !== undefined) headers["content-type"] = "application/json";
    if (oversized) headers["transfer-encoding"] = "chunked";
    else if (payload !== undefined) headers["content-length"] = Buffer.byteLength(payload);
    const req = http.request(new URL(path, origin), { method, headers, agent }, (res) => {
      event.status = res.statusCode;
      event.handlerMarker = res.headers["x-transport-handler"] ?? null;
      event.cacheControl = res.headers["cache-control"] ?? null;
      const chunks = [];
      let bytes = 0;
      res.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 1_000_000) res.destroy(new Error("diagnostic response limit"));
        else chunks.push(chunk);
      });
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json;
        try { json = JSON.parse(text); } catch { /* Proxy errors are plain text. */ }
        event.errorKind = json?.error?.kind ?? (text.includes("Network connection lost") ? "proxy_network_connection_lost" : null);
        event.finishedAt = new Date().toISOString();
        done({ event, json });
      });
      res.on("error", (error) => { event.networkError = error.code ?? error.name; done({ event }); });
    });
    req.on("socket", (socket) => {
      if (!socketIds.has(socket)) socketIds.set(socket, ++socketSequence);
      event.socketId = socketIds.get(socket);
      event.reusedSocket = req.reusedSocket;
      const capture = () => { event.localPort = socket.localPort; event.remotePort = socket.remotePort; };
      if (socket.connecting) socket.once("connect", capture); else capture();
    });
    req.setTimeout(15_000, () => req.destroy(new Error("diagnostic timeout")));
    req.on("error", (error) => { event.networkError = error.code ?? error.name; done({ event }); });
    if (oversized) {
      for (let offset = 0; offset < payload.length; offset += 64 * 1024) req.write(payload.slice(offset, offset + 64 * 1024));
      req.end();
    } else req.end(payload);
  });
}

if (process.argv[2] === "--separate-client") {
  const [origin, label, path, paperId] = process.argv.slice(3);
  const result = await send(origin, { label, path, method: "POST", paper: fixture(paperId) });
  console.log(JSON.stringify(result));
  process.exit(result.event.status === undefined ? 1 : 0);
}

const runId = randomUUID();
const directory = resolve(root, ".wrangler/transport-investigation", runId);
const temporary = resolve(directory, "temporary");
const wrangler = resolve(root, "node_modules/wrangler/bin/wrangler.js");
const children = new Set();
const evidence = { runId, startedAt: new Date().toISOString(), versions: { node: process.version, bundledUndici: process.versions.undici, client: "node:http native Agent (no retries)" }, cases: [], logs: [], requests: wireEvents };
let failure = false;

function log(record) { console.log(JSON.stringify(record)); }
function launch(args, options = {}) {
  const child = spawn(process.execPath, args, { cwd: temporary, windowsHide: true,
    detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: resolve(temporary, "runtime-logs") }, ...options });
  child.done = new Promise((done) => { child.once("error", (error) => { child.launchError = error; done(); }); child.once("close", done); });
  child.pendingText = "";
  const capture = (chunk) => {
    child.pendingText += chunk.toString();
    const lines = child.pendingText.split(/\r?\n/u);
    child.pendingText = lines.pop();
    for (const raw of lines) {
      const line = raw.replace(/\x1b\[[0-9;]*m/gu, "");
      const marker = line.indexOf("TRANSPORT_EVENT ");
      if (marker !== -1) {
        try { evidence.logs.push({ pid: child.pid, handler: JSON.parse(line.slice(marker + 16)) }); } catch { /* Never copy arbitrary logs. */ }
      } else if (line.includes("recovered on attempt")) {
        const match = /(GET|HEAD).*recovered on attempt (\d+)/u.exec(line);
        evidence.logs.push({ pid: child.pid, proxy: "internal-retry-recovered", method: match?.[1], attempt: match?.[2] });
      } else if (line.includes("Network connection lost")) evidence.logs.push({ pid: child.pid, proxy: "Network connection lost" });
    }
  };
  child.stdout.on("data", capture); child.stderr.on("data", capture);
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
        try { process.kill(child.pid, 0); throw new Error(`Owned process ${child.pid} still alive`); }
        catch (error) { if (error.code !== "ESRCH") throw error; }
      }
    } else process.kill(-child.pid, "SIGTERM");
    await Promise.race([child.done, delay(10_000, undefined, { ref: false }).then(() => { throw new Error("Owned process stop timed out"); })]);
  }
  children.delete(child);
  log({ stoppedOwnedPid: child.pid });
}

async function port() {
  const server = createServer();
  await new Promise((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", done); });
  const value = server.address().port;
  await new Promise((done, fail) => server.close((error) => error ? fail(error) : done()));
  return value;
}

async function start(kind) {
  const area = resolve(temporary, kind);
  await mkdir(area, { recursive: true });
  const source = kind === "application" ? "src/worker/index.ts" : "scripts/fixtures/transport-worker.mjs";
  const importPath = resolve(root, source).replaceAll("\\", "/");
  // Generated observer is local to this run. It logs only fixed trace labels,
  // methods, paths and statuses, not headers/bodies/environment/binding values.
  await writeFile(resolve(area, "observer.mjs"), `import target from ${JSON.stringify(importPath)};
const seen = [];
const event = (value) => { seen.push(value); console.log("TRANSPORT_EVENT " + JSON.stringify(value)); };
export default { async fetch(request, env, ctx) {
  const path = new URL(request.url).pathname;
  if (path === "/__transport/seen") return Response.json(seen);
  const trace = request.headers.get("x-transport-trace") ?? "readiness";
  event({ trace, phase: "enter", method: request.method, path });
  try {
    const response = await target.fetch(request, env, ctx);
    event({ trace, phase: "exit", status: response.status });
    const headers = new Headers(response.headers); headers.set("x-transport-handler", trace);
    return new Response(response.body, { status: response.status, headers });
  } catch (error) { event({ trace, phase: "throw", name: error.name }); throw error; }
} };
`);
  const config = { name: `transport-${kind}`, main: "observer.mjs", compatibility_date: "2025-09-01" };
  if (kind === "application") config.d1_databases = [{ binding: "DB", database_name: "transport-isolated", database_id: "transport-isolated", migrations_dir: resolve(root, "drizzle"), remote: false }];
  const configPath = resolve(area, "wrangler.json");
  const state = resolve(area, "state");
  await writeFile(configPath, JSON.stringify(config, null, 2));
  if (kind === "application") {
    const migration = launch([wrangler, "d1", "migrations", "apply", "DB", "--config", configPath, "--local", "--persist-to", state]);
    migration.stdin.end();
    await Promise.race([migration.done, delay(45_000, undefined, { ref: false }).then(() => { throw new Error("Isolated migration timeout"); })]);
    assert.equal(migration.exitCode, 0, "Isolated migration failed; raw configuration not logged");
    children.delete(migration);
  }
  const origin = `http://127.0.0.1:${await port()}`;
  const child = launch([wrangler, "dev", "--config", configPath, "--local", "--persist-to", state,
    "--ip", "127.0.0.1", "--port", new URL(origin).port, "--inspector-port", "0", "--show-interactive-dev-session=false"]);
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, "Owned Wrangler exited before readiness");
    const ready = await send(origin, { label: "readiness", path: "/api/health" });
    if (ready.event.status === 200) return { kind, child, origin };
    await delay(150);
  }
  throw new Error("Local Worker readiness timeout");
}

async function request(server, options) {
  const result = await send(server.origin, options);
  wireEvents.push({ server: server.kind, ...result.event });
  return result;
}

async function separate(server, options) {
  const child = launch([resolve(root, "scripts/transport-investigation.mjs"), "--separate-client", server.origin, options.label, options.path, options.paper.id]);
  let text = "";
  child.stdout.on("data", (chunk) => { text += chunk.toString(); });
  await Promise.race([child.done, delay(20_000, undefined, { ref: false }).then(() => { throw new Error("Separate client timeout"); })]);
  children.delete(child);
  const result = JSON.parse(text);
  wireEvents.push({ server: server.kind, ...result.event });
  return result;
}

async function runCase(server, connection, first = "POST", mode = "cancel") {
  const caseId = `${server.kind}-${connection}-${first}-${mode}-${++sequence}`;
  const path = server.kind === "application" ? "/api/library/papers" : `/body?mode=${mode}`;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
  const result = { caseId, workerPid: server.child.pid, connection, first, mode };
  const logStart = evidence.logs.length;
  evidence.cases.push(result);
  try {
    const before = await request(server, { label: `${caseId}-before`, path, agent });
    assert.equal(before.event.status, 200);
    const beforeRows = before.json?.papers ?? [];
    const overId = `2501.${String(sequence * 10).padStart(5, "0")}`;
    const valid = fixture(`2501.${String(sequence * 10 + 1).padStart(5, "0")}`);
    const oversized = await request(server, { label: `${caseId}-oversized`, path, method: "POST", agent, paper: fixture(overId), oversized: true });
    result.rejectionStatus = oversized.event.status;
    assert.equal(oversized.event.status, 413);
    const next = { label: `${caseId}-immediate`, path: first === "health" ? "/api/health" : path,
      method: first === "POST" ? "POST" : "GET", agent: connection === "reuse" ? agent : false,
      paper: first === "POST" ? valid : undefined };
    const immediate = connection === "separate" ? await separate(server, next) : await request(server, next);
    result.immediateStatus = immediate.event.status ?? null;
    result.sameClientSocket = immediate.event.clientPid === oversized.event.clientPid && immediate.event.socketId === oversized.event.socketId;
    result.immediateHandlerMarker = immediate.event.handlerMarker;
    result.oversizedClient = { pid: oversized.event.clientPid, socket: oversized.event.socketId, port: oversized.event.localPort };
    result.immediateClient = { pid: immediate.event.clientPid, socket: immediate.event.socketId, port: immediate.event.localPort };
    if (connection === "reuse") assert.equal(result.sameClientSocket, true, "Reused-client comparison did not actually reuse its socket");
    else assert.equal(result.sameClientSocket, false, "Fresh-client comparison reused a socket");
    if (connection !== "reuse") assert.notEqual(immediate.event.localPort, oversized.event.localPort);
    const expectedStatus = first === "POST" && server.kind === "application" ? 201 : 200;
    if (immediate.event.status !== expectedStatus) failure = true;

    // A failing first request is retained above. These are distinct inspection
    // operations and a NEW fixture save, never retries of the failed request.
    const after = await request(server, { label: `${caseId}-after`, path });
    assert.equal(after.event.status, 200);
    if (server.kind === "application") {
      assert.equal(after.json.papers.some((paper) => paper.arxivId === overId), false);
      assert.equal(after.json.papers.length, beforeRows.length + (immediate.event.status === 201 ? 1 : 0));
      for (const row of beforeRows) assert.deepEqual(after.json.papers.find((paper) => paper.id === row.id), row);
      result.beforeRows = beforeRows.length;
      result.afterRows = after.json.papers.length;
      result.oversizedDidNotWrite = true;
      result.immediateDidWrite = after.json.papers.some((paper) => paper.arxivId === valid.id);
    }
    const health = await request(server, { label: `${caseId}-health`, path: "/api/health" });
    assert.equal(health.event.status, 200);
    const distinct = fixture(`2501.${String(sequence * 10 + 2).padStart(5, "0")}`);
    const saved = await request(server, { label: `${caseId}-distinct-valid`, path, method: "POST", paper: distinct });
    assert.equal(saved.event.status, server.kind === "application" ? 201 : 200);
    const final = await request(server, { label: `${caseId}-final`, path });
    assert.equal(final.event.status, 200);
    if (server.kind === "application") {
      const { id: arxivId, ...metadata } = distinct;
      assert.deepEqual(saved.json.paper, { ...metadata, arxivId, source: "arxiv", id: saved.json.paper.id, savedAt: saved.json.paper.savedAt });
      assert.deepEqual(final.json.papers.find((paper) => paper.arxivId === distinct.id), saved.json.paper);
      assert.equal(final.json.papers.length, after.json.papers.length + 1);
      result.finalRows = final.json.papers.length;
    }
    result.healthyWithoutRestart = true;
    const observed = await send(server.origin, { label: "observer-read", path: "/__transport/seen" });
    const trace = observed.json.filter((event) => event.trace.startsWith(caseId));
    result.handlerTrace = trace;
    assert.ok(trace.some((event) => event.trace === `${caseId}-before` && event.phase === "enter"));
    assert.ok(trace.some((event) => event.trace === `${caseId}-oversized` && event.phase === "exit" && event.status === 413));
    result.immediateReachedHandler = trace.some((event) => event.trace === next.label && event.phase === "enter");
    result.proxyEvents = evidence.logs.slice(logStart).filter((event) => event.proxy);
    const { handlerTrace: _trace, ...summary } = result;
    log({ caseResult: summary });
  } finally { agent.destroy(); }
}

try {
  await mkdir(temporary, { recursive: true });
  for (const name of ["wrangler", "miniflare", "workerd", "undici"]) evidence.versions[name] = JSON.parse(await readFile(resolve(root, `node_modules/${name}/package.json`), "utf8")).version;
  const application = await start("application");
  for (const connection of ["reuse", "fresh", "separate"]) await runCase(application, connection);
  for (const first of ["GET", "health"]) await runCase(application, "reuse", first);
  await stop(application.child);
  const minimal = await start("minimal");
  for (const connection of ["reuse", "fresh", "separate"]) await runCase(minimal, connection);
  for (const first of ["GET", "health"]) await runCase(minimal, "reuse", first);
  // Single-variable comparison: release without cancel; still byte/time bounded.
  for (const connection of ["reuse", "fresh"]) await runCase(minimal, connection, "POST", "release");
  evidence.result = failure ? "transport_failure_reproduced" : "passed";
  evidence.firstTransportFailure = wireEvents.find((event) => event.errorKind === "proxy_network_connection_lost" || event.networkError) ?? null;
  if (failure) process.exitCode = 1;
} catch (error) {
  evidence.result = "diagnostic_failed";
  evidence.error = String(error.stack ?? error);
  console.error(evidence.error);
  process.exitCode = 1;
} finally {
  for (const child of [...children]) {
    try { await stop(child); } catch (error) { evidence.cleanupError = String(error); process.exitCode = 1; }
  }
  // Only this run's generated tree is removable. Keep sanitized result.json;
  // raw Wrangler logs and temporary bindings/state never enter the repository.
  try {
    if (children.size === 0) {
      const actual = await realpath(temporary);
      const owner = await realpath(directory);
      assert.equal(dirname(actual), owner);
      assert.equal(actual, resolve(owner, "temporary"));
      assert.ok(owner.startsWith(resolve(root, ".wrangler/transport-investigation") + sep));
      await rm(actual, { recursive: true, force: false, maxRetries: 8, retryDelay: 250 });
      evidence.ownedTemporaryStateRemoved = true;
    }
  } catch (error) { evidence.cleanupError = String(error); process.exitCode = 1; }
  evidence.finishedAt = new Date().toISOString();
  await writeFile(resolve(directory, "result.json"), JSON.stringify(evidence, null, 2) + "\n");
  log({ result: evidence.result, evidence: resolve(directory, "result.json") });
}
