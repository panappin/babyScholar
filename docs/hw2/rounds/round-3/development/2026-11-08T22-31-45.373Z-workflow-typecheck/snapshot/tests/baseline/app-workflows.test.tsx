// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../../src/App';
import { abortedRequest, deferred, failure, json, mockApi, requests } from './helpers/browser';
import type { PaperSearchResult } from '../../src/worker/paper-search-types';
import type { SavedPaper } from '../../src/worker/library-types';

const paper: PaperSearchResult = { id: '2401.01234v3', title: 'Learning from graphs', authors: ['Ada Author'],
  year: 2024, abstract: 'A complete abstract about graph learning.', url: 'http://arxiv.org/abs/2401.01234v3', pdfUrl: null };
const saved: SavedPaper = { ...paper, id: '11111111-1111-4111-8111-111111111111', arxivId: '2401.01234',
  source: 'arxiv', title: 'Authoritative saved title', savedAt: '2026-01-02T03:04:05.000Z' };
const path = '/api/library/papers';
const searchPath = '/api/papers/search';
function setup(overrides: Parameters<typeof mockApi>[0] = {}) {
  const api = mockApi({
    'GET /api/health': () => json({ status: 'ok' }),
    'GET /api/storage/status': () => json({ d1: { status: 'ok' }, r2: { status: 'ok' } }),
    [`GET ${path}`]: () => json({ papers: [] }),
    [`GET ${searchPath}`]: (_init, url) => json({ provider: 'arxiv', query: url.searchParams.get('q'), papers: [paper] }),
    ...overrides,
  });
  const view = render(<App />);
  return { api, user: userEvent.setup(), ...view };
}
async function search(user: ReturnType<typeof userEvent.setup>, query = 'graph learning') {
  await user.type(screen.getByRole('textbox', { name: 'Research topic or keywords' }), query);
  await user.click(screen.getByRole('button', { name: 'Search' }));
}

describe('Search and library observable workflows', () => {
  it('loads status and library without starting a search, then normalizes an explicit query', async () => {
    const { api, user } = setup();
    expect(await screen.findByText('Backend connected')).toBeVisible();
    expect(requests(api, 'GET', searchPath)).toHaveLength(0);
    await search(user, '  cafe\u0301   learning  ');
    expect(await screen.findByRole('heading', { name: paper.title })).toBeVisible();
    expect(new URL(String(requests(api, 'GET', searchPath)[0][0]), 'http://localhost').searchParams.get('q')).toBe('café learning');
    expect(screen.getByText(paper.abstract)).toBeVisible();
    expect(screen.getByRole('link', { name: /View paper on arXiv/ })).toHaveAttribute('href', 'https://arxiv.org/abs/2401.01234v3');
  });

  it.each([['', /Enter a research topic/], ['?!', /Use letters or numbers/]])('rejects invalid input %j without a search request', async (query, message) => {
    const { api, user } = setup();
    if (query) await user.type(screen.getByRole('textbox'), query as string);
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(message as RegExp);
    expect(requests(api, 'GET', searchPath)).toHaveLength(0);
  });

  it('shows empty results distinctly from errors and permits a new explicit search', async () => {
    let attempt = 0;
    const { api, user } = setup({ [`GET ${searchPath}`]: () => json({ provider: 'arxiv', query: 'topic', papers: ++attempt === 1 ? [] : [paper] }) });
    await search(user);
    expect(await screen.findByText(/No papers found/)).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByRole('heading', { name: paper.title })).toBeVisible();
    expect(requests(api, 'GET', searchPath)).toHaveLength(2);
  });

  it.each([
    ['application failure', () => failure('upstream', 'Search provider unavailable.'), /Search provider unavailable/],
    ['malformed success', () => json({ papers: [] }), /unexpected response/],
    ['gateway HTML', () => new Response('<secret>gateway detail</secret>', { status: 502 }), /HTTP 502/],
    ['network failure', () => Promise.reject(new Error('private transport detail')), /could not be completed/],
  ] as const)('handles %s with useful feedback and no fabricated result', async (_label, handler, message) => {
    const { user } = setup({ [`GET ${searchPath}`]: handler });
    await search(user);
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.queryByRole('heading', { name: paper.title })).not.toBeInTheDocument();
    expect(screen.queryByText(/private transport detail|gateway detail/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Search' })).toBeEnabled();
  });

  it('prevents duplicate searches while pending and releases the control after the real timeout', async () => {
    const { api } = setup({ [`GET ${searchPath}`]: init => abortedRequest(init.signal) });
    await screen.findByText('Backend connected');
    vi.useFakeTimers();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'topic' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(screen.getByRole('button', { name: 'Searching...' })).toBeDisabled();
    fireEvent.submit(screen.getByRole('textbox').closest('form')!);
    expect(requests(api, 'GET', searchPath)).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(screen.getByRole('alert')).toHaveTextContent('took too long');
    expect(screen.getByRole('button', { name: 'Search' })).toBeEnabled();
  });

  it('retains the authoritative duplicate record when saved and reopened', async () => {
    const pending = deferred<Response>();
    const { api, user } = setup({ [`POST ${path}`]: () => pending.promise });
    await search(user);
    await user.dblClick(await screen.findByRole('button', { name: 'Save to library' }));
    expect(requests(api, 'POST', path)).toHaveLength(1);
    expect(JSON.parse(String(requests(api, 'POST', path)[0][1]?.body))).toEqual({ paper });
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled();
    await act(async () => pending.resolve(json({ paper: saved, created: false })));
    expect(await screen.findByRole('button', { name: 'Saved' })).toBeDisabled();
    await user.click(screen.getByRole('tab', { name: 'Library (1)' }));
    expect(screen.getByRole('heading', { name: saved.title })).toBeVisible();
    expect(screen.getByText(saved.id)).toBeVisible();
    expect(screen.getByText(/^Saved /, { selector: 'time' })).toHaveAttribute('datetime', saved.savedAt);
    expect(requests(api, 'POST', path)).toHaveLength(1);
  });

  it('recognizes a previously saved base ID when search returns another version', async () => {
    const { api, user } = setup({ [`GET ${path}`]: () => json({ papers: [saved] }) });
    await search(user);
    expect(await screen.findByRole('button', { name: 'Saved' })).toBeDisabled();
    expect(requests(api, 'POST', path)).toHaveLength(0);
  });

  it.each(['lost response', 'malformed success', 'wrong paper', 'non-application error'] as const)
    ('reconciles %s with GET and shows a confirmed save without a contradictory error', async mode => {
      let reads = 0;
      const { api, user } = setup({
        [`GET ${path}`]: () => json({ papers: ++reads === 1 ? [] : [saved] }),
        [`POST ${path}`]: () => {
          if (mode === 'lost response') throw new Error('connection lost after commit');
          if (mode === 'malformed success') return json({ unexpected: true });
          if (mode === 'wrong paper') return json({ created: true, paper: { ...saved, arxivId: '2401.99999' } });
          return new Response('gateway error', { status: 502 });
        },
      });
      await search(user);
      await user.click(await screen.findByRole('button', { name: 'Save to library' }));
      expect(await screen.findByRole('button', { name: 'Saved' })).toBeDisabled();
      await waitFor(() => expect(screen.queryByText(/Checking the library/)).not.toBeInTheDocument());
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(requests(api, 'GET', path)).toHaveLength(2);
      expect(requests(api, 'POST', path)).toHaveLength(1);
      await user.click(screen.getByRole('tab', { name: 'Library (1)' }));
      expect(screen.getByRole('heading', { name: saved.title })).toBeVisible();
    });

  it('leaves an unknown save disabled until an explicit library reload confirms it', async () => {
    let reads = 0;
    const { api, user } = setup({
      [`GET ${path}`]: () => ++reads === 2 ? failure('database_failure', 'Temporary read failure') : json({ papers: reads > 2 ? [saved] : [] }),
      [`POST ${path}`]: () => Promise.reject(new Error('uncertain outcome')),
    });
    await search(user);
    await user.click(await screen.findByRole('button', { name: 'Save to library' }));
    expect(await screen.findByText(/save outcome is still unknown/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save unconfirmed' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Reload library to check save' }));
    expect(await screen.findByRole('button', { name: 'Saved' })).toBeDisabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(requests(api, 'POST', path)).toHaveLength(1);
  });

  it('does not let an older library read erase a successful save', async () => {
    const stale = deferred<Response>();
    const { user } = setup({ [`GET ${path}`]: () => stale.promise, [`POST ${path}`]: () => json({ paper: saved, created: true }) });
    await search(user);
    await user.click(await screen.findByRole('button', { name: 'Save to library' }));
    await screen.findByRole('button', { name: 'Saved' });
    await act(async () => stale.resolve(json({ papers: [] })));
    expect(screen.getByRole('button', { name: 'Saved' })).toBeDisabled();
    await user.click(screen.getByRole('tab', { name: 'Library (1)' }));
    expect(screen.getByRole('heading', { name: saved.title })).toBeVisible();
  });

  it.each(['malformed', 'application error'] as const)('retains saved records when a library reload returns %s', async mode => {
    let reads = 0;
    const { user } = setup({ [`GET ${path}`]: () => ++reads === 1 ? json({ papers: [saved] })
      : mode === 'malformed' ? json({ papers: [{}] }) : failure('database_failure', 'Library read failed') });
    await user.click(await screen.findByRole('tab', { name: 'Library (1)' }));
    await user.click(screen.getByRole('button', { name: 'Reload library' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(mode === 'malformed' ? 'unexpected response' : 'Library read failed');
    expect(screen.getByRole('heading', { name: saved.title })).toBeVisible();
  });

  it('retains an unconfirmed removal and only removes the record after explicit successful retry', async () => {
    let deleted = false, attempts = 0;
    const { api, user } = setup({ [`GET ${path}`]: () => json({ papers: deleted ? [] : [saved] }),
      [`DELETE ${path}/${saved.id}`]: () => { if (++attempts === 1) return json({ deleted: true, id: 'wrong-record' });
        deleted = true; return json({ deleted: true, id: saved.id }); },
    });
    await user.click(await screen.findByRole('tab', { name: 'Library (1)' }));
    await user.click(screen.getByRole('button', { name: 'Remove from library' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Removal is unconfirmed');
    expect(screen.getByRole('heading', { name: saved.title })).toBeVisible();
    expect(requests(api, 'DELETE')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Remove from library' }));
    expect(await screen.findByText(/No saved papers yet/)).toBeVisible();
    expect(requests(api, 'DELETE')).toHaveLength(2);
    await user.click(screen.getByRole('tab', { name: 'Search' }));
    await search(user);
    expect(await screen.findByRole('button', { name: 'Save to library' })).toBeEnabled();
  });

  it('opens PDFs through the actual tab and uses GET only on selection of the view', async () => {
    const { api, user } = setup({ 'GET /api/documents': () => json({ documents: [] }) });
    await user.click(screen.getByRole('tab', { name: 'PDFs' }));
    expect(await screen.findByText('No PDFs have been uploaded yet.')).toBeVisible();
    expect(within(screen.getByRole('tabpanel')).getByRole('button', { name: 'Upload and process' })).toBeEnabled();
    expect(requests(api, 'POST')).toHaveLength(0);
  });
});
