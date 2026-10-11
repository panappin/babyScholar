import type { DocumentQuestionAnswerPart, DocumentQuestionOutcome } from "./document-types.js";
import { DocumentError } from "./document-validation.js";
import type { SummarySourceExcerpt } from "./summary-source.js";

const encoder = new TextEncoder();
const MAX_ANSWER_BYTES = 16_000;
export const DOCUMENT_QUESTION_MAX_WORDS = 300;

export interface ValidatedDocumentQuestionOutput {
  outcome: DocumentQuestionOutcome;
  answerParts: DocumentQuestionAnswerPart[];
  insufficientSourceReason: string | null;
  warnings: string[];
}

function invalid(): never {
  console.warn(JSON.stringify({ event: "document_question_output_rejected", stage: "schema_validation_failed" }));
  throw new DocumentError("question_invalid_response", 502, "The question provider did not return a usable bounded answer.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function answer(value: unknown): string {
  if (typeof value !== "string" || !/[\p{L}\p{N}]/u.test(value) || encoder.encode(value).byteLength > MAX_ANSWER_BYTES) invalid();
  return value.trim();
}

/**
 * Ordinary text is the preferred provider result. Legacy structured responses
 * remain usable, but optional citation data never gates answer acceptance.
 * Newly generated evidence is omitted rather than presenting unverified quotes.
 * Existing stored records are read unchanged by document-questions.ts.
 */
export function validateDocumentQuestionOutput(output: unknown, _excerpt: SummarySourceExcerpt): ValidatedDocumentQuestionOutput {
  if (typeof output === "string") {
    const text = answer(output);
    // Compatibility with existing fixture/providers returning the older JSON
    // envelope. This is optional decoding, not a mandatory structured format.
    let decoded: unknown;
    try { decoded = JSON.parse(text); } catch { /* Normal plain-text answer. */ }
    output = isRecord(decoded) ? decoded : text;
  }

  const warnings = ["This answer may include uncertainty or supplementary general knowledge. Citations are optional and new quotations are not verified."];
  let answerParts: DocumentQuestionAnswerPart[];
  if (typeof output === "string") {
    answerParts = [{ text: answer(output), evidence: [] }];
  } else if (isRecord(output)) {
    if (Array.isArray(output.answerParts) && output.answerParts.length > 0 && output.answerParts.length <= 4) {
      answerParts = output.answerParts.map((part) => {
        if (!isRecord(part)) invalid();
        return { text: answer(part.text), evidence: [] };
      });
    } else if (typeof output.answer === "string") {
      answerParts = [{ text: answer(output.answer), evidence: [] }];
    } else if (output.outcome === "insufficient_source" && typeof output.insufficientSourceReason === "string") {
      return { outcome: "insufficient_source", answerParts: [], insufficientSourceReason: answer(output.insufficientSourceReason), warnings };
    } else invalid();
  } else invalid();

  const prose = answerParts.map((part) => part.text).join("\n\n");
  if (encoder.encode(prose).byteLength > MAX_ANSWER_BYTES) invalid();
  return { outcome: "answered", answerParts, insufficientSourceReason: null, warnings };
}
