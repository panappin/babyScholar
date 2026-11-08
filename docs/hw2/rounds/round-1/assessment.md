# Round 1 assessment

Full evaluation: `npm.cmd run baseline`,
`artifacts/baseline/2026-11-08T19-11-08.389Z`. Aggregate exit 1;
18/19 stages passed. Generated tests: **106/106 passed** (82 new cases),
four files. The preceding focused invocation also passed all 106 cases.

| Metric | Initial covered / total | Round 1 covered / total | Round 1 percent |
|---|---:|---:|---:|
| Statements | 91 / 2960 | 364 / 2960 | 12.29% |
| Branches | 64 / 2595 | 263 / 2595 | 10.13% |
| Functions | 13 / 533 | 67 / 533 | 12.57% |
| Lines | 86 / 2444 | 301 / 2444 | 12.31% |

## Changes and correctness review

- Added 34 request/stream/upload tests and 48 provider-output validator tests.
  Native Web streams and Requests exercise actual decoding/parsing. Fake clocks
  check that stalled bodies remain pending at 9999 ms and return 408 at 10000 ms,
  even if cancellation never settles. Error kinds, locks, and timers are checked.
- Literal byte limits have both accepted-boundary and rejected-overflow cases.
  PDF identity uses known bytes and an independently computed fixed SHA-256.
  Unicode tests distinguish UTF-8 bytes, Unicode code points, and UTF-16 units.
- Output tests accept citation-free prose and legacy envelopes, discard new
  unverified quotes, retain null fields and uncertainty, and enforce actual
  shape/byte bounds. The 300-word provider instruction is not invented as a
  hard validator rejection rule.
- Corrected metadata verifier v2/mandatory-quote assertions to current v4 and
  empty new-evidence arrays. Its success, deliberate field mismatch, and
  application-error scenarios all pass; field/cache/persistence checks remain.
- Updated obsolete browser feedback labels and new-generation quote assertions.
  Saved-quote fixtures still have rendering checks. The official round-1 run
  **does not validate all those repairs** because it fails earlier, below.

## Browser failure and limits

At `frontend-search-browser-check.mjs:750`, the real library-refresh scenario
times out waiting for the persisted record. Captured UI state has zero cards
and `Loading the library took too long. Please reload it.` The initial run
passed this same scenario. Backend library persistence checks still pass.

This is an **unresolved integration/runtime timeout**, not the initial stale
summary label and not proof of a product defect or a specific environment
cause. No assertion is removed and no passing retry replaces this failed run.
Round 2 should investigate it and retain any separate diagnostic attempt.

## Fault-detection experiment

Command: `node scripts/baseline/fault-probes.mjs round-1`.
The isolated clean control passes all 106 tests. Five hand-selected source
mutations run only in disposable copies, with the same suite and config.

| Seeded regression | Round 1 outcome |
|---|---|
| Reject an exactly 10 MiB upload | Detected: 1 failing test |
| Decode question UTF-8 lossily | Survived |
| Retry generation after a network failure | Survived |
| Increase summary source budget by one byte | Survived |
| Require a summary envelope instead of accepting prose | Detected: 5 failing tests |

The UTF-8 survivor exposes a weak fixture: the invalid byte/incomplete sequence
is also invalid JSON, so JSON parsing rejects it even if the decoder silently
replaces invalid bytes. This is a test-design limitation, **not a current
application bug**. Round 2 should place invalid bytes inside otherwise valid
JSON and assert rejection rather than normalized replacement text.

`generation-recovery.ts`, `metadata-source.ts`, and `summary-source.ts` still
have zero line coverage. Their missing recovery/deadline and source-budget
behavior explains the other two survivors and guides a distinct second round.
Question request handling has 100% lines despite the UTF-8 survivor, a concrete
reason not to treat line coverage as a correctness score.

No existing application defect was confirmed. These five seeded probes are
neither discovered bugs nor a repository-wide mutation score.

Evidence: [instructions](instructions.md), [full stage results](evidence/results.json),
[per-file coverage](evidence/per-file-coverage.csv),
[test/configuration snapshots](evidence/snapshot/),
[development results](development/tests-1.json), and
[fault-probe commands, mutations, outcomes and failing test names](fault-probes/results.json).
