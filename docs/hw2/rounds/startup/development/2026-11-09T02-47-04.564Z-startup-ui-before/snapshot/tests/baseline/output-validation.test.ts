import { describe, expect, it, vi, afterEach } from 'vitest';
import { validateMetadataOutput } from '../../src/worker/metadata-validation';
import { validateDocumentSummaryOutput } from '../../src/worker/summary-validation';
import { validateDocumentQuestionOutput } from '../../src/worker/question-validation';
import type { SummarySourceExcerpt } from '../../src/worker/summary-source';

// Empty context deliberately proves that quote matching is not an acceptance gate.
const excerpt: SummarySourceExcerpt = { pages: [], pageNumbers: [], pageRanges: [], evidenceReferences: [],
  byteCount: 0, totalPageCount: 0, truncated: false, coverageWarning: 'No extracted pages.' };
const metadataExcerpt = { pages: [], pageNumbers: [], byteCount: 0, clipped: false };
const metadata = (value: unknown) => validateMetadataOutput(value, metadataExcerpt);
const summary = (value: unknown) => validateDocumentSummaryOutput(value, excerpt);
const question = (value: unknown) => validateDocumentQuestionOutput(value, excerpt);
const invalid = (kind: string) => expect.objectContaining({ kind: `${kind}_invalid_response`, status: 502 });

afterEach(() => vi.restoreAllMocks());

describe('metadata output contract (round 1)', () => {
  it('allows nullable bibliographic fields without citations', () => {
    expect(metadata({ title: null })).toEqual({ title: null, authors: null, year: null, abstract: null,
      evidence: { title: [], authors: [], year: [], abstract: [] }, warnings: [] });
  });

  it('retains supplied fields, filters warnings, and discards unverified new quotes', () => {
    expect(metadata({ title: '  A title  ', authors: [' Ada ', '', null], year: 2024,
      abstract: ' Abstract ', evidence: { title: [{ pageNumber: 999, quote: 'not in source' }] },
      warnings: ['  uncertain  ', '', 7, 'x'.repeat(501)] })).toEqual({
      title: 'A title', authors: ['Ada'], year: 2024, abstract: 'Abstract',
      evidence: { title: [], authors: [], year: [], abstract: [] }, warnings: ['uncertain'],
    });
  });

  it.each([null, [], {}, { title: 5 }, { authors: 'Ada' }, { authors: [false] },
    { year: 999 }, { year: 3000 }, { year: 2024.5 }, { year: '2024' },
    { title: 'é'.repeat(501) }, { abstract: 'é'.repeat(6001) },
    { authors: ['é'.repeat(251)] }, { authors: Array(33).fill('Ada') }])
  ('rejects invalid metadata case %#', value => expect(() => metadata(value)).toThrowError(invalid('metadata')));

  it('accepts exact UTF-8 field limits and bounded author count', () => {
    const result = metadata({ title: 'é'.repeat(500), abstract: 'é'.repeat(6000), authors: Array(32).fill('é'.repeat(250)), year: 2999 });
    expect(result.title).toBe('é'.repeat(500));
    expect(result.abstract).toBe('é'.repeat(6000));
    expect(result.authors).toEqual(Array(32).fill('é'.repeat(250)));
    expect(result.year).toBe(2999);
  });
});

describe('summary output contract (round 1)', () => {
  it('accepts plain prose without a JSON envelope or evidence', () => {
    expect(summary('  A useful summary.  ')).toEqual({ overview: { text: 'A useful summary.', evidence: [] },
      contributions: [], methods: [], findings: [], limitations: [], warnings: [] });
  });

  it('decodes a legacy envelope, preserves text and warnings, and omits unverified quotes', () => {
    const value = { overview: { text: ' Overview ', evidence: [{ pageNumber: 999, quote: 'invented' }] },
      contributions: [' A contribution '], methods: [], findings: [{ text: 'Finding' }],
      limitations: ['Uncertain'], warnings: [' Caution '] };
    expect(summary(JSON.stringify(value))).toEqual({ overview: { text: 'Overview', evidence: [] },
      contributions: [{ text: 'A contribution', evidence: [] }], methods: [],
      findings: [{ text: 'Finding', evidence: [] }], limitations: [{ text: 'Uncertain', evidence: [] }], warnings: ['Caution'] });
  });

  it.each(['{unfinished prose', '{"note":"ordinary text, no overview"}'])
  ('keeps non-envelope text as prose: %s', text => expect(summary(text).overview).toEqual({ text, evidence: [] }));

  it('accepts exactly 12000 UTF-8 bytes and rejects one byte more', () => {
    const text = 'é'.repeat(6000);
    expect(summary(text).overview.text).toBe(text);
    expect(() => summary(text + 'x')).toThrowError(invalid('summary'));
  });

  it('enforces the aggregate prose budget across sections', () => {
    expect(() => summary({ overview: 'x'.repeat(6000), contributions: ['y'.repeat(6000)] }))
      .toThrowError(invalid('summary'));
  });

  it.each([null, [], '', '  ', { overview: 1 }, { overview: 'ok', methods: null },
    { overview: 'ok', findings: Array(33).fill('finding') }, { overview: 'ok', warnings: 'warning' },
    { overview: 'ok', warnings: Array(16).fill('warning') }, { overview: 'ok', warnings: ['é'.repeat(251)] }])
  ('rejects invalid summary case %#', value => expect(() => summary(value)).toThrowError(invalid('summary')));
});

describe('question answer contract (round 1)', () => {
  it('accepts ordinary answers and does not impose a hard 300-word validation rule', () => {
    const prose = Array(301).fill('word').join(' ');
    const result = question(prose);
    expect(result).toMatchObject({ outcome: 'answered', answerParts: [{ text: prose, evidence: [] }], insufficientSourceReason: null });
    expect(result.warnings).toEqual([expect.stringContaining('Citations are optional')]);
  });

  it('accepts a legacy answer envelope and strips even malformed optional evidence', () => {
    expect(question(JSON.stringify({ answerParts: [{ text: ' Answer ', evidence: 'unverified' }] })))
      .toMatchObject({ outcome: 'answered', answerParts: [{ text: 'Answer', evidence: [] }], insufficientSourceReason: null });
    expect(question({ answer: 'Direct answer' }).answerParts).toEqual([{ text: 'Direct answer', evidence: [] }]);
  });

  it('preserves a usable insufficient-source explanation', () => {
    expect(question({ outcome: 'insufficient_source', insufficientSourceReason: '  Not enough context. ' }))
      .toMatchObject({ outcome: 'insufficient_source', answerParts: [], insufficientSourceReason: 'Not enough context.' });
  });

  it('accepts exactly 16000 UTF-8 bytes and rejects one extra byte', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const text = 'é'.repeat(8000);
    expect(question(text).answerParts).toEqual([{ text, evidence: [] }]);
    expect(() => question(text + 'x')).toThrowError(invalid('question'));
  });

  it('counts separators in the combined answer budget', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => question({ answerParts: [{ text: 'x'.repeat(8000) }, { text: 'y'.repeat(8000) }] }))
      .toThrowError(invalid('question'));
  });

  it.each([null, [], {}, '', '   ', '...?!', { answerParts: [null] },
    { answerParts: [] }, { answerParts: Array(5).fill({ text: 'Answer' }) },
    { outcome: 'insufficient_source', insufficientSourceReason: '' }])
  ('rejects unusable answer case %#', value => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => question(value)).toThrowError(invalid('question'));
  });
});
