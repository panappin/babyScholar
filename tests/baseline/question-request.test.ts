import { describe, expect, it } from 'vitest';
import { readDocumentQuestion } from '../../src/worker/question-request';

const request = (body: unknown, type = 'application/json') => new Request('http://localhost/question', {
  method: 'POST', headers: { 'content-type': type }, body: JSON.stringify(body),
});

describe('question request: initial contract cases', () => {
  it('preserves display text and normalizes cache whitespace', async () => {
    await expect(readDocumentQuestion(request({ question: 'What  is\nthis?' }))).resolves.toEqual({
      question: 'What  is\nthis?', normalizedQuestion: 'What is this?',
    });
  });
  it.each([{}, [], null, { question: 3 }, { question: '' }, { question: ' padded ' }, { question: 'Why?', extra: true }])
    ('rejects invalid shape/value %j', async body => {
      await expect(readDocumentQuestion(request(body))).rejects.toMatchObject({ status: 400 });
    });
  it('rejects unsupported content type', async () => {
    await expect(readDocumentQuestion(request({ question: 'Why?' }, 'text/plain'))).rejects.toMatchObject({ status: 415 });
  });
  it('accepts the exact question byte limit', async () => {
    await expect(readDocumentQuestion(request({ question: 'x'.repeat(2048) }))).resolves.toHaveProperty('question', 'x'.repeat(2048));
  });
  it('enforces bytes, not character count, for multibyte questions', async () => {
    await expect(readDocumentQuestion(request({ question: 'é'.repeat(1025) }))).rejects.toMatchObject({ status: 413 });
  });
});
