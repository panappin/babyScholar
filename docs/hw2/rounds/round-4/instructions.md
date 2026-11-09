# Round 4 guidance recorded before implementation

The [verbatim user request](user-request.txt) is the external instruction.
The deadline clarification was: “Assume it is 10PM EST.” It was received on
November 8, 2026. The working cutoff is therefore November 9 at 03:00 UTC;
delivery must finish by 02:15 UTC to retain at least 45 minutes.

The following is the coding agent's implementation plan, not an invented user
prompt or interaction:

> First reproduce the 260-test coverage result under the existing lock and
> unchanged Vitest configuration. Exercise provider modules through their
> public functions with injected fetch, real Response/ReadableStream objects,
> and fake timers. Verify request intent, classifications, byte boundaries,
> stream cleanup, and safe errors. Reproduce the two probe hypotheses before
> any product edit. Keep any narrow confirmed fix in a separate commit.
>
> Prioritize orchestration guards, cached reads, provider failure propagation,
> and claim cleanup using controlled storage and provider boundaries. Do not
> claim SQL or deployed integration coverage from these isolated tests. Avoid
> duplicating the already covered generation-recovery state machine. Keep
> coverage configuration and dependency versions fixed. Preserve failed runs
> and their snapshots before corrections. Stop adding tests in time to rerun
> the full baseline, update the report, inspect the PDF, and publish the branch.

Attribution correction supplied in this request: **dot** suggested the arXiv
testing seams in round 3. Earlier archived records retain their original bytes;
the current report corrects the attribution without rewriting history.

The report must retain AI authorship disclosure and distinguish observable
session decisions from personal motives or experience that only the author
can supply. Name, course identifiers, and personal reflection need author
confirmation unless supported by existing assignment sources.

## Actual execution feedback and follow-up guidance

After the first provider typecheck, the agent found that Vitest spreads tuple
rows passed to `it.each`. Four intended byte-array cases instead passed only
their first number to `Uint8Array`, producing zero-filled buffers. Their green
result was a weak oracle. The subsequent guidance, recorded before the probe:

> Correct those rows to named objects containing explicit byte arrays. Prove
> that replacement decoding would produce valid JSON, and keep the positive
> correctly encoded replacement-character case. In isolated copies, disable
> fatal decoding in question-openai.ts and compare the original and corrected
> provider test files, with a passing control for each. Treat this single
> selected mutation only as evidence about this oracle, not a broad score.

The user also asked to track usage limits and then reported: “If you cant see
the exact usage, I have 80% left on the first Pro plan”. This is a user-reported
starting allowance, not an agent-readable live meter. Work is kept in tested
commit checkpoints; no exact remaining account quota is claimed.
