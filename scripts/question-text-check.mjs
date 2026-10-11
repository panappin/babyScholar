import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";

// In-memory compilation of the actual small adapter/validator, without a
// Worker, secret file, network call, build artifact, or new dependency.
const worker = resolve(import.meta.dirname, "../src/worker");
const modules = new Map();
async function load(name) {
  if (modules.has(name)) return modules.get(name);
  const source = await readFile(resolve(worker, name.replace(/\.js$/u, ".ts")), "utf8");
  let { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  });
  for (const match of outputText.matchAll(/from "\.\/([^"\n]+)"/gu)) {
    const dependency = await load(match[1]);
    outputText = outputText.replace(match[0], `from "${dependency}"`);
  }
  const url = `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`;
  modules.set(name, url);
  return url;
}
const { requestDocumentQuestion } = await import(await load("question-openai.js"));
const { validateDocumentQuestionOutput } = await import(await load("question-validation.js"));
const { requestDocumentMetadata } = await import(await load("metadata-openai.js"));
const { validateMetadataOutput } = await import(await load("metadata-validation.js"));
const { requestDocumentSummary } = await import(await load("summary-openai.js"));
const { validateDocumentSummaryOutput } = await import(await load("summary-validation.js"));
const { selectSummarySource } = await import(await load("summary-source.js"));
const excerpt = {
  pages: [{ pageNumber: 1, text: "The paper studies indexing and reports faster queries." }],
  evidenceReferences: [], pageNumbers: [1], pageRanges: [{ startPage: 1, endPage: 1 }],
  byteCount: 63, totalPageCount: 1, truncated: false, coverageWarning: "All pages included.",
};
let mockedRequests = 0;
async function check(text, expected, direct = false) {
  const mockedFetch = async (_url, init) => {
    mockedRequests += 1;
    const request = JSON.parse(init.body);
    assert.equal(request.text?.format?.type, undefined, "plain answers must not require JSON schema");
    assert.equal(request.store, false);
    assert.equal(request.tools, undefined);
    assert.ok(request.input[1].content.includes(excerpt.pages[0].text));
    return Response.json(direct ? { status: "completed", output_text: text } : {
      status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }],
    });
  };
  const provider = await requestDocumentQuestion({ OPENAI_API_KEY: "offline-test-sentinel", OPENAI_MODEL: "gpt-6-luna" }, "What is the paper about?", excerpt, mockedFetch);
  const output = validateDocumentQuestionOutput(provider.output, excerpt);
  assert.equal(output.outcome, "answered");
  assert.equal(output.answerParts[0].text, expected);
  assert.deepEqual(output.answerParts[0].evidence, []);
  assert.equal(output.insufficientSourceReason, null);
  // Exact existing storage payload shape remains JSON round-trip compatible.
  assert.deepEqual(JSON.parse(JSON.stringify(output.answerParts)), output.answerParts);
}
const plain = "The paper studies indexing. General background: indexing can speed up reads, though the excerpt does not establish every trade-off.";
await check(plain, plain);
const useful = "The paper reports faster queries; the excerpt leaves the experimental details uncertain.";
await check(JSON.stringify({ outcome: "answered", answerParts: [{ text: useful, evidence: [{ pageNumber: 999, referenceId: "bad", quote: "invented citation" }] }], insufficientSourceReason: null, warnings: "invalid optional data" }), useful, true);

const env = { OPENAI_API_KEY: "offline-test-sentinel", OPENAI_MODEL: "gpt-6-luna" };
const metadataExcerpt = { ...excerpt, clipped: false };
const metadataValues = { title: "A useful normalized title", authors: ["Sample Author"], year: 2025, abstract: "A useful paper description, not a literal source substring." };
function mockResponse(text, kind) {
  return async (_url, init) => {
    mockedRequests += 1;
    const request = JSON.parse(init.body);
    assert.ok(request.input[1].content.includes(excerpt.pages[0].text));
    assert.equal(request.store, false);
    assert.equal(request.tools, undefined);
    if (kind === "metadata") {
      assert.deepEqual(request.text.format.schema.required, ["title", "authors", "year", "abstract"]);
      assert.equal(request.text.format.schema.properties.evidence, undefined);
    } else assert.equal(request.text?.format, undefined);
    return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }] });
  };
}
const metadataProvider = await requestDocumentMetadata(env, metadataExcerpt, mockResponse(JSON.stringify(metadataValues), "metadata"));
const metadata = validateMetadataOutput(metadataProvider.output, metadataExcerpt);
assert.deepEqual({ title: metadata.title, authors: metadata.authors, year: metadata.year, abstract: metadata.abstract }, metadataValues);
assert.deepEqual(metadata.evidence, { title: [], authors: [], year: [], abstract: [] });
assert.deepEqual(validateMetadataOutput({ ...metadataValues, evidence: "bad optional evidence" }, metadataExcerpt).evidence, metadata.evidence);
assert.equal(validateMetadataOutput({ title: null, authors: null, year: null, abstract: null }, metadataExcerpt).title, null);
const summaryText = "The selected paper studies indexing and reports faster queries. The supplied excerpt does not describe the full evaluation setup.";
const summaryProvider = await requestDocumentSummary(env, excerpt, mockResponse(summaryText, "summary"));
const summary = validateDocumentSummaryOutput(summaryProvider.output, excerpt);
assert.equal(summary.overview.text, summaryText);
assert.deepEqual(summary.overview.evidence, []);
assert.equal(validateDocumentSummaryOutput({ overview: { text: summaryText, evidence: [{ pageNumber: 99, referenceId: -1 }] } }, excerpt).overview.text, summaryText);
assert.deepEqual(selectSummarySource({ pages: excerpt.pages, pageCount: 1 }).evidenceReferences, [], "source selection must not build citation references");

// Compile only the existing row-reading prefix, so we exercise actual cache/GET
// readers without importing the PDF parser or starting a database/runtime.
async function rowReader(file, name) {
  const source = await readFile(resolve(worker, file), "utf8");
  const firstAsync = source.indexOf("\nasync function");
  assert.ok(firstAsync > 0);
  const compiled = ts.transpileModule(source.slice(0, firstAsync), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText.replace(/^import .*?;\s*$/gmu, "").replace(/^export \{\};?\s*$/gmu, "");
  return new Function("METADATA_MAX_TEXT_BYTES", "SUMMARY_MAX_TEXT_BYTES", `${compiled}\nreturn ${name};`)(24_000, 96 * 1024);
}
const commonRow = {
  document_id: "11111111-1111-4111-8111-111111111111", source_sha256: "a".repeat(64),
  extraction_parser: "unpdf", extraction_parser_version: "1.8.1", extraction_extracted_at: "2026-01-01T00:00:00.000Z",
  model: "gpt-6-luna", prompt_version: "offline-fixture", schema_version: "offline-fixture",
  generated_at: "2026-01-01T00:00:01.000Z", created_at: "2026-01-01T00:00:01.000Z",
  source_excerpt_byte_count: 63, source_excerpt_clipped: 0, source_excerpt_truncated: 0,
  total_page_count: 1, source_coverage_warning: "All pages included.", selected_pages_json: "[1]",
  included_page_numbers_json: "[1]", included_page_ranges_json: '[{"startPage":1,"endPage":1}]', warnings_json: "[]",
};
const readMetadata = await rowReader("document-metadata.ts", "metadataFromRow");
const metadataRow = { ...commonRow, ...metadataValues, authors_json: JSON.stringify(metadata.authors), evidence_json: JSON.stringify(metadata.evidence) };
assert.deepEqual(readMetadata(metadataRow).evidence, metadata.evidence);
const readSummary = await rowReader("document-summary.ts", "summaryFromRow");
const summaryRow = { ...commonRow, overview_json: JSON.stringify(summary.overview), contributions_json: "[]", methods_json: "[]", findings_json: "[]", limitations_json: "[]" };
assert.equal(readSummary(summaryRow).overview.text, summaryText);
const readQuestion = await rowReader("document-questions.ts", "questionFromRow");
const questionRow = { ...commonRow, id: "22222222-2222-4222-8222-222222222222", question: "What is the paper about?", normalized_question: "What is the paper about?", extraction_fingerprint: "b".repeat(64), outcome: "answered", answer_parts_json: JSON.stringify([{ text: plain, evidence: [] }]), insufficient_source_reason: null };
assert.equal(readQuestion(questionRow).answerParts[0].text, plain);
const oldQuote = { pageNumber: 1, quote: "An earlier saved quote" };
assert.deepEqual(readSummary({ ...summaryRow, overview_json: JSON.stringify({ text: summaryText, evidence: [oldQuote] }) }).overview.evidence, [oldQuote]);
assert.deepEqual(readMetadata({ ...metadataRow, evidence_json: JSON.stringify({ ...metadata.evidence, title: [oldQuote] }) }).evidence.title, [oldQuote]);
assert.deepEqual(readQuestion({ ...questionRow, answer_parts_json: JSON.stringify([{ text: plain, evidence: [oldQuote] }]) }).answerParts[0].evidence, [oldQuote]);
console.log(JSON.stringify({ result: "passed", cases: ["metadata-without-evidence-or-literal-source-values", "ordinary-summary-without-evidence", "ordinary-answer-without-citations", "invalid-optional-evidence-does-not-discard-text", "saved-row-readers-and-legacy-records"], mockedRequests, liveProviderRequests: 0 }));
