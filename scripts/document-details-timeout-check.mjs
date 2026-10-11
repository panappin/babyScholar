import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

// Exercise the actual loadDetails implementation with controlled promises and
// timers. No browser, server, secret file, or external request is needed.
const source = await readFile(new URL("../src/DocumentWorkspace.tsx", import.meta.url), "utf8");
const start = source.indexOf("  async function loadDetails(id: string)");
const end = source.indexOf("\n  function selectDocument", start);
assert.ok(start >= 0 && end > start, "loadDetails implementation must be found");
const compiled = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;

function harness() {
  const mounted = { current: true };
  const revision = { current: 0 };
  const request = { current: null };
  const timers = new Map();
  const reads = [];
  let nextTimer = 0;
  let writes = 0;
  let state = {
    status: "loaded", extraction: { documentId: "saved" }, metadata: { title: "Saved title" },
    summary: { status: "loaded", summary: { overview: { text: "Saved summary" } } },
    questions: { status: "loaded", questions: [{ id: "saved-answer" }] },
  };
  const window = {
    setTimeout(callback, milliseconds) {
      assert.equal(milliseconds, 10_000);
      const id = ++nextTimer;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  const getStoredResults = (id, signal) => new Promise((resolve, reject) => {
    reads.push({ id, signal, resolve, reject });
    signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
  });
  const load = new Function("window", "mounted", "detailRevision", "detailRequest", "getStoredResults", "setDetailState", "READ_TIMEOUT_MS",
    `${compiled}\nreturn loadDetails;`)(window, mounted, revision, request, getStoredResults, (update) => { state = typeof update === "function" ? update(state) : update; writes += 1; }, 10_000);
  return { load, reads, timers, request, mounted, get state() { return state; }, get writes() { return writes; } };
}

const timeout = harness();
const expired = timeout.load("first");
assert.equal(timeout.state.status, "loading");
[...timeout.timers.values()][0]();
await expired;
assert.equal(timeout.state.status, "error");
assert.equal(timeout.state.summary.status, "error");
assert.equal(timeout.state.questions.status, "error");
assert.match(timeout.state.message, /too long.*Retry/u);
assert.equal(timeout.state.summary.summary.overview.text, "Saved summary");
assert.equal(timeout.state.questions.questions[0].id, "saved-answer");
assert.equal(timeout.request.current, null);
assert.equal(timeout.timers.size, 0);
const results = { extraction: { documentId: "first" }, metadata: null, summary: { status: "missing", summary: null }, questions: { status: "empty", questions: [] } };
const retry = timeout.load("first");
timeout.reads[1].resolve(results);
await retry;
assert.equal(timeout.state.status, "loaded");
assert.equal(timeout.state.extraction.documentId, "first");

const superseded = harness();
const old = superseded.load("old");
const oldTimeout = [...superseded.timers.values()][0];
const current = superseded.load("new");
const writesBeforeOldFinishes = superseded.writes;
oldTimeout(); // Even a queued old timeout cannot overwrite a newer selection.
await old;
assert.equal(superseded.writes, writesBeforeOldFinishes);
assert.equal(superseded.state.status, "loading");
assert.equal(superseded.request.current.signal, superseded.reads[1].signal);
superseded.reads[1].resolve({ ...results, extraction: { documentId: "new" } });
await current;
assert.equal(superseded.state.extraction.documentId, "new");
assert.equal(superseded.state.status, "loaded");

const cancelled = harness();
const unmounted = cancelled.load("old");
cancelled.mounted.current = false;
cancelled.request.current.abort();
const writesBeforeUnmount = cancelled.writes;
await unmounted;
assert.equal(cancelled.writes, writesBeforeUnmount);
console.log("PDF detail checks: timeout settles all panels, explicit reload recovers, superseded/unmounted requests cannot update state: PASS");
