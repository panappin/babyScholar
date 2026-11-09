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
  status: "stored" | "deleting";
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

/** Bibliographic metadata generated with selected PDF text as context. */
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

/** Inclusive, one-based source-page interval supplied to the summary provider. */
export interface DocumentSummaryPageRange {
  startPage: number;
  endPage: number;
}

/** Optional quotation retained by earlier saved summary records. */
export interface DocumentSummaryEvidenceQuote {
  pageNumber: number;
  quote: string;
}

/** Summary text; new results use empty evidence, older saved quotes remain readable. */
export interface DocumentSummaryItem {
  text: string;
  evidence: DocumentSummaryEvidenceQuote[];
}

export type DocumentSummarySection = "contributions" | "methods" | "findings" | "limitations";

/** Immutable summary of persisted extracted PDF text, independent of metadata. */
export interface DocumentSummary {
  documentId: string;
  sourceSha256: string;
  extractionParser: "unpdf";
  extractionParserVersion: string;
  extractionExtractedAt: string;
  totalPageCount: number;
  /** Every persisted source page sent, including a possibly final partial page. */
  includedPageNumbers: number[];
  includedPageRanges: DocumentSummaryPageRange[];
  /** UTF-8 bytes of supplied extracted text before prompt framing. */
  sourceExcerptByteCount: number;
  /** True when the 96 KiB source budget cut off remaining source text. */
  sourceExcerptTruncated: boolean;
  /** Explicit full/partial source-coverage note retained with the result. */
  sourceCoverageWarning: string;
  model: string;
  promptVersion: string;
  schemaVersion: string;
  createdAt: string;
  overview: DocumentSummaryItem;
  contributions: DocumentSummaryItem[];
  methods: DocumentSummaryItem[];
  findings: DocumentSummaryItem[];
  limitations: DocumentSummaryItem[];
  warnings: string[];
}

export interface DocumentSummaryResponse {
  summary: DocumentSummary;
  created?: boolean;
}

/** Optional quotation retained by earlier saved Q&A records. */
export interface DocumentQuestionEvidenceQuote {
  pageNumber: number;
  quote: string;
}

/** One ordered answer portion; newly generated plain text uses empty evidence. */
export interface DocumentQuestionAnswerPart {
  text: string;
  evidence: DocumentQuestionEvidenceQuote[];
}

export type DocumentQuestionOutcome = "answered" | "insufficient_source";

/** Immutable answer with PDF context for one normalized question/extraction pair. */
export interface DocumentQuestionRecord {
  /** Independent application UUID for this saved Q&A result. */
  id: string;
  documentId: string;
  /** Trimmed user question, retaining its original case, punctuation, and numbers. */
  question: string;
  /** NFC/collapsed-whitespace cache identity; it also preserves case and punctuation. */
  normalizedQuestion: string;
  sourceSha256: string;
  extractionParser: "unpdf";
  extractionParserVersion: string;
  extractionExtractedAt: string;
  /** SHA-256 fingerprint of the exact extraction provenance used for this result. */
  extractionFingerprint: string;
  totalPageCount: number;
  includedPageNumbers: number[];
  includedPageRanges: DocumentSummaryPageRange[];
  sourceExcerptByteCount: number;
  sourceExcerptTruncated: boolean;
  sourceCoverageWarning: string;
  model: string;
  promptVersion: string;
  schemaVersion: string;
  outcome: DocumentQuestionOutcome;
  /** Present only when outcome is `answered`, in the provider's returned order. */
  answerParts: DocumentQuestionAnswerPart[];
  /** Present only when outcome is `insufficient_source`; it has no answer/citations. */
  insufficientSourceReason: string | null;
  warnings: string[];
  createdAt: string;
}

export interface DocumentQuestionResponse {
  question: DocumentQuestionRecord;
  created?: boolean;
}

export interface ListDocumentQuestionsResponse {
  questions: DocumentQuestionRecord[];
}

export type DocumentErrorKind = "invalid_request" | "unsupported_media_type" | "body_too_large"
  | "request_timeout" | "method_not_allowed" | "storage_unavailable" | "database_failure"
  | "document_not_found" | "document_deleting" | "object_missing" | "extraction_not_found" | "source_hash_mismatch"
  | "password_protected" | "no_usable_text" | "extraction_limit_exceeded" | "extraction_timeout"
  | "parser_error" | "metadata_not_found" | "metadata_in_progress"
  | "metadata_missing_configuration" | "metadata_authentication" | "metadata_quota_or_rate_limit"
  | "metadata_model_access" | "metadata_provider_failure" | "metadata_timeout"
  | "metadata_refusal" | "metadata_incomplete" | "metadata_invalid_response"
  | "summary_not_found" | "summary_in_progress" | "summary_missing_configuration"
  | "summary_authentication" | "summary_quota_or_rate_limit" | "summary_model_access"
  | "summary_provider_failure" | "summary_timeout" | "summary_refusal"
  | "summary_incomplete" | "summary_invalid_response"
  | "question_in_progress" | "question_missing_configuration"
  | "question_authentication" | "question_quota_or_rate_limit"
  | "question_model_access" | "question_provider_failure" | "question_timeout"
  | "question_refusal" | "question_incomplete" | "question_invalid_response";

export interface DocumentErrorResponse {
  error: { kind: DocumentErrorKind; message: string };
}
