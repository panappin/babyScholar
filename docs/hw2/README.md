# HW2 baseline and guided test improvements

The initial assessment, two required guided rounds, and two additional workflow
and backend improvement rounds are retained here. Source stayed unchanged through round 2;
round 3 confirms and fixes one narrow save-reconciliation bug; round 4 adds
provider/SQL orchestration tests and fixes two local probe defects. Existing
integration/browser checks remain separate from combined Node/jsdom coverage.

- [Six-section editable report](report.md), [PDF](report.pdf), and [handoff checklist](final-pdf-checklist.md)
- [Verbatim user instructions and rubric clarification](improvement-request.md)
- [New Windows initial reproduction](rounds/initial/assessment.md)
- [Round 1: inputs and output contracts](rounds/round-1/assessment.md)
- [Round 2: recovery, source budgets, and UTF-8 fault feedback](rounds/round-2/assessment.md)
- [Round 3: React workflows, deterministic arXiv service, and browser diagnosis](rounds/round-3/assessment.md)
- [Round 4: provider contracts and document-generation orchestration](rounds/round-4/assessment.md)
- [Final bounded quality review: 15 cases and two oracle/fixture corrections](rounds/final-review/quality-review.md)
- [Final backend comparison](backend-comparison.json) and [all-file CSV](backend-per-file-comparison.csv)
- [Workflow comparison including the configuration bridge](workflow-comparison.json) and [all-file CSV](workflow-per-file-comparison.csv)
- [Machine-readable comparison](comparison.json) and [all-file coverage comparison](per-file-comparison.csv)

The historical [initial assessment](initial-assessment.md) and `evidence/`
directory are unchanged. Fair comparisons use the three new Windows runs,
whose complete selected evidence and exact snapshots are in `rounds/`.

## Reproduce

Node 24.11.1 is the verified runtime for the final suite, including its built-in
SQLite tests. The app manifest allows older versions, but those were not
validated for these new tests. Use `npm.cmd` instead of `npm` in PowerShell.

```sh
npm ci
npm run baseline
# Or individual parts:
npm test
npm run test:coverage
npm run test:workflows:types
npm run test:providers:types
npm run profile
```

`baseline` builds and typechecks, runs the documented existing offline checks
plus deletion, reset and metadata-verifier checks, executes the new unit suite
with coverage, then captures local CPU profiling. Every stage gets a separate
log and exit status. A failed stage does not suppress subsequent evidence; the
aggregate exits nonzero if any stage failed. Raw runs go to timestamped ignored
`artifacts/baseline/` directories. Supply a new destination with
`npm run baseline -- artifacts/baseline/my-run`. Do not reuse a destination if
you want to preserve its logs. No live arXiv or OpenAI checks, deployment,
production database access, or credentials are required.

For restricted Linux workspaces where Wrangler cannot write to the default
home config directory, use an allowed writable config location, e.g.:
`XDG_CONFIG_HOME=/tmp/babyscholar-config npm run baseline`.
This changes only the test invocation's config location, not the application.
The pre-existing browser verifier only discovers Chrome/Edge in two Windows
installation paths. A failure to discover a browser on Linux is not evidence
that the app's UI is broken.

## Evidence and metric interpretation

- `results.json`: base commit, source tree hash, dirty worktree at invocation,
  runtime/machine, exact stage commands, exits and wall times.
- `coverage/baseline/index.html`, `lcov.info`, `coverage-final.json`, and
  `coverage-summary.json`: source-level generated-unit-suite coverage, also archived in each run's
  `coverage/` subdirectory. The
  denominator includes all `src/**/*.ts(x)`, including untouched UI and Worker
  modules, except declaration files, type-only `*-types.ts` and the two local
  diagnostic probe modules. CSS, scripts, fixtures and generated bindings are
  outside this denominator. Zero coverage means not exercised by **this suite**,
  not necessarily absent from the legacy checks.
- Pinned Vitest 5.1 / V8 uses source-aware coverage remapping. All-source
  function/branch denominators include unimported code. Do not compare these
  numbers to an older Vitest coverage engine without rerunning both suites.
  No coverage is claimed for workerd subprocesses or the actual browser from
  this Node unit runner.
- `profile.json`: seven post-warmup batches for two fixed pure-function
  workloads, with iterations and ms/call distribution. `baseline.cpuprofile`
  can be loaded in Chrome DevTools Performance or a compatible CPU-profile
  viewer. It includes Node startup and benchmark machinery; it is not a
  production server profile. The JSON memory sample is process memory after
  benchmarking, not peak app RSS. Stage wall times include process/build/
  harness startup and must not be called endpoint latency.
- Later comparisons should use the same source denominator, fixture sizes,
  commands and machine. CPU numbers vary with load and JIT state; no speedup
  or performance regression is established by this single baseline.

## Initial test design / correctness review

The 24 generated tests cover browser/Worker arXiv identity consistency, version
handling, unsafe-link rejection, cross-paper mismatch, and request shape,
content type, whitespace/cache identity and UTF-8 size constraints. Expected
results are explicit rather than copied from the function under test.

Contract sources: README's paper/library behavior and existing validation
contracts in `paper-identity.ts`, `arxiv-identity.ts`, `question-request.ts`.
Review includes accepted legacy identifiers, exact byte boundary, and multibyte
input. Browser and Worker agreement alone is not the oracle: each must equal
an independent expected base ID. The suite makes **no** unsupported assumption
that generated summaries or answers require citations or quote matching.

Passing these tests establishes only those cases. No mutation score is
reported and no genuine product defect is claimed without a failing
requirement-based reproduction. Existing check failures must be triaged as
product, test, or environment failures, not all counted as detected bugs.

## Reproduce and inspect the guided rounds

The round-2 suite is seven files / 163 tests in `tests/baseline/`. The initial
24 tests described above remain unchanged. Round 1 adds 82 cases; round 2 adds
57, selected after inspecting round 1's results and surviving seeded faults.

Round 3 adds 97 cases: 37 arXiv service tests, 22 App workflows and 38 document
workflows. That round's suite has 260 tests in 10 files (200 Node, 60 jsdom).
The unchanged 163-test suite was measured under the new TSX/DOM configuration
before these additions, reproducing its prior counts exactly. Round-3
line coverage is 55.64% (1360/2444), with all untested source still included.
Statement/function denominators increase by one because of the documented
App fix. The old comparison files remain unchanged; use the workflow
comparison for the extension.

Eight selected new workflow faults improved from 7/8 to 8/8 detections after
adding a missing download boundary pair. The original five seeds also remain
detected in the round-3 260-test suite. These are selected probes, not an
exhaustive mutation score or existing bugs. Browser preview mode passed the
complete workflow verifier; intermittent development-server readiness stalls
remain a separate limitation. See the report for the final baseline outcome.

Round 4 adds 202 tests: 24 probe, 98 provider adapter and 80 generation-handler
cases. The final 462-test suite measures 2053/2445 lines (83.96%) with identical
Vitest configuration and dependency lock. The narrow probe fixes add one line,
two statements and three branches. The handlers execute real migration schemas
and SQL under a small D1-shaped adapter over Node in-memory SQLite; this is not
Cloudflare D1 emulation. A selected lossy provider decoder fault survived the
first provider tests and failed four assertions after a fixture correction,
with unchanged coverage. Two confirmed probe defects are distinct from that
artificial fault and the earlier App bug. The arXiv seam suggestion came from
**dot**; historical archives retain the original attribution and bytes.

Each `rounds/<phase>/evidence/` directory contains `results.json`, all stage
logs, per-file CSV, raw coverage JSON, LCOV, CPU profile, structured verifier
diagnostics, and exact test/configuration/verifier snapshots. `archive.json`
records the original timestamped raw run and SHA-256 hashes. Git attributes
preserve archive bytes across platforms; the coverage archive is explicitly
exempted from the ordinary generated-coverage ignore rule.

```sh
node scripts/baseline/compare-hw2.mjs
node scripts/baseline/compare-workflows.mjs
node scripts/baseline/compare-backends.mjs
# Optional selected fault probes in disposable copies; no working source edits:
node scripts/baseline/fault-probes.mjs round-4
node scripts/baseline/workflow-fault-probes.mjs refined
node scripts/baseline/provider-utf8-probe.mjs
# Separate built-app browser mode (normal baseline still uses the dev server):
npm run build:frontend
node scripts/baseline/browser-experiment.mjs preview
```

The original three-round comparison validates archive hashes and identical source-tree
identities, denominators, dependency/configuration snapshots, stage commands,
profile workloads, and runtime/machine metadata. Fault probes are five selected
synthetic regressions, not discovered product defects or an exhaustive mutation
score. Detailed outcomes and limitations are in the report.

The recording helper `node scripts/baseline/archive-hw2.mjs <phase>
<timestamped-run-path>` was used once per phase immediately after evaluation.
It deliberately refuses to overwrite an existing phase archive.
Future `npm run baseline` invocations still create new timestamped raw runs;
keep the historical archives intact. Their snapshots preserve the earlier
suites if a reviewer wants to replay a prior round separately.

The final quality pass reviewed 15 representative cases and corrected two
bounded weaknesses in four existing cases; it did not add a coverage round or
change product code or dependencies. The author's revised report, personal
reflection and independent terminal-baseline evidence are preserved in
`rounds/final-review/`. The editable report includes the verified name/course,
dependency audit and exact regression-test/fix references. PDF generation and
verification details are in the review checklist. The author reviews and
submits the assignment; no merge to `main` is performed.
