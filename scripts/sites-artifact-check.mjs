import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import worker from "../dist/server/index.js";

const root = resolve(import.meta.dirname, "..");
assert.equal(typeof worker.fetch, "function");
const manifest = JSON.parse(await readFile(resolve(root, ".openai/hosting.json"), "utf8"));
assert.equal(manifest.d1, "DB");
assert.equal(manifest.r2, "PAPER_BUCKET");

let assetRequests = 0;
const html = await readFile(resolve(root, "dist/client/index.html"), "utf8");
const env = {
  ASSETS: { async fetch() { assetRequests++; return new Response(html, { headers: { "content-type": "text/html" } }); } },
  DB: { prepare(sql) { assert.equal(sql, "SELECT id FROM storage_probes LIMIT 1"); return { async all() { return { results: [] }; } }; } },
  PAPER_BUCKET: { async list(options) { assert.deepEqual(options, { limit: 1 }); return { objects: [] }; } },
};
const request = (path) => new Request("https://artifact-test.example" + path);
assert.deepEqual(await (await worker.fetch(request("/api/health"), env)).json(), { status: "ok" });
assert.deepEqual(await (await worker.fetch(request("/api/storage/status"), env)).json(), {
  status: "ok", d1: { status: "ok" }, r2: { status: "ok" },
});
for (const path of ["/api/unknown", "/api/__local/storage-probe/status", "/api/__local/integrations/openai"]) {
  assert.equal((await worker.fetch(request(path), env)).status, 404);
}
assert.equal(assetRequests, 0);
assert.match(await (await worker.fetch(request("/"), env)).text(), /AI Research Assistant/);
assert.equal(assetRequests, 1);
for (const name of ["0000_storage_probe.sql", "meta/0000_snapshot.json", "meta/_journal.json"]) {
  assert.deepEqual(await readFile(resolve(root, "dist/.openai/drizzle", name)), await readFile(resolve(root, "drizzle", name)));
}
console.log("Sites artifact: callable Worker, API/static routing, disabled probes, declared bindings, and unchanged migration metadata: PASS (binding fixtures).");
