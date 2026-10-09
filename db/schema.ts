import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Retained infrastructure verification table.
export const storageProbes = sqliteTable("storage_probes", {
  id: text("id").primaryKey().notNull(),
  value: text("value").notNull(),
});

export const papers = sqliteTable("papers", {
  id: text("id").primaryKey().notNull(),
  source: text("source").notNull(),
  arxivId: text("arxiv_id").notNull(),
  title: text("title").notNull(),
  authorsJson: text("authors_json").notNull(),
  year: integer("year"),
  abstract: text("abstract").notNull(),
  url: text("url"),
  pdfUrl: text("pdf_url"),
  savedAt: text("saved_at").notNull(),
}, (table) => [uniqueIndex("papers_source_identity").on(table.source, table.arxivId)]);

// Original uploaded PDF bytes are private R2 objects. Only the display and
// integrity metadata belongs in D1; extraction results are intentionally absent
// until a later phase.
export const uploadedDocuments = sqliteTable("uploaded_documents", {
  id: text("id").primaryKey().notNull(),
  filename: text("filename").notNull(),
  byteCount: integer("byte_count").notNull(),
  sha256: text("sha256").notNull(),
  objectKey: text("object_key").notNull(),
  uploadedAt: text("uploaded_at").notNull(),
  status: text("status").notNull(),
}, (table) => [
  uniqueIndex("uploaded_documents_object_key").on(table.objectKey),
  index("uploaded_documents_uploaded_at_id").on(table.uploadedAt, table.id),
]);

// Each original PDF has at most one immutable successful text extraction. The
// source hash lets later callers verify which exact R2 bytes produced it.
export const documentExtractions = sqliteTable("document_extractions", {
  documentId: text("document_id").primaryKey().notNull(),
  sourceSha256: text("source_sha256").notNull(),
  parser: text("parser").notNull(),
  parserVersion: text("parser_version").notNull(),
  extractedAt: text("extracted_at").notNull(),
  pageCount: integer("page_count").notNull(),
  pagesJson: text("pages_json").notNull(),
});

// One immutable source-grounded bibliographic result per successful text
// extraction. Arrays and evidence stay JSON because D1 stores this small,
// bounded API result without introducing a second document identity.
export const documentMetadata = sqliteTable("document_metadata", {
  documentId: text("document_id").primaryKey().notNull(),
  sourceSha256: text("source_sha256").notNull(),
  extractionParser: text("extraction_parser").notNull(),
  extractionParserVersion: text("extraction_parser_version").notNull(),
  extractionExtractedAt: text("extraction_extracted_at").notNull(),
  selectedPagesJson: text("selected_pages_json").notNull(),
  sourceExcerptByteCount: integer("source_excerpt_byte_count").notNull(),
  sourceExcerptClipped: integer("source_excerpt_clipped").notNull(),
  model: text("model").notNull(),
  promptVersion: text("prompt_version").notNull(),
  generatedAt: text("generated_at").notNull(),
  title: text("title"),
  authorsJson: text("authors_json"),
  year: integer("year"),
  abstract: text("abstract"),
  evidenceJson: text("evidence_json").notNull(),
  warningsJson: text("warnings_json").notNull(),
});

// A short-lived ownership record prevents concurrent first requests from
// producing duplicate provider calls. It is deliberately separate from the
// immutable result so failed/expired attempts can be recovered explicitly.
export const documentMetadataClaims = sqliteTable("document_metadata_claims", {
  documentId: text("document_id").primaryKey().notNull(),
  ownerToken: text("owner_token").notNull(),
  expiresAt: text("expires_at").notNull(),
});

// One immutable summary per persisted text extraction. Coverage is retained with
// the result so a later reader can distinguish full from partial source input.
export const documentSummaries = sqliteTable("document_summaries", {
  documentId: text("document_id").primaryKey().notNull(),
  sourceSha256: text("source_sha256").notNull(),
  extractionParser: text("extraction_parser").notNull(),
  extractionParserVersion: text("extraction_parser_version").notNull(),
  extractionExtractedAt: text("extraction_extracted_at").notNull(),
  totalPageCount: integer("total_page_count").notNull(),
  includedPageNumbersJson: text("included_page_numbers_json").notNull(),
  includedPageRangesJson: text("included_page_ranges_json").notNull(),
  sourceExcerptByteCount: integer("source_excerpt_byte_count").notNull(),
  sourceExcerptTruncated: integer("source_excerpt_truncated").notNull(),
  sourceCoverageWarning: text("source_coverage_warning").notNull(),
  model: text("model").notNull(),
  promptVersion: text("prompt_version").notNull(),
  schemaVersion: text("schema_version").notNull(),
  createdAt: text("created_at").notNull(),
  overviewJson: text("overview_json").notNull(),
  contributionsJson: text("contributions_json").notNull(),
  methodsJson: text("methods_json").notNull(),
  findingsJson: text("findings_json").notNull(),
  limitationsJson: text("limitations_json").notNull(),
  warningsJson: text("warnings_json").notNull(),
});

// Independent from metadata claims: either feature can run without the other.
export const documentSummaryClaims = sqliteTable("document_summary_claims", {
  documentId: text("document_id").primaryKey().notNull(),
  ownerToken: text("owner_token").notNull(),
  expiresAt: text("expires_at").notNull(),
});
