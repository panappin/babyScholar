import type {
  DocumentSummary,
  DocumentSummaryEvidenceQuote,
  DocumentSummaryItem,
  DocumentSummaryPageRange,
  DocumentSummaryResponse,
  DocumentSummarySection,
} from "./document-types.js";
import { DocumentError } from "./document-validation.js";
import { documentErrorResponse, findDocument, requireDocumentStorage, validDocumentId } from "./documents.js";
import { findExtraction } from "./extractions.js";
import { IntegrationError } from "./integration-errors.js";
import { generateWithRecovery } from "./generation-recovery.js";
import {
  requestDocumentSummary,
  SUMMARY_PROMPT_VERSION,
  SUMMARY_SCHEMA_VERSION,
} from "./summary-openai.js";
import { selectSummarySource, SUMMARY_MAX_TEXT_BYTES } from "./summary-source.js";
import { validateDocumentSummaryOutput } from "./summary-validation.js";
import type { WorkerEnv } from "./storage.js";

interface SummaryRow {
  document_id: string;
  source_sha256: string;
  extraction_parser: "unpdf";
  extraction_parser_version: string;
  extraction_extracted_at: string;
  total_page_count: number;
  included_page_numbers_json: string;
  included_page_ranges_json: string;
  source_excerpt_byte_count: number;
  source_excerpt_truncated: number;
  source_coverage_warning: string;
  model: string;
  prompt_version: string;
  schema_version: string;
  created_at: string;
  overview_json: string;
  contributions_json: string;
  methods_json: string;
  findings_json: string;
  limitations_json: string;
  warnings_json: string;
}

const SUMMARY_COLUMNS = "document_id, source_sha256, extraction_parser, extraction_parser_version, extraction_extracted_at, total_page_count, included_page_numbers_json, included_page_ranges_json, source_excerpt_byte_count, source_excerpt_truncated, source_coverage_warning, model, prompt_version, schema_version, created_at, overview_json, contributions_json, methods_json, findings_json, limitations_json, warnings_json";
const SHA256 = /^[a-f0-9]{64}$/u;
const sections: DocumentSummarySection[] = ["contributions", "methods", "findings", "limitations"];
const CLAIM_LEASE_MS = 60_000;

function parseJson(value: string, name: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Stored ${name} is invalid.`);
  }
}

function isEvidenceQuote(value: unknown): value is DocumentSummaryEvidenceQuote {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2 && Number.isInteger(record.pageNumber) && typeof record.quote === "string";
}

function isItem(value: unknown): value is DocumentSummaryItem {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2 && typeof record.text === "string"
    && Array.isArray(record.evidence) && record.evidence.every(isEvidenceQuote);
}

function isPageRange(value: unknown): value is DocumentSummaryPageRange {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2 && Number.isInteger(record.startPage) && Number.isInteger(record.endPage)
    && (record.startPage as number) > 0 && (record.endPage as number) >= (record.startPage as number);
}

function summaryFromRow(row: SummaryRow): DocumentSummary {
  const includedPageNumbers = parseJson(row.included_page_numbers_json, "summary page numbers");
  const includedPageRanges = parseJson(row.included_page_ranges_json, "summary page ranges");
  const overview = parseJson(row.overview_json, "summary overview");
  const values = {
    contributions: parseJson(row.contributions_json, "summary contributions"),
    methods: parseJson(row.methods_json, "summary methods"),
    findings: parseJson(row.findings_json, "summary findings"),
    limitations: parseJson(row.limitations_json, "summary limitations"),
  } as const;
  const warnings = parseJson(row.warnings_json, "summary warnings");
  if (
    typeof row.document_id !== "string"
    || !SHA256.test(row.source_sha256)
    || row.extraction_parser !== "unpdf"
    || typeof row.extraction_parser_version !== "string" || row.extraction_parser_version.length === 0
    || typeof row.extraction_extracted_at !== "string"
    || !Number.isInteger(row.total_page_count) || row.total_page_count < 1
    || !Array.isArray(includedPageNumbers) || includedPageNumbers.length < 1 || includedPageNumbers.length > row.total_page_count
    || !includedPageNumbers.every((page, index) => Number.isInteger(page) && page > 0 && page <= row.total_page_count && (index === 0 || page > includedPageNumbers[index - 1]))
    || !Array.isArray(includedPageRanges) || includedPageRanges.length < 1 || !includedPageRanges.every(isPageRange)
    || !Number.isInteger(row.source_excerpt_byte_count) || row.source_excerpt_byte_count < 0 || row.source_excerpt_byte_count > SUMMARY_MAX_TEXT_BYTES
    || ![0, 1].includes(row.source_excerpt_truncated)
    || typeof row.source_coverage_warning !== "string" || row.source_coverage_warning.length === 0
    || typeof row.model !== "string" || row.model.length === 0
    || typeof row.prompt_version !== "string" || row.prompt_version.length === 0
    || typeof row.schema_version !== "string" || row.schema_version.length === 0
    || typeof row.created_at !== "string"
    || !isItem(overview)
    || !sections.every((section) => Array.isArray(values[section]) && values[section].every(isItem))
    || !Array.isArray(warnings) || !warnings.every((warning) => typeof warning === "string")
  ) {
    throw new Error("Stored document summary is invalid.");
  }
  return {
    documentId: row.document_id,
    sourceSha256: row.source_sha256,
    extractionParser: row.extraction_parser,
    extractionParserVersion: row.extraction_parser_version,
    extractionExtractedAt: row.extraction_extracted_at,
    totalPageCount: row.total_page_count,
    includedPageNumbers: includedPageNumbers as number[],
    includedPageRanges: includedPageRanges as DocumentSummaryPageRange[],
    sourceExcerptByteCount: row.source_excerpt_byte_count,
    sourceExcerptTruncated: row.source_excerpt_truncated === 1,
    sourceCoverageWarning: row.source_coverage_warning,
    model: row.model,
    promptVersion: row.prompt_version,
    schemaVersion: row.schema_version,
    createdAt: row.created_at,
    overview: overview as DocumentSummaryItem,
    contributions: values.contributions as DocumentSummaryItem[],
    methods: values.methods as DocumentSummaryItem[],
    findings: values.findings as DocumentSummaryItem[],
    limitations: values.limitations as DocumentSummaryItem[],
    warnings: warnings as string[],
  };
}

async function findSummary(db: D1Database, documentId: string): Promise<DocumentSummary | null> {
  const row = await db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM document_summaries WHERE document_id = ?`)
    .bind(documentId).first<SummaryRow>();
  return row ? summaryFromRow(row) : null;
}

function providerError(error: unknown): DocumentError {
  if (error instanceof DocumentError) return error;
  if (!(error instanceof IntegrationError)) {
    return new DocumentError("summary_provider_failure", 502, "The summary provider failed unexpectedly.");
  }
  const mapped = {
    missing_configuration: ["summary_missing_configuration", 424, "Summarization is not configured."],
    authentication: ["summary_authentication", 502, "The summary provider rejected authentication."],
    quota_or_rate_limit: ["summary_quota_or_rate_limit", 429, "The summary provider is unavailable due to quota or rate limits."],
    model_access: ["summary_model_access", 502, "The configured summary model is unavailable."],
    timeout: ["summary_timeout", 504, "Summarization timed out."],
    refusal: ["summary_refusal", 422, "The summary provider refused the request."],
    incomplete_response: ["summary_incomplete", 502, "The summary provider returned an incomplete response."],
    malformed_response: ["summary_invalid_response", 502, "The summary provider returned invalid summary data."],
    network_failure: ["summary_provider_failure", 502, "The summary provider could not be reached."],
    upstream_error: ["summary_provider_failure", 502, "The summary provider returned an error."],
  } as const;
  const [kind, status, message] = mapped[error.kind];
  return new DocumentError(kind, status, message);
}

async function acquireClaim(db: D1Database, documentId: string, ownerToken: string, now: string, expiresAt: string): Promise<boolean> {
  const [expired, claimed] = await db.batch([
    db.prepare("DELETE FROM document_summary_claims WHERE expires_at <= ?").bind(now),
    db.prepare("INSERT INTO document_summary_claims (document_id, owner_token, expires_at) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM uploaded_documents WHERE id = ? AND status = 'stored') ON CONFLICT(document_id) DO NOTHING")
      .bind(documentId, ownerToken, expiresAt, documentId),
  ]);
  if (!expired.success || !claimed.success) throw new Error("Summary claim operation failed.");
  return claimed.meta.changes === 1;
}

async function releaseClaim(db: D1Database, documentId: string, ownerToken: string): Promise<void> {
  await db.prepare("DELETE FROM document_summary_claims WHERE document_id = ? AND owner_token = ?")
    .bind(documentId, ownerToken).run();
}

async function persistSummary(
  db: D1Database,
  summary: DocumentSummary,
  ownerToken: string,
  now: string,
): Promise<{ summary: DocumentSummary; created: boolean }> {
  const [inserted, released, selected] = await db.batch([
    db.prepare(`INSERT INTO document_summaries (${SUMMARY_COLUMNS})
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM document_summary_claims WHERE document_id = ? AND owner_token = ? AND expires_at > ?)
      AND EXISTS (SELECT 1 FROM uploaded_documents WHERE id = ? AND status = 'stored')
      ON CONFLICT(document_id) DO NOTHING`)
      .bind(
        summary.documentId, summary.sourceSha256, summary.extractionParser, summary.extractionParserVersion,
        summary.extractionExtractedAt, summary.totalPageCount, JSON.stringify(summary.includedPageNumbers),
        JSON.stringify(summary.includedPageRanges), summary.sourceExcerptByteCount, summary.sourceExcerptTruncated ? 1 : 0,
        summary.sourceCoverageWarning, summary.model, summary.promptVersion, summary.schemaVersion, summary.createdAt,
        JSON.stringify(summary.overview), JSON.stringify(summary.contributions), JSON.stringify(summary.methods),
        JSON.stringify(summary.findings), JSON.stringify(summary.limitations), JSON.stringify(summary.warnings),
        summary.documentId, ownerToken, now, summary.documentId,
      ),
    db.prepare("DELETE FROM document_summary_claims WHERE document_id = ? AND owner_token = ?").bind(summary.documentId, ownerToken),
    db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM document_summaries WHERE document_id = ?`).bind(summary.documentId),
  ]);
  if (!inserted.success || !released.success || !selected.success) throw new Error("Summary persistence failed.");
  if (selected.results.length !== 1) {
    throw new DocumentError("summary_in_progress", 409, "Summary generation is in progress; try again after the active request finishes.");
  }
  return { summary: summaryFromRow(selected.results[0] as SummaryRow), created: inserted.meta.changes === 1 };
}

async function requireEmptyBody(request: Request): Promise<void> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && declaredLength !== "0") {
    throw new DocumentError("invalid_request", 400, "Summary generation does not accept a request body.");
  }
  if (!request.body) return;
  const reader = request.body.getReader();
  try {
    const first = await reader.read();
    if (!first.done) throw new DocumentError("invalid_request", 400, "Summary generation does not accept a request body.");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function generateSummary(env: WorkerEnv, rawId: string): Promise<{ summary: DocumentSummary; created: boolean }> {
  const id = validDocumentId(rawId);
  const { db } = requireDocumentStorage(env);
  const document = await findDocument(db, id);
  if (!document) throw new DocumentError("document_not_found", 404, "The uploaded document was not found.");
  const extraction = await findExtraction(db, id);
  if (!extraction) throw new DocumentError("extraction_not_found", 404, "The uploaded document has not been extracted.");
  const cached = await findSummary(db, id);
  if (cached) return { summary: cached, created: false };
  if (!env.OPENAI_API_KEY?.trim()) throw new DocumentError("summary_missing_configuration", 424, "Summarization is not configured.");

  const ownerToken = crypto.randomUUID();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + CLAIM_LEASE_MS).toISOString();
  if (!await acquireClaim(db, id, ownerToken, now, expiresAt)) {
    const savedDuringClaim = await findSummary(db, id);
    if (savedDuringClaim) return { summary: savedDuringClaim, created: false };
    throw new DocumentError("summary_in_progress", 409, "Summary generation is in progress; try again after the active request finishes.");
  }

  try {
    const savedAfterClaim = await findSummary(db, id);
    if (savedAfterClaim) {
      await releaseClaim(db, id, ownerToken);
      return { summary: savedAfterClaim, created: false };
    }
    const excerpt = selectSummarySource(extraction);
    let provider;
    try {
      provider = await generateWithRecovery("summary",
        (remaining, correction) => requestDocumentSummary(env, excerpt, fetch, remaining, correction),
        (output) => validateDocumentSummaryOutput(output, excerpt),
        async () => {
          if (!await findDocument(db, id)) throw new DocumentError("document_not_found", 404, "The uploaded document was deleted.");
          const owned = await db.prepare("SELECT 1 FROM document_summary_claims WHERE document_id = ? AND owner_token = ? AND expires_at > ?")
            .bind(id, ownerToken, new Date().toISOString()).first();
          if (!owned) throw new DocumentError("summary_in_progress", 409, "Generation ownership expired. Reload saved results before retrying.");
        });
    } catch (error) {
      throw providerError(error);
    }
    const output = provider.output;
    const summary: DocumentSummary = {
      documentId: id,
      sourceSha256: extraction.sourceSha256,
      extractionParser: extraction.parser,
      extractionParserVersion: extraction.parserVersion,
      extractionExtractedAt: extraction.extractedAt,
      totalPageCount: excerpt.totalPageCount,
      includedPageNumbers: excerpt.pageNumbers,
      includedPageRanges: excerpt.pageRanges,
      sourceExcerptByteCount: excerpt.byteCount,
      sourceExcerptTruncated: excerpt.truncated,
      sourceCoverageWarning: excerpt.coverageWarning,
      model: provider.model,
      promptVersion: SUMMARY_PROMPT_VERSION,
      schemaVersion: SUMMARY_SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      ...output,
      warnings: [...output.warnings, excerpt.coverageWarning],
    };
    return await persistSummary(db, summary, ownerToken, new Date().toISOString());
  } finally {
    await releaseClaim(db, id, ownerToken).catch(() => undefined);
  }
}

export async function handleDocumentSummary(request: Request, env: WorkerEnv, rawId: string): Promise<Response> {
  const headers: Record<string, string> = { "cache-control": "no-store" };
  try {
    if (request.method === "GET") {
      const id = validDocumentId(rawId);
      const { db } = requireDocumentStorage(env);
      const document = await findDocument(db, id);
      if (!document) throw new DocumentError("document_not_found", 404, "The uploaded document was not found.");
      const extraction = await findExtraction(db, id);
      if (!extraction) throw new DocumentError("extraction_not_found", 404, "The uploaded document has not been extracted.");
      const summary = await findSummary(db, id);
      if (!summary) throw new DocumentError("summary_not_found", 404, "The uploaded document summary has not been generated.");
      const response: DocumentSummaryResponse = { summary };
      return Response.json(response, { headers });
    }
    if (request.method === "POST") {
      await requireEmptyBody(request);
      const result = await generateSummary(env, rawId);
      const response: DocumentSummaryResponse = { summary: result.summary, created: result.created };
      return Response.json(response, { status: result.created ? 201 : 200, headers });
    }
    headers.Allow = "GET, POST";
    throw new DocumentError("method_not_allowed", 405, "Use GET or POST for document summaries.");
  } catch (error) {
    return documentErrorResponse(error, headers);
  }
}
