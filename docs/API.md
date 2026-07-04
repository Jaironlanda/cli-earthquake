# Earthquake CLI — API Reference

The Worker ([`src/index.ts`](../src/index.ts)) exposes a small surface: two JSON
HTTP routes, one admin route, and a WebSocket terminal. Everything else falls
through to the static assets in [`public/`](../public/).

- **Base URL (local):** `http://localhost:8787`
- **Base URL (prod):** your deployed `*.workers.dev` host (or custom domain)
- **Routing:** `/admin/*`, `/ws`, and `/api/*` are handled by the Worker first
  (`run_worker_first` in [`wrangler.jsonc`](../wrangler.jsonc)); all other paths
  serve static files.

| Route | Method | Auth | Purpose |
| ----- | ------ | ---- | ------- |
| [`/api/config`](#get-apiconfig) | `GET` | none | Client bootstrap config (Protomaps key). |
| [`/admin/ingest`](#post-adminingest) | `POST` | Bearer | Run the fetch → dedupe → store pipeline. |
| [`/ws`](#ws--websocket-terminal) | `GET` (Upgrade) | none | WebSocket terminal (query commands, receive alerts). |

There is also a **cron trigger** (`*/15 * * * *`) that runs the same ingestion
pipeline as `/admin/ingest` on a schedule — see [`scheduled()`](../src/index.ts).
It is not an HTTP route; it broadcasts any new records to open terminals.

---

## HTTP endpoints

### `GET /api/config`

Hands the browser its runtime configuration. Currently just the publishable
Protomaps basemap key (empty string when unset — the map then falls back to a
plain dark canvas).

**Response** `200 application/json`

```json
{ "protomapsKey": "" }
```

The key is a **publishable**, domain-restrictable basemap token (it ends up in
tile URLs the browser fetches), not a server secret.

```bash
curl -s localhost:8787/api/config
# → {"protomapsKey":""}
```

---

### `POST /admin/ingest`

Triggers one run of the ingestion pipeline: fetch the live feed from
`api.data.gov.my`, derive a stable id per record, and `INSERT OR IGNORE` into
D1. Ingestion is **idempotent** — re-running never duplicates rows (see
[`ingest()`](../src/lib/ingest.ts)).

**Auth** — `Authorization: Bearer <ADMIN_TOKEN>` is required. `ADMIN_TOKEN` is
read from `.dev.vars` locally, or set via `wrangler secret put ADMIN_TOKEN` in
production.

**Responses**

| Status | Body | When |
| ------ | ---- | ---- |
| `200` | `{ "fetched": N, "inserted": M, "insertedRows": [...] }` | Success. `inserted` is the count of genuinely-new rows. |
| `401` | `{ "error": "Unauthorized" }` | Missing/incorrect bearer token (or `ADMIN_TOKEN` unset). |
| `405` | `Method Not Allowed` (+ `Allow: POST`) | Any method other than `POST`. |
| `502` | `{ "error": "Ingestion failed", "detail": "..." }` | Upstream fetch or DB write failed. |

> `insertedRows` mirrors `inserted` and carries the actual new rows (used
> internally by the cron broadcast). The response can be large after a cold
> start; callers that only need counts can ignore it.

```bash
TOKEN=$(sed -n 's/ADMIN_TOKEN="\(.*\)"/\1/p' .dev.vars)
curl -X POST localhost:8787/admin/ingest -H "Authorization: Bearer $TOKEN"
# → {"fetched":805,"inserted":805,"insertedRows":[...]}   (re-run → "inserted":0)
```

---

## `/ws` — WebSocket terminal

`GET /ws` with an `Upgrade: websocket` header opens a terminal session, handled
by the single `TerminalHub` Durable Object
([`src/durable-objects/terminal-hub.ts`](../src/durable-objects/terminal-hub.ts)).
A plain `GET` without the upgrade header returns `426 Upgrade Required`.

The socket speaks **line-delimited JSON frames**. Every frame has a `type`.

### Client → server

```jsonc
{ "type": "input", "line": "list --mag>5" }
```

Anything that isn't a valid `{"type":"input","line":"<string>"}` envelope gets a
friendly `error` frame back rather than closing the socket.

### Server → client

| `type` | Fields | When |
| ------ | ------ | ---- |
| `welcome` | `text` | Once, on connect (the init-screen banner). |
| `output` | `text`, `mapData?` | Normal command result. `text` is ANSI; `mapData` is GeoJSON for the map. |
| `download` | `text`, `filename`, `mime`, `content` | `export` result — the client saves the file, then prints `text`. |
| `alert` | `text`, `mapData` | **Unsolicited** — pushed to every socket when a cron ingest finds new quakes. |
| `error` | `text` | Malformed frame, or an internal error running a command. |

`text` fields contain **ANSI escape codes** (colour, bold) meant for xterm.js —
strip them (`/\x1b\[[0-9;]*m/g`) if consuming programmatically.

`mapData` is a GeoJSON `FeatureCollection` of `Point`s
([`rowsToGeoJSON`](../src/lib/geojson.ts)); each feature's `properties` carry
`id`, `mag`, `depth`, `location`, and `time`.

### Example (Node's built-in `WebSocket`)

```bash
node --input-type=module -e '
const ws = new WebSocket("ws://localhost:8787/ws");
ws.onmessage = (e) => {
  const f = JSON.parse(e.data);
  if (f.type === "welcome") return;              // skip the banner
  console.log(f.type, "\n", f.text);
  ws.close();
};
ws.onopen = () => ws.send(JSON.stringify({ type: "input", line: "list --mag>6" }));
'
```

---

## Command reference

Commands are parsed by [`executeCommand`](../src/lib/commands.ts), driven by a
single registry so `help` can never drift from what the parser accepts. All D1
queries are **parameterized** — user input is never interpolated into SQL.

| Command (aliases) | Description |
| ----------------- | ----------- |
| `help` (`?`) | List all commands and options. |
| `clear` (`cls`) | Clear the terminal screen. |
| `list [filters]` (`ls`) | Recent earthquakes, newest first. Returns `output` + `mapData`. |
| `search <id \| text>` (`find`) | A 16-hex-char token → id detail view; otherwise a location text search. |
| `export csv\|json [filters]` | Serialize the filtered set to a downloadable file. Returns a `download` frame. |
| `trend [--by day\|month] [filters]` | ASCII bar chart of counts per time bucket, coloured by peak magnitude. |

### Filters (shared by `list`, `export`, `trend`)

| Flag | Meaning |
| ---- | ------- |
| `--mag>N` / `--mag>=N` / `--mag N` / `--min-mag N` | Minimum magnitude. |
| `--since YYYY-MM-DD` | Only records on/after this UTC date. |
| `--location STR` (`--loc`) | Case-sensitive substring match on either location field. Quote multi-word values: `--location "New Zealand"`. |
| `--limit N` | Max rows. `list`/`search` default 20, max 100; `export` caps at 10,000. |
| `--by day\|month` | (`trend` only) Time bucket; default `day`. |

Bad flags, non-numeric magnitudes, unknown commands, and missing arguments all
return a friendly one-line `Error:` (or `Unknown command:`) in the `text` field —
the socket stays open.

```
list --mag>5 --since 2026-01-01 --location Sabah --limit 50
search Kepulauan
search aaaa000000000001
export json --mag>6
trend --by month --location Indonesia
```

---

## Data model

Each persisted row ([`EarthquakeRow`](../src/types.ts), table in
[`migrations/0001_init.sql`](../migrations/0001_init.sql)):

| Field | Type | Notes |
| ----- | ---- | ----- |
| `id` | `string` | Primary key: first 16 hex chars of `SHA-256(utcdatetime\|lat\|lon)`. The upstream feed has no id, so hashing its natural key makes ingestion idempotent. |
| `utcdatetime` | `string` | ISO 8601, e.g. `2026-07-03T04:04:49`. |
| `localdatetime` | `string \| null` | ISO 8601 in Malaysia local time. |
| `lat`, `lon` | `number` | Decimal degrees. |
| `depth` | `number \| null` | Kilometres. |
| `location` | `string \| null` | Displayed place name. |
| `location_original` | `string \| null` | Original/English place name. |
| `magdefault` | `number \| null` | Magnitude. |
| `magtypedefault` | `string \| null` | Magnitude type, e.g. `mb`. |
| `status` | `string \| null` | e.g. `NORMAL`. |

`export json` emits an array of these objects; `export csv` emits the same
fields as RFC-4180 rows ([`src/lib/export.ts`](../src/lib/export.ts)).

---

## Testing

The API is covered by [`test/`](../test) using
[`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/),
which runs the tests **inside** the Workers runtime with the real `DB` (D1) and
`TERMINAL_HUB` (Durable Object) bindings — no platform mocking.

```bash
npm test          # watch mode
npm run test:run  # single run (CI)
```

| File | Covers |
| ---- | ------ |
| [`test/api.test.ts`](../test/api.test.ts) | HTTP routing (`/api/config`, `/admin/ingest` auth, `/ws` upgrade) + a full terminal round-trip through the Durable Object. |
| [`test/commands.test.ts`](../test/commands.test.ts) | `executeCommand` parsing, filtering, and the `search`/`export`/`trend` variants against a seeded D1. |
| [`test/ingest.test.ts`](../test/ingest.test.ts) | `computeId` stability and `upsertEarthquakes` idempotency. |

The `/admin/ingest` **success path** hits the live upstream feed over the
network, so it is exercised manually (see [`README.md`](../README.md)) rather
than in the hermetic test suite; the ingest pipeline itself is unit-tested via
`upsertEarthquakes` with fixture records.
