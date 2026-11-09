# Bounded final test-quality review

This is a review of **15 selected concrete cases**, not a manual audit of all
462 cases or a new coverage-expansion round. The review began at 7:54 PM EST
on November 8; the maximum exploration budget was 45 minutes, with delivery
required before the 9:15 PM review/submission buffer. The tests were read
alongside their source contracts, fixture helpers and neighboring cases.
Exploration stopped at approximately 8:03 PM EST; subsequent work was limited
to evaluation, evidence preservation, report reconciliation and delivery.

## Findings and changes

Two clear weaknesses were corrected; neither establishes a product defect.

1. The question prompt fixture claimed pages 1–2 and 4, but actually supplied
   only page 1, a one-page byte count and an all-pages warning. The fixture now
   supplies all three listed pages with consistent metadata. Assertions check
   the page labels **and their actual text**, and reject extra page labels.
   This is a formatter-level supplied-excerpt contract, not a claim to exercise
   source selection or to reproduce its normal contiguous selection policy.
2. The persistence test threw before INSERT, so an empty table did not prove
   rollback. It now throws during claim release after INSERT, records that a
   row really existed at the failure point, then requires an empty result
   table, released claim, retained extraction and exactly one provider call.
   The shared test covers all three generation handlers. It exercises their
   atomic batch usage through SQLite; it does not validate distributed D1.

No genuinely redundant case was identified in this sample. No tests were
deleted. Acceptance/rejection boundary pairs and separate public error mapping
are necessary checks of different outcomes. Remaining limitations are noted
below rather than counted as bugs. No product source or dependency changed.

## Examined cases

Titles below identify the concrete parameter where a definition is shared.
All paths are under `tests/baseline/`.

| # | File and exact title / selected parameter | Contract, assertion, mock boundary and overlap assessment |
|---|---|---|
| 1 | `app-workflows.test.tsx`: `reconciles lost response with GET and shows a confirmed save without a contradictory error` | Actual App logic; HTTP boundary fake only. Disabled Saved button plus absence of alert and one POST/two GETs detect contradictory feedback and automatic retry. Other response variants enter the same recovery through distinct failures; no deletion justified. |
| 2 | `app-workflows.test.tsx`: `does not confirm an uncertain save when GET contains only a different paper` | Negative counterpart to #1: visible unconfirmed alert, enabled Save, no Saved button, one POST. Prevents a weak implementation that treats any nonempty library as confirmation. |
| 3 | `document-workspace.test.tsx`: `enforces the downloaded PDF byte boundary at 10 MiB plus 0 bytes` | Real component download reader and stream; object URL API stubbed. Requires exact blob size/type and usable link with no cancellation. Checks download preparation, not a filesystem save. Necessary acceptance half of #4. |
| 4 | Same file/title, `plus 1 bytes` | Dishonest Content-Length cannot bypass actual-byte limit. Requires visible error, exactly one cancellation, no object URL and no prepared link. Distinct rejection half; prior selected fault demonstrated the need for #3. |
| 5 | `openai-probe.test.ts`: `keeps the deadline active while consuming a stalled response body` | Injected fetch returns an actual stalled abort-aware stream. Fake-clock signal assertion, timeout classification, single request and cleared timer check the body deadline. Fixture finally releases its pending promise even on pre-fix failure. Does not claim to abort a noncooperating fetch. |
| 6 | `openai-probe.test.ts`: `propagates null JSON to the caller as malformed response, not network failure` | Calls the actual public error mapper after a real Response.json(null). Distinct from raw thrown-error type checks: verifies caller-facing classification. Does not exercise the Worker router. |
| 7 | `provider-adapters.test.ts`, metadata: `returns validated transport output and sends explicit non-stored source context` | Injected fetch captures URL, method, headers and JSON; exact returned metadata and schema, source placement, no tools, store:false and timer cleanup. Provider/model behavior is intentionally fake; no claim about generated content quality. Analogous adapters have separate product implementations. |
| 8 | Same file, summary: `reads a multibyte code point split across streamed chunks without corruption` | Actual bytes split inside a four-byte code point; output equality and unlocked reader. Tests streaming decode, unlike the unsplit ordinary successful response. |
| 9 | Same file, question: `accepts exactly the byte limit, including multibyte text and JSON whitespace` | Real padded response with exact adapter limit; output equality, unlocked reader and no cancellation. Necessary acceptance boundary. |
| 10 | Same file, question: `rejects one excess byte despite a dishonest Content-Length, cancels and releases the reader` | Actual limit+1 stream; rejected safe error, cancellation once despite cancellation rejection, unlocked reader and cleared timer. Necessary rejection counterpart to #9. |
| 11 | Same file: `question prompts describe only available truncated page ranges` | **Corrected inconsistent fixture and weak oracle**, as described above. Fetch substitution captures the actual formatter's request; source selection remains separately tested. |
| 12 | Same file: `question rejects invalid UTF-8 leading byte inside otherwise valid JSON and logs only its stage` | Named object row supplies the intended 0xff byte. A positive lossy-decoding control proves JSON would otherwise be valid. Strict rejection, safe diagnostic and released reader distinguish decoder policy from syntax rejection. Correctly encoded U+FFFD neighbor checks legitimate text. |
| 13 | `document-generation.test.ts`, summary: `prevents a duplicate concurrent provider request while a claim is held` | Deferred fetch keeps first handler active while a second receives 409. Actual handler/SQL/migrations, one fetch and one persisted result; finally resolves the pending fixture. SQLite scheduling is deterministic, not distributed concurrency proof. |
| 14 | Same file, summary: formerly `rolls back failed persistence, returns a safe error and releases its claim`; now `rolls back an inserted result when claim release fails, returns a safe error and releases its claim` | **Strengthened failure timing and oracle**, as described above. SQLite adapter provides atomic batch semantics; handler decides to use them. Shared definition also rerun for metadata and question. Earlier transport-failure cleanup does not substitute for partially completed persistence. |
| 15 | Same file, metadata: `does not persist or delete a replacement owner after losing its lease` | Fake fetch changes the stored owner before returning; actual handler/SQL must preserve the replacement and write no result. Distinct from ownership loss before dispatch, which must make zero provider calls. No claim about wall-clock lease contention in hosted D1. |

## Execution and interpretation

The pre-change focused run passed **178/178** tests. The corrected focused run
also passed **178/178** (98 provider, 80 handler). Provider and workflow test
typechecks passed. The change improves the meaning of four existing cases
(one formatter plus three parameterized persistence cases); it adds no cases.
The full baseline, coverage and exact command snapshots are archived separately
under this review. A passing suite alone does not prove the entire suite has
strong oracles. Earlier seeded-fault evidence is preserved and was not rerun
or enlarged as part of this bounded review.

The original assignment available here is the six-section rubric supplied by
the user in `docs/hw2/improvement-request.md`. The original generation record,
initial assessment, latest report, bug reproductions and round evidence were
read. No separate full assignment document was supplied. The revised report
provided by the author is preserved verbatim as `author-revision.md`; it is
the basis of the final editable report, including the personal reflection.
