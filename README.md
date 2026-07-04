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

Built as a series of independently verifiable phases. **All 7 phases are
complete.**

| Phase | Scope | State |
| ----- | ----- | ----- |
| 1 | Data layer — D1 schema + fetch → dedupe → store | ✅ Done |
| 2 | Cron automation (15-min ingestion) | ✅ Done |
| 3 | Terminal backend (Durable Object + WebSockets) | ✅ Done |
| 4 | Terminal frontend (xterm.js) | ✅ Done |
| 5 | Real-time alerts | ✅ Done |
| 6 | Map panel (Protomaps + MapLibre) | ✅ Done |
| 7 | Export (CSV/JSON download) + `trend` chart | ✅ Done |

## Architecture (current)

```
api.data.gov.my ─fetch─▶ Worker (src/index.ts) ─INSERT OR IGNORE─▶ D1 (earthquakes)
                         POST /admin/ingest + */15 cron            │        │
                              new rows ─broadcast RPC─▶            │        │ query
   xterm.js  ◀─WebSocket──▶ TerminalHub (Durable Object) ◀─────────┘────────┘
   (public/)     /ws     parse command → ANSI reply · push {type:"alert"} to all tabs
```

After each cron ingest, any genuinely-new rows are pushed to every open terminal
as a `{"type":"alert"}` banner — no page refresh needed (Phase 5). The
`TerminalHub` uses the WebSocket Hibernation API, so idle tabs cost nothing yet
still receive the fan-out.

`list` / `search` results (and alerts) also carry a GeoJSON `mapData` payload
that a MapLibre GL JS panel plots beside the terminal as circles sized/coloured
by magnitude (Phase 6). The basemap is Protomaps' hosted dark vector style when
a `PROTOMAPS_KEY` is configured; without one it degrades to a plain dark canvas
so points still render.

Each record's primary key is a truncated SHA-256 of `utcdatetime|lat|lon`. The
upstream feed has no id field, so hashing its natural key makes ingestion
idempotent: re-fetching the same feed inserts zero new rows.

- `src/index.ts` — Worker entry; bearer-guarded `POST /admin/ingest`, `GET /api/config` (Protomaps key), `/ws` → Durable Object, else static assets.
- `src/lib/ingest.ts` — fetch, `computeId`, batched upsert; returns the actual newly-inserted rows for alert fan-out.
- `src/durable-objects/terminal-hub.ts` — `TerminalHub` DO: WebSocket Hibernation session hub; `broadcastNewEarthquakes()` RPC fans alerts (with `mapData`) out to every socket.
- `src/lib/commands.ts` — `executeCommand()`: a single command registry drives both dispatch and `help`; parses `help` / `list` / `search` / `export` / `trend`, runs parameterized D1 queries, returns `{text, mapData?, download?}`.
- `src/lib/format.ts` — ANSI colour + fixed-width table/detail renderers (magnitude colour-coded by severity) + `renderAlertBanner()` + `renderTrend()` (ASCII bar chart).
- `src/lib/export.ts` — `rowsToCSV()` / `rowsToJSON()`: serialize a result set into downloadable file content (Phase 7).
- `src/lib/geojson.ts` — `rowsToGeoJSON()`: converts D1 rows into the map panel's Point FeatureCollection.
- `src/types.ts` — `Env` + API/row types.
- `migrations/0001_init.sql` — `earthquakes` table (structured fields only, no raw JSON).
- `public/index.html` — xterm.js terminal + MapLibre map shell; loads xterm, MapLibre GL JS, and the Protomaps basemaps helper via CDN (no build step).
- `public/app.js` — terminal client: opens `/ws`, hand-rolls the prompt/line editor (Enter, backspace, cursor keys, ↑/↓ history, Ctrl+A/E/U/L/C), writes ANSI replies to xterm, renders pushed `alert` banners without disturbing the current line, forwards `mapData` to the map, saves `export` downloads via a Blob, auto-reconnects.
- `public/map.js` — MapLibre GL JS map; exposes `window.EarthquakeMap.setFeatures()` / `.addFeatures()`, plots magnitude-scaled circles, and picks a Protomaps or dark-canvas basemap from `/api/config`.
- `public/styles.css` — full-viewport terminal/map split layout with a connection-status indicator and dark-themed map chrome.

### Terminal commands (over `/ws`)

The WebSocket speaks JSON: send `{"type":"input","line":"<command>"}`, receive
`{"type":"output","text":"...ANSI...","mapData":{...GeoJSON}}` (or `welcome` /
`error`). `export` instead returns `{"type":"download","filename","mime","content","text"}`,
which the browser saves to disk. Server-pushed `{"type":"alert","text":"...","mapData":{...}}`
frames arrive unsolicited when a cron ingest finds new earthquakes. `mapData` is
a Point FeatureCollection the browser plots on the map panel.

| Command | Purpose |
| ------- | ------- |
| `help` | List available commands. |
| `list [--mag>N] [--since YYYY-MM-DD] [--location STR] [--limit N]` | Recent earthquakes, newest first. |
| `search <id \| text>` | 16-hex id → detail view; otherwise location text search. |
| `export csv\|json [list filters]` | Download the filtered set as a CSV or JSON file. |
| `trend [--by day\|month] [list filters]` | ASCII bar chart of quake counts per time bucket, coloured by peak magnitude. |

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

Then open **http://localhost:8787** for the terminal UI: type `help`, `list --mag>5`,
`trend --by month`, or `search <location>` at the prompt. Backspace, cursor keys,
and ↑/↓ command history work; magnitude values are colour-coded by severity. The
map panel to the right plots the current result set — run `list --mag>6` to see
the matching circles appear, or `search <location>` to re-centre it. `export csv
--mag>5` downloads the filtered set as a file.

### Map basemap (optional)

The map renders on a plain dark canvas out of the box. To get a real vector
basemap, grab a free key from [protomaps.com](https://protomaps.com/dashboard)
and expose it to the browser via `GET /api/config`:

```bash
# local dev — add to .dev.vars
echo 'PROTOMAPS_KEY="<your-key>"' >> .dev.vars
# production — set the var in wrangler.jsonc, or:
npx wrangler secret put PROTOMAPS_KEY
```

The key is a publishable, domain-restrictable basemap token (it ends up in tile
URLs the browser fetches), not a server secret.

Trigger an ingestion run and inspect the result:

```bash
TOKEN=$(sed -n 's/ADMIN_TOKEN="\(.*\)"/\1/p' .dev.vars)
curl -X POST localhost:8787/admin/ingest -H "Authorization: Bearer $TOKEN"
# → {"fetched":805,"inserted":805}   (re-run → "inserted":0)

npx wrangler d1 execute earthquake-db --local \
  --command "SELECT count(*) FROM earthquakes"
```

Exercise the terminal backend over WebSocket (any WS client; here with Node's
built-in `WebSocket`):

```bash
node --input-type=module -e '
const ws = new WebSocket("ws://localhost:8787/ws");
ws.onmessage = (e) => { console.log(JSON.parse(e.data).text); ws.close(); };
ws.onopen = () => ws.send(JSON.stringify({ type: "input", line: "list --mag>6" }));
'
```

Verify real-time alerts (Phase 5): run `wrangler dev --test-scheduled`, clear the
local table (`... --command "DELETE FROM earthquakes"`) so a scheduled ingest
treats every fetched record as new, open a WS client, then trigger the cron with
`curl "localhost:8787/__scheduled?cron=*/15+*+*+*+*"` — the socket receives an
unsolicited `{"type":"alert"}` banner. Re-triggering inserts nothing and sends no
alert.

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
