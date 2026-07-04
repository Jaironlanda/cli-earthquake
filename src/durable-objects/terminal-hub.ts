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
 *                     {"type":"welcome","text":"..."}         (on connect)
 */

import { DurableObject } from "cloudflare:workers";
import type { Env, EarthquakeRow } from "../types";
import { executeCommand, matchesWatch, type WatchFilter } from "../lib/commands";
import { color, renderAlertBanner, renderWelcome } from "../lib/format";
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
 * Phase 8 alert filter plus the command rate-limit counter.
 */
interface SocketState {
  watch: WatchFilter | null;
  rate?: RateWindow;
}

/** Read a socket's persisted state, tolerating the legacy bare-filter format. */
function readSocketState(ws: WebSocket): SocketState {
  let raw: unknown;
  try {
    raw = ws.deserializeAttachment();
  } catch {
    raw = null;
  }
  if (raw && typeof raw === "object" && ("watch" in raw || "rate" in raw)) {
    return raw as SocketState;
  }
  // Pre-throttle attachment: a bare WatchFilter (Phase 8) or null.
  return { watch: (raw as WatchFilter | null) ?? null };
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

    server.send(
      JSON.stringify({ type: "welcome", text: this.welcomeBanner() }),
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

    try {
      const { text, mapData, download, watch } = await executeCommand(
        parsed.line,
        this.env,
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
   * cron ingest finds unseen records. We render the banner once and fan it out
   * over every live socket — including sockets whose DO was hibernating, which
   * `getWebSockets()` still returns. Send failures on individual sockets are
   * swallowed so one dead connection can't abort the broadcast.
   */
  broadcastNewEarthquakes(records: EarthquakeRow[]): void {
    if (records.length === 0) return;

    // Unfiltered frame, rendered once and reused for every socket without a
    // `watch` subscription (the common case).
    const allFrame = this.alertFrame(records);

    for (const ws of this.ctx.getWebSockets()) {
      // A `watch` filter is stored in this socket's attachment (Phase 8). A null
      // filter means "send every alert" — the pre-Phase-8 behaviour.
      const filter = readSocketState(ws).watch;

      let frame = allFrame;
      if (filter) {
        const visible = records.filter((r) => matchesWatch(r, filter!));
        if (visible.length === 0) continue; // nothing this terminal cares about
        frame = this.alertFrame(visible);
      }

      try {
        ws.send(frame);
      } catch (error) {
        console.error("Alert broadcast to a socket failed:", error);
      }
    }
  }

  /**
   * Build one `alert` frame for a set of records: the rendered banner, the map
   * upsert data, and a `bell` flag the client uses to ring the terminal bell
   * when something significant (≥ {@link BELL_MAGNITUDE}) arrives.
   */
  private alertFrame(records: EarthquakeRow[]): string {
    const peak = Math.max(
      ...records.map((r) => r.magdefault ?? -Infinity),
    );
    return JSON.stringify({
      type: "alert",
      text: renderAlertBanner(records),
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
    // 1005 = "no status received"; passing it back to close() is invalid, so
    // fall back to a normal-closure code.
    ws.close(code === 1005 ? 1000 : code, reason);
  }

  /** Log transport errors; the runtime closes the socket for us. */
  override async webSocketError(_ws: WebSocket, error: unknown): Promise<void> {
    console.error("WebSocket error:", error);
  }

  /** The init screen written to a freshly connected terminal. */
  private welcomeBanner(): string {
    return renderWelcome();
  }
}
