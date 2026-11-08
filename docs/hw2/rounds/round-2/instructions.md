# Round 2: recovery, source budgets, and a surviving UTF-8 fault

Recorded after the complete round-1 baseline and its isolated fault probes.

## Actual feedback supplied

- Round 1: 106 passing tests, 301/2444 lines (12.31%), 263/2595 branches
  (10.13%). All-source denominators are identical to the initial run.
- Request and output validation now have strong execution coverage, but
  `generation-recovery.ts`, `metadata-source.ts`, and `summary-source.ts`
  remain at zero lines. Continuing only with validator happy paths would miss
  materially different recovery and source-preservation behavior.
- Three of five seeded regressions survive: lossy UTF-8 question decoding,
  network-error retry, and a summary source budget one byte too large.
- The UTF-8 survivor occurs despite `question-request.ts` having 100% line
  coverage: the round-1 invalid-byte fixtures are also invalid JSON.
- Metadata verifier scenarios pass. The browser stage fails earlier than the
  repaired assertions, at persisted-library refresh, with a timeout alert.
  That scenario passed initially, so its cause remains unresolved.

## Exact round instruction (agent self-guidance)

```text
Make the second improvement distinct: test the shared generation-recovery state
machine and metadata/summary source selection that remain uncovered after round
1. Use fake time to assert one overall deadline, remaining budget passed to a
second attempt, a maximum of two attempts, owner checks, stage-specific invalid
output recovery, and no retries for transport/auth/quota/refusal/upstream errors.
Verify that diagnostics and terminal errors do not echo provider content.
For source selection, use independently specified pages and literal 24000-byte
metadata / 98304-byte summary budgets. Cover all-page versus first-three-page
selection, exact limits, one-byte overflow, complete Unicode prefixes, omission
of later pages, empty inputs, page ranges, and unchanged original extraction.
Repair the demonstrated weak UTF-8 test oracle by placing invalid byte sequences
inside otherwise valid JSON strings, with valid Unicode positive controls. This
must reject lossy decoding rather than accidentally testing only JSON syntax.
Investigate the round-1 browser timeout with a separately logged unchanged
verifier rerun before considering further harness changes; do not remove the
refresh assertion or silently replace the failed round-1 result with a retry.
If it recurs, collect concrete diagnostics; do not label it a product defect
or assert an environment root cause without evidence.
Keep app source, dependency versions, Vitest scope and baseline stage commands
unchanged. Record every development failure and correction. Run the full same
npm.cmd run baseline evaluation and archive round 2, then repeat the same five
isolated fault probes. Report surviving gaps and limitations honestly.
```
