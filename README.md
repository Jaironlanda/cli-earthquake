# Earthquake CLI

A web-based terminal for exploring live earthquake data, built on Cloudflare
Workers. Data comes from the Malaysian government open-data feed
([`api.data.gov.my`](https://api.data.gov.my/weather/warning/earthquake/)) —
worldwide events relevant to the Malaysia/SE-Asia region, updated continuously
and served without authentication.

The end goal (see [`planning/implementation-plan.md`](planning/implementation-plan.md))
is an xterm.js terminal in the browser where you can `list`, `search`, filter,
and `export` earthquakes, see them plotted on a Protomaps map, and receive
real-time alerts as new events are ingested — all backed by Cloudflare D1,
Durable Objects, and Cron Triggers.

## Status

Built as a series of independently verifiable phases. **Phase 1 (data layer) is
complete**; later phases are not built yet.

| Phase | Scope | State |
| ----- | ----- | ----- |
| 1 | Data layer — D1 schema + fetch → dedupe → store | ✅ Done |
| 2 | Cron automation (15-min ingestion) | ✅ Done |
| 3 | Terminal backend (Durable Object + WebSockets) | ⬜ Planned |
| 4 | Terminal frontend (xterm.js) | ⬜ Planned |
| 5 | Real-time alerts | ⬜ Planned |
| 6 | Map panel (Protomaps + MapLibre) | ⬜ Planned |
| 7 | Export + polish | ⬜ Planned |

## Architecture (current)

```
api.data.gov.my  ──fetch──▶  Worker (src/index.ts)  ──INSERT OR IGNORE──▶  D1 (earthquakes)
                             POST /admin/ingest
```

Each record's primary key is a truncated SHA-256 of `utcdatetime|lat|lon`. The
upstream feed has no id field, so hashing its natural key makes ingestion
idempotent: re-fetching the same feed inserts zero new rows.

- `src/index.ts` — Worker entry; bearer-guarded `POST /admin/ingest`, else static assets.
- `src/lib/ingest.ts` — fetch, `computeId`, batched upsert.
- `src/types.ts` — `Env` + API/row types.
- `migrations/0001_init.sql` — `earthquakes` table (structured fields only, no raw JSON).

## Development

```bash
npm install

# One-time: create the D1 database (already provisioned as "earthquake-db")
# npx wrangler d1 create earthquake-db   # then paste database_id into wrangler.jsonc

# Apply migrations to the local database
npx wrangler d1 migrations apply earthquake-db --local

# Provide the admin token for local dev (gitignored)
echo 'ADMIN_TOKEN="<some-secret>"' > .dev.vars

# Run locally
npm run dev
```

Trigger an ingestion run and inspect the result:

```bash
TOKEN=$(sed -n 's/ADMIN_TOKEN="\(.*\)"/\1/p' .dev.vars)
curl -X POST localhost:8787/admin/ingest -H "Authorization: Bearer $TOKEN"
# → {"fetched":805,"inserted":805}   (re-run → "inserted":0)

npx wrangler d1 execute earthquake-db --local \
  --command "SELECT count(*) FROM earthquakes"
```

## Deployment

```bash
npx wrangler d1 migrations apply earthquake-db --remote
npx wrangler secret put ADMIN_TOKEN
npm run deploy
```

## Commands

| Command | Purpose |
| ------- | ------- |
| `npm run dev` / `npm start` | Run locally via `wrangler dev` |
| `npm run deploy` | Deploy via `wrangler deploy` |
| `npx wrangler types` | Regenerate TS types (run after editing bindings in `wrangler.jsonc`) |
| `npx wrangler d1 migrations apply earthquake-db --local\|--remote` | Apply D1 migrations |
