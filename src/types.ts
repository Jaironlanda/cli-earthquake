/**
 * Shared types for the Earthquake CLI Worker.
 */

/** Worker bindings and secrets. Mirrors wrangler.jsonc. */
export interface Env {
  /** Static assets (public/) served for any non-Worker route. */
  ASSETS: Fetcher;
  /** D1 database holding the `earthquakes` table. */
  DB: D1Database;
  /** Bearer token guarding /admin/* routes. Set via `wrangler secret put ADMIN_TOKEN`. */
  ADMIN_TOKEN: string;
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
