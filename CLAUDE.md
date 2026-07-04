# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

"Earthquake CLI": a web-based terminal (xterm.js frontend) over live
earthquake data from `api.data.gov.my`, built on Cloudflare Workers. The full,
phased build is described in `planning/implementation-plan.md`; `planning/project-draft.md`
holds the original spec. Work proceeds one phase at a time, each on its own branch.

**Phases 1 (data layer), 2 (cron automation), 3 (terminal backend), 4
(xterm.js terminal frontend), 5 (real-time alerts), and 6 (Protomaps/MapLibre
map panel) are done** — the rest of the plan (Phase 7: export + polish) is not
built yet.

Current code:

- `src/index.ts` — Worker entry (`fetch` + `scheduled`). Routes `POST /admin/ingest`
  (bearer-guarded by `ADMIN_TOKEN`) through the ingestion pipeline; `GET /api/config`
  returns `{protomapsKey}` (Phase 6) for the browser map; routes `/ws`
  (WebSocket upgrade) to the single `TerminalHub` DO (`getByName("global-hub")`);
  everything else falls through to `env.ASSETS.fetch(request)` (static assets in
  `public/`). Also re-exports `TerminalHub` so the runtime can instantiate it. The
  `scheduled()` cron handler runs the same idempotent pipeline every 15 minutes.
- `src/lib/ingest.ts` — `computeId()` (truncated SHA-256 of `utcdatetime|lat|lon`,
  giving each record a stable id since the API has none), `fetchLatestEarthquakes()`,
  `upsertEarthquakes()` (batched `INSERT OR IGNORE` → idempotent ingestion). Returns
  `insertedRows` (the actually-new rows, keyed off each statement's `meta.changes`)
  so Phase 5 can broadcast them.
- `src/durable-objects/terminal-hub.ts` — `TerminalHub extends DurableObject<Env>`.
  Uses the **WebSocket Hibernation API** (`ctx.acceptWebSocket`), so the DO can be
  evicted while sockets stay open (matters for Phase 5 alert fan-out).
  `webSocketMessage()` parses `{type:"input",line}`, calls `executeCommand()`, and
  replies `{type:"output",text,mapData}` (or `welcome` / `error`). `broadcastNewEarthquakes()`
  is an RPC method (called by `scheduled()`, not over `.fetch()`) that renders one
  alert banner and `ws.send`s `{type:"alert",text,mapData}` to every `ctx.getWebSockets()`.
- `src/lib/commands.ts` — `executeCommand(line, env)`: quote-aware tokenizer, parses
  `help`, `list [--mag>N] [--since DATE] [--location STR] [--limit N]`,
  `search <id|text>`, and runs **parameterized** D1 queries. Returns a
  `CommandResult` (`{text, mapData?}`) — row-returning commands attach `mapData`
  (Phase 6). User-facing problems return a friendly error string; unexpected errors
  are re-thrown.
- `src/lib/format.ts` — ANSI helpers, magnitude→colour severity mapping, and
  fixed-width table + detail renderers. Uses `\r\n` line endings for xterm.js.
  `renderAlertBanner()` formats the Phase 5 push (top-magnitude rows first, capped
  at 10 with a "…and N more" summary).
- `src/lib/geojson.ts` — `rowsToGeoJSON()` (Phase 6): converts `EarthquakeRow[]`
  into a Point `FeatureCollection` (props: `id`, `mag`, `depth`, `location`, `time`),
  skipping rows without finite coords. Shared by `commands.ts` and `terminal-hub.ts`.
- `src/types.ts` — `Env` bindings (incl. `TERMINAL_HUB`, `PROTOMAPS_KEY`) +
  `EarthquakeApiRecord` / `EarthquakeRow`.
- `migrations/0001_init.sql` — `earthquakes` table, indexed on `utcdatetime`,
  `magdefault`, `location`. Stores only structured fields (no raw-JSON blob) to keep
  the indefinitely-growing table small.
- `public/index.html` — xterm.js terminal + MapLibre map shell. Loads `@xterm/xterm`,
  `@xterm/addon-fit`, `maplibre-gl`, and `@protomaps/basemaps` from a CDN via
  `<script>` tags (no build step, matching the static-asset convention); loads
  `public/map.js` (classic script, sets `window.EarthquakeMap`) then `public/app.js`
  as a module, plus `public/styles.css`.
- `public/app.js` — terminal client. Creates a `Terminal` + `FitAddon`, opens the
  `/ws` WebSocket, and **hand-rolls the prompt/line editor** via `term.onData()`
  (xterm.js has no built-in shell): buffered line with insert-at-cursor, Enter,
  backspace, ←/→, ↑/↓ history (with draft stash), Home/End, Ctrl+A/E/U/L/C. Sends
  `{type:"input",line}`; on `welcome`/`output`/`error` writes the ANSI text back, and
  forwards any `mapData` to `EarthquakeMap.setFeatures()` (Phase 6).
  A server-pushed `{type:"alert"}` can arrive at any time: it prints the banner,
  upserts its `mapData` via `EarthquakeMap.addFeatures()`, then re-renders the prompt
  + half-typed line (skipped while `busy`, since the pending reply redraws the prompt
  itself). A `busy` flag gates input while a command is in flight; auto-reconnects
  with backoff (welcome only greets once).
- `public/map.js` — MapLibre GL JS map (Phase 6). Fetches `/api/config`; if a
  `protomapsKey` is present it builds the Protomaps dark vector style via the
  `basemaps` helper, else falls back to a plain dark-background style so points still
  render. Adds a `circle` layer sized/coloured by magnitude (bands mirror
  `format.ts`). Exposes `window.EarthquakeMap.setFeatures(fc)` (replace + fit bounds)
  and `.addFeatures(fc)` (upsert by id, for alerts); both queue until the map's
  `load` fires. Hover popups show magnitude/location/time.
- `public/styles.css` — full-viewport flex split (terminal | MapLibre map) plus a
  title-bar connection-status indicator and dark-themed map chrome/popups; stacks
  vertically under 800px.

Bindings in `wrangler.jsonc`: `ASSETS` (static assets,
`run_worker_first: ["/admin/*", "/ws", "/api/*"]`), `DB` (D1 database `earthquake-db`),
`TERMINAL_HUB` (Durable Object → `TerminalHub`; `migrations` tag `v1`,
`new_sqlite_classes: ["TerminalHub"]`), and a `PROTOMAPS_KEY` var (empty by default;
publishable basemap key served to the browser via `/api/config`);
`triggers.crons: ["*/15 * * * *"]` drives the `scheduled()` handler.

## Commands

- `npm run dev` / `npm start` — run locally via `wrangler dev`
- `npm run typecheck` — type-check with `tsc --noEmit` (config in `tsconfig.json`)
- `npm run deploy` — deploy via `wrangler deploy`
- `npx wrangler types` — regenerate TypeScript types; **run this after changing any bindings in `wrangler.jsonc`**
- `npx wrangler d1 migrations apply earthquake-db --local` (or `--remote`) — apply D1 migrations

There is no lint or test script configured yet.

## Local setup

- `ADMIN_TOKEN` is read from a gitignored `.dev.vars` file for local dev
  (`ADMIN_TOKEN="..."`); in production set it via `wrangler secret put ADMIN_TOKEN`.
- The live data source (`https://api.data.gov.my/weather/warning/earthquake/`) is
  unauthenticated. Trigger ingestion locally with
  `curl -X POST localhost:8787/admin/ingest -H "Authorization: Bearer <token>"`.
- The terminal backend (`/ws`) is unauthenticated. Test it with any WebSocket
  client (e.g. Node's built-in `WebSocket`) by sending
  `{"type":"input","line":"list --mag>6"}` and reading the `output` reply (which
  now also carries `mapData`).
- `PROTOMAPS_KEY` is optional. Without it the map uses a plain dark canvas; set
  `PROTOMAPS_KEY="..."` in `.dev.vars` (or `wrangler secret put PROTOMAPS_KEY`) to
  enable the Protomaps basemap. It's a publishable key, exposed to the browser via
  `/api/config`.

## Cloudflare Workers guidance

Knowledge of Cloudflare Workers APIs and limits may be outdated. Before any Workers, KV, R2, D1, Durable Objects, Queues, Vectorize, AI, or Agents SDK task, retrieve current docs rather than relying on training data — use the `cloudflare` / `wrangler` / `agents-sdk` skills, or the docs MCP at `https://docs.mcp.cloudflare.com/mcp`.

- For limits and quotas, check the product's `/platform/limits/` page (e.g. `/workers/platform/limits`).
- Error 1102 = CPU/Memory exceeded — check `/workers/platform/limits/`.
- Product docs live under `/kv/`, `/r2/`, `/d1/`, `/durable-objects/`, `/queues/`, `/vectorize/`, `/workers-ai/`, `/agents/` on developers.cloudflare.com.
- If Durable Objects or Workflows are introduced, follow their respective best-practice rules pages (`durable-objects/best-practices/rules-of-durable-objects/`, `workflows/build/rules-of-workflows/`).
