# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

"Earthquake CLI": a web-based terminal (planned xterm.js frontend) over live
earthquake data from `api.data.gov.my`, built on Cloudflare Workers. The full,
phased build is described in `planning/implementation-plan.md`; `planning/project-draft.md`
holds the original spec. Work proceeds one phase at a time, each on its own branch.

**Phase 1 (data layer) is done** — the rest of the plan (cron, Durable Object
terminal backend, xterm.js frontend, real-time alerts, Protomaps map, export)
is not built yet.

Current code:

- `src/index.ts` — Worker entry (`fetch`). Routes `POST /admin/ingest` (bearer-guarded
  by `ADMIN_TOKEN`) through the ingestion pipeline; everything else falls through to
  `env.ASSETS.fetch(request)` (static assets in `public/`).
- `src/lib/ingest.ts` — `computeId()` (truncated SHA-256 of `utcdatetime|lat|lon`,
  giving each record a stable id since the API has none), `fetchLatestEarthquakes()`,
  `upsertEarthquakes()` (batched `INSERT OR IGNORE` → idempotent ingestion).
- `src/types.ts` — `Env` bindings + `EarthquakeApiRecord` / `EarthquakeRow`.
- `migrations/0001_init.sql` — `earthquakes` table, indexed on `utcdatetime`,
  `magdefault`, `location`. Stores only structured fields (no raw-JSON blob) to keep
  the indefinitely-growing table small.
- `public/index.html` — still the default scaffold page (replaced in Phase 4).

Bindings in `wrangler.jsonc`: `ASSETS` (static assets, `run_worker_first: ["/admin/*"]`)
and `DB` (D1 database `earthquake-db`).

## Commands

- `npm run dev` / `npm start` — run locally via `wrangler dev`
- `npm run deploy` — deploy via `wrangler deploy`
- `npx wrangler types` — regenerate TypeScript types; **run this after changing any bindings in `wrangler.jsonc`**
- `npx wrangler d1 migrations apply earthquake-db --local` (or `--remote`) — apply D1 migrations

There is no lint, test, or build script configured yet.

## Local setup

- `ADMIN_TOKEN` is read from a gitignored `.dev.vars` file for local dev
  (`ADMIN_TOKEN="..."`); in production set it via `wrangler secret put ADMIN_TOKEN`.
- The live data source (`https://api.data.gov.my/weather/warning/earthquake/`) is
  unauthenticated. Trigger ingestion locally with
  `curl -X POST localhost:8787/admin/ingest -H "Authorization: Bearer <token>"`.

## Cloudflare Workers guidance

Knowledge of Cloudflare Workers APIs and limits may be outdated. Before any Workers, KV, R2, D1, Durable Objects, Queues, Vectorize, AI, or Agents SDK task, retrieve current docs rather than relying on training data — use the `cloudflare` / `wrangler` / `agents-sdk` skills, or the docs MCP at `https://docs.mcp.cloudflare.com/mcp`.

- For limits and quotas, check the product's `/platform/limits/` page (e.g. `/workers/platform/limits`).
- Error 1102 = CPU/Memory exceeded — check `/workers/platform/limits/`.
- Product docs live under `/kv/`, `/r2/`, `/d1/`, `/durable-objects/`, `/queues/`, `/vectorize/`, `/workers-ai/`, `/agents/` on developers.cloudflare.com.
- If Durable Objects or Workflows are introduced, follow their respective best-practice rules pages (`durable-objects/best-practices/rules-of-durable-objects/`, `workflows/build/rules-of-workflows/`).
