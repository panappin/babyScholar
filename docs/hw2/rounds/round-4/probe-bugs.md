# Confirmed probe defects, reproduced before the product fix

These are two separate existing defects in the local connectivity probe,
not seeded faults and not evidence that document generation shares the bugs.
The three document provider adapters already keep their timers through body
reading and guard null envelopes.

## Deadline ends at response headers

`probeOpenAi` starts a deadline but its `finally` cleared the timer immediately
after `fetch` returned headers, before `response.json()` consumed the body.
A real Response backed by an abort-aware stalled ReadableStream reproduces
the issue. After 20 ms of fake time, `expect(signal.aborted).toBe(true)` fails:
the signal remains false and the operation remains pending until fixture
cleanup. A separate stalled-before-headers test already passes.

The contract is the probe's explicit timeout argument, timeout error and
AbortSignal, consistent with its role as a bounded connectivity check. The
reproduction does not rely on a live request, scheduler speed, or waiting for
Vitest's own timeout. The fixture always releases its pending promise in
`finally`, including when the assertion fails.

Fix: retain the existing timer through body consumption and validation; map an
abort during either headers or body to `IntegrationError('timeout', ...)`.
Clear the timer on every completion path. There is still one request, no retry,
and no new request/response size policy. Fetch implementations must honor the
AbortSignal, as native fetch does; arbitrary non-cooperating injected promises
are not claimed to be forcibly interrupted.

## Null successful JSON loses its error classification

An HTTP 200 `Response.json(null)` reaches `record.status`, throwing a TypeError
instead of the existing `malformed_response` classification. Two assertions
confirm the defect: the public probe rejects with the wrong error type, and
passing that error through the caller's `publicIntegrationError` produces
`network_failure`. The local route catches the error; this is a classification
defect, not a claim that the Worker process crashes.

Fix: guard the successful JSON envelope before accessing status, preserving
HTTP error classification first. Remove an unreachable duplicate guard inside
the text helper. Null/non-object/array success envelopes now return a classified
malformed-response error.

## Before and after evidence

- `2026-11-08T23-38-14.457Z-r4-probe-before`: 24 tests, 21 passing and three
  failing assertions for the two defects. The unchanged source is snapshotted.
- `2026-11-08T23-38-38.111Z-r4-probe-after`: the same 24 tests all pass after
  the narrow fix. No test assertions were weakened.

Both are in this round's development archive. The product fix is committed
separately from the new tests and evidence tooling. Earlier App bug evidence
and every earlier round remain unchanged.
