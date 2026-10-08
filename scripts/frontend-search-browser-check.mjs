import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = resolve(root, "node_modules/wrangler/bin/wrangler.js");
const vite = resolve(root, "node_modules/vite/bin/vite.js");
const state = resolve(root, ".wrangler/frontend-search-browser-check", randomUUID());
const browserCandidates = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];
const browserPath = browserCandidates.find(existsSync);
const skipLiveSearch = process.env.PAPERS_UI_CHECK_SKIP_LIVE === "true";
const children = new Set();
let worker;
let frontend;
let browser;

const fixtureResponse = {
  provider: "arxiv",
  query: "machine learning",
  papers: [
    {
      id: "2401.01234",
      title: "A fixture paper for the browser check",
      authors: ["Ada Author", "Bea Researcher"],
      year: 2024,
      abstract: "This complete fixture abstract is deliberately long enough to verify that the UI renders all of its text without truncation.",
      url: "https://arxiv.org/abs/2401.01234v2",
      pdfUrl: "https://arxiv.org/pdf/2401.01234v2.pdf",
    },
    {
      id: "cond-mat/0011267",
      title: "A fixture paper without a link",
      authors: [],
      year: null,
      abstract: "A second complete abstract verifies missing-metadata fallbacks.",
      url: null,
      pdfUrl: null,
    },
  ],
};

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
  const child = spawn(entry, args, {
    cwd: root,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", ...extraEnv },
  });
  child.log = "";
  child.done = new Promise((resolveDone) => {
    child.once("error", (error) => { child.launchError = error; resolveDone(); });
    child.once("close", () => resolveDone());
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
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "pipe" });
    const killCode = await new Promise((resolveKill, reject) => {
      killer.once("error", reject);
      killer.once("exit", resolveKill);
    });
    // taskkill can report 128/255 if an owned process exits between the status
    // check and the command. Verify the PID before calling that cleanup a failure.
    if (killCode !== 0 && child.exitCode === null && child.signalCode === null) {
      await delay(100);
      let stillRunning = true;
      try { process.kill(child.pid, 0); } catch { stillRunning = false; }
      if (stillRunning) throw new Error(`taskkill exited ${killCode}`);
    }
    await Promise.race([
      child.done,
      delay(10_000, undefined, { ref: false }).then(() => { throw new Error(`PID ${child.pid} did not stop`); }),
    ]);
  }
  children.delete(child);
}

async function waitForServer(child, url) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.launchError || child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Server exited before becoming ready.\n${child.log}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
      if (response.ok) return;
    } catch { /* The server may still be starting. */ }
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${url}.\n${child.log}`);
}

async function migrate() {
  const child = launch(process.execPath, [wrangler, "d1", "migrations", "apply", "DB", "--config", "wrangler.jsonc", "--local", "--persist-to", state]);
  child.stdin.end();
  await Promise.race([
    child.done,
    delay(45_000, undefined, { ref: false }).then(() => { throw new Error("Local migration timed out"); }),
  ]);
  if (child.launchError || child.exitCode !== 0) throw new Error(child.log || String(child.launchError));
  children.delete(child);
}

class CdpConnection {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async connect() {
    await new Promise((resolveOpen, rejectOpen) => {
      this.socket.addEventListener("open", resolveOpen, { once: true });
      this.socket.addEventListener("error", rejectOpen, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params, message.sessionId);
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolveCommand, rejectCommand) => this.pending.set(id, { resolve: resolveCommand, reject: rejectCommand }));
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  close() {
    this.socket.close();
  }
}

async function browserDebuggerUrl(port) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      const body = await response.json();
      if (typeof body.webSocketDebuggerUrl === "string") return body.webSocketDebuggerUrl;
    } catch { /* Chrome may still be starting. */ }
    await delay(150);
  }
  throw new Error("Timed out waiting for the browser debugging endpoint.");
}

async function main() {
  assert.ok(browserPath, "A supported local Chrome or Edge executable is required for this browser check.");
  await mkdir(state, { recursive: true });
  const workerPort = await availablePort();
  const vitePort = await availablePort();
  const debuggerPort = await availablePort();
  const workerOrigin = `http://127.0.0.1:${workerPort}`;
  const viteOrigin = `http://127.0.0.1:${vitePort}`;

  await migrate();
  worker = launch(process.execPath, [wrangler, "dev", "--config", "wrangler.jsonc", "--local", "--persist-to", state,
    "--ip", "127.0.0.1", "--port", String(workerPort), "--inspector-port", "0", "--show-interactive-dev-session=false"]);
  await waitForServer(worker, `${workerOrigin}/api/health`);
  frontend = launch(process.execPath, [vite, "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], {
    LOCAL_WORKER_ORIGIN: workerOrigin,
  });
  await waitForServer(frontend, viteOrigin);

  browser = launch(browserPath, ["--headless=new", `--remote-debugging-port=${debuggerPort}`, "--remote-allow-origins=*",
    `--user-data-dir=${resolve(state, "browser-profile")}`, "--no-first-run", "--no-default-browser-check", "about:blank"]);
  const cdp = new CdpConnection(await browserDebuggerUrl(debuggerPort));
  await cdp.connect();
  const target = await cdp.send("Target.createTarget", { url: "about:blank" });
  const attached = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  const sessionId = attached.sessionId;
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/papers/search*" }] }, sessionId);

  const pausedRequests = [];
  cdp.on("Fetch.requestPaused", (params, eventSessionId) => {
    if (eventSessionId === sessionId) pausedRequests.push(params);
  });

  const evaluate = async (expression) => {
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  const waitFor = async (expression, description) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await delay(50);
    }
    throw new Error(`Timed out waiting for ${description}.`);
  };
  const nextPaused = async () => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const request = pausedRequests.shift();
      if (request) return request;
      await delay(25);
    }
    throw new Error("Timed out waiting for a paper-search request.");
  };
  const fillInput = async (value) => evaluate(`(() => {
    const input = document.querySelector('#paper-search-query');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    return input.value;
  })()`);
  const pressEnter = async () => {
    await cdp.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    }, sessionId);
    await cdp.send("Input.dispatchKeyEvent", { type: "char", text: "\r", unmodifiedText: "\r" }, sessionId);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, sessionId);
  };
  const fulfillJson = (request, status, body) => cdp.send("Fetch.fulfillRequest", {
    requestId: request.requestId,
    responseCode: status,
    responseHeaders: [{ name: "content-type", value: "application/json; charset=utf-8" }],
    body: Buffer.from(JSON.stringify(body)).toString("base64"),
  }, sessionId);

  await cdp.send("Page.navigate", { url: viteOrigin }, sessionId);
  await waitFor("document.querySelector('#paper-search-query') && document.body.innerText.includes('Search only runs when you submit')", "the initial search UI");
  await waitFor("document.body.innerText.includes('Backend connected') && document.body.innerText.includes('D1 connected') && document.body.innerText.includes('R2 connected')", "the existing connection indicators");
  assert.equal(pausedRequests.length, 0, "page load must not start a paper search");

  await fillInput("machine learning");
  assert.equal(pausedRequests.length, 0, "typing must not start a paper search");
  await pressEnter();
  const firstRequest = await nextPaused();
  assert.match(firstRequest.request.url, /[?&]q=machine(?:%20|\+)learning/u);
  await waitFor("document.body.innerText.includes('Searching arXiv for') && document.querySelector('button[type=submit]').disabled", "the loading state");
  await pressEnter();
  await delay(100);
  assert.equal(pausedRequests.length, 0, "duplicate keyboard submission must not create another request while pending");
  await fillInput("a later edit");
  await fulfillJson(firstRequest, 200, fixtureResponse);
  await waitFor("document.querySelectorAll('.paper-card').length === 2", "fixture results");
  const resultDetails = await evaluate(`JSON.stringify({
    text: document.body.innerText,
    heading: document.querySelector('#search-results-title').textContent,
    provider: document.querySelector('.provider').textContent,
    link: document.querySelector('.paper-link')?.href,
    target: document.querySelector('.paper-link')?.target,
    rel: document.querySelector('.paper-link')?.rel
  })`);
  const rendered = JSON.parse(resultDetails);
  for (const value of [fixtureResponse.papers[0].title, "Ada Author, Bea Researcher", "2024", fixtureResponse.papers[0].abstract, "Paper link unavailable"]) {
    assert.ok(rendered.text.includes(value), `Expected rendered result text: ${value}`);
  }
  assert.match(rendered.heading, /machine learning/u, "results must remain associated with the submitted query");
  assert.equal(rendered.provider, "Provider: arxiv");
  assert.equal(rendered.link, fixtureResponse.papers[0].url);
  assert.equal(rendered.target, "_blank");
  assert.match(rendered.rel, /noopener/u);
  const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, sessionId);
  const screenshotPath = resolve(state, "fixture-results.png");
  await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 1, mobile: true }, sessionId);
  await delay(50);
  const mobileMetrics = JSON.parse(await evaluate("JSON.stringify({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth })"));
  assert.ok(mobileMetrics.scrollWidth <= mobileMetrics.width, "the narrow layout must not require horizontal scrolling");
  const mobileScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, sessionId);
  const mobileScreenshotPath = resolve(state, "fixture-results-mobile.png");
  await writeFile(mobileScreenshotPath, Buffer.from(mobileScreenshot.data, "base64"));

  await fillInput("no results topic");
  await pressEnter();
  await fulfillJson(await nextPaused(), 200, { provider: "arxiv", query: "no results topic", papers: [] });
  await waitFor("document.body.innerText.includes('No papers found for')", "the no-results state");

  await fillInput("upstream failure");
  await pressEnter();
  await fulfillJson(await nextPaused(), 502, { error: { kind: "upstream", message: "arXiv could not provide a valid paper search response." } });
  await waitFor("document.querySelector('[role=alert]')?.textContent.includes('arXiv could not provide')", "a sanitized API error");

  await fillInput("unexpected response");
  await pressEnter();
  await fulfillJson(await nextPaused(), 200, { unexpected: true });
  await waitFor("document.querySelector('[role=alert]')?.textContent.includes('unexpected response')", "an unexpected JSON error");

  await fillInput("network failure");
  await pressEnter();
  await cdp.send("Fetch.failRequest", { requestId: (await nextPaused()).requestId, errorReason: "Failed" }, sessionId);
  await waitFor("Boolean(document.querySelector('[role=alert]'))", "a network error");

  const requestsBeforeBlank = pausedRequests.length;
  await fillInput("   ");
  await pressEnter();
  await waitFor("document.querySelector('[role=alert]')?.textContent.includes('Enter a research topic')", "blank-input validation");
  assert.equal(pausedRequests.length, requestsBeforeBlank, "blank input must not make a request");

  await evaluate(`(() => {
    window.__phaseOneOriginalSetTimeout = window.setTimeout;
    window.setTimeout = (callback, milliseconds, ...args) => window.__phaseOneOriginalSetTimeout(callback, milliseconds === 20000 ? 25 : milliseconds, ...args);
  })()`);
  await fillInput("timeout fixture");
  await pressEnter();
  const timeoutRequest = await nextPaused();
  await waitFor("document.querySelector('[role=alert]')?.textContent.includes('took too long')", "the browser timeout state");
  await cdp.send("Fetch.failRequest", { requestId: timeoutRequest.requestId, errorReason: "Aborted" }, sessionId).catch(() => undefined);
  await evaluate("window.setTimeout = window.__phaseOneOriginalSetTimeout");

  let liveSearch = "not_invoked";
  if (!skipLiveSearch) {
    await cdp.send("Fetch.disable", {}, sessionId);
    await fillInput("graph neural networks");
    await pressEnter();
    await waitFor("document.querySelectorAll('.paper-card').length > 0 && document.querySelector('.provider')?.textContent === 'Provider: arxiv'", "one live search through the Vite proxy");
    liveSearch = "passed";
  }
  console.log(JSON.stringify({
    result: "passed",
    browser: browserPath,
    viteOrigin,
    workerOrigin,
    mockSearchStates: ["loading", "results", "no-results", "API error", "unexpected JSON", "network error", "blank input", "timeout"],
    liveSearch,
    screenshotPath,
    mobileScreenshotPath,
    state,
  }));
  cdp.close();
}

try {
  await main();
} finally {
  for (const child of [...children]) {
    try { await stop(child); }
    catch (error) { console.error(`Process cleanup failed for owned PID ${child.pid}: ${error}`); process.exitCode = 1; }
  }
}
