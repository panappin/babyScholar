import type { DocumentMetadataEvidence } from "./document-types.js";
import { DocumentError } from "./document-validation.js";
import type { MetadataSourceExcerpt } from "./metadata-source.js";

const encoder = new TextEncoder();
export interface ValidatedMetadataOutput {
  title: string | null;
  authors: string[] | null;
  year: number | null;
  abstract: string | null;
  evidence: DocumentMetadataEvidence;
  warnings: string[];
}

// Shared cache-identity normalization; it no longer verifies PDF evidence.
export function normalizeMetadataWhitespace(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function invalid(): never {
  throw new DocumentError("metadata_invalid_response", 502, "The metadata provider returned unusable metadata fields.");
}
function text(value: unknown, maximum: number): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || encoder.encode(value).byteLength > maximum) invalid();
  return value.trim() || null;
}

/** Basic application shape parsing. Optional evidence never gates acceptance. */
export function validateMetadataOutput(output: unknown, _excerpt: MetadataSourceExcerpt): ValidatedMetadataOutput {
  if (typeof output !== "object" || output === null || Array.isArray(output)) invalid();
  const fields = output as Record<string, unknown>;
  if (!["title", "authors", "year", "abstract"].some((field) => Object.hasOwn(fields, field))) invalid();
  const title = text(fields.title, 1_000);
  const abstract = text(fields.abstract, 12_000);
  let authors: string[] | null = null;
  if (fields.authors !== undefined && fields.authors !== null) {
    if (!Array.isArray(fields.authors) || fields.authors.length > 32) invalid();
    authors = fields.authors.map((author) => text(author, 500)).filter((author): author is string => author !== null);
    if (!authors.length) authors = null;
  }
  const year = fields.year === undefined ? null : fields.year;
  if (year !== null && (typeof year !== "number" || !Number.isInteger(year) || year < 1000 || year > 2999)) invalid();
  const warnings = Array.isArray(fields.warnings)
    ? fields.warnings.filter((warning): warning is string => typeof warning === "string" && !!warning.trim() && encoder.encode(warning).byteLength <= 500).slice(0, 16).map((warning) => warning.trim())
    : [];
  return { title, authors, year: year as number | null, abstract,
    evidence: { title: [], authors: [], year: [], abstract: [] }, warnings };
}
