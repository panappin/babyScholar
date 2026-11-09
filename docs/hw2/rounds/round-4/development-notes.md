# Actual round-4 execution feedback

These notes are a retrospective execution record. They do not impersonate
additional user prompts. Exact external instructions and the agent's recorded
guidance are in [instructions.md](instructions.md) and [user-request.txt](user-request.txt).

## Verified starting point

Branch and remote both pointed to `69c2eff`. The tracked tree was clean.
The hosting ZIP/directory and `docs/hw2/report.zip` were untracked and preserved.
The existing PDF, editable report and verification records were copied into
this round before editing. The archived round-3 baseline has 19 passed stages.
`npm ci` passed and a new unchanged coverage run reproduced all 260 passing
tests and exactly 1360/2444 covered lines (55.64%). The four provider files and
three generation handlers each had zero measured coverage. Older integration
scripts still exercise them separately; zero here did not mean never tested.

## Probe hypotheses

The first 24 focused tests passed 21 and failed three assertions, establishing
two defects: a body-read deadline gap and null-envelope misclassification.
The same 24 passed after the narrow product fix. See [probe-bugs.md](probe-bugs.md).
The product change was committed separately as `5285152`; tests were still
uncommitted at that point and their exact versions are in command snapshots.

## Provider adapters

The first provider run passed 98 cases across metadata, summary and question.
These assert explicit request shape and source context, loopback sentinel
credentials, safe HTTP classification, refusals and incomplete responses,
streamed Unicode, exact response-byte limits, oversized-stream cancellation,
transport failure and deadlines before headers and during bodies. Ordinary
summary/answer prose without citations is deliberately accepted.

The focused typecheck found an important test defect: `it.each([[0xff], ...])`
spreads tuple elements. The callback's supposed byte array was a number, so
`new Uint8Array(insertion)` generated NUL bytes, which JSON parsing would reject
even under lossy UTF-8 decoding. Named objects now carry the exact byte arrays.
A structural positive control verifies that lossy decoding would yield valid
JSON. The correctly encoded U+FFFD positive case remains accepted. This is a
test correction, not a newly discovered provider product bug. Other typecheck
corrections were explicit typing of unknown JSON and importing Node's URL type
for filesystem URLs rather than mixing Worker and Node ambient URL types.

Metadata and summary use replacement UTF-8 decoding; question uses fatal
decoding. Valid split Unicode and byte limits are tested for all three, while
the strict-invalid-UTF-8 oracle applies to question. This pass does not impose
a new shared decoder policy or count the asymmetry as a confirmed defect.

## Orchestration

The tests call the actual three public generation handlers, their providers,
source selection and validation. A small D1-shaped adapter executes the real
SQL and repository migrations in fresh Node in-memory SQLite. Only the storage
binding and fetch boundary are substituted. R2 is an access-rejecting sentinel:
these workflows must use persisted extraction rather than re-read the PDF.
This approach exercises SQL/provenance/claim behavior but does not reproduce
Cloudflare D1's distributed concurrency, workerd or deployment behavior.

The first run passed 69/71. Two incorrect tests were fixed:

- The question path fingerprints extraction using asynchronous WebCrypto before
  starting its provider deadline. Advancing fake time before that boundary
  left the request pending. A fixture `started` promise now synchronizes on
  provider dispatch before advancing 25 seconds. No production timeout changed.
- A cache test supplied outer whitespace, but the existing request contract
  requires an already-trimmed question. It now varies internal whitespace to
  test normalized cache identity, then changes extraction provenance to verify
  cache invalidation. Existing outer-whitespace rejection tests remain intact.

Nine further cases check ownership before provider dispatch, preserved error
classification when best-effort cleanup fails, and safe reads of corrupt saved
JSON. The corrected handler file passes all 80 cases. Success cases independently
assert saved output/provenance, one provider call, cache reuse without a key,
read-only GET, empty claim tables, and unchanged extracted source. Failure cases
assert caller status/kind, no invalid persisted result, and claim ownership.

## Evaluation checkpoints

The first combined run passed 462 tests (260 prior + 24 probe + 98 provider +
80 handler cases), reaching 2053/2445 lines (83.96%). This run preceded the
four UTF-8 fixture corrections and is preserved as an intermediate result,
not presented as the final assertion-quality check. Subsequent results and
the final baseline are indexed in the round assessment and development index.

The Vitest/V8 version, coverage configuration and dependency lock remain
unchanged. The probe fix changes source denominators by +1 line, +2 statements
and +3 branches; function count is unchanged. No percentages are averaged.
Node's experimental SQLite warning is retained in logs and is not a failed
test. No provider credentials, live arXiv/OpenAI requests or paid calls are used.

## Oracle validation after the typecheck correction

The selected lossy-provider-decoding fault survived the first 98-case provider
suite. With the corrected explicit byte arrays, the same mutation failed all
four intended UTF-8 assertions. Both unmodified controls passed 98/98. The
corrected full suite still passes 462 tests with identical coverage counts.
This is direct evidence that coverage and passing counts alone missed a weak
oracle. It is one artificial fault studied across two test versions, not a
general mutation score or an additional existing product bug.
