import type {
  DocumentMetadataEvidence,
  DocumentMetadataEvidenceQuote,
  DocumentMetadataField,
} from "./document-types.js";
import { DocumentError } from "./document-validation.js";
import type { MetadataSourceExcerpt } from "./metadata-source.js";

const fields: DocumentMetadataField[] = ["title", "authors", "year", "abstract"];
const encoder = new TextEncoder();
const MAX_TITLE_BYTES = 1_000;
const MAX_AUTHOR_COUNT = 32;
const MAX_AUTHOR_BYTES = 500;
const MAX_ABSTRACT_BYTES = 12_000;
const MAX_EVIDENCE_PER_FIELD = 3;
const MAX_EVIDENCE_QUOTE_BYTES = 600;
const MAX_WARNINGS = 16;
const MAX_WARNING_BYTES = 500;

export interface ValidatedMetadataOutput {
  title: string | null;
  authors: string[] | null;
  year: number | null;
  abstract: string | null;
  evidence: DocumentMetadataEvidence;
  warnings: string[];
}

function invalid(message: string): never {
  throw new DocumentError("metadata_invalid_response", 502, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

/** NFC plus collapsed whitespace is the default source/evidence comparison. */
export function normalizeMetadataWhitespace(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

/**
 * PDF text extraction can expose a presentation-only line-end hyphen, e.g.
 * `interpreta-\ntion`. Join only that exact physical line-break form on the
 * persisted source side before comparison. Same-line compound hyphens and all
 * punctuation remain literal; an ordinary hyphen deletion never matches.
 */
export function normalizeMetadataSourcePresentation(value: string): string {
  return normalizeMetadataWhitespace(
    value.normalize("NFC").replace(/(\p{L})[\u00ad\u2010-\u2015-][\t \f\v]*\r?\n[\t \f\v]*(\p{L})/gu, "$1$2"),
  );
}

function boundedSourceString(value: unknown, maximumBytes: number, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || byteLength(value) > maximumBytes) {
    invalid(`OpenAI returned an unsupported ${name} value.`);
  }
  return value;
}

function sourceContains(excerpt: MetadataSourceExcerpt, value: string): boolean {
  const target = normalizeMetadataWhitespace(value);
  return target.length > 0 && excerpt.pages.some((page) => normalizeMetadataSourcePresentation(page.text).includes(target));
}

function validateWarnings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_WARNINGS) invalid("OpenAI returned unsupported metadata warnings.");
  const warnings = value.map((warning) => boundedSourceString(warning, MAX_WARNING_BYTES, "metadata warning"));
  if (new Set(warnings).size !== warnings.length) invalid("OpenAI returned duplicate metadata warnings.");
  return warnings;
}

function warningNamesField(warnings: string[], field: DocumentMetadataField): boolean {
  return warnings.some((warning) => new RegExp(`\\b${field}\\b`, "iu").test(warning));
}

function validateEvidenceQuote(value: unknown, excerpt: MetadataSourceExcerpt): DocumentMetadataEvidenceQuote {
  if (!isRecord(value) || !hasOnlyKeys(value, ["pageNumber", "quote"])) invalid("OpenAI returned malformed metadata evidence.");
  const pageNumber = value.pageNumber;
  const quote = value.quote;
  if (typeof pageNumber !== "number" || !Number.isInteger(pageNumber) || typeof quote !== "string" || quote.length === 0 || quote !== quote.trim() || byteLength(quote) > MAX_EVIDENCE_QUOTE_BYTES) {
    invalid("OpenAI returned unsupported metadata evidence.");
  }
  const page = excerpt.pages.find((candidate) => candidate.pageNumber === pageNumber);
  if (!page || !normalizeMetadataSourcePresentation(page.text).includes(normalizeMetadataWhitespace(quote))) {
    invalid("OpenAI returned metadata evidence that does not match the selected PDF text.");
  }
  return { pageNumber, quote };
}

function validateEvidence(value: unknown, excerpt: MetadataSourceExcerpt): DocumentMetadataEvidence {
  if (!isRecord(value) || !hasOnlyKeys(value, fields)) invalid("OpenAI returned malformed metadata evidence.");
  const evidence = {} as DocumentMetadataEvidence;
  for (const field of fields) {
    const quotes = value[field];
    if (!Array.isArray(quotes) || quotes.length > MAX_EVIDENCE_PER_FIELD) invalid("OpenAI returned too much metadata evidence.");
    const validated = quotes.map((quote) => validateEvidenceQuote(quote, excerpt));
    if (new Set(validated.map((quote) => `${quote.pageNumber}\u0000${quote.quote}`)).size !== validated.length) {
      invalid("OpenAI returned duplicate metadata evidence.");
    }
    evidence[field] = validated;
  }
  return evidence;
}

function validateAuthors(value: unknown, excerpt: MetadataSourceExcerpt): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_AUTHOR_COUNT) invalid("OpenAI returned unsupported authors.");
  const authors = value.map((author) => boundedSourceString(author, MAX_AUTHOR_BYTES, "author"));
  if (new Set(authors).size !== authors.length) invalid("OpenAI returned duplicate authors.");
  let previous = -1;
  const source = excerpt.pages.map((page) => normalizeMetadataWhitespace(page.text)).join(" ");
  for (const author of authors) {
    const index = source.indexOf(normalizeMetadataWhitespace(author), previous + 1);
    if (index < 0) invalid("OpenAI returned authors unsupported by the selected PDF text.");
    previous = index;
  }
  return authors;
}

function validateYear(value: unknown, excerpt: MetadataSourceExcerpt): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1000 || value > 2999) invalid("OpenAI returned an unsupported year.");
  const pattern = new RegExp(`(?<!\\d)${value}(?!\\d)`, "u");
  if (!excerpt.pages.some((page) => pattern.test(normalizeMetadataWhitespace(page.text)))) {
    invalid("OpenAI returned a year unsupported by the selected PDF text.");
  }
  return value;
}

function validateKnownEvidence(
  field: DocumentMetadataField,
  value: string | string[] | number | null,
  evidence: DocumentMetadataEvidence,
  warnings: string[],
): void {
  if (value === null) {
    if (evidence[field].length !== 0 || !warningNamesField(warnings, field)) {
      invalid(`Unknown ${field} must have no evidence and a warning.`);
    }
    return;
  }
  if (evidence[field].length === 0) invalid(`Known ${field} requires source evidence.`);
}

/** Validates model output even when strict structured-output schema succeeds. */
export function validateMetadataOutput(output: unknown, excerpt: MetadataSourceExcerpt): ValidatedMetadataOutput {
  const expected = ["title", "authors", "year", "abstract", "evidence", "warnings"];
  if (!isRecord(output) || !hasOnlyKeys(output, expected)) invalid("OpenAI returned malformed metadata.");
  const warnings = validateWarnings(output.warnings);
  const evidence = validateEvidence(output.evidence, excerpt);
  const title = output.title === null ? null : boundedSourceString(output.title, MAX_TITLE_BYTES, "title");
  const authors = validateAuthors(output.authors, excerpt);
  const year = validateYear(output.year, excerpt);
  const abstract = output.abstract === null ? null : boundedSourceString(output.abstract, MAX_ABSTRACT_BYTES, "abstract");
  if (title !== null && !sourceContains(excerpt, title)) invalid("OpenAI returned a title unsupported by the selected PDF text.");
  if (abstract !== null && !sourceContains(excerpt, abstract)) invalid("OpenAI returned an abstract unsupported by the selected PDF text.");
  validateKnownEvidence("title", title, evidence, warnings);
  validateKnownEvidence("authors", authors, evidence, warnings);
  validateKnownEvidence("year", year, evidence, warnings);
  validateKnownEvidence("abstract", abstract, evidence, warnings);
  return { title, authors, year, abstract, evidence, warnings };
}
