# Initial Windows reproduction

The preserved starting run is
`artifacts/baseline/2026-11-08T19-03-28.103Z`, on November 8, 2026.
Installation (`npm.cmd ci`) exited 0. `npm.cmd run baseline` exited 1:
17 stages passed and two verifier stages failed. All 24 initial unit tests
passed. This run precedes either improvement round.

| Metric | Covered / total | Percent |
|---|---:|---:|
| Statements | 91 / 2960 | 3.07% |
| Branches | 64 / 2595 | 2.46% |
| Functions | 13 / 533 | 2.43% |
| Lines | 86 / 2444 | 3.51% |

Node v24.11.1, npm 11.6.2, Windows x64, Intel i9-13900HX,
32 logical CPUs. Later rounds use this same machine, not the Linux machine
in the historical `initial-assessment.md`. The measured coverage happens to
match the historical run; comparisons below use only the new Windows runs.

## Actual failure triage

1. **Metadata verifier: stale test oracles.** The child diagnostic shows matching
   title, authors, year, abstract, PDF hash, and selected pages. It returns prompt
   `document-metadata-v4`; the verifier expects v2. Its four nonempty,
   source-matching evidence expectations also fail because current generation
   deliberately returns empty evidence arrays. The current README explicitly
   makes citations and quote matching optional. These are not product defects.
2. **Browser verifier: stale test oracle.** Chrome starts successfully and the
   earlier search/library scenarios execute. At line 812 the verifier waits
   for `Generating a source-grounded summary`, but current
   `DocumentWorkspace.tsx` sets `Generating a summary using saved PDF text...`.
   The 30-second wait expires. This is not the Linux browser-discovery failure
   in the historical assessment, and it does not establish an app timeout.
   Later browser scenarios were not reached in this initial run.

No genuine application bug was confirmed by this initial reproduction.
Malformed-response fixtures and deliberate provider failures in passing
offline checks are test scenarios, not observed production defects.

## Correctness and gaps

The initial 24 tests remain valid for identity, unsafe links, request shape,
cache normalization, and question byte limits. Some request rejection tests
only assert an HTTP status; the new rounds should assert the relevant error
kind and cleanup behavior too. Passing malformed UTF-8/JSON rejection tests
can also be ambiguous unless the rest of the JSON envelope is valid.

Most source modules remain untested by the unit suite. In particular,
library validation, generated summary/answer validation, generation recovery,
and source selection have zero line coverage. PDF validation is 10.66%,
metadata validation 9.52%, and question request handling 90.19%; its missing
lines nevertheless contain important timeout/failure paths. These measured
gaps guide the first instruction in [round 1](../round-1/instructions.md).

Evidence: [stage results](evidence/results.json),
[per-file coverage](evidence/per-file-coverage.csv),
[structured diagnostics index](evidence/diagnostics/index.json),
[exact starting tests and configuration](evidence/snapshot/), and
[installation result](setup/setup.json). Text copies of PowerShell setup and
development logs are transcoded to UTF-8 for review; their original raw files
remain under `artifacts/`. Baseline logs and coverage files are copied verbatim.
