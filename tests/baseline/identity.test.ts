import { describe, expect, it } from 'vitest';
import { canonicalArxivId, arxivSourceIdentity, safeArxivPaperLink } from '../../src/paper-identity';
import { parseArxivId, canonicalArxivLink } from '../../src/worker/arxiv-identity';

describe('paper identity: initial contract cases', () => {
  it.each([
    ['2401.01234v2', '2401.01234'],
    ['hep-th/9901001v3', 'hep-th/9901001'],
    ['2401.1234', '2401.1234'],
  ])('canonicalizes %s across browser and worker', (input, base) => {
    expect(canonicalArxivId(input)).toBe(base);
    expect(parseArxivId(input)).toEqual({ base, versioned: input });
    expect(arxivSourceIdentity(input)).toBe(`arxiv:${base}`);
  });
  it.each(['', 'not-a-paper', '2401.12', '2401.01234 trailing'])('rejects malformed ID %j', input => {
    expect(canonicalArxivId(input)).toBeUndefined();
    expect(parseArxivId(input)).toBeUndefined();
    expect(arxivSourceIdentity(input)).toBe(`arxiv:invalid:${input}`);
  });
  it('keeps versions in the link but not in source identity', () => {
    expect(safeArxivPaperLink('http://www.arxiv.org/abs/2401.01234v2?x=1', '2401.01234v1'))
      .toBe('https://arxiv.org/abs/2401.01234v2');
    expect(canonicalArxivLink('http://arxiv.org/pdf/2401.01234v2.pdf', 'pdf'))
      .toBe('https://arxiv.org/pdf/2401.01234v2.pdf');
  });
  it.each([
    'https://arxiv.org.evil.test/abs/2401.01234',
    'https://user:password@arxiv.org/abs/2401.01234',
    'https://arxiv.org:8443/abs/2401.01234',
    'javascript:alert(1)',
  ])('rejects unsafe link %s', url => {
    expect(safeArxivPaperLink(url, '2401.01234')).toBeNull();
    expect(canonicalArxivLink(url, 'abstract')).toBeNull();
  });
  it('does not link a different paper', () => {
    expect(safeArxivPaperLink('https://arxiv.org/abs/2401.01235', '2401.01234')).toBeNull();
  });
});
