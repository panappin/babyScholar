# Round 3: observable workflows and search-service resilience

Recorded November 8, 2026 before implementation. The verbatim user request is
in [user-request.txt](user-request.txt); the bounded session clock is in
[session.json](session.json). The starting report is preserved as
[prior-report.md](prior-report.md). No PDF was found in the existing checkout,
including ignored project artifact directories (excluding runtime fixture PDFs).

## Verified starting evidence and priorities

- Branch and remote both point to `d66051c`; unrelated untracked hosting ZIP
  and directory remain untouched. Existing initial/round-1/round-2 evidence is
  immutable and retained.
- Round 2: 163 passing unit tests, 394/2444 lines (16.12%). `App.tsx` has
  227 lines and `DocumentWorkspace.tsx` 580: together 807/2444 (33.02%) at zero
  Node-suite coverage. `arxiv.ts` is another 214 lines at zero. This does not
  mean these modules were never exercised by the separate legacy checks.
- Existing arXiv checks already cover basic Atom parsing, a cached query,
  one in-flight duplicate, spacing, and upstream errors. New cases should add
  cache expiration/eviction, mutation isolation, queue recovery, and more exact
  transport/parser boundaries rather than simply duplicate the script.
- Highest user-facing risks are an uncertain save being reconciled incorrectly,
  a stale response replacing the selected document, unexpected data producing a
  success state, accidental repeated generation, and losing saved results after
  a failed read. These guide assertions on visible results and network intent.

## Exact implementation instruction (agent self-guidance)

```text
Extend the existing 163-test suite with React component workflow tests and
arXiv service tests. Keep the production application unchanged unless an actual
requirement-based failure is reproduced; document any product fix distinctly.
Use Testing Library and a compatible pinned DOM environment for user-observable
interactions. Mock only the fetch/service boundary with explicit routing and
fail unexpected requests. Include saved-paper identity, uncertain-save GET
reconciliation without automatic POST retries, loading/empty/error/malformed
states, duplicate clicks, stale library/detail responses, explicit PDF
summary/question actions, retained results after failures, and cleanup.
Test arXiv cache expiry/eviction, independent returned data, equivalent query
identity, failure followed by recovery, queue progress, parser rejection,
response-size boundaries and timeout classification. Keep all services offline.
Preserve the existing V8 version and source inclusion/exclusion rules. Add TSX
discovery and the minimum JSX/DOM tooling needed, then rerun the frozen 163
tests under the new configuration before adding new tests. Save that bridge
measurement and explicitly disclose any denominator/configuration difference.
Never average frontend/backend percentages: use a single instrumented V8 run
if supported, and report its exact scope, per-file counts and limitations.
Use actual failures and seeded-fault survivors as feedback. Preserve failed
development attempts with their test snapshots. Treat DOM emulation as
component evidence, not a real-browser/Worker integration result.
```

## Browser investigation instruction

```text
First reproduce/characterize the inherited browser failure with one bounded
unchanged baseline. Then use controlled diagnostics to separate direct Worker,
Vite proxy/static serving, browser interception/navigation, and harness process
management. Do not relax assertions or extend waits simply to get green.
Change a harness/environment issue only with concrete evidence, retain the
original failure and the intervention, and run a meaningful verification.
Stop expanding this investigation after about one hour if it is not narrowing.
```

## Measurement and delivery instruction

```text
Preserve exact prompts, raw timestamped commands, failures, config/test snapshots,
coverage, and seeded-fault outcomes. Select a small, documented set of realistic
new-workflow regressions in isolated copies and run a clean control. Keep these
artificial faults distinct from existing product defects. Finish the full
evaluation, six-section editable report, verified PDF, integrity/link checks,
and commit/push to hw2/initial-baseline. Reserve at least 45 minutes before the
five-hour ceiling for delivery, do not submit the assignment, and do not merge
main. Flag the agent-authored reflection for the student's review.
```

Official tooling references consulted during setup:
[Vitest environments](https://vitest.dev/guide/environment.html),
[React Testing Library](https://testing-library.com/docs/react-testing-library/intro/),
and [user-event](https://testing-library.com/docs/user-event/intro/).
These explain the testing environment; application requirements come from the
repository's current contracts and observable workflows.

## Additional user guidance received during the preflight

```text
One useful addition for Codex: the arXiv search service has injectable fetch, clock, sleep, timeout, and response-size limits. That gives it a way to test Atom parsing, query normalization, upstream failures, request coalescing, and cache expiry deterministically without live arXiv calls. It can verify those seams in the code and use them where appropriate.
```

Verified these options in `ArxivSearchOptions` and `createArxivSearchService`;
tests will exercise the public service through these injected boundaries.
