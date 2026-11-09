// Startup probes are strictly read-only. No provider request or migration.
const endpoints = [
  ['/api/health', body => body?.status === 'ok'],
  ['/api/storage/status', body => body?.status === 'ok' && body?.d1?.status === 'ok' && body?.r2?.status === 'ok'],
  ['/api/library/papers', body => Array.isArray(body?.papers)],
  ['/api/documents', body => Array.isArray(body?.documents)],
];

export async function waitForReadiness(origin, { label = origin, timeoutMs = 30_000,
  requestTimeoutMs = 2_000, intervalMs = 200, fetchImplementation = fetch,
  signal = new AbortController().signal } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastFailure = 'no successful startup checks';
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    let ready = true;
    for (const [path, validate] of endpoints) {
      signal.throwIfAborted();
      const budget = Math.min(requestTimeoutMs, deadline - Date.now());
      if (budget <= 0) { ready = false; break; }
      const controller = new AbortController();
      const combined = AbortSignal.any([signal, controller.signal]);
      let timer;
      let onAbort;
      try {
        await Promise.race([
          (async () => {
            const response = await fetchImplementation(new URL(path, origin), { method: 'GET', signal: combined });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            if (!validate(await response.json())) throw new Error('unexpected startup response');
          })(),
          new Promise((_, reject) => {
            onAbort = () => reject(new Error('request cancelled or timed out'));
            combined.addEventListener('abort', onAbort, { once: true });
            if (combined.aborted) onAbort();
            timer = setTimeout(() => controller.abort(), budget);
          }),
        ]);
      } catch (error) {
        // Never echo endpoint payloads, library contents or credentials.
        const reason = /^HTTP \d+$|^unexpected startup response$/.test(error?.message ?? '')
          ? error.message : 'unreachable or timed out';
        lastFailure = `${path}: ${reason}`;
        ready = false;
        break;
      } finally {
        clearTimeout(timer);
        if (onAbort) combined.removeEventListener('abort', onAbort);
        controller.abort();
      }
    }
    signal.throwIfAborted();
    if (ready && Date.now() < deadline) return;
    if (Date.now() >= deadline) break;
    await new Promise((resolve, reject) => {
      const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, Math.max(0, Math.min(intervalMs, deadline - Date.now())));
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }
  throw new Error(`${label} was not ready within ${timeoutMs / 1000}s (${lastFailure}). Check the Worker logs, storage/schema configuration and occupied ports. Apply documented local migrations explicitly only if needed; startup does not migrate or reset data.`);
}
