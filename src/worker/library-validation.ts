import { canonicalArxivLink, parseArxivId } from "./arxiv-identity.js";
import type { LibraryErrorKind, SavePaperRequest } from "./library-types.js";

export const LIBRARY_BODY_BYTES = 256 * 1024;
const BODY_TIMEOUT_MS = 10_000;

export class LibraryError extends Error {
  constructor(readonly kind: LibraryErrorKind, readonly status: number, message: string) {
    super(message);
    this.name = "LibraryError";
  }
}

function invalid(message: string): never {
  throw new LibraryError("invalid_request", 400, message);
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fieldText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || [...value].length > maximum || value.includes("\0")) {
    return invalid(`${field} must be a string of at most ${maximum} characters without null characters.`);
  }
  return value; // Preserve the full supplied metadata, including whitespace and Unicode.
}

function paperLink(value: unknown, kind: "abstract" | "pdf", identity: string): string | null {
  if (value === null) return null;
  const field = kind === "abstract" ? "paper.url" : "paper.pdfUrl";
  const link = canonicalArxivLink(fieldText(value, field, 2_048), kind);
  if (!link) return invalid(`${field} must be null or a supported arXiv HTTP(S) link.`);
  const prefix = kind === "abstract" ? "/abs/" : "/pdf/";
  const path = new URL(link).pathname.slice(prefix.length).replace(/\.pdf$/u, "");
  if (parseArxivId(path)?.base !== identity) {
    return invalid(`${field} must refer to paper.id.`);
  }
  return link;
}

export function validateSavePaper(value: unknown): SavePaperRequest {
  if (!object(value) || Object.keys(value).some((key) => key !== "paper") || !object(value.paper)) {
    return invalid("Provide a JSON object containing only paper.");
  }
  const paper = value.paper;
  const fields = ["id", "title", "authors", "year", "abstract", "url", "pdfUrl"];
  if (Object.keys(paper).some((key) => !fields.includes(key))) return invalid("paper contains unsupported fields.");
  const identifier = parseArxivId(fieldText(paper.id, "paper.id", 64));
  if (!identifier) return invalid("paper.id must be a supported modern or legacy arXiv identifier.");
  const title = fieldText(paper.title, "paper.title", 2_000);
  const abstract = fieldText(paper.abstract, "paper.abstract", 100_000);
  if (!Array.isArray(paper.authors) || paper.authors.length > 2_000) {
    return invalid("paper.authors must be an ordered array of at most 2000 names.");
  }
  const authors = paper.authors.map((author) => {
    const name = fieldText(author, "paper.authors entry", 512);
    if (!name.trim()) return invalid("Each author name must contain text.");
    return name;
  });
  if (paper.year !== null && (typeof paper.year !== "number" || !Number.isInteger(paper.year)
    || paper.year < 1 || paper.year > 9_999)) {
    return invalid("paper.year must be null or an integer from 1 to 9999.");
  }
  return { paper: {
    id: identifier.base, title, authors, year: paper.year, abstract,
    url: paperLink(paper.url, "abstract", identifier.base),
    pdfUrl: paperLink(paper.pdfUrl, "pdf", identifier.base),
  } };
}

// Measure received bytes, not just Content-Length. Keep both memory use and
// body-reading time bounded, including streams that stop producing chunks.
export async function readSavePaper(request: Request): Promise<SavePaperRequest> {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json" || ![null, "identity"].includes(request.headers.get("content-encoding"))) {
    throw new LibraryError("unsupported_media_type", 415, "Use an uncompressed application/json body.");
  }
  const tooLarge = () => new LibraryError("body_too_large", 413, "The JSON body must not exceed 262144 bytes.");
  // Always measure the stream itself rather than trusting Content-Length.
  if (!request.body) return invalid("A JSON body is required.");
  const reader = request.body.getReader();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new LibraryError("request_timeout", 408, "The request body took too long to arrive.")), BODY_TIMEOUT_MS);
  });
  let json = "";
  let bytes = 0;
  let complete = false;
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
    while (true) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > LIBRARY_BODY_BYTES) throw tooLarge();
      json += decoder.decode(chunk.value, { stream: true });
    }
    json += decoder.decode();
    complete = true;
  } catch (error) {
    if (error instanceof LibraryError) throw error;
    return invalid("The request body could not be read as UTF-8 JSON.");
  } finally {
    // Settle cancellation before replying, but never beyond the same deadline.
    if (!complete) await Promise.race([reader.cancel(), deadline]).catch(() => undefined);
    if (timeout !== undefined) clearTimeout(timeout);
    reader.releaseLock();
  }
  let value: unknown;
  try { value = JSON.parse(json); } catch { return invalid("The request body must contain valid JSON."); }
  return validateSavePaper(value);
}
