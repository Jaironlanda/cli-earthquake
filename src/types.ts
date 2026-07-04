/**
 * Shared types for the Earthquake CLI Worker.
 */

/** Worker bindings and secrets. Mirrors wrangler.jsonc. */
export interface Env {
  /** Static assets (public/) served for any non-Worker route. */
  ASSETS: Fetcher;
  /** D1 database holding the `earthquakes` table. */
  DB: D1Database;
  /**
   * Per-IP rate limiter for /ws connection attempts (spam/DDoS mitigation).
   * `RateLimit` is a runtime-provided global (see `ratelimits` in wrangler.jsonc).
   */
  WS_CONNECT_LIMIT: RateLimit;
  /** Bearer token guarding /admin/* routes. Set via `wrangler secret put ADMIN_TOKEN`. */
  ADMIN_TOKEN: string;
  /** Durable Object namespace for the WebSocket terminal hub (Phase 3). */
  TERMINAL_HUB: DurableObjectNamespace<import("./durable-objects/terminal-hub").TerminalHub>;
  /**
   * Publishable Protomaps basemap key served to the browser via /api/config
   * (Phase 6). Empty string when unset — the map then uses a plain dark canvas.
   */
  PROTOMAPS_KEY: string;
}

/**
 * A single record as returned by
 * https://api.data.gov.my/weather/warning/earthquake/
 *
 * Verified against the live feed: `depth` and `magdefault` arrive as JSON
 * numbers (magdefault may be an integer like `5` or a float like `5.5`).
 */
export interface EarthquakeApiRecord {
  utcdatetime: string;
  localdatetime: string;
  lat: number;
  lon: number;
  depth: number;
  location: string;
  location_original: string;
  n_distancemas: string;
  n_distancerest: string;
  nbm_distancemas: string;
  nbm_distancerest: string;
  magdefault: number;
  magtypedefault: string;
  status: string;
  visible: boolean;
  lat_vector: string;
  lon_vector: string;
}

/** A row of the `earthquakes` D1 table (the subset of fields we persist). */
export interface EarthquakeRow {
  id: string;
  utcdatetime: string;
  localdatetime: string | null;
  lat: number;
  lon: number;
  depth: number | null;
  location: string | null;
  location_original: string | null;
  magdefault: number | null;
  magtypedefault: string | null;
  status: string | null;
}
