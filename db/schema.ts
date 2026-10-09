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
