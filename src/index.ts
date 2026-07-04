/**
 * Worker entry point for the Earthquake CLI.
 *
 * Phase 1: a single admin route (`POST /admin/ingest`) drives the ingestion
 * pipeline; everything else falls through to the static assets in public/.
 * Phase 2: a `scheduled()` cron handler runs the same pipeline every 15 minutes.
 * Phase 3: `/ws` upgrades to a WebSocket handled by the TerminalHub Durable
 * Object; later phases add the xterm.js frontend and API endpoints.
 */

import type { Env } from "./types";
import { ingest } from "./lib/ingest";

// Re-exported so the Workers runtime can instantiate the Durable Object class
// declared in wrangler.jsonc's `durable_objects.bindings`.
export { TerminalHub } from "./durable-objects/terminal-hub";

/** Single, well-known DO instance holding every terminal session. */
const TERMINAL_HUB_NAME = "global-hub";

/** Constant-time-ish bearer check for /admin/* routes. */
function isAuthorized(request: Request, env: Env): boolean {
  const header = request.headers.get("Authorization") ?? "";
  const expected = `Bearer ${env.ADMIN_TOKEN}`;
  return Boolean(env.ADMIN_TOKEN) && header === expected;
}

async function handleIngest(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "POST" },
    });
  }
  if (!isAuthorized(request, env)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await ingest(env.DB);
    return Response.json(result);
  } catch (error) {
    console.error("Ingestion failed:", error);
    return Response.json(
      { error: "Ingestion failed", detail: String(error) },
      { status: 502 },
    );
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/admin/ingest") {
      return handleIngest(request, env);
    }

    // Phase 6: hand the browser the Protomaps basemap key (a publishable,
    // domain-restrictable key — safe to expose to the client). Empty string
    // when unset; the map then falls back to a plain dark canvas. The response
    // is static, so let Cloudflare's edge cache it for an hour: repeat page
    // loads then skip the Worker entirely (spam/DDoS mitigation).
    if (url.pathname === "/api/config") {
      return Response.json(
        { protomapsKey: env.PROTOMAPS_KEY ?? "" },
        { headers: { "Cache-Control": "public, max-age=3600" } },
      );
    }

    // WebSocket terminal: route to the single global TerminalHub instance.
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected a WebSocket upgrade request", {
          status: 426,
        });
      }
      // Throttle connection attempts per client IP before touching the DO, so a
      // script can't open sockets in a tight loop. Per-command spam over an
      // already-open socket is throttled inside the DO (terminal-hub.ts).
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      const { success } = await env.WS_CONNECT_LIMIT.limit({ key: ip });
      if (!success) {
        return new Response("Too Many Requests", { status: 429 });
      }
      const stub = env.TERMINAL_HUB.getByName(TERMINAL_HUB_NAME);
      return stub.fetch(request);
    }

    // Everything else: serve static assets from public/.
    return env.ASSETS.fetch(request);
  },

  /**
   * Cron handler (see `triggers.crons` in wrangler.jsonc): runs the ingestion
   * pipeline on a schedule. Ingestion is idempotent (dedupe by primary key), so
   * repeated runs never duplicate rows. Errors are re-thrown so Cloudflare marks
   * the invocation as failed and surfaces it in `wrangler tail` / observability.
   */
  async scheduled(
    controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    try {
      const result = await ingest(env.DB);
      console.log(
        `Scheduled ingest (${controller.cron}): fetched ${result.fetched}, inserted ${result.inserted}`,
      );

      // Phase 5: push genuinely-new records to every open terminal via the DO.
      // Direct RPC on the stub (not .fetch()) — no HTTP round-trip needed.
      if (result.insertedRows.length > 0) {
        const stub = env.TERMINAL_HUB.getByName(TERMINAL_HUB_NAME);
        await stub.broadcastNewEarthquakes(result.insertedRows);
      }
    } catch (error) {
      console.error("Scheduled ingestion failed:", error);
      throw error;
    }
  },
} satisfies ExportedHandler<Env>;
