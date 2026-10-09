import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import worker from "../dist/server/index.js";

const root = resolve(import.meta.dirname, "..");
assert.equal(typeof worker.fetch, "function");
const manifest = JSON.parse(await readFile(resolve(root, ".openai/hosting.json"), "utf8"));
assert.equal(manifest.d1, "DB");
assert.equal(manifest.r2, "PAPER_BUCKET");

const serverRoot = resolve(root, "dist/server");
const bundleMetadata = JSON.parse(await readFile(resolve(serverRoot, "bundle-meta.json"), "utf8"));
assert.ok(Object.keys(bundleMetadata.inputs).some((entry) => entry.replaceAll("\\", "/").includes("node_modules/unpdf/")), "Sites Worker must package UnPDF.");
const serverBundle = await readFile(resolve(serverRoot, "index.js"), "utf8");
assert.doesNotMatch(serverBundle, /from\s+["']unpdf(?:\/pdfjs)?["']/u, "Sites Worker must not rely on a bare UnPDF import.");
const frontendFiles = (await readdir(resolve(root, "dist/client"), { recursive: true, withFileTypes: true }))
  .filter((entry) => entry.isFile())
  .map((entry) => resolve(entry.parentPath, entry.name));
for (const file of frontendFiles) {
  const content = await readFile(file, "utf8");
  assert.doesNotMatch(content, /getDocumentProxy|unpdf\/pdfjs|from["']unpdf/u, `Frontend must not contain Worker parser code: ${file}`);
  assert.doesNotMatch(content, /OPENAI_API_KEY|api\.openai\.com|requestDocumentMetadata|metadata-openai/u, `Frontend must not contain metadata-provider code: ${file}`);
}

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
const migrationFiles = (await readdir(resolve(root, "drizzle"), { recursive: true, withFileTypes: true }))
  .filter((entry) => entry.isFile())
  .map((entry) => resolve(entry.parentPath, entry.name));
for (const source of migrationFiles) {
  const name = source.slice(resolve(root, "drizzle").length + 1);
  assert.deepEqual(await readFile(resolve(root, "dist/.openai/drizzle", name)), await readFile(resolve(root, "drizzle", name)));
}
console.log("Sites artifact: callable Worker, API/static routing, disabled probes, declared bindings, packaged UnPDF, parser-free frontend, and unchanged migration metadata: PASS (binding fixtures).");
