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
import { executeCommand } from "../lib/commands";
import { bold, color, dim, EOL, renderAlertBanner } from "../lib/format";
import { rowsToGeoJSON } from "../lib/geojson";

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
      const { text, mapData, download } = await executeCommand(
        parsed.line,
        this.env,
      );
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

    const frame = JSON.stringify({
      type: "alert",
      text: renderAlertBanner(records),
      // Phase 6: the map upserts these points without clearing existing ones.
      mapData: rowsToGeoJSON(records),
    });

    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(frame);
      } catch (error) {
        console.error("Alert broadcast to a socket failed:", error);
      }
    }
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

  /** The greeting written to a freshly connected terminal. */
  private welcomeBanner(): string {
    return [
      bold(color("Earthquake CLI", "cyan")) +
        dim(" — live seismic data terminal"),
      dim('Type "help" to get started.'),
    ].join(EOL);
  }
}
