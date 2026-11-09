import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { probeOpenAi } from '../../src/worker/openai';
import { IntegrationError, publicIntegrationError } from '../../src/worker/integration-errors';

const env = { OPENAI_API_KEY: ' offline-fixture-only ', OPENAI_MODEL: ' gpt-6-luna ' };
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected live fetch'); }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('OpenAI connectivity probe contracts', () => {
  it.each([undefined, '', '   '])('rejects missing configuration before fetch (%s)', async key => {
    const fetcher = vi.fn();
    await expect(probeOpenAi({ OPENAI_API_KEY: key }, fetcher)).rejects.toMatchObject({ kind: 'missing_configuration' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('makes one non-stored request and returns trimmed direct text', async () => {
    const fetcher = vi.fn(async () => Response.json({ status: 'completed', output_text: ' OK ' }));
    await expect(probeOpenAi(env, fetcher)).resolves.toEqual({ provider: 'openai', model: 'gpt-6-luna', text: 'OK' });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer offline-fixture-only');
    expect(JSON.parse(String(init.body))).toEqual({ model: 'gpt-6-luna', input: 'Reply with the word OK.', store: false,
      reasoning: { effort: 'none' }, max_output_tokens: 256 });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(init.signal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('joins usable REST text parts and keeps custom model parameters portable', async () => {
    const fetcher = vi.fn(async () => Response.json({ status: 'completed', output: [null, 2, {},
      { content: [null, { type: 'other', text: 'ignored' }, { type: 'output_text', text: ' First ' },
        { type: 'output_text', text: ' ' }, { type: 'output_text', text: 'Second' }] }] }));
    await expect(probeOpenAi({ ...env, OPENAI_MODEL: ' fixture-model ' }, fetcher))
      .resolves.toMatchObject({ model: 'fixture-model', text: 'First\nSecond' });
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ model: 'fixture-model', input: 'Reply with the word OK.', store: false });
  });

  it.each([
    [401, {}, 'authentication'], [429, null, 'quota_or_rate_limit'],
    [403, { error: { message: 'model access denied' } }, 'model_access'],
    [403, { error: 'denied' }, 'authentication'],
    [400, { error: { code: 'unsupported_model' } }, 'model_access'],
    [404, { error: { type: 'not_found' } }, 'model_access'],
    [500, { error: { message: 'private upstream detail' } }, 'upstream_error'],
  ])('classifies HTTP %s safely without retry', async (status, payload, kind) => {
    const fetcher = vi.fn(async () => Response.json(payload, { status: Number(status) }));
    await expect(probeOpenAi(env, fetcher)).rejects.toMatchObject({ name: 'IntegrationError', kind, upstreamStatus: status,
      message: `OpenAI returned HTTP ${status}.` });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([null, 42, [], {}, { status: 'incomplete', output_text: 'partial' },
    { status: 'completed', output: [{ content: [{ type: 'refusal', refusal: 'no' }] }] },
    { status: 'completed', output_text: ' ' }])('rejects unusable successful payload %# as a classified error', async payload => {
    await expect(probeOpenAi(env, async () => Response.json(payload)))
      .rejects.toMatchObject({ name: 'IntegrationError', kind: 'malformed_response' });
  });

  it('propagates null JSON to the caller as malformed response, not network failure', async () => {
    const result = await probeOpenAi(env, async () => Response.json(null)).catch(publicIntegrationError);
    expect(result).toMatchObject({ kind: 'malformed_response' });
  });

  it('classifies invalid JSON without exposing its contents', async () => {
    await expect(probeOpenAi(env, async () => new Response('private invalid payload')))
      .rejects.toMatchObject({ kind: 'malformed_response', upstreamStatus: 200,
        message: 'OpenAI returned a non-JSON response.' });
  });

  it('classifies transport failures and clears the deadline', async () => {
    await expect(probeOpenAi(env, async () => { throw new Error('private network detail'); }))
      .rejects.toMatchObject({ kind: 'network_failure', message: 'Could not reach the OpenAI API.' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts a request that stalls before response headers', async () => {
    const fetcher = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    }));
    const assertion = expect(probeOpenAi(env, fetcher, 20)).rejects.toMatchObject({ kind: 'timeout' });
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
    expect(fetcher).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the deadline active while consuming a stalled response body', async () => {
    let signal!: AbortSignal;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      signal = init!.signal!;
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      return new Response(body);
    });
    const outcome = probeOpenAi(env, fetcher, 20).then(value => ({ value }), error => ({ error }));
    try {
      await vi.advanceTimersByTimeAsync(20);
      expect(signal.aborted).toBe(true);
      const result = await outcome;
      expect(result).toMatchObject({ error: { name: 'IntegrationError', kind: 'timeout' } });
      expect('error' in result && result.error).toBeInstanceOf(IntegrationError);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      // Even the pre-fix failure is bounded; do not leave the stalled promise alive.
      if (!signal.aborted) controller.error(new Error('fixture cleanup'));
      await outcome;
    }
  });
});
