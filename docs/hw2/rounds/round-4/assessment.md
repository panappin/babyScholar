# Round 4: provider contracts and document-generation orchestration

Started on `hw2/initial-baseline` at `69c2eff`, November 8, 2026, 6:35:37 PM EST.
The confirmed submission cutoff is 10 PM EST; delivery is bounded to finish
by 9:15 PM. Exploration ended once the targeted behavior, corrected oracles,
coverage and typechecks passed. No work on main or assignment submission.

- [Exact external request](user-request.txt), [recorded guidance and feedback](instructions.md), [time record](session.json)
- [Actual failures and corrections](development-notes.md)
- [Two confirmed probe defects](probe-bugs.md)
- [Development run index](development/index.json)
- [Final baseline results](evidence/results.json) and [all-file coverage](evidence/per-file-coverage.csv)
- [Comparative raw counts](../../backend-comparison.json) and [per-file CSV](../../backend-per-file-comparison.csv)

## Results and scope

The unchanged preflight reproduced 260/260 tests and 1360/2444 lines, matching
round 3 exactly. The final suite contains **462 tests in 13 files**: 402 Node
tests and 60 React/jsdom cases. The 202 new cases comprise 24 probe, 98 provider
adapter and 80 orchestration tests. Full baseline: **19/19 stages passed (aggregate exit 0)**.

| Metric | Round 3 / preflight | Round 4 final |
|---|---:|---:|
| Statements | 1572/2961 (53.09%) | 2380/2963 (80.32%) |
| Branches | 1335/2595 (51.44%) | 2032/2598 (78.21%) |
| Functions | 305/534 (57.11%) | 427/534 (79.96%) |
| Lines | 1360/2444 (55.64%) | 2053/2445 (83.96%) |

Vitest/V8 5.1.0, dependency lock and coverage configuration are unchanged.
The two probe fixes add one measured line, two statements and three branches;
function count is unchanged. All-source scope still includes untested code.
Actual browser/workerd execution does not contribute to these percentages.

| Target file | Prior covered lines | Final covered lines |
|---|---:|---:|
| metadata-openai.ts | 0/98 | 98/98 |
| summary-openai.ts | 0/98 | 98/98 |
| question-openai.ts | 0/110 | 109/110 |
| openai.ts | 0/61 | 62/62 |
| document-metadata.ts | 0/103 | 94/103 |
| document-summary.ts | 0/109 | 101/109 |
| document-questions.ts | 0/104 | 97/104 |

The handler tests execute actual migrations and SQL with Node's in-memory
SQLite via a small D1-shaped adapter. They verify persisted values, provenance,
claim ownership and cleanup, cached/read-only behavior, explicit retries and
caller error classifications. They do not establish Cloudflare D1 equivalence,
distributed race safety, R2 behavior or deployment correctness. No new runtime
or testing dependencies were installed; Node 24.11.1 supplies SQLite, whose
experimental warning is preserved. Both test typecheck commands pass.

## Correctness, real bugs and artificial faults

Both user-supplied hypotheses became confirmed probe defects through focused
pre-fix failures. The same tests pass after product commit `5285152`. The
body timeout fix assumes an AbortSignal-aware fetch implementation. Null JSON
previously escaped as a TypeError and was sanitized to the wrong network-failure
kind; the Worker did not crash. These defects affect the local connectivity
probe. The three generation providers already had body deadlines/null guards.
The earlier App save-feedback bug remains separately documented and fixed.

The new test/tooling commit is `89afbd3`. Tests were corrected for an invalid
outer-whitespace request and fake-clock advancement before asynchronous
fingerprinting. Typechecking exposed a weak UTF-8 fixture despite a green test
run. The single selected lossy-provider-decoding mutation survived the original
98-case file and failed four corrected assertions; both clean controls passed.
Coverage did not change. It is an artificial fault, not a fourth real bug.

Original selected fault reruns: **5/5 detected; 462-test clean control passed**.
Workflow selected fault reruns: **8/8 detected; 462-test clean control passed**.
All earlier results, including survivors, are preserved. These small deliberate
sets are not an exhaustive mutation score or an estimate of arbitrary defects.

Detailed final experiments: [original five](development/round-4-2026-11-08T23-53-09.593Z/results.json),
[eight workflows](development/2026-11-08T23-56-03.532Z-refined/results.json), and
[one provider oracle before/after](development/2026-11-08T23-45-35.339Z-provider-utf8/results.json).
The original faults triggered 1, 4, 29, 5 and 12 failing tests respectively;
the workflow faults triggered 2, 1, 3, 1, 1, 1, 1 and 1. These are assertion
counts, not additional discovered defects.

## Remaining limits and handoff

The prior normal and preview browser checks passed after stale harness fixes,
but earlier intermittent development-server stalls remain unexplained. This
round's normal browser outcome is recorded in the final baseline; it does not
prove that intermittency is resolved. No live provider quality, billing,
hosted authentication, production load or OCR claims are made.

The final baseline passed all 19 stages, including its normal development-mode
browser stage (121,292 ms). The coverage stage passed all 462 tests and exactly
matched the corrected standalone coverage run. The preserved timestamp is
`2026-11-08T23-46-17.167Z`, evaluated test commit `89afbd3`, source tree
`a4debbe9bb7d35edf18fae6cb2864bd42d60cd39`.

The revised six-section report corrects the arXiv suggestion attribution to
**dot**, includes the actual weak/strong UTF-8 examples and save-feedback
assertion/fix, and marks personal reflection and unverified author/course
details for author review. Earlier records retain their original bytes.
