import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createMetadataPdfFixture, createSummaryPdfFixture } from "./fixtures/pdf-fixtures.mjs";

const root = resolve(import.meta.dirname, "..");
const wrangler = resolve(root, "node_modules/wrangler/bin/wrangler.js");
const vite = resolve(root, "node_modules/vite/bin/vite.js");
const state = resolve(root, ".wrangler/frontend-search-browser-check", randomUUID());
const browserCandidates = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];
const browserPath = browserCandidates.find(existsSync);
const children = new Set();
const evidence = { startedAt: new Date().toISOString(), state, steps: [], result: "running" };
const documentFixture = createMetadataPdfFixture();
const summaryFixture = createSummaryPdfFixture();
let worker;
let frontend;
let browser;
let metadataProvider;
let metadataProviderOrigin;
let metadataProviderCalls = 0;
let metadataProviderMode = "success";
let summaryProviderCalls = 0;
let summaryProviderMode = "success";

const existingPaper = {
  id: "11111111-1111-4111-8111-111111111111",
  source: "arxiv",
  arxivId: "2401.01234",
  title: "Original saved metadata",
  authors: ["Original Author"],
  year: 2023,
  abstract: "The original saved abstract stays authoritative for duplicate responses.",
  url: "https://arxiv.org/abs/2401.01234v1",
  pdfUrl: "https://arxiv.org/pdf/2401.01234v1.pdf",
  savedAt: "2025-01-02T03:04:05.000Z",
};
const newlySavedPaper = {
  id: "22222222-2222-4222-8222-222222222222",
  source: "arxiv",
  arxivId: "2401.01235",
  title: "Newly saved fixture paper",
  authors: ["Ada Author", "Bea Researcher"],
  year: 2024,
  abstract: "This complete fixture abstract is deliberately long enough to verify complete browser rendering, save feedback, and Library persistence.",
  url: "https://arxiv.org/abs/2401.01235v2",
  pdfUrl: "https://arxiv.org/pdf/2401.01235v2.pdf",
  savedAt: "2026-02-03T04:05:06.000Z",
};
const duplicatePaper = {
  ...existingPaper,
  id: "33333333-3333-4333-8333-333333333333",
  arxivId: "2401.01236",
  title: "Original duplicate record",
  savedAt: "2025-02-03T04:05:06.000Z",
};
const actualSearchPaper = {
  id: "2401.01239",
  title: "Actual browser proxy fixture",
  authors: ["Browser Fixture Author", "Second Author"],
  year: 2024,
  abstract: "An offline fixture is saved through the real browser, relative Vite proxy, local Worker, and isolated D1 database.",
  url: "https://arxiv.org/abs/2401.01239v3",
  pdfUrl: "https://arxiv.org/pdf/2401.01239v3.pdf",
};
const mockDocumentOne = { id: "44444444-4444-4444-8444-444444444444", filename: "unknown-metadata.pdf", byteCount: 512, sha256: "a".repeat(64), uploadedAt: "2026-01-02T03:04:05.000Z", status: "stored" };
const mockDocumentTwo = { id: "55555555-5555-4555-8555-555555555555", filename: "resume-fixture.pdf", byteCount: 768, sha256: "b".repeat(64), uploadedAt: "2026-01-03T03:04:05.000Z", status: "stored" };
const mockExtraction = (documentId, title = "Mock extracted page") => ({ documentId, sourceSha256: "a".repeat(64), parser: "unpdf", parserVersion: "unpdf@1.8.1", extractedAt: "2026-01-02T03:04:05.000Z", pageCount: 1, pages: [{ pageNumber: 1, text: title }] });
const unknownMetadata = (documentId) => ({
  documentId, sourceSha256: "a".repeat(64), extractionParser: "unpdf", extractionParserVersion: "unpdf@1.8.1", extractionExtractedAt: "2026-01-02T03:04:05.000Z",
  selectedPageNumbers: [1], sourceExcerptByteCount: 18, sourceExcerptClipped: false, model: "local-mock", promptVersion: "document-metadata-v1", generatedAt: "2026-01-02T03:04:06.000Z",
  title: null, authors: null, year: null, abstract: null,
  evidence: { title: [], authors: [], year: [], abstract: [] }, warnings: ["title is unknown in the selected source."],
});
const partialSummary = (documentId) => ({
  documentId, sourceSha256: "a".repeat(64), extractionParser: "unpdf", extractionParserVersion: "unpdf@1.8.1", extractionExtractedAt: "2026-01-02T03:04:05.000Z",
  totalPageCount: 5, includedPageNumbers: [1, 2, 3], includedPageRanges: [{ startPage: 1, endPage: 3 }], sourceExcerptByteCount: 98_304,
  sourceExcerptTruncated: true, sourceCoverageWarning: "Partial source coverage: pages 1-3 of 5 were included within the 98304-byte budget.",
  model: "local-summary-mock", promptVersion: "document-summary-v1", schemaVersion: "document-summary-schema-v1", createdAt: "2026-01-02T03:04:07.000Z",
  overview: { text: "The partial fixture is summarized from selected persisted pages only.", evidence: [{ pageNumber: 1, quote: "Current selected PDF text" }] },
  contributions: [{ text: "It labels the limited source coverage.", evidence: [{ pageNumber: 2, quote: "Current selected PDF text" }] }],
  methods: [], findings: [], limitations: [],
  warnings: ["methods are unavailable in the selected source.", "findings are unavailable in the selected source.", "limitations are unavailable in the selected source.", "Partial source coverage: pages 1-3 of 5 were included within the 98304-byte budget."],
});

function record(step, details = {}) {
  evidence.steps.push({ step, ...details });
  console.log(JSON.stringify({ step, ...details }));
}

function metadataProviderOutput() {
  const expected = documentFixture.expected;
  return {
    title: expected.title,
    authors: expected.authors,
    year: expected.year,
    abstract: expected.abstract,
    evidence: {
      title: [{ pageNumber: 1, quote: expected.title }],
      authors: [{ pageNumber: 1, quote: "Avery Example; Bao Example" }],
      year: [{ pageNumber: 1, quote: "Published: 2024" }],
      abstract: [{ pageNumber: 1, quote: `Abstract: ${expected.abstract}` }],
    },
    warnings: [],
  };
}

function summaryProviderOutput() {
  const expected = summaryFixture.expected;
  return {
    overview: {
      text: "The fixture evaluates an ordered approach to source-grounded research-paper summaries.",
      evidence: [{ pageNumber: 1, quote: expected.overviewQuote }],
    },
    contributions: [{
      text: "It separates persisted source selection from summary generation.",
      evidence: [{ pageNumber: 2, quote: expected.contributionQuote }],
    }],
    methods: [{
      text: "Its method keeps ordered page text with page-numbered evidence.",
      evidence: [{ pageNumber: 3, quote: expected.methodQuote }],
    }],
    findings: [{
      text: "Later-page findings can remain represented in the resulting summary.",
      evidence: [{ pageNumber: 4, quote: expected.findingQuote }],
    }],
    limitations: [{
      text: "Supporting quotes do not establish every implication of a paraphrase.",
      evidence: [{ pageNumber: 4, quote: expected.limitationQuote }],
    }],
    warnings: [],
  };
}

async function startMetadataProvider() {
  metadataProvider = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = undefined; }
    const isSummary = body?.text?.format?.name === "document_summary";
    const expectedAuthorization = isSummary ? "Bearer local-summary-test-key" : "Bearer local-metadata-test-key";
    if (request.method !== "POST" || request.url !== "/v1/responses" || request.headers.authorization !== expectedAuthorization) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "unexpected local provider request" } }));
      return;
    }
    if (isSummary) {
      summaryProviderCalls += 1;
      if (summaryProviderMode === "failure") {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "local summary provider failure" } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(summaryProviderOutput()) }] }] }));
      return;
    }
    metadataProviderCalls += 1;
    if (metadataProviderMode === "failure") {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "local metadata provider failure" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(metadataProviderOutput()) }] }],
    }));
  });
  await new Promise((resolveStarted, rejectStarted) => {
    metadataProvider.once("error", rejectStarted);
    metadataProvider.listen(0, "127.0.0.1", resolveStarted);
  });
  const address = metadataProvider.address();
  assert.ok(address && typeof address !== "string", "Local metadata provider did not bind a TCP port.");
  metadataProviderOrigin = `http://127.0.0.1:${address.port}/v1/responses`;
}

async function stopMetadataProvider() {
  if (!metadataProvider) return;
  await new Promise((resolveStopped, rejectStopped) => metadataProvider.close((error) => error ? rejectStopped(error) : resolveStopped()));
  metadataProvider = undefined;
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
  const child = spawn(entry, args, {
    cwd: root,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", ...extraEnv },
  });
  child.done = new Promise((resolveDone) => {
    child.once("error", (error) => { child.launchError = error; resolveDone(); });
    child.once("close", resolveDone);
  });
  children.add(child);
  return child;
}

async function stop(child) {
  if (!child || !children.has(child)) return;
  if (child.exitCode === null && child.signalCode === null && !child.launchError) {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    const killCode = await new Promise((resolveKill, reject) => { killer.once("error", reject); killer.once("exit", resolveKill); });
    if (killCode !== 0 && child.exitCode === null && child.signalCode === null) {
      let running = true;
      try { process.kill(child.pid, 0); } catch (error) { if (error.code === "ESRCH") running = false; else throw error; }
      if (running) throw new Error(`Could not stop owned process ${child.pid} (taskkill ${killCode}).`);
    }
    await Promise.race([child.done, delay(10_000, undefined, { ref: false }).then(() => { throw new Error(`Owned process ${child.pid} did not stop.`); })]);
  }
  children.delete(child);
  record("stopped-owned-process", { pid: child.pid });
}

async function waitForServer(child, url) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.launchError || child.exitCode !== null || child.signalCode !== null) throw new Error("An owned local server exited before readiness.");
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1_500) })).ok) return;
    } catch { /* The owned server may still be starting. */ }
    await delay(150);
  }
  throw new Error(`Timed out waiting for ${url}.`);
}

async function migrate() {
  const child = launch(process.execPath, [wrangler, "d1", "migrations", "apply", "DB", "--config", "wrangler.jsonc", "--local", "--persist-to", state]);
  child.stdin.end();
  await Promise.race([child.done, delay(45_000, undefined, { ref: false }).then(() => { throw new Error("Isolated local migration timed out."); })]);
  assert.equal(child.exitCode, 0, "Isolated local migration failed.");
  children.delete(child);
  record("migration-applied", { exitCode: child.exitCode });
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
    } catch { /* The owned browser may still be starting. */ }
    await delay(150);
  }
  throw new Error("Timed out waiting for the browser debugging endpoint.");
}

async function main() {
  try {
  assert.ok(browserPath, "A supported local Chrome or Edge executable is required for this browser check.");
  await mkdir(state, { recursive: true });
  const workerPort = await availablePort();
  const vitePort = await availablePort();
  const debuggerPort = await availablePort();
  const workerOrigin = `http://127.0.0.1:${workerPort}`;
  const viteOrigin = `http://127.0.0.1:${vitePort}`;

  await startMetadataProvider();
  await migrate();
  worker = launch(process.execPath, [wrangler, "dev", "--config", "wrangler.jsonc", "--local", "--persist-to", state,
    "--var", "OPENAI_API_KEY:offline-metadata-test-key", "--var", `LOCAL_METADATA_PROVIDER_URL:${metadataProviderOrigin}`, "--var", `LOCAL_SUMMARY_PROVIDER_URL:${metadataProviderOrigin}`,
    "--ip", "127.0.0.1", "--port", String(workerPort), "--inspector-port", "0", "--show-interactive-dev-session=false"]);
  await waitForServer(worker, `${workerOrigin}/api/health`);
  frontend = launch(process.execPath, [vite, "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], { LOCAL_WORKER_ORIGIN: workerOrigin });
  await waitForServer(frontend, viteOrigin);
  record("local-worker-and-vite-started", { workerPid: worker.pid, frontendPid: frontend.pid, workerOrigin, viteOrigin });

  browser = launch(browserPath, ["--headless=new", `--remote-debugging-port=${debuggerPort}`, "--remote-allow-origins=*",
    `--user-data-dir=${resolve(state, "browser-profile")}`, "--no-first-run", "--no-default-browser-check", "about:blank"]);
  const cdp = new CdpConnection(await browserDebuggerUrl(debuggerPort));
  await cdp.connect();
  const target = await cdp.send("Target.createTarget", { url: "about:blank" });
  const attached = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  const sessionId = attached.sessionId;
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  const paused = [];
  const allPaused = [];
  cdp.on("Fetch.requestPaused", (params, eventSessionId) => {
    if (eventSessionId !== sessionId) return;
    paused.push(params);
    allPaused.push({ method: params.request.method, url: params.request.url, postData: params.request.postData });
  });

  const evaluate = async (expression) => {
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  const waitFor = async (expression, description) => {
    // Vite can need more than the former 12 seconds when rebuilding after this
    // browser has exercised a large intercepted mock sequence. This remains a
    // bounded readiness wait, not a request retry.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await evaluate(`Boolean(${expression})`)) return;
      await delay(40);
    }
    throw new Error(`Timed out waiting for ${description}.`);
  };
  const click = (selector) => evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!(element instanceof HTMLElement)) return false; element.click(); return true; })()`);
  const fillInput = (value) => evaluate(`(() => {
    const input = document.querySelector('#paper-search-query');
    if (!(input instanceof HTMLInputElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    return true;
  })()`);
  const pressEnter = async () => {
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, sessionId);
    await cdp.send("Input.dispatchKeyEvent", { type: "char", text: "\r", unmodifiedText: "\r" }, sessionId);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, sessionId);
  };
  const nextPaused = async (predicate, description) => {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const index = paused.findIndex(predicate);
      if (index !== -1) return paused.splice(index, 1)[0];
      await delay(25);
    }
    throw new Error(`Timed out waiting for ${description}.`);
  };
  const newestPaused = async (predicate, description) => {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const matches = paused.map((request, index) => ({ request, index })).filter(({ request }) => predicate(request));
      if (matches.length) {
        // React StrictMode intentionally mounts/effect-cleans up/mounts in
        // development. The final request is the one still owned by the page;
        // earlier aborted interception IDs must never be fulfilled.
        await delay(100);
        const current = paused.map((request, index) => ({ request, index })).filter(({ request }) => predicate(request));
        const selected = current.at(-1);
        if (selected) {
          for (let index = paused.length - 1; index >= 0; index--) if (predicate(paused[index])) paused.splice(index, 1);
          return selected.request;
        }
      }
      await delay(25);
    }
    throw new Error(`Timed out waiting for ${description}.`);
  };
  const isSearch = (request) => request.request.method === "GET" && request.request.url.includes("/api/papers/search");
  const isLibraryGet = (request) => request.request.method === "GET" && request.request.url.includes("/api/library/papers");
  const isLibraryPost = (request) => request.request.method === "POST" && request.request.url.includes("/api/library/papers");
  const documentPath = (request) => new URL(request.request.url).pathname;
  const isDocumentList = (request) => request.request.method === "GET" && documentPath(request) === "/api/documents";
  const isDocumentText = (request, id) => request.request.method === "GET" && documentPath(request) === `/api/documents/${id}/text`;
  const isDocumentMetadataGet = (request, id) => request.request.method === "GET" && documentPath(request) === `/api/documents/${id}/metadata`;
  const isDocumentExtractPost = (request, id) => request.request.method === "POST" && documentPath(request) === `/api/documents/${id}/extract`;
  const isDocumentMetadataPost = (request, id) => request.request.method === "POST" && documentPath(request) === `/api/documents/${id}/metadata`;
  const isDocumentSummaryGet = (request, id) => request.request.method === "GET" && documentPath(request) === `/api/documents/${id}/summary`;
  const isDocumentSummaryPost = (request, id) => request.request.method === "POST" && documentPath(request) === `/api/documents/${id}/summary`;
  const fulfillJson = async (request, status, body) => {
    record("mock-response", { method: request.request.method, path: new URL(request.request.url).pathname, status });
    return cdp.send("Fetch.fulfillRequest", {
      requestId: request.requestId,
      responseCode: status,
      responseHeaders: [{ name: "content-type", value: "application/json; charset=utf-8" }],
      body: Buffer.from(JSON.stringify(body)).toString("base64"),
    }, sessionId);
  };
  const navigate = async () => {
    await cdp.send("Page.navigate", { url: viteOrigin }, sessionId);
    await waitFor("document.querySelector('#paper-search-query')", "the initial page");
    await waitFor("document.body.innerText.includes('Backend connected') && document.body.innerText.includes('D1 connected') && document.body.innerText.includes('R2 connected')", "connection indicators");
  };
  const mockSearch = async (query, body, status = 200) => {
    assert.equal(await fillInput(query), true);
    await pressEnter();
    const request = await nextPaused(isSearch, `search request for ${query}`);
    await fulfillJson(request, status, body);
  };
  const resolveInitialLibrary = async (papers) => {
    const request = await newestPaused(isLibraryGet, "active initial library request");
    assert.equal(await click("#library-tab"), true);
    await waitFor("document.body.innerText.includes('Loading saved papers')", "initial library loading state");
    await fulfillJson(request, 200, { papers });
    if (papers.length) await waitFor(`document.body.innerText.includes(${JSON.stringify(papers[0].id)})`, "rendered saved library record");
    else await waitFor("document.body.innerText.includes('No saved papers yet')", "empty library state");
  };

  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/papers/search*" }, { urlPattern: "*/api/library/papers*" }] }, sessionId);
  await navigate();
  await resolveInitialLibrary([existingPaper]);
  assert.ok((await evaluate("document.body.innerText")).includes("Original saved metadata"));
  assert.equal(await click("#search-tab"), true);

  const searchResponse = {
    provider: "arxiv",
    query: "machine learning",
    papers: [
      { id: "2401.01234", title: "Changed search title", authors: ["Search Author"], year: 2024, abstract: "Search metadata must not replace an existing record.", url: "https://arxiv.org/abs/2401.01234v9", pdfUrl: null },
      { id: "2401.01235", title: newlySavedPaper.title, authors: newlySavedPaper.authors, year: newlySavedPaper.year, abstract: newlySavedPaper.abstract, url: newlySavedPaper.url, pdfUrl: newlySavedPaper.pdfUrl },
    ],
  };
  assert.equal(await fillInput("machine learning"), true);
  await pressEnter();
  const fixtureSearchRequest = await nextPaused(isSearch, "fixture search request");
  await waitFor("document.body.innerText.includes('Searching arXiv for') && document.querySelector('button[type=submit]').disabled", "search loading state");
  await pressEnter();
  await delay(75);
  assert.equal(paused.filter(isSearch).length, 0, "pending search must not be submitted twice");
  await fulfillJson(fixtureSearchRequest, 200, searchResponse);
  await waitFor("document.querySelectorAll('.paper-card').length === 2", "fixture search results");
  assert.equal(await evaluate("document.querySelector('[data-save-paper=\"2401.01234\"]').disabled"), true, "existing source identity must be recognized as saved");
  assert.equal(await evaluate("document.querySelector('[data-save-paper=\"2401.01234\"]').textContent"), "Saved");
  assert.equal(await click('[data-save-paper="2401.01235"]'), true);
  const saveRequest = await nextPaused(isLibraryPost, "fixture save request");
  assert.deepEqual(JSON.parse(saveRequest.request.postData), { paper: searchResponse.papers[1] });
  await waitFor("document.querySelector('[data-save-paper=\"2401.01235\"]').textContent === 'Saving...'", "per-paper saving state");
  await fulfillJson(saveRequest, 201, { paper: newlySavedPaper, created: true });
  await waitFor("document.querySelector('[data-save-paper=\"2401.01235\"]').textContent === 'Saved'", "saved feedback");
  assert.equal(await click("#library-tab"), true);
  await waitFor(`document.body.innerText.includes(${JSON.stringify(newlySavedPaper.id)}) && document.body.innerText.includes(${JSON.stringify(existingPaper.id)})`, "newly saved library record");
  assert.match(await evaluate("document.body.innerText"), /Newly saved fixture paper[\s\S]*Original saved metadata/u);
  record("mocked-existing-save-and-library-passed", { existingId: existingPaper.id, createdId: newlySavedPaper.id });

  const desktopScreenshotPath = resolve(state, "library-desktop.png");
  const desktopScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, sessionId);
  await writeFile(desktopScreenshotPath, Buffer.from(desktopScreenshot.data, "base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 1, mobile: true }, sessionId);
  await delay(50);
  const mobileMetrics = JSON.parse(await evaluate("JSON.stringify({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth })"));
  assert.ok(mobileMetrics.scrollWidth <= mobileMetrics.width, "narrow Library layout must not require horizontal scrolling");
  const mobileScreenshotPath = resolve(state, "library-mobile.png");
  const mobileScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, sessionId);
  await writeFile(mobileScreenshotPath, Buffer.from(mobileScreenshot.data, "base64"));
  await cdp.send("Emulation.clearDeviceMetricsOverride", {}, sessionId);

  assert.equal(await click(".reload-button"), true);
  const libraryErrorRequest = await nextPaused(isLibraryGet, "library error reload");
  await fulfillJson(libraryErrorRequest, 503, { error: { kind: "database_failure", message: "The paper library database operation failed." } });
  await waitFor("document.querySelector('[role=alert]')?.textContent.includes('database operation failed')", "library API error");
  assert.ok((await evaluate("document.body.innerText")).includes(newlySavedPaper.id), "failed library reads must retain visible records");
  assert.equal(await click(".reload-button"), true);
  const malformedLibrary = await nextPaused(isLibraryGet, "malformed library reload");
  await fulfillJson(malformedLibrary, 200, { unexpected: true });
  await waitFor("document.querySelector('[role=alert]')?.textContent.includes('unexpected response')", "malformed library error");
  assert.ok((await evaluate("document.body.innerText")).includes(existingPaper.id), "malformed library reads must retain visible records");
  record("mocked-library-errors-retain-records-passed");

  // Abort an initial load with a browser refresh, then fulfill the newer one.
  // The superseded response must not erase the current page's records.
  await cdp.send("Page.navigate", { url: viteOrigin }, sessionId);
  await waitFor("document.querySelector('#paper-search-query')", "first stale-library page");
  const staleLibrary = await newestPaused(isLibraryGet, "superseded library request");
  await cdp.send("Page.navigate", { url: viteOrigin }, sessionId);
  await waitFor("document.querySelector('#paper-search-query')", "replacement stale-library page");
  const currentLibrary = await newestPaused(isLibraryGet, "replacement library request");
  await fulfillJson(currentLibrary, 200, { papers: [newlySavedPaper] });
  await cdp.send("Fetch.failRequest", { requestId: staleLibrary.requestId, errorReason: "Aborted" }).catch(() => undefined);
  assert.equal(await click("#library-tab"), true);
  await waitFor(`document.body.innerText.includes(${JSON.stringify(newlySavedPaper.id)})`, "current library after stale load");
  assert.equal((await evaluate("document.body.innerText")).includes("No saved papers yet"), false);
  record("mocked-stale-library-response-ignored");

  await cdp.send("Page.navigate", { url: viteOrigin }, sessionId);
  await waitFor("document.querySelector('#paper-search-query')", "empty-library page");
  await resolveInitialLibrary([]);
  record("mocked-empty-library-passed");
  assert.equal(await click("#search-tab"), true);
  const duplicateSearch = { provider: "arxiv", query: "duplicate fixture", papers: [{ id: "2401.01236", title: "Duplicate search metadata", authors: ["Different Author"], year: null, abstract: "The response must use the original saved record.", url: "https://arxiv.org/abs/2401.01236v7", pdfUrl: null }] };
  await mockSearch("duplicate fixture", duplicateSearch);
  await waitFor("document.querySelector('[data-save-paper=\"2401.01236\"]')", "duplicate search result");
  assert.equal(await click('[data-save-paper="2401.01236"]'), true);
  const duplicateSave = await nextPaused(isLibraryPost, "duplicate save request");
  await fulfillJson(duplicateSave, 200, { paper: duplicatePaper, created: false });
  await waitFor("document.querySelector('[data-save-paper=\"2401.01236\"]').textContent === 'Saved'", "duplicate save feedback");
  assert.equal(await click("#library-tab"), true);
  await waitFor(`document.body.innerText.includes(${JSON.stringify(duplicatePaper.id)}) && document.querySelector('#library-view time')?.dateTime === ${JSON.stringify(duplicatePaper.savedAt)}`, "original duplicate record in library");
  assert.ok((await evaluate("document.body.innerText")).includes("Original duplicate record"));
  record("mocked-duplicate-preserves-id-and-timestamp", { id: duplicatePaper.id, savedAt: duplicatePaper.savedAt });

  assert.equal(await click("#search-tab"), true);
  await mockSearch("search api error", { error: { kind: "upstream", message: "arXiv could not provide a valid paper search response." } }, 502);
  await waitFor("document.querySelector('[role=alert]')?.textContent.includes('arXiv could not provide')", "sanitized search error");
  await mockSearch("unexpected search", { unexpected: true });
  await waitFor("document.querySelector('[role=alert]')?.textContent.includes('unexpected response')", "unexpected search JSON error");
  assert.equal(await fillInput("network search"), true);
  await pressEnter();
  await cdp.send("Fetch.failRequest", { requestId: (await nextPaused(isSearch, "network search request")).requestId, errorReason: "Failed" }, sessionId);
  await waitFor("document.querySelector('[role=alert]')?.textContent.includes('could not be completed')", "search network error");
  await mockSearch("no results fixture", { provider: "arxiv", query: "no results fixture", papers: [] });
  await waitFor("document.body.innerText.includes('No papers found for')", "search empty state");
  record("mocked-search-empty-errors-and-unexpected-json-passed");

  await cdp.send("Page.navigate", { url: viteOrigin }, sessionId);
  await waitFor("document.querySelector('#paper-search-query')", "interrupted-save page");
  await resolveInitialLibrary([]);
  assert.equal(await click("#search-tab"), true);
  const interruptedSearch = { provider: "arxiv", query: "interrupted save", papers: [{ id: "2401.01237", title: "Interrupted fixture", authors: ["Interrupted Author"], year: 2024, abstract: "This must not be retried automatically.", url: "https://arxiv.org/abs/2401.01237v1", pdfUrl: null }] };
  await mockSearch("interrupted save", interruptedSearch);
  await waitFor("document.querySelector('[data-save-paper=\"2401.01237\"]')", "interrupted-save search result");
  await evaluate(`(() => {
    window.__libraryOriginalSetTimeout = window.setTimeout;
    window.setTimeout = (callback, milliseconds, ...args) => window.__libraryOriginalSetTimeout(callback, milliseconds === 15000 ? 25 : milliseconds, ...args);
  })()`);
  assert.equal(await click('[data-save-paper="2401.01237"]'), true);
  const interruptedPost = await nextPaused(isLibraryPost, "interrupted save POST");
  await waitFor("document.body.innerText.includes('Checking the library before another save')", "uncertain save feedback");
  await cdp.send("Fetch.failRequest", { requestId: interruptedPost.requestId, errorReason: "Aborted" }, sessionId).catch(() => undefined);
  const reconciliation = await nextPaused(isLibraryGet, "uncertain-save reconciliation GET");
  await fulfillJson(reconciliation, 200, { papers: [] });
  await waitFor("document.querySelector('[role=alert]')?.textContent.includes('could not be confirmed')", "reconciled uncertain save error");
  await evaluate("window.setTimeout = window.__libraryOriginalSetTimeout");
  assert.equal(allPaused.filter((request) => request.method === "POST" && request.url.includes("/api/library/papers") && request.postData?.includes("2401.01237")).length, 1, "interrupted POST must not retry automatically");
  record("mocked-interrupted-save-reconciles-without-post-retry");

  // Real isolated D1 flow: only the search route is mocked. Save/list/refresh
  // use relative browser requests through Vite to the owned local Worker.
  await cdp.send("Fetch.disable", {}, sessionId);
  await cdp.send("Page.navigate", { url: viteOrigin }, sessionId);
  await waitFor("document.querySelector('#paper-search-query')", "actual-flow page");
  assert.equal(await click("#library-tab"), true);
  await waitFor("document.body.innerText.includes('No saved papers yet')", "actual empty library");
  assert.equal(await click("#search-tab"), true);
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/papers/search*" }] }, sessionId);
  await mockSearch("actual browser fixture", { provider: "arxiv", query: "actual browser fixture", papers: [actualSearchPaper] });
  await waitFor("document.querySelector('[data-save-paper=\"2401.01239\"]')", "actual search fixture");
  assert.equal(await click('[data-save-paper="2401.01239"]'), true);
  await waitFor("document.querySelector('[data-save-paper=\"2401.01239\"]').textContent === 'Saved'", "real D1 save through Vite proxy");
  assert.equal(await click("#library-tab"), true);
  assert.equal(await click(".reload-button"), true);
  await waitFor("document.querySelector('#library-view code')", "real D1 library record");
  const firstRecord = JSON.parse(await evaluate("JSON.stringify({ codes: [...document.querySelectorAll('#library-view code')].map((node) => node.textContent), saved: document.querySelector('#library-view time')?.dateTime })"));
  assert.equal(firstRecord.codes[0], actualSearchPaper.id);
  assert.ok(typeof firstRecord.codes[1] === "string" && firstRecord.codes[1] !== actualSearchPaper.id);
  assert.match(firstRecord.saved, /^\d{4}-\d{2}-\d{2}T/u);
  const actualRecordId = firstRecord.codes[1];
  const actualSavedAt = firstRecord.saved;
  await cdp.send("Page.navigate", { url: viteOrigin }, sessionId);
  await waitFor("document.querySelector('#paper-search-query')", "browser refresh");
  assert.equal(await click("#library-tab"), true);
  await waitFor(`document.body.innerText.includes(${JSON.stringify(actualRecordId)})`, "record after browser refresh");
  assert.equal(await evaluate("document.querySelector('[data-save-paper=\"2401.01239\"]')?.disabled ?? true"), true, "not searched after refresh; saved UI state is reconciled from the library");
  const duplicateActual = await evaluate(`fetch('/api/library/papers', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: ${JSON.stringify(JSON.stringify({ paper: actualSearchPaper }))}
  }).then(async (response) => ({ status: response.status, body: await response.json() }))`);
  assert.equal(duplicateActual.status, 200);
  assert.equal(duplicateActual.body.created, false);
  assert.equal(duplicateActual.body.paper.id, actualRecordId);
  assert.equal(duplicateActual.body.paper.savedAt, actualSavedAt);
  assert.equal(await click(".reload-button"), true);
  await waitFor(`document.body.innerText.includes(${JSON.stringify(actualRecordId)})`, "unchanged record after real duplicate");
  record("actual-browser-vite-proxy-d1-save-refresh-and-duplicate-passed", { id: actualRecordId, savedAt: actualSavedAt });

  // Document-only mock states use the same browser/CDP harness. They exercise
  // rendering and stale/interrupted request handling without invoking Worker
  // extraction or the local provider boundary.
  await cdp.send("Fetch.disable", {}, sessionId);
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/documents*" }] }, sessionId);
  await cdp.send("Page.navigate", { url: viteOrigin }, sessionId);
  await waitFor("document.querySelector('#pdfs-tab')", "mocked PDFs page");
  assert.equal(await click("#pdfs-tab"), true);
  const initialDocuments = await newestPaused(isDocumentList, "initial PDFs list request");
  await waitFor("document.body.innerText.includes('Loading saved PDFs')", "PDF loading state");
  await fulfillJson(initialDocuments, 200, { documents: [] });
  await waitFor("document.body.innerText.includes('No PDFs have been uploaded yet')", "PDF empty state");
  assert.equal(await click("#pdfs-view .reload-button"), true);
  await fulfillJson(await nextPaused(isDocumentList, "PDF error reload"), 503, { error: { kind: "database_failure", message: "The document database operation failed." } });
  await waitFor("document.querySelector('[role=alert]')?.textContent.includes('document database operation failed')", "PDF list API error");
  assert.equal(await click("#pdfs-view .reload-button"), true);
  await fulfillJson(await nextPaused(isDocumentList, "malformed PDFs reload"), 200, { unexpected: true });
  await waitFor("document.querySelector('[role=alert]')?.textContent.includes('unexpected response')", "malformed PDFs response");
  assert.equal(await click("#pdfs-view .reload-button"), true);
  await fulfillJson(await nextPaused(isDocumentList, "mock PDFs records reload"), 200, { documents: [mockDocumentOne, mockDocumentTwo] });
  await waitFor(`document.querySelector('[data-document-id="${mockDocumentOne.id}"]')`, "mock PDF records");

  // Unknown metadata remains explicit and readable rather than fabricated.
  assert.equal(await click(`[data-document-id="${mockDocumentOne.id}"]`), true);
  await fulfillJson(await nextPaused((request) => isDocumentText(request, mockDocumentOne.id), "unknown-metadata text GET"), 200, { extraction: mockExtraction(mockDocumentOne.id, "Current selected PDF text") });
  await fulfillJson(await nextPaused((request) => isDocumentMetadataGet(request, mockDocumentOne.id), "unknown-metadata GET"), 200, { metadata: unknownMetadata(mockDocumentOne.id) });
  await waitFor("document.body.innerText.includes('Loading saved summary')", "summary loading state");
  await fulfillJson(await nextPaused((request) => isDocumentSummaryGet(request, mockDocumentOne.id), "not-generated summary GET"), 404, { error: { kind: "summary_not_found", message: "The uploaded document summary has not been generated." } });
  await waitFor("document.body.innerText.includes('Title unavailable') && document.body.innerText.includes('title is unknown')", "unknown metadata fallbacks");
  await waitFor("document.body.innerText.includes('No summary has been generated')", "not-generated summary state");
  assert.equal(await click('[data-generate-summary]'), true);
  await waitFor("document.body.innerText.includes('Generating a source-grounded summary')", "summary generation feedback");
  await fulfillJson(await nextPaused((request) => isDocumentSummaryPost(request, mockDocumentOne.id), "partial summary POST"), 201, { summary: partialSummary(mockDocumentOne.id), created: true });
  await waitFor("document.body.innerText.includes('Partial source coverage') && document.body.innerText.includes('Text outside the source budget was omitted')", "partial summary coverage rendering");
  await evaluate("document.querySelector('.summary-evidence').open = true");
  await waitFor("document.body.innerText.includes('Supporting quotes') && document.body.innerText.includes('Page 1:')", "summary page-numbered evidence");
  const summaryPostsAfterCreate = allPaused.filter((request) => request.method === "POST" && request.url.endsWith(`/api/documents/${mockDocumentOne.id}/summary`)).length;
  assert.equal(await click('[data-summary-reload]'), true);
  await fulfillJson(await nextPaused((request) => isDocumentSummaryGet(request, mockDocumentOne.id), "saved summary reload GET"), 200, { summary: partialSummary(mockDocumentOne.id) });
  await waitFor("document.body.innerText.includes('Partial source coverage')", "saved summary after explicit GET reload");
  assert.equal(allPaused.filter((request) => request.method === "POST" && request.url.endsWith(`/api/documents/${mockDocumentOne.id}/summary`)).length, summaryPostsAfterCreate, "summary reload must use GET only");

  // A superseded detail response must not overwrite a newer selection.
  assert.equal(await click(`[data-document-id="${mockDocumentTwo.id}"]`), true);
  const staleText = await nextPaused((request) => isDocumentText(request, mockDocumentTwo.id), "stale document text request");
  const staleMetadata = await nextPaused((request) => isDocumentMetadataGet(request, mockDocumentTwo.id), "stale document metadata request");
  const staleSummary = await nextPaused((request) => isDocumentSummaryGet(request, mockDocumentTwo.id), "stale document summary request");
  assert.equal(await click(`[data-document-id="${mockDocumentOne.id}"]`), true);
  await fulfillJson(await nextPaused((request) => isDocumentText(request, mockDocumentOne.id), "current document text request"), 200, { extraction: mockExtraction(mockDocumentOne.id, "Current selected PDF text") });
  await fulfillJson(await nextPaused((request) => isDocumentMetadataGet(request, mockDocumentOne.id), "current document metadata request"), 200, { metadata: unknownMetadata(mockDocumentOne.id) });
  await fulfillJson(await nextPaused((request) => isDocumentSummaryGet(request, mockDocumentOne.id), "current document summary request"), 200, { summary: partialSummary(mockDocumentOne.id) });
  await cdp.send("Fetch.failRequest", { requestId: staleText.requestId, errorReason: "Aborted" }).catch(() => undefined);
  await cdp.send("Fetch.failRequest", { requestId: staleMetadata.requestId, errorReason: "Aborted" }).catch(() => undefined);
  await cdp.send("Fetch.failRequest", { requestId: staleSummary.requestId, errorReason: "Aborted" }).catch(() => undefined);
  await waitFor("document.querySelector('.document-text pre')?.textContent.includes('Current selected PDF text') && document.body.innerText.includes('Partial source coverage')", "stale document and summary selection ignored");

  // Resume reads first, then surfaces in-progress and interrupted POSTs without
  // retrying them. The interrupted case reconciles through read-only GETs.
  assert.equal(await click(`[data-document-id="${mockDocumentTwo.id}"]`), true);
  await fulfillJson(await nextPaused((request) => isDocumentText(request, mockDocumentTwo.id), "resume candidate text GET"), 200, { extraction: mockExtraction(mockDocumentTwo.id, "Resume fixture page text") });
  await fulfillJson(await nextPaused((request) => isDocumentMetadataGet(request, mockDocumentTwo.id), "resume candidate metadata GET"), 404, { error: { kind: "metadata_not_found", message: "The uploaded document metadata has not been generated." } });
  await fulfillJson(await nextPaused((request) => isDocumentSummaryGet(request, mockDocumentTwo.id), "resume candidate summary GET"), 404, { error: { kind: "summary_not_found", message: "The uploaded document summary has not been generated." } });
  await waitFor("document.body.innerText.includes('Resume processing')", "resume action");
  assert.equal(await click('[data-generate-summary]'), true);
  await fulfillJson(await nextPaused((request) => isDocumentSummaryPost(request, mockDocumentTwo.id), "summary in-progress POST"), 409, { error: { kind: "summary_in_progress", message: "Summary generation is in progress; try again after the active request finishes." } });
  await waitFor("document.body.innerText.includes('Summary generation is in progress')", "summary in-progress feedback");
  assert.equal(await click("#pdfs-view .document-detail .save-button"), true);
  await fulfillJson(await nextPaused((request) => isDocumentText(request, mockDocumentTwo.id), "resume preflight text GET"), 200, { extraction: mockExtraction(mockDocumentTwo.id, "Resume fixture page text") });
  await fulfillJson(await nextPaused((request) => isDocumentMetadataGet(request, mockDocumentTwo.id), "resume preflight metadata GET"), 404, { error: { kind: "metadata_not_found", message: "The uploaded document metadata has not been generated." } });
  await fulfillJson(await nextPaused((request) => isDocumentSummaryGet(request, mockDocumentTwo.id), "resume preflight summary GET"), 404, { error: { kind: "summary_not_found", message: "The uploaded document summary has not been generated." } });
  await fulfillJson(await nextPaused((request) => isDocumentMetadataPost(request, mockDocumentTwo.id), "in-progress metadata POST"), 409, { error: { kind: "metadata_in_progress", message: "Metadata generation is in progress; try again after the active request finishes." } });
  await waitFor("document.querySelector('[role=alert]')?.textContent.includes('Metadata generation is in progress')", "metadata in-progress feedback");
  const postsBeforeInterrupt = allPaused.filter((request) => request.method === "POST" && request.url.endsWith(`/api/documents/${mockDocumentTwo.id}/metadata`)).length;
  assert.equal(await click("#pdfs-view .document-detail .save-button"), true);
  await fulfillJson(await nextPaused((request) => isDocumentText(request, mockDocumentTwo.id), "interrupted preflight text GET"), 200, { extraction: mockExtraction(mockDocumentTwo.id, "Resume fixture page text") });
  await fulfillJson(await nextPaused((request) => isDocumentMetadataGet(request, mockDocumentTwo.id), "interrupted preflight metadata GET"), 404, { error: { kind: "metadata_not_found", message: "The uploaded document metadata has not been generated." } });
  await fulfillJson(await nextPaused((request) => isDocumentSummaryGet(request, mockDocumentTwo.id), "interrupted preflight summary GET"), 404, { error: { kind: "summary_not_found", message: "The uploaded document summary has not been generated." } });
  await fulfillJson(await nextPaused((request) => isDocumentMetadataPost(request, mockDocumentTwo.id), "interrupted metadata POST"), 200, { unexpected: true });
  await fulfillJson(await nextPaused((request) => isDocumentText(request, mockDocumentTwo.id), "interrupted reconciliation text GET"), 200, { extraction: mockExtraction(mockDocumentTwo.id, "Resume fixture page text") });
  await fulfillJson(await nextPaused((request) => isDocumentMetadataGet(request, mockDocumentTwo.id), "interrupted reconciliation metadata GET"), 404, { error: { kind: "metadata_not_found", message: "The uploaded document metadata has not been generated." } });
  await fulfillJson(await nextPaused((request) => isDocumentSummaryGet(request, mockDocumentTwo.id), "interrupted reconciliation summary GET"), 404, { error: { kind: "summary_not_found", message: "The uploaded document summary has not been generated." } });
  await waitFor("document.body.innerText.includes('saved results are shown')", "interrupted processing reconciliation");
  assert.equal(allPaused.filter((request) => request.method === "POST" && request.url.endsWith(`/api/documents/${mockDocumentTwo.id}/metadata`)).length, postsBeforeInterrupt + 1, "interrupted metadata POST must not retry automatically");

  assert.equal(await click('[data-summary-reload]'), true);
  await fulfillJson(await nextPaused((request) => isDocumentSummaryGet(request, mockDocumentTwo.id), "malformed summary GET"), 200, { unexpected: true });
  await waitFor("document.querySelector('[role=alert]')?.textContent.includes('Saved summary returned an unexpected response')", "malformed summary feedback");
  assert.equal(await click('[data-generate-summary]'), true);
  await fulfillJson(await nextPaused((request) => isDocumentSummaryPost(request, mockDocumentTwo.id), "summary provider failure POST"), 502, { error: { kind: "summary_provider_failure", message: "The summary provider returned an error." } });
  await waitFor("document.querySelector('[role=alert]')?.textContent.includes('summary provider returned an error')", "summary provider failure feedback");
  const summaryPostsBeforeUncertain = allPaused.filter((request) => request.method === "POST" && request.url.endsWith(`/api/documents/${mockDocumentTwo.id}/summary`)).length;
  assert.equal(await click('[data-generate-summary]'), true);
  await fulfillJson(await nextPaused((request) => isDocumentSummaryPost(request, mockDocumentTwo.id), "uncertain summary POST"), 200, { unexpected: true });
  await fulfillJson(await nextPaused((request) => isDocumentSummaryGet(request, mockDocumentTwo.id), "uncertain summary reconciliation GET"), 404, { error: { kind: "summary_not_found", message: "The uploaded document summary has not been generated." } });
  await waitFor("document.querySelector('[role=alert]')?.textContent.includes('No saved summary was found')", "uncertain summary reconciliation");
  assert.equal(allPaused.filter((request) => request.method === "POST" && request.url.endsWith(`/api/documents/${mockDocumentTwo.id}/summary`)).length, summaryPostsBeforeUncertain + 1, "uncertain summary POST must not retry automatically");
  record("mocked-pdfs-summary-loading-partial-evidence-get-only-stale-and-inprogress-passed");

  // Real isolated PDF flow: browser FormData crosses the relative Vite proxy,
  // Worker uploads to isolated R2, extracts with the real parser, and reaches
  // only this loopback metadata-provider boundary.
  await cdp.send("Fetch.disable", {}, sessionId);
  await cdp.send("Page.navigate", { url: viteOrigin }, sessionId);
  await waitFor("document.querySelector('#pdfs-tab')", "PDFs tab");
  assert.equal(metadataProviderCalls, 0, "loading the page must not call the metadata provider");
  assert.equal(await click("#pdfs-tab"), true);
  await waitFor("document.querySelector('#pdf-upload')", "PDF upload form");
  await waitFor("document.body.innerText.includes('No PDFs have been uploaded yet')", "empty PDFs state");
  const fixtureBase64 = Buffer.from(documentFixture.bytes).toString("base64");
  const choosePdf = async (filename, base64 = fixtureBase64) => evaluate(`(() => {
    const input = document.querySelector('#pdf-upload');
    if (!(input instanceof HTMLInputElement)) return false;
    const bytes = Uint8Array.from(atob(${JSON.stringify(base64)}), (character) => character.charCodeAt(0));
    const file = new File([bytes], ${JSON.stringify(filename)}, { type: 'application/pdf' });
    const files = new DataTransfer();
    files.items.add(file);
    Object.defineProperty(input, 'files', { configurable: true, value: files.files });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.files?.[0]?.name === ${JSON.stringify(filename)};
  })()`);
  assert.equal(await choosePdf("metadata-browser-fixture.pdf"), true);
  assert.equal(await click("#pdfs-view button[type=submit]"), true);
  await waitFor("document.body.innerText.includes('Extracting text from the stored PDF') || document.body.innerText.includes('Extracting source-grounded metadata')", "PDF processing feedback");
  await waitFor(`document.body.innerText.includes(${JSON.stringify(documentFixture.expected.title)}) && document.body.innerText.includes(${JSON.stringify(documentFixture.expected.abstract)}) && document.body.innerText.includes('Ready — text and source-grounded metadata are saved.')`, "completed PDF metadata pipeline");
  assert.equal(metadataProviderCalls, 1, "the explicit upload pipeline must make one loopback metadata request");
  const uploadedDocumentId = await evaluate("document.querySelector('.document-select')?.dataset.documentId");
  assert.match(uploadedDocumentId, /^[0-9a-f-]{36}$/u);
  await evaluate("document.querySelector('.document-text').open = true; document.querySelector('.metadata-evidence').open = true");
  await waitFor("document.body.innerText.includes('Page 1') && document.body.innerText.includes('Avery Example') && document.body.innerText.includes('Page-numbered source evidence')", "extracted page text and metadata evidence");
  const originalPdfBase64 = await evaluate(`fetch('/api/documents/${uploadedDocumentId}/pdf').then(async (response) => {
    if (!response.ok) throw new Error('download failed');
    const bytes = new Uint8Array(await response.arrayBuffer());
    let text = '';
    for (const byte of bytes) text += String.fromCharCode(byte);
    return btoa(text);
  })`);
  assert.deepEqual(Buffer.from(originalPdfBase64, "base64"), Buffer.from(documentFixture.bytes), "original-PDF download must preserve fixture bytes");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 1, mobile: true }, sessionId);
  await delay(50);
  const pdfMobileMetrics = JSON.parse(await evaluate("JSON.stringify({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth })"));
  assert.ok(pdfMobileMetrics.scrollWidth <= pdfMobileMetrics.width, "narrow PDFs layout must not require horizontal scrolling");
  await cdp.send("Emulation.clearDeviceMetricsOverride", {}, sessionId);
  await cdp.send("Page.navigate", { url: viteOrigin }, sessionId);
  await waitFor("document.querySelector('#pdfs-tab')", "PDF browser refresh");
  assert.equal(metadataProviderCalls, 1, "browser refresh must not generate metadata");
  assert.equal(await click("#pdfs-tab"), true);
  await waitFor(`document.querySelector('[data-document-id=${JSON.stringify(uploadedDocumentId)}]')`, "persisted PDF after browser refresh");
  assert.equal(await click(`[data-document-id="${uploadedDocumentId}"]`), true);
  await waitFor(`document.body.innerText.includes(${JSON.stringify(documentFixture.expected.title)})`, "persisted document metadata after selection");
  assert.equal(metadataProviderCalls, 1, "list reload and selection must use GET only");
  record("actual-browser-vite-proxy-pdf-upload-extract-metadata-refresh-download-passed", { documentId: uploadedDocumentId, providerCalls: metadataProviderCalls });

  // A provider failure is surfaced without removing the stored original or
  // extracted text. It also proves no automatic metadata POST retry occurs.
  metadataProviderMode = "failure";
  assert.equal(await choosePdf("metadata-browser-failure.pdf"), true);
  assert.equal(await click("#pdfs-view button[type=submit]"), true);
  await waitFor("document.querySelector('[role=alert]')?.textContent.includes('metadata provider')", "metadata failure feedback");
  await waitFor("document.body.innerText.includes('Extracted page text')", "text retained after metadata failure");
  assert.equal(metadataProviderCalls, 2, "failed metadata processing must have exactly one provider request and no automatic retry");
  metadataProviderMode = "success";
  record("actual-browser-metadata-failure-retains-upload-and-text-passed", { providerCalls: metadataProviderCalls });

  // A separate actual Worker flow proves that an explicit summary works from
  // saved text even when this fixture's bibliographic metadata is unavailable.
  const summaryFixtureBase64 = Buffer.from(summaryFixture.bytes).toString("base64");
  assert.equal(await choosePdf("summary-browser-fixture.pdf", summaryFixtureBase64), true);
  assert.equal(await click("#pdfs-view button[type=submit]"), true);
  await waitFor("document.querySelector('[role=alert]')?.textContent.includes('metadata') && document.body.innerText.includes('Extracted page text')", "summary fixture text retained after unavailable metadata");
  await waitFor("document.body.innerText.includes('No summary has been generated')", "actual summary not-generated state");
  const summaryDocumentId = await evaluate("document.querySelector('.document-select')?.dataset.documentId");
  assert.match(summaryDocumentId, /^[0-9a-f-]{36}$/u);
  assert.equal(await click('[data-generate-summary]'), true);
  await waitFor("document.body.innerText.includes('Later-page findings can remain represented in the resulting summary.') && document.body.innerText.includes('Full source coverage')", "actual summary generation and evidence");
  assert.equal(summaryProviderCalls, 1, "explicit summary generation must make exactly one loopback provider request");
  await evaluate("document.querySelectorAll('.summary-evidence')[3]?.setAttribute('open', '')");
  await waitFor("document.body.innerText.includes('Supporting quotes') && document.body.innerText.includes('Page 4:')", "actual summary expandable evidence");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 1, mobile: true }, sessionId);
  await delay(50);
  const summaryMobileMetrics = JSON.parse(await evaluate("JSON.stringify({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth })"));
  assert.ok(summaryMobileMetrics.scrollWidth <= summaryMobileMetrics.width, "narrow summary layout must not require horizontal scrolling");
  await cdp.send("Emulation.clearDeviceMetricsOverride", {}, sessionId);
  await cdp.send("Page.navigate", { url: viteOrigin }, sessionId);
  await waitFor("document.querySelector('#pdfs-tab')", "summary browser refresh");
  assert.equal(await click("#pdfs-tab"), true);
  await waitFor(`document.querySelector('[data-document-id=${JSON.stringify(summaryDocumentId)}]')`, "persisted summary PDF after refresh");
  assert.equal(await click(`[data-document-id="${summaryDocumentId}"]`), true);
  await waitFor("document.body.innerText.includes('Later-page findings can remain represented in the resulting summary.')", "persisted summary after GET-only refresh");
  assert.equal(summaryProviderCalls, 1, "browser refresh and selection must not regenerate a saved summary");
  record("actual-browser-vite-proxy-summary-explicit-generation-refresh-and-evidence-passed", { documentId: summaryDocumentId, summaryProviderCalls, metadataProviderCalls });

  cdp.close();
  evidence.result = "passed";
  evidence.browser = browserPath;
  evidence.workerOrigin = workerOrigin;
  evidence.viteOrigin = viteOrigin;
  evidence.metadataProviderCalls = metadataProviderCalls;
  evidence.summaryProviderCalls = summaryProviderCalls;
  evidence.desktopScreenshotPath = desktopScreenshotPath;
  evidence.mobileScreenshotPath = mobileScreenshotPath;
} catch (error) {
  evidence.result = "failed";
  evidence.error = String(error.stack ?? error);
  console.error(evidence.error);
  process.exitCode = 1;
} finally {
  for (const child of [...children]) {
    try { await stop(child); } catch (error) { console.error(`Owned process cleanup failed: ${error}`); process.exitCode = 1; }
  }
  try { await stopMetadataProvider(); } catch (error) { console.error(`Owned local metadata provider cleanup failed: ${error}`); process.exitCode = 1; }
  evidence.finishedAt = new Date().toISOString();
  await mkdir(state, { recursive: true });
  await writeFile(resolve(state, "result.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify({ result: evidence.result, evidence: resolve(state, "result.json") }));
}
}

await main();
