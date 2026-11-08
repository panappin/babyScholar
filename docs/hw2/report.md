# BabyScholar HW2: guided test generation and evaluation

November 8, 2026. Report draft for author review and PDF export.

## 1. Test Generation Approach

The subject is [BabyScholar](https://github.com/panappin/babyScholar), a React
and Cloudflare Worker research workspace for paper search, a saved library,
PDF upload/extraction, metadata, summaries, and questions. The application
source stayed unchanged during this evaluation: Git source tree
`2b735d17bc59c5e714dee91c837f05ead0a5d30d`.

The inherited initial suite contains 24 deterministic Node/Vitest tests in two
files: 13 identity/link cases and 11 question-request cases. It checks modern
and legacy arXiv IDs, version handling, unsafe links, cross-paper mismatch,
JSON request shape, normalized cache identity, and UTF-8 question limits.
The [original generation record](initial-prompt.md) preserves the earlier
instruction to create baseline tests, coverage, profiling, and assessment.

The new instruction was to reproduce that baseline, then perform two distinct
improvements driven by actual results and remaining coverage gaps. It also
explicitly required failure triage, correct product requirements, and no
invented citation requirement. The [verbatim interaction record](improvement-request.md)
contains the request and the user's six-section rubric clarification.
Each round's exact recorded self-instruction precedes its implementation;
these are labeled agent self-guidance, not invented additional user prompts.

Evaluation used `npm.cmd ci` and the same `npm.cmd run baseline` command for
all three comparison runs on Windows. The harness executes 19 stages: build
and typechecks, existing offline backend/browser checks, the generated suite
with V8 source coverage, and fixed local CPU workloads. Existing integration
scripts are evaluated separately from unit-test counts. Providers use local
fixtures; no live OpenAI/arXiv request, deployment, or production data is used.

## 2. Initial Test Evaluation

The new Windows reproduction began at commit `e2f5c97` on
`hw2/initial-baseline`. All 24 unit tests passed; 17/19 baseline stages passed,
so the aggregate command exited 1. Coverage was 91/2960 statements (3.07%),
64/2595 branches (2.46%), 13/533 functions (2.43%), and 86/2444 lines (3.51%).

Two existing checks had stale oracles. The metadata verifier expected prompt
v2 instead of current v4 and mandatory source-matching quotes. Its recorded
bibliographic fields, source hash, and page selection actually matched. The
Windows browser started successfully but waited for obsolete summary progress
wording. The Linux browser-discovery failure in the historical assessment was
therefore not the cause on this machine.

The initial tests correctly asserted their narrow contracts, including explicit
identity expectations rather than only browser/Worker agreement. Some negative
cases checked status alone. They missed stream failure/cleanup, most validators,
recovery policy, source budgets, storage/routing, and almost all UI behavior in
unit coverage. Question-request lines were already 90.19% covered, but timeout
and failure paths were among the missing lines. **No genuine existing
application bug was confirmed.** Stale tests are not application defects.

The [initial Windows assessment](rounds/initial/assessment.md) links exact logs,
structured diagnostics, per-file coverage, and test/configuration snapshots.
The original Linux evidence remains intact and is not mixed into the new
machine's before/after comparisons.

## 3. Iterative Test Improvement

**Round 1: request boundaries and current output contracts.** The
[instruction](rounds/round-1/instructions.md) used the initial measured gaps.
A representative excerpt was: “Add tests for all three bounded input readers
... actual bytes over dishonest Content-Length, stalled/erroring streams,
the shared 10-second read deadline, cancellation that never settles, and
released stream locks.”

The agent added 34 request/stream/upload cases and 48 output-validation cases.
They use real Web Requests/streams and fake clocks; check byte limits on both
sides of a boundary; verify a fixed PDF hash; distinguish Unicode code points
from UTF-16 units; and accept ordinary prose and nullable fields without
citations. Legacy envelopes remain acceptable, while newly supplied unverified
quotes are discarded. Metadata and browser oracles were aligned with current
requirements without removing field, persistence, cache, or saved-quote checks.

All 106 unit tests passed on the first focused run and in the full baseline.
Line coverage rose to 301/2444 (12.31%). The metadata verifier passed all three
scenarios, including intentional field mismatch. The full run passed 18/19
stages but encountered a different browser timeout at persisted-library refresh,
before the repaired summary assertion. That failure was retained.

A separate clean-control experiment applied five hand-selected regressions in
disposable source/test copies. Round 1 detected exact-upload-limit rejection
and refusal of ordinary summary prose. Lossy question decoding, network-error
retry, and a one-byte-excess source budget survived. In particular, the UTF-8
fixtures were also invalid JSON, so they could pass for the wrong reason even
though question-request line coverage had reached 100%.

**Round 2: recovery and source selection, plus the surviving UTF-8 fault.** The
[second instruction](rounds/round-2/instructions.md) explicitly used those
results, including the surviving faults and zero coverage of recovery/source
selection. Its direction was to “test the shared generation-recovery state
machine and metadata/summary source selection” and place invalid bytes
“inside otherwise valid JSON strings.”

The agent added 27 recovery tests, 20 source-selection tests, and 10 UTF-8
integrity cases. These check a shared deadline and remaining correction budget,
two-attempt limits, ownership checks, nonretryable failures, sanitized errors,
24,000-byte metadata and 98,304-byte summary budgets, whole Unicode prefixes,
later-page omission, and unchanged original extraction. Correctly encoded U+FFFD
is a positive control, distinguishing invalid encoding from legitimate text.

The first focused invocation had a syntax error in the new UTF-8 test file:
one extra closing parenthesis prevented its 10 cases from loading. The other
153 tests passed. Removing that parenthesis gave 163/163 passing tests; the
failed file and both results are preserved. No product change was made to
resolve this test-authoring error.

An unchanged browser rerun reproduced the refresh timeout. A subsequent
instrumented run showed HTTP 200 and one saved paper directly from the Worker,
but a timeout for the same GET through Vite. Browser refresh requests also
aborted without responses. This narrows the failure to the local proxy/runtime
path; its underlying cause remains unresolved. The final harness retains
metadata-only diagnostics, the same assertions, and the same timeout limits.

The complete [round-1 assessment](rounds/round-1/assessment.md) and
[round-2 assessment](rounds/round-2/assessment.md) distinguish official
comparison runs from focused development and browser diagnostics.

## 4. Final Evaluation

The final full evaluation preserves 163/163 passing tests and 18/19 passing
stages. Its aggregate exit is 1 because the browser stage fails during page
readiness after refresh (`browser refresh`), slightly earlier than the round-1
record wait. The captured direct Worker GET still returns HTTP 200 with one
paper; the corresponding Vite-proxied GET times out. Later browser scenarios,
including the repaired generation/quote assertions, are not counted as
validated by this final run.

| Measure | Initial | Round 1 | Final (round 2) |
|---|---:|---:|---:|
| Passing unit tests | 24/24 | 106/106 | 163/163 |
| Passing baseline stages | 17/19 | 18/19 | 18/19 |
| Statements | 91/2960 (3.07%) | 364/2960 (12.29%) | 470/2960 (15.87%) |
| Branches | 64/2595 (2.46%) | 263/2595 (10.13%) | 317/2595 (12.21%) |
| Functions | 13/533 (2.43%) | 67/533 (12.57%) | 82/533 (15.38%) |
| Lines | 86/2444 (3.51%) | 301/2444 (12.31%) | 394/2444 (16.12%) |
| Selected seeded faults detected | Not measured | 2/5 | 5/5 |
| Confirmed existing application bugs | 0 | 0 | 0 |

The final isolated control passes all 163 tests. The same five faults are all
detected: exact-upload-limit rejection (1 failing test), lossy question UTF-8
decoding (4), nonretryable generation retry (13), excess summary-source budget
(5), and refusal of plain summary prose (5). These failures occur only in the
mutated disposable copies. The unmodified suite passes.

Targeted final line/branch coverage is 94.44%/100% for generation recovery,
100%/100% for both source selectors, and 100%/93.93% for question requests.
The unchanged request line percentage, alongside the now-detected UTF-8
mutation, demonstrates improved assertion strength without extra line coverage.

Coverage uses unchanged Vitest 5.1.0/V8 configuration and includes all
`src/**/*.ts(x)`, excluding declaration files, type-only `*-types.ts`, and two
local diagnostic probe modules. Untouched UI/Worker code remains in the
denominator. Legacy workerd and browser execution is **not** folded into Node
unit coverage. The [machine-readable comparison](comparison.json) and
[all-file comparison table](per-file-comparison.csv) preserve covered counts,
totals, percentages, stage outcomes, commands, and profile samples.

The useful improvements were explicit negative-path assertions, accepted and
rejected boundary pairs, native stream cleanup checks, current contract
examples, and feedback from surviving faults. Merely reaching every line did
not guarantee a strong UTF-8 oracle. More timeout waiting also would not
establish a product failure's cause; the browser transport diagnostics were
more informative than assuming either a product bug or an environment excuse.

No existing application defect is confirmed. Corrected stale verifier
expectations, an agent-generated syntax error, synthetic mutation detections,
and the observed unresolved local integration timeout are separate categories.
The five selected probes are not a comprehensive mutation score and do not
establish the suite's effectiveness against arbitrary faults.

Important limits remain: overall coverage is still low; UI, routing, storage,
and provider adapter modules are mostly unmeasured by the unit suite. Existing
offline integration checks provide additional evidence but not a merged
coverage percentage. Fake-time recovery tests check the helper's budget
accounting; provider adapters must still enforce their supplied I/O timeouts.
No live model output quality, hosted behavior, production load, OCR, or real
network reliability is established. The unresolved Vite-path timeout limits
end-to-end confidence, and scenarios after a failed browser wait are not
counted as passed.

All three runs retain their CPU profiles and seven-batch pure-function
measurements for `canonicalArxivLink` and `selectSummarySource`. These exclude
provider, storage, browser and workerd latency. Stage wall times include setup
and harness overhead. With unchanged application source and variable local
load/JIT state, the observations do not establish a speedup or performance
regression; process memory samples are not peak app memory. Observed median
milliseconds/call were:

| Workload | Initial | Round 1 | Final |
|---|---:|---:|---:|
| `canonicalArxivLink` (20,000 calls/batch) | 0.000716 | 0.000722 | 0.000760 |
| `selectSummarySource` (100 calls/batch) | 2.095886 | 2.487174 | 2.164804 |

## 5. Reflection

The agent understood pure-function contracts and generated useful boundary,
Unicode, and error-path cases. It benefited from the user's warning about the
stale metadata version and optional citations: copying older quote-matching
assertions would have tested a superseded requirement. Current README/source
contracts and actual failure diagnostics were more reliable than historical
labels such as “source-grounded.”

The work also demonstrates limitations. The first malformed-UTF-8 fixtures
did not isolate decoding from JSON parsing, despite achieving full line
coverage. The second round contained a test syntax error. Browser timing and
proxy failures needed runtime evidence that source inspection alone could not
provide, and the investigation did not establish a complete root cause.
Passing tests therefore justify only their exercised contracts, not general
product correctness or generated-answer factual accuracy.

The valuable feedback loop was concrete: measured gaps selected the first
round; actual surviving faults and remaining uncovered modules selected the
second. Preserving failed runs prevented retrospective selection of only
successful evidence. Accepted-boundary controls made negative assertions
more meaningful, and the independent fixed PDF hash avoided a circular oracle.

Significant human input consisted of the scoped task, the citation/version
warning, and the exact six-section PDF rubric. The agent performed the test
and verifier edits, corrected its own syntax error, and added diagnostic
instrumentation. No user-written test edits or independent human audit are
claimed. The author should review this reflection and add their own learning
before exporting the final PDF; these observations are agent-authored.

## 6. GitHub Repository

Repository: [panappin/babyScholar](https://github.com/panappin/babyScholar).
HW2 branch: [hw2/initial-baseline](https://github.com/panappin/babyScholar/tree/hw2/initial-baseline).
The final generated suite is in `tests/baseline/` (seven files, 163 tests).
Existing integration/browser scripts remain in `scripts/`. Exact round
instructions, snapshots, results, diagnostics and coverage are under
`docs/hw2/rounds/`; timestamped raw runs and full HTML reports remain locally
under ignored `artifacts/baseline/`.

Use Node >=22.12. This comparison used Node v24.11.1, npm 11.6.2, Windows x64,
and an Intel i9-13900HX (32 logical CPUs). From the repository root:

```powershell
git switch hw2/initial-baseline
npm.cmd ci
npm.cmd test
npm.cmd run test:coverage
npm.cmd run baseline
```

On macOS/Linux use `npm` in place of `npm.cmd`. The legacy browser verifier
only discovers two Windows Chrome/Edge locations, so full-browser results on
other environments cannot be assumed. `test:coverage` writes
`coverage/baseline/index.html` and machine-readable reports. `baseline` archives
each run separately, continues after a failed stage, and exits nonzero if any
stage fails; inspect `results.json` and the corresponding log.

To verify the committed three-round evidence and regenerate its comparison:

```powershell
node scripts/baseline/compare-hw2.mjs
```

To repeat the selected final fault probes without modifying working source:

```powershell
node scripts/baseline/fault-probes.mjs round-2
```

The code and evidence are committed on the HW2 branch. This work does not
merge into `main` or submit the assignment. PDF export and submission remain
the author's responsibility after reviewing the report and the deadline.
