# Deployment handoff

This handoff is a portable source and build checkpoint for a later ChatGPT Sites deployment. It does **not** provision, configure, or deploy any hosted resource.

## Verified source and build entry points

- Frontend entry: `src/main.tsx`, which renders `src/App.tsx`.
- Worker entry: `src/worker/index.ts`, exporting the callable default `fetch(request, env)` handler.
- Local development entry: `wrangler.jsonc`; Vite proxies relative `/api/*` requests to the Worker.

On Windows PowerShell, use `npm.cmd`:

```powershell
npm.cmd ci
npm.cmd run typecheck
npm.cmd run build
```

The full output needed for handoff is:

- `dist/frontend/` — static frontend assets.
- `dist/worker/` — the complete Worker-compatible ESM directory. Deploying only `index.js` is insufficient because it imports sibling modules.

The source checkpoint also includes `package-lock.json`, `worker-configuration.d.ts`, all scripts, `db/schema.ts`, `drizzle/*.sql`, and `drizzle/meta/**`.

## Bindings, migrations, and configuration

The Worker expects these bindings:

| Binding | Local development label | Hosted deployment requirement |
| --- | --- | --- |
| `DB` | local D1 database `ai-research-assistant-local` | Bind a D1 database selected/provisioned during Sites setup. |
| `PAPER_BUCKET` | local R2 bucket `ai-research-assistant-papers-local` | Bind an R2 bucket selected/provisioned during Sites setup. |

The local identifiers in `wrangler.jsonc` have `remote: false`; they are placeholders only and are not hosted IDs. Do not reuse them as deployment identifiers. The hosted D1/R2 resource names/IDs, account settings, and migration application procedure must be supplied during the later Sites setup.

The schema is defined in `db/schema.ts`. The ordered, committed migration history is `drizzle/0000_storage_probe.sql` and `drizzle/meta/**`. Preserve applied migrations and add new migrations rather than modifying existing ones.

For configuration:

- Set `OPENAI_API_KEY` as a hosted Worker secret. It must not be placed in frontend code, `VITE_*` variables, committed files, or the handoff archive.
- `OPENAI_MODEL` is non-secret configuration and defaults to `gpt-6-luna`. Set it only to a model available to the deployment account; the application does not silently substitute another model.
- Local `.dev.vars` is ignored and is never part of this handoff. `.dev.vars.example` is the safe template.

## Diagnostics and verification

`GET /api/health` and `GET /api/storage/status` are normal application checks. The local storage and integration probe routes are disabled by default and require both a loopback request and an explicit flag:

- `LOCAL_STORAGE_PROBE=true`
- `LOCAL_INTEGRATION_PROBE=true`

Do not configure either flag for routine local development or hosted deployment. `npm.cmd run storage:check` and `npm.cmd run integrations` create isolated local state and processes for their diagnostics. A live `integrations` run makes one arXiv query and, if a key is configured, one OpenAI request. For no-external-call reproducibility, run:

```powershell
$env:INTEGRATION_CHECK_OFFLINE = "true"
npm.cmd run integrations
Remove-Item Env:INTEGRATION_CHECK_OFFLINE
```

The expected blank frontend remains a connection-status page; paper discovery, persistence features, PDF processing, summaries, Q&A, hosted configuration, and deployment are outside this checkpoint.
