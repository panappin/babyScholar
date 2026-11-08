# Round 2 assessment

Full evaluation: `npm.cmd run baseline`,
`artifacts/baseline/2026-11-08T19-24-56.461Z`. Aggregate exit 1;
18/19 stages passed. Generated tests: **163/163 passed**, seven files.
This adds 57 cases after the 106-test round-1 result and fault probes were
archived. Source tree, lockfile, coverage scope, evaluation commands, profile
workloads, and machine are unchanged.

| Metric | Initial | Round 1 | Final covered / total | Final percent |
|---|---:|---:|---:|---:|
| Statements | 3.07% | 12.29% | 470 / 2960 | 15.87% |
| Branches | 2.46% | 10.13% | 317 / 2595 | 12.21% |
| Functions | 2.43% | 12.57% | 82 / 533 | 15.38% |
| Lines | 3.51% | 12.31% | 394 / 2444 | 16.12% |

## Changes guided by actual round-1 feedback

- **27 recovery cases:** success, stage-specific corrective responses,
  default/shared deadlines, consumed budget, ownership before each attempt,
  nonretryable error classes and HTTP failures, a two-attempt ceiling, and
  sanitized terminal errors/diagnostics. The helper receives mocked provider
  callbacks, not a live API. Provider adapters remain responsible for enforcing
  the I/O timeout passed to them.
- **20 source-selection cases:** independent literal byte budgets, full versus
  partial pages, first-three-page metadata versus all-page summaries, preserved
  empty pages, exact/overflow limits, complete Unicode prefixes and immutable
  extraction inputs. Tests do not impose citation or quote requirements.
- **10 UTF-8 cases:** invalid sequences now sit inside otherwise valid JSON
  strings. A correctly encoded replacement character is accepted. This addresses
  the actual lossy-decoder survivor rather than adding another syntactically
  invalid JSON fixture.
- **Browser diagnostics:** retain request/status/failure metadata and bounded
  direct Worker/Vite GET probes on failure. Assertions and application timeout
  settings are unchanged. No product or proxy configuration was altered.

The first focused invocation encountered a test-file syntax error (one extra
parenthesis), with 153 executed cases passing and the UTF-8 file unable to load.
The file and failed result are preserved. The syntax-only correction yielded
163 passing tests; it did not change an assertion or application behavior.

## Actual failures and correctness review

The final browser stage fails at **`browser refresh` page readiness** after a
real D1 save, before the subsequent record wait. This is distinct from the
initial stale-summary-label failure and the round-1 record-refresh wait.
The final captured direct Worker library GET returns HTTP 200 and one saved
paper; the same GET through the owned Vite server times out. The separate
unchanged and instrumented diagnostic attempts are preserved in
[development evidence](development/README.md).

Classification: **observed unresolved local integration/runtime failure**,
narrowed to the Vite/proxy path. Its exact root cause is not proven, so it is
not attributed to product logic, browser discovery, stale copy, or pipe
backpressure without further evidence. No genuine existing application bug is
confirmed by this task. Later browser flows, including the round-1 repairs to
generation/quote assertions, are not reported as passing. Backend persistence
and metadata verifier checks do pass.

The new tests use independently specified results and both sides of limits.
Review specifically avoided mandatory citations, a hard 300-word parser gate,
or treating PDF magic validation as proof of successful PDF extraction.
Recovery/source-selection tests are distinct from round 1's boundary validators.
The agent's syntax error is reported as a test-authoring failure, not a product
bug. Neither seeds nor intentional offline provider errors count as existing
application defects.

## Same five fault probes, after the full evaluation

Command: `node scripts/baseline/fault-probes.mjs round-2`. The unmodified
isolated control passes all 163 tests. Working application source is never
mutated; every probe uses a disposable copy.

| Seeded regression | Round 1 | Round 2 | Failing tests in round 2 |
|---|---|---|---:|
| Reject exact 10 MiB upload | Detected | Detected | 1 |
| Decode question UTF-8 lossily | Survived | Detected | 4 |
| Retry nonretryable generation error | Survived | Detected | 13 |
| Summary source budget plus one byte | Survived | Detected | 5 |
| Reject ordinary summary prose | Detected | Detected | 5 |

These five deliberately selected regressions demonstrate specific fault
detection. They are not a representative mutation sample or a general mutation
score. The initial suite was not tested against these probes, so no initial
probe result is invented.

## Remaining gaps and comparison limits

Generation recovery has 17/18 lines and 24/24 branches; the terminal defensive
fall-through line is unexercised. Both source selectors have full measured
line/branch coverage. Question-request lines remain 100% while its previously
surviving UTF-8 fault is now detected: stronger fixtures matter independently
of line percentage. Library validation still has 87.69% lines / 66.07%
branches; many UI, routing, provider and storage modules remain at zero in
this Node suite. Existing integration checks are separate evidence and do not
increase these unit-coverage percentages.

The three runs' counts use the same all-source denominator. Raw profiles and
per-file reports are archived. CPU samples are local microbenchmarks with
variable load/JIT state, not endpoint latency or proof of a performance change.
Live providers, production data/load, hosted behavior and OCR remain outside
scope. The browser/proxy failure remains an explicit follow-up limitation.

Evidence: [exact round instruction](instructions.md),
[stage results](evidence/results.json), [per-file coverage](evidence/per-file-coverage.csv),
[raw coverage JSON](evidence/coverage/coverage-final.json),
[exact tests/configuration/verifier snapshots](evidence/snapshot/),
[fault-probe outcomes and failed test names](fault-probes/results.json),
and [complete comparison](../../comparison.json).
