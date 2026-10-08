# Development log

## 2026-10-08 — Phase 0A.1

- The initial directory contained no project files, `AGENTS.md`, or Git repository, so a minimal React/Vite and Worker scaffold was created.
- Windows PowerShell execution policy blocks `npm.ps1` (and `pnpm.ps1`). The documented and verified workaround is to run npm as `npm.cmd`; no machine policy was changed.
- In this environment, Vite listens on the `localhost` IPv6 loopback interface. Use `http://localhost:5173` for the frontend; the Worker remains available on `http://127.0.0.1:8787`.
- The controlled verification sandbox initially blocked npm's user-cache access and Vite/esbuild's config-path read. Both install and build passed after the sandbox was granted the required access; this is not an application configuration change.

## 2026-10-08 — Phase 0A.1 audit follow-up

- Recorded Node `v24.11.1` and npm `11.6.2`.
- `npm.cmd audit --json` exited 1 with three high findings. Complete reports are preserved in `audit-evidence-before.json` and `audit-evidence-after.json`; the nonzero status is npm's expected behavior when findings exist.
- All findings are in the development path `wrangler@4.148.0` → `miniflare@5.20261006.0-alpha` → `sharp@0.35.4`. The advisory is `GHSA-wq5f-xc86-pv6w` for Sharp versions below `0.35.5`.
- `npm.cmd audit --omit=dev --json` exited 0 with no production findings. The current application only uses Wrangler/Miniflare for local Worker development; it does not invoke Sharp. This lowers production-bundle exposure but does not make the development-tool finding harmless.
- `npm.cmd audit fix --dry-run --json` exited 1 and proposed zero changes. Current registry metadata still has the latest Wrangler (`4.148.0`) pinning that Miniflare version, and Miniflare pinning Sharp `0.35.4`. Sharp `0.35.5` exists, but an override would bypass that exact upstream pin, so no dependency, manifest, or lockfile change was made.
- Because dependencies did not change, the prior typecheck, production build, frontend/Worker health, and built-Worker checks were not rerun. No local processes were started or stopped in this follow-up.

## 2026-10-08 — Phase 0A.2: persistent local D1 and R2

### Scope and changes

- Inspected the current scaffold and ancestor/project instruction paths; no `AGENTS.md` or Git repository was present. Preserved the preceding history, all three original audit evidence files, and the unrelated empty `vite` file. The user had already confirmed the original backend indicator in a browser screenshot.
- Environment remains Windows PowerShell, Node `v24.11.1`, npm `11.6.2`, Wrangler `4.148.0`, and Vite `7.3.7`. Installed Wrangler's launcher requires Node >=22; corrected `package.json` and README from the previous Node 20 prerequisite to >=22.12 (also compatible with Vite).
- Added exact stable dev dependencies `drizzle-kit@0.31.11` and `drizzle-orm@0.45.4`. The Worker does not import Drizzle; the schema generator uses it. Production dependencies remain React and React DOM. Manifest/lockfile consistency was asserted after installation.
- Updated `wrangler.jsonc` with local `DB` (database name `ai-research-assistant-local`, local ID `local-ai-research-assistant`) and `PAPER_BUCKET` (bucket `ai-research-assistant-papers-local`), both `remote: false`. Installed Wrangler accepted these local labels; no production ID, account, secret, or hosted resource was created.
- Generated `worker-configuration.d.ts` with actual D1/R2 types. Worker and frontend TypeScript configurations now isolate their respective runtime types; the tooling typecheck also checks the Drizzle schema/configuration.
- Added `db/schema.ts`, `drizzle.config.ts`, and the generated `drizzle/0000_storage_probe.sql`, `drizzle/meta/0000_snapshot.json`, and `drizzle/meta/_journal.json`. Inspected the SQL: one `CREATE TABLE storage_probes` with only non-null `id` (text primary key) and `value` (text), no seed data. Applied SQL and metadata are retained for future migrations and the later Sites handoff.
- Added typed helpers in `src/worker/storage.ts` and a flag-gated local probe handler in `src/worker/local-probe.ts`. Updated `src/worker/index.ts` with read-only `/api/storage/status`; `/api/health` remains exactly `{"status":"ok"}`. All parameterized D1 operations bind values and use one SQL statement per prepare call. No runtime schema creation.
- Updated `src/App.tsx` and `src/styles.css` with small independent backend/D1/R2 indicators, relative requests, loading/failure states, and a 10-second request timeout. Updated `vite.config.ts` with an optional local Worker origin for isolated verification and strict port selection. The default `/api` proxy remains `http://127.0.0.1:8787`.
- Added `scripts/storage-check.mjs`, npm migration/type-generation/check commands, `.dev.vars*` ignore rules, README instructions, and current audit/persistence evidence. All runtime state remains under ignored `.wrangler/`.

### Commands and results

| Command | Result |
| --- | --- |
| `node --version` / `npm.cmd --version` | `v24.11.1` / `11.6.2` |
| `npm.cmd view drizzle-kit dist-tags --json` | Stable `latest` is `0.31.11`; prerelease tags were not selected |
| `npm.cmd view drizzle-orm dist-tags --json` | Stable `latest` is `0.45.4` |
| `npm.cmd install --save-dev --save-exact drizzle-kit@0.31.11 drizzle-orm@0.45.4` | Exit 0; added 15 packages, reported 4 moderate + 3 high findings |
| `npm.cmd install --package-lock-only` | Exit 0; synchronized the updated Node engine metadata |
| `npm.cmd run worker:types` | Exit 0; generated `DB: D1Database` and `PAPER_BUCKET: R2Bucket` plus runtime types |
| `npm.cmd run db:generate -- --name=storage_probe` | Exit 0; generated the single table's initial migration and metadata |
| `npm.cmd run db:migrate:local` | Exit 0; applied `0000_storage_probe.sql` with `--local --persist-to .wrangler/state` |
| `npm.cmd run storage:check` | Exit 0; full restart, reapplication, HTTP, disabled-route, and scoped cleanup checks passed |
| `node --check scripts/storage-check.mjs` | Exit 0 |
| `npm.cmd run typecheck` | Exit 0, including Worker bindings and Drizzle configuration/schema |
| `npm.cmd run build` | Exit 0; includes typecheck, Vite, and Worker ESM compilation; rerun after final source cleanup |
| `npm.cmd explain esbuild` | Identified the new vulnerable nested `esbuild@0.18.20` and separate patched copies used by other tools |
| `npm.cmd ls --depth=0` | Direct scaffold versions preserved; Drizzle additions present. Existing extraneous Sharp optional packages remain untouched |
| `npm.cmd audit --json` | Exit 1 (findings), 7 total; saved complete output to `audit-phase-0a2.json` |
| `npm.cmd audit --omit=dev --json` | Exit 0, 0 findings; saved `audit-phase-0a2-production.json` |
| `npm.cmd audit fix --dry-run --json` | Exit 1, zero changes; saved `audit-phase-0a2-dry-run.json` |

The final built-handler health check used the existing direct ESM approach and passed:

```powershell
node --input-type=module --eval "import assert from 'node:assert/strict'; import worker from './dist/worker/index.js'; const r = await worker.fetch(new Request('http://local.test/api/health')); assert.equal(r.status, 200); assert.deepEqual(await r.json(), {status:'ok'}); console.log('Built Worker health: PASS');"
```

Additional direct ESM assertions passed: absent bindings return 503 with `binding_missing` for both; a failing D1 query returns 503 while R2 stays `ok`; a failing R2 operation returns 503 while D1 stays `ok`; unflagged GET/PUT/DELETE probe routes return 404. These failure-path assertions used small injected failing bindings; successful storage and persistence checks used real local D1/R2 through Wrangler/workerd.

### Persistence and HTTP evidence

- Regular dev/migrations use `.wrangler/state`. The isolated run used `.wrangler/storage-check/6a27419e-00d5-4eb9-abc9-5e829158553e`, the same application configuration, `--local`, `--persist-to <that directory>`, `--ip 127.0.0.1`, `--port 49933`, `--inspector-port 0`, and `--show-interactive-dev-session=false`.
- The first Worker (PID 119260) omitted the probe flag: health/storage status both returned HTTP 200; all three probe methods returned 404. Its own Vite process (PID 117168) used `--host 127.0.0.1 --port 49972 --strictPort` with `LOCAL_WORKER_ORIGIN=http://127.0.0.1:49933`. Frontend HTML returned 200 and both proxied status endpoints returned the expected 200 JSON. The script stopped only those owned processes.
- Worker PID 117024 used `--var LOCAL_STORAGE_PROBE:true`. A GET first confirmed the UUID had neither a row nor an object. Exactly one PUT wrote row ID `6a27419e-00d5-4eb9-abc9-5e829158553e`, value `persistent D1 probe 6a27419e-00d5-4eb9-abc9-5e829158553e: quotes ' and Unicode λ`, and the known 53-byte R2 object at `__storage_probes/6a27419e-00d5-4eb9-abc9-5e829158553e.bin`.
- Initial reads matched. After terminating the owned Worker process tree, replacement PID 118644 used exactly the same state and flag. Its **first probe operation was GET**, and both the original row and all original bytes matched without a rewrite or reseed. R2 SHA-256: `00ccf20cb1400d742cb53fea91bd4313b52fc5e97d1cd13c3f80dc7d69e2dda3`.
- Stopped that owned Worker and ran `node node_modules/wrangler/bin/wrangler.js d1 migrations apply DB --config wrangler.jsonc --local --persist-to C:\Users\panap\PycharmProjects\babyScholar\.wrangler\storage-check\6a27419e-00d5-4eb9-abc9-5e829158553e` again. Exit 0: `No migrations to apply!`. Worker PID 119076 then read the same row and bytes successfully.
- Deleted only that UUID row and object, verified both reads returned null, and stopped the final owned Worker. The test directory/migration history remain for inspection; user processes were not terminated. Follow-up socket inspection showed no listeners remaining on test ports.
- Full exact values, byte arrays, process IDs, HTTP origins, migration commands, and step ordering are preserved in `storage-check-evidence.json` and the ignored run's `result.json`. The storage test ran from 17:00:08.265 to 17:00:19.573 UTC.
- Build handoff paths remain `dist/frontend/` and `dist/worker/index.js`. The Worker entry now imports sibling ESM modules, so retain all of `dist/worker/`, plus `drizzle/*.sql` and `drizzle/meta/**` for the later handoff.

### Audit assessment, setup issues, and remaining checks

- Known findings remain 3 high through `wrangler@4.148.0 → miniflare@5.20261006.0-alpha → sharp@0.35.4`, advisory [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w). No forced override was added.
- New findings are 4 moderate package entries for one advisory, [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99), via `drizzle-kit@0.31.11 → @esbuild-kit/esm-loader@2.6.5 → @esbuild-kit/core-utils@3.3.2 → esbuild@0.18.20`. Affected feature: esbuild's development server CORS. The inspected loader calls `transform`/`transformSync`; this project's Drizzle command generates files and does not start that server or Drizzle Studio. Vite uses esbuild 0.28.2 and Wrangler its separate 0.28.1; these are not the newly flagged copy. This bounds the observed exposure, rather than treating dev dependencies as harmless.
- Full audit now totals 7 (3 high, 4 moderate), versus the prior 3 high. Production-only remains zero. The dry run changes nothing and suggests breaking Drizzle downgrade `0.18.1` for the new findings; it would regress migration tooling compatibility and was not applied. Security remediation remains open for a separate scoped task.
- npm also warns that the two `@esbuild-kit` packages are deprecated in favor of tsx; retained stable upstream dependencies rather than introducing overrides or prereleases. Installation/build/runtime commands requiring subprocess/cache access were run with approved sandbox escalation, as in Phase 0A.1. No machine policy changed.
- An initial optional lockfile-snapshot one-liner failed because PowerShell stripped its JavaScript string quotes; no files were written by it. Subsequent inline Node commands used an outer double-quoted argument with inner single quotes and passed. No required application verification failed.
- Browser rendering of the new D1/R2 indicators was not rechecked; this phase verified served HTML, direct/proxied HTTP, compiled Worker behavior, and persistence. The user's earlier screenshot covers the prior backend-connected baseline only. No hosted checks were performed or required; local and hosted data are separate.
- Runtime identifies the agent as GPT-6. Exact Astra variant, reasoning setting, and pricing multiplier are not exposed to the agent and are not claimed. Instrumented work began at 16:55:18 UTC; final source/build verification completed at 17:04:16 UTC (8 minutes 58 seconds to that checkpoint, with documentation following).

## 2026-10-08 — Phase 0A.3: local arXiv and OpenAI connectivity wiring

### Scope and changes

- Inspected the existing project and instruction paths before changes; no `AGENTS.md` or Git repository is present. Preserved the blank frontend, Worker health/storage behavior, D1/R2 bindings, migration metadata, `.wrangler/state`, all build output, audit evidence, and unrelated files.
- Added the committed `.dev.vars.example` template with `OPENAI_API_KEY` placeholder and `OPENAI_MODEL=gpt-6-luna`. The real `.dev.vars` remains ignored; it was absent during verification. The ignore rule explicitly re-includes only the example template.
- Added the non-secret default `OPENAI_MODEL: gpt-6-luna` to `wrangler.jsonc`, regenerated Worker binding types, and extended the Worker environment shape with optional secret/configuration bindings. The generated type contains no API key.
- Added small Worker-compatible arXiv and OpenAI adapters plus typed, sanitized integration failures. They have bounded abort timeouts, no automatic retry, and distinguish missing configuration, authentication, quota/rate limits, model access, malformed responses, upstream errors, network failures, and timeouts. The OpenAI adapter sends the exact diagnostic prompt only; the Luna request uses `reasoning: { effort: "none" }`, `max_output_tokens: 256`, and `store: false`, with no tools. Configured non-default models receive only portable request fields; no model is silently substituted.
- arXiv uses one HTTPS Atom query for `all:electron` with `max_results=1`, parses a real entry/title/link, and treats an Atom error feed as upstream failure even on an HTTP success status. The deliberately paced check makes one request and one connection.
- Added flag- and loopback-gated local integration routes, the real-Worker `npm.cmd run integrations` script, and focused `npm.cmd run integrations:offline` checks. External calls cannot occur from page load, health/storage checks, builds, type checks, or offline tests. The live script owns an isolated `.wrangler/integration-check/<UUID>` directory, ports, and child processes and cleans up only those children.
- Added `integration-check-evidence.json`, a sanitized record of the local run. No dependency was added or upgraded, so the documented audit baseline remains 3 high and 4 moderate development-dependency findings, with 0 production-only findings; no audit suppression, forced fix, or override was used.

### Commands and results

| Command | Result |
| --- | --- |
| `npm.cmd run worker:types` | Exit 0; regenerated Worker binding/runtime types with the non-secret model binding |
| `npm.cmd run typecheck` | Exit 0 |
| `npm.cmd run build` | Exit 0; retained `dist/frontend/` and the complete Worker ESM module directory `dist/worker/` |
| `npm.cmd run integrations:offline` | Exit 0; missing-key, Atom-error-feed, timeout, and Responses request-shape checks passed |
| `npm.cmd run integrations` | Exit 0 with `passed_with_openai_skipped`; real local Worker health/storage passed directly and via its own Vite proxy, and disabled integration routes returned 404 |

The live check used its own state directory `.wrangler/integration-check/c07cc225-80e5-4820-9f13-e8e22fcfd166`, did not touch normal local state, and stopped only its Worker/Vite children. It made one real arXiv request, successfully validated **“The electronic structure of cuprates from high energy spectroscopy”** at `https://arxiv.org/abs/cond-mat/0011267v1`. OpenAI was correctly skipped before any network request because `OPENAI_API_KEY` was absent; the selected configurable model is `gpt-6-luna`. `integration-check-evidence.json` has the exact sanitized ports, process ownership, and result sequence.

### Remaining local action

- To perform the one authenticated OpenAI probe, create the ignored `.dev.vars` only if it is absent (`Copy-Item .dev.vars.example .dev.vars`), edit it locally with `notepad .dev.vars`, enter the account's key without sharing it, and run `npm.cmd run integrations`. The result must be a completed response containing usable text for the check to pass fully.
- No browser rendering check was needed or repeated in this narrow infrastructure phase. The user-provided screenshots remain evidence for the blank page, backend, D1, and R2 indicators. The scripted check verified the frontend's served/proxied HTTP paths; the only unperformed live integration is authenticated OpenAI access pending local configuration.

## 2026-10-08 — Phase 0B.1: source checkpoint and deployment handoff

### Checkpoint and evidence

- Initialized the previously unversioned project as a new Git repository on `main`. Git `2.45.1.windows.1` found the existing valid author identity `Pranav <panappin@gmail.com>`; no global Git configuration was changed. The sandbox Windows identity differs from the workspace owner, so Git commands used a per-command `safe.directory` setting only.
- Reconciled the supplied successful local Worker result `.wrangler/integration-check/4d91d328-87d3-4552-929c-a3bee2188791/result.json` into the shareable `integration-check-evidence.json`. The sanitized evidence retains the earlier `passed_with_openai_skipped` run and adds the later fully successful run: arXiv metadata passed, `gpt-6-luna` returned `OK`, direct and Vite-proxied health/storage passed, probe routes were disabled by default, and only owned processes were cleaned up. No paid request was repeated.
- Added `docs/DEPLOYMENT_HANDOFF.md` with source/Worker entry points, Windows build commands, required complete output directories, D1/R2 bindings, migration locations, OpenAI secret/model configuration, and disabled diagnostic flags. It explicitly distinguishes local labels from future hosted identifiers.
- Extended `.gitignore` for PyCharm/VS Code local files and generated `handoff/` archives, while retaining `.dev.vars.example`. `git check-ignore` confirmed `.dev.vars`, `.wrangler/`, `dist/`, and `node_modules/` are excluded. The real `.dev.vars` was present but never read, staged, printed, copied, or archived.
- Reviewed the 41-file initial staging set (source, package lock, schema, migration SQL/metadata, scripts, Worker types, documentation, and audit evidence). A non-printing staged-content scan passed with no credential-shaped values. Wrangler-generated `worker-configuration.d.ts` has existing trailing whitespace, retained unchanged because it is generated and required.

### Reproducibility

- Exported the committed source into a separate clean copy with no `.git`, `.dev.vars`, `.wrangler`, `node_modules`, or `dist`. In the final short-path copy, `C:\tmp\bsr-cbbc7b65-2f86-4e58-816a-ef23e81bb6e0`, all required commands passed:

| Command | Result |
| --- | --- |
| `npm.cmd ci` | Exit 0; installed exactly 144 packages from `package-lock.json`; npm reported the unchanged 4 moderate + 3 high development-tool findings |
| `npm.cmd run typecheck` | Exit 0 |
| `npm.cmd run build` | Exit 0; rebuilt `dist/frontend/` and the complete `dist/worker/` ESM directory |
| `$env:INTEGRATION_CHECK_OFFLINE='true'; npm.cmd run integrations` | Exit 0, `passed_offline`; migration, direct health/storage, Vite-proxied health/storage, disabled-route 404s, and owned-process cleanup passed; arXiv/OpenAI routes were deliberately not invoked |

- The first clean copies were placed under the long `%TEMP%` path and exposed a Wrangler/Miniflare local D1 internal error before any external call. Direct diagnostics showed the failure depended on the long nested persistence path, not source, lockfile, secret, or application configuration. Repeating the unmodified committed source from the short `C:\tmp` path passed. One `npm exec` diagnostic unnecessarily attempted to obtain a Node package; it was outside the final reproducibility run and its discarded temporary copy contained no project secrets. The final required clean verification made no arXiv or OpenAI requests.
- Added explicit `INTEGRATION_CHECK_OFFLINE=true` support to `scripts/integration-check.mjs` and documented it in README and the handoff. It runs the actual local Worker/Vite core checks while not invoking either external adapter. Normal `npm.cmd run integrations` retains its deliberate live behavior.

### GitHub handoff status

- Local commits created before this log entry: `ffb36c5` (`chore: add phase 0 infrastructure checkpoint`), plus iterative verification-only commits. The final log/checkpoint commit and handoff archive are created after this entry.
- `gh` is not installed. `git credential-manager github list` failed because this runtime cannot persist/access the Windows `wincredman` store. A read-only `git -c credential.interactive=false ls-remote https://github.com/panappin/babyScholar.git` returned `Repository not found`; without a usable authenticated session that does not distinguish an absent private repository from unauthorized access. No GitHub repository, remote, visibility, or remote history was changed. The next user-side action is to authenticate Git Credential Manager or install/sign in to GitHub CLI as `panappin`; no token should be pasted into chat.
- The known audit baseline remains 3 high and 4 moderate development-tool findings, with zero production-only findings. No package dependency change, audit suppression, force fix, or override was made in this phase.
- A generated handoff ZIP was inspected before this final log commit to validate the handoff procedure: it contained the tracked source plus the clean-build `dist/frontend/` and complete `dist/worker/` directory (58 entries; 3 frontend files; 14 Worker files). Required source/migration/handoff files were present; `.git`, `node_modules`, `.wrangler`, `handoff`, real `.dev.vars`, real `.env*`, and credential-shaped values were absent. The archive is regenerated from the final commit after this entry so its source revision exactly matches the final checkpoint; its absolute path and SHA-256 are reported with the handoff.

## Phase 0B.2 hosting preparation, October 8, 2026

- Received the Phase 0B.1 ZIP and independently verified SHA-256
  `f21fddc6f17b6d441515f5d87ac6982f5d246a01a9538509d46967491d6af015`,
  all 58 entries, and the archive CRC. Normalized its Windows entry separators
  during Linux extraction. No real environment files or credential-shaped
  values were found by the bounded scan.
- Retained the React/TypeScript application, full Worker modules, the original
  Drizzle SQL/metadata, and the dependency lockfile. No dependency versions or
  paper-assistant features were changed. Added a small book favicon.
- Registered private Site `appgprj_6ac7edf4f7248191a1b330185e0df5e0` and
  declared the existing logical bindings `DB` and `PAPER_BUCKET`. Sites owns
  the production resources; local placeholder IDs are excluded from the
  hosted Worker configuration.
- Added `ASSETS` fallback for frontend requests, keeping `/api/*` routed to
  the existing backend. The build retains `dist/frontend/` and the full
  `dist/worker/`, then stages `dist/client/`, the full `dist/server/`, and
  immutable migration metadata for publication.
- `npm run build`, `npm run integrations:offline`, the full integration check
  with `INTEGRATION_CHECK_OFFLINE=true`, and `npm run sites:check` passed in
  the managed Linux hosting checkout. The artifact check uses binding fixtures;
  the full offline check uses local Worker D1/R2 emulation and the Vite proxy.
  No arXiv query or paid OpenAI request was repeated.
- Set non-secret Sites runtime configuration `OPENAI_MODEL=gpt-6-luna`.
  The existing local API key was not supplied in the ZIP. OpenAI Developers
  was initially declined, then the user stated it was installed; a recheck
  confirmed installation and available Personal/Default-project targets.
  No new API key was created. Hosted secret configuration and authenticated
  OpenAI connectivity remain pending.
- Publication outcome and the complete interaction record belong in the
  running AI Research Assistant Phase Journal. The Windows GitHub repository
  has not received these hosting changes yet; synchronize the supplied handoff
  through the next scoped Codex task without replacing Git history or secrets.

### Windows source synchronization

- Confirmed the local `main` HEAD was the required base checkpoint
  `044ef6fb79f9f20b5471a9b43d87c75932c8da1f` and matched `origin/main` before
  applying the handoff. The supplied `babyScholar-phase-0b2-hosting-changes.zip`
  SHA-256 matched `462bf69cfc1c4acf83380d104a1b9453570c4923c1f7a89dc71d75581277311c`.
  It was extracted to a fresh temporary directory and all 12 paths were
  inspected before synchronization.
- Preserved the real ignored `.dev.vars`, local `.wrangler` state, ignored
  build output, `package-lock.json`, `db/schema.ts`, `drizzle/0000_storage_probe.sql`,
  `drizzle/meta/**`, and `wrangler.jsonc`. The registered project ID remains
  `appgprj_6ac7edf4f7248191a1b330185e0df5e0`; hosted bindings remain `DB` and
  `PAPER_BUCKET`.
- Dependencies were already present, so `npm.cmd ci` was not run. `npm.cmd run
  build` passed: type checking, Vite, Worker ESM build, and Sites staging all
  completed. The resulting `dist/client/`, full `dist/server/`, and
  `dist/.openai/drizzle/` paths were checked locally.
- Ran `npm.cmd run integrations` with `INTEGRATION_CHECK_OFFLINE=true` because
  the preserved local key could otherwise send the deliberate paid OpenAI
  probe. It passed local migration, direct Worker health/storage, Vite-proxied
  health/storage, disabled-route 404s, and owned-process cleanup without
  invoking arXiv or OpenAI. `npm.cmd run sites` passed the packaged Worker,
  API/static routing, binding fixtures, disabled probes, and copied migration
  metadata. The package adds a dependency-free `sites` alias to the supplied
  `sites:check` script so the requested command is available.
- This synchronization did not create another Site, redeploy, configure a
  hosted secret, or change the private Site audience. Hosted `OPENAI_API_KEY`
  setup and authenticated hosted OpenAI verification remain pending.

## 2026-10-08 — Phase 1A: backend arXiv paper search

### Scope and implementation

- Inspected the current project, README, development log, Worker router, arXiv
  adapter, integration scripts, Git state, and HEAD before changing source. No
  `AGENTS.md` exists in or above this project. Preserved the blank frontend,
  D1/R2 bindings and state, hosted project ID, Drizzle SQL/metadata,
  `package-lock.json`, real ignored environment files, and the pre-existing
  untracked Phase 0B.2 ZIP/folder.
- Reviewed the arXiv API manual and Terms of Use. Added
  `GET /api/papers/search?q=<plain-text-keywords>` without changing the
  frontend or local diagnostic routes. It sends one server-built query to
  `https://export.arxiv.org/api/query` with `start=0`, `max_results=10`, and
  relevance sorting.
- The request contract is `{ provider: "arxiv", query, papers }`. Results keep
  Atom order and include stable modern/legacy base IDs (the source `vN` suffix
  is removed only from `id`), title, ordered authors, first-submission year from
  `published`, full normalized abstract, and optional canonical HTTPS arXiv
  abstract/PDF links. Source URL versions are retained. Only exact
  `arxiv.org`/`www.arxiv.org` links are accepted; missing optional fields remain
  empty or `null`.
- `q` is required, NFC-normalized, whitespace-collapsed, and limited to 200
  Unicode characters. The adapter extracts Unicode letter/number terms and
  creates each quoted `all:` term plus its `AND` operators itself. Therefore
  user quotes, field prefixes, wildcards, punctuation, and boolean syntax are
  not passed through as arXiv query language. Invalid input returns JSON 400
  before fetching.
- Extended the existing Worker-compatible manual Atom parser rather than adding
  a dependency. It detects successful HTTP error feeds, normalizes XML entities
  and namespaces, handles empty valid feeds, constrains complete body reading to
  10 seconds and 1 MB, clears timers, and returns sanitized 502/504 errors with
  no retries. The search service has a 20-entry, five-minute successful-result
  cache, same-query in-flight deduplication, and a single per-isolate queue
  that spaces distinct arXiv requests by at least three seconds. These are not
  a deployment-wide rate limiter.
- Added dependency-free `papers:check` and `papers:live` commands plus fixture
  coverage for response shape/status errors, modern and legacy IDs, ordered
  authors, entities/namespaces, published year, absent links, empty/error/
  malformed feeds, invalid inputs with zero fetches, HTTP/network failures,
  body timeout/size limit, cache, deduplication, and spacing. No dependency or
  lockfile update was needed. The documented audit baseline remains 3 high and
  4 moderate development-tool findings with zero production-only findings.

### Verification

| Command | Result |
| --- | --- |
| `npm.cmd run typecheck` | Exit 0 |
| `npm.cmd run build:worker` | Exit 0 |
| `npm.cmd run papers:check` | Exit 0; all fixed-fixture and mocked-fetch search checks passed |
| `npm.cmd run build` | Exit 0; type checking, Vite build, Worker ESM build, and Sites staging passed |
| `npm.cmd run sites` | Exit 0; packaged Worker routing/binding/migration fixture check passed |
| `npm.cmd run integrations:offline` | Exit 0; prior arXiv/OpenAI adapter failure-path checks passed without external calls |
| `INTEGRATION_CHECK_OFFLINE=true; npm.cmd run integrations` | Exit 0 (`passed_offline`); local migration, direct Worker health/storage, Vite-proxied health/storage, disabled probe 404s, and owned-process cleanup passed. The prior environment value was restored. |
| `npm.cmd run papers:live` | Exit 0 after the local Worker started and stopped; made exactly one live arXiv request through the new endpoint, with no OpenAI request. |

- The one live endpoint check searched `graph neural networks` at a local Worker
  origin and received `2211.12792`, **“MECCH: Metapath Context
  Convolution-based Heterogeneous Graph Neural Networks”**, with canonical URL
  `https://arxiv.org/abs/2211.12792v2`. Its isolated ignored state was
  `.wrangler/paper-search-check/86834ff8-a468-43dc-99e4-0ecf02475550`.
- The constrained sandbox initially blocked Vite/Wrangler from reading project
  configuration and writing Wrangler's normal log directory, so the first
  `build`, full offline integration, and live-check attempts failed before
  application verification. Rerunning those exact requested commands with
  normal filesystem access passed. The failed owned Worker was stopped; no
  user process, runtime state, secret, hosted resource, or paid API request was
  changed. The live retry is the sole successful endpoint request in this
  phase.
- Storage behavior and persistence configuration were unchanged, so the full
  restart-persistence check was not repeated. Browser UI checking was not
  repeated because the frontend remains intentionally blank; the local Worker
  route, built Worker, Sites artifact, and Vite proxy were covered by the
  scripted checks.

## 2026-10-08 — Hosted OpenAI status correction

- This corrects the now-stale Phase 1A/hosting handoff wording that said hosted
  `OPENAI_API_KEY` setup was pending. The owner confirmed the existing private
  Site already has that secret and was redeployed during Phase 0B.2. Historical
  entries above retain the state recorded when they were written. This correction
  did not read, create, change, or expose a secret; it did not make an OpenAI
  request or deploy a Site.

## 2026-10-08 — Phase 1B: research-paper search frontend

### Scope and implementation

- Inspected the current checkout, Git state/HEAD, package scripts, README,
  development log, frontend, Phase 1A response/error contract, and verification
  scripts before edits. No `AGENTS.md` exists in or above the project. Preserved
  the real ignored environment file, runtime state, storage/migrations/bindings,
  hosted project configuration, and the pre-existing untracked Phase 0B.2 ZIP
  and extracted folder.
- Added a labeled React topic/keywords form in `src/App.tsx`. It sends only on
  button click or Enter, uses `URLSearchParams` with the relative
  `/api/papers/search` URL, mirrors the backend's whitespace/Unicode/empty/
  letter-or-number/200-character validation, and never calls OpenAI. Search does
  not run on mount or while typing; the pending button is disabled and duplicate
  submission is ignored.
- Added clear initial, loading, results, empty, and sanitized-error states.
  The submitted query is stored with the response state, so later input edits
  cannot relabel a pending or completed result. Requests have a 20-second
  browser timeout, are aborted on unmount, and use request IDs so late responses
  cannot overwrite a newer state.
- Result cards render title, ordered authors, first-submission year, full
  abstract, and a safe arXiv link when supplied. Missing metadata has explicit
  unavailable text; no HTML injection is used. The page labels the year as first
  submitted and explains that it comes from arXiv's first submission. Existing
  Backend/D1/R2 indicators remain intact.
- Moved the Phase 1A response/error declarations to the declaration-only
  `src/worker/paper-search-types.ts` module and re-exported them from the
  adapter. The React import is type-only; the backend's runtime behavior did not
  change. A post-build scan found no arXiv adapter/runtime marker in
  `dist/frontend/`.
- Extended the existing visual style with responsive cards, keyboard focus,
  form labels/status announcements, and a narrow layout. Browser visual review
  caught a mobile input-height issue caused by the desktop flex basis after the
  controls became a column; adding the mobile flex reset fixed it.
- Added dependency-free `papers:ui:check`, using local headless Chrome through
  its DevTools protocol. It owns isolated Worker/Vite/browser processes and
  state, fixtures exceptional fetches in the real browser, and by default makes
  one live search through the form/Vite proxy. `PAPERS_UI_CHECK_SKIP_LIVE=true`
  runs the same fixture/browser check without an upstream call. No package or
  lockfile change was needed; the audit baseline remains unchanged.

### Verification

| Command | Result |
| --- | --- |
| `npm.cmd run typecheck` | Exit 0 |
| `npm.cmd run build` | Exit 0; frontend, Worker ESM, and Sites staging built |
| `npm.cmd run papers:check` | Exit 0; Phase 1A fixed-fixture adapter checks passed |
| `npm.cmd run sites` | Exit 0; existing Sites artifact/binding/migration check passed |
| `INTEGRATION_CHECK_OFFLINE=true; npm.cmd run integrations` | Exit 0 (`passed_offline`); local migration, direct/ proxied health/storage, disabled routes, and owned-process cleanup passed; the previous environment value was restored |
| `npm.cmd run papers:ui:check` | Exit 0 after a keyboard-event correction; browser used fixture responses for exceptional states and made exactly one live arXiv search through the React form and Vite proxy. It asserted only a nonempty arXiv result, not a fixed title/count. |
| `PAPERS_UI_CHECK_SKIP_LIVE=true; npm.cmd run papers:ui:check` | Final exit 0; no external request. Verified load/typing make no search, keyboard submission, loading, duplicate prevention, query association after editing, empty/API/malformed-JSON/network/timeout/blank states, all three connection indicators, and no narrow-layout horizontal overflow. |

- The browser fixture result visually checked all five required fields: title,
  ordered authors, year, complete abstract, and available paper link; it also
  checked unavailable metadata fallbacks. Full desktop and 375px-wide mobile
  screenshots were inspected at
  `.wrangler/frontend-search-browser-check/d678ce57-b8d3-46a3-bde1-bc1b939de937/`
  during the corrected-layout run; later equivalent ignored evidence is retained
  in `.wrangler/frontend-search-browser-check/`.
- The first browser-check attempt did not dispatch Enter correctly through CDP
  and timed out before any paper-search request, so no provider call occurred.
  The CDP key sequence was corrected. Two later fixture-only runs exposed
  Windows cleanup races after Chrome had already exited; cleanup now verifies
  the owned PID before treating `taskkill` codes as failure. The final browser
  checks passed and stopped only owned processes.
- No OpenAI request, hosted configuration change, deployment, push, storage
  schema/migration/binding change, PDF download, or feature beyond the search UI
  was performed. Storage persistence was unchanged, so its restart check was
  not repeated.

## 2026-10-08 — Phase 2A: persistent paper-library backend

### Scope and contracts

- Inspected the attachment request, repository/ancestor instructions, README,
  development log, schema/configuration, migration history, Worker routing,
  search types/helpers, and verification scripts. No applicable `AGENTS.md`
  was found. Starting `main` was `32c64eb5f725baabd3418638fd43a2eaa34aa9df`,
  with no tracked changes; the existing untracked Phase 0B.2 ZIP/folder were
  preserved. Tooling: Windows PowerShell, Node v24.11.1, npm 11.6.2, installed
  Wrangler 4.148.0 and Miniflare 5.20261006.0-alpha. No installation or upgrade.
- Added `papers` to `db/schema.ts` and generated additive
  `drizzle/0001_paper_library.sql`, `drizzle/meta/0001_snapshot.json`, and the
  appended journal entry. The initial migration and historical snapshot are
  unchanged. Columns retain an independent application UUID, source, normalized
  arXiv ID, title, ordered authors as JSON, nullable year, full abstract, nullable
  links, and UTC first-save timestamp. A database unique index on
  `(source, arxiv_id)` prevents races and version-link duplicates.
- Added declaration-only `SavePaperRequest`, `SavedPaper`, `SavePaperResponse`,
  `ListPapersResponse`, and error types. `SavedPaper.id` is the application UUID;
  `SavedPaper.arxivId` is the normalized provider identifier, and `source` is
  `arxiv`. A parameterized transactional insert/read batch uses
  `ON CONFLICT (source, arxiv_id) DO NOTHING`, returning the original metadata,
  ID, and timestamp on duplicates without overwriting them. Consulted the
  [official D1 prepared-statement](https://developers.cloudflare.com/d1/worker-api/prepared-statements/)
  and [batch API documentation](https://developers.cloudflare.com/d1/worker-api/d1-database/).
- `POST /api/library/papers` accepts `{"paper": PaperSearchResult}`: new saves
  return 201 `{"paper": SavedPaper, "created": true}`; duplicates return 200
  with the original record and `created: false`. `GET` returns 200
  `{"papers": SavedPaper[]}`, all records ordered by `saved_at DESC, id DESC`,
  including `[]` for an empty library. All application library responses are
  JSON with `Cache-Control: no-store`; no permissive CORS or new auth was added.
- Runtime validation precedes database access. Uncompressed UTF-8 JSON is
  measured during streaming, capped at 262,144 bytes with a 10-second deadline.
  The reader is cancelled/released on failure within that same deadline. Field
  limits, nullable/empty metadata policy, and sanitized 400/408/413/415/405/503
  error contracts are documented in README. Shared identity/safe-link helpers
  were extracted without changing the search adapter's rules. URLs must match
  the source identity and normalize only valid exact-host arXiv HTTP(S) links.
- Added dependency-free `node scripts/library-check.mjs`; no package script,
  dependency, or lockfile changed. Extended the existing Sites artifact check
  to compare every Drizzle SQL/meta file, including the newly generated ones.
  Full Worker output and Sites migration staging remain intact.

### Windows commands and actual results

| Command | Result |
| --- | --- |
| `npm.cmd run db:generate -- --name=paper_library` | Exit 0; generated the additive table/index migration and metadata |
| `npm.cmd run typecheck` | Initial exit 1 for two Worker runtime typing details; corrected `TextDecoder` options and guarded timer cleanup, then exit 0 |
| `npm.cmd run build` | Final exit 0; type checking, frontend, Worker ESM, and complete Sites staging passed |
| `node scripts/library-check.mjs` | Final exit 0; real local D1 save/list, concurrency, input validation, restart/reapply, and owned-state/process cleanup passed |
| `npm.cmd run papers:check` | Exit 0; existing offline search fixtures passed after helper extraction |
| `npm.cmd run sites` | Exit 0; packaged Worker/bindings/static routing and all migration artifacts passed |
| `npm.cmd run integrations` with `INTEGRATION_CHECK_OFFLINE=true` | Final exit 0, `passed_offline`; direct/proxied health/storage, disabled probes, and owned-process cleanup passed; no external probes invoked |
| `node scripts/library-check.mjs --transport-stress` | Exit 1; reproducible remaining local-proxy edge case described below, not suppressed |

The full integration command was run in PowerShell with this environment guard
(README also documents it):

```powershell
$priorIntegrationOffline = $env:INTEGRATION_CHECK_OFFLINE
try {
  $env:INTEGRATION_CHECK_OFFLINE = 'true'
  npm.cmd run integrations
  $integrationExit = $LASTEXITCODE
} finally {
  if ($null -eq $priorIntegrationOffline) {
    Remove-Item Env:INTEGRATION_CHECK_OFFLINE -ErrorAction SilentlyContinue
  } else {
    $env:INTEGRATION_CHECK_OFFLINE = $priorIntegrationOffline
  }
}
exit $integrationExit
```

- Successful library evidence:
  `.wrangler/library-check/65bb04d4-6f9d-4d16-8d6b-3b26ec83f602/result.json`.
  Two simultaneous FIRST saves returned `[201, 200]`, one row, the same UUID
  `2e2645fd-8d48-4627-a654-ae142d7eba67`, and the same timestamp
  `2026-10-08T22:51:42.083Z`. Full metadata round-tripped three ordered authors
  and a 52,500-character abstract, including quotes, Unicode, and line breaks.
  Repeated/versioned saves preserved the winner; nullable and legacy-ID records
  produced three total rows in stable order. Twenty-six invalid paper cases,
  malformed JSON, invalid UTF-8/media types, unknown fields, unsafe links,
  length-declared and chunked oversized bodies made no writes. Built-Worker
  checks covered missing DB, database errors, dishonest length, and stalled body.
- The successful run stopped PID 122680, restarted PID 120624 on the same
  isolated state, and GET the identical three records before any further POST.
  After stopping it, reapplying migrations, and starting PID 123176, GET again
  returned the same records, UUID, and timestamp. All owned processes stopped.
  Only this run's generated `state` directory was removed; `result.json` remains.
- Final full offline integration evidence:
  `.wrangler/integration-check/10733905-9506-4c33-a8ee-7a18b32eedb9/result.json`.
  Worker health/storage passed at port 49623, the Vite proxy at 49730, and all
  check-owned processes stopped. Earlier offline integration also passed at
  `.wrangler/integration-check/e127a151-9e9e-423e-b7cf-a81084406774/result.json`.

### Failures, remaining limitation, and next phase

- Git inspection under the restricted sandbox could not see the repository;
  normal authorized repository access succeeded. Build/local Wrangler commands
  used normal authorized access for project configuration and Wrangler logs.
- Early library-check runs exposed a local transport failure immediately after
  rejecting oversized chunked uploads: a following POST/PUT could return HTTP
  500 `Network connection lost` from Miniflare's core proxy, outside the Worker
  handler. Initial suspicion about early Content-Length rejection or stream
  cleanup alone was not confirmed: bounded reading, awaited cancellation,
  release-only cleanup, and connection-close experiments did not resolve it.
  No speculative connection headers, retries, dependency upgrades, or overrides
  were retained. The production reader uses actual byte counting, a shared
  deadline, and bounded cancellation.
- The default test asserts the 413 rejection, GETs the unchanged records, then
  successfully retries the *fixture's duplicate save as a separate test*; it is
  not an automatic retry of a failed HTTP request. It completes restart and
  migration-reapply checks. The additional `--transport-stress` mode instead
  sends a duplicate POST immediately after chunked rejection and fails visibly.
  Final reproduction evidence:
  `.wrangler/library-check/dd09027e-339a-44b6-b864-8b8957090ca1/result.json`:
  `POST HTTP 500, expected 200: local proxy: Network connection lost`.
  Its owned Worker stopped; failed isolated state is retained. Related
  [upstream proxy failures](https://github.com/cloudflare/workers-sdk/issues/15002)
  exist, but this does not establish an identical root cause. This edge case
  remains unresolved and needs a separately scoped local-tool investigation;
  hosted behavior has not been checked. A passing default test does not certify
  the immediate-write transport sequence.
- An earlier otherwise successful run hit Windows `EBUSY` while removing an
  owned SQLite shared-memory file after process shutdown. Bounded filesystem
  cleanup retries fixed that race; the final default run cleaned up successfully.
  Earlier failed run directories remain under `.wrangler/library-check/` for
  diagnosis. Normal `.wrangler/state`, real environment files, user processes,
  application data, bindings, and hosted configuration were not changed.
- The frontend is unchanged (build assets still `index-JeGgcMsp.js` and
  `index-DeEVgRB_.css`); prior browser/search and R2 restart evidence was reused.
  No browser/live arXiv/OpenAI check, PDF operation, push, deployment, or normal
  user-database migration was performed. Dependencies/audits were not changed;
  the documented baseline remains 3 high and 4 moderate development findings,
  zero production-only findings.
- For normal local use: `npm.cmd run db:migrate:local`, then `npm.cmd run dev`.
  Applying the new migration to existing normal local/hosted databases remains
  a deliberate startup/publication step, not part of the isolated checks.
  Phase 2B will add selection/save/browse UI. GitHub source handoff and hosted
  publication are separate phases. This phase is committed locally only.
