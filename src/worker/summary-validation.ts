import type {
  DocumentSummaryEvidenceQuote,
  DocumentSummaryItem,
  DocumentSummarySection,
} from "./document-types.js";
import { DocumentError } from "./document-validation.js";
import { METADATA_EVIDENCE_QUOTE_BYTES, metadataPageContains } from "./metadata-validation.js";
import type { SummarySourceExcerpt } from "./summary-source.js";

const sections: DocumentSummarySection[] = ["contributions", "methods", "findings", "limitations"];
const encoder = new TextEncoder();
const MAX_OVERVIEW_BYTES = 3_000;
const MAX_POINT_BYTES = 1_500;
const MAX_POINTS_PER_SECTION = 4;
const MAX_EVIDENCE_PER_ITEM = 2;
// One application-owned coverage warning is appended after provider output is validated.
const MAX_WARNINGS = 15;
const MAX_WARNING_BYTES = 500;
const MAX_SUMMARY_WORDS = 500;
const MAX_SUMMARY_PROSE_BYTES = 12_000;

export interface ValidatedSummaryOutput {
  overview: DocumentSummaryItem;
  contributions: DocumentSummaryItem[];
  methods: DocumentSummaryItem[];
  findings: DocumentSummaryItem[];
  limitations: DocumentSummaryItem[];
  warnings: string[];
}

function invalid(message: string): never {
  throw new DocumentError("summary_invalid_response", 502, message);
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

function boundedText(value: unknown, maximumBytes: number, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || byteLength(value) > maximumBytes) {
    invalid(`OpenAI returned an unsupported summary ${name}.`);
  }
  return value;
}

function validateEvidenceQuote(value: unknown, excerpt: SummarySourceExcerpt): DocumentSummaryEvidenceQuote {
  if (!isRecord(value) || !hasOnlyKeys(value, ["pageNumber", "quote"])) invalid("OpenAI returned malformed summary evidence.");
  const pageNumber = value.pageNumber;
  const quote = value.quote;
  if (typeof pageNumber !== "number" || !Number.isInteger(pageNumber)
    || typeof quote !== "string" || quote.length === 0 || quote !== quote.trim()
    || byteLength(quote) > METADATA_EVIDENCE_QUOTE_BYTES) {
    invalid("OpenAI returned unsupported summary evidence.");
  }
  const page = excerpt.pages.find((candidate) => candidate.pageNumber === pageNumber);
  if (!page || !metadataPageContains(page.text, quote)) {
    invalid("OpenAI returned summary evidence that does not match the selected PDF text.");
  }
  return { pageNumber, quote };
}

function validateItem(value: unknown, excerpt: SummarySourceExcerpt, name: string, maximumBytes: number): DocumentSummaryItem {
  if (!isRecord(value) || !hasOnlyKeys(value, ["text", "evidence"])) invalid("OpenAI returned malformed summary item.");
  const text = boundedText(value.text, maximumBytes, `${name} text`);
  if (!Array.isArray(value.evidence) || value.evidence.length === 0 || value.evidence.length > MAX_EVIDENCE_PER_ITEM) {
    invalid("OpenAI returned unsupported summary evidence.");
  }
  const evidence = value.evidence.map((quote) => validateEvidenceQuote(quote, excerpt));
  if (new Set(evidence.map((quote) => `${quote.pageNumber}\u0000${quote.quote}`)).size !== evidence.length) {
    invalid("OpenAI returned duplicate summary evidence.");
  }
  return { text, evidence };
}

function validateWarnings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_WARNINGS) invalid("OpenAI returned unsupported summary warnings.");
  const warnings = value.map((warning) => boundedText(warning, MAX_WARNING_BYTES, "warning"));
  if (new Set(warnings).size !== warnings.length) invalid("OpenAI returned duplicate summary warnings.");
  return warnings;
}

function warningNamesSection(warnings: string[], section: DocumentSummarySection): boolean {
  return warnings.some((warning) => new RegExp(`\\b${section}\\b`, "iu").test(warning));
}

function validateSection(
  value: unknown,
  excerpt: SummarySourceExcerpt,
  section: DocumentSummarySection,
  warnings: string[],
): DocumentSummaryItem[] {
  if (!Array.isArray(value) || value.length > MAX_POINTS_PER_SECTION) invalid(`OpenAI returned unsupported summary ${section}.`);
  const items = value.map((item) => validateItem(item, excerpt, section, MAX_POINT_BYTES));
  if (new Set(items.map((item) => item.text)).size !== items.length) invalid(`OpenAI returned duplicate summary ${section}.`);
  if (items.length === 0 && !warningNamesSection(warnings, section)) {
    invalid(`Unavailable summary ${section} requires a warning.`);
  }
  return items;
}

function wordCount(value: string): number {
  return value.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

/**
 * Summary prose is intentionally not checked as a literal source substring.
 * Exact quotes establish only that cited text occurs in the selected pages.
 */
export function validateDocumentSummaryOutput(output: unknown, excerpt: SummarySourceExcerpt): ValidatedSummaryOutput {
  const expected = ["overview", "contributions", "methods", "findings", "limitations", "warnings"];
  if (!isRecord(output) || !hasOnlyKeys(output, expected)) invalid("OpenAI returned malformed summary.");
  const warnings = validateWarnings(output.warnings);
  const overview = validateItem(output.overview, excerpt, "overview", MAX_OVERVIEW_BYTES);
  const contributions = validateSection(output.contributions, excerpt, "contributions", warnings);
  const methods = validateSection(output.methods, excerpt, "methods", warnings);
  const findings = validateSection(output.findings, excerpt, "findings", warnings);
  const limitations = validateSection(output.limitations, excerpt, "limitations", warnings);
  const prose = [overview, ...contributions, ...methods, ...findings, ...limitations].map((item) => item.text).join(" ");
  if (byteLength(prose) > MAX_SUMMARY_PROSE_BYTES || wordCount(prose) > MAX_SUMMARY_WORDS) {
    invalid(`OpenAI returned a summary exceeding the ${MAX_SUMMARY_WORDS}-word limit.`);
  }
  return { overview, contributions, methods, findings, limitations, warnings };
}
