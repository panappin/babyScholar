import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
