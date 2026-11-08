# Round 3: workflows, arXiv resilience, and failure diagnosis

## Scope and provenance

The session started at 2026-11-08 22:15:29 UTC on `hw2/initial-baseline`, with
local and remote at `d66051c`. The user-requested five-hour ceiling and delivery
reserve are in [session.json](session.json). The unrelated hosting ZIP and
directory were not modified or added. The existing report was preserved as
[prior-report.md](prior-report.md); no existing report PDF was found in the
checkout. A new verified PDF accompanies the updated report.

- [Verbatim extension request](user-request.txt)
- [Pre-implementation instructions and the user's arXiv guidance](instructions.md)
- [Actual test-authoring failures and corrections](development-notes.md)
- [Confirmed existing save-reconciliation bug](product-bug.md)
- [Machine-readable development index](development/index.json)
- [Final full evaluation](evidence/results.json) and [all-file coverage](evidence/per-file-coverage.csv)

Product fix `852eb2c` is separate from test/tooling commit `2c83268`.
Source tree changed only from `2b735d17bc59c5e714dee91c837f05ead0a5d30d` to
`0ea6df465799f6defbb240b16b0e8abab7c906d8`: one App identity comparison.
No Worker, proxy, persistence, generation or citation policy changed.

## Evaluations and comparability

| Measurement | Tests | Lines | Statements | Branches | Functions |
|---|---:|---:|---:|---:|---:|
| Round 2 / fresh preflight | 163 passing | 394/2444 | 470/2960 | 317/2595 | 82/533 |
| Frozen-suite configuration bridge | 163 passing | 394/2444 | 470/2960 | 317/2595 | 82/533 |
| First workflow expansion | 256 passing | 1360/2444 | 1569/2961 | 1329/2595 | 305/534 |
| Feedback refinement | 260 passing | 1360/2444 | 1572/2961 | 1335/2595 | 305/534 |
| Final full baseline | 260 passing | 1360/2444 | 1572/2961 | 1335/2595 | 305/534 |

Final baseline status: **19/19 stages passed (aggregate exit 0)**. The fresh preflight passed
18/19 stages, failing at browser initial-page readiness. Each run preserved
its own timestamped results; earlier failures were never overwritten.

Vitest/V8 remains 5.1.0. All-source includes/excludes and the commands
`npm.cmd run test:coverage` / `npm.cmd run baseline` remain the same. The
configuration now discovers TSX and uses automatic JSX; individual React files
use jsdom while prior tests remain in Node. The bridge shows that this change
alone did not improve coverage. One combined V8 report instruments both
environments; browser/workerd subprocesses remain excluded. The App fix adds
one statement and function, so those denominators change. Lines and branches
are unchanged. No percentages are averaged. See the
[extension comparison](../../workflow-comparison.json) and
[per-file CSV](../../workflow-per-file-comparison.csv).

The new 97 cases comprise 37 arXiv, 22 App and 38 DocumentWorkspace tests. The
final totals are 200 Node and 60 jsdom tests. Dependency versions are locked;
the existing dependencies were not upgraded. The dedicated workflow typecheck
passes for the three new files and helpers. Production browser/Worker
typechecks remain separate in the build.

## Fault detection and test correctness

The eight workflow seeds are explicitly specified before their execution in
each results file. A clean control runs all tests, then each isolated mutant
runs its affected workflow file. The working source is hashed before/after.

| Selected new regression | First expansion | Final suite |
|---|---|---|
| Cache expires one tick late | Detected | Detected, 2 failing tests |
| Shared returned author array | Detected | Detected, 1 failing test |
| Failed request poisons the queue | Detected | Detected, 3 failing tests |
| Old library read erases new save | Detected | Detected, 1 failing test |
| Old document details replace selection | Detected | Detected, 1 failing test |
| Failed reload clears saved summary | Detected | Detected, 1 failing test |
| Selection leaks prepared object URL | Detected | Detected, 1 failing test |
| Download rejects exact 10 MiB limit | Survived | Detected, 1 failing test |

The boundary-pair refinement caught the survivor with no increase in line
coverage. The control grew from 256 to 260 passing tests. Detailed evidence:
[first experiment](development/2026-11-08T22-32-26.875Z-first/results.json),
[feedback experiment](development/2026-11-08T22-36-33.216Z-refined/results.json),
and [final committed-suite experiment](development/2026-11-08T22-51-54.638Z-refined/results.json).

The original five faults were also
[rerun against all 260 tests](development/round-3-2026-11-08T22-47-55.373Z/results.json):
all detected, with 1, 4, 13, 5 and 5 failing tests respectively. These two
selected sets do not constitute a repository-wide mutation score. The only
confirmed existing product defect is the independently reproduced App save
feedback bug; all seeds are artificial.

Assertions follow actual contracts. Ordinary prose and empty evidence arrays
are accepted. Older saved quotes remain readable. Missing metadata/summary
does not block Q&A when saved extraction exists. Destructive operations and
generation require explicit intent; unknown outcomes trigger read-only
reconciliation or explicit retry. The typecheck and source review corrected
test selector, fixture, isolation and summary-recovery mistakes rather than
changing product behavior to satisfy erroneous tests.

## Browser evidence, separated by failure class

| Run / mode | Observed outcome |
|---|---|
| Unchanged preflight, development | Initial page timeout; direct Worker succeeded, Vite GET timed out |
| Pipe drain experiment | Same early timeout; output buffering is not an established cause |
| Network diagnostics | Reached D1 save/refresh; stale Q&A progress-text assertion failed |
| Fresh HTTP diagnostics after text fix | Reached PDF processing; unconfigured metadata-failure expectation failed; fresh HTTP and fetch probes all passed |
| Normal control after explicit metadata failure | Actual question POST returned 502; fixture still routed by obsolete schema name |
| Provider routing corrected, normal mode | Intermittent initial-page timeout returned |
| Detailed development diagnostics | Failed during a later PDF page navigation; static/API requests failed through fetch and fresh HTTP, while Worker succeeded |
| Isolated Vite/module/proxy probe | All 21 requests passed without Chrome/CDP/Worker storage |
| Built-app preview, same browser assertions | Complete suite passed, including real local Q&A, summary, persistence, download and deletion |
| Final normal baseline | Passed, including all actual local PDF/Q&A/summary/delete flows |

All diagnostics and exact harness snapshots are linked from the development
index. The preview result is
[recorded separately](development/2026-11-08T22-46-33.647Z-browser-preview/diagnostic-1.json).
It forced download permission in its disposable browser profile. The normal
baseline continues to use development mode, so a preview pass is not silently
substituted for a failed normal stage. No readiness deadline was extended and
no production configuration was changed. Earlier development-server stalls
remain unexplained; the evidence does not establish an application defect.

## Limitations and delivery

The final suite still leaves about 44% of source lines unmeasured, especially
Worker routing, storage, adapters and parsing. jsdom lacks browser layout and
download behavior. Local fixtures cannot establish live model quality,
provider/network reliability, hosted access, OCR or production performance.
CPU profiles and wall times are retained without a speedup claim.

The six-section [editable report](../../report.md) and [PDF](../../report.pdf)
include these limits and concrete interaction examples. The reflection is
agent-authored for student review. Publication is to the HW2 branch only;
no merge to main or assignment submission is performed.
