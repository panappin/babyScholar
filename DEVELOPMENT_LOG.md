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

## 2026-10-08 — Phase 2A transport investigation (no application fix)

### Baseline and reproduction

- Inspected applicable instruction locations (no `AGENTS.md` found), Git,
  package scripts, this log, README's limitation, bounded body reader, library
  handler, stress checker, and installed Wrangler/Miniflare source. Current
  `main` started at `73840f92e295e3602cf67ea7e37a497552a8c5a5`, ahead one of
  origin/main, with no tracked changes. The existing untracked Phase 0B.2 ZIP
  and folder were preserved. No history was amended or pushed.
- Version inspection commands: `node --version`, `npm.cmd --version`, and
  `node -e "for (const p of ['wrangler','miniflare','workerd','undici']) { console.log(p + ': ' + require(p + '/package.json').version) } console.log('Node bundled undici: ' + process.versions.undici)"`.
  Installed versions: Node v24.11.1, npm 11.6.2, Wrangler 4.148.0, Miniflare
  5.20261006.0-alpha, workerd 1.20261006.1, installed Undici 7.29.1, and Node's
  built-in fetch Undici 7.16.0. The controlled diagnostic uses Node v24.11.1's
  native `node:http` client, not either Undici implementation.
- Ran the existing command **unchanged**, before adding instrumentation:
  `node scripts/library-check.mjs --transport-stress` exited 1. The first
  immediate duplicate POST after the chunked 413 returned
  `POST HTTP 500, expected 200: local proxy: Network connection lost`.
  Evidence: `.wrangler/library-check/cfc97c09-2751-4c6e-a185-ad2833916a04/result.json`.
  Its owned Worker PID 122796 stopped; its generated state was subsequently
  removed after retaining this evidence. Older phase state/evidence was untouched.

### Controlled transport and handler observations

- Added `scripts/transport-investigation.mjs` and the small standalone
  `scripts/fixtures/transport-worker.mjs`. No application module was edited.
  The diagnostic generates temporary local Wrangler configurations and an
  observer wrapper in one owned UUID directory. The application variant imports
  the unchanged source Worker with isolated real D1; the minimal variant imports
  only the standalone bounded-reader fixture, with no D1, R2, React, Vite, or
  application/provider imports. Both use the installed runtime and the same
  compatibility date. Real bindings/configuration and environment files are not
  modified or copied into those temporary configurations.
- Requests carry fixed diagnostic labels. The wrapper records handler entry,
  exit/status, and a response marker, plus an in-memory trace for independent
  observation. It never logs request contents, configuration, secrets, or SQL.
  Client evidence records actual socket object identity, local/remote TCP ports,
  process PID, and `request.reusedSocket`. A one-socket native keep-alive Agent
  provides the reused connection; `agent: false` creates an observed new socket;
  a separate Node process provides the third comparison. All are loopback-only,
  with no client retries. A new `fetch()` call or delay is not used as evidence
  of a new connection.
- `node scripts/transport-investigation.mjs` was run twice. Both exited **1**
  (`transport_failure_reproduced`), retaining failures while continuing distinct
  integrity/health checks. Final evidence:
  `.wrangler/transport-investigation/ca8b974b-e3da-4a4b-b1ef-4026c2b07a61/result.json`.
  Earlier equivalent evidence:
  `.wrangler/transport-investigation/301d10f3-987f-484c-88a3-73baa8d69a93/result.json`.

Final application observations (same owned Wrangler PID 70396 throughout):

| First operation after chunked 413 | Verified client transport | Outcome | Reached handler? |
| --- | --- | --- | --- |
| New valid POST | PID 122780, socket 9 / local port 63763 reused | 500, proxy connection lost | No |
| New valid POST | New socket 16 / port 63777, distinct from upload socket 15 / port 63775 | 500, proxy connection lost | No |
| New valid POST | Separate PID 68660 / port 63785, distinct from upload PID 122780 / port 63784 | 500, proxy connection lost | No |
| Library GET | Same client socket 28 / port 63792 | 200 after proxy retry attempt 2 | Yes, once |
| Health GET | Same client socket 34 / port 63799 | 200 after proxy retry attempt 2 | Yes, once |

- Every upload reached the handler and returned 413 `body_too_large` with
  `no-store`. Each failed subsequent POST lacked both a handler entry and a
  response marker; the trace retained the earlier before/413 entries, ruling
  out an unnoticed handler-trace reset. Sanitized proxy logs separately record
  the connection failure. Native client reuse is therefore **not necessary**
  for this failure: fresh client TCP sockets and another client process fail too.
- Inspected installed `node_modules/wrangler/wrangler-dist/ProxyWorker.js`:
  it forwards requests to the UserWorker through its own `fetch` and automatically
  retries connection-level GET/HEAD failures, but not POST. The same policy is
  visible in the [official upstream ProxyWorker source](https://raw.githubusercontent.com/cloudflare/workers-sdk/main/packages/wrangler/templates/startDevWorker/ProxyWorker.ts).
  The installed source and actual logs explain why inserting a GET appeared to
  recover the earlier normal check: it can consume a failed internal attempt.
  We did not add or configure these runtime retries. GET/health thus returned 200
  to the client but still encountered an internal forwarding failure first.
- This distinguishes the observed client-to-Wrangler sockets from the separate
  Wrangler-to-UserWorker forwarding leg. The failed POST is localized to that
  forwarding path before handler entry. Internal stale-pool/unfinished-body
  handling is an inference, not a packet-level observation; the exact workerd/KJ
  connection lifecycle causing it remains unconfirmed. The older upstream issue
  linked in Phase 2A is not proof of the same underlying cause.

### No-write, recovery, and minimal reproduction

- Each oversized diagnostic upload was otherwise valid fixture JSON padded to
  327,680 bytes and sent in five 64 KiB chunks without Content-Length. Its arXiv
  identity was distinct from both subsequent valid fixtures, making unintended
  writes detectable. No actual paper/provider request was made.
- Every application case GET the library before rejection and again afterward.
  For immediate-POST cases, the first failure was recorded **before** the GET,
  not hidden by a preflight or retry. For the GET-first case, the sequence was
  explicitly before-GET → oversized POST → after-GET → valid POST → final-GET.
  Counts before/after the rejected upload and failed immediate POST were
  `0→0`, `1→1`, `2→2`; GET-first/health-first cases were `3→3`, `4→4`.
  Oversized identities were absent and every pre-existing fixture row was
  deeply compared unchanged. The failed immediate POST identities were absent.
- After those inspections, each case issued a **distinct new fixture POST**, not
  a retry of the failed request. All five returned 201; final GETs verified the
  exact metadata and resulting counts 1, 2, 3, 4, 5. Health and list requests also
  succeeded, and the same Worker stayed usable without restart. These recovery
  results do not make the first failed requests successful.
- The minimal Worker reproduced the same 413 → immediate POST 500 for reused,
  fresh, and separate-process clients; failed POSTs again did not enter its
  handler. Its immediate GET/health requests logged retry attempt 2 before 200.
  Releasing the reader without cancellation still reproduced the POST failure
  for reused and fresh sockets. This rules out D1, application imports, JSON
  validation, and `reader.cancel()` alone as necessary conditions. A subsequent
  small fully consumed POST returned 200 without restart.
- The minimal fixture uses the same 262,144-byte limit and 10-second deadline,
  stores no body content, stops reading at overflow, and never drains an
  unlimited upload. Consulted the official
  [Workers reader documentation](https://developers.cloudflare.com/workers/runtime-apis/streams/readablestreamdefaultreader/)
  for cancellation/release semantics. No supported application-specific defect
  or justified small production fix was established; the original bounded
  reader, validation, sanitized errors, and API contracts are unchanged.

### Verification, cleanup, and disposition

| Exact command | Result |
| --- | --- |
| `node scripts/library-check.mjs --transport-stress` | Exit 1, unchanged original reproduction |
| `node scripts/transport-investigation.mjs` | Exit 1 on both runs; 12 cases completed with retained failures and integrity checks |
| `node --check scripts/transport-investigation.mjs` | Exit 0 |
| `node --check scripts/fixtures/transport-worker.mjs` | Exit 0 |
| `node scripts/library-check.mjs` | Exit 0; normal concurrency/validation/restart/migration-reapply checks passed |

- Final normal-check evidence:
  `.wrangler/library-check/b64693a8-fec5-4296-a457-cb0b9c655e71/result.json`.
  Simultaneous first saves returned 201/200 with one record; three records
  survived restart and migration reapplication. Its disposable state was removed
  and only its owned processes stopped. This pass does not cover away the
  immediate-write failures demonstrated above.
- Both diagnostic runs stopped only their recorded child process trees and
  removed only their resolved, UUID-owned `temporary` tree, including test DBs,
  generated wrappers/configuration, and raw Wrangler logs. Sanitized client,
  handler, and proxy evidence remains in `result.json`; normal `.wrangler/state`,
  previous failed-check directories, user servers, and user data were preserved.
- No application fix was made, so build, paper fixtures, Sites artifacts, and
  full offline integration were not repeated; their unchanged-input Phase 2A
  evidence is retained. The requested `npm.cmd run papers` does not exist in
  the current manifest; the actual offline command is `npm.cmd run papers:check`.
  No manifest change was made to add an alias, and no live search command ran.
- **Phase 2B readiness remains blocked under the requested gate:** fresh-client
  POSTs also fail. Database integrity checks passed, but healthy later requests
  and a minimal reproduction do not establish reliable immediate fresh writes
  or unaffected hosted production. A separately scoped local-runtime fix or
  version-comparison investigation is needed before clearing this blocker.
  This task stops at diagnosis, with clearly failing diagnostics retained.
- Only the diagnostic script, minimal fixture, README guidance, and this appended
  record are committed on the existing branch. No frontend/application source,
  dependencies/lockfile, migrations/schema, secrets, real bindings, cloud
  resources, push, deployment, arXiv, or OpenAI operations changed. The audit
  baseline remains 3 high and 4 moderate development findings, zero production-only.

## 2026-10-08 — Phase 2B: Save controls and browsable Library UI

### Scope and implementation

- Inspected the project instructions, Git state, README, development history,
  shared search/library declarations and error contracts, frontend, Vite proxy,
  and the existing dependency-free browser verifier before editing. No
  `AGENTS.md` applies. Work began from `f26546c9f418ddaa37cdbf57cc966940ef39098f`
  on `main`; the pre-existing untracked Phase 0B.2 ZIP and folder were left
  untouched.
- Added `src/paper-identity.ts`, a browser-only canonical arXiv source-identity
  and safe-link helper. The React bundle imports only declaration-only types
  from `src/worker/paper-search-types.ts` and `src/worker/library-types.ts`; it
  does not import Worker runtime code.
- Updated `src/App.tsx` and `src/styles.css` with Search/Library tabs and
  per-result Save controls. The UI POSTs the exact `{ "paper": PaperSearchResult }`
  envelope to the relative `/api/library/papers` path. Both `201 {created:true}`
  and `200 {created:false}` retain the returned original `SavedPaper`; pending
  submissions are deduplicated by canonical arXiv source identity, not title or
  versioned URL. A successful response immediately merges into the local
  newest-first Library view.
- The Library loads from the authoritative relative GET endpoint, presents
  initial/loading/empty/loaded/error states and an explicit reload action, and
  preserves existing records after a read failure. Cards show the distinct
  application ID and canonical arXiv ID, ordered authors, nullable first-year,
  complete abstract, safe link/fallback, and saved time. Search and the
  Backend/D1/R2 indicators remain in place.
- Search, Library, and per-save requests have bounded browser timeouts, request
  IDs, and unmount cleanup. A late response cannot overwrite newer state. A
  timed-out or interrupted POST is reported as uncertain and reconciled with a
  GET before another save attempt; the client never automatically retries POST.
  Unexpected JSON, sanitized API errors, and network failures remain
  user-readable without exposing raw error details.
- Extended the existing no-dependency Chrome DevTools verifier rather than
  adding a test framework. It owns a UUID-scoped D1/Worker/Vite/Chrome setup,
  intercepts fixture search/library cases, and uses the actual Vite proxy plus
  isolated D1 for the final save/refresh/duplicate flow. It makes no arXiv or
  OpenAI request.

### Verification

| Command/check | Result |
| --- | --- |
| `npm.cmd run typecheck` | Exit 0 |
| `node --check scripts/frontend-search-browser-check.mjs` | Exit 0 |
| `npm.cmd run papers:ui:check` | Exit 0; isolated browser/UI/proxy check passed |
| `npm.cmd run build` | Exit 0; type checks, Vite frontend, Worker ESM, and Sites staging passed |
| `npm.cmd run sites` | Exit 0; existing Sites artifact/binding/migration check passed |
| Built frontend scan | Exit 0; no Worker runtime/binding markers found in `dist/frontend` |

- The final browser evidence is
  `.wrangler/frontend-search-browser-check/507ccde6-d3e6-4cdd-a0a4-86a607958d98/result.json`.
  It recorded fixture loading/empty/error/malformed/stale states, an existing
  save, a 200 duplicate response preserving ID/timestamp, and an interrupted
  POST that reconciled by GET without an automatic retry. It also completed the
  actual browser flow through the relative Vite proxy and isolated local D1:
  fixture result, Save, Library, browser refresh, then duplicate POST. The
  record ID remained `08a41d1d-ed79-4a41-9013-a2447136548a` with saved time
  `2026-10-08T23:47:08.197Z`. The verifier stopped only its Worker, Vite, and
  Chrome child PIDs.
- Desktop and 375px narrow screenshots from that evidence were inspected. The
  Search/Library controls and cards remain readable, and the narrow layout had
  no horizontal overflow.
- The browser harness initially exposed a DevTools object-serialization issue
  in a selector wait and React Strict Mode's aborted first Library load. The
  verifier now waits on Boolean predicates and services the newest live paused
  Library request; it does not manufacture a response for an already-aborted
  interception. The final run above is the passing result.
- Phase 2A's normal `library-check.mjs`, restart-persistence evidence, paper
  checks, offline integrations, and backend/API behavior were reused rather
  than rerun: no Worker, schema, migration, binding, dependency, lockfile, or
  API source changed. No live arXiv/OpenAI request, normal user-state migration,
  runtime experiment, push, deployment, or hosted configuration change occurred.

### Remaining limitation

- The documented local Wrangler/Miniflare transport failure after an oversized
  chunked upload remains deliberately unresolved and its failing diagnostic is
  retained. The minimal Worker reproduces the failure before handler entry,
  including fresh-client requests. This normal UI work does not establish that
  hosted production is unaffected; no retry, dependency upgrade, runtime change,
  or masking of the diagnostic was added. The audit baseline remains 3 high and
  4 moderate development-tool findings, with zero production-only findings.

## 2026-10-09 - Phase 3A: original-PDF upload and private retention backend

### Scope and design

- Inspected the project and ancestor instruction paths (no `AGENTS.md`), Git
  status, README, existing development history, schema/migrations, Worker
  router/storage helpers, generated binding types, and isolated checks before
  editing. Work began at `d11d14a6e61fad7607923b6408eda74343d2693f` on a clean
  tracked `main`; the pre-existing untracked Phase 0B.2 ZIP/folder were left
  untouched.
- Added `uploaded_documents` to `db/schema.ts` and generated the additive
  `drizzle/0002_uploaded_documents.sql` plus `drizzle/meta/0002_snapshot.json`
  and journal entry. The new table has an application UUID, original display
  filename, original byte count, lowercase SHA-256, private object key, UTC
  upload time, and `stored` status. A unique object-key index and
  `(uploaded_at, id)` index support deterministic private storage and stable
  newest-first listing. Earlier SQL, snapshots, journal entries, and tables
  remain unchanged.
- Added declaration-only public contracts in `src/worker/document-types.ts`.
  `UploadedDocument` returns only ID, filename, byte count, SHA-256, upload
  time, and `stored` status; the R2 object key is Worker-internal.
- Added the collection routes `POST/GET /api/documents` and
  `GET /api/documents/:id/pdf`. The POST body is read from the actual incoming
  stream before multipart parsing, with a 10-second deadline and a
  10,551,296-byte cap (10 MiB file plus 64 KiB multipart allowance), regardless
  of `Content-Length`. The rebuilt bounded Request is then parsed for exactly
  one `file` field. It rejects absent/multiple/extra fields, empty data,
  filenames longer than 255 Unicode code points or containing NUL, files over
  10 MiB, and data not beginning `%PDF-`. MIME type and filename alone are not
  trusted. The header check is intentionally not PDF extraction or a claim that
  later parsing will succeed.
- The Worker generates `uploaded_documents/<application UUID>.pdf`, stores the
  exact original bytes in `PAPER_BUCKET`, then inserts the parameterized D1 row.
  It returns HTTP 201 only after both writes. If the D1 insert fails after a
  successful R2 put, it attempts one delete of only that generated key and
  returns a sanitized 503; D1/R2 are not atomic, so failed cleanup can leave a
  private orphan with no D1 record. No write is retried. Stored rows also must
  reference the deterministic key for their own UUID before a PDF can be read.
- PDF retrieval validates a canonical application UUID, distinguishes a missing
  D1 record from a missing R2 object, and sends only `application/pdf`,
  `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and a
  server-generated `document-<UUID>.pdf` attachment name. Submitted filenames
  are never used as paths or response attachment names.
- Added `npm.cmd run documents:check` without dependencies or lockfile changes.
  Its 512-byte minimal one-page fixture is authored in the repository script
  and released as CC0-1.0. The check uses a UUID-scoped local D1/R2 state tree,
  owns/stops only its Wrangler child processes, and removes only its successful
  owned state while retaining sanitized result evidence.

### Verification

| Command/check | Result |
| --- | --- |
| `npm.cmd run db:generate -- --name=uploaded_documents` | Exit 0; generated only `0002_uploaded_documents.sql`, its snapshot, and the journal entry |
| initial `npm.cmd run typecheck` | Found that generated Worker declarations do not name the DOM `FormDataEntryValue` alias |
| corrected `npm.cmd run typecheck` | Exit 0; runtime file guard now accepts `unknown` at that generated-type boundary |
| `node --check scripts/document-check.mjs` | Exit 0 |
| `npm.cmd run build` | Final exit 0; type checks, Vite frontend, Worker ESM, and Sites staging passed |
| `npm.cmd run documents:check` | Final exit 0; isolated D1/R2 document check passed |
| `npm.cmd run sites` | Exit 0; callable Worker, static routing, bindings, and complete migration metadata passed |
| `npm.cmd run papers:check` | Exit 0; offline parser/validation/cache/bounded-body checks passed |
| `node scripts/library-check.mjs` | Exit 0; normal save/duplicate/restart/migration-reapply checks passed |

- Final document evidence is
  `.wrangler/document-check/027924b2-d126-4060-8141-0601e1accf3f/result.json`.
  It verified an empty list; first upload ID
  `83efb7c6-6fc0-4468-9907-5b56750c185b`, 512 bytes, SHA-256
  `277b943327ca968c69c561692ecaf74ee84a266f2d96d5dd1b2be5623424d8d0`;
  a distinct second upload; exact original-byte downloads; newest-first list;
  a replacement Worker whose first document operation was a read; and migration
  reapplication preserving both rows and hashes. It stopped only PIDs 69100,
  119996, and 117680 and removed only its UUID-owned test state.
- The same check exercised missing storage (503), failed R2 put without a D1
  query (503), failed D1 insert with exactly one request-key cleanup attempt
  (503), missing R2 object (404), a chunked dishonest-`Content-Length` body
  overage before any storage access (413), stalled body timeout (408), missing
  and multiple file fields, non-PDF/empty files, long filename, file limit, and
  local raw body limit. Invalid cases retained the two successful records;
  production object keys and errors were not logged.
- Search/library checks were rerun because this phase changes the common Worker
  router and migration set. Browser UI, live arXiv/OpenAI, generic storage,
  normal user-state migration, deployment, hosted checks, and push were not
  repeated. No normal `.wrangler/state`, secret, binding, dependency, lockfile,
  frontend, or cloud resource changed.

### Remaining limitation

- The prior local Wrangler/Miniflare failure immediately after a rejected
  oversized **chunked** upload remains an explicit failing diagnostic and was
  not rerun or altered. The document check's direct built-Worker stream case
  verifies the bounded handler without D1/R2 access, and its local body-limit
  request used a fixed byte body; neither result clears the known local
  transport limitation or establishes hosted behavior. No retry, runtime
  experiment, dependency change, or diagnostic suppression was introduced.

## 2026-10-08 — Phase 3B: Worker PDF text extraction and D1 persistence

### Scope and implementation

- Inspected the repository, Git state, existing document routes/types,
  migrations, local Worker/Sites build staging, isolated checks, README, and
  development history before editing. No project or ancestor `AGENTS.md` was
  present. The pre-existing untracked Phase 0B.2 ZIP/folder remains untouched;
  normal `.wrangler/state`, real local secret file, bindings, frontend, and
  hosted configuration were not changed.
- Added the only runtime dependency, exact `unpdf@1.8.1`. Its bundled
  serverless PDF.js build is bundled by Wrangler; no canvas, native filesystem,
  remote font/asset fetch, PDF rendering, PDF JavaScript evaluation, OCR, or
  additional service was added. The Worker sets range/background fetches,
  font-face/system fonts, XFA, and eval off, and releases each PDF loading task.
- Replaced the former TypeScript-emission-only Worker build with
  `scripts/build-worker.mjs`, which uses Wrangler `deploy --dry-run --metafile`.
  TypeScript remains the type-checker, while the deploy-compatible bundle now
  resolves UnPDF into `dist/worker/index.js` and `bundle-meta.json`; Sites
  staging copies that complete artifact to `dist/server`.
- Before adding the D1 table or API routes, `scripts/unpdf-worker-proof.mjs`
  bundled a minimal Worker through the same Wrangler artifact path, started the
  emitted bundle locally, and extracted a valid two-page fixture. The final
  proof passed with PDF.js `6.1.200`, no bare UnPDF import, known separate page
  phrases, and non-ASCII `Café`. The original fixture generator is
  `scripts/fixtures/pdf-fixtures.mjs`, released as CC0-1.0.
- Added `document_extractions` to `db/schema.ts` and generated the additive
  `drizzle/0003_document_extractions.sql`, snapshot, and journal entry. The
  document ID primary key permits exactly one successful record per stored
  document; each row persists source SHA-256, `unpdf`/runtime version, UTC
  extraction time, page count, and ordered one-based page JSON. Earlier SQL,
  snapshots, and applied migrations remain unchanged.
- Added declaration-only `DocumentExtraction`/page/response types and the
  Worker-only parser and route modules. `POST /api/documents/:id/extract`
  accepts no body, checks a cached D1 result before R2/parser work, validates
  the recomputed R2 SHA-256, then returns 201 for a persisted result or 200 for
  the immutable original. Conflict-safe D1 persistence leaves one authoritative
  record under concurrent first calls. `GET /api/documents/:id/text` separates
  `document_not_found` from `extraction_not_found`; all responses are no-store
  and all SQL remains parameterized.
- Extraction rejects rather than truncates over 100 pages, 500 KiB extracted
  UTF-8 text, or 1 MiB serialized page data. A 20-second deadline bounds async
  parser operations but cannot interrupt synchronous PDF.js CPU already on the
  Worker event loop. Clear sanitized errors cover absent R2, hash mismatch,
  password protection, unusable image-only text, parser failure, limits,
  deadline, and D1/storage failure. Failed attempts retain original bytes and
  never replace an existing successful extraction.
- Added `extractions:check` and strengthened the Sites artifact check. The
  frontend artifact is asserted free of parser runtime markers; Sites bundle
  metadata must include UnPDF with no bare runtime import. No frontend code was
  changed.

### Verification

| Exact command/check | Result |
| --- | --- |
| `npm.cmd install unpdf@1.8.1 --save-exact` | Exit 0; one dependency added, lockfile updated |
| `npm.cmd run unpdf:proof` | Final exit 0; actual emitted local Wrangler Worker parsed the CC0 two-page fixture, PDF.js 6.1.200 |
| `npm.cmd run db:generate -- --name=document_extractions` | Exit 0; generated only `0003_document_extractions.sql`, snapshot, and journal entry |
| `node --check scripts/extraction-check.mjs` | Exit 0 |
| `node --check scripts/unpdf-worker-proof.mjs` | Exit 0 |
| `npm.cmd run typecheck` | Exit 0 |
| `npm.cmd run build` | Exit 0; type checks, Vite build, Wrangler dry-run Worker bundle, and Sites staging passed |
| `npm.cmd run sites` | Exit 0; binding/static routing/migration checks plus packaged UnPDF and parser-free frontend assertions passed |
| `npm.cmd run extractions:check` | Final exit 0; isolated real local Worker/D1/R2 extraction check passed |
| `npm.cmd run documents:check` | Exit 0; existing isolated upload/list/download/restart/migration check still passed |
| `npm.cmd audit --json` | Exit 1 because findings were reported: unchanged count of 3 high and 4 moderate development-tool findings |
| `npm.cmd audit --omit=dev --json` | Exit 0; 0 production-only findings |

- Final extraction evidence:
  `.wrangler/extraction-check/5df2f533-201d-45c4-83e6-481df8a879f6/result.json`.
  It used only UUID-scoped state and owned Wrangler processes. It proved the
  actual two-page ordered text, SHA linkage, GET-before/after extraction, 201
  then cached 200, two concurrent first requests yielding 201/200 with the same
  record, byte-identical PDF downloads, restart read before another extraction,
  migration reapplication, no-body enforcement, corrupt/signature-only,
  encrypted, image-only, page/text limits, and offline missing-object/hash/D1
  errors. The owned state was removed after the pass.
- During harness construction, a local variable shadowed Node `process`, then a
  fixed port was found to be unsuitable for an isolated checker. Both were
  check-only defects corrected before the passing Worker proof. Sandbox-local
  Wrangler runs also could not write their normal user-profile diagnostic log;
  the same owned commands passed when permitted to use that standard Wrangler
  log location. Neither issue was an application/runtime behavior change.
- PDF.js emitted its standard-font-data warning for the deliberately basic
  Type1 fixture. Text extraction still passed in the actual local Worker; no
  remote font URL was configured or fetched. This fixture warning is retained
  in ignored local evidence rather than suppressed.
- Search, library, browser, live arXiv/OpenAI, hosted, normal-storage, and
  known transport-stress checks were not repeated: this backend slice did not
  alter their inputs or behavior. The new document migration/router did justify
  rerunning the isolated document retention check.

### Remaining limitation

- The pre-existing local Wrangler/Miniflare oversized-chunked-upload transport
  failure remains documented, unchanged, and unrerun. This Phase 3B check does
  not establish hosted behavior for that unrelated proxy fault. No retry,
  runtime update, audit override, dependency upgrade beyond UnPDF, deployment,
  secret change, provider call, or frontend/metadata feature was introduced.

## 2026-10-08 — Phase 3C: source-grounded document metadata (backend only)

### Scope and implementation

- Inspected the repository, existing Phase 3A/3B document types/routes,
  persisted extraction contract, Worker bindings, generated types, migrations,
  README, development history, and project/ancestor instruction paths before
  editing. No `AGENTS.md` was present. The existing ignored Phase 0B.2 ZIP and
  folder, real local secret file, normal `.wrangler/state`, bindings, frontend,
  dependencies, lockfile, and hosted configuration remain unchanged.
- Added the additive `drizzle/0004_document_metadata.sql`, generated Drizzle
  snapshot, and journal entry. `document_metadata` persists one immutable result
  per document with source/extraction provenance, exact selected-page/clip
  facts, configured model, prompt version, time, nullable values, evidence, and
  warnings. `document_metadata_claims` is a short-lived D1 owner-token lease;
  only its owner can persist/release, so it prevents duplicate in-flight live
  calls without changing existing metadata.
- Added Worker-only source selection, strict Responses adapter, runtime output
  validation, and metadata route modules. `POST /api/documents/:id/metadata`
  requires an empty body and an existing extraction; it returns 201 on creation
  and 200 from cache. `GET` returns only stored metadata. Unknown document,
  missing extraction/metadata, claim-in-progress, missing configuration,
  provider categories, refusal/incomplete/malformed output, and storage errors
  remain separate sanitized API results.
- Metadata uses at most the first three persisted ordered pages and 24,000 UTF-8
  bytes, with code-point-safe clipping. The prompt treats PDF text as untrusted
  data and forbids filename/current-date/reference-list/web/model-memory
  inference. It sends no tools or PDF bytes, uses `store:false`, strict JSON
  Schema, one 25-second operation, a 256 KiB response cap, no automatic retry,
  and `reasoning.effort: none` only for the configured `gpt-6-luna` model.
  Runtime validation normalizes whitespace, requires source-matching evidence
  for known values, preserves author order, and requires a warning for each
  null/unknown field.
- Added `metadata:check` (isolated Worker/D1/R2 and loopback mock only) and
  `metadata:live` (one deliberate provider-capable POST, no retry). The latter
  reuses only the existing ignored Worker key/model; it never reads, prints,
  writes, rotates, or places the key in Vite/build/evidence output. The Sites
  artifact check now rejects metadata-provider/key markers in the frontend.

### Verification

| Exact command/check | Result |
| --- | --- |
| `npm.cmd run db:generate -- --name=document_metadata` | Exit 0; generated only `0004_document_metadata.sql`, its snapshot, and journal entry |
| `node --check scripts/metadata-check.mjs` | Exit 0 |
| `node --check scripts/metadata-live-check.mjs` | Exit 0 |
| `node --experimental-strip-types --input-type=module` (inline UTF-8 selector-boundary assertion) | Exit 0; 24,000-byte policy stopped before a partial multibyte code point |
| `npm.cmd run typecheck` | Final exit 0 |
| `npm.cmd run build` | Final exit 0; type checks, frontend, Worker ESM dry-run, and Sites staging passed |
| `npm.cmd run sites` | Final exit 0; callable Worker/static routing/bindings/migration artifact checks passed, including no metadata provider/key markers in frontend files |
| `npm.cmd run metadata:check` | Final exit 0; isolated real Worker/D1/R2/mocked-Responses matrix passed |
| `npm.cmd run documents:check` | Exit 0; existing upload/list/download/restart/migration check passed after shared router/migration work |
| `npm.cmd run extractions:check` | Final exit 0; existing extraction/restart/migration/original-byte check passed (the pre-existing PDF.js standard-font fixture warning remains non-fatal) |
| `npm.cmd run metadata:live` | Exit 1; exactly one authorized provider-capable metadata POST, no retry |

- Final offline metadata evidence is
  `.wrangler/metadata-check/92c55f37-7828-4c7f-9233-6c29687e6003/result.json`.
  It verifies source-supported known fields and quotes, all-null unknown fields,
  selected `[1,2,3]` clipping, no text/PDF mutation, cache GET/POST behavior,
  one provider call under concurrent POSTs, restart-before-read, migration
  reapplication, missing storage/configuration/text, wrong evidence, malformed
  JSON, refusal, incomplete response, and provider failure. The mock confirms
  `store:false`, 4096 maximum output tokens, no tools, and strict schema shape.
- The single live invocation used a fresh, UUID-scoped Worker/D1/R2 state and
  the already configured model/key. Its sanitized evidence is
  `.wrangler/metadata-live-check/1ed9a2d2-1c1d-408c-a814-beddf8ee7706/result.json`.
  It reached the local Worker, uploaded and extracted the CC0 fixture, then the
  metadata endpoint returned 502 and persisted no metadata row. Read-only local
  observability status metadata showed an upstream HTTP 200 and the local
  metadata POST HTTP 502. The raw provider body was intentionally neither
  printed nor retained, so the exact provider error/shape cannot be recovered
  without a second request.
- Comparing the 200/502 evidence with code identified a justified parser gap:
  the new adapter accepted only top-level `output_text`, while the existing
  project Responses parser also accepts REST `output[].content[].text`. The
  adapter now accepts both forms; the offline mock was changed to the REST
  nested form and passed all final checks. This is an evidence-based fix, not a
  claim that it explains the one live failure conclusively. The live checker now
  records only sanitized status/error kind for any future deliberate run and
  retries cleanup of its own state, but it was not rerun to respect the
  one-request limit. The temporary live-check state was removed; its sanitized
  result remains ignored for audit history.

### Remaining limitation and next verification

- No successful live Phase 3C metadata response was obtained in this phase.
  A future explicitly authorized `npm.cmd run metadata:live` should confirm the
  corrected REST parser with one new deliberate request; it must not be treated
  as already verified. The existing Phase 2A local Wrangler/Miniflare
  oversized-chunked-upload transport limitation also remains unchanged and does
  not establish hosted behavior. No frontend work, OCR, PDF processing change,
  dependency update, audit action, migration of normal user state, push,
  deployment, hosted secret change, arXiv call, or extra OpenAI call occurred.

## 2026-10-08 — Phase 3C live-verifier offline observability repair

### Retained live-attempt evidence

- Started from committed Phase 3C `9f9b856fcbc6cc7e0d117e9198243e95de71bd8b`
  with the pre-existing uncommitted cache-guard update in
  `scripts/metadata-live-check.mjs`. No project or ancestor `AGENTS.md` was
  present. The untracked Phase 0B.2 ZIP/folder remains untouched.
- The retained additional-live-attempt record
  `.wrangler/metadata-live-check/8c62ecbc-47aa-44f1-b464-cd7a557ae240/result.json`
  establishes only: isolated migrations completed, an owned Worker started and
  stopped, the verifier marked one provider-capable metadata POST attempt, and
  it exited with `AssertionError`. It does **not** record an application POST
  status/error kind, provider response, assertion stage/field, a metadata GET,
  or persistence. Its isolated runtime state was already deleted. Those details
  are unknown; this verifier exit alone does not establish that the application
  failed.
- The prior original live-attempt evidence remains preserved separately at
  `.wrangler/metadata-live-check/1ed9a2d2-1c1d-408c-a814-beddf8ee7706/result.json`.
  No discarded provider output was reconstructed or printed.

### Verifier repair

- Reworked only `scripts/metadata-live-check.mjs` plus its focused offline
  verifier/documentation command. Before every request assertion it now records
  a named stage, sanitized application status/error kind, no-store/JSON shape,
  `created` flag, and compact fixture-only metadata fields. It records expected
  and actual CC0 fixture fields, evidence counts, the first mismatch name, and
  a persisted-result GET before deliberately failing a fixture comparison.
  Headers, keys, raw provider envelopes, and source text are excluded.
- The cache path now stops only its first owned Worker, restarts the same
  isolated state with `--var OPENAI_API_KEY:` (empty), GETs the saved result
  before any cached POST, and only then verifies the cached `200`/
  `created:false` result. Consequently, the cache POST has no usable key and
  cannot start a provider request. Cleanup saves diagnostics before and after
  deleting only the UUID-owned state.
- Added `metadata:live:offline`, which invokes the real verifier with only a
  loopback Responses mock and a non-usable test sentinel. It covers a successful
  persistence/cache path, an intentionally valid-but-fixture-mismatched title,
  and a provider-originated application error. It does not read or send the
  real local key.

### Offline verification

| Exact command/check | Result |
| --- | --- |
| `node --check scripts/metadata-live-check.mjs` | Exit 0 |
| `node --check scripts/metadata-live-verifier-check.mjs` | Exit 0 |
| `npm.cmd run typecheck` | Exit 0 |
| `npm.cmd run metadata:live:offline` | Exit 0; all three isolated verifier scenarios passed their expected outcomes |

- Success evidence:
  `.wrangler/metadata-live-check/fcbe6511-bded-4076-a525-8afb0108a5b5/result.json`.
  The mock received one request; POST was 201, GET was 200 and matched the
  persisted result, then the empty-key restart GET was 200 and cached POST was
  200 with `created:false` and the same metadata. Its owned state was removed.
- Fixture-mismatch evidence:
  `.wrangler/metadata-live-check/4d8b460d-49ae-47b6-8d7c-7fd605b82d64/result.json`.
  It intentionally exited 1 at `fixture-field-comparison` with mismatch
  `title`, while preserving POST 201, GET 200, and matching persisted metadata
  diagnostics before cleanup. Its owned state was removed.
- Application-error evidence:
  `.wrangler/metadata-live-check/44e177fe-e8f5-49fc-8220-99ac0c99fcb0/result.json`.
  Its mock made one request; the application returned 502
  `metadata_provider_failure`, and the subsequent GET returned 404
  `metadata_not_found`. Its owned state was removed.
- `npm.cmd run metadata:live`, `npm.cmd run integrations`, and every other
  provider/connectivity probe were deliberately **not** run. No OpenAI/arXiv
  request, application schema/parser/model/fixture/dependency change, build,
  frontend change, normal user-state operation, push, or deployment occurred.
  No concrete application defect was identified; a future live run remains a
  separate authorization decision.

## 2026-10-08 — Phase 3C authorized live metadata verification

- With explicit one-request authorization, ran `npm.cmd run metadata:live`
  once from repaired-verifier commit
  `0b43c5f3dc7111b7186233f366be1b494dc3eaac`. It exited 0 and saved sanitized
  evidence at
  `.wrangler/metadata-live-check/bcc7c3c3-b7e3-44ed-985f-adf8d4db8b19/result.json`.
  The verifier recorded one provider-capable metadata POST (`liveProviderRequests: 1`)
  and no retry. It does not retain a separately verifiable upstream request
  count or raw provider envelope.
- The application metadata POST returned HTTP 201 with `created:true` and no
  application error kind. The owned CC0 fixture's title, ordered authors, year,
  and abstract all matched expected values; source SHA-256, selected pages,
  clipping status, prompt version, configured-model presence, and each field's
  source-evidence indicator also matched.
- Before evaluating completion, the verifier performed a read-only metadata GET:
  it returned HTTP 200 with no error and matched the initially persisted
  metadata. It then stopped only its owned Worker, restarted the same isolated
  state with `OPENAI_API_KEY` explicitly empty, confirmed the saved metadata by
  GET (HTTP 200), and made the cached POST. That POST returned HTTP 200 with
  `created:false` and preserved the original metadata and timestamp-bearing
  cached result (`cachedPostMatchesInitial: true`). The verifier removed only
  its UUID-owned runtime state during cleanup.
- README's existing local command and cache-safety guidance remains accurate;
  no application source, dependencies, model/key configuration, normal user
  state, frontend, migration, push, deployment, or additional provider request
  occurred. The pre-existing local Wrangler/Miniflare oversized-upload
  transport limitation remains unchanged.
