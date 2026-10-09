import type {
  DocumentErrorResponse,
  ListDocumentsResponse,
  UploadedDocument,
  UploadDocumentResponse,
} from "./document-types.js";
import { DocumentError, readUploadedDocument, type ValidatedDocumentUpload } from "./document-validation.js";
import type { WorkerEnv } from "./storage.js";

export interface DocumentRow {
  id: string;
  filename: string;
  byte_count: number;
  sha256: string;
  object_key: string;
  uploaded_at: string;
  status: "stored";
}

export const DOCUMENT_COLUMNS = "id, filename, byte_count, sha256, object_key, uploaded_at, status";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function privateObjectKey(id: string): string {
  return `uploaded_documents/${id}.pdf`;
}

function documentFromRow(row: DocumentRow): UploadedDocument {
  if (
    !UUID.test(row.id)
    || typeof row.filename !== "string"
    || !Number.isInteger(row.byte_count)
    || row.byte_count < 1
    || !SHA256.test(row.sha256)
    || row.object_key !== privateObjectKey(row.id)
    || typeof row.uploaded_at !== "string"
    || row.status !== "stored"
  ) {
    throw new Error("Invalid stored document metadata");
  }
  return {
    id: row.id,
    filename: row.filename,
    byteCount: row.byte_count,
    sha256: row.sha256,
    uploadedAt: row.uploaded_at,
    status: "stored",
  };
}

export function requireDocumentStorage(env: WorkerEnv): { db: D1Database; bucket: R2Bucket } {
  if (!env.DB || !env.PAPER_BUCKET) {
    throw new DocumentError("storage_unavailable", 503, "The document storage is unavailable.");
  }
  return { db: env.DB, bucket: env.PAPER_BUCKET };
}

export function validDocumentId(id: string): string {
  if (!UUID.test(id)) {
    throw new DocumentError("invalid_request", 400, "Document id must be a canonical application UUID.");
  }
  return id;
}

async function listDocuments(db: D1Database): Promise<ListDocumentsResponse> {
  const rows = await db.prepare(`SELECT ${DOCUMENT_COLUMNS} FROM uploaded_documents ORDER BY uploaded_at DESC, id DESC`).all<DocumentRow>();
  if (!rows.success) throw new Error("Document list failed");
  return { documents: rows.results.map(documentFromRow) };
}

export async function findDocument(db: D1Database, id: string): Promise<DocumentRow | null> {
  const row = await db.prepare(`SELECT ${DOCUMENT_COLUMNS} FROM uploaded_documents WHERE id = ?`).bind(id).first<DocumentRow>();
  return row ?? null;
}

async function insertDocument(db: D1Database, row: DocumentRow): Promise<void> {
  const result = await db.prepare(`INSERT INTO uploaded_documents (${DOCUMENT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(row.id, row.filename, row.byte_count, row.sha256, row.object_key, row.uploaded_at, row.status)
    .run();
  if (!result.success || result.meta.changes !== 1) throw new Error("Document insert failed");
}

async function storeDocument(env: WorkerEnv, upload: ValidatedDocumentUpload): Promise<UploadedDocument> {
  const { db, bucket } = requireDocumentStorage(env);
  const id = crypto.randomUUID();
  const row: DocumentRow = {
    id,
    filename: upload.filename,
    byte_count: upload.bytes.byteLength,
    sha256: upload.sha256,
    object_key: privateObjectKey(id),
    uploaded_at: new Date().toISOString(),
    status: "stored",
  };

  try {
    await bucket.put(row.object_key, upload.bytes, {
      httpMetadata: { contentType: "application/pdf" },
    });
  } catch {
    throw new DocumentError("storage_unavailable", 503, "The document storage is unavailable.");
  }

  try {
    await insertDocument(db, row);
  } catch {
    // D1 and R2 cannot share one atomic transaction. This key belongs only to
    // this request, so a failed row insert gets one best-effort cleanup attempt.
    await bucket.delete(row.object_key).catch(() => undefined);
    throw new DocumentError("database_failure", 503, "The document database operation failed.");
  }
  return documentFromRow(row);
}

export function documentErrorResponse(error: unknown, headers: Record<string, string>): Response {
  const failure = error instanceof DocumentError ? error
    : new DocumentError("database_failure", 503, "The document database operation failed.");
  const body: DocumentErrorResponse = { error: { kind: failure.kind, message: failure.message } };
  return Response.json(body, { status: failure.status, headers });
}

export async function handleDocuments(request: Request, env: WorkerEnv): Promise<Response> {
  const headers: Record<string, string> = { "cache-control": "no-store" };
  try {
    if (request.method === "GET") {
      const { db } = requireDocumentStorage(env);
      return Response.json(await listDocuments(db), { headers });
    }
    if (request.method === "POST") {
      const document = await storeDocument(env, await readUploadedDocument(request));
      const response: UploadDocumentResponse = { document };
      return Response.json(response, { status: 201, headers });
    }
    headers.Allow = "GET, POST";
    throw new DocumentError("method_not_allowed", 405, "Use GET or POST for documents.");
  } catch (error) {
    return documentErrorResponse(error, headers);
  }
}

export async function handleDocumentPdf(request: Request, env: WorkerEnv, rawId: string): Promise<Response> {
  const headers: Record<string, string> = { "cache-control": "no-store" };
  try {
    if (request.method !== "GET") {
      headers.Allow = "GET";
      throw new DocumentError("method_not_allowed", 405, "Use GET to retrieve an uploaded PDF.");
    }
    const id = validDocumentId(rawId);
    const { db, bucket } = requireDocumentStorage(env);
    const row = await findDocument(db, id);
    if (!row) throw new DocumentError("document_not_found", 404, "The uploaded document was not found.");
    let object: R2ObjectBody | null;
    try {
      object = await bucket.get(row.object_key);
    } catch {
      throw new DocumentError("storage_unavailable", 503, "The document storage is unavailable.");
    }
    if (!object) throw new DocumentError("object_missing", 404, "The uploaded document bytes are unavailable.");
    return new Response(object.body, {
      headers: {
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="document-${id}.pdf"`,
        "content-length": String(row.byte_count),
        "content-type": "application/pdf",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return documentErrorResponse(error, headers);
  }
}
