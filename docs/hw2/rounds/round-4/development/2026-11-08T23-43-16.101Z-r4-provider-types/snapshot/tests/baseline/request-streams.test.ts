import { afterEach, describe, expect, it, vi } from 'vitest';
import { readDocumentQuestion } from '../../src/worker/question-request';
import { readSavePaper } from '../../src/worker/library-validation';
import { readUploadedDocument } from '../../src/worker/document-validation';

const encoder = new TextEncoder();
const paper = { id: '2401.01234v2', title: '  Résumé 🧪\n', authors: [' Ada ', '李'],
  year: null, abstract: '', url: null, pdfUrl: null };
const libraryBody = JSON.stringify({ paper });
const questionBody = JSON.stringify({ question: 'Pourquoi é 🧪?' });
const jsonReaders = [
  { name: 'library', read: readSavePaper, body: libraryBody, limit: 262_144,
    expected: { paper: { ...paper, id: '2401.01234' } } },
  { name: 'question', read: readDocumentQuestion, body: questionBody, limit: 3_072,
    expected: { question: 'Pourquoi é 🧪?', normalizedQuestion: 'Pourquoi é 🧪?' } },
];
const readers = [
  ...jsonReaders.map(reader => ({ ...reader, contentType: 'application/json' })),
  { name: 'upload', read: readUploadedDocument, limit: 10_551_296,
    contentType: 'multipart/form-data; boundary=fixture' },
];

function request(body: ReadableStream<Uint8Array> | null, contentType: string, headers = {}) {
  const init: RequestInit & { duplex: 'half' } = { method: 'POST', body, duplex: 'half',
    headers: { 'content-type': contentType, ...headers } };
  return new Request('http://localhost/input', init);
}

function chunks(...values: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({ start(controller) {
    for (const value of values) controller.enqueue(value);
    controller.close();
  } });
}

afterEach(() => vi.useRealTimers());

describe.each(readers)('$name request stream (round 1)', ({ read, contentType, limit }) => {
  it('requires an uncompressed body of the supported media type', async () => {
    await expect(read(request(null, contentType))).rejects.toMatchObject({ kind: 'invalid_request', status: 400 });
    await expect(read(request(null, contentType, { 'content-encoding': 'gzip' })))
      .rejects.toMatchObject({ kind: 'unsupported_media_type', status: 415 });
    await expect(read(request(null, 'text/plain')))
      .rejects.toMatchObject({ kind: 'unsupported_media_type', status: 415 });
  });

  it('measures actual bytes despite a dishonest Content-Length and cancels overflow', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(limit)); controller.enqueue(new Uint8Array(1)); },
      cancel,
    });
    await expect(read(request(body, contentType, { 'content-length': '1' })))
      .rejects.toMatchObject({ kind: 'body_too_large', status: 413 });
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it('maps a broken transport to invalid_request and releases the reader', async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('transport fault')); } });
    await expect(read(request(body, contentType))).rejects.toMatchObject({ kind: 'invalid_request', status: 400 });
    expect(body.locked).toBe(false);
  });

  it('expires at 10 seconds even when stream cancellation never settles', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ cancel });
    let settled = false;
    const result = read(request(body, contentType)).catch(error => { settled = true; return error; });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ kind: 'request_timeout', status: 408 });
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe.each(jsonReaders)('$name JSON decoding (round 1)', ({ read, body, limit, expected }) => {
  it('decodes multibyte code points split across single-byte chunks and clears the timer', async () => {
    vi.useFakeTimers();
    const stream = chunks(...Array.from(encoder.encode(body), byte => new Uint8Array([byte])));
    await expect(read(request(stream, 'Application/JSON; charset=utf-8', { 'content-encoding': 'identity' })))
      .resolves.toEqual(expected);
    expect(stream.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts exactly the wrapper byte budget, independent of Content-Length', async () => {
    const padded = body + ' '.repeat(limit - encoder.encode(body).byteLength);
    expect(encoder.encode(padded).byteLength).toBe(limit);
    await expect(read(request(chunks(encoder.encode(padded)), 'application/json', { 'content-length': '99999999' })))
      .resolves.toEqual(expected);
  });

  it.each([
    { name: 'invalid JSON', bytes: encoder.encode('{') },
    { name: 'invalid UTF-8', bytes: new Uint8Array([0xff]) },
    { name: 'incomplete UTF-8', bytes: new Uint8Array([0xe2, 0x82]) },
  ])('rejects $name with an explicit client error', async ({ bytes }) => {
    const stream = chunks(bytes);
    await expect(read(request(stream, 'application/json'))).rejects.toMatchObject({ kind: 'invalid_request', status: 400 });
    expect(stream.locked).toBe(false);
  });
});

const pdf = encoder.encode('%PDF-1.7\nfixture');
function upload(bytes = pdf, name = 'paper.pdf', mime = 'application/pdf') {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mime }), name);
  return form;
}
const uploadRequest = (form: FormData) => new Request('http://localhost/documents', { method: 'POST', body: form });

describe('PDF multipart contract (round 1)', () => {
  it('retains original bytes and a known SHA-256; MIME and extension are not the oracle', async () => {
    const result = await readUploadedDocument(uploadRequest(upload(pdf, 'notes.bin', 'text/plain')));
    expect(result).toEqual({ filename: 'notes.bin', bytes: pdf,
      sha256: 'f581fc87f30296eff11777c3ce1b9a8b7077071ad8abedfcba317fef0c807224' });
  });

  it.each([
    { name: 'no file', form: () => new FormData() },
    { name: 'text field instead of a file', form: () => { const form = new FormData(); form.set('file', '%PDF-text'); return form; } },
    { name: 'duplicate files', form: () => { const form = upload(); form.append('file', new Blob([pdf]), 'other.pdf'); return form; } },
    { name: 'additional field', form: () => { const form = upload(); form.set('extra', 'value'); return form; } },
    { name: 'empty file', form: () => upload(new Uint8Array()) },
    { name: 'wrong signature with PDF MIME', form: () => upload(encoder.encode('not a PDF')) },
    { name: 'short signature', form: () => upload(encoder.encode('%PDF')) },
    { name: '256 code point name', form: () => upload(pdf, '🧪'.repeat(256)) },
  ])('rejects $name', async ({ form }) => {
    await expect(readUploadedDocument(uploadRequest(form())))
      .rejects.toMatchObject({ kind: 'invalid_request', status: 400 });
  });

  it('accepts 255 Unicode code points, rather than counting UTF-16 units', async () => {
    await expect(readUploadedDocument(uploadRequest(upload(pdf, '🧪'.repeat(255)))))
      .resolves.toHaveProperty('filename', '🧪'.repeat(255));
  });

  it('accepts an exact 10 MiB file and rejects one extra byte inside a valid multipart body', async () => {
    const exact = new Uint8Array(10 * 1024 * 1024);
    exact.set(pdf);
    const accepted = await readUploadedDocument(uploadRequest(upload(exact)));
    expect(Buffer.compare(accepted.bytes, exact)).toBe(0);
    const extra = new Uint8Array(exact.length + 1);
    extra.set(pdf);
    await expect(readUploadedDocument(uploadRequest(upload(extra))))
      .rejects.toMatchObject({ kind: 'body_too_large', status: 413 });
  });

  it('rejects an unparseable multipart envelope', async () => {
    await expect(readUploadedDocument(request(chunks(pdf), 'multipart/form-data')))
      .rejects.toMatchObject({ kind: 'invalid_request', status: 400 });
  });
});
