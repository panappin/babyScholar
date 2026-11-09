import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateWithRecovery } from '../../src/worker/generation-recovery';
import { DocumentError } from '../../src/worker/document-validation';
import { IntegrationError, type IntegrationFailureKind } from '../../src/worker/integration-errors';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('generation recovery and ownership (round 2)', () => {
  it('validates one successful response and supplies the default 25-second budget', async () => {
    const owner = vi.fn(async () => {});
    const request = vi.fn(async () => ({ model: 'fixture-model', output: 'raw' }));
    const validate = vi.fn(() => ({ answer: 'validated' }));
    await expect(generateWithRecovery('question', request, validate, owner))
      .resolves.toEqual({ model: 'fixture-model', output: { answer: 'validated' } });
    expect(owner).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledExactlyOnceWith(25_000, '');
    expect(validate).toHaveBeenCalledExactlyOnceWith('raw');
  });

  it.each(['metadata', 'summary', 'question'] as const)('corrects one invalid %s output within the same budget', async stage => {
    const events: string[] = [];
    const owner = vi.fn(async () => { events.push('owner'); });
    const request = vi.fn(async (_remaining: number, _correction: string) => {
      events.push('request');
      vi.setSystemTime(Date.now() + 200);
      return { model: 'fixture-model', output: events.length };
    });
    let validations = 0;
    const validate = vi.fn(() => {
      events.push('validate');
      if (++validations === 1) throw new DocumentError(`${stage}_invalid_response`, 502, 'invalid provider output');
      return 'usable';
    });
    await expect(generateWithRecovery(stage, request, validate, owner, 1_000))
      .resolves.toEqual({ model: 'fixture-model', output: 'usable' });
    expect(request.mock.calls[0]).toEqual([1_000, '']);
    expect(request.mock.calls[1][0]).toBe(800);
    expect(request.mock.calls[1][1]).toContain('previous attempt returned an invalid or empty result');
    expect(events).toEqual(['owner', 'request', 'validate', 'owner', 'request', 'validate']);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, 200])('corrects malformed successful provider data (status %s)', async status => {
    const request = vi.fn().mockRejectedValueOnce(new IntegrationError('malformed_response', 'invalid body', status))
      .mockResolvedValueOnce({ model: 'fixture', output: 'usable' });
    await expect(generateWithRecovery('summary', request, value => value, async () => {}))
      .resolves.toEqual({ model: 'fixture', output: 'usable' });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each(['authentication', 'quota_or_rate_limit', 'model_access', 'network_failure', 'timeout',
    'upstream_error', 'refusal', 'incomplete_response', 'missing_configuration'] as IntegrationFailureKind[])
  ('never retries %s', async kind => {
    const failure = new IntegrationError(kind, 'provider failure');
    const request = vi.fn().mockRejectedValue(failure);
    const validate = vi.fn();
    await expect(generateWithRecovery('question', request, validate, async () => {})).rejects.toBe(failure);
    expect(request).toHaveBeenCalledOnce();
    expect(validate).not.toHaveBeenCalled();
  });

  it.each([400, 503])('does not retry malformed upstream HTTP failures (%s)', async status => {
    const failure = new IntegrationError('malformed_response', 'bad HTTP response', status);
    const request = vi.fn().mockRejectedValue(failure);
    await expect(generateWithRecovery('metadata', request, value => value, async () => {})).rejects.toBe(failure);
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([new Error('unexpected implementation failure'), new DocumentError('metadata_invalid_response', 502, 'wrong stage')])
  ('does not misclassify an unrelated error as a summary correction', async failure => {
    const request = vi.fn().mockRejectedValue(failure);
    await expect(generateWithRecovery('summary', request, value => value, async () => {})).rejects.toBe(failure);
    expect(request).toHaveBeenCalledOnce();
  });

  it.each(['metadata', 'summary', 'question'] as const)('stops after two invalid %s attempts without echoing provider content', async stage => {
    const request = vi.fn().mockRejectedValue(new IntegrationError('malformed_response', 'PRIVATE FIXTURE CONTENT'));
    const result = await generateWithRecovery(stage, request, value => value, async () => {}).catch(error => error);
    expect(result).toMatchObject({ kind: `${stage}_invalid_response`, status: 502 });
    expect(result.message).toContain('after two attempts');
    expect(result.message).toContain('Your PDF and text remain available');
    expect(result.message).not.toContain('PRIVATE FIXTURE CONTENT');
    expect(request).toHaveBeenCalledTimes(2);
    expect(vi.mocked(console.warn).mock.calls.flat().join(' ')).not.toContain('PRIVATE FIXTURE CONTENT');
    expect(console.info).not.toHaveBeenCalled();
  });

  it('does not request generation if ownership is already lost', async () => {
    const failure = new DocumentError('document_not_found', 404, 'removed');
    const owner = vi.fn().mockRejectedValue(failure);
    const request = vi.fn();
    await expect(generateWithRecovery('summary', request, value => value, owner)).rejects.toBe(failure);
    expect(request).not.toHaveBeenCalled();
  });

  it('rechecks ownership before the corrective attempt', async () => {
    const failure = new DocumentError('document_not_found', 404, 'removed between attempts');
    const owner = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(failure);
    const request = vi.fn().mockRejectedValue(new IntegrationError('malformed_response', 'invalid output'));
    await expect(generateWithRecovery('summary', request, value => value, owner)).rejects.toBe(failure);
    expect(owner).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledOnce();
  });

  it('includes ownership-check time in the overall budget', async () => {
    const request = vi.fn();
    await expect(generateWithRecovery('summary', request, value => value, async () => { vi.setSystemTime(1_000); }, 1_000))
      .rejects.toMatchObject({ kind: 'timeout' });
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects a valid response arriving at the deadline', async () => {
    const request = vi.fn(async () => { vi.setSystemTime(1_000); return { model: 'fixture', output: 'usable' }; });
    await expect(generateWithRecovery('summary', request, value => value, async () => {}, 1_000))
      .rejects.toMatchObject({ kind: 'timeout' });
    expect(request).toHaveBeenCalledOnce();
  });

  it('does not grant a fresh budget after a recoverable failure uses the deadline', async () => {
    const request = vi.fn(async () => { vi.setSystemTime(1_000); throw new IntegrationError('malformed_response', 'late invalid result'); });
    await expect(generateWithRecovery('summary', request, value => value, async () => {}, 1_000))
      .rejects.toMatchObject({ kind: 'timeout' });
    expect(request).toHaveBeenCalledOnce();
    expect(JSON.parse(vi.mocked(console.warn).mock.calls[0][0]).correctiveAttempt).toBe(false);
  });
});
