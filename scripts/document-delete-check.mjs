import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import worker from "../dist/worker/index.js";
import { createSummaryPdfFixture } from "./fixtures/pdf-fixtures.mjs";

const root = resolve(import.meta.dirname, "..");
const directory = resolve(root, ".wrangler/document-delete-check", randomUUID());
let mf;
const evidence = { result: "running", liveProviderRequests: 0, steps: [] };
const fixture = createSummaryPdfFixture();
try {
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: "deletion-fixture", modules: true, script: "export default { fetch() { return new Response('ok'); } }", compatibilityDate: "2025-02-20", d1Databases: ["DB"], r2Buckets: ["PAPER_BUCKET"] }] }));
  const db = await mf.getD1Database("DB");
  const bucket = await mf.getR2Bucket("PAPER_BUCKET");
  for (const path of (await readdir(resolve(root, "drizzle"))).filter((path) => path.endsWith(".sql")).sort()) {
    const sql = await readFile(resolve(root, "drizzle", path), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) if (statement.trim()) await db.exec(statement.replaceAll("\n", " "));
  }
  const env = { DB: db, PAPER_BUCKET: bucket };
  const call = (path, init, bindings = env) => worker.fetch(new Request(`http://delete-check.invalid${path}`, init), bindings);
  const upload = async () => {
    const body = new FormData(); body.append("file", new Blob([fixture.bytes], { type: "application/pdf" }), "owned-fixture.pdf");
    const response = await call("/api/documents", { method: "POST", body }); assert.equal(response.status, 201);
    return (await response.json()).document;
  };
  const first = await upload(); const other = await upload();
  const extracted = await call(`/api/documents/${first.id}/extract`, { method: "POST" }); assert.equal(extracted.status, 201);
  const childTables = ["document_metadata", "document_summaries", "document_questions", "document_metadata_claims", "document_summary_claims", "document_question_claims"];
  // Storage-only sentinels exercise every cleanup table, not generation validation.
  // The HTTP question suite separately deletes a genuinely generated full document.
  for (const table of childTables) {
    const columns = (await db.prepare(`PRAGMA table_info(${table})`).all()).results;
    for (const document of [first, other]) {
      const values = columns.map((column) => column.name === "document_id" ? document.id : column.name === "id" ? randomUUID() : column.type === "integer" ? 0 : "owned-cleanup-fixture");
      await db.prepare(`INSERT INTO ${table} (${columns.map((column) => column.name).join(",")}) VALUES (${values.map(() => "?").join(",")})`).bind(...values).run();
    }
  }
  const otherRows = await Promise.all(childTables.map((table) => db.prepare(`SELECT * FROM ${table} WHERE document_id = ?`).bind(other.id).first()));
  // Simulate a bucket outage after the durable deletion marker was written.
  const failingBucket = { async delete() { throw new Error("fixture storage failure"); } };
  let response = await call(`/api/documents/${first.id}`, { method: "DELETE" }, { ...env, PAPER_BUCKET: failingBucket });
  assert.equal(response.status, 503);
  assert.equal((await db.prepare("SELECT status FROM uploaded_documents WHERE id = ?").bind(first.id).first()).status, "deleting");
  assert.equal((await call(`/api/documents/${first.id}/extract`, { method: "POST" })).status, 409);
  assert.ok(await bucket.get(`uploaded_documents/${first.id}.pdf`));
  evidence.steps.push("bucket-failure-retains-marker-and-blocks-processing");
  // Simulate D1 cleanup failure after R2 was successfully removed.
  const failingDb = { prepare: db.prepare.bind(db), batch: async (statements) => {
    if (statements.length > 4) throw new Error("fixture cleanup failure");
    return db.batch(statements);
  } };
  response = await call(`/api/documents/${first.id}`, { method: "DELETE" }, { ...env, DB: failingDb });
  assert.equal(response.status, 503);
  assert.equal(await bucket.get(`uploaded_documents/${first.id}.pdf`), null);
  assert.equal((await db.prepare("SELECT status FROM uploaded_documents WHERE id = ?").bind(first.id).first()).status, "deleting");
  assert.equal((await call(`/api/documents/${first.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await call(`/api/documents/${first.id}`, { method: "DELETE" })).status, 200);
  for (const table of ["uploaded_documents", "document_extractions", "document_metadata", "document_summaries", "document_questions", "document_metadata_claims", "document_summary_claims", "document_question_claims"]) {
    assert.equal((await db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${table === "uploaded_documents" ? "id" : "document_id"} = ?`).bind(first.id).first()).count, 0);
  }
  const otherPdf = await call(`/api/documents/${other.id}/pdf`); assert.equal(otherPdf.status, 200);
  assert.deepEqual(new Uint8Array(await otherPdf.arrayBuffer()), fixture.bytes);
  assert.deepEqual(await Promise.all(childTables.map((table) => db.prepare(`SELECT * FROM ${table} WHERE document_id = ?`).bind(other.id).first())), otherRows);
  evidence.steps.push("d1-failure-retry-idempotence-and-unrelated-pdf-preserved");

  const race = await upload();
  let release, began;
  const released = new Promise((done) => { release = done; });
  const started = new Promise((done) => { began = done; });
  const pausedBucket = { async get(key) { const object = await bucket.get(key); const bytes = await object.arrayBuffer(); began(); await released; return { arrayBuffer: async () => bytes }; } };
  const extracting = call(`/api/documents/${race.id}/extract`, { method: "POST" }, { ...env, PAPER_BUCKET: pausedBucket });
  await started;
  assert.equal((await call(`/api/documents/${race.id}`, { method: "DELETE" })).status, 200);
  release();
  assert.equal((await extracting).status, 409);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM document_extractions WHERE document_id = ?").bind(race.id).first()).count, 0);
  evidence.steps.push("late-extraction-cannot-recreate-deleted-content");
  evidence.result = "passed";
} catch (error) { evidence.result = "failed"; evidence.error = String(error.stack ?? error); process.exitCode = 1; }
finally { await mf?.dispose(); await mkdir(directory, { recursive: true }); await writeFile(resolve(directory, "result.json"), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify({ ...evidence, evidence: resolve(directory, "result.json") })); }
