# Round 2 development and diagnostic attempts

The official comparison is the subsequent full baseline, not these focused
checks. Earlier failures are retained rather than overwritten.

## Unit development

```powershell
npm.cmd test -- --reporter=default --reporter=json --outputFile=artifacts/hw2-development/round-2/tests-1.json
npm.cmd test -- --reporter=default --reporter=json --outputFile=artifacts/hw2-development/round-2/tests-2.json
```

The first invocation exits 1: 153 tests pass, but the new UTF-8 file has one
extra closing parenthesis and fails transformation before its 10 tests run.
This is an **agent-generated test syntax error**, not a product failure.
[The exact failed file](utf8-integrity.failed.ts),
[failed log](tests-1.log) and [structured result](tests-1.json) are retained.
Removing that single extra parenthesis produces **163/163 passing tests** in
seven files on the second invocation ([log](tests-2.log), [JSON](tests-2.json)).
No application source or assertion expectation changed to fix this error.

## Browser investigation

Both separate diagnostic invocations use:

```powershell
node scripts/frontend-search-browser-check.mjs
```

1. **Unchanged verifier rerun**: exits 1 at the same `record after browser
   refresh` wait as the official round-1 evaluation. The UI reports a timed-out
   library read. [Log](browser-recheck-unchanged.log) and
   [structured result](browser-recheck-unchanged.json) preserve it; the script
   is byte-identical to the round-1 archived browser snapshot.
2. **Transport diagnostic**: after reproduction, add metadata-only CDP request/
   response/failure tracking, buffered child-pipe byte counts, and bounded
   direct Worker/Vite library GET probes on a failed wait. No assertion or
   product behavior is changed. The [diagnostic script snapshot](browser-transport-diagnostic.mjs)
   preserves the exact instrumentation used. Headers, credentials and response
   bodies are not recorded by this instrumentation.

The instrumented attempt also exits 1 at persisted-library refresh. Its
[structured result](browser-transport-diagnostic.json) records:

- Direct Worker library GET: HTTP 200, one persisted paper.
- Vite-proxied library GET from Node: `TimeoutError` after a two-second bound.
- Browser library/health/storage requests at refresh: aborted, without recorded
  responses. This is not a missing record in D1 or a text-label assertion.
- Buffered child output was only 3747/0 bytes for Worker stdout/stderr,
  73/430 for Vite, and 0/15799 for Chrome. No pipe-capacity root cause is proven.

This narrows the failure to the local development/proxy path, but does not
establish which runtime, transport, or application component caused it. The
failure remains open. No timeout is increased, no refresh assertion is removed,
and no product or Vite configuration is changed to get a passing result. The
metadata-only diagnostics remain available in the final full evaluation.
A diagnostic rerun never replaces the failed round-1 result.
