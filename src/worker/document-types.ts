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

export type DocumentMetadataField = "title" | "authors" | "year" | "abstract";

/** A short, page-numbered quotation from the selected persisted PDF text. */
export interface DocumentMetadataEvidenceQuote {
  pageNumber: number;
  quote: string;
}

export type DocumentMetadataEvidence = Record<DocumentMetadataField, DocumentMetadataEvidenceQuote[]>;

/** Source-grounded bibliographic metadata, never inferred from a filename or web source. */
export interface DocumentMetadata {
  documentId: string;
  /** SHA-256 of the original stored PDF used by the linked text extraction. */
  sourceSha256: string;
  extractionParser: "unpdf";
  extractionParserVersion: string;
  extractionExtractedAt: string;
  /** One-based pages selected from the persisted extraction for this request. */
  selectedPageNumbers: number[];
  /** UTF-8 byte count of the selected text only, before prompt framing. */
  sourceExcerptByteCount: number;
  /** True when the three-page or 24 KiB excerpt policy omitted source text. */
  sourceExcerptClipped: boolean;
  /** Configured Responses API model; never a frontend or secret value. */
  model: string;
  promptVersion: string;
  generatedAt: string;
  title: string | null;
  /** Ordered names, or null when the selected text does not establish authors. */
  authors: string[] | null;
  year: number | null;
  abstract: string | null;
  evidence: DocumentMetadataEvidence;
  /** Explicit uncertainty/ambiguity notes; no fabricated confidence score. */
  warnings: string[];
}

export interface DocumentMetadataResponse {
  metadata: DocumentMetadata;
  created?: boolean;
}

export type DocumentErrorKind = "invalid_request" | "unsupported_media_type" | "body_too_large"
  | "request_timeout" | "method_not_allowed" | "storage_unavailable" | "database_failure"
  | "document_not_found" | "object_missing" | "extraction_not_found" | "source_hash_mismatch"
  | "password_protected" | "no_usable_text" | "extraction_limit_exceeded" | "extraction_timeout"
  | "parser_error" | "metadata_not_found" | "metadata_in_progress"
  | "metadata_missing_configuration" | "metadata_authentication" | "metadata_quota_or_rate_limit"
  | "metadata_model_access" | "metadata_provider_failure" | "metadata_timeout"
  | "metadata_refusal" | "metadata_incomplete" | "metadata_invalid_response";

export interface DocumentErrorResponse {
  error: { kind: DocumentErrorKind; message: string };
}
