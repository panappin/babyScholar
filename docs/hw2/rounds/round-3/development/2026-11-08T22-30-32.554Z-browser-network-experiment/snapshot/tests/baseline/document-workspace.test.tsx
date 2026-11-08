// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DocumentWorkspace } from '../../src/DocumentWorkspace';
import { abortedRequest, deferred, failure, json, mockApi, requests, stubObjectUrls } from './helpers/browser';
import { document, secondDocument, extraction, metadata, summary, question } from './helpers/document-fixtures';

const base = `/api/documents/${document.id}`;
function setup(overrides: Parameters<typeof mockApi>[0] = {}) {
  const routes: Parameters<typeof mockApi>[0] = { 'GET /api/documents': () => json({ documents: [document] }) };
  for (const doc of [document, secondDocument]) {
    routes[`GET /api/documents/${doc.id}/text`] = () => json({ extraction: extraction(doc.id) });
    routes[`GET /api/documents/${doc.id}/metadata`] = () => failure('metadata_not_found', 'No saved metadata', 404);
    routes[`GET /api/documents/${doc.id}/summary`] = () => failure('summary_not_found', 'No saved summary', 404);
    routes[`GET /api/documents/${doc.id}/questions`] = () => json({ questions: [] });
  }
  const api = mockApi({ ...routes, ...overrides });
  const view = render(<DocumentWorkspace />);
  return { api, user: userEvent.setup(), ...view };
}
async function select(user: ReturnType<typeof userEvent.setup>, name = document.filename) {
  await user.click(await screen.findByRole('button', { name: new RegExp(name.replace('.', '\\.')) }));
  await waitFor(() => expect(screen.queryByText('Reading saved text, metadata, and summary...')).not.toBeInTheDocument());
}
const summaryRegion = () => within(screen.getByRole('region', { name: 'Summary', exact: true }));
const questionsRegion = () => within(screen.getByRole('region', { name: 'Questions and answers' }));

describe('PDF list and stored detail reads', () => {
  it('shows loading, then empty state without performing generation', async () => {
    const pending = deferred<Response>();
    const { api } = setup({ 'GET /api/documents': () => pending.promise });
    expect(screen.getByText('Loading saved PDFs...')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Reload PDFs' })).toBeDisabled();
    await act(async () => pending.resolve(json({ documents: [] })));
    expect(screen.getByText('No PDFs have been uploaded yet.')).toBeVisible();
    expect(requests(api, 'POST')).toHaveLength(0);
  });

  it.each(['malformed', 'application error'] as const)('retains listed documents after a %s reload', async mode => {
    let reads = 0;
    const { api, user } = setup({ 'GET /api/documents': () => ++reads === 1 ? json({ documents: [document] })
      : mode === 'malformed' ? json({ documents: [{}] }) : failure('database_failure', 'Document database unavailable') });
    await screen.findByRole('button', { name: /graph-study.pdf/ });
    await user.click(screen.getByRole('button', { name: 'Reload PDFs' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(mode === 'malformed' ? 'unexpected response' : 'Document database unavailable');
    expect(screen.getByRole('button', { name: /graph-study.pdf/ })).toBeEnabled();
    expect(requests(api, 'POST')).toHaveLength(0);
  });

  it('reopens saved text, metadata, summary and answer using read-only requests; quotes are optional', async () => {
    const { api, user } = setup({ [`GET ${base}/metadata`]: () => json({ metadata: metadata() }),
      [`GET ${base}/summary`]: () => json({ summary: summary() }), [`GET ${base}/questions`]: () => json({ questions: [question()] }) });
    await select(user);
    expect(screen.getByText(metadata().title!)).toBeVisible();
    expect(screen.getByText(summary().overview.text)).toBeVisible();
    expect(screen.getByText(question().answerParts[0].text)).toBeVisible();
    expect(screen.queryByText(/Optional saved quotes/)).not.toBeInTheDocument();
    await user.click(screen.getByText('Extracted page text (1 page)'));
    expect(screen.getByText(extraction().pages[0].text)).toBeVisible();
    expect(requests(api, 'GET')).toHaveLength(5);
    expect(requests(api, 'POST')).toHaveLength(0);
  });

  it('keeps unknown metadata explicit and older optional quotes readable', async () => {
    const old = summary(); old.overview.evidence = [{ pageNumber: 1, quote: 'An older saved quote.' }];
    old.sourceExcerptTruncated = true; old.totalPageCount = 3; old.warnings = ['Only opening text is represented.'];
    const unknown = { ...metadata(), title: null, authors: null, year: null, abstract: null };
    const { user } = setup({ [`GET ${base}/metadata`]: () => json({ metadata: unknown }), [`GET ${base}/summary`]: () => json({ summary: old }) });
    await select(user);
    for (const text of ['Title unavailable', 'Authors unavailable', 'Year unavailable', 'Abstract unavailable']) expect(screen.getByText(text)).toBeVisible();
    expect(screen.getByText('Partial text coverage.')).toBeVisible();
    expect(screen.getByText(old.warnings[0])).toBeVisible();
    await user.click(screen.getByText('Optional saved quotes (1)'));
    expect(screen.getByText(/An older saved quote/)).toBeVisible();
  });

  it('ignores late detail responses from the previous selection even if transport ignores abort', async () => {
    const oldText = deferred<Response>(); let signal: AbortSignal | undefined | null;
    const { api, user } = setup({ 'GET /api/documents': () => json({ documents: [document, secondDocument] }),
      [`GET ${base}/text`]: init => { signal = init.signal; return oldText.promise; },
      [`GET ${base}/metadata`]: () => json({ metadata: { ...metadata(), title: 'Old selection metadata' } }),
      [`GET /api/documents/${secondDocument.id}/metadata`]: () => json({ metadata: { ...metadata(secondDocument.id), title: 'Current selection metadata' } }),
    });
    await user.click(await screen.findByRole('button', { name: /graph-study.pdf/ }));
    await select(user, secondDocument.filename);
    expect(signal?.aborted).toBe(true);
    expect(screen.getByText('Current selection metadata')).toBeVisible();
    await act(async () => oldText.resolve(json({ extraction: extraction() })));
    expect(screen.queryByText('Old selection metadata')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: secondDocument.filename })).toBeVisible();
    await user.click(screen.getByText('Extracted page text (1 page)'));
    expect(screen.getByText(extraction(secondDocument.id).pages[0].text)).toBeVisible();
    expect(screen.queryByText(extraction().pages[0].text)).not.toBeInTheDocument();
    expect(requests(api, 'POST')).toHaveLength(0);
  });

  it.each(['summary', 'questions'] as const)('rejects saved %s belonging to another document', async resource => {
    const { user } = setup({ [`GET ${base}/${resource}`]: () => resource === 'summary'
      ? json({ summary: summary(secondDocument.id) }) : json({ questions: [question(secondDocument.id)] }) });
    await select(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('unexpected response');
    expect(screen.queryByText(resource === 'summary' ? summary().overview.text : question().answerParts[0].text)).not.toBeInTheDocument();
  });

  it.each(['text', 'metadata'] as const)('reports malformed %s and recovers through explicit detail reads', async resource => {
    let reads = 0;
    const { api, user } = setup({ [`GET ${base}/${resource}`]: () => ++reads === 1 ? json({ invalid: true })
      : resource === 'text' ? json({ extraction: extraction() }) : json({ metadata: metadata() }) });
    await select(user);
    expect(screen.getAllByRole('alert')[0]).toHaveTextContent('unexpected response');
    await user.click(screen.getByRole('button', { name: 'Retry loading PDF details' }));
    expect(await screen.findByRole('button', { name: 'Generate summary', exact: true })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Retry loading PDF details' })).not.toBeInTheDocument();
    expect(requests(api, 'POST')).toHaveLength(0);
  });

  it('bounds a stalled detail read and provides a read-only retry action', async () => {
    const { api, user } = setup({ [`GET ${base}/text`]: init => abortedRequest(init.signal) });
    await screen.findByRole('button', { name: /graph-study.pdf/ });
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: /graph-study.pdf/ }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.getAllByRole('alert')[0]).toHaveTextContent('Reading this PDF took too long');
    expect(screen.getByRole('button', { name: 'Retry loading PDF details' })).toBeEnabled();
    expect(requests(api, 'POST')).toHaveLength(0);
  });
});

describe('Explicit summary and question actions with reconciliation', () => {
  it('generates one summary after an explicit action without requiring metadata or citations', async () => {
    const pending = deferred<Response>();
    const { api, user } = setup({ [`POST ${base}/summary`]: () => pending.promise });
    await select(user);
    expect(requests(api, 'POST')).toHaveLength(0);
    await user.dblClick(screen.getByRole('button', { name: 'Generate summary', exact: true }));
    expect(requests(api, 'POST', `${base}/summary`)).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Generate summary', exact: true })).not.toBeInTheDocument();
    await act(async () => pending.resolve(json({ summary: summary(), created: true })));
    expect(await screen.findByText(summary().overview.text)).toBeVisible();
    expect(summaryRegion().queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/Optional saved quotes/)).not.toBeInTheDocument();
  });

  it.each(['lost response', 'malformed success', 'wrong document'] as const)('reconciles summary %s without another POST', async mode => {
    let reads = 0;
    const { api, user } = setup({ [`GET ${base}/summary`]: () => ++reads === 1 ? failure('summary_not_found', 'No summary', 404) : json({ summary: summary() }),
      [`POST ${base}/summary`]: () => { if (mode === 'lost response') throw new Error('connection closed');
        return mode === 'wrong document' ? json({ summary: summary(secondDocument.id) }) : json({ invalid: true }); },
    });
    await select(user);
    await user.click(screen.getByRole('button', { name: 'Generate summary', exact: true }));
    expect(await screen.findByText(summary().overview.text)).toBeVisible();
    expect(summaryRegion().queryByRole('alert')).not.toBeInTheDocument();
    expect(requests(api, 'POST', `${base}/summary`)).toHaveLength(1);
    expect(requests(api, 'GET', `${base}/summary`)).toHaveLength(2);
  });

  it('retains a saved summary if a reload fails, without generating again', async () => {
    let reads = 0;
    const { api, user } = setup({ [`GET ${base}/summary`]: () => ++reads === 1 ? json({ summary: summary() }) : failure('database_failure', 'Summary storage unavailable') });
    await select(user);
    await user.click(screen.getByRole('button', { name: 'Reload summary' }));
    expect(await summaryRegion().findByRole('alert')).toHaveTextContent('Summary storage unavailable');
    expect(screen.getByText(summary().overview.text)).toBeVisible();
    expect(requests(api, 'POST')).toHaveLength(0);
  });

  it('handles summary already-in-progress by waiting for an explicit GET reload', async () => {
    let reads = 0;
    const { api, user } = setup({ [`GET ${base}/summary`]: () => ++reads < 2 ? failure('summary_not_found', 'No summary', 404) : json({ summary: summary() }),
      [`POST ${base}/summary`]: () => failure('summary_in_progress', 'Already generating', 409) });
    await select(user);
    await user.click(screen.getByRole('button', { name: 'Generate summary', exact: true }));
    expect(await screen.findByText(/Already generating/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Generate summary', exact: true })).not.toBeInTheDocument();
    expect(requests(api, 'GET', `${base}/summary`)).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Reload summary' }));
    expect(await screen.findByText(summary().overview.text)).toBeVisible();
    expect(requests(api, 'POST')).toHaveLength(1);
    expect(requests(api, 'GET', `${base}/summary`)).toHaveLength(2);
  });

  it('asks once, accepts prose without quotes, and retains the answer after a failed history reload', async () => {
    const pending = deferred<Response>(); let reads = 0;
    const { api, user } = setup({ [`POST ${base}/questions`]: () => pending.promise,
      [`GET ${base}/questions`]: () => ++reads === 1 ? json({ questions: [] }) : failure('database_failure', 'History unavailable') });
    await select(user);
    await user.type(screen.getByRole('textbox', { name: 'Question about this PDF' }), question().question);
    await user.dblClick(screen.getByRole('button', { name: 'Ask', exact: true }));
    expect(screen.getByRole('button', { name: 'Asking...' })).toBeDisabled();
    expect(requests(api, 'POST')).toHaveLength(1);
    expect(JSON.parse(String(requests(api, 'POST')[0][1]?.body))).toEqual({ question: question().question });
    await act(async () => pending.resolve(json({ question: question(), created: true })));
    expect(await screen.findByText(question().answerParts[0].text)).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Question about this PDF' })).toHaveValue('');
    expect(screen.queryByText(/Optional saved quotes/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reload question history' }));
    expect(await questionsRegion().findByRole('alert')).toHaveTextContent('History unavailable');
    expect(screen.getByText(question().answerParts[0].text)).toBeVisible();
    expect(requests(api, 'POST')).toHaveLength(1);
  });

  it.each(['', ' untrimmed ', '🧪'.repeat(512) + 'x'])('rejects invalid question %j before transport', async value => {
    const { api, user } = setup(); await select(user);
    fireEvent.change(screen.getByRole('textbox', { name: 'Question about this PDF' }), { target: { value } });
    await user.click(screen.getByRole('button', { name: 'Ask', exact: true }));
    expect(await questionsRegion().findByRole('alert')).toHaveTextContent(value.length > 100 ? '2 KiB UTF-8' : 'trimmed, nonempty');
    expect(requests(api, 'POST')).toHaveLength(0);
  });

  it('accepts an exact 2 KiB Unicode question and renders an explicit insufficient-source answer', async () => {
    const value = '🧪'.repeat(512), result = { ...question(), question: value, normalizedQuestion: value,
      outcome: 'insufficient_source', answerParts: [], insufficientSourceReason: 'This document does not establish that result.' };
    const { api, user } = setup({ [`POST ${base}/questions`]: () => json({ question: result }) });
    await select(user);
    fireEvent.change(screen.getByRole('textbox', { name: 'Question about this PDF' }), { target: { value } });
    await user.click(screen.getByRole('button', { name: 'Ask', exact: true }));
    expect(await screen.findByRole('region', { name: 'Insufficient source result' })).toHaveTextContent(result.insufficientSourceReason);
    expect(screen.queryByRole('region', { name: 'Answer using PDF context' })).not.toBeInTheDocument();
    expect(JSON.parse(String(requests(api, 'POST')[0][1]?.body)).question).toBe(value);
  });

  it('reconciles an interrupted question using normalized identity without automatically asking again', async () => {
    let reads = 0;
    const stored = { ...question(), question: 'What  is the method?' };
    const { api, user } = setup({ [`GET ${base}/questions`]: () => json({ questions: ++reads === 1 ? [] : [stored] }),
      [`POST ${base}/questions`]: () => Promise.reject(new Error('lost response')) });
    await select(user);
    await user.type(screen.getByRole('textbox', { name: 'Question about this PDF' }), question().question);
    await user.click(screen.getByRole('button', { name: 'Ask', exact: true }));
    expect(await screen.findByText(stored.answerParts[0].text)).toBeVisible();
    expect(questionsRegion().queryByRole('alert')).not.toBeInTheDocument();
    expect(requests(api, 'POST')).toHaveLength(1);
    expect(requests(api, 'GET', `${base}/questions`)).toHaveLength(2);
  });

  it.each([401, 403])('handles gateway HTTP %i without exposing HTML or offering a POST retry', async status => {
    const { api, user } = setup({ [`POST ${base}/questions`]: () => new Response('<h1>private gateway page</h1>', { status }) });
    await select(user);
    await user.type(screen.getByRole('textbox', { name: 'Question about this PDF' }), question().question);
    await user.click(screen.getByRole('button', { name: 'Ask', exact: true }));
    expect(await questionsRegion().findByRole('alert')).toHaveTextContent(`HTTP ${status}`);
    expect(screen.queryByText(/private gateway page/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry', exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Question about this PDF' })).toHaveValue(question().question);
    await user.click(screen.getAllByRole('button', { name: 'Reload question history' })[1]);
    expect(await screen.findByText(/No saved questions yet/)).toBeVisible();
    expect(requests(api, 'POST')).toHaveLength(1);
  });
});

describe('Upload, download and deletion intent', () => {
  it.each([['missing', null], ['empty', new File([], 'empty.pdf', { type: 'application/pdf' })],
    ['too large', new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'large.pdf', { type: 'application/pdf' })]] as const)
    ('rejects a %s upload before transport', async (kind, file) => {
      const { api, user } = setup();
      await screen.findByRole('button', { name: /graph-study.pdf/ });
      if (file) await user.upload(screen.getByLabelText('PDF file'), file);
      await user.click(screen.getByRole('button', { name: 'Upload and process' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(kind === 'missing' ? 'Choose a PDF file' : kind === 'empty' ? 'nonempty' : '10 MiB or smaller');
      expect(requests(api, 'POST')).toHaveLength(0);
    });

  it('uploads an exact-limit file, processes missing text and metadata once, and leaves summary/questions explicit', async () => {
    let extracted = false, generated = false;
    const { api, user } = setup({
      'GET /api/documents': () => json({ documents: [] }),
      'POST /api/documents': init => {
        const file = (init.body as FormData).get('file') as File;
        expect(file.size).toBe(10 * 1024 * 1024); expect(file.name).toBe('boundary.pdf');
        return json({ document });
      },
      [`GET ${base}/text`]: () => extracted ? json({ extraction: extraction() }) : failure('extraction_not_found', 'No text', 404),
      [`GET ${base}/metadata`]: () => generated ? json({ metadata: metadata() }) : failure('metadata_not_found', 'No metadata', 404),
      [`POST ${base}/extract`]: () => { extracted = true; return json({ extraction: extraction(), created: true }); },
      [`POST ${base}/metadata`]: () => { generated = true; return json({ metadata: metadata(), created: true }); },
    });
    await screen.findByText('No PDFs have been uploaded yet.');
    await user.upload(screen.getByLabelText('PDF file'), new File([new Uint8Array(10 * 1024 * 1024)], 'boundary.pdf', { type: 'application/pdf' }));
    await user.click(screen.getByRole('button', { name: 'Upload and process' }));
    expect(await screen.findByText(/Ready.*text and metadata are saved/)).toBeVisible();
    expect(screen.getByText(metadata().title!)).toBeVisible();
    expect(requests(api, 'POST').map(([input]) => String(input))).toEqual(['/api/documents', `${base}/extract`, `${base}/metadata`]);
    expect(screen.getByRole('button', { name: 'Generate summary', exact: true })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Ask', exact: true })).toBeEnabled();
  });

  it('resumes only missing metadata without reuploading or re-extracting the document', async () => {
    const { api, user } = setup({ [`POST ${base}/metadata`]: () => json({ metadata: metadata(), created: true }) });
    await select(user);
    await user.click(screen.getByRole('button', { name: 'Retry metadata only' }));
    expect(await screen.findByText(/Ready.*text and metadata are saved/)).toBeVisible();
    expect(requests(api, 'POST').map(([input]) => String(input))).toEqual([`${base}/metadata`]);
  });

  it('leaves an interrupted upload uncertain and does not repeat it', async () => {
    const { api, user } = setup({ 'POST /api/documents': () => Promise.reject(new Error('connection closed')) });
    await screen.findByRole('button', { name: /graph-study.pdf/ });
    await user.upload(screen.getByLabelText('PDF file'), new File(['%PDF-fixture'], 'fixture.pdf', { type: 'application/pdf' }));
    await user.click(screen.getByRole('button', { name: 'Upload and process' }));
    expect(await screen.findByText(/upload may have been interrupted/)).toHaveTextContent('no upload was retried');
    expect(requests(api, 'POST')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Reload PDFs' })).toBeEnabled();
  });

  it('prepares a PDF with a safe filename and revokes its link on selection change and unmount', async () => {
    const unsafe = { ...document, filename: '../graph:study.pdf' };
    const create = vi.fn().mockReturnValueOnce('blob:fixture-one').mockReturnValueOnce('blob:fixture-two'), revoke = vi.fn();
    stubObjectUrls(create, revoke);
    const { api, user, unmount } = setup({ 'GET /api/documents': () => json({ documents: [unsafe, secondDocument] }),
      [`GET ${base}/pdf`]: () => new Response('%PDF-fixture', { headers: { 'content-type': 'application/pdf' } }),
      [`GET /api/documents/${secondDocument.id}/pdf`]: () => new Response('%PDF-second', { headers: { 'content-type': 'application/pdf' } }),
    });
    await select(user, unsafe.filename);
    await user.click(screen.getByRole('button', { name: 'Prepare original PDF download' }));
    const link = await screen.findByRole('link', { name: 'Download prepared PDF' });
    expect(link).toHaveAttribute('href', 'blob:fixture-one'); expect(link).toHaveAttribute('download', '.._graph_study.pdf');
    expect(create.mock.calls[0][0].size).toBe(12);
    expect(screen.getByText(/application cannot confirm whether your browser saved/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open original PDF in a new tab' })).toHaveAttribute('rel', 'noopener');
    await select(user, secondDocument.filename);
    expect(revoke).toHaveBeenCalledWith('blob:fixture-one');
    expect(screen.queryByRole('link', { name: 'Download prepared PDF' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Prepare original PDF download' }));
    await screen.findByRole('link', { name: 'Download prepared PDF' });
    unmount(); expect(revoke).toHaveBeenCalledWith('blob:fixture-two');
    expect(requests(api, 'POST')).toHaveLength(0);
  });

  it('expires a prepared download after one minute', async () => {
    const revoke = vi.fn();
    stubObjectUrls(vi.fn(() => 'blob:expires'), revoke);
    const { user } = setup({ [`GET ${base}/pdf`]: () => new Response('%PDF', { headers: { 'content-type': 'application/pdf' } }) });
    await select(user); vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Prepare original PDF download' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByRole('link', { name: 'Download prepared PDF' })).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(screen.queryByRole('link', { name: 'Download prepared PDF' })).not.toBeInTheDocument();
    expect(screen.getByText(/prepared PDF link expired/)).toBeVisible();
    expect(revoke).toHaveBeenCalledWith('blob:expires');
  });

  it('rejects a non-PDF download while preserving a usable fallback', async () => {
    const create = vi.fn(); stubObjectUrls(create, vi.fn());
    const { user } = setup({ [`GET ${base}/pdf`]: () => new Response('<html>gateway</html>', { headers: { 'content-type': 'text/html' } }) });
    await select(user); await user.click(screen.getByRole('button', { name: 'Prepare original PDF download' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('did not return a PDF');
    expect(create).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Open original PDF in a new tab' })).toHaveAttribute('href', `${base}/pdf`);
  });

  it('requires deletion confirmation and keeps a record until a matching success response', async () => {
    let attempts = 0, deleted = false;
    const { api, user } = setup({ 'GET /api/documents': () => json({ documents: deleted ? [secondDocument] : [document, secondDocument] }),
      [`DELETE ${base}`]: () => { if (++attempts === 1) return json({ deleted: true, id: secondDocument.id });
        deleted = true; return json({ deleted: true, id: document.id }); },
    });
    await select(user);
    expect(screen.getByRole('button', { name: 'Delete PDF' })).toBeDisabled();
    expect(requests(api, 'DELETE')).toHaveLength(0);
    await user.click(screen.getByRole('checkbox', { name: /Delete this PDF/ }));
    await user.click(screen.getByRole('button', { name: 'Delete PDF' }));
    expect(await screen.findByText(/Deletion could not be confirmed/)).toBeVisible();
    expect(screen.getByRole('button', { name: /graph-study.pdf/ })).toBeVisible();
    expect(requests(api, 'DELETE')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Delete PDF' }));
    expect(await screen.findByText('The PDF and its saved processing results were deleted.')).toBeVisible();
    expect(screen.queryByRole('button', { name: /graph-study.pdf/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /second-study.pdf/ })).toBeVisible();
    expect(requests(api, 'DELETE')).toHaveLength(2);
  });
});
