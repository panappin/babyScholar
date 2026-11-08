import { getDocumentProxy, getResolvedPDFJS } from "unpdf";
import type { DocumentTextPage } from "./document-types.js";
import { DocumentError } from "./document-validation.js";

export const EXTRACTION_MAX_PAGES = 100;
export const EXTRACTION_MAX_TEXT_BYTES = 500 * 1024;
export const EXTRACTION_MAX_SERIALIZED_PAGE_BYTES = 1024 * 1024;
export const EXTRACTION_DEADLINE_MS = 20_000;
const UNPDF_VERSION = "1.8.1";
const textEncoder = new TextEncoder();

// Text extraction does not render pages. These options avoid range/background
// requests, fonts and PDF JavaScript evaluation; the original R2 bytes are the
// only input. PDF.js still cannot be preempted while doing synchronous CPU work.
const parserOptions = {
  disableAutoFetch: true,
  disableFontFace: true,
  disableRange: true,
  disableWorker: true,
  enableXfa: false,
  isEvalSupported: false,
  maxImageSize: 16_777_216,
  stopAtErrors: true,
  useSystemFonts: false,
};

export interface ExtractedPdfText {
  parser: "unpdf";
  parserVersion: string;
  pageCount: number;
  pages: DocumentTextPage[];
}

function byteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

async function withinDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new DocumentError("extraction_timeout", 504, "PDF text extraction exceeded its processing deadline.");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new DocumentError("extraction_timeout", 504, "PDF text extraction exceeded its processing deadline."));
    }, remaining);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function pageText(content: { items: unknown[] }): string {
  return content.items.map((item) => {
    const candidate = item as { str?: unknown; hasEOL?: unknown };
    const value = typeof candidate.str === "string" ? candidate.str : "";
    return candidate.hasEOL === true ? `${value}\n` : value;
  }).join("");
}

function parserFailure(error: unknown): DocumentError {
  const name = error instanceof Error ? error.name : "";
  if (name === "PasswordException") {
    return new DocumentError("password_protected", 422, "Password-protected PDFs cannot be extracted.");
  }
  return new DocumentError("parser_error", 422, "The stored PDF could not be parsed for text extraction.");
}

/**
 * Extracts all supported text before returning it. The Promise deadline bounds
 * asynchronous waits, but JavaScript timers cannot interrupt synchronous PDF.js
 * CPU work already running on the Worker event loop.
 */
export async function extractPdfText(bytes: Uint8Array): Promise<ExtractedPdfText> {
  const deadline = Date.now() + EXTRACTION_DEADLINE_MS;
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
  try {
    pdf = await withinDeadline(getDocumentProxy(bytes, parserOptions), deadline);
    if (pdf.numPages > EXTRACTION_MAX_PAGES) {
      throw new DocumentError("extraction_limit_exceeded", 413, `PDFs with more than ${EXTRACTION_MAX_PAGES} pages are not supported.`);
    }

    const pages: DocumentTextPage[] = [];
    let totalTextBytes = 0;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await withinDeadline(pdf.getPage(pageNumber), deadline);
      try {
        const content = await withinDeadline(page.getTextContent(), deadline);
        const text = pageText(content);
        totalTextBytes += byteLength(text);
        if (totalTextBytes > EXTRACTION_MAX_TEXT_BYTES) {
          throw new DocumentError("extraction_limit_exceeded", 413, `Extracted text must not exceed ${EXTRACTION_MAX_TEXT_BYTES} UTF-8 bytes.`);
        }
        pages.push({ pageNumber, text });
        if (byteLength(JSON.stringify(pages)) > EXTRACTION_MAX_SERIALIZED_PAGE_BYTES) {
          throw new DocumentError("extraction_limit_exceeded", 413, `Serialized page text must not exceed ${EXTRACTION_MAX_SERIALIZED_PAGE_BYTES} bytes.`);
        }
      } finally {
        page.cleanup();
      }
    }
    if (!pages.some((page) => page.text.trim().length > 0)) {
      throw new DocumentError("no_usable_text", 422, "The stored PDF has no usable text; OCR is not available.");
    }
    const pdfjs = await withinDeadline(getResolvedPDFJS(), deadline);
    return { parser: "unpdf", parserVersion: `unpdf@${UNPDF_VERSION}/pdfjs@${pdfjs.version}`, pageCount: pdf.numPages, pages };
  } catch (error) {
    if (error instanceof DocumentError) throw error;
    throw parserFailure(error);
  } finally {
    await pdf?.loadingTask.destroy().catch(() => undefined);
  }
}
