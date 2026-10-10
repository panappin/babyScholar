import type {
  DocumentSummaryEvidenceQuote,
  DocumentSummaryItem,
  DocumentSummarySection,
} from "./document-types.js";
import { DocumentError } from "./document-validation.js";
import { metadataPageContains } from "./metadata-validation.js";
import { SUMMARY_EVIDENCE_REFERENCE_BYTES, type SummarySourceExcerpt } from "./summary-source.js";

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

type SummaryEvidenceRejectionReason =
  | "reference_shape"
  | "page_number_type"
  | "page_number_integer"
  | "reference_id_type"
  | "reference_id_integer"
  | "reference_not_issued"
  | "resolved_quote_empty"
  | "resolved_quote_too_large"
  | "resolved_quote_mismatch"
  | "duplicate_reference";

function invalid(message: string): never {
  throw new DocumentError("summary_invalid_response", 502, message);
}

/**
 * Keep provider/PDF content out of diagnostics. The fixed item label, index,
 * and reason are enough to identify a malformed reference in Worker logs.
 */
function invalidEvidence(item: string, index: number, reason: SummaryEvidenceRejectionReason): never {
  console.warn(JSON.stringify({ event: "summary_evidence_rejected", item, index, reason }));
  invalid("OpenAI returned unsupported summary evidence.");
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

function validateEvidenceReference(
  value: unknown,
  excerpt: SummarySourceExcerpt,
  item: string,
  index: number,
): DocumentSummaryEvidenceQuote {
  if (!isRecord(value) || !hasOnlyKeys(value, ["pageNumber", "referenceId"])) invalidEvidence(item, index, "reference_shape");
  const pageNumber = value.pageNumber;
  const referenceId = value.referenceId;
  if (typeof pageNumber !== "number") invalidEvidence(item, index, "page_number_type");
  if (!Number.isInteger(pageNumber)) invalidEvidence(item, index, "page_number_integer");
  if (typeof referenceId !== "number") invalidEvidence(item, index, "reference_id_type");
  if (!Number.isInteger(referenceId)) invalidEvidence(item, index, "reference_id_integer");
  const reference = excerpt.evidenceReferences.find((candidate) => (
    candidate.pageNumber === pageNumber && candidate.referenceId === referenceId
  ));
  if (!reference) invalidEvidence(item, index, "reference_not_issued");
  const page = excerpt.pages.find((candidate) => candidate.pageNumber === pageNumber);
  if (!reference.quote || reference.quote !== reference.quote.trim()) invalidEvidence(item, index, "resolved_quote_empty");
  if (byteLength(reference.quote) > SUMMARY_EVIDENCE_REFERENCE_BYTES) invalidEvidence(item, index, "resolved_quote_too_large");
  if (!page || !metadataPageContains(page.text, reference.quote)) invalidEvidence(item, index, "resolved_quote_mismatch");
  return { pageNumber, quote: reference.quote };
}

function validateItem(value: unknown, excerpt: SummarySourceExcerpt, name: string, maximumBytes: number): DocumentSummaryItem {
  if (!isRecord(value) || !hasOnlyKeys(value, ["text", "evidence"])) invalid("OpenAI returned malformed summary item.");
  const text = boundedText(value.text, maximumBytes, `${name} text`);
  if (!Array.isArray(value.evidence) || value.evidence.length === 0 || value.evidence.length > MAX_EVIDENCE_PER_ITEM) {
    invalid("OpenAI returned unsupported summary evidence.");
  }
  const evidence = value.evidence.map((reference, index) => validateEvidenceReference(reference, excerpt, name, index));
  if (new Set(evidence.map((quote) => `${quote.pageNumber}\u0000${quote.quote}`)).size !== evidence.length) {
    invalidEvidence(name, -1, "duplicate_reference");
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
