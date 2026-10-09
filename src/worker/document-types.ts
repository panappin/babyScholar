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

export type DocumentErrorKind = "invalid_request" | "unsupported_media_type" | "body_too_large"
  | "request_timeout" | "method_not_allowed" | "storage_unavailable" | "database_failure"
  | "document_not_found" | "object_missing";

export interface DocumentErrorResponse {
  error: { kind: DocumentErrorKind; message: string };
}
