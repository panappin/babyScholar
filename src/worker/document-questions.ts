import type {
  DocumentQuestionAnswerPart,
  DocumentQuestionEvidenceQuote,
  DocumentQuestionRecord,
  DocumentQuestionResponse,
  DocumentQuestionOutcome,
  DocumentSummaryPageRange,
  ListDocumentQuestionsResponse,
} from "./document-types.js";
import { DocumentError } from "./document-validation.js";
import { documentErrorResponse, findDocument, requireDocumentStorage, validDocumentId } from "./documents.js";
import { findExtraction } from "./extractions.js";
import { IntegrationError } from "./integration-errors.js";
import { QUESTION_PROMPT_VERSION, QUESTION_SCHEMA_VERSION, requestDocumentQuestion } from "./question-openai.js";
import { readDocumentQuestion, type ValidatedDocumentQuestion } from "./question-request.js";
import { validateDocumentQuestionOutput } from "./question-validation.js";
import { selectSummarySource, SUMMARY_MAX_TEXT_BYTES } from "./summary-source.js";
import type { WorkerEnv } from "./storage.js";

interface QuestionRow {
  id: string;
  document_id: string;
  question: string;
  normalized_question: string;
  source_sha256: string;
  extraction_parser: "unpdf";
  extraction_parser_version: string;
  extraction_extracted_at: string;
  extraction_fingerprint: string;
  total_page_count: number;
  included_page_numbers_json: string;
  included_page_ranges_json: string;
  source_excerpt_byte_count: number;
  source_excerpt_truncated: number;
  source_coverage_warning: string;
  model: string;
  prompt_version: string;
  schema_version: string;
  outcome: DocumentQuestionOutcome;
  answer_parts_json: string;
  insufficient_source_reason: string | null;
  warnings_json: string;
  created_at: string;
}

const QUESTION_COLUMNS = "id, document_id, question, normalized_question, source_sha256, extraction_parser, extraction_parser_version, extraction_extracted_at, extraction_fingerprint, total_page_count, included_page_numbers_json, included_page_ranges_json, source_excerpt_byte_count, source_excerpt_truncated, source_coverage_warning, model, prompt_version, schema_version, outcome, answer_parts_json, insufficient_source_reason, warnings_json, created_at";
const SHA256 = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const CLAIM_LEASE_MS = 60_000;
const encoder = new TextEncoder();

function parseJson(value: string, name: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Stored ${name} is invalid.`);
  }
}

function isEvidenceQuote(value: unknown): value is DocumentQuestionEvidenceQuote {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2 && Number.isInteger(record.pageNumber) && typeof record.quote === "string";
}

function isAnswerPart(value: unknown): value is DocumentQuestionAnswerPart {
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

function questionFromRow(row: QuestionRow): DocumentQuestionRecord {
  const includedPageNumbers = parseJson(row.included_page_numbers_json, "question page numbers");
  const includedPageRanges = parseJson(row.included_page_ranges_json, "question page ranges");
  const answerParts = parseJson(row.answer_parts_json, "question answer parts");
  const warnings = parseJson(row.warnings_json, "question warnings");
  const validAnswered = row.outcome === "answered" && Array.isArray(answerParts) && answerParts.length > 0
    && answerParts.every(isAnswerPart) && row.insufficient_source_reason === null;
  const validInsufficient = row.outcome === "insufficient_source" && Array.isArray(answerParts) && answerParts.length === 0
    && typeof row.insufficient_source_reason === "string" && row.insufficient_source_reason.length > 0;
  if (
    !UUID.test(row.id)
    || !UUID.test(row.document_id)
    || typeof row.question !== "string" || row.question.length === 0 || row.question !== row.question.trim()
    || typeof row.normalized_question !== "string" || row.normalized_question.length === 0
    || !SHA256.test(row.source_sha256)
    || row.extraction_parser !== "unpdf"
    || typeof row.extraction_parser_version !== "string" || row.extraction_parser_version.length === 0
    || typeof row.extraction_extracted_at !== "string"
    || !SHA256.test(row.extraction_fingerprint)
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
    || !(validAnswered || validInsufficient)
    || !Array.isArray(warnings) || !warnings.every((warning) => typeof warning === "string")
    || typeof row.created_at !== "string"
  ) {
    throw new Error("Stored document question is invalid.");
  }
  return {
    id: row.id,
    documentId: row.document_id,
    question: row.question,
    normalizedQuestion: row.normalized_question,
    sourceSha256: row.source_sha256,
    extractionParser: row.extraction_parser,
    extractionParserVersion: row.extraction_parser_version,
    extractionExtractedAt: row.extraction_extracted_at,
    extractionFingerprint: row.extraction_fingerprint,
    totalPageCount: row.total_page_count,
    includedPageNumbers: includedPageNumbers as number[],
    includedPageRanges: includedPageRanges as DocumentSummaryPageRange[],
    sourceExcerptByteCount: row.source_excerpt_byte_count,
    sourceExcerptTruncated: row.source_excerpt_truncated === 1,
    sourceCoverageWarning: row.source_coverage_warning,
    model: row.model,
    promptVersion: row.prompt_version,
    schemaVersion: row.schema_version,
    outcome: row.outcome,
    answerParts: answerParts as DocumentQuestionAnswerPart[],
    insufficientSourceReason: row.insufficient_source_reason,
    warnings: warnings as string[],
    createdAt: row.created_at,
  };
}

async function extractionFingerprint(extraction: Awaited<ReturnType<typeof findExtraction>> & object): Promise<string> {
  const provenance = JSON.stringify({
    sourceSha256: extraction.sourceSha256,
    parser: extraction.parser,
    parserVersion: extraction.parserVersion,
    extractedAt: extraction.extractedAt,
  });
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(provenance));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function findQuestion(
  db: D1Database,
  documentId: string,
  normalizedQuestion: string,
  fingerprint: string,
): Promise<DocumentQuestionRecord | null> {
  const row = await db.prepare(`SELECT ${QUESTION_COLUMNS} FROM document_questions WHERE document_id = ? AND normalized_question = ? AND extraction_fingerprint = ?`)
    .bind(documentId, normalizedQuestion, fingerprint).first<QuestionRow>();
  return row ? questionFromRow(row) : null;
}

async function listQuestions(db: D1Database, documentId: string): Promise<DocumentQuestionRecord[]> {
  const rows = await db.prepare(`SELECT ${QUESTION_COLUMNS} FROM document_questions WHERE document_id = ? ORDER BY created_at DESC, id DESC`)
    .bind(documentId).all<QuestionRow>();
  if (!rows.success) throw new Error("Question list failed.");
  return rows.results.map(questionFromRow);
}

function providerError(error: unknown): DocumentError {
  if (!(error instanceof IntegrationError)) {
    return new DocumentError("question_provider_failure", 502, "The question provider failed unexpectedly.");
  }
  const mapped = {
    missing_configuration: ["question_missing_configuration", 424, "Document question answering is not configured."],
    authentication: ["question_authentication", 502, "The question provider rejected authentication."],
    quota_or_rate_limit: ["question_quota_or_rate_limit", 429, "The question provider is unavailable due to quota or rate limits."],
    model_access: ["question_model_access", 502, "The configured question model is unavailable."],
    timeout: ["question_timeout", 504, "Document question answering timed out."],
    refusal: ["question_refusal", 422, "The question provider refused the request."],
    incomplete_response: ["question_incomplete", 502, "The question provider returned an incomplete response."],
    malformed_response: ["question_invalid_response", 502, "The question provider returned invalid question data."],
    network_failure: ["question_provider_failure", 502, "The question provider could not be reached."],
    upstream_error: ["question_provider_failure", 502, "The question provider returned an error."],
  } as const;
  const [kind, status, message] = mapped[error.kind];
  return new DocumentError(kind, status, message);
}

async function acquireClaim(
  db: D1Database,
  documentId: string,
  normalizedQuestion: string,
  fingerprint: string,
  ownerToken: string,
  now: string,
  expiresAt: string,
): Promise<boolean> {
  const [expired, claimed] = await db.batch([
    db.prepare("DELETE FROM document_question_claims WHERE expires_at <= ?").bind(now),
    db.prepare("INSERT INTO document_question_claims (document_id, normalized_question, extraction_fingerprint, owner_token, expires_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(document_id, normalized_question, extraction_fingerprint) DO NOTHING")
      .bind(documentId, normalizedQuestion, fingerprint, ownerToken, expiresAt),
  ]);
  if (!expired.success || !claimed.success) throw new Error("Question claim operation failed.");
  return claimed.meta.changes === 1;
}

async function releaseClaim(db: D1Database, documentId: string, normalizedQuestion: string, fingerprint: string, ownerToken: string): Promise<void> {
  await db.prepare("DELETE FROM document_question_claims WHERE document_id = ? AND normalized_question = ? AND extraction_fingerprint = ? AND owner_token = ?")
    .bind(documentId, normalizedQuestion, fingerprint, ownerToken).run();
}

async function persistQuestion(
  db: D1Database,
  record: DocumentQuestionRecord,
  ownerToken: string,
  now: string,
): Promise<{ question: DocumentQuestionRecord; created: boolean }> {
  const [inserted, released, selected] = await db.batch([
    db.prepare(`INSERT INTO document_questions (${QUESTION_COLUMNS})
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM document_question_claims WHERE document_id = ? AND normalized_question = ? AND extraction_fingerprint = ? AND owner_token = ? AND expires_at > ?)
      ON CONFLICT(document_id, normalized_question, extraction_fingerprint) DO NOTHING`)
      .bind(
        record.id, record.documentId, record.question, record.normalizedQuestion, record.sourceSha256,
        record.extractionParser, record.extractionParserVersion, record.extractionExtractedAt, record.extractionFingerprint,
        record.totalPageCount, JSON.stringify(record.includedPageNumbers), JSON.stringify(record.includedPageRanges),
        record.sourceExcerptByteCount, record.sourceExcerptTruncated ? 1 : 0, record.sourceCoverageWarning,
        record.model, record.promptVersion, record.schemaVersion, record.outcome, JSON.stringify(record.answerParts),
        record.insufficientSourceReason, JSON.stringify(record.warnings), record.createdAt,
        record.documentId, record.normalizedQuestion, record.extractionFingerprint, ownerToken, now,
      ),
    db.prepare("DELETE FROM document_question_claims WHERE document_id = ? AND normalized_question = ? AND extraction_fingerprint = ? AND owner_token = ?")
      .bind(record.documentId, record.normalizedQuestion, record.extractionFingerprint, ownerToken),
    db.prepare(`SELECT ${QUESTION_COLUMNS} FROM document_questions WHERE document_id = ? AND normalized_question = ? AND extraction_fingerprint = ?`)
      .bind(record.documentId, record.normalizedQuestion, record.extractionFingerprint),
  ]);
  if (!inserted.success || !released.success || !selected.success) throw new Error("Question persistence failed.");
  if (selected.results.length !== 1) {
    throw new DocumentError("question_in_progress", 409, "Question generation is in progress; try again after the active request finishes.");
  }
  return { question: questionFromRow(selected.results[0] as QuestionRow), created: inserted.meta.changes === 1 };
}

async function generateQuestion(
  env: WorkerEnv,
  rawId: string,
  input: ValidatedDocumentQuestion,
): Promise<{ question: DocumentQuestionRecord; created: boolean }> {
  const documentId = validDocumentId(rawId);
  const { db } = requireDocumentStorage(env);
  const document = await findDocument(db, documentId);
  if (!document) throw new DocumentError("document_not_found", 404, "The uploaded document was not found.");
  const extraction = await findExtraction(db, documentId);
  if (!extraction) throw new DocumentError("extraction_not_found", 404, "The uploaded document has not been extracted.");
  const fingerprint = await extractionFingerprint(extraction);
  const cached = await findQuestion(db, documentId, input.normalizedQuestion, fingerprint);
  if (cached) return { question: cached, created: false };
  if (!env.OPENAI_API_KEY?.trim()) throw new DocumentError("question_missing_configuration", 424, "Document question answering is not configured.");

  const ownerToken = crypto.randomUUID();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + CLAIM_LEASE_MS).toISOString();
  if (!await acquireClaim(db, documentId, input.normalizedQuestion, fingerprint, ownerToken, now, expiresAt)) {
    const savedDuringClaim = await findQuestion(db, documentId, input.normalizedQuestion, fingerprint);
    if (savedDuringClaim) return { question: savedDuringClaim, created: false };
    throw new DocumentError("question_in_progress", 409, "Question generation is in progress; try again after the active request finishes.");
  }

  try {
    const savedAfterClaim = await findQuestion(db, documentId, input.normalizedQuestion, fingerprint);
    if (savedAfterClaim) {
      await releaseClaim(db, documentId, input.normalizedQuestion, fingerprint, ownerToken);
      return { question: savedAfterClaim, created: false };
    }
    const excerpt = selectSummarySource(extraction);
    let provider;
    try {
      provider = await requestDocumentQuestion(env, input.question, excerpt);
    } catch (error) {
      throw providerError(error);
    }
    const output = validateDocumentQuestionOutput(provider.output, excerpt);
    const record: DocumentQuestionRecord = {
      id: crypto.randomUUID(),
      documentId,
      question: input.question,
      normalizedQuestion: input.normalizedQuestion,
      sourceSha256: extraction.sourceSha256,
      extractionParser: extraction.parser,
      extractionParserVersion: extraction.parserVersion,
      extractionExtractedAt: extraction.extractedAt,
      extractionFingerprint: fingerprint,
      totalPageCount: excerpt.totalPageCount,
      includedPageNumbers: excerpt.pageNumbers,
      includedPageRanges: excerpt.pageRanges,
      sourceExcerptByteCount: excerpt.byteCount,
      sourceExcerptTruncated: excerpt.truncated,
      sourceCoverageWarning: excerpt.coverageWarning,
      model: provider.model,
      promptVersion: QUESTION_PROMPT_VERSION,
      schemaVersion: QUESTION_SCHEMA_VERSION,
      outcome: output.outcome,
      answerParts: output.answerParts,
      insufficientSourceReason: output.insufficientSourceReason,
      warnings: [...output.warnings, excerpt.coverageWarning],
      createdAt: new Date().toISOString(),
    };
    return await persistQuestion(db, record, ownerToken, new Date().toISOString());
  } finally {
    await releaseClaim(db, documentId, input.normalizedQuestion, fingerprint, ownerToken).catch(() => undefined);
  }
}

export async function handleDocumentQuestions(request: Request, env: WorkerEnv, rawId: string): Promise<Response> {
  const headers: Record<string, string> = { "cache-control": "no-store" };
  try {
    const documentId = validDocumentId(rawId);
    const { db } = requireDocumentStorage(env);
    const document = await findDocument(db, documentId);
    if (!document) throw new DocumentError("document_not_found", 404, "The uploaded document was not found.");
    const extraction = await findExtraction(db, documentId);
    if (!extraction) throw new DocumentError("extraction_not_found", 404, "The uploaded document has not been extracted.");
    if (request.method === "GET") {
      const response: ListDocumentQuestionsResponse = { questions: await listQuestions(db, documentId) };
      return Response.json(response, { headers });
    }
    if (request.method === "POST") {
      const input = await readDocumentQuestion(request);
      const result = await generateQuestion(env, documentId, input);
      const response: DocumentQuestionResponse = { question: result.question, created: result.created };
      return Response.json(response, { status: result.created ? 201 : 200, headers });
    }
    headers.Allow = "GET, POST";
    throw new DocumentError("method_not_allowed", 405, "Use GET or POST for document questions.");
  } catch (error) {
    return documentErrorResponse(error, headers);
  }
}
