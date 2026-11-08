# Round 3 development feedback and decisions

These are actual execution findings, not hypothetical agent interactions.
Timestamped command directories are archived under `development/`. The exact
user request and the pre-implementation self-instructions are separate files.

## Measurement bridge

The unchanged 163 tests passed in the new preflight, again with 18/19 baseline
stages. The browser failed at initial-page readiness, before any API traffic.
Direct Worker GET returned 200/zero papers; the Vite GET timed out. Child output
buffers were small. None of this establishes a product defect.

Pinned React Testing Library 16.3.3, DOM Testing Library 10.4.2, user-event
14.6.8, jest-dom 7.0.1, and jsdom 27.4.0 were installed. The latest jsdom engine
range did not support the installed Node 24.11.1, so 27.4.0 was selected by its
published engine requirement. Marked 18.1.3 supports the report renderer.
Vitest/V8 remain 5.1.0. Test discovery now includes TSX and automatic JSX;
individual TSX files opt into jsdom while all original tests remain in Node.
The source coverage include/exclude rules and commands are unchanged.

Before adding tests, the configuration bridge reran the frozen 163 cases.
All passed, with exactly 394/2444 lines, 470/2960 statements, 317/2595 branches,
and 82/533 functions. This supports comparing the expanded combined V8 run;
no frontend/backend percentages are averaged. The later product fix introduces
one arrow function/statement, changing those denominators to 534/2961; lines
remain 2444 and branches remain 2595. The exact snapshots expose this change.

## Test authoring corrections

- `arxiv-first`: 36/37 passed. The prefixed-Atom fixture supplied a bare legacy
  ID; `arxivIdentifier` expects the URL used by real Atom entries. Corrected
  the fixture to `https://arxiv.org/abs/hep-th/9901001v2`; all 37 then passed.
- `app-first`: 53/58 passed across App/arXiv. Four failures reproduce the one
  confirmed product bug documented in `product-bug.md`. The fifth was my
  incorrect button name (`Remove` versus `Remove from library`). The narrow
  identity fix and selector correction produced 58/58 passing cases.
- `documents-first`: 34/35 passed. I assumed an in-progress summary response
  automatically reconciled like a question response. The actual summary
  contract waits for an explicit reload. The revised test asserts one initial
  GET, no automatic extra GET/POST, then success on the explicit second GET.
  This correction changes the test to the product requirement, not vice versa.
- The first optional test typecheck combined Worker and browser ambient types
  and reported BufferSource conflicts in unchanged Worker code. It also caught
  unsupported `exact` properties in my role-query options. String role names
  already match exactly, so those options were removed. The dedicated config
  now typechecks the three new workflow files and their helpers; the existing
  build retains its separate production browser/Worker typechecks. This is
  explicitly narrower than claiming all legacy unit tests are typechecked.
- Review caught a test-isolation weakness: mutating static methods on the
  shared URL constructor. A temporary URL subclass is now stubbed and restored
  after each test. Unexpected boundary requests fail in afterEach even if the
  component catches their rejection. Abort-aware mocks cover real timeout
  paths; intentionally abort-ignoring deferred mocks exercise stale responses.

## Rationale recorded after the first expanded evaluation and fault experiment

The first expanded run passed 256 tests and covered 1360/2444 lines. The
actual `workflow-fault-probes.mjs first` invocation then evaluated eight
selected regressions: arXiv TTL boundary, returned-author-array sharing,
queue poisoning after a failure, stale library reads after save, stale document
details after selection, summary retention on failed reload, prepared URL
cleanup on selection, and the exact download-size boundary. The script writes
its selected mutations before running them. A clean control and failing
test names distinguish detections from tool failures. This paragraph is
a retrospective explanation, not a verbatim user prompt or invented interaction.

The first clean control passed 256 tests. Seven selected faults were detected;
`download-rejects-exact-limit` survived. Upload size checks did not cover the
separate downloaded-stream limit. The refinement therefore adds an exact
10 MiB download acceptance case paired with one-byte overflow, cancellation,
and no object URL on rejection. A stale pending download must also never
publish after selection changes. An App negative counterpart ensures a
different returned paper cannot falsely confirm an uncertain save. The
refined suite has 260 tests; line coverage remains 55.64%, while branch
coverage and fault detection improve. The second isolated experiment records
the actual outcome of each same seed separately.

## Browser experiments (bounded investigation)

The pipe-drain experiment retained all waits and assertions. It still failed
at initial readiness. Therefore unconsumed output is not an established cause.
The network diagnostic experiment reached real D1 save/refresh and mock PDF
flows, then failed on obsolete Q&A progress text: `Asking from ...` versus
the actual `Asking with ... as context`. Corrected only that expectation.

The next run passed real PDF upload/extraction/metadata/refresh/prepared
download and metadata-only retry. It then waited for an unconfigured metadata
failure on the summary fixture. Recorded metadata POST status was 201, no
error alert existed, and Worker, Vite API and Vite static probes all returned
200 through both fetch and fresh HTTP connections. Under the current contract,
unmatched optional quotes do not make metadata invalid. The corrected fixture
explicitly sets its offline provider to fail for that upload, then restores it;
the intended test still requires Q&A and summary generation without metadata.

The corrected normal-control run then reached an actual question POST, which
returned 502 while the loopback question call count stayed zero. The fixture
server still routed by removed summary/question JSON-schema names. Current
adapters send ordinary text requests and already use three distinct loopback
sentinel keys. The fixture now routes by those keys, retaining method/path,
authorization, input-array and `store: false` checks. This is a test-provider
repair, not a change to the real provider adapter or its output contract.

No readiness deadlines were extended. No application proxy or generation
behavior was changed. Earlier intermittent Vite/readiness stalls remain
distinct from these proven stale assertions; later passes alone would not
prove their root cause or guarantee stability. All browser/provider calls use
disposable local state and loopback providers; no live provider calls occur.

## Final verification

The final fresh-install baseline at `2026-11-08T22-53-27.521Z` passed all 19
stages, including the normal development-server browser and all 260 tests.
The separately recorded preview run also passed (111 logged steps, four
metadata fixture calls, one summary and one question call, zero live calls).
No workaround replaced the normal browser stage. Earlier intermittent stalls
remain unexplained; a passing final run does not establish their resolution.
The final original-five and new-eight fault controls each pass 260 tests and
detect every selected seed. The workflow typecheck also passes after npm ci.
