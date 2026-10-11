# BabyScholar

BabyScholar is a local research workspace for finding papers, saving a library,
and working with uploaded PDFs. It can extract PDF text and, when a local Worker
has an OpenAI key, generate source-grounded metadata, summaries, and answers
with page-numbered supporting quotes. Its React frontend talks to the local
Cloudflare Worker through relative `/api` URLs; the Worker uses local D1 and R2
emulation for persistent development data.

## Run it locally

Clone commands run from the folder where you keep projects. After `Set-Location
.\\babyScholar` or `cd babyScholar`, run every remaining command in this guide
from the repository root.

### 1. Prerequisites

- Git
- Node.js **22.12.0 or later** (this project was tested with Node.js 24.11.1)
- npm (installed with Node; npm 11.6.2 was used for the recorded checks)

On Windows PowerShell, use `npm.cmd` rather than `npm`. This avoids the common
PowerShell execution-policy block on `npm.ps1`; it does not require changing an
execution policy. The commands below use `npm.cmd` on Windows and `npm` on
macOS/Linux.

### 2. Clone, install, configure, migrate, and start

**Windows PowerShell**

```powershell
git clone https://github.com/panappin/babyScholar.git
Set-Location .\babyScholar
npm.cmd ci

if (-not (Test-Path -LiteralPath .dev.vars)) {
  Copy-Item .dev.vars.example .dev.vars
}
notepad .dev.vars

npm.cmd run db:migrate:local
npm.cmd run dev
```

**macOS/Linux**

```sh
git clone https://github.com/panappin/babyScholar.git
cd babyScholar
npm ci

test -f .dev.vars || cp .dev.vars.example .dev.vars
${EDITOR:-vi} .dev.vars

npm run db:migrate:local
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). The Worker listens locally
at `http://127.0.0.1:8787`; Vite proxies the frontend's `/api` requests to it.
`npm run dev`/`npm.cmd run dev` starts and manages both processes.

To stop the app, press `Ctrl+C` in its terminal. If that terminal was lost, run
`npm.cmd run dev:stop` on Windows (or `npm run dev:stop` on macOS/Linux) from
this repository. It stops only a verified managed BabyScholar session; stop an
older or manually started server from its original terminal.

### 3. Configure the local Worker key safely

`.dev.vars.example` is the safe template. The local, ignored `.dev.vars` file
contains:

```ini
OPENAI_API_KEY=your_key_here
OPENAI_MODEL=gpt-6-luna
```

Set `OPENAI_API_KEY` to an API key you own. Leave `OPENAI_MODEL` at the default
unless you deliberately choose a model enabled for your account that supports
the Responses API and the application's structured-output requests. The Worker
never silently substitutes a model.

Keep the key Worker-only: never put it in a `VITE_` variable, frontend source,
logs, or committed files, and never commit `.dev.vars`. Edit the local file in
an editor rather than pasting the key into chat or a command history.

The app starts, local migrations work, and the offline checks below work without
a key. A key is required only when you explicitly request AI-backed document
metadata, a summary, or Q&A. Paper search uses arXiv and needs network access,
but does not use an OpenAI key.

### 4. Local data persists

Local D1 and R2 data live under `.wrangler/state` and persist across normal
restarts. This includes saved papers, uploaded PDFs, extracted text, metadata,
summaries, and saved questions. Local data is separate from hosted data.

If Wrangler reports a local-state/internal error on Windows from a deeply nested
directory, move or clone the project to a short ordinary path such as
`C:\src\babyScholar` and retry. This is a known workaround for the current
Windows Wrangler setup, not a requirement for every clone.

## First-run troubleshooting

| Problem | What to do |
| --- | --- |
| Port 5173 or 8787 is already in use | Stop the existing server from its owning terminal. For a managed BabyScholar session, use `npm.cmd run dev:stop` (Windows) or `npm run dev:stop` (macOS/Linux), then start again. |
| D1/table error or a feature says local storage is unavailable | From the repository root, stop development and run `npm.cmd run db:migrate:local` (or `npm run db:migrate:local`), then start again. |
| AI action reports missing configuration | Create `.dev.vars` from `.dev.vars.example`, enter an account-owned `OPENAI_API_KEY`, choose an available model, and restart the Worker. Startup itself does not require a key. |
| Local state is locked or Wrangler fails in a deep Windows path | Stop verified project processes first. Do not delete `.wrangler/state`; use the reset procedure below or move to a short path if the documented Windows issue applies. |
| A browser page cannot reach the backend | Keep `npm run dev` running and open `http://localhost:5173`, not the Worker port. The Vite proxy supplies the relative `/api` connection. |

## Checks: offline first

The verifier commands below use disposable local state and loopback
fixtures/mocks; build commands may write ignored `dist/` artifacts. None of
these commands calls OpenAI or arXiv. Run them from the repository root.

**Windows PowerShell**

```powershell
npm.cmd run integrations:offline
npm.cmd run papers:check
node scripts/library-check.mjs
npm.cmd run documents:check
npm.cmd run extractions:check
npm.cmd run metadata:check
npm.cmd run summaries
npm.cmd run questions
npm.cmd run documents:ui:check
npm.cmd run typecheck
npm.cmd run build
npm.cmd run sites
```

**macOS/Linux**

```sh
npm run integrations:offline
npm run papers:check
node scripts/library-check.mjs
npm run documents:check
npm run extractions:check
npm run metadata:check
npm run summaries
npm run questions
npm run documents:ui:check
npm run typecheck
npm run build
npm run sites
```

Do not treat the offline checks as proof that a hosted service or a live model
will behave identically.

### Commands that make live requests

These are optional diagnostics, not startup steps. They require internet access
and may consume quota or invoke external services. **Do not run them unless you
intend to make the stated live request.**

| Command | Live activity |
| --- | --- |
| `npm.cmd run integrations` / `npm run integrations` | One fixed arXiv probe and at most one OpenAI Responses request. |
| `npm.cmd run papers:live` / `npm run papers:live` | One arXiv search request. |
| `npm.cmd run metadata:live` / `npm run metadata:live` | One OpenAI metadata verification request when a usable local key is configured; it stops rather than retrying. |

The normal UI performs no provider call merely by loading a page. Search, AI
generation, and these diagnostics are explicit actions.

## Intentionally reset local data

This is destructive to the active local state: it removes local access to saved
papers, PDFs, extraction results, metadata, summaries, and Q&A history. It does
not affect hosted data or `.dev.vars`.

1. Stop local development first.
2. From the repository root, run one of these commands:

   ```powershell
   npm.cmd run storage:reset -- --confirm-reset
   ```

   ```sh
   npm run storage:reset -- --confirm-reset
   ```

The command refuses a detected project server, moves the prior
`.wrangler/state` to `.wrangler/state-backups/`, creates fresh local state, then
applies the committed migrations. A failed backup move does not begin migration.
Keep the reported backup until you are sure the reset was intended; it is the
recovery point for the former local data. Windows cleanup is verified; POSIX
process cleanup has not been independently verified.

## Project map

| Path | Purpose |
| --- | --- |
| `src/` | React frontend and Worker source. |
| `src/worker/` | API routes, D1/R2 access, validation, and Worker-only AI adapters. |
| `scripts/` | Local development helpers and isolated verification scripts. |
| `drizzle/` and `drizzle/meta/` | Immutable, ordered local D1 migrations and Drizzle metadata (`0000` through `0006`). |
| `wrangler.jsonc` | Local Worker entry point and local D1/R2 binding labels. |
| `vite.config.ts` | Development `/api` proxy and frontend build output. |
| `docs/DEPLOYMENT_HANDOFF.md` | Build artifacts, bindings, and portable deployment handoff details. |
| `docs/SITES_DEPLOYMENT.md` | Existing Sites staging and hosted configuration guidance. |
| `DEVELOPMENT_LOG.md` | Detailed implementation history, migration notes, audit baseline, and retained verification outcomes. |

For production artifacts, run `npm run build`. It writes the frontend to
`dist/frontend/`, Worker-compatible ESM output to `dist/worker/`, and the
existing Sites staging output under `dist/`. See the deployment documents above
before using those artifacts; local binding labels are not hosted resource IDs.

## Important limits

- Grounding validates supporting quotes against retained extracted page text.
  A quote being present proves source presence, not that every model paraphrase
  is logically entailed.
- PDF extraction does not include OCR. Scanned/image-only PDFs may have no
  usable text.
- Local fixture checks make no live requests. Live provider behavior, hosted
  frame/download behavior, and the known oversized chunked-upload transport
  limitation need separate verification where relevant.
