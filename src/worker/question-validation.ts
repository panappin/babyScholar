import type { DocumentQuestionAnswerPart, DocumentQuestionEvidenceQuote, DocumentQuestionOutcome } from "./document-types.js";
import { DocumentError } from "./document-validation.js";
import { METADATA_EVIDENCE_QUOTE_BYTES, metadataPageContains, normalizeMetadataWhitespace } from "./metadata-validation.js";
import type { SummarySourceExcerpt } from "./summary-source.js";

const encoder = new TextEncoder();
const MAX_ANSWER_PARTS = 4;
const MAX_ANSWER_PART_BYTES = 2_000;
const MAX_EVIDENCE_PER_PART = 2;
const MAX_WARNINGS = 15;
const MAX_WARNING_BYTES = 500;
const MAX_INSUFFICIENT_REASON_BYTES = 1_000;
export const DOCUMENT_QUESTION_MAX_WORDS = 300;

export interface ValidatedDocumentQuestionOutput {
  outcome: DocumentQuestionOutcome;
  answerParts: DocumentQuestionAnswerPart[];
  insufficientSourceReason: string | null;
  warnings: string[];
}

function invalid(message: string): never {
  throw new DocumentError("question_invalid_response", 502, message);
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
    invalid(`OpenAI returned an unsupported question ${name}.`);
  }
  return value;
}

function wordCount(value: string): number {
  return value.match(/[\p{L}\p{N}]+(?:['\u2019-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

function validateEvidenceQuote(value: unknown, excerpt: SummarySourceExcerpt): DocumentQuestionEvidenceQuote {
  if (!isRecord(value) || !hasOnlyKeys(value, ["pageNumber", "quote"])) invalid("OpenAI returned malformed question evidence.");
  const pageNumber = value.pageNumber;
  const quote = value.quote;
  if (typeof pageNumber !== "number" || !Number.isInteger(pageNumber)
    || typeof quote !== "string" || quote.length === 0 || quote !== quote.trim()
    || byteLength(quote) > METADATA_EVIDENCE_QUOTE_BYTES) {
    invalid("OpenAI returned unsupported question evidence.");
  }
  const page = excerpt.pages.find((candidate) => candidate.pageNumber === pageNumber);
  if (!page || !metadataPageContains(page.text, quote)) {
    invalid("OpenAI returned question evidence that does not match the included PDF text.");
  }
  return { pageNumber, quote };
}

function validateAnswerParts(value: unknown, excerpt: SummarySourceExcerpt): DocumentQuestionAnswerPart[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ANSWER_PARTS) {
    invalid("OpenAI returned an unsupported question answer.");
  }
  const answerParts = value.map((part) => {
    if (!isRecord(part) || !hasOnlyKeys(part, ["text", "evidence"])) invalid("OpenAI returned malformed question answer.");
    const text = boundedText(part.text, MAX_ANSWER_PART_BYTES, "answer part");
    if (!Array.isArray(part.evidence) || part.evidence.length === 0 || part.evidence.length > MAX_EVIDENCE_PER_PART) {
      invalid("OpenAI returned unsupported question evidence.");
    }
    const evidence = part.evidence.map((quote) => validateEvidenceQuote(quote, excerpt));
    if (new Set(evidence.map((quote) => `${quote.pageNumber}\u0000${quote.quote}`)).size !== evidence.length) {
      invalid("OpenAI returned duplicate question evidence.");
    }
    return { text, evidence };
  });
  if (new Set(answerParts.map((part) => part.text)).size !== answerParts.length) invalid("OpenAI returned duplicate question answer parts.");
  if (wordCount(answerParts.map((part) => part.text).join(" ")) > DOCUMENT_QUESTION_MAX_WORDS) {
    invalid(`OpenAI returned an answer exceeding the ${DOCUMENT_QUESTION_MAX_WORDS}-word limit.`);
  }
  return answerParts;
}

function validateWarnings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_WARNINGS) invalid("OpenAI returned unsupported question warnings.");
  const warnings = value.map((warning) => boundedText(warning, MAX_WARNING_BYTES, "warning"));
  if (new Set(warnings).size !== warnings.length) invalid("OpenAI returned duplicate question warnings.");
  return warnings;
}

/** Validates provider output after strict structured-output decoding. */
export function validateDocumentQuestionOutput(output: unknown, excerpt: SummarySourceExcerpt): ValidatedDocumentQuestionOutput {
  const expected = ["outcome", "answerParts", "insufficientSourceReason", "warnings"];
  if (!isRecord(output) || !hasOnlyKeys(output, expected)) invalid("OpenAI returned malformed question data.");
  const warnings = validateWarnings(output.warnings);
  if (output.outcome === "answered") {
    if (output.insufficientSourceReason !== null) invalid("An answered question cannot include an insufficient-source reason.");
    return { outcome: "answered", answerParts: validateAnswerParts(output.answerParts, excerpt), insufficientSourceReason: null, warnings };
  }
  if (output.outcome === "insufficient_source") {
    if (!Array.isArray(output.answerParts) || output.answerParts.length !== 0) {
      invalid("An insufficient-source result cannot include an answer or citations.");
    }
    const insufficientSourceReason = boundedText(output.insufficientSourceReason, MAX_INSUFFICIENT_REASON_BYTES, "insufficient-source reason");
    if (excerpt.truncated && !/^the included (excerpt|pages)\b/iu.test(normalizeMetadataWhitespace(insufficientSourceReason))) {
      invalid("A partial-source conclusion must refer to the included excerpt.");
    }
    return { outcome: "insufficient_source", answerParts: [], insufficientSourceReason, warnings };
  }
  invalid("OpenAI returned an unsupported question outcome.");
}
