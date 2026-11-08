# Initial assessment: November 8, 2026

Application baseline: `e72a5f460ebcc8704002c9f24c90c2d14bf86f16`. Source tree:
`2b735d17bc59c5e714dee91c837f05ead0a5d30d`. No application source was changed. Evaluation code and
new tests were present as uncommitted changes during measurement; exact dirty
paths and commands are in [results.json](evidence/results.json). This document
and its evidence are committed alongside the evaluated harness.

Environment: Node v24.22.1, linux/x64,
AMD EPYC 9V74 80-Core Processor, 9 logical CPUs. Wrangler config was routed
to a writable temporary directory. This is not a measurement on the user's
Windows laptop or a deployed Cloudflare service.

## Executive assessment

- New generated initial suite: **24/24 tests pass**, two files. This establishes
  a small, deliberately explicit baseline, not broad product confidence.
- Build, all three production typechecks, and main offline backend checks pass.
- The aggregate run remains **nonzero**: two legacy checks fail. One is a
  stale test oracle; the other is unavailable browser infrastructure.
- **No product defect confirmed.** A passing suite is not proof there are none.
- Final runtime dependency audit reports no vulnerabilities; the full tooling
  audit reports **4 high + 4 moderate**, zero critical. These are existing
  Drizzle/Wrangler dependency chains, not the new Vitest dependency chain.
  Audit results are advisory-database snapshots, not an exploitability finding.
  No automatic dependency remediation was performed on application tooling.
- No live provider, deployed app, real browser flow, production load, or
  user-perceived latency was evaluated.

## Existing checks and harness timing

| Stage | Result | Wall seconds |
|---|---|---:|
| build | passed | 8.026 |
| papers | passed | 1.404 |
| integrations | passed | 1.461 |
| question-text | passed | 0.477 |
| document-details-timeout | passed | 0.306 |
| library | passed | 20.593 |
| document | passed | 20.591 |
| document-delete | passed | 1.456 |
| extraction | passed | 10.793 |
| metadata | passed | 11.858 |
| summary | passed | 37.579 |
| question | passed | 45.596 |
| metadata-live-verifier | failed | 5.070 |
| local-reset | passed | 3.028 |
| frontend-search-browser | failed | 0.064 |
| sites-artifact | passed | 0.118 |
| generated-suite-coverage | passed | 1.098 |
| profile-prepare | passed | 1.104 |
| profile | passed | 1.868 |

These are stage durations, not individual test counts or endpoint latencies.
Many existing scripts contain numerous assertions and disposable D1/R2
integration scenarios. See per-stage logs in [evidence](evidence/).

### Failure triage

1. `metadata-live-verifier` fails its offline-success expectation. Diagnostic
   rerun `node scripts/metadata-live-check.mjs --offline=success` confirms
   HTTP 200 and metadata prompt version `document-metadata-v4`, while
   `scripts/metadata-live-check.mjs:305` expects `document-metadata-v2`.
   This is a **stale test contract**, not evidence that metadata generation
   failed. The initial assessment preserves the failure for the improvement
   rounds. Diagnostic log and structured result are saved in evidence.
2. `frontend-search-browser` cannot find a supported executable. The existing
   verifier only checks two Windows Chrome/Edge paths; this run is Linux.
   UI behavior is **not evaluated**, rather than proven faulty.

The first exploratory invocation also failed because Wrangler could not write
its default home config. That environmental setup issue was resolved by setting
`XDG_CONFIG_HOME`; the table is the later complete final invocation, not a
mixture of the failed setup and successful runs.

## Source coverage: generated suite only

Pinned Vitest 5.1.0 / V8; explicit all-source denominator described in the
[reproduction guide](README.md). Legacy workerd/browser checks are not merged.

| Metric | Covered / total | Percent |
|---|---:|---:|
| statements | 91/2960 | 3.07% |
| branches | 64/2595 | 2.46% |
| functions | 13/533 | 2.43% |
| lines | 86/2444 | 3.51% |

Most UI, Worker routing, storage, generation, recovery and provider modules are
uncovered by the new unit suite. Their zero percentages do not negate the
separate integration checks. The next rounds should target actual uncovered
branches and correctness, not merely add duplicate happy-path assertions.
The preliminary Vitest 3 results were discarded after moving to the current
patched runner and its source-aware coverage mapping; they must not be used
for before/after claims.

## Profiling

Seven timed batches after warmup. Input: one fixed arXiv PDF URL, and a
20-page deterministic text extraction that exceeds the 96 KiB summary budget.

| Workload | Calls per batch | Median ms/call | Min–max ms/call |
|---|---:|---:|---:|
| canonicalArxivLink | 20000 | 0.000693 | 0.000589–0.001016 |
| selectSummarySource | 100 | 2.251926 | 2.063695–2.425156 |

The source-selection workload is substantially heavier than URL normalization
in this local benchmark. This does not establish a production bottleneck;
network/provider and storage times are excluded. Raw CPU samples are in
[baseline.cpuprofile](evidence/baseline.cpuprofile), with the full batch results
and process memory sample in [profile.json](evidence/profile.json).
Do not infer user-facing speed, peak memory, throughput or scalability from
these two workloads.

## Test correctness and fault-detection conclusion

The initial generated tests use explicit requirements/oracles for identity,
unsafe links, request format, cache normalization and byte limits. Manual
review found no unsupported citation/quote requirement in the new tests.
They found no confirmed application bug in their small scope. Evaluating the
pre-existing verifier exposed one concrete stale oracle, documented above.
This is valuable test-correctness evidence but must not be counted as an
application bug or a mutation score. Two guided improvement rounds and the
final six-section homework report are still outstanding.
