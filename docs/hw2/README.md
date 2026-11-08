# HW2 initial baseline

This is the **initial assessment**, not either of the two required improvement
rounds. Application source is unchanged. The existing checks are preserved and
reported separately from the newly generated initial unit suite.

## Reproduce

Node >=22.12; use `npm.cmd` instead of `npm` in Windows PowerShell.

```sh
npm ci
npm run baseline
# Or individual parts:
npm test
npm run test:coverage
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

## Next improvement rounds (not performed here)

1. Expand requirement-driven boundary/negative cases and review test
   correctness, especially streaming request failure/timeout paths and
   validators. Save the actual prompt, results and reasoning.
2. Use measured gaps to add recovery/timeouts, summary-source Unicode budgets,
   and integration/UI coverage where the environment supports it. Re-evaluate
   with the same measures and retain evidence before/after each round.

A final homework report still needs the two distinct guided rounds and the
required six-section write-up. This baseline is not a completed submission.
