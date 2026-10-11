import type {
  DocumentExtraction,
  ExtractDocumentResponse,
  GetDocumentTextResponse,
  DocumentTextPage,
} from "./document-types.js";
import { DocumentError } from "./document-validation.js";
import {
  documentErrorResponse,
  findDocument,
  requireDocumentStorage,
  validDocumentId,
  type DocumentRow,
} from "./documents.js";
import { extractPdfText } from "./pdf-text.js";
import type { WorkerEnv } from "./storage.js";

interface ExtractionRow {
  document_id: string;
  source_sha256: string;
  parser: "unpdf";
  parser_version: string;
  extracted_at: string;
  page_count: number;
  pages_json: string;
}

const EXTRACTION_COLUMNS = "document_id, source_sha256, parser, parser_version, extracted_at, page_count, pages_json";
const SHA256 = /^[a-f0-9]{64}$/u;

async function sourceSha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function extractionFromRow(row: ExtractionRow): DocumentExtraction {
  let pages: unknown;
  try {
    pages = JSON.parse(row.pages_json);
  } catch {
    throw new Error("Stored extraction page data is invalid.");
  }
  if (
    typeof row.document_id !== "string"
    || !SHA256.test(row.source_sha256)
    || row.parser !== "unpdf"
    || typeof row.parser_version !== "string"
    || row.parser_version.length === 0
    || typeof row.extracted_at !== "string"
    || !Number.isInteger(row.page_count)
    || row.page_count < 1
    || !Array.isArray(pages)
    || pages.length !== row.page_count
    || !pages.every((page, index) => {
      const candidate = page as { pageNumber?: unknown; text?: unknown };
      return typeof candidate === "object" && candidate !== null
        && candidate.pageNumber === index + 1 && typeof candidate.text === "string";
    })
  ) {
    throw new Error("Stored extraction metadata is invalid.");
  }
  return {
    documentId: row.document_id,
    sourceSha256: row.source_sha256,
    parser: row.parser,
    parserVersion: row.parser_version,
    extractedAt: row.extracted_at,
    pageCount: row.page_count,
    pages: pages as DocumentTextPage[],
  };
}

export async function findExtraction(db: D1Database, documentId: string): Promise<DocumentExtraction | null> {
  const row = await db.prepare(`SELECT ${EXTRACTION_COLUMNS} FROM document_extractions WHERE document_id = ?`)
    .bind(documentId).first<ExtractionRow>();
  return row ? extractionFromRow(row) : null;
}

async function readOriginalBytes(bucket: R2Bucket, document: DocumentRow): Promise<Uint8Array> {
  let object: R2ObjectBody | null;
  try {
    object = await bucket.get(document.object_key);
  } catch {
    throw new DocumentError("storage_unavailable", 503, "The document storage is unavailable.");
  }
  if (!object) throw new DocumentError("object_missing", 404, "The uploaded document bytes are unavailable.");
  try {
    return new Uint8Array(await object.arrayBuffer());
  } catch {
    throw new DocumentError("storage_unavailable", 503, "The document storage is unavailable.");
  }
}

async function persistExtraction(
  db: D1Database,
  extraction: DocumentExtraction,
): Promise<{ extraction: DocumentExtraction; created: boolean }> {
  const row: ExtractionRow = {
    document_id: extraction.documentId,
    source_sha256: extraction.sourceSha256,
    parser: extraction.parser,
    parser_version: extraction.parserVersion,
    extracted_at: extraction.extractedAt,
    page_count: extraction.pageCount,
    pages_json: JSON.stringify(extraction.pages),
  };
  const [inserted, selected] = await db.batch([
    db.prepare(`INSERT INTO document_extractions (${EXTRACTION_COLUMNS}) SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM uploaded_documents WHERE id = ? AND status = 'stored') ON CONFLICT(document_id) DO NOTHING`)
      .bind(row.document_id, row.source_sha256, row.parser, row.parser_version, row.extracted_at, row.page_count, row.pages_json, row.document_id),
    db.prepare(`SELECT ${EXTRACTION_COLUMNS} FROM document_extractions WHERE document_id = ?`).bind(row.document_id),
  ]);
  if (inserted.success && selected.success && selected.results.length === 0) {
    throw new DocumentError("document_deleting", 409, "The PDF was deleted while extraction was running.");
  }
  if (!inserted.success || !selected.success || selected.results.length !== 1) {
    throw new Error("Document extraction persistence failed.");
  }
  return { extraction: extractionFromRow(selected.results[0] as ExtractionRow), created: inserted.meta.changes === 1 };
}

async function extractStoredDocument(env: WorkerEnv, rawId: string): Promise<ExtractDocumentResponse> {
  const id = validDocumentId(rawId);
  const { db, bucket } = requireDocumentStorage(env);
  const document = await findDocument(db, id);
  if (!document) throw new DocumentError("document_not_found", 404, "The uploaded document was not found.");

  // Return the immutable, authoritative record before touching R2 or parser.
  const cached = await findExtraction(db, id);
  if (cached) return { extraction: cached, created: false };

  const bytes = await readOriginalBytes(bucket, document);
  if (await sourceSha256(bytes) !== document.sha256) {
    throw new DocumentError("source_hash_mismatch", 409, "The stored PDF bytes do not match their recorded integrity hash.");
  }
  const parsed = await extractPdfText(bytes);
  const candidate: DocumentExtraction = {
    documentId: document.id,
    sourceSha256: document.sha256,
    parser: parsed.parser,
    parserVersion: parsed.parserVersion,
    extractedAt: new Date().toISOString(),
    pageCount: parsed.pageCount,
    pages: parsed.pages,
  };
  return persistExtraction(db, candidate);
}

async function requireEmptyBody(request: Request): Promise<void> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && declaredLength !== "0") {
    throw new DocumentError("invalid_request", 400, "Text extraction does not accept a request body.");
  }
  if (!request.body) return;
  const reader = request.body.getReader();
  try {
    const first = await reader.read();
    // Local Workers expose an empty POST as a readable stream, so only actual
    // stream content is rejected. Reading one chunk keeps this route bounded.
    if (!first.done) throw new DocumentError("invalid_request", 400, "Text extraction does not accept a request body.");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function handleDocumentExtraction(request: Request, env: WorkerEnv, rawId: string): Promise<Response> {
  const headers: Record<string, string> = { "cache-control": "no-store" };
  try {
    if (request.method !== "POST") {
      headers.Allow = "POST";
      throw new DocumentError("method_not_allowed", 405, "Use POST to extract stored PDF text.");
    }
    await requireEmptyBody(request);
    const result = await extractStoredDocument(env, rawId);
    return Response.json(result, { status: result.created ? 201 : 200, headers });
  } catch (error) {
    return documentErrorResponse(error, headers);
  }
}

export async function handleDocumentText(request: Request, env: WorkerEnv, rawId: string): Promise<Response> {
  const headers: Record<string, string> = { "cache-control": "no-store" };
  try {
    if (request.method !== "GET") {
      headers.Allow = "GET";
      throw new DocumentError("method_not_allowed", 405, "Use GET to retrieve stored document text.");
    }
    const id = validDocumentId(rawId);
    const { db } = requireDocumentStorage(env);
    const document = await findDocument(db, id);
    if (!document) throw new DocumentError("document_not_found", 404, "The uploaded document was not found.");
    const extraction = await findExtraction(db, id);
    if (!extraction) throw new DocumentError("extraction_not_found", 404, "The uploaded document has not been extracted.");
    const response: GetDocumentTextResponse = { extraction };
    return Response.json(response, { headers });
  } catch (error) {
    return documentErrorResponse(error, headers);
  }
}
