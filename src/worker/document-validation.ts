import type { DocumentErrorKind } from "./document-types.js";

export const DOCUMENT_FILE_BYTES = 10 * 1024 * 1024;
// Multipart boundaries and the one permitted field need a small, explicit
// allowance. The raw body remains bounded before any multipart parser runs.
export const DOCUMENT_MULTIPART_OVERHEAD_BYTES = 64 * 1024;
export const DOCUMENT_BODY_BYTES = DOCUMENT_FILE_BYTES + DOCUMENT_MULTIPART_OVERHEAD_BYTES;
export const DOCUMENT_BODY_TIMEOUT_MS = 10_000;
export const DOCUMENT_FILENAME_CODE_POINTS = 255;

export class DocumentError extends Error {
  constructor(readonly kind: DocumentErrorKind, readonly status: number, message: string) {
    super(message);
    this.name = "DocumentError";
  }
}

export interface ValidatedDocumentUpload {
  filename: string;
  bytes: Uint8Array;
  sha256: string;
}

function invalid(message: string): never {
  throw new DocumentError("invalid_request", 400, message);
}

function tooLarge(message: string): never {
  throw new DocumentError("body_too_large", 413, message);
}

function isFile(value: unknown): value is File {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { name?: unknown; size?: unknown; arrayBuffer?: unknown };
  return typeof candidate.name === "string"
    && typeof candidate.size === "number"
    && typeof candidate.arrayBuffer === "function";
}

function hasPdfSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 5
    && bytes[0] === 0x25 // %
    && bytes[1] === 0x50 // P
    && bytes[2] === 0x44 // D
    && bytes[3] === 0x46 // F
    && bytes[4] === 0x2d; // -
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Read the incoming stream ourselves before constructing a second Request for
// formData(). This keeps multipart parsing inside the same byte/time bounds and
// deliberately ignores untrusted Content-Length.
async function readBoundedMultipartBody(request: Request): Promise<Uint8Array> {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "multipart/form-data" || ![null, "identity"].includes(request.headers.get("content-encoding"))) {
    throw new DocumentError("unsupported_media_type", 415, "Use an uncompressed multipart/form-data body.");
  }
  if (!request.body) return invalid("A multipart/form-data body containing file is required.");

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
      if (total > DOCUMENT_BODY_BYTES) {
        tooLarge(`The multipart request body must not exceed ${DOCUMENT_BODY_BYTES} bytes.`);
      }
      chunks.push(chunk.value);
    }
    complete = true;
  } catch (error) {
    if (error instanceof DocumentError) throw error;
    return invalid("The multipart request body could not be read.");
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
  return bytes;
}

function singleFile(form: FormData): File {
  const entries = Array.from(form.entries());
  const fileEntries = entries.filter(([name]) => name === "file");
  if (fileEntries.length === 0) return invalid("Provide exactly one multipart field named file.");
  if (fileEntries.length !== 1 || entries.length !== 1) {
    return invalid("Provide exactly one multipart field named file and no additional fields.");
  }
  const value = fileEntries[0][1];
  if (!isFile(value)) return invalid("The file field must contain an uploaded file.");
  return value;
}

export async function readUploadedDocument(request: Request): Promise<ValidatedDocumentUpload> {
  const body = await readBoundedMultipartBody(request);
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  let form: FormData;
  try {
    form = await new Request(request.url, { method: "POST", headers, body }).formData();
  } catch {
    return invalid("The multipart/form-data body could not be parsed.");
  }

  const file = singleFile(form);
  const filename = file.name;
  if (!filename || [...filename].length > DOCUMENT_FILENAME_CODE_POINTS || filename.includes("\0")) {
    return invalid(`The file name must contain at most ${DOCUMENT_FILENAME_CODE_POINTS} characters and no null characters.`);
  }
  if (file.size === 0) return invalid("The PDF file must not be empty.");
  if (file.size > DOCUMENT_FILE_BYTES) {
    tooLarge(`The PDF file must not exceed ${DOCUMENT_FILE_BYTES} bytes.`);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  // Recheck actual decoded multipart data instead of trusting File metadata.
  if (bytes.byteLength === 0) return invalid("The PDF file must not be empty.");
  if (bytes.byteLength > DOCUMENT_FILE_BYTES) {
    tooLarge(`The PDF file must not exceed ${DOCUMENT_FILE_BYTES} bytes.`);
  }
  if (!hasPdfSignature(bytes)) {
    return invalid("The uploaded file must begin with a PDF signature.");
  }
  return { filename, bytes, sha256: await sha256(bytes) };
}
