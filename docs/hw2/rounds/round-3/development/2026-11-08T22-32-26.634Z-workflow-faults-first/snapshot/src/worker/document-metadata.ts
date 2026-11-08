import type {
  DocumentMetadata,
  DocumentMetadataEvidence,
  DocumentMetadataEvidenceQuote,
  DocumentMetadataField,
  DocumentMetadataResponse,
} from "./document-types.js";
import { DocumentError } from "./document-validation.js";
import { documentErrorResponse, findDocument, requireDocumentStorage, validDocumentId } from "./documents.js";
import { findExtraction } from "./extractions.js";
import { IntegrationError } from "./integration-errors.js";
import { generateWithRecovery } from "./generation-recovery.js";
import { requestDocumentMetadata, METADATA_PROMPT_VERSION } from "./metadata-openai.js";
import { selectMetadataSource, METADATA_MAX_TEXT_BYTES } from "./metadata-source.js";
import { validateMetadataOutput } from "./metadata-validation.js";
import type { WorkerEnv } from "./storage.js";

interface MetadataRow {
  document_id: string;
  source_sha256: string;
  extraction_parser: "unpdf";
  extraction_parser_version: string;
  extraction_extracted_at: string;
  selected_pages_json: string;
  source_excerpt_byte_count: number;
  source_excerpt_clipped: number;
  model: string;
  prompt_version: string;
  generated_at: string;
  title: string | null;
  authors_json: string | null;
  year: number | null;
  abstract: string | null;
  evidence_json: string;
  warnings_json: string;
}

const METADATA_COLUMNS = "document_id, source_sha256, extraction_parser, extraction_parser_version, extraction_extracted_at, selected_pages_json, source_excerpt_byte_count, source_excerpt_clipped, model, prompt_version, generated_at, title, authors_json, year, abstract, evidence_json, warnings_json";
const SHA256 = /^[a-f0-9]{64}$/u;
const FIELDS: DocumentMetadataField[] = ["title", "authors", "year", "abstract"];
const CLAIM_LEASE_MS = 60_000;

function parseJson(value: string, name: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Stored ${name} is invalid.`);
  }
}

function isEvidenceQuote(value: unknown): value is DocumentMetadataEvidenceQuote {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2
    && Number.isInteger(record.pageNumber) && typeof record.quote === "string";
}

function metadataFromRow(row: MetadataRow): DocumentMetadata {
  const selectedPageNumbers = parseJson(row.selected_pages_json, "metadata page selection");
  const authors = row.authors_json === null ? null : parseJson(row.authors_json, "metadata authors");
  const evidence = parseJson(row.evidence_json, "metadata evidence");
  const warnings = parseJson(row.warnings_json, "metadata warnings");
  if (
    typeof row.document_id !== "string"
    || !SHA256.test(row.source_sha256)
    || row.extraction_parser !== "unpdf"
    || typeof row.extraction_parser_version !== "string" || row.extraction_parser_version.length === 0
    || typeof row.extraction_extracted_at !== "string"
    || !Array.isArray(selectedPageNumbers) || selectedPageNumbers.length < 1 || selectedPageNumbers.length > 3
    || !selectedPageNumbers.every((page, index) => Number.isInteger(page) && page > 0 && (index === 0 || page > selectedPageNumbers[index - 1]))
    || !Number.isInteger(row.source_excerpt_byte_count) || row.source_excerpt_byte_count < 0 || row.source_excerpt_byte_count > METADATA_MAX_TEXT_BYTES
    || ![0, 1].includes(row.source_excerpt_clipped)
    || typeof row.model !== "string" || row.model.length === 0
    || typeof row.prompt_version !== "string" || row.prompt_version.length === 0
    || typeof row.generated_at !== "string"
    || (row.title !== null && typeof row.title !== "string")
    || (row.year !== null && (!Number.isInteger(row.year) || row.year < 1000 || row.year > 2999))
    || (row.abstract !== null && typeof row.abstract !== "string")
    || (authors !== null && (!Array.isArray(authors) || !authors.every((author) => typeof author === "string")))
    || !Array.isArray(warnings) || !warnings.every((warning) => typeof warning === "string")
    || typeof evidence !== "object" || evidence === null || Array.isArray(evidence)
    || Object.keys(evidence).length !== FIELDS.length || !FIELDS.every((field) => Array.isArray((evidence as Record<string, unknown>)[field])
      && ((evidence as Record<string, unknown>)[field] as unknown[]).every(isEvidenceQuote))
  ) {
    throw new Error("Stored document metadata is invalid.");
  }
  return {
    documentId: row.document_id,
    sourceSha256: row.source_sha256,
    extractionParser: row.extraction_parser,
    extractionParserVersion: row.extraction_parser_version,
    extractionExtractedAt: row.extraction_extracted_at,
    selectedPageNumbers: selectedPageNumbers as number[],
    sourceExcerptByteCount: row.source_excerpt_byte_count,
    sourceExcerptClipped: row.source_excerpt_clipped === 1,
    model: row.model,
    promptVersion: row.prompt_version,
    generatedAt: row.generated_at,
    title: row.title,
    authors: authors as string[] | null,
    year: row.year,
    abstract: row.abstract,
    evidence: evidence as DocumentMetadataEvidence,
    warnings: warnings as string[],
  };
}

async function findMetadata(db: D1Database, documentId: string): Promise<DocumentMetadata | null> {
  const row = await db.prepare(`SELECT ${METADATA_COLUMNS} FROM document_metadata WHERE document_id = ?`)
    .bind(documentId).first<MetadataRow>();
  return row ? metadataFromRow(row) : null;
}

function providerError(error: unknown): DocumentError {
  if (error instanceof DocumentError) return error;
  if (!(error instanceof IntegrationError)) {
    return new DocumentError("metadata_provider_failure", 502, "The metadata provider failed unexpectedly.");
  }
  const mapped = {
    missing_configuration: ["metadata_missing_configuration", 424, "Metadata extraction is not configured."],
    authentication: ["metadata_authentication", 502, "The metadata provider rejected authentication."],
    quota_or_rate_limit: ["metadata_quota_or_rate_limit", 429, "The metadata provider is unavailable due to quota or rate limits."],
    model_access: ["metadata_model_access", 502, "The configured metadata model is unavailable."],
    timeout: ["metadata_timeout", 504, "Metadata extraction timed out."],
    refusal: ["metadata_refusal", 422, "The metadata provider refused the extraction request."],
    incomplete_response: ["metadata_incomplete", 502, "The metadata provider returned an incomplete response."],
    malformed_response: ["metadata_invalid_response", 502, "The metadata provider returned invalid metadata."],
    network_failure: ["metadata_provider_failure", 502, "The metadata provider could not be reached."],
    upstream_error: ["metadata_provider_failure", 502, "The metadata provider returned an error."],
  } as const;
  const [kind, status, message] = mapped[error.kind];
  return new DocumentError(kind, status, message);
}

async function acquireClaim(db: D1Database, documentId: string, ownerToken: string, now: string, expiresAt: string): Promise<boolean> {
  const [expired, claimed] = await db.batch([
    db.prepare("DELETE FROM document_metadata_claims WHERE expires_at <= ?").bind(now),
    db.prepare("INSERT INTO document_metadata_claims (document_id, owner_token, expires_at) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM uploaded_documents WHERE id = ? AND status = 'stored') ON CONFLICT(document_id) DO NOTHING")
      .bind(documentId, ownerToken, expiresAt, documentId),
  ]);
  if (!expired.success || !claimed.success) throw new Error("Metadata claim operation failed.");
  return claimed.meta.changes === 1;
}

async function releaseClaim(db: D1Database, documentId: string, ownerToken: string): Promise<void> {
  await db.prepare("DELETE FROM document_metadata_claims WHERE document_id = ? AND owner_token = ?")
    .bind(documentId, ownerToken).run();
}

async function persistMetadata(
  db: D1Database,
  metadata: DocumentMetadata,
  ownerToken: string,
  now: string,
): Promise<{ metadata: DocumentMetadata; created: boolean }> {
  const [inserted, released, selected] = await db.batch([
    db.prepare(`INSERT INTO document_metadata (${METADATA_COLUMNS})
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM document_metadata_claims WHERE document_id = ? AND owner_token = ? AND expires_at > ?)
      AND EXISTS (SELECT 1 FROM uploaded_documents WHERE id = ? AND status = 'stored')
      ON CONFLICT(document_id) DO NOTHING`)
      .bind(
        metadata.documentId, metadata.sourceSha256, metadata.extractionParser, metadata.extractionParserVersion,
        metadata.extractionExtractedAt, JSON.stringify(metadata.selectedPageNumbers), metadata.sourceExcerptByteCount,
        metadata.sourceExcerptClipped ? 1 : 0, metadata.model, metadata.promptVersion, metadata.generatedAt,
        metadata.title, metadata.authors === null ? null : JSON.stringify(metadata.authors), metadata.year, metadata.abstract,
        JSON.stringify(metadata.evidence), JSON.stringify(metadata.warnings), metadata.documentId, ownerToken, now, metadata.documentId,
      ),
    db.prepare("DELETE FROM document_metadata_claims WHERE document_id = ? AND owner_token = ?").bind(metadata.documentId, ownerToken),
    db.prepare(`SELECT ${METADATA_COLUMNS} FROM document_metadata WHERE document_id = ?`).bind(metadata.documentId),
  ]);
  if (!inserted.success || !released.success || !selected.success) throw new Error("Metadata persistence failed.");
  if (selected.results.length !== 1) {
    throw new DocumentError("metadata_in_progress", 409, "Metadata generation is in progress; try again after the active request finishes.");
  }
  return { metadata: metadataFromRow(selected.results[0] as MetadataRow), created: inserted.meta.changes === 1 };
}

async function requireEmptyBody(request: Request): Promise<void> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && declaredLength !== "0") {
    throw new DocumentError("invalid_request", 400, "Metadata generation does not accept a request body.");
  }
  if (!request.body) return;
  const reader = request.body.getReader();
  try {
    const first = await reader.read();
    if (!first.done) throw new DocumentError("invalid_request", 400, "Metadata generation does not accept a request body.");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function generateMetadata(env: WorkerEnv, rawId: string): Promise<{ metadata: DocumentMetadata; created: boolean }> {
  const id = validDocumentId(rawId);
  const { db } = requireDocumentStorage(env);
  const document = await findDocument(db, id);
  if (!document) throw new DocumentError("document_not_found", 404, "The uploaded document was not found.");
  const extraction = await findExtraction(db, id);
  if (!extraction) throw new DocumentError("extraction_not_found", 404, "The uploaded document has not been extracted.");
  const cached = await findMetadata(db, id);
  if (cached) return { metadata: cached, created: false };
  if (!env.OPENAI_API_KEY?.trim()) throw new DocumentError("metadata_missing_configuration", 424, "Metadata extraction is not configured.");

  const ownerToken = crypto.randomUUID();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + CLAIM_LEASE_MS).toISOString();
  if (!await acquireClaim(db, id, ownerToken, now, expiresAt)) {
    const savedDuringClaim = await findMetadata(db, id);
    if (savedDuringClaim) return { metadata: savedDuringClaim, created: false };
    throw new DocumentError("metadata_in_progress", 409, "Metadata generation is in progress; try again after the active request finishes.");
  }

  try {
    // A just-finished concurrent winner can release its claim between our first
    // cache read and claim acquisition. Check once more before contacting OpenAI.
    const savedAfterClaim = await findMetadata(db, id);
    if (savedAfterClaim) {
      await releaseClaim(db, id, ownerToken);
      return { metadata: savedAfterClaim, created: false };
    }
    const excerpt = selectMetadataSource(extraction);
    let provider;
    try {
      provider = await generateWithRecovery("metadata",
        (remaining, correction) => requestDocumentMetadata(env, excerpt, fetch, remaining, correction),
        (output) => validateMetadataOutput(output, excerpt),
        async () => {
          if (!await findDocument(db, id)) throw new DocumentError("document_not_found", 404, "The uploaded document was deleted.");
          const owned = await db.prepare("SELECT 1 FROM document_metadata_claims WHERE document_id = ? AND owner_token = ? AND expires_at > ?")
            .bind(id, ownerToken, new Date().toISOString()).first();
          if (!owned) throw new DocumentError("metadata_in_progress", 409, "Generation ownership expired. Reload saved results before retrying.");
        });
    } catch (error) {
      throw providerError(error);
    }
    const output = provider.output;
    const metadata: DocumentMetadata = {
      documentId: id,
      sourceSha256: extraction.sourceSha256,
      extractionParser: extraction.parser,
      extractionParserVersion: extraction.parserVersion,
      extractionExtractedAt: extraction.extractedAt,
      selectedPageNumbers: excerpt.pageNumbers,
      sourceExcerptByteCount: excerpt.byteCount,
      sourceExcerptClipped: excerpt.clipped,
      model: provider.model,
      promptVersion: METADATA_PROMPT_VERSION,
      generatedAt: new Date().toISOString(),
      ...output,
    };
    return await persistMetadata(db, metadata, ownerToken, new Date().toISOString());
  } finally {
    // Success releases this exact owner in the persistence batch. Failed calls
    // only remove their own lease and never disturb a later owner.
    await releaseClaim(db, id, ownerToken).catch(() => undefined);
  }
}

export async function handleDocumentMetadata(request: Request, env: WorkerEnv, rawId: string): Promise<Response> {
  const headers: Record<string, string> = { "cache-control": "no-store" };
  try {
    if (request.method === "GET") {
      const id = validDocumentId(rawId);
      const { db } = requireDocumentStorage(env);
      const document = await findDocument(db, id);
      if (!document) throw new DocumentError("document_not_found", 404, "The uploaded document was not found.");
      const extraction = await findExtraction(db, id);
      if (!extraction) throw new DocumentError("extraction_not_found", 404, "The uploaded document has not been extracted.");
      const metadata = await findMetadata(db, id);
      if (!metadata) throw new DocumentError("metadata_not_found", 404, "The uploaded document metadata has not been generated.");
      const response: DocumentMetadataResponse = { metadata };
      return Response.json(response, { headers });
    }
    if (request.method === "POST") {
      await requireEmptyBody(request);
      const result = await generateMetadata(env, rawId);
      const response: DocumentMetadataResponse = { metadata: result.metadata, created: result.created };
      return Response.json(response, { status: result.created ? 201 : 200, headers });
    }
    headers.Allow = "GET, POST";
    throw new DocumentError("method_not_allowed", 405, "Use GET or POST for document metadata.");
  } catch (error) {
    return documentErrorResponse(error, headers);
  }
}
