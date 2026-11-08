# Round 1: bounded inputs and current output contracts

Recorded before implementation, after the complete Windows initial evaluation
at `artifacts/baseline/2026-11-08T19-03-28.103Z` was archived.

## Actual feedback supplied

- Initial generated suite: 24 passing tests; statements 91/2960 (3.07%),
  branches 64/2595 (2.46%), functions 13/533 (2.43%), lines 86/2444 (3.51%).
- `question-request.ts` has 90.19% lines but missed timeout, stream failure,
  overflow, and cleanup lines 42, 52, 58-59, 75. High line coverage alone
  therefore conceals important request-boundary risk.
- `library-validation.ts`, `question-validation.ts`, `summary-validation.ts`
  have zero coverage. `document-validation.ts` is 10.66% lines and
  `metadata-validation.ts` is 9.52%, mainly incidental imports.
- 17/19 baseline stages pass. The metadata verifier's recorded fixture fields
  match, but it expects v2 instead of v4 and nonempty verified quotes.
- The real Windows browser starts and executes earlier flows. It fails at
  `frontend-search-browser-check.mjs:812`: waiting for `Generating a
  source-grounded summary`, while the current UI displays `Generating a
  summary using saved PDF text...`. This is a stale test expectation, not
  evidence of a provider, browser-discovery, or product failure.

## Exact round instruction (agent self-guidance)

```text
Improve the initial suite using the measured request-boundary and validator gaps.
Add tests for all three bounded input readers (library JSON, question JSON,
multipart PDF): actual bytes over dishonest Content-Length, stalled/erroring
streams, the shared 10-second read deadline, cancellation that never settles,
and released stream locks. For JSON, include split multibyte UTF-8, malformed
and incomplete UTF-8, invalid JSON, and the exact wrapper-byte boundary.
For PDF upload, verify original bytes and a fixed SHA-256, content rather than
MIME/filename, one-file-only form rules, Unicode filename lengths, and exact
10 MiB acceptance versus one-byte overflow. Test current metadata, summary,
and answer validation with independent positive and negative expectations,
optional legacy envelopes, nullable fields, byte bounds, and discarded new
unverified evidence. Do not demand citations or a hard 300-word answer gate.
Repair the demonstrated stale metadata verifier oracles and browser copy
expectations against the current README and UI contract, retaining meaningful
field, persistence, cache, legacy-quote rendering, and error checks. Diagnose
any further real failure rather than weakening assertions to obtain green.
Keep application source, dependencies, coverage configuration and baseline
commands unchanged. Preserve focused development results and all failures.
Run npm.cmd run baseline again, archive the complete round-1 evidence and
test snapshots, and only then select round 2 from its actual remaining gaps.
```

This is the first guided improvement round. The original 24 tests remain
unchanged. Verifier repairs are reported separately from new unit-test coverage
and from product fault detection.

## Supplemental diagnostic instruction (before execution)

```text
After the full round-1 evaluation has completed, run a control and five
hand-selected seeded regressions in disposable copies of src, tests and the
unchanged Vitest config. Never mutate the working source. Check exact upload
limit rejection, lossy question UTF-8 decoding, retries after a network failure,
a summary source budget one byte too large, and refusal of ordinary summary
prose. Count a seed as detected only when the clean control passes and test
assertions fail, not when the runner crashes. Keep surviving seeds as feedback
for round 2. These are synthetic regressions, not discovered existing bugs or
a comprehensive mutation score. Use the same five probes after round 2.
```
