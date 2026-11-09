import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleDocumentMetadata } from '../../src/worker/document-metadata';
import { handleDocumentSummary } from '../../src/worker/document-summary';
import { handleDocumentQuestions } from '../../src/worker/document-questions';
import type { WorkerEnv } from '../../src/worker/storage';
import { SqliteD1 } from './helpers/sqlite-d1';

const id = '44444444-4444-4444-8444-444444444444';
const timestamp = '2026-11-08T23:00:00.000Z';
const sourceHash = 'a'.repeat(64);
const paperText = 'This paper compares deterministic generation workflows. Café 🧪.';
const metadata = { title: 'A study', authors: ['A. Author'], year: 2026, abstract: null };
const ordinaryText = 'A useful plain-text finding without any citation.';
const stages = [
  { name: 'metadata', table: 'document_metadata', claims: 'document_metadata_claims', handler: handleDocumentMetadata,
    output: JSON.stringify(metadata), prompt: 'document-metadata-v4' },
  { name: 'summary', table: 'document_summaries', claims: 'document_summary_claims', handler: handleDocumentSummary,
    output: ordinaryText, prompt: 'document-summary-v3' },
  { name: 'question', table: 'document_questions', claims: 'document_question_claims', handler: handleDocumentQuestions,
    output: ordinaryText, prompt: 'document-question-text-v3' },
] as const;
type Stage = typeof stages[number];
let db: SqliteD1;
let env: WorkerEnv;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
const validResponse = (output: string) => Response.json({ status: 'completed', output_text: output });
const rows = (table: string) => db.sqlite.prepare(`SELECT * FROM ${table}`).all();
const post = (stage: Stage, question = 'What is the finding?') => new Request(`http://localhost/api/documents/${id}/${stage.name}`, {
  method: 'POST', ...(stage.name === 'question' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question }) } : {}),
});
const invoke = (stage: Stage, request = post(stage), settings = env, documentId = id) => stage.handler(request, settings, documentId);
async function expectError(response: Response, status: number, kind: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const body = await response.json();
  expect(body).toMatchObject({ error: { kind } });
  expect(JSON.stringify(body)).not.toContain('PRIVATE_FIXTURE_DETAIL');
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(timestamp));
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  db = new SqliteD1();
  db.sqlite.prepare('INSERT INTO uploaded_documents VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'study.pdf', 512, sourceHash, `uploaded_documents/${id}.pdf`, timestamp, 'stored');
  db.sqlite.prepare('INSERT INTO document_extractions VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, sourceHash, 'unpdf', 'unpdf@1.8.1', timestamp, 1, JSON.stringify([{ pageNumber: 1, text: paperText }]));
  // R2 is required by the contract but these handlers must use saved text only.
  const bucket = new Proxy({}, { get() { throw new Error('Generation unexpectedly touched R2'); } });
  env = { DB: db as unknown as D1Database, PAPER_BUCKET: bucket as R2Bucket, OPENAI_API_KEY: 'offline-fixture-only' };
  fetcher = vi.fn<typeof fetch>(async () => { throw new Error('Unexpected provider request'); });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { db.close(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe.each(stages)('$name generation orchestration with SQLite storage', stage => {
  it.each([
    ['invalid-id', 400, 'invalid_request'], ['missing-storage', 503, 'storage_unavailable'],
    ['missing-document', 404, 'document_not_found'], ['missing-extraction', 404, 'extraction_not_found'],
    ['deleting-document', 409, 'document_deleting'],
  ])('rejects %s before provider work', async (condition, status, kind) => {
    if (condition === 'missing-document') db.sqlite.exec('DELETE FROM uploaded_documents');
    if (condition === 'missing-extraction') db.sqlite.exec('DELETE FROM document_extractions');
    if (condition === 'deleting-document') db.sqlite.exec("UPDATE uploaded_documents SET status = 'deleting'");
    const response = await invoke(stage, post(stage), condition === 'missing-storage' ? {} : env,
      condition === 'invalid-id' ? 'not-an-id' : id);
    await expectError(response, Number(status), String(kind));
    expect(fetcher).not.toHaveBeenCalled();
    expect(rows(stage.claims)).toEqual([]);
  });

  it('GET reports absence without implicitly generating', async () => {
    const response = await invoke(stage, new Request('http://localhost/result'));
    if (stage.name === 'question') {
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ questions: [] });
    } else await expectError(response, 404, `${stage.name}_not_found`);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects unsupported methods with Allow and no generation', async () => {
    const response = await invoke(stage, new Request('http://localhost/result', { method: 'PUT' }));
    await expectError(response, 405, 'method_not_allowed');
    expect(response.headers.get('allow')).toBe('GET, POST');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fails missing configuration before taking a generation claim', async () => {
    await expectError(await invoke(stage, post(stage), { ...env, OPENAI_API_KEY: ' ' }), 424, `${stage.name}_missing_configuration`);
    expect(rows(stage.claims)).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('persists source provenance and readable output, then reuses saved results without a key', async () => {
    fetcher.mockImplementation(async () => validResponse(stage.output));
    const first = await invoke(stage);
    expect(first.status).toBe(201);
    const created = await first.json();
    expect(created.created).toBe(true);
    const result = created[stage.name];
    expect(result).toMatchObject({ documentId: id, sourceSha256: sourceHash, extractionParser: 'unpdf',
      extractionParserVersion: 'unpdf@1.8.1', extractionExtractedAt: timestamp, model: 'gpt-6-luna', promptVersion: stage.prompt,
      sourceExcerptByteCount: new TextEncoder().encode(paperText).length });
    if (stage.name === 'metadata') expect(result).toMatchObject({ ...metadata, evidence: { title: [], authors: [], year: [], abstract: [] } });
    if (stage.name === 'summary') expect(result.overview).toEqual({ text: ordinaryText, evidence: [] });
    if (stage.name === 'question') expect(result.answerParts).toEqual([{ text: ordinaryText, evidence: [] }]);
    expect(rows(stage.table)).toHaveLength(1);
    expect(rows(stage.claims)).toEqual([]);
    const cached = await invoke(stage, post(stage), { ...env, OPENAI_API_KEY: undefined });
    expect(cached.status).toBe(200);
    expect(await cached.json()).toEqual({ [stage.name]: result, created: false });
    const read = await invoke(stage, new Request('http://localhost/result'), { ...env, OPENAI_API_KEY: undefined });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual(stage.name === 'question' ? { questions: [result] } : { [stage.name]: result });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(rows('document_extractions')[0].pages_json).toBe(JSON.stringify([{ pageNumber: 1, text: paperText }]));
  });

  it.each([[401, 502, 'authentication'], [429, 429, 'quota_or_rate_limit'], [403, 502, 'model_access'], [503, 502, 'provider_failure']])
    ('maps upstream HTTP %s to caller HTTP %s and releases only its claim', async (upstream, status, suffix) => {
      fetcher.mockImplementation(async () => Response.json({ error: { message: 'PRIVATE_FIXTURE_DETAIL model access' } }, { status: Number(upstream) }));
      await expectError(await invoke(stage), Number(status), `${stage.name}_${suffix}`);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(rows(stage.table)).toEqual([]);
      expect(rows(stage.claims)).toEqual([]);
      expect(rows('uploaded_documents')).toHaveLength(1);
      expect(rows('document_extractions')).toHaveLength(1);
    });

  it.each([
    [{ status: 'incomplete' }, 502, 'incomplete'],
    [{ status: 'completed', output: [{ content: [{ type: 'refusal', refusal: 'PRIVATE_FIXTURE_DETAIL' }] }] }, 422, 'refusal'],
  ])('maps provider completion failure %# without retrying', async (payload, status, suffix) => {
    fetcher.mockImplementation(async () => Response.json(payload));
    await expectError(await invoke(stage), Number(status), `${stage.name}_${suffix}`);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(rows(stage.claims)).toEqual([]);
  });

  it('maps transport failure and leaves source data available for explicit retry', async () => {
    fetcher.mockRejectedValue(new Error('PRIVATE_FIXTURE_DETAIL'));
    await expectError(await invoke(stage), 502, `${stage.name}_provider_failure`);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(rows(stage.table)).toEqual([]);
    expect(rows(stage.claims)).toEqual([]);
    fetcher.mockImplementation(async () => validResponse(stage.output));
    expect((await invoke(stage)).status).toBe(201);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('bounds malformed-response recovery and cleans up an exhausted attempt', async () => {
    fetcher.mockImplementation(async () => new Response('PRIVATE_FIXTURE_DETAIL'));
    await expectError(await invoke(stage), 502, `${stage.name}_invalid_response`);
    expect(fetcher).toHaveBeenCalledTimes(stage.name === 'question' ? 1 : 2);
    expect(rows(stage.table)).toEqual([]);
    expect(rows(stage.claims)).toEqual([]);
  });

  it('maps a stalled response body to caller timeout and releases its claim', async () => {
    const started = deferred<void>();
    fetcher.mockImplementation(async (_url, init) => new Response(new ReadableStream({ start(controller) {
      init!.signal!.addEventListener('abort', () => controller.error(init!.signal!.reason), { once: true });
      started.resolve();
    } })));
    const pending = invoke(stage);
    // Question fingerprinting uses asynchronous WebCrypto before its deadline
    // starts. Advance time only after the provider actually begins the request.
    await started.promise;
    await vi.advanceTimersByTimeAsync(25_000);
    await expectError(await pending, 504, `${stage.name}_timeout`);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(rows(stage.claims)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('prevents a duplicate concurrent provider request while a claim is held', async () => {
    const started = deferred<void>(), response = deferred<Response>();
    fetcher.mockImplementation(async () => { started.resolve(); return response.promise; });
    const first = invoke(stage);
    await started.promise;
    try {
      await expectError(await invoke(stage), 409, `${stage.name}_in_progress`);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(rows(stage.claims)).toHaveLength(1);
    } finally { response.resolve(validResponse(stage.output)); }
    expect((await first).status).toBe(201);
    expect(rows(stage.table)).toHaveLength(1);
    expect(rows(stage.claims)).toEqual([]);
  });

  it('does not persist or delete a replacement owner after losing its lease', async () => {
    fetcher.mockImplementation(async () => {
      db.sqlite.exec(`UPDATE ${stage.claims} SET owner_token = 'replacement-owner'`);
      return validResponse(stage.output);
    });
    await expectError(await invoke(stage), 409, `${stage.name}_in_progress`);
    expect(rows(stage.table)).toEqual([]);
    expect(rows(stage.claims)).toMatchObject([{ owner_token: 'replacement-owner' }]);
  });

  it('checks ownership before dispatch and preserves a replacement claim', async () => {
    db.beforeExecute = sql => {
      if (sql.startsWith(`SELECT 1 FROM ${stage.claims}`)) db.sqlite.exec(`UPDATE ${stage.claims} SET owner_token = 'replacement-owner'`);
    };
    await expectError(await invoke(stage), 409, `${stage.name}_in_progress`);
    expect(fetcher).not.toHaveBeenCalled();
    expect(rows(stage.table)).toEqual([]);
    expect(rows(stage.claims)).toMatchObject([{ owner_token: 'replacement-owner' }]);
  });

  it('preserves the provider failure classification if best-effort claim cleanup also fails', async () => {
    fetcher.mockRejectedValue(new Error('PRIVATE_FIXTURE_DETAIL'));
    db.beforeExecute = sql => {
      if (sql.startsWith(`DELETE FROM ${stage.claims} WHERE document_id`)) throw new Error('PRIVATE_FIXTURE_DETAIL cleanup');
    };
    await expectError(await invoke(stage), 502, `${stage.name}_provider_failure`);
    expect(rows(stage.table)).toEqual([]);
    expect(rows(stage.claims)).toHaveLength(1); // Lease expiry remains the fallback.
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('rejects corrupt saved JSON safely instead of calling the provider during a read', async () => {
    fetcher.mockImplementation(async () => validResponse(stage.output));
    expect((await invoke(stage)).status).toBe(201);
    const column = stage.name === 'metadata' ? 'evidence_json' : stage.name === 'summary' ? 'overview_json' : 'answer_parts_json';
    db.sqlite.prepare(`UPDATE ${stage.table} SET ${column} = ?`).run('PRIVATE_FIXTURE_DETAIL invalid JSON');
    await expectError(await invoke(stage, new Request('http://localhost/result')), 503, 'database_failure');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('does not persist when deletion begins during generation', async () => {
    fetcher.mockImplementation(async () => {
      db.sqlite.exec("UPDATE uploaded_documents SET status = 'deleting'");
      return validResponse(stage.output);
    });
    await expectError(await invoke(stage), 409, `${stage.name}_in_progress`);
    expect(rows(stage.table)).toEqual([]);
    expect(rows(stage.claims)).toEqual([]);
  });

  it('rolls back failed persistence, returns a safe error and releases its claim', async () => {
    fetcher.mockImplementation(async () => validResponse(stage.output));
    db.beforeExecute = sql => { if (sql.startsWith(`INSERT INTO ${stage.table} (`)) throw new Error('PRIVATE_FIXTURE_DETAIL'); };
    await expectError(await invoke(stage), 503, 'database_failure');
    expect(rows(stage.table)).toEqual([]);
    expect(rows(stage.claims)).toEqual([]);
    expect(rows('document_extractions')).toHaveLength(1);
  });
});

describe.each(stages.filter(stage => stage.name !== 'question'))('$name corrective generation', stage => {
  it('corrects one invalid result under the same claim, then persists only the valid output', async () => {
    const owners: unknown[] = [];
    fetcher.mockImplementation(async () => {
      owners.push(rows(stage.claims)[0].owner_token);
      return owners.length === 1 ? validResponse(stage.name === 'metadata' ? '{"year":"invalid"}' : ' ') : validResponse(stage.output);
    });
    expect((await invoke(stage)).status).toBe(201);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(owners[0]).toBeTruthy();
    expect(owners[1]).toBe(owners[0]);
    const retry = JSON.parse(String(fetcher.mock.calls[1][1]?.body));
    expect(retry.input[1].content).toContain('previous attempt returned an invalid or empty result');
    expect(rows(stage.table)).toHaveLength(1);
    expect(rows(stage.claims)).toEqual([]);
  });

  it('rejects a nonempty POST body before claiming or calling the provider', async () => {
    const request = new Request('http://localhost/result', { method: 'POST', body: '{}' });
    await expectError(await invoke(stage, request), 400, 'invalid_request');
    expect(request.body?.locked).toBe(false);
    expect(rows(stage.claims)).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('question cache identity', () => {
  const stage = stages[2];
  it('normalizes whitespace and invalidates cache when extraction provenance changes', async () => {
    fetcher.mockImplementation(async () => validResponse(stage.output));
    expect((await invoke(stage, post(stage, 'What   is the finding?'))).status).toBe(201);
    expect((await invoke(stage, post(stage, 'What is the finding?'))).status).toBe(200);
    expect(fetcher).toHaveBeenCalledOnce();
    db.sqlite.prepare('UPDATE document_extractions SET extracted_at = ?').run('2026-11-08T23:01:00.000Z');
    expect((await invoke(stage, post(stage))).status).toBe(201);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(rows(stage.table)).toHaveLength(2);
    expect(new Set(rows(stage.table).map(row => row.extraction_fingerprint)).size).toBe(2);
  });
});
