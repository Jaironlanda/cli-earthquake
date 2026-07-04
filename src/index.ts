/**
 * Worker entry point for the Earthquake CLI.
 *
 * Phase 1: a single admin route (`POST /admin/ingest`) drives the ingestion
 * pipeline; everything else falls through to the static assets in public/.
 * Phase 2: a `scheduled()` cron handler runs the same pipeline every 15 minutes.
 * Later phases add WebSocket terminal routing and API endpoints.
 */

import type { Env } from "./types";
import { ingest } from "./lib/ingest";

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
    } catch (error) {
      console.error("Scheduled ingestion failed:", error);
      throw error;
    }
  },
} satisfies ExportedHandler<Env>;
