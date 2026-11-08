import type { DocumentExtraction, DocumentMetadata, DocumentQuestionRecord, DocumentSummary, UploadedDocument } from '../../../src/worker/document-types';

export const document: UploadedDocument = { id: '44444444-4444-4444-8444-444444444444', filename: 'graph-study.pdf',
  byteCount: 512, sha256: 'a'.repeat(64), uploadedAt: '2026-01-01T00:00:00.000Z', status: 'stored' };
export const secondDocument: UploadedDocument = { ...document, id: '55555555-5555-4555-8555-555555555555',
  filename: 'second-study.pdf', uploadedAt: '2026-01-02T00:00:00.000Z' };
export const extraction = (id = document.id): DocumentExtraction => ({ documentId: id, sourceSha256: document.sha256,
  parser: 'unpdf', parserVersion: 'unpdf@1.8.1', extractedAt: '2026-01-02T01:00:00.000Z', pageCount: 1,
  pages: [{ pageNumber: 1, text: `Persisted source for ${id}.` }] });
const provenance = (id: string) => ({ documentId: id, sourceSha256: document.sha256, extractionParser: 'unpdf' as const,
  extractionParserVersion: 'unpdf@1.8.1', extractionExtractedAt: extraction(id).extractedAt,
  sourceExcerptByteCount: 40, model: 'offline-fixture', promptVersion: 'fixture-v1' });
export const metadata = (id = document.id): DocumentMetadata => ({ ...provenance(id), selectedPageNumbers: [1],
  sourceExcerptClipped: false, generatedAt: '2026-01-02T01:01:00.000Z', title: 'Saved document title',
  authors: ['Ada Author'], year: 2026, abstract: 'Saved document abstract.', evidence: { title: [], authors: [], year: [], abstract: [] }, warnings: [] });
const coverage = { totalPageCount: 1, includedPageNumbers: [1], includedPageRanges: [{ startPage: 1, endPage: 1 }],
  sourceExcerptTruncated: false, sourceCoverageWarning: 'All saved text was included.', schemaVersion: 'fixture-v1',
  createdAt: '2026-01-02T01:02:00.000Z' };
export const summary = (id = document.id): DocumentSummary => ({ ...provenance(id), ...coverage,
  overview: { text: 'A plain-language overview of graph learning.', evidence: [] },
  contributions: [{ text: 'Separates stored text from generation.', evidence: [] }], methods: [], findings: [], limitations: [], warnings: [] });
export const question = (id = document.id): DocumentQuestionRecord => ({ ...provenance(id), ...coverage,
  id: '66666666-6666-4666-8666-666666666666', extractionFingerprint: 'b'.repeat(64),
  question: 'What is the method?', normalizedQuestion: 'What is the method?', outcome: 'answered',
  answerParts: [{ text: 'The approach compares graph representations.', evidence: [] }], insufficientSourceReason: null, warnings: [] });
