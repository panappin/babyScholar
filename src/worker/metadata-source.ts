import type { DocumentExtraction, DocumentTextPage } from "./document-types.js";

export const METADATA_MAX_PAGES = 3;
export const METADATA_MAX_TEXT_BYTES = 24_000;
const encoder = new TextEncoder();

export interface MetadataSourceExcerpt {
  pages: DocumentTextPage[];
  pageNumbers: number[];
  byteCount: number;
  clipped: boolean;
}

function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

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

/** Selects only the first ordered pages and never splits a Unicode code point. */
export function selectMetadataSource(extraction: DocumentExtraction): MetadataSourceExcerpt {
  const pages: DocumentTextPage[] = [];
  let remaining = METADATA_MAX_TEXT_BYTES;
  let clipped = extraction.pages.length > METADATA_MAX_PAGES;
  for (const page of extraction.pages.slice(0, METADATA_MAX_PAGES)) {
    if (remaining === 0) {
      clipped = true;
      break;
    }
    const text = truncateAtTextBoundary(page.text, remaining);
    pages.push({ pageNumber: page.pageNumber, text });
    const used = utf8ByteLength(text);
    remaining -= used;
    if (text.length !== page.text.length) {
      clipped = true;
      break;
    }
  }
  if (pages.length < extraction.pages.length) clipped = true;
  return {
    pages,
    pageNumbers: pages.map((page) => page.pageNumber),
    byteCount: pages.reduce((total, page) => total + utf8ByteLength(page.text), 0),
    clipped,
  };
}
