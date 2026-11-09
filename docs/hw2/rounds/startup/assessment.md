# Bounded startup readiness and read-only recovery

Starting branch: `hw2/initial-baseline`, commit `d2d29a3`. The author extended
the submission target to 10:30 PM EST; agent work must stop by 10 PM.

## Reproduction and scope

Two new UI cases failed against the existing App in
`development/2026-11-09T02-47-04.564Z-startup-ui-before`: both could not find
the `Retry connection` button after failed/stalled initial reads. This was a
focused two-test run; 22 other App cases were deliberately skipped. Fetch is
mocked at the HTTP boundary, with real responses and abort-aware stalled
promises. A readiness flag then permits successful health, storage and library
reads. This deterministically reproduces the missing in-page recovery control,
not an actual Windows scheduler delay or every reported browser hang.

Source inspection found that the old launcher starts Worker and Vite together,
without a readiness barrier. The old status effect runs only at mount; later
Worker readiness does not rerun it. The read-only library already has its own
reload action. AI authentication is a separate key issue reported resolved by
the author; no live provider call was made for this work.

## Product change

- `scripts/startup-readiness.mjs` checks GET `/api/health`,
  `/api/storage/status`, `/api/library/papers` and `/api/documents`. It checks
  response status and expected structure, including D1/R2 status and list
  shapes. Every request includes body consumption in its deadline: at most
  two seconds per request within a 30-second phase. Polling ends on success,
  cancellation or deadline, not an unconditional startup delay. A timeout
  identifies the failed endpoint and directs the user to logs, schema/config
  and ports; it never automatically migrates or resets storage.
- The managed launcher waits for direct Worker readiness before starting Vite,
  then checks all four endpoints through Vite. Its final app-ready message and
  Vite's buffered ready URL appear only after proxy checks. Vite stdout is
  drained immediately, with a bounded buffer; stderr remains visible. Existing
  SIGINT/SIGTERM and child-process cleanup paths now also cancel readiness.
- App exposes `Retry connection` when an initial health/storage/library read
  fails. Each health/storage attempt is bounded by ten seconds; library retains
  its existing ten-second bound. Retrying only reruns GETs. The mount lifecycle
  remains separate, so connection retry does not cancel active saves or rerun
  writes, uploads or generation. No automatic write retry was added.

## Deterministic tests and actual development feedback

Five launcher cases use isolated fake responses and fake time: delayed Worker
and document-schema readiness followed by all proxy endpoints; permanent HTTP
failure; malformed successful readiness payload; stalled body; and cancellation
of a stuck fetch. These are unit tests of the readiness barrier, not process
or hosted-network emulation. Two UI cases verify successful explicit recovery
and bounded stalled reads with no additional automatic requests or writes.

The first combined run passed 28/29. At exactly the total deadline the helper
scheduled a redundant zero-delay polling timer, which the exact fake-clock
advance had not executed. The test hit its own five-second limit. The helper
now exits immediately when its deadline is reached; the unchanged assertions
pass. This is a development defect corrected before publication, not another
pre-existing product bug. Corrected and final focused runs pass 29/29.
Both focused TypeScript checks pass. Launcher modules pass `node --check`.

An early full baseline was deliberately interrupted after that correction, to
restart all stages against a stable implementation. Its wrapper exit is 1 and
is retained as an interrupted run, not misreported as a completed regression.
The final full baseline result, exact snapshots and per-file coverage are in
`evidence/`. Its `local-reset` stage uses disposable storage, exercises the
actual managed Worker/Vite startup and verifies owned process-tree cleanup;
its fixture migrations do not touch user data. Native Windows console Ctrl+C
was not separately simulated; signal handlers and readiness cancellation are
covered by source review, unit cancellation and managed-shutdown checks.

Earlier captures omit launcher JavaScript from their snapshot; that limitation
is explicit. The final focused capture includes both launcher files, and the
final baseline archive copies their stable evaluated versions. Historical
archives are not rewritten. Scripts remain outside the established `src/**`
coverage scope; the App product change changes its measured denominator.

This bounded startup change does **not** establish the cause of the earlier
intermittent Vite proxy/static-request stalls. Those limitations remain in the
report. The three earlier confirmed HW2 defects and selected artificial faults
retain their original evidence and interpretation. No fault-probe rerun or
production performance claim is made here.

## Final verification

Full baseline: 19/19 stages passed; 469/469 tests in 14 files. 2400/2975 statements, 2051/2607 branches, 434/540 functions, 2064/2453 lines.
Product fix commit: `fcc2454`. Exact final test/product snapshots are archived.
