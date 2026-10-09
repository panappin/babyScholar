/** Public document metadata. Private R2 object keys never leave the Worker. */
export interface UploadedDocument {
  /** Independent application UUID, unrelated to a filename or storage key. */
  id: string;
  /** Original client filename retained only as display metadata. */
  filename: string;
  /** Exact number of original PDF bytes stored in R2. */
  byteCount: number;
  /** Lowercase SHA-256 hex digest of the original PDF bytes. */
  sha256: string;
  /** Server-assigned UTC ISO 8601 timestamp. */
  uploadedAt: string;
  /** Extraction has not run in Phase 3A. */
  status: "stored";
}

export interface UploadDocumentResponse {
  document: UploadedDocument;
}

export interface ListDocumentsResponse {
  documents: UploadedDocument[];
}

/** Complete server-extracted text, retained per original uploaded document. */
export interface DocumentTextPage {
  /** One-based PDF page number, retained in the original document order. */
  pageNumber: number;
  /** Full text extracted from that page; extraction never silently truncates it. */
  text: string;
}

export interface DocumentExtraction {
  /** The application document UUID, never an R2 key or filename. */
  documentId: string;
  /** SHA-256 of the exact R2 source bytes used for this extraction. */
  sourceSha256: string;
  /** Parser package used by the Worker. */
  parser: "unpdf";
  /** Parser package/runtime version recorded when extraction completed. */
  parserVersion: string;
  /** Server-assigned UTC ISO 8601 timestamp, retained for cached responses. */
  extractedAt: string;
  pageCount: number;
  pages: DocumentTextPage[];
}

export interface ExtractDocumentResponse {
  extraction: DocumentExtraction;
  created: boolean;
}

export interface GetDocumentTextResponse {
  extraction: DocumentExtraction;
}

export type DocumentErrorKind = "invalid_request" | "unsupported_media_type" | "body_too_large"
  | "request_timeout" | "method_not_allowed" | "storage_unavailable" | "database_failure"
  | "document_not_found" | "object_missing" | "extraction_not_found" | "source_hash_mismatch"
  | "password_protected" | "no_usable_text" | "extraction_limit_exceeded" | "extraction_timeout"
  | "parser_error";

export interface DocumentErrorResponse {
  error: { kind: DocumentErrorKind; message: string };
}
