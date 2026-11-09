import { describe, expect, it } from 'vitest';
import { selectSummarySource } from '../../src/worker/summary-source';
import { selectMetadataSource } from '../../src/worker/metadata-source';
import type { DocumentExtraction } from '../../src/worker/document-types';

function extraction(texts: string[]): DocumentExtraction {
  return { documentId: '11111111-1111-4111-8111-111111111111', sourceSha256: 'a'.repeat(64),
    parser: 'unpdf', parserVersion: 'fixture', extractedAt: '2026-01-01T00:00:00.000Z',
    pageCount: texts.length, pages: texts.map((text, index) => ({ pageNumber: index + 1, text })) };
}

const selectors = [
  { name: 'summary', select: selectSummarySource, budget: 98_304, flag: 'truncated' },
  { name: 'metadata', select: selectMetadataSource, budget: 24_000, flag: 'clipped' },
] as const;

describe.each(selectors)('$name source budget (round 2)', ({ select, budget, flag }) => {
  it('handles an empty extraction explicitly', () => {
    expect(select(extraction([]))).toMatchObject({ pages: [], pageNumbers: [], byteCount: 0, [flag]: false });
  });

  it('accepts an exact byte budget without marking complete input as clipped', () => {
    const text = 'é'.repeat(budget / 2);
    expect(select(extraction([text]))).toMatchObject({ pages: [{ pageNumber: 1, text }],
      pageNumbers: [1], byteCount: budget, [flag]: false });
  });

  it('clips one-byte overflow at exactly the documented limit', () => {
    const text = 'x'.repeat(budget);
    expect(select(extraction([text + 'Z']))).toMatchObject({ pages: [{ pageNumber: 1, text }],
      pageNumbers: [1], byteCount: budget, [flag]: true });
  });

  it('does not include later pages when an earlier page fills the budget', () => {
    const text = 'x'.repeat(budget);
    expect(select(extraction([text, 'later']))).toMatchObject({ pages: [{ pageNumber: 1, text }],
      pageNumbers: [1], byteCount: budget, [flag]: true });
  });

  it.each([1, 2, 3])('retains a complete Unicode prefix with %i byte(s) left for a four-byte character', remaining => {
    const prefix = 'x'.repeat(budget - remaining);
    const result = select(extraction([prefix + '🧪Z', 'later']));
    expect(result).toMatchObject({ pages: [{ pageNumber: 1, text: prefix }], pageNumbers: [1],
      byteCount: budget - remaining, [flag]: true });
    expect(new TextEncoder().encode(result.pages[0].text).byteLength).toBe(result.byteCount);
    expect(result.pages[0].text.isWellFormed()).toBe(true);
  });

  it('does not mutate persisted extraction pages while selecting a partial final page', () => {
    const input = extraction(['opening', 'x'.repeat(budget)]);
    const before = structuredClone(input);
    for (const page of input.pages) Object.freeze(page);
    Object.freeze(input.pages);
    Object.freeze(input);
    const result = select(input);
    expect(result.pages).toEqual([{ pageNumber: 1, text: 'opening' }, { pageNumber: 2, text: 'x'.repeat(budget - 7) }]);
    expect(result.byteCount).toBe(budget);
    expect(input).toEqual(before);
  });
});

describe('different source policies (round 2)', () => {
  it('includes later summary pages and preserves empty pages and contiguous ranges', () => {
    const input = extraction(['intro', '', 'method', 'late finding']);
    expect(selectSummarySource(input)).toEqual({ pages: input.pages, evidenceReferences: [],
      pageNumbers: [1, 2, 3, 4], pageRanges: [{ startPage: 1, endPage: 4 }],
      byteCount: 23, totalPageCount: 4, truncated: false,
      coverageWarning: 'Source coverage: all 4 extracted page(s) were included.' });
  });

  it('limits metadata to the first three pages, even when more text would fit', () => {
    expect(selectMetadataSource(extraction(['intro', 'authors', 'abstract', 'appendix']))).toEqual({
      pages: [{ pageNumber: 1, text: 'intro' }, { pageNumber: 2, text: 'authors' }, { pageNumber: 3, text: 'abstract' }],
      pageNumbers: [1, 2, 3], byteCount: 20, clipped: true,
    });
  });

  it('keeps an exactly three-page metadata excerpt complete', () => {
    expect(selectMetadataSource(extraction(['a', '', 'b']))).toEqual({ pages: [{ pageNumber: 1, text: 'a' },
      { pageNumber: 2, text: '' }, { pageNumber: 3, text: 'b' }], pageNumbers: [1, 2, 3], byteCount: 2, clipped: false });
  });

  it('reports partial summary coverage with the original total page count', () => {
    const result = selectSummarySource(extraction(['x'.repeat(98_304), 'omitted']));
    expect(result.pageRanges).toEqual([{ startPage: 1, endPage: 1 }]);
    expect(result.totalPageCount).toBe(2);
    expect(result.coverageWarning).toBe('Partial source coverage: pages 1 of 2 were included within the 98304-byte budget.');
  });
});
