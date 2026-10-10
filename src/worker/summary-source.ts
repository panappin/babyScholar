import type { DocumentExtraction, DocumentSummaryPageRange, DocumentTextPage } from "./document-types.js";

export const SUMMARY_MAX_TEXT_BYTES = 96 * 1024;
/**
 * Quotes returned to callers remain short. The model selects one of these
 * server-issued references; it never has to reproduce the PDF presentation
 * text itself.
 */
export const SUMMARY_EVIDENCE_REFERENCE_BYTES = 600;
const encoder = new TextEncoder();

export interface SummaryEvidenceReference {
  pageNumber: number;
  /** One-based, page-local identifier shown to the provider. */
  referenceId: number;
  /** Exact trimmed source text resolved by the Worker, never provider output. */
  quote: string;
}

export interface SummarySourceExcerpt {
  pages: DocumentTextPage[];
  evidenceReferences: SummaryEvidenceReference[];
  pageNumbers: number[];
  pageRanges: DocumentSummaryPageRange[];
  byteCount: number;
  totalPageCount: number;
  truncated: boolean;
  coverageWarning: string;
}

function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

/** Takes complete Unicode code points only; it never produces a broken UTF-8 sequence. */
function truncateAtTextBoundary(value: string, maximumBytes: number): string {
  if (utf8ByteLength(value) <= maximumBytes) return value;
  let result = "";
  let used = 0;
  for (const character of value) {
    const bytes = utf8ByteLength(character);
    if (used + bytes > maximumBytes) break;
    result += character;
    used += bytes;
  }
  return result;
}

function pageRanges(pageNumbers: number[]): DocumentSummaryPageRange[] {
  const ranges: DocumentSummaryPageRange[] = [];
  for (const pageNumber of pageNumbers) {
    const previous = ranges.at(-1);
    if (previous && pageNumber === previous.endPage + 1) {
      previous.endPage = pageNumber;
    } else {
      ranges.push({ startPage: pageNumber, endPage: pageNumber });
    }
  }
  return ranges;
}

function formatRanges(ranges: DocumentSummaryPageRange[]): string {
  return ranges.map((range) => range.startPage === range.endPage
    ? String(range.startPage)
    : `${range.startPage}-${range.endPage}`).join(", ");
}

/**
 * Split selected source pages into bounded, server-owned evidence excerpts.
 * Prefer whitespace boundaries so ordinary words remain intact. An unusually
 * long unbroken token is split only as a last resort, at a Unicode boundary.
 * Source pages themselves remain unchanged.
 */
function evidenceReferencesForPage(page: DocumentTextPage): SummaryEvidenceReference[] {
  const references: SummaryEvidenceReference[] = [];
  let referenceId = 1;

  // Prefer physical extracted lines: they are concise and make a reference
  // useful without asking a provider to reconstruct a paragraph. Split a
  // single long line further only when its own byte budget requires it.
  for (const line of page.text.split(/\r\n|[\r\n]/u)) {
    let remaining = line;
    while (remaining.length > 0) {
      const bounded = truncateAtTextBoundary(remaining, SUMMARY_EVIDENCE_REFERENCE_BYTES);
      let consumed = bounded.length;
      if (bounded.length < remaining.length) {
        let whitespaceIndex = -1;
        for (let index = 0; index < bounded.length; index += 1) {
          if (/\s/u.test(bounded[index])) whitespaceIndex = index;
        }
        if (whitespaceIndex > 0) consumed = whitespaceIndex;
      }
      if (consumed === 0) consumed = bounded.length;
      const quote = remaining.slice(0, consumed).trim();
      remaining = remaining.slice(consumed);
      if (!quote) continue;
      // `quote` is derived from a bounded source slice. Keep this invariant
      // explicit in case this splitter changes in the future.
      if (utf8ByteLength(quote) > SUMMARY_EVIDENCE_REFERENCE_BYTES) {
        throw new Error("Summary evidence reference exceeded its byte limit.");
      }
      references.push({ pageNumber: page.pageNumber, referenceId, quote });
      referenceId += 1;
    }
  }
  return references;
}

/**
 * Uses every ordered persisted extraction page until the source budget is full.
 * The final selected page can be partial; later pages are deliberately omitted.
 */
export function selectSummarySource(extraction: DocumentExtraction): SummarySourceExcerpt {
  const pages: DocumentTextPage[] = [];
  let remaining = SUMMARY_MAX_TEXT_BYTES;
  let truncated = false;

  for (const page of extraction.pages) {
    if (remaining === 0) {
      truncated = true;
      break;
    }
    const text = truncateAtTextBoundary(page.text, remaining);
    pages.push({ pageNumber: page.pageNumber, text });
    remaining -= utf8ByteLength(text);
    if (text.length !== page.text.length) {
      truncated = true;
      break;
    }
  }
  if (pages.length < extraction.pages.length) truncated = true;

  const numbers = pages.map((page) => page.pageNumber);
  const ranges = pageRanges(numbers);
  const evidenceReferences = pages.flatMap(evidenceReferencesForPage);
  const included = formatRanges(ranges) || "none";
  const coverageWarning = truncated
    ? `Partial source coverage: pages ${included} of ${extraction.pageCount} were included within the ${SUMMARY_MAX_TEXT_BYTES}-byte budget.`
    : `Source coverage: all ${extraction.pageCount} extracted page(s) were included.`;

  return {
    pages,
    evidenceReferences,
    pageNumbers: numbers,
    pageRanges: ranges,
    byteCount: pages.reduce((total, page) => total + utf8ByteLength(page.text), 0),
    totalPageCount: extraction.pageCount,
    truncated,
    coverageWarning,
  };
}
