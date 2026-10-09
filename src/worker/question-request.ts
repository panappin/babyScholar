import { normalizeMetadataWhitespace } from "./metadata-validation.js";
import { DOCUMENT_BODY_TIMEOUT_MS, DocumentError } from "./document-validation.js";

export const DOCUMENT_QUESTION_MAX_BYTES = 2 * 1024;
// The JSON wrapper is bounded separately from the question's own UTF-8 limit.
export const DOCUMENT_QUESTION_BODY_BYTES = 3 * 1024;

export interface ValidatedDocumentQuestion {
  question: string;
  normalizedQuestion: string;
}

const encoder = new TextEncoder();

function invalid(message: string): never {
  throw new DocumentError("invalid_request", 400, message);
}

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function hasOnlyQuestion(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === "question";
}

async function readBoundedJsonBody(request: Request): Promise<unknown> {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json" || ![null, "identity"].includes(request.headers.get("content-encoding"))) {
    throw new DocumentError("unsupported_media_type", 415, "Use an uncompressed application/json question body.");
  }
  if (!request.body) return invalid("A JSON body containing question is required.");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new DocumentError("request_timeout", 408, "The request body took too long to arrive.")),
      DOCUMENT_BODY_TIMEOUT_MS,
    );
  });
  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > DOCUMENT_QUESTION_BODY_BYTES) {
        throw new DocumentError("body_too_large", 413, `The question JSON body must not exceed ${DOCUMENT_QUESTION_BODY_BYTES} bytes.`);
      }
      chunks.push(chunk.value);
    }
    complete = true;
  } catch (error) {
    if (error instanceof DocumentError) throw error;
    return invalid("The question body could not be read.");
  } finally {
    if (!complete) await Promise.race([reader.cancel(), deadline]).catch(() => undefined);
    if (timeout !== undefined) clearTimeout(timeout);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return invalid("The question body must contain valid JSON.");
  }
}

/** Strictly validates the only accepted POST body and its stable cache identity. */
export async function readDocumentQuestion(request: Request): Promise<ValidatedDocumentQuestion> {
  const value = await readBoundedJsonBody(request);
  if (typeof value !== "object" || value === null || Array.isArray(value) || !hasOnlyQuestion(value as Record<string, unknown>)) {
    return invalid("Provide exactly one JSON field named question.");
  }
  const question = (value as Record<string, unknown>).question;
  if (typeof question !== "string" || question.length === 0 || question !== question.trim()) {
    return invalid("Question must be a trimmed, nonempty string.");
  }
  if (byteLength(question) > DOCUMENT_QUESTION_MAX_BYTES) {
    throw new DocumentError("body_too_large", 413, `Question must not exceed ${DOCUMENT_QUESTION_MAX_BYTES} UTF-8 bytes.`);
  }
  const normalizedQuestion = normalizeMetadataWhitespace(question);
  if (!normalizedQuestion) return invalid("Question must be a trimmed, nonempty string.");
  return { question, normalizedQuestion };
}
