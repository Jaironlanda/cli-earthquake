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

Built as a series of independently verifiable phases. **Phases 1–5 are
complete**; later phases are not built yet.

| Phase | Scope | State |
| ----- | ----- | ----- |
| 1 | Data layer — D1 schema + fetch → dedupe → store | ✅ Done |
| 2 | Cron automation (15-min ingestion) | ✅ Done |
| 3 | Terminal backend (Durable Object + WebSockets) | ✅ Done |
| 4 | Terminal frontend (xterm.js) | ✅ Done |
| 5 | Real-time alerts | ✅ Done |
| 6 | Map panel (Protomaps + MapLibre) | ⬜ Planned |
| 7 | Export + polish | ⬜ Planned |

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

Each record's primary key is a truncated SHA-256 of `utcdatetime|lat|lon`. The
upstream feed has no id field, so hashing its natural key makes ingestion
idempotent: re-fetching the same feed inserts zero new rows.

- `src/index.ts` — Worker entry; bearer-guarded `POST /admin/ingest`, `/ws` → Durable Object, else static assets.
- `src/lib/ingest.ts` — fetch, `computeId`, batched upsert; returns the actual newly-inserted rows for alert fan-out.
- `src/durable-objects/terminal-hub.ts` — `TerminalHub` DO: WebSocket Hibernation session hub; `broadcastNewEarthquakes()` RPC fans alerts out to every socket.
- `src/lib/commands.ts` — `executeCommand()`: parses `help` / `list` / `search` and runs parameterized D1 queries.
- `src/lib/format.ts` — ANSI colour + fixed-width table/detail renderers (magnitude colour-coded by severity) + `renderAlertBanner()`.
- `src/types.ts` — `Env` + API/row types.
- `migrations/0001_init.sql` — `earthquakes` table (structured fields only, no raw JSON).
- `public/index.html` — xterm.js terminal + map-panel shell; loads xterm via CDN (no build step).
- `public/app.js` — terminal client: opens `/ws`, hand-rolls the prompt/line editor (Enter, backspace, cursor keys, ↑/↓ history, Ctrl+A/E/U/L/C), writes ANSI replies to xterm, renders pushed `alert` banners without disturbing the current line, auto-reconnects.
- `public/styles.css` — full-viewport terminal/map split layout with a connection-status indicator.

### Terminal commands (over `/ws`)

The WebSocket speaks JSON: send `{"type":"input","line":"<command>"}`, receive
`{"type":"output","text":"...ANSI..."}` (or `welcome` / `error`). Server-pushed
`{"type":"alert","text":"...ANSI..."}` frames arrive unsolicited when a cron
ingest finds new earthquakes.

| Command | Purpose |
| ------- | ------- |
| `help` | List available commands. |
| `list [--mag>N] [--since YYYY-MM-DD] [--location STR] [--limit N]` | Recent earthquakes, newest first. |
| `search <id \| text>` | 16-hex id → detail view; otherwise location text search. |

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
or `search <location>` at the prompt. Backspace, cursor keys, and ↑/↓ command
history work; magnitude values are colour-coded by severity. (The map panel to the
right is a placeholder until Phase 6.)

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
