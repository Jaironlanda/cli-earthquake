# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

"Earthquake CLI": a web-based terminal (xterm.js frontend) over live
earthquake data from `api.data.gov.my`, built on Cloudflare Workers. The full,
phased build is described in `planning/implementation-plan.md`; `planning/project-draft.md`
holds the original spec. Work proceeds one phase at a time, each on its own branch.

**All 7 phases are done**: 1 (data layer), 2 (cron automation), 3 (terminal
backend), 4 (xterm.js terminal frontend), 5 (real-time alerts), 6
(Protomaps/MapLibre map panel), and 7 (CSV/JSON export download + `trend` ASCII
chart + registry-driven help). The build in `planning/implementation-plan.md`
is complete.

**Phase 8 (post-plan, "fun & useful" commands)** extended the same registry with
`stats`, `sparkline`, `top`, `nearby <lat> <lon>`, `minimap`, `compare A B`,
`richter <mag>`, `felt <id>`, `random`, and `banner` (a D1-backed
year-at-a-glance summary — total / mag-5+ count / strongest / latest / avg mag /
monthly sparkline — that doubles as the on-connect welcome frame, whose
`mapData` plots the year's newest quakes on page open), plus per-terminal alert
filtering: `watch [--mag>N] [--location STR]` / `unwatch` store a filter on the
WebSocket (`serializeAttachment`, survives hibernation) so alerts fan out only to
matching sockets, and significant alerts (≥ mag 5) ring the terminal bell (`\x07`).

**Viewer-timezone display (post-Phase-8)**: the browser sends its IANA timezone
(`Intl.DateTimeFormat().resolvedOptions().timeZone`) as `?tz=` on the `/ws` URL;
the DO validates it (`resolveTimeZone`) and persists it in the socket attachment,
and every rendered timestamp (welcome banner, tables, detail cards, alerts, map
popups) is shown 12-hour `MM-DD-YYYY hh:mm AM/PM` in that zone with a short zone
label (e.g. `GMT+8`), falling back to UTC. Stored data stays UTC; `--since`
filters, `trend`/`sparkline` bucket labels, and CSV/JSON exports remain UTC.

**Responsive rendering (post-timezone)**: the UI adapts to screen size on two
levels. Client-side (`public/`), the floating terminal uses `dvh` heights, a
`@media (pointer: coarse)` touch-target bump, a compacted titlebar under 560px,
and a JS-driven font size (`app.js` `applyResponsiveFont`, 11–14px) that shrinks
on narrow widths so more columns fit. Server-side, the browser reports its
terminal column count as `?cols=` on `/ws` (validated by `resolveCols`, persisted
in the socket attachment) and again in every `{type:"input"}` frame (so it tracks
resizes); the DO threads it into `executeCommand(line, env, tz?, width?)`, and the
`format.ts` renderers adapt: the welcome banner drops its 58-col box for a compact
header below ~58 cols, the `list`/`search`/`top`/alert table drops the ID column
and shrinks LOCATION on tablet widths then becomes stacked two-line cards on a
phone (<54 cols), and `nearby`/`trend`/`minimap` scale their columns/bars/grid to
the width. `width` is always optional — `undefined` selects the full desktop
layout, which is what raw ws clients and the test suite get.

Current code:

- `src/index.ts` — Worker entry (`fetch` + `scheduled`). Routes `POST /admin/ingest`
  (bearer-guarded by `ADMIN_TOKEN`) through the ingestion pipeline; `GET /api/config`
  returns `{protomapsKey}` (Phase 6) for the browser map (edge-cached an hour via
  `Cache-Control` so repeat page loads skip the Worker); routes `/ws`
  (WebSocket upgrade) to the single `TerminalHub` DO (`getByName("global-hub")`),
  after throttling connection attempts per client IP through the `WS_CONNECT_LIMIT`
  rate-limit binding (429 when exceeded);
  everything else falls through to `env.ASSETS.fetch(request)` (static assets in
  `public/`). Also re-exports `TerminalHub` so the runtime can instantiate it. The
  `scheduled()` cron handler runs the same idempotent pipeline every 15 minutes.
- `src/lib/ingest.ts` — `computeId()` (truncated SHA-256 of `utcdatetime|lat|lon`,
  giving each record a stable id since the API has none; lat/lon are normalised
  through `Number()` so a formatting-only feed change can't duplicate an event),
  `fetchLatestEarthquakes()` (bounded by an `AbortSignal.timeout` so a hung
  upstream can't stall the cron),
  `upsertEarthquakes()` (batched `INSERT OR IGNORE` → idempotent ingestion). Returns
  `insertedRows` (the actually-new rows, keyed off each statement's `meta.changes`)
  so Phase 5 can broadcast them.
- `src/durable-objects/terminal-hub.ts` — `TerminalHub extends DurableObject<Env>`.
  Uses the **WebSocket Hibernation API** (`ctx.acceptWebSocket`), so the DO can be
  evicted while sockets stay open (matters for Phase 5 alert fan-out).
  `webSocketMessage()` first applies a **hibernation-safe per-socket command
  throttle** (fixed window, `RATE_MAX` inputs per `RATE_WINDOW_MS`; over-limit
  frames get a friendly `error` and are dropped), then parses `{type:"input",line}`,
  calls `executeCommand()`, and
  replies `{type:"output",text,mapData}` — or, when the result carries a `download`
  (Phase 7 `export`), `{type:"download",filename,mime,content,text}` — plus `welcome`
  / `error`. The `welcome` frame is the `banner` year summary with its `mapData`
  attached, so the map shows markers as soon as the site opens; a D1 failure
  falls back to the static `renderWelcome()`. To keep the aggregate query set off
  every connection, the DO caches the tz-independent `computeYearSummary()` result
  (`getWelcomeSummary()`) and only re-renders the localised text per socket;
  the cache is validated against a cheap `max(rowid)`/`max(utcdatetime)` table
  fingerprint, so it self-refreshes whenever rows land (cron, admin, or manual)
  without coupling to the broadcast path.
  Per-socket state (the Phase 8 `CommandResult.watch` filter, the
  throttle counter, **and** the viewer's `tz` from the `?tz=` connect param)
  lives in one `SocketState` object persisted via
  `ws.serializeAttachment()` (`readSocketState`/`writeSocketState` helpers tolerate
  the legacy bare-filter attachment), so all survive DO hibernation.
  `broadcastNewEarthquakes()` is an RPC method (called by `scheduled()`, not over
  `.fetch()`) that fans an alert to every `ctx.getWebSockets()`; per socket it reads
  the stored `watch` filter (`readSocketState()`), skips or narrows the record
  set to matches, and sends `{type:"alert",text,mapData,bell}` (`bell` set when peak
  magnitude ≥ 5, Phase 8), with banner times rendered in each socket's timezone
  (unfiltered frames cached per zone).
- `src/lib/commands.ts` — `executeCommand(line, env)`: quote-aware tokenizer + a
  shared arg parser (`parseArgs`/`buildWhere`), driven by a single **command
  registry** (`COMMANDS`) that also renders `help` (so help can't drift from the
  parser). Parses `help`, `list`, `search <id|text>`,
  `export csv|json [filters]` (Phase 7 — returns a `download` payload, capped at
  `MAX_EXPORT` = 10k rows), and `trend [--by day|month] [filters]` (Phase 7 —
  `GROUP BY strftime(...)` → ASCII chart). Phase 8 added `stats`/`sparkline`/`top`/
  `nearby`/`minimap`/`compare`/`richter`/`felt`/`random`/`banner` (all through the
  same `parseArgs`/`buildWhere` machinery; `nearby` bounding-boxes in SQL —
  clamping latitude at the poles and splitting the longitude band into an OR of
  two ranges when it wraps ±180° — then refines with a JS haversine) plus
  `watch`/`unwatch`, which return a
  `CommandResult.watch` directive; `matchesWatch(row, filter)` (exported, unit-tested)
  is the shared filter predicate the DO reuses at broadcast time.
  `executeCommand(line, env, tz?)` threads the viewer's timezone into the
  registry handlers (`run(env, args, tz?)`) so time-rendering commands localise
  their output. `computeYearSummary(env)`
  (exported) runs the tz-independent `banner` query set (aggregates +
  strongest/latest + monthly buckets + up to `BANNER_MAP_ROWS` newest rows as map
  data; the year is the newest record's, falling back to the current UTC year),
  and `buildBanner(env, tz?)` renders it via `renderWelcome`; the DO caches the
  `computeYearSummary` result so the query set isn't re-run per connection. Runs
  **parameterized** D1 queries; returns a `CommandResult`
  (`{text, mapData?, download?, watch?}`). User-facing problems return a friendly
  error string; unexpected errors are re-thrown.
- `src/lib/format.ts` — ANSI helpers, magnitude→colour severity mapping, and
  fixed-width table + detail renderers. Uses `\r\n` line endings for xterm.js.
  `resolveTimeZone()` validates an IANA zone; `makeTimeFormatter(tz?)` converts
  the stored suffix-less UTC ISO timestamps into the viewer's zone (12-hour
  `MM-DD-YYYY hh:mm AM/PM` + short zone label, UTC fallback), and every
  time-rendering function takes an optional `tz` (zone named in table headers /
  field labels).
  `renderAlertBanner()` formats the Phase 5 push (top-magnitude rows first, capped
  at 10 with a "…and N more" summary). `renderTrend()` draws the Phase 7 bar chart
  (bars scaled to the busiest bucket, coloured by peak magnitude). Phase 8 renderers:
  `renderStats`, `renderNearbyTable`, `renderRichter` (severity band + TNT-energy
  readout), `renderSparkline` (Unicode `▁▂▃▅▇` ramp), `renderMinimap` (ASCII lat/lon
  grid auto-fit to the data bounds), and `renderCompare`. `renderWelcome(summary?)`
  takes an optional `YearSummary` and renders the year-at-a-glance block into the
  init screen.
- `src/lib/export.ts` — `rowsToCSV()` (RFC-4180 quoting) / `rowsToJSON()` (Phase 7):
  serialize `EarthquakeRow[]` into downloadable file content. Runtime-agnostic.
- `src/lib/geojson.ts` — `rowsToGeoJSON()` (Phase 6): converts `EarthquakeRow[]`
  into a Point `FeatureCollection` (props: `id`, `mag`, `depth`, `location`, `time`),
  skipping rows without finite coords. Shared by `commands.ts` and `terminal-hub.ts`.
- `src/types.ts` — `Env` bindings (incl. `TERMINAL_HUB`, `PROTOMAPS_KEY`,
  `WS_CONNECT_LIMIT`) + `EarthquakeApiRecord` / `EarthquakeRow`.
- `migrations/0001_init.sql` — `earthquakes` table, indexed on `utcdatetime`,
  `magdefault`, `location`. Stores only structured fields (no raw-JSON blob) to keep
  the indefinitely-growing table small.
- `public/index.html` — full-screen MapLibre map with a floating Linux-style
  terminal window over it: `#term-window` (titlebar with connection status,
  help/minimize/maximize buttons, `#terminal` body), a `#term-dock` chip shown
  while minimized, and a `#help-modal` plain-language guide for non-technical
  users (opened by the `?` button, auto-shown on first visit). Loads `@xterm/xterm`, `@xterm/addon-fit`, `maplibre-gl`, and
  `@protomaps/basemaps` from a CDN via `<script>` tags (no build step, matching
  the static-asset convention); loads `public/map.js` (classic script, sets
  `window.EarthquakeMap`) then `public/app.js` as a module, plus `public/styles.css`.
- `public/app.js` — terminal client. Creates a `Terminal` + `FitAddon`, opens the
  `/ws` WebSocket, and **hand-rolls the prompt/line editor** via `term.onData()`
  (xterm.js has no built-in shell): buffered line with insert-at-cursor, Enter,
  backspace, ←/→, ↑/↓ history (with draft stash), Home/End, Ctrl+A/E/U/L/C. Sends
  `{type:"input",line}`; on `welcome`/`output`/`error` writes the ANSI text back, and
  forwards any `mapData` to `EarthquakeMap.setFeatures()` (Phase 6). A
  `{type:"download"}` frame (Phase 7 `export`) is saved via `saveFile()` (Blob +
  object URL + hidden `<a download>`), then prints its confirmation text.
  A server-pushed `{type:"alert"}` can arrive at any time: it prints the banner,
  upserts its `mapData` via `EarthquakeMap.addFeatures()`, then re-renders the prompt
  + half-typed line (skipped while `busy`, since the pending reply redraws the prompt
  itself). A `busy` flag gates input while a command is in flight; auto-reconnects
  with backoff (welcome only greets once). The terminal runs with
  `allowTransparency` + a transparent theme background (the translucent glass is
  CSS on `.term-window`), refits via a `ResizeObserver`, and a window-manager
  block wires minimize (→ top-center dock chip, which pulses if an alert
  arrives while minimized), maximize/restore (button or titlebar double-click),
  and titlebar-drag with viewport clamping. Commands whose reply carries map
  features fade the window to a "ghost" (`.ghost`, 10% opacity; hover previews
  it, clicking/typing in the terminal restores it, an incoming alert un-ghosts)
  so the plot shows through; pointerdown on the map minimizes the window to the
  dock chip. The help modal is
  wired to the `?` button, ×/Esc/backdrop close, and a `localStorage`
  first-visit flag (`eq-guide-seen`).
- `public/map.js` — MapLibre GL JS map (Phase 6). Fetches `/api/config`; if a
  `protomapsKey` is present it builds the Protomaps dark vector style via the
  `basemaps` helper, else falls back to a plain dark-background style so points still
  render. Adds a `circle` layer sized/coloured by magnitude (bands mirror
  `format.ts`). Exposes `window.EarthquakeMap.setFeatures(fc)` (replace + fit bounds)
  and `.addFeatures(fc)` (upsert by id, for alerts); both queue until the map's
  `load` fires. Hover popups show magnitude/location/time.
- `public/styles.css` — full-viewport map layer with the floating terminal
  window on top, centered in the viewport by default: translucent glass
  background (`rgba` + `backdrop-filter` blur) so the map shows through,
  `.maximized` (pins to viewport edges), `.minimized` (hidden; top-center dock
  chip visible), and `.ghost` (10% opacity, hover restores to full) states,
  titlebar/window-button styling, the connection-status dot,
  the `#help-modal` guide card, dark-themed map chrome/popups, and a
  near-fullscreen window under 700px.

Bindings in `wrangler.jsonc`: `ASSETS` (static assets,
`run_worker_first: ["/admin/*", "/ws", "/api/*"]`), `DB` (D1 database `earthquake-db`),
`TERMINAL_HUB` (Durable Object → `TerminalHub`; `migrations` tag `v1`,
`new_sqlite_classes: ["TerminalHub"]`), a `PROTOMAPS_KEY` var (empty by default;
publishable basemap key served to the browser via `/api/config`), and a
`WS_CONNECT_LIMIT` rate-limit binding (`ratelimits`, per-IP `/ws` connection
throttle — 60/60s by default);
`triggers.crons: ["*/15 * * * *"]` drives the `scheduled()` handler.

## Commands

- `npm run dev` / `npm start` — run locally via `wrangler dev`
- `npm run typecheck` — type-check with `tsc --noEmit` (config in `tsconfig.json`)
- `npm run deploy` — deploy via `wrangler deploy`
- `npx wrangler types` — regenerate TypeScript types; **run this after changing any bindings in `wrangler.jsonc`**
- `npx wrangler d1 migrations apply earthquake-db --local` (or `--remote`) — apply D1 migrations
- `npm test` / `npm run test:run` — run the Vitest suite in watch / single-run mode

Tests use `@cloudflare/vitest-pool-workers` (config in `vitest.config.mts`), so
they run inside the Workers runtime with the real `DB`/`TERMINAL_HUB` bindings.
The suite lives in `test/` (`api`, `commands`, `ingest`); `test/apply-migrations.ts`
applies the D1 schema before each file, and `docs/API.md` documents the API
surface under test. There is no lint script configured yet.

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
