import { describe, expect, it } from 'vitest';
import { readDocumentQuestion } from '../../src/worker/question-request';
import { readSavePaper } from '../../src/worker/library-validation';

const encoder = new TextEncoder();
const paper = { id: '2401.01234', title: 'A_MARKER_B', authors: [], year: null, abstract: '', url: null, pdfUrl: null };
const readers = [
  { name: 'question', read: readDocumentQuestion, json: JSON.stringify({ question: 'A_MARKER_B' }),
    expected: { question: 'A_�_B', normalizedQuestion: 'A_�_B' } },
  { name: 'library', read: readSavePaper, json: JSON.stringify({ paper }),
    expected: { paper: { ...paper, title: 'A_�_B' } } },
];

function request(json: string, insertion: Uint8Array) {
  const [prefix, suffix] = json.split('MARKER');
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(encoder.encode(prefix));
    controller.enqueue(insertion);
    controller.enqueue(encoder.encode(suffix));
    controller.close();
  } });
  const init: RequestInit & { duplex: 'half' } = { method: 'POST', body: stream, duplex: 'half',
    headers: { 'content-type': 'application/json' } };
  return new Request('http://localhost/input', init);
}

describe.each(readers)('$name UTF-8 integrity (round 2 survivor feedback)', ({ read, json, expected }) => {
  it.each([
    { name: 'invalid leading byte', bytes: [0xff] },
    { name: 'invalid continuation', bytes: [0xc3, 0x28] },
    { name: 'encoded surrogate', bytes: [0xed, 0xa0, 0x80] },
    { name: 'incomplete four-byte sequence', bytes: [0xf0, 0x9f, 0x92] },
  ])('rejects $name inside otherwise valid JSON', async ({ bytes }) => {
    // Unlike round 1's bare invalid bytes, lossy decoding would make this a
    // valid request. The oracle specifically detects data-corrupting decoding.
    const input = request(json, new Uint8Array(bytes));
    await expect(read(input)).rejects.toMatchObject({ kind: 'invalid_request', status: 400 });
    expect(input.body?.locked).toBe(false);
  });

  it('accepts an intentionally supplied, correctly encoded replacement character', async () => {
    await expect(read(request(json, encoder.encode('�')))).resolves.toEqual(expected);
  });
});
