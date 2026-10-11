import type { DocumentSummaryItem, DocumentSummarySection } from "./document-types.js";
import { DocumentError } from "./document-validation.js";
import type { SummarySourceExcerpt } from "./summary-source.js";

const encoder = new TextEncoder();
const MAX_SUMMARY_PROSE_BYTES = 12_000;
const MAX_POINTS_PER_SECTION = 32;
const MAX_WARNINGS = 15;
const MAX_WARNING_BYTES = 500;

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

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function boundedText(value: unknown, maximumBytes: number, name: string): string {
  if (typeof value !== "string") invalid(`OpenAI returned an unsupported summary ${name}.`);
  const text = value.trim();
  if (!text || byteLength(text) > maximumBytes) invalid(`OpenAI returned an unsupported summary ${name}.`);
  return text;
}

function validateItem(value: unknown, name: string): DocumentSummaryItem {
  const text = boundedText(isRecord(value) ? value.text : value, MAX_SUMMARY_PROSE_BYTES, name);
  return { text, evidence: [] };
}

function validateSection(value: unknown, section: DocumentSummarySection): DocumentSummaryItem[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_POINTS_PER_SECTION) invalid(`OpenAI returned unsupported summary ${section}.`);
  return value.map((item) => validateItem(item, section));
}

function validateWarnings(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_WARNINGS) invalid("OpenAI returned unsupported summary warnings.");
  return value.map((warning) => boundedText(warning, MAX_WARNING_BYTES, "warning"));
}

/** Accept ordinary prose and older structured responses; new evidence is discarded. */
export function validateDocumentSummaryOutput(output: unknown, _excerpt: SummarySourceExcerpt): ValidatedSummaryOutput {
  if (typeof output === "string") {
    const text = boundedText(output, MAX_SUMMARY_PROSE_BYTES, "text");
    // Older provider fixtures and responses may still contain a JSON summary.
    if (text.startsWith("{")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      if (isRecord(parsed) && Object.hasOwn(parsed, "overview")) output = parsed;
    }
    if (typeof output === "string") {
      return { overview: { text, evidence: [] }, contributions: [], methods: [], findings: [], limitations: [], warnings: [] };
    }
  }

  if (!isRecord(output)) invalid("OpenAI returned malformed summary.");
  const overview = validateItem(output.overview, "overview");
  const contributions = validateSection(output.contributions, "contributions");
  const methods = validateSection(output.methods, "methods");
  const findings = validateSection(output.findings, "findings");
  const limitations = validateSection(output.limitations, "limitations");
  const warnings = validateWarnings(output.warnings);
  const prose = [overview, ...contributions, ...methods, ...findings, ...limitations].map((item) => item.text).join(" ");
  if (byteLength(prose) > MAX_SUMMARY_PROSE_BYTES) invalid("OpenAI returned a summary exceeding the byte limit.");
  return { overview, contributions, methods, findings, limitations, warnings };
}
