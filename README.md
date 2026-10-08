# AI Research Assistant

Phase 1B provides a React/TypeScript research-paper search page backed by arXiv, alongside persistent local D1/R2 checks and the Worker backend. Saving papers, PDF processing, summaries, and Q&A remain later work.

## Prerequisites

- Windows PowerShell (the environment used to create this scaffold)
- Node.js 22.12 or newer (verified with Node.js 24.11.1 and npm 11.6.2)
- npm, installed alongside Node.js

This PowerShell environment blocks the `npm.ps1` shim. Use `npm.cmd` in the commands below; this avoids changing the execution policy.

## Install and run locally

```powershell
npm.cmd install
npm.cmd run db:migrate:local
npm.cmd run dev
```

Then open <http://localhost:5173>. The page shows backend, D1, and R2 connection indicators plus an explicit research-topic/keywords search form. It requests `/api/health` and `/api/storage/status` using relative URLs; Vite proxies `/api` to the local Worker at <http://127.0.0.1:8787>. Requests time out after 10 seconds and show failure states. A storage component can fail independently of the others.

Stop both development processes with `Ctrl+C`.

No Cloudflare login, hosted resource, or S3 credential is needed. These commands use Wrangler's `--local` mode. Local state and hosted data are separate; these local identifiers do not provision or identify production resources.

## Local bindings and migrations

| Binding | Local identifier | Purpose |
| --- | --- | --- |
| `DB` | database name `ai-research-assistant-local`, ID `local-ai-research-assistant` | D1 database |
| `PAPER_BUCKET` | bucket `ai-research-assistant-papers-local` | R2 object storage |

`wrangler.jsonc` explicitly sets both bindings to `remote: false`. The development Worker and `db:migrate:local` both use **`.wrangler/state`** via `--persist-to`; Wrangler stores D1 under `v3/d1` and R2 under `v3/r2` below it. Restarting the Worker preserves this data. The entire `.wrangler/` directory is ignored by Git.

`db/schema.ts` defines `storage_probes(id TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)`. Drizzle Kit generates SQL into `drizzle/*.sql` and generation history into `drizzle/meta/**`. The initial migration is `drizzle/0000_storage_probe.sql`; it contains only schema DDL. Wrangler separately tracks applied migrations in its D1 migration table. Probe inserts are never part of a migration or runtime initialization.

```powershell
# After a deliberate schema change, generate a NEW migration and inspect its SQL:
npm.cmd run db:generate -- --name=describe_the_change
# Apply committed migrations to the local database, not a remote database:
npm.cmd run db:migrate:local
# Regenerate binding/runtime types after changing Wrangler bindings:
npm.cmd run worker:types
```

Keep applied SQL and `drizzle/meta/**` intact. Future schema changes add migrations; do not edit an already applied migration or use runtime table creation. Commit the migration files and generated `worker-configuration.d.ts` alongside source changes. Drizzle ORM and Kit are development dependencies used only for schema generation; the Worker uses the actual D1/R2 binding APIs directly.

## Storage status and persistence check

`GET /api/health` remains `200 {"status":"ok"}`. `GET /api/storage/status` performs a read-only query against `storage_probes` and an R2 `list({limit: 1})`. On success:

```json
{"status":"ok","d1":{"status":"ok"},"r2":{"status":"ok"}}
```

A missing binding or failed operation returns HTTP 503 with independent component results and `binding_missing` or `operation_failed`. For example, before migrations are applied, D1 fails while R2 can still succeed. No status request writes data.

```powershell
npm.cmd run storage:check
```

`scripts/storage-check.mjs` uses the same `wrangler.jsonc`, its own available loopback ports, and a fresh `.wrangler/storage-check/<UUID>/` state directory per run. It applies the migration, verifies HTTP health/storage directly and through its own Vite proxy, and confirms the probe routes return 404 without a flag. It then starts a Worker with `--var LOCAL_STORAGE_PROBE:true`, writes one unique row and a 53-byte object, and compares both. It stops that process tree, restarts against exactly the same state, and reads both values **before any rewrite**. It then reapplies migrations and checks both again.

After success, it deletes only its UUID row and `__storage_probes/<UUID>.bin` object, verifies both are absent, and stops only processes it started. On Windows, it uses `taskkill /PID <owned-child-PID> /T /F` for the restart and process cleanup, so persistence is also checked across an abrupt process stop. Its state directory and `result.json` are retained for inspection. A failed run exits nonzero, attempts cleanup if its Worker is still available, and reports retained state if cleanup fails. The command runs unattended; allow it to finish so its cleanup can run.

The test-only `/api/__local/storage-probe/<UUID>` routes require the explicit `LOCAL_STORAGE_PROBE=true` binding and a loopback request hostname; the flag is absent by default and from committed Wrangler configuration. Do not enable it for ordinary development or hosted use. SQL values are bound to prepared statements, with one statement per `prepare()` call. Node filesystem/process code lives only in the verification script.

The script supplies `LOCAL_WORKER_ORIGIN` to its own Vite process to proxy its selected test port. Normal development needs no environment file or variables and still uses port 8787.

## Checks and production builds

```powershell
npm.cmd run typecheck
npm.cmd run build
```

The production artifacts are:

- Frontend static assets: `dist/frontend/`
- Worker-compatible ESM module: `dist/worker/index.js` (with `dist/worker/index.js.map`)

The Worker exports a default object with a callable `fetch(request, env)` handler. `wrangler.jsonc` points local development at `src/worker/index.ts`. For a later Sites handoff, retain the entire **`dist/worker/`** directory: `index.js` imports its sibling Worker ESM modules. Also retain `dist/frontend/`, `drizzle/*.sql`, and `drizzle/meta/**`. No deployment is configured or performed in this phase.

## arXiv paper search API

`GET /api/papers/search?q=<plain-text-keywords>` is the Phase 1A paper-search
endpoint used by the Phase 1B frontend. For example, with the local Worker running:

```powershell
Invoke-RestMethod 'http://127.0.0.1:8787/api/papers/search?q=graph%20neural%20networks'
```

It returns the first 10 arXiv results in relevance order:

```json
{
  "provider": "arxiv",
  "query": "graph neural networks",
  "papers": [{
    "id": "2401.01234",
    "title": "Example title",
    "authors": ["Example Author"],
    "year": 2024,
    "abstract": "Example abstract",
    "url": "https://arxiv.org/abs/2401.01234v2",
    "pdfUrl": "https://arxiv.org/pdf/2401.01234v2.pdf"
  }]
}
```

`q` is required, is Unicode-NFC-normalized, has collapsed whitespace, and is
limited to 200 Unicode characters. It accepts *plain text*, not arXiv's advanced
query language: Unicode letters/numbers become individually quoted `all:` terms
joined by server-generated `AND`; punctuation, quotes, field prefixes, wildcards,
and supplied boolean syntax are separators. URL encoding is used in addition to,
not instead of, that policy. Invalid input returns JSON HTTP 400 before any
upstream request.

The adapter parses Atom entries in order, including every author, title, summary,
and `published` year (first submission, never `updated`). `id` is a stable modern
or legacy arXiv identifier with its `vN` suffix removed; supplied abstract/PDF URLs
retain their version and are normalized to HTTPS only for exact `arxiv.org` or
`www.arxiv.org` hosts. Missing optional metadata is an empty string/array or
`null`. A valid empty feed is `200` with an empty `papers` array; an Atom error
feed is an upstream failure even if it has HTTP 200.

Outbound calls have a 10-second whole-operation timeout (including body reading),
a 1 MB response limit, and no automatic retries. Invalid/malformed/upstream and
network failures return sanitized JSON HTTP 502; timeouts return 504. A successful
response is held in a small in-memory cache for five minutes, identical in-flight
requests are shared, and distinct upstream calls are serialized at least three
seconds apart. Those controls apply only within one Worker isolate; they are not a
deployment-wide rate limiter. This follows arXiv's documented API defaults and
request limits; later hosted work will need any cross-isolate coordination it
requires. See the [arXiv API manual](https://info.arxiv.org/help/api/user-manual.html)
and [Terms of Use](https://info.arxiv.org/help/api/tou.html).

```powershell
# Offline fixtures and mocked fetches only; no network requests:
npm.cmd run build:worker
npm.cmd run papers:check

# Starts and stops its own local Worker, then makes exactly one arXiv search:
npm.cmd run papers:live
```

`papers:check` covers Atom namespaces/entities, modern and legacy IDs, ordered
authors, published-year selection, absent links, input validation with no fetch,
empty/error/malformed feeds, HTTP/network errors, body-read timeout, response
size limit, cache behavior, in-flight deduplication, and three-second spacing.

## Research-paper search interface

The local page has a labeled **Research topic or keywords** form and searches
only when you select **Search** or press Enter. It uses a relative
`/api/papers/search` URL with `URLSearchParams`; it does not call OpenAI, search
on input changes, or run on page load. The browser repeats the endpoint's
plain-text validation before sending: an input must contain letters or numbers,
and is normalized/limited to 200 Unicode characters.

While a request is pending the button is disabled, duplicate submissions are
ignored, and the submitted query remains attached to its loading, result,
empty, or error state even if the input is edited afterward. The browser aborts
an in-flight search on unmount and has a 20-second client timeout to allow for
the Worker's upstream timeout and local arXiv pacing.

Each result renders its title, ordered authors, first-submission year, complete
abstract, and an arXiv link when available. The year note is deliberate:
arXiv's `published` value reflects the first submission. Missing authors, year,
abstract, or link receive clear unavailable text rather than made-up metadata.
Links open in a new tab with `noopener noreferrer`; provider and metadata are
ordinary React text, never injected HTML.

For a manual local check, start `npm.cmd run dev`, open <http://localhost:5173>,
enter `graph neural networks`, and press Enter. Confirm the loading text, paper
cards, full abstracts, link behavior, blank-input feedback, and the existing
connection indicators. Do not expect a fixed paper title or count from arXiv.

On this Windows setup, a dependency-free headless Chrome/Edge check is also
available. It starts isolated Worker/Vite/browser processes; by default it uses
fixtures for exceptional states and makes **one** live search through the actual
React form and Vite proxy.

```powershell
npm.cmd run papers:ui:check

# Fixture-only UI rendering check; explicitly makes no live arXiv request:
$priorUiSkip = $env:PAPERS_UI_CHECK_SKIP_LIVE
$env:PAPERS_UI_CHECK_SKIP_LIVE = "true"
npm.cmd run papers:ui:check
if ($null -eq $priorUiSkip) { Remove-Item Env:PAPERS_UI_CHECK_SKIP_LIVE } else { $env:PAPERS_UI_CHECK_SKIP_LIVE = $priorUiSkip }
```

The check covers keyboard Enter submission, loading, duplicate prevention,
submitted-query association after editing, result cards and link safety, empty
results, sanitized API errors, malformed JSON, network failure, browser timeout,
blank input, and all existing connection indicators. Its ignored fixture
screenshot and isolated state are retained below `.wrangler/` for inspection.

## Structure

```text
db/schema.ts                    Minimal Drizzle probe schema
drizzle.config.ts               SQLite migration generation configuration
drizzle/*.sql                   Committed schema-only migrations
drizzle/meta/                   Committed Drizzle generation history
src/App.tsx                     Search UI plus relative status/search requests
src/worker/index.ts             Health/status/search routing and ESM fetch handler
src/worker/storage.ts           Typed D1/R2 helpers
src/worker/local-probe.ts       Explicitly gated local verification routes
src/worker/arxiv.ts             Bounded, paced arXiv Atom search adapter and metadata parser
src/worker/paper-search-types.ts  Shared declaration-only search response types
src/worker/openai.ts            Bounded OpenAI Responses API probe
src/worker/local-integration-probe.ts  Gated local integration routes
scripts/storage-check.mjs      Isolated persistence and HTTP verification
scripts/integration-check.mjs  Isolated live Worker connectivity verification
scripts/integration-offline-check.mjs  Focused adapter failure-path checks
scripts/paper-search-check.mjs  Offline arXiv search adapter and route checks
scripts/paper-search-live-check.mjs  One-request local Worker arXiv endpoint check
scripts/frontend-search-browser-check.mjs  Isolated browser UI/proxy check
worker-configuration.d.ts      Wrangler-generated binding/runtime types
vite.config.ts                 Development proxy and frontend build output
wrangler.jsonc                 Local D1/R2 bindings
```

## Local OpenAI configuration and integration checks

`wrangler.jsonc` sets the non-secret default `OPENAI_MODEL` to `gpt-6-luna`. The ignored `.dev.vars` file supplies a local `OPENAI_API_KEY`; it is read only by the Worker binding and is never exposed to Vite or frontend code. `.dev.vars.example` is the safe committed template.

If `.dev.vars` is absent, create it once and enter the key in a local editor. Do not paste a key into a terminal, chat, source file, or committed configuration.

```powershell
if (-not (Test-Path -LiteralPath .dev.vars)) {
  Copy-Item .dev.vars.example .dev.vars
}
notepad .dev.vars
```

Leave `OPENAI_MODEL=gpt-6-luna` unless deliberately selecting a model available to your account. Then run:

```powershell
npm.cmd run integrations:offline
npm.cmd run integrations
```

`integrations` creates isolated local Wrangler state and ports, verifies health and storage directly and through its own Vite proxy, proves both integration routes are 404 when disabled, then enables them only for that check. In normal mode it makes one fixed arXiv metadata query (`max_results=1`) and at most one OpenAI request with the prompt `Reply with the word OK.` No integrations run on page load, normal health/storage requests, type checks, builds, or offline tests. The script stops only its own processes and preserves a sanitized result in its ignored state directory. The first recorded run succeeded against arXiv and skipped OpenAI before a key existed; the later supplied run succeeded against both and received `OK` from `gpt-6-luna`. Both records are retained in `integration-check-evidence.json`.

For a clean-copy reproducibility check that must make **no external calls**, use the same command in explicit offline mode. It still starts the local Worker and Vite proxy and checks health/storage and disabled routes, but it does not invoke either upstream probe:

```powershell
$env:INTEGRATION_CHECK_OFFLINE = "true"
npm.cmd run integrations
Remove-Item Env:INTEGRATION_CHECK_OFFLINE
```

The test-only `/api/__local/integrations/arxiv` and `/api/__local/integrations/openai` routes require `LOCAL_INTEGRATION_PROBE=true` plus a loopback hostname. The committed configuration has no such flag, so the routes are 404 in normal development and hosted use.

`.env*` and real `.dev.vars*` files are ignored; the `.dev.vars.example` template is intentionally retained. Keep credentials out of source, logs, evidence, and build artifacts.

## Manual HTTP checks

With `npm.cmd run dev` running in another terminal:

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8787/api/health | Select-Object StatusCode, Content
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8787/api/storage/status | Select-Object StatusCode, Content
Invoke-WebRequest -UseBasicParsing http://localhost:5173/api/health | Select-Object StatusCode, Content
Invoke-WebRequest -UseBasicParsing http://localhost:5173/api/storage/status | Select-Object StatusCode, Content
```

## Known audit findings

The full Phase 0A.2 audit reports **3 high** findings already present through `wrangler → miniflare → sharp`, plus **4 moderate** findings introduced through `drizzle-kit → @esbuild-kit/esm-loader → @esbuild-kit/core-utils → esbuild@0.18.20`. The production-only audit reports **0**. Full evidence is in `audit-phase-0a2*.json`; the previous phase's audit evidence is preserved.

The new [esbuild advisory](https://github.com/advisories/GHSA-67mh-4wv8-2f99) concerns its development-server feature. The inspected loader uses transformation APIs, and the project's Drizzle command only generates migration files; no Drizzle Studio or vulnerable esbuild server is started. This assessment is specific to the current commands, not a claim that development dependencies are harmless. The audit dry run proposed no changes; its suggested Drizzle downgrade to 0.18.1 is marked breaking and was not applied. No forced fix or dependency override was introduced. See `DEVELOPMENT_LOG.md` for exact verification results.

References: [Cloudflare local D1 development](https://developers.cloudflare.com/d1/best-practices/local-development/), [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/), [R2 Worker binding API](https://developers.cloudflare.com/r2/api/workers/workers-api-usage/), [OpenAI GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), [Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create), and the [arXiv API manual](https://info.arxiv.org/help/api/user-manual.html).

# Sites hosting copy

Phase 0B.2 hosting preparation retains the local application and adds the Sites
manifest and reproducible build staging. See [docs/SITES_DEPLOYMENT.md](docs/SITES_DEPLOYMENT.md)
for the output layout, runtime secret setup, verification, and Windows source
synchronization. `npm.cmd run build` now also prepares Sites-compatible output;
`npm.cmd run sites` checks the packaged Worker with binding fixtures.
