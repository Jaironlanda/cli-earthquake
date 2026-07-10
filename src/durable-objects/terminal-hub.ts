/**
 * TerminalHub — the WebSocket backend for the Earthquake CLI terminal.
 *
 * A single instance (addressed by `idFromName("global-hub")`, see src/index.ts)
 * holds every open terminal session. It uses the **WebSocket Hibernation API**
 * (`ctx.acceptWebSocket`), so the Durable Object can be evicted from memory
 * while sockets stay open — the runtime rehydrates it on the next message. That
 * keeps idle cost at zero even with many connected browser tabs, which matters
 * because Phase 5 will fan out real-time alerts to all of them.
 *
 * Protocol (JSON over the socket):
 *   client → server: {"type":"input","line":"list --mag>5"}
 *   server → client: {"type":"output","text":"...ANSI..."}   (command result)
 *                     {"type":"download","filename","mime","content","text"}
 *                                                             (Phase 7 export)
 *                     {"type":"error","text":"..."}          (internal failure)
 *                     {"type":"welcome","text":"...","mapData":{...}}
 *                                        (on connect — the year banner + its
 *                                         GeoJSON so the map plots markers)
 */

import { DurableObject } from "cloudflare:workers";
import type { Env, EarthquakeRow } from "../types";
import {
  computeYearSummary,
  executeCommand,
  matchesWatch,
  type WatchFilter,
  type YearSummaryData,
} from "../lib/commands";
import {
  color,
  renderAlertBanner,
  renderWelcome,
  resolveTimeZone,
} from "../lib/format";
import { rowsToGeoJSON } from "../lib/geojson";

/** Magnitude at or above which an alert also rings the terminal bell (Phase 8). */
const BELL_MAGNITUDE = 5;

/**
 * Per-socket command throttle: at most RATE_MAX inputs per RATE_WINDOW_MS, so a
 * script can't flood one open socket with commands (each runs a D1 query). Set
 * well above a human's typing rate (2 cmd/s sustained) but far below a flood.
 */
const RATE_WINDOW_MS = 10_000;
const RATE_MAX = 20;

/** Fixed-window command counter persisted per socket (survives hibernation). */
interface RateWindow {
  windowStart: number;
  count: number;
}

/**
 * State attached to each WebSocket via `serializeAttachment`, so it survives DO
 * hibernation (an in-memory field would be wiped when the DO is evicted): the
 * Phase 8 alert filter, the command rate-limit counter, and the browser's IANA
 * timezone (sent as `?tz=` on the /ws URL) used to localise rendered times.
 */
interface SocketState {
  watch: WatchFilter | null;
  rate?: RateWindow;
  tz?: string;
  /** Viewer's terminal column count (from ?cols= / the input frame), for responsive rendering. */
  cols?: number;
}

/** Read a socket's persisted state, tolerating the legacy bare-filter format. */
function readSocketState(ws: WebSocket): SocketState {
  let raw: unknown;
  try {
    raw = ws.deserializeAttachment();
  } catch {
    raw = null;
  }
  if (
    raw &&
    typeof raw === "object" &&
    ("watch" in raw || "rate" in raw || "tz" in raw || "cols" in raw)
  ) {
    return raw as SocketState;
  }
  // Pre-throttle attachment: a bare WatchFilter (Phase 8) or null.
  return { watch: (raw as WatchFilter | null) ?? null };
}

/**
 * Sanitise a terminal column count reported by the browser (?cols= or the input
 * frame). Clamps to a sane range; anything non-numeric → undefined (which the
 * renderers treat as "full desktop layout").
 */
function resolveCols(raw: string | number | null | undefined): number | undefined {
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(Math.max(Math.floor(n), 20), 400);
}

/** Persist a socket's state (in-memory tag, restored after hibernation). */
function writeSocketState(ws: WebSocket, state: SocketState): void {
  ws.serializeAttachment(state);
}

/**
 * Advance the fixed-window counter for one inbound command; returns false once
 * the socket has exceeded RATE_MAX within the current window. Mutates `state`.
 */
function tickRateLimit(state: SocketState): boolean {
  const now = Date.now();
  const rate = state.rate;
  if (!rate || now - rate.windowStart >= RATE_WINDOW_MS) {
    state.rate = { windowStart: now, count: 1 };
    return true;
  }
  rate.count += 1;
  return rate.count <= RATE_MAX;
}

/** Shape of an inbound client message. */
interface InputMessage {
  type: "input";
  line: string;
  /** Current terminal column count, sent per command so responsive rendering tracks resizes. */
  cols?: number;
}

function isInputMessage(value: unknown): value is InputMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "input" &&
    typeof (value as { line?: unknown }).line === "string"
  );
}

export class TerminalHub extends DurableObject<Env> {
  /**
   * Cached welcome-banner data (the year-at-a-glance aggregate query set) plus
   * the table fingerprint it was computed from. The summary is tz-independent —
   * only the rendered text depends on the viewer's timezone — so we compute it
   * once and reuse it across every connecting socket, which keeps repeat
   * connections off the several D1 aggregates the banner needs. In-memory only:
   * a hibernation eviction resets it to null and the next connect recomputes.
   */
  private welcome: { key: string; data: YearSummaryData } | null = null;

  /**
   * Return the welcome-banner summary, recomputing the (expensive) aggregate
   * query set only when the table has actually changed since we last cached it.
   * The staleness check is a single O(1) probe — the largest rowid and newest
   * timestamp — so it stays correct no matter how rows entered D1 (cron ingest,
   * the admin route, or a direct write) without paying for the full query set
   * on every connection.
   */
  private async getWelcomeSummary(): Promise<YearSummaryData> {
    const fp = await this.env.DB.prepare(
      `SELECT max(rowid) AS seq, max(utcdatetime) AS last FROM earthquakes`,
    ).first<{ seq: number | null; last: string | null }>();
    const key = `${fp?.seq ?? ""}:${fp?.last ?? ""}`;
    if (this.welcome?.key !== key) {
      this.welcome = { key, data: await computeYearSummary(this.env) };
    }
    return this.welcome.data;
  }

  /**
   * Upgrade an HTTP request to a WebSocket. The Worker routes `/ws` here (via
   * the DO stub's `.fetch()`); we complete the handshake and hand the server
   * end to the Hibernation manager, returning the client end with a 101.
   */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade request", {
        status: 426,
      });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Hand off to hibernation-managed acceptance (not server.accept()), so the
    // DO can be evicted while the socket stays open.
    this.ctx.acceptWebSocket(server);

    // The browser sends its IANA timezone as ?tz= (public/app.js) so every
    // frame we render — welcome, command output, alerts — shows the viewer's
    // local clock. Validate it here (an Intl round-trip) and persist it in the
    // socket attachment so it survives hibernation; missing/invalid → UTC.
    // The browser also reports its terminal width as ?cols= (public/app.js) so
    // the banner and tables render for its screen size; persist it alongside tz.
    const params = new URL(request.url).searchParams;
    const tz = resolveTimeZone(params.get("tz"));
    const cols = resolveCols(params.get("cols"));
    writeSocketState(server, { watch: null, tz, cols });

    // The welcome frame is the `banner` command's year-at-a-glance summary,
    // with its GeoJSON attached so the map shows markers as soon as the page
    // opens. The aggregate query set is cached across connections (see
    // getWelcomeSummary) and only the tz-localised text is rendered per socket.
    // A D1 hiccup must not break connecting, so fall back to the plain static
    // welcome screen.
    let welcome: { text: string; mapData?: unknown };
    try {
      const { summary, mapData } = await this.getWelcomeSummary();
      welcome = { text: renderWelcome(summary, tz, cols), mapData };
    } catch (error) {
      console.error("Welcome banner build failed:", error);
      welcome = { text: renderWelcome(undefined, tz, cols) };
    }
    server.send(
      JSON.stringify({
        type: "welcome",
        text: welcome.text,
        mapData: welcome.mapData,
      }),
    );

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Handle an inbound frame. Parses the {type:"input"} envelope, runs the
   * command against D1, and replies with a {type:"output"} (or {type:"error"}
   * if the command threw unexpectedly). Malformed frames get a friendly error
   * rather than tearing the socket down.
   */
  override async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    // Hibernation-safe per-socket throttle: count this frame in the socket's
    // persisted state and persist it immediately, so the counter is kept even
    // if the DO is evicted between messages. Over-limit frames are dropped with
    // a friendly notice rather than tearing the socket down.
    const state = readSocketState(ws);
    const allowed = tickRateLimit(state);
    writeSocketState(ws, state);
    if (!allowed) {
      ws.send(
        JSON.stringify({
          type: "error",
          text: color("Slow down — too many commands. Try again shortly.", "red"),
        }),
      );
      return;
    }

    let parsed: unknown;
    try {
      const text =
        typeof message === "string"
          ? message
          : new TextDecoder().decode(message);
      parsed = JSON.parse(text);
    } catch {
      ws.send(
        JSON.stringify({
          type: "error",
          text: color("Malformed message (expected JSON).", "red"),
        }),
      );
      return;
    }

    if (!isInputMessage(parsed)) {
      ws.send(
        JSON.stringify({
          type: "error",
          text: color('Expected {"type":"input","line":"..."}.', "red"),
        }),
      );
      return;
    }

    // The client sends its current terminal width with each command so
    // responsive rendering tracks resizes since connect; persist the latest so
    // pushed alerts also use it. Fall back to the width captured at connect.
    const cols = resolveCols(parsed.cols) ?? state.cols;
    if (cols !== state.cols) {
      state.cols = cols;
      writeSocketState(ws, state);
    }

    try {
      const { text, mapData, download, watch } = await executeCommand(
        parsed.line,
        this.env,
        state.tz,
        cols,
      );
      // Phase 8: `watch`/`unwatch` store an alert filter on this very socket
      // (alongside the rate counter in the same attachment, so both survive DO
      // hibernation — getWebSockets() + deserializeAttachment() recover them at
      // broadcast time). `null` clears the filter; `undefined` leaves it as-is.
      if (watch !== undefined) {
        state.watch = watch;
        writeSocketState(ws, state);
      }
      // Phase 7: `export` yields a file; the client saves it and prints `text`
      // as the confirmation. Everything else is a normal ANSI output frame.
      if (download) {
        ws.send(JSON.stringify({ type: "download", text, ...download }));
      } else {
        ws.send(JSON.stringify({ type: "output", text, mapData }));
      }
    } catch (error) {
      console.error("Command execution failed:", error);
      ws.send(
        JSON.stringify({
          type: "error",
          text: color("Internal error running command.", "red"),
        }),
      );
    }
  }

  /**
   * Broadcast newly-ingested earthquakes to every connected terminal
   * (Phase 5). Called as an RPC by the Worker's `scheduled()` handler after a
   * cron ingest finds unseen records. Banner timestamps are rendered in each
   * socket's stored timezone, so unfiltered frames are cached per zone and
   * reused across sockets sharing it. `getWebSockets()` also returns sockets
   * whose DO was hibernating. Send failures on individual sockets are
   * swallowed so one dead connection can't abort the broadcast.
   */
  broadcastNewEarthquakes(records: EarthquakeRow[]): void {
    if (records.length === 0) return;

    // Unfiltered frames keyed by timezone + width, rendered once per
    // (zone,width) and reused for every socket without a `watch` subscription
    // (the common case) that shares both.
    const framesByZone = new Map<string, string>();

    for (const ws of this.ctx.getWebSockets()) {
      // A `watch` filter is stored in this socket's attachment (Phase 8). A null
      // filter means "send every alert" — the pre-Phase-8 behaviour.
      const state = readSocketState(ws);
      const filter = state.watch;

      let frame: string;
      if (filter) {
        const visible = records.filter((r) => matchesWatch(r, filter));
        if (visible.length === 0) continue; // nothing this terminal cares about
        frame = this.alertFrame(visible, state.tz, state.cols);
      } else {
        const key = `${state.tz ?? ""}|${state.cols ?? ""}`;
        let cached = framesByZone.get(key);
        if (cached === undefined) {
          cached = this.alertFrame(records, state.tz, state.cols);
          framesByZone.set(key, cached);
        }
        frame = cached;
      }

      try {
        ws.send(frame);
      } catch (error) {
        console.error("Alert broadcast to a socket failed:", error);
      }
    }
  }

  /**
   * Build one `alert` frame for a set of records: the rendered banner (times
   * in the receiving socket's timezone), the map upsert data, and a `bell`
   * flag the client uses to ring the terminal bell when something significant
   * (≥ {@link BELL_MAGNITUDE}) arrives.
   */
  private alertFrame(
    records: EarthquakeRow[],
    tz?: string,
    width?: number,
  ): string {
    const peak = Math.max(
      ...records.map((r) => r.magdefault ?? -Infinity),
    );
    return JSON.stringify({
      type: "alert",
      text: renderAlertBanner(records, tz, width),
      // Phase 6: the map upserts these points without clearing existing ones.
      mapData: rowsToGeoJSON(records),
      bell: peak >= BELL_MAGNITUDE,
    });
  }

  /** Close our end cleanly when the client disconnects. */
  override async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    // The reserved codes 1005 ("no status received"), 1006 ("abnormal
    // closure"), and 1015 ("TLS handshake") are set by the runtime but can't
    // be passed back to close() — doing so throws "Invalid WebSocket close
    // code". Only echo a code the spec allows us to send; otherwise fall back
    // to a normal closure.
    const sendable = code >= 1000 && code <= 4999 && ![1004, 1005, 1006, 1015].includes(code);
    ws.close(sendable ? code : 1000, reason);
  }

  /** Log transport errors; the runtime closes the socket for us. */
  override async webSocketError(_ws: WebSocket, error: unknown): Promise<void> {
    console.error("WebSocket error:", error);
  }
}
