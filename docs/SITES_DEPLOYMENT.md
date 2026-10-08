# Sites deployment

This hosting copy is based on the Phase 0B.1 handoff from local checkpoint
`044ef6fb79f9f20b5471a9b43d87c75932c8da1f`.

The existing React frontend and Worker APIs are retained. Sites owns hosted D1
and R2 resources, declared as `DB` and `PAPER_BUCKET` in `.openai/hosting.json`.
The local labels in `wrangler.jsonc` remain local and are never deployed as
Cloudflare resource IDs. Keep the registered `project_id` unchanged.

## Build and local development

The original local commands still work:

```powershell
npm.cmd ci
npm.cmd run db:migrate:local
npm.cmd run dev
```

`npm.cmd run build` retains `dist/frontend/` and all of `dist/worker/`, then
stages `dist/client/`, the full `dist/server/`, and migration metadata under
`dist/.openai/`. `ASSETS` serves the frontend in a hosted Worker; `/api/*`
continues through the existing API handler. Do not deploy only the Worker
entrypoint or use a static-only deployment.

```powershell
npm.cmd run build
npm.cmd run integrations:offline
npm.cmd run sites
```

The artifact check uses binding fixtures. The separate no-external-call
integration check runs real local D1/R2 emulation and the Vite proxy:

```powershell
$env:INTEGRATION_CHECK_OFFLINE = "true"
npm.cmd run integrations
Remove-Item Env:INTEGRATION_CHECK_OFFLINE
```

Applied SQL and `drizzle/meta/**` are immutable. Publishing applies committed
migrations before Worker upload. Append new migrations for later features.

## Runtime secrets and verification

Sites runtime configuration sets `OPENAI_MODEL=gpt-6-luna`. The original ZIP
does not include the local API key. `OPENAI_API_KEY` must be configured as a
hosted secret through a secure setup flow before hosted LLM work is enabled.
Never put it in frontend variables, this repository, build output, or ZIPs.

The current blank app needs no OpenAI request to serve its frontend or read
health/storage status. Hosted OpenAI connectivity is pending until a secret is
configured and a controlled authenticated check is completed. The original
successful local arXiv/OpenAI evidence remains in `integration-check-evidence.json`.

The Site is private by default. Preserve that audience. Do not enable
`LOCAL_STORAGE_PROBE` or `LOCAL_INTEGRATION_PROBE` in Sites; local mutation and
integration routes remain unavailable on hosted requests.

Check the deployed frontend's Backend, D1, and R2 indicators. Normal API
diagnostics are `GET /api/health` and `GET /api/storage/status`. Paper search,
saved papers, PDF processing, summaries, and Q&A remain later slices.

## Source synchronization

The Sites source repository preserves this hosted copy. The Windows GitHub
repository is a separate source remote. Copy only the supplied hosting patch
onto the original Windows checkpoint, run the checks, review, commit, and push
normally. Do not copy runtime state, dependencies, or credentials, and do not
replace `.git` or force-push. Keep both copies aligned before further slices.
