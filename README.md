# AI Research Assistant

Phase 3C adds backend-only, source-grounded title/authors/year/abstract
generation from persisted PDF text retained in private R2. There is still no
upload or text UI, OCR, summaries, or Q&A.

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

The same schema also defines `papers`. The additive
`drizzle/0001_paper_library.sql` creates that table and its unique
`(source, arxiv_id)` index. It does not alter the probe table or rewrite the
initial migration/snapshot. Run `npm.cmd run db:migrate:local` before ordinary
development to apply any pending migrations to your persistent local database.

The additive `drizzle/0002_uploaded_documents.sql` creates
`uploaded_documents` without changing either earlier migration. It stores an
application UUID, original display filename, byte count, SHA-256, private R2
object key, upload time, and `stored` status. It has a stable newest-first
lookup index. Apply this migration deliberately to a local database before
using the document endpoints:

```powershell
npm.cmd run db:migrate:local
```

The additive `drizzle/0003_document_extractions.sql` creates one text-extraction
record per uploaded document. It preserves the source PDF SHA-256, parser and
version, UTC extraction timestamp, page count, and ordered one-based page text
as JSON. Its `document_id` primary key is the D1 uniqueness constraint used to
retain one authoritative result under concurrent extraction requests. It does
not alter any earlier migration, existing document row, or R2 object.

The additive `drizzle/0004_document_metadata.sql` creates immutable
`document_metadata` results and short-lived `document_metadata_claims` leases.
It preserves the existing papers, uploaded-document, and extraction tables.
Apply it with the same deliberate local migration command before requesting
metadata.

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
- Worker-compatible bundled ESM module: `dist/worker/index.js` (with source map
  and `dist/worker/bundle-meta.json`)

The Worker exports a default object with a callable `fetch(request, env)` handler.
`wrangler.jsonc` points local development at `src/worker/index.ts`; the build
uses Wrangler's dry-run bundler so Worker dependencies such as UnPDF are included
in the same artifact that Sites stages at `dist/server/`. Retain the complete
`dist/worker/`, `dist/server/`, and `dist/frontend/` directories, plus
`drizzle/*.sql` and `drizzle/meta/**`, for a handoff. No deployment is configured
or performed in this phase.

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

## Persistent paper-library API (Phase 2A)

The existing `DB` binding stores library metadata; no external API or R2 request
runs on either library route. Phase 2B consumes these routes from the local
search/Library UI without changing their API contract. The existing private
Sites boundary is unchanged; there is no new authentication mechanism or
permissive CORS policy.

`POST /api/library/papers` requires `Content-Type: application/json` and this
exact envelope (all seven `PaperSearchResult` fields must be present):

```json
{"paper":{"id":"2401.01234","title":"Example title","authors":["First Author","Second Author"],"year":2024,"abstract":"The complete abstract.","url":"https://arxiv.org/abs/2401.01234v2","pdfUrl":null}}
```

A new save is HTTP **201** with `{"paper": SavedPaper, "created": true}`.
An existing identity is HTTP **200** with `{"paper": SavedPaper, "created": false}`.
The declaration-only contract is in `src/worker/library-types.ts`:

```typescript
interface SavedPaper {
  id: string;           // independent application UUID
  source: "arxiv";
  arxivId: string;      // source identifier without vN, not the application ID
  title: string;
  authors: string[];    // original order
  year: number | null;
  abstract: string;     // complete supplied text
  url: string | null;
  pdfUrl: string | null;
  savedAt: string;      // server-assigned UTC ISO 8601 timestamp
}
```

`GET /api/library/papers` is HTTP **200** with `{"papers": SavedPaper[]}` (or
`{"papers":[]}` initially). It returns all records, ordered by `savedAt` descending
then application `id` descending for a stable tie-break. Authors are stored as
JSON; text and nullable metadata round-trip without truncation. Titles do not
identify records. A database unique index on `(source, arxiv_id)` and a
parameterized transactional insert/read batch resolve simultaneous first saves.
Duplicates, including versioned IDs/links, return the first record's complete
metadata, UUID, and timestamp without overwriting anything.

Input is uncompressed UTF-8 JSON, limited to **262,144 received bytes (256 KiB)**
and a **10-second body-read deadline**; bytes are counted while streaming, not
trusted from `Content-Length`. Field limits are Unicode code points: ID 64,
title 2,000, abstract 100,000, each author 512, each link 2,048; there may be up to
2,000 ordered authors. Empty title/abstract and an empty author array are allowed
for unavailable search metadata; individual authors cannot be blank. Year is
`null` or an integer 1–9999; links are explicitly `null` or valid arXiv links.
NUL characters, unknown fields, missing fields, and incorrect types are rejected.
The overall byte limit also applies when individual fields are within their limits.

Modern and legacy arXiv IDs use the existing search rules. A `vN` suffix is
removed from identity only. Supplied links must identify that same paper and
use HTTP(S) on exactly `arxiv.org` or `www.arxiv.org`, without credentials or a
nonstandard port. The shared search helper canonicalizes them to HTTPS on
`arxiv.org`, retaining the version/path and discarding query/fragment data.
Client input cannot assign the saved record's UUID, source, or timestamp.

Every library response uses `Cache-Control: no-store`. Errors are sanitized
`{"error":{"kind":"...","message":"..."}}` JSON, without submitted content,
SQL details, or secrets:

| Status | `error.kind` |
| --- | --- |
| 400 | `invalid_request` |
| 408 | `request_timeout` |
| 413 | `body_too_large` |
| 415 | `unsupported_media_type` |
| 405 | `method_not_allowed` (with `Allow: GET, POST`) |
| 503 | `storage_unavailable` or `database_failure` |

Apply migrations before normal startup, then use the same relative `/api` path
through Vite (5173) or directly on the Worker (8787):

```powershell
npm.cmd run db:migrate:local
npm.cmd run dev
# In another terminal, an empty or previously saved library:
Invoke-RestMethod 'http://127.0.0.1:8787/api/library/papers'
Invoke-RestMethod 'http://localhost:5173/api/library/papers'
```

The reproducible library check is a plain Node command to keep `package.json`
and the lockfile unchanged:

```powershell
npm.cmd run build
node scripts/library-check.mjs
```

It uses real local Wrangler/D1, available ports, and one unique
`.wrangler/library-check/<UUID>/state` directory. It verifies empty/all-record
lists, full/nullable metadata, concurrent first saves, immutable versioned
duplicates, stable ordering, validation and actual body bounds without writes,
and sanitized failure paths against the built Worker. It stops and restarts
its own Worker against the same state and **GETs before any further POST**,
then reapplies migrations and compares the same records again. It never calls
arXiv/OpenAI. It stops only owned processes, removes only its generated state
after success, and retains sanitized `result.json` evidence. Failed state is
retained for diagnosis. Normal `.wrangler/state` and user servers are untouched.

## Original-PDF document API (Phases 3A–3C)

This backend-only slice retains private original PDFs and extracts readable text
only on the Worker. Metadata generation is available only through the Worker
API; there is no upload or text frontend control, OCR, summary, or Q&A feature.
The existing private Site boundary, `DB`, and `PAPER_BUCKET` bindings are reused;
there is no new public bucket route or CORS policy.

`POST /api/documents` accepts uncompressed `multipart/form-data` containing
**exactly one** field named `file`. The field must be a nonempty file with an
original filename of at most 255 Unicode code points (and no NUL), a file size
at most **10 MiB** (10,485,760 bytes), and bytes beginning with the ASCII PDF
signature `%PDF-`. The Worker reads the raw stream itself before multipart
parsing, with a 10-second deadline and a total cap of **10,551,296 bytes**
(10 MiB plus a documented 64 KiB multipart-boundary/field allowance). It counts
received bytes rather than trusting `Content-Length`. Signature validation is
only a lightweight upload gate; it does not claim a later PDF parser will be
able to process the document.

On success, the Worker generates an application UUID and private R2 key
`uploaded_documents/<UUID>.pdf`, stores the exact received file bytes, inserts
the D1 row, and returns HTTP **201**:

```json
{"document":{"id":"application-uuid","filename":"original.pdf","byteCount":512,"sha256":"lowercase-sha256-hex","uploadedAt":"2026-10-08T00:00:00.000Z","status":"stored"}}
```

The R2 key is never included in a public response. `GET /api/documents` returns
`{"documents": UploadedDocument[]}` in `uploadedAt DESC, id DESC` order.
`GET /api/documents/:id/pdf` validates the application UUID and streams the
original object only when its D1 document row exists. It returns
`application/pdf`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`,
and a safe server-generated attachment name (`document-<UUID>.pdf`), never the
submitted filename.

### Stored-PDF text extraction (Phase 3B)

`POST /api/documents/:id/extract` accepts **no request body**. It first checks
for an existing D1 record before reading R2 or invoking the parser. A new,
complete extraction is returned as HTTP **201**; the same document later returns
HTTP **200** with its original timestamp and `created:false`. Concurrent first
requests may parse in parallel, but the D1 `document_id` primary key and
conflict-safe insert retain one authoritative persisted record.

`GET /api/documents/:id/text` returns the same stored extraction. It returns
`document_not_found` for an unknown application UUID and `extraction_not_found`
for a known PDF that has not successfully extracted.

```json
{"extraction":{"documentId":"application-uuid","sourceSha256":"lowercase-sha256-hex","parser":"unpdf","parserVersion":"unpdf@1.8.1/pdfjs@<runtime-version>","extractedAt":"2026-10-08T00:00:00.000Z","pageCount":2,"pages":[{"pageNumber":1,"text":"First page text"},{"pageNumber":2,"text":"Second page text"}]},"created":true}
```

The Worker reads only the stored private R2 object, recomputes SHA-256 before
parsing, and never accepts client-supplied text. It uses UnPDF's bundled
serverless PDF.js build with range/background fetches, system fonts, font-face
use, XFA, and PDF JavaScript evaluation disabled. It does not render pages,
use canvas/native filesystem APIs, fetch remote fonts/assets, execute embedded
PDF JavaScript, or perform OCR. Parser resources are released after every
attempt.

This MVP rejects—not truncates—PDFs over **100 pages**, extracted UTF-8 text
over **500 KiB**, or serialized page data over **1 MiB**. It applies a 20-second
whole-extraction deadline to asynchronous parser waits. A timer cannot interrupt
synchronous PDF.js CPU work already running on the Worker event loop; this is a
bounded operational guard, not CPU preemption. Password-protected PDFs,
corrupt/signature-only inputs, and image-only PDFs with no usable text are not
converted or OCRed. Failures leave the original object and any existing
successful extraction untouched.

Every document error is sanitized JSON with `Cache-Control: no-store`:

| Status | `error.kind` |
| --- | --- |
| 400 | `invalid_request` |
| 404 | `document_not_found` or `object_missing` |
| 404 | `extraction_not_found` (known document, no successful extraction) |
| 409 | `source_hash_mismatch` |
| 408 | `request_timeout` |
| 413 | `body_too_large` or `extraction_limit_exceeded` |
| 415 | `unsupported_media_type` |
| 405 | `method_not_allowed` (with the route's `Allow` header) |
| 422 | `password_protected`, `no_usable_text`, or `parser_error` |
| 504 | `extraction_timeout` |
| 503 | `storage_unavailable` or `database_failure` |

D1 and R2 do not share an atomic transaction. If R2 storage succeeds but the
D1 insert fails, the Worker makes one best-effort deletion attempt for only the
new request's generated key, then returns a sanitized 503. If that cleanup
also fails, a private unreferenced R2 object can remain; no automatic write or
cleanup retry is made. An R2 write failure never starts a D1 insert.

After applying the migration, use the focused local check after a build:

```powershell
npm.cmd run build
npm.cmd run documents:check
npm.cmd run unpdf:proof
npm.cmd run extractions:check
npm.cmd run metadata:check
```

`documents:check` uses only a UUID-scoped `.wrangler/document-check/<UUID>/`
state directory, a repository-authored 512-byte minimal PDF fixture released as
CC0-1.0, and local Wrangler D1/R2 bindings. It verifies empty listing, two
distinct uploads, returned byte/hash metadata, exact downloaded bytes, stable
order, restart-before-new-upload persistence, migration reapplication, invalid
multipart cases, raw body/file limits, and offline storage/cleanup failures.
It never calls arXiv or OpenAI and never touches normal `.wrangler/state`.

`unpdf:proof` first bundles a minimal no-binding Worker with the exact Wrangler
settings used for Worker/Sites artifacts, starts the resulting bundle locally,
and extracts a repository-authored valid two-page PDF. The fixture source is
`scripts/fixtures/pdf-fixtures.mjs`, released as CC0-1.0; it verifies separate
known phrases and non-ASCII `Café`. `extractions:check` then uses a separate
UUID-scoped local D1/R2 state tree to verify the complete API, source hash,
ordered pages, cache/repeat/concurrent behavior, original-byte preservation,
restart-before-reextract, migration reapplication, corrupt/signature-only,
encrypted, image-only, page/text-limit, missing R2, hash mismatch, and D1
failure cases. It never calls external providers or normal local state.

### Source-grounded metadata (Phase 3C)

`POST /api/documents/:id/metadata` accepts **no request body** and requires a
successful persisted text extraction. It returns a newly saved metadata result
with HTTP **201** and `created:true`; a later POST returns the immutable cached
result with HTTP **200** and `created:false`. `GET /api/documents/:id/metadata`
returns the saved result without contacting OpenAI. Unknown document,
missing-text, and missing-metadata cases remain distinct (`document_not_found`,
`extraction_not_found`, and `metadata_not_found`). A concurrent generation
returns `409 metadata_in_progress`; its claim lease prevents duplicate live
provider calls without becoming a durable result.

The Worker selects at most the first three persisted, ordered text pages and no
more than 24,000 UTF-8 bytes, never splitting a Unicode code point. The response
records selected pages, byte count, clipping, source SHA-256, parser/extraction
provenance, configured model, prompt version, generation time, nullable fields,
page-numbered evidence quotes, and warnings. The model receives no filename,
current date, web data, tools, PDF bytes, or text beyond that bounded excerpt.
It is instructed that the PDF text is untrusted data. Runtime validation still
requires normalized source quotes and source-supported values after strict
structured JSON decoding; an unavailable field must be `null`, have no evidence,
and have a warning naming it.

Only the Worker reads `OPENAI_API_KEY`; Vite/frontend code never receives the
key, source excerpt, or provider implementation. The Responses request uses
`store:false`, no tools, one bounded 25-second operation, a 256 KiB bounded
response body, no automatic retry, and `gpt-6-luna` reasoning effort `none`
when that configured model is selected. Sanitized errors distinguish missing
configuration, authentication, quota/rate limits, model access, timeout,
refusal, incomplete/malformed output, and provider/network failure.

```powershell
# Local mock provider plus isolated Worker/D1/R2 state; no OpenAI call:
npm.cmd run metadata:check

# Deliberate one-request local live check. Requires an existing local key and
# may incur provider use; it never retries. Do not run this during offline work.
npm.cmd run metadata:live
```

`metadata:check` uses only the CC0 repository fixture, a loopback Responses
mock, and UUID-scoped local state. It verifies all nullable/known fields and
evidence, missing storage/configuration/text, cache and concurrent claims,
restart/migration persistence, three-page clipping, refusal/incomplete/malformed
responses, invalid evidence, provider failure, and unchanged original PDF/text
records. It leaves normal `.wrangler/state` untouched.

Known local-tool limitation: with the installed Wrangler 4.148.0 / Miniflare
5.20261006.0-alpha, an immediate POST/PUT after a rejected oversized chunked
upload can receive a proxy-generated `500 Network connection lost`, outside
the application's sanitized response handler. The default check verifies the
413 response and then GETs the unchanged library; a subsequent duplicate save
also passes. That is not proof that the immediate-write edge case is fixed.
This separate reproduction deliberately fails if the proxy issue occurs; it
does not retry or hide it:

```powershell
node scripts/library-check.mjs --transport-stress
```

The follow-up investigation reproduced this with a reused native HTTP socket,
a verified fresh socket, and a separate client process. Failed POSTs did not
reach the handler. A minimal Worker without D1 or application imports also
failed, with either cancellation or release-only early rejection. Successful
immediate GET/health responses are not a workaround: Wrangler logged an
internal retry before returning 200. No client/application retry was added.

```powershell
# Fails visibly when the runtime problem reproduces; still checks no-write
# integrity and recovery, and cleans only its own temporary processes/state:
node scripts/transport-investigation.mjs
```

This diagnostic records TCP socket identities/ports, handler entry/exit markers,
sanitized proxy logs, and library snapshots below
`.wrangler/transport-investigation/<UUID>/result.json`. The application byte
limit, deadline, validation, and dependencies remain unchanged. The exact
internal connection-pool mechanism is unconfirmed; hosted behavior is untested.
Because fresh-client requests also fail, the local transport blocker remains
open pending a scoped local-runtime fix. Phase 2B supports normal UI workflows
but does not establish hosted behavior for that edge case. See the appended
investigation in `DEVELOPMENT_LOG.md`; earlier failures and reports are retained
there.

## Research-paper search and Library interface

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

Each search result has a **Save to library** control. It reports per-paper
Saving, Saved, recoverable error, or an uncertain outcome while it reconciles a
timed-out/interrupted request with the authoritative library. A source identity
uses the canonical arXiv ID rather than a title or versioned URL, so an existing
saved result is recognized after a refresh and cannot receive duplicate pending
submissions. A successful save is merged into the Library immediately; no
automatic POST retry occurs.

Select **Library** to load the newest-first records from `/api/library/papers`.
It has explicit initial, loading, empty, loaded, and error states and a
**Reload library** action. Cards show the title, ordered authors, nullable
first-submission year, complete abstract, safe paper link/fallback, saved time,
the application record ID, and the distinct canonical arXiv ID. A failed reload
retains any records already displayed.

For a manual local check, start `npm.cmd run dev`, open <http://localhost:5173>,
enter `graph neural networks`, and press Enter. Confirm the loading text, paper
cards, full abstracts, link behavior, blank-input feedback, Save state, Library
view, refresh persistence, and the existing connection indicators. Do not
expect a fixed paper title or count from arXiv.

On this Windows setup, a dependency-free headless Chrome/Edge check is also
available. It starts isolated Worker/Vite/browser processes, uses fixtures for
search/library exceptional states, and uses a disposable local D1 database for
the Save, Library, browser-refresh, and duplicate-record flow. It makes no
arXiv or OpenAI request.

```powershell
npm.cmd run papers:ui:check
```

The check covers keyboard Enter submission, loading, duplicate prevention,
submitted-query association after editing, result cards and link safety, empty
results, sanitized API errors, malformed JSON, network failure, browser timeout,
blank input, save/library loading and errors, existing saves, duplicate responses,
an interrupted save reconciliation, browser refresh persistence, desktop/narrow
layouts, and all existing connection indicators. Its ignored screenshots and
isolated state are retained below `.wrangler/` for inspection.

## Structure

```text
db/schema.ts                    Drizzle storage-probe, paper-library, and document schema
drizzle.config.ts               SQLite migration generation configuration
drizzle/*.sql                   Committed schema-only migrations
drizzle/meta/                   Committed Drizzle generation history
src/App.tsx                     Search/Save/Library UI plus relative API requests
src/paper-identity.ts           Browser-safe canonical arXiv identity and link helpers
src/worker/index.ts             Health/status/search/library routing and ESM fetch handler
src/worker/storage.ts           Typed D1/R2 helpers
src/worker/local-probe.ts       Explicitly gated local verification routes
src/worker/arxiv.ts             Bounded, paced arXiv Atom search adapter and metadata parser
src/worker/paper-search-types.ts  Shared declaration-only search response types
src/worker/arxiv-identity.ts    Shared arXiv identity and safe-link rules
src/worker/library-types.ts     Declaration-only save/list/error contracts
src/worker/library-validation.ts  Bounded body reading and runtime validation
src/worker/library.ts           Parameterized D1 save/list API
src/worker/document-types.ts    Declaration-only uploaded-document contracts
src/worker/document-validation.ts  Bounded multipart/PDF validation and SHA-256
src/worker/documents.ts         Private R2 + parameterized D1 document API
src/worker/document-metadata.ts Cached/claimed source-grounded metadata API
src/worker/metadata-source.ts   Bounded persisted-text excerpt selection
src/worker/metadata-openai.ts   Bounded strict-JSON Responses adapter
src/worker/metadata-validation.ts Runtime source/evidence validation
src/worker/openai.ts            Bounded OpenAI Responses API probe
src/worker/local-integration-probe.ts  Gated local integration routes
scripts/storage-check.mjs      Isolated persistence and HTTP verification
scripts/integration-check.mjs  Isolated live Worker connectivity verification
scripts/integration-offline-check.mjs  Focused adapter failure-path checks
scripts/metadata-check.mjs      Isolated metadata Worker/D1/R2/mock-provider check
scripts/metadata-live-check.mjs One-request local live metadata verifier
scripts/paper-search-check.mjs  Offline arXiv search adapter and route checks
scripts/library-check.mjs       Offline real-D1 duplicate/persistence check
scripts/document-check.mjs      Isolated local D1/R2 original-PDF persistence check
scripts/paper-search-live-check.mjs  One-request local Worker arXiv endpoint check
scripts/frontend-search-browser-check.mjs  Isolated search/Library browser/proxy check
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

The metadata endpoint reuses that same Worker-only key and preserves the
configured model; it does not introduce another secret or a `VITE_` variable.

`integrations` creates isolated local Wrangler state and ports, verifies health and storage directly and through its own Vite proxy, proves both integration routes are 404 when disabled, then enables them only for that check. In normal mode it makes one fixed arXiv metadata query (`max_results=1`) and at most one OpenAI request with the prompt `Reply with the word OK.` No integrations run on page load, normal health/storage requests, type checks, builds, or offline tests. The script stops only its own processes and preserves a sanitized result in its ignored state directory. The first recorded run succeeded against arXiv and skipped OpenAI before a key existed; the later supplied run succeeded against both and received `OK` from `gpt-6-luna`. Both records are retained in `integration-check-evidence.json`.

For a clean-copy reproducibility check that must make **no external calls**, use the same command in explicit offline mode. It still starts the local Worker and Vite proxy and checks health/storage and disabled routes, but it does not invoke either upstream probe:

```powershell
$priorIntegrationOffline = $env:INTEGRATION_CHECK_OFFLINE
try {
  $env:INTEGRATION_CHECK_OFFLINE = "true"
  npm.cmd run integrations
} finally {
  if ($null -eq $priorIntegrationOffline) {
    Remove-Item Env:INTEGRATION_CHECK_OFFLINE -ErrorAction SilentlyContinue
  } else {
    $env:INTEGRATION_CHECK_OFFLINE = $priorIntegrationOffline
  }
}
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
