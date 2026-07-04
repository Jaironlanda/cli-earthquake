/**
 * Command parsing and execution for the Earthquake CLI terminal.
 *
 * `executeCommand(line, env)` takes a raw input line (as typed at the prompt),
 * parses it, runs the corresponding parameterized D1 query, and returns a
 * `CommandResult`. All queries are bound (never string-interpolated) so user
 * input can't inject SQL.
 *
 * Commands are declared once in the {@link COMMANDS} registry, which drives both
 * dispatch and `help` — so the help text can never drift from what the parser
 * actually accepts. Supported commands (see `help`):
 *   help
 *   list   [--mag>N] [--since YYYY-MM-DD] [--location STR] [--limit N]
 *   search <id | text>
 *   export csv|json [same filters as list]        (Phase 7 — file download)
 *   trend  [--by day|month] [filters] [--limit N]  (Phase 7 — ASCII chart)
 */

import type { Env, EarthquakeRow } from "../types";
import {
  bold,
  color,
  dim,
  EOL,
  renderCompare,
  renderEarthquakeDetail,
  renderEarthquakeTable,
  renderMinimap,
  renderNearbyTable,
  renderRichter,
  renderSparkline,
  renderStats,
  renderTrend,
  renderWelcome,
  type CompareSide,
  type QuakeStats,
  type RowWithDistance,
  type TrendBucket,
  type YearSummary,
} from "./format";
import { rowsToGeoJSON, type EarthquakeFeatureCollection } from "./geojson";
import { rowsToCSV, rowsToJSON } from "./export";

/**
 * The result of running a command:
 *  - `text` — ANSI output for the terminal (a confirmation line for `export`).
 *  - `mapData` — optional GeoJSON the browser plots on the MapLibre panel
 *    (Phase 6); row-returning commands attach it, `help`/`trend`/errors don't.
 *  - `download` — optional file payload (Phase 7); when present the client saves
 *    it to disk instead of (or alongside) printing.
 */
export interface CommandResult {
  text: string;
  mapData?: EarthquakeFeatureCollection;
  download?: { filename: string; mime: string; content: string };
  /**
   * Phase 8 `watch`/`unwatch`: a per-connection alert filter directive for the
   * TerminalHub to store on the WebSocket. A filter object subscribes that
   * socket to matching alerts only; `null` clears any filter (all alerts);
   * `undefined` (the default) leaves the current subscription untouched.
   */
  watch?: WatchFilter | null;
}

/** A per-connection alert filter (Phase 8 `watch`). All fields optional (AND-ed). */
export interface WatchFilter {
  minMag?: number;
  location?: string;
}

/** Does an earthquake row satisfy a stored watch filter? */
export function matchesWatch(row: EarthquakeRow, filter: WatchFilter): boolean {
  if (filter.minMag !== undefined && (row.magdefault ?? -Infinity) < filter.minMag) {
    return false;
  }
  if (filter.location !== undefined) {
    const needle = filter.location.toLowerCase();
    const hay = `${row.location ?? ""} ${row.location_original ?? ""}`.toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

/** Columns selected for every row-returning query (matches EarthquakeRow). */
const ROW_COLUMNS = `id, utcdatetime, localdatetime, lat, lon, depth,
   location, location_original, magdefault, magtypedefault, status`;

/** Default and maximum number of rows returned by `list` / `search`. */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Cap on rows a single `export` pulls. The `earthquakes` table grows without
 * bound (see migrations/0001_init.sql); this keeps one export bounded in memory
 * and payload size. If the table ever nears D1's size limit (500MB free / 10GB
 * paid — not a near-term concern at the current ingest rate), archive old rows
 * to R2 as a separate job rather than lifting this cap.
 */
const MAX_EXPORT = 10_000;

/** Default / max number of buckets a `trend` chart shows, per time unit. */
const TREND_DEFAULTS: Record<TrendUnit, number> = { day: 14, month: 12 };
const MAX_TREND_BUCKETS = 60;

/** A parse or validation problem the user should see (not an internal error). */
class CommandError extends Error {}

/**
 * Split a command line into whitespace-separated tokens, honouring double
 * quotes so `--location "New Zealand"` stays one token.
 */
function tokenize(line: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line)) !== null) {
    tokens.push(match[1] ?? match[2]);
  }
  return tokens;
}

// --- Shared option parsing -------------------------------------------------

/** Logical filter/option keys a command may accept. */
type OptionKey = "mag" | "since" | "location" | "limit" | "by" | "radius";

/** Map every accepted flag spelling to its logical key. */
const FLAG_ALIASES: Record<string, OptionKey> = {
  "--mag": "mag",
  "--mag>": "mag",
  "--min-mag": "mag",
  "--since": "since",
  "--location": "location",
  "--loc": "location",
  "--limit": "limit",
  "--by": "by",
  "--radius": "radius",
};

/** Options parsed off a command line (all optional; each command uses a subset). */
interface ParsedArgs {
  minMag?: number;
  since?: string;
  location?: string;
  limit?: number;
  by?: string;
  radius?: number;
}

/** Validate a numeric flag value. */
function parseNumber(flag: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new CommandError(`Invalid number for ${flag}: "${raw}"`);
  }
  return value;
}

/**
 * Parse option tokens shared across `list`, `export`, and `trend`. Accepts
 * `--mag>N`, `--mag>=N`, `--mag N`, `--since DATE`, `--location STR`,
 * `--limit N`, `--by UNIT`, and joined `--flag=value`. `allowed` restricts which
 * options this particular command permits; anything else is a friendly error.
 */
function parseArgs(tokens: string[], allowed: Set<OptionKey>): ParsedArgs {
  const args: ParsedArgs = {};

  for (let i = 0; i < tokens.length; i++) {
    let token = tokens[i];

    // Split the value out of `--mag>5`, `--mag>=5`, and `--flag=value` forms.
    let inlineValue: string | undefined;
    const relMatch = token.match(/^(--mag)(>=|>)(.*)$/);
    if (relMatch) {
      token = relMatch[1];
      inlineValue = relMatch[3];
    } else if (token.startsWith("--") && token.includes("=")) {
      const eq = token.indexOf("=");
      inlineValue = token.slice(eq + 1);
      token = token.slice(0, eq);
    }

    const key = FLAG_ALIASES[token];
    if (key === undefined || !allowed.has(key)) {
      throw new CommandError(`Unknown option: ${tokens[i]}`);
    }

    const value =
      inlineValue !== undefined && inlineValue !== ""
        ? inlineValue
        : (() => {
            const next = tokens[++i];
            if (next === undefined) {
              throw new CommandError(`Missing value for ${token}`);
            }
            return next;
          })();

    switch (key) {
      case "mag":
        args.minMag = parseNumber("--mag", value);
        break;
      case "since":
        args.since = value;
        break;
      case "location":
        args.location = value;
        break;
      case "limit":
        args.limit = Math.trunc(parseNumber("--limit", value));
        break;
      case "by":
        args.by = value.toLowerCase();
        break;
      case "radius":
        args.radius = parseNumber("--radius", value);
        break;
    }
  }

  return args;
}

/** Build the shared `WHERE` clause + bind values from parsed filters. */
function buildWhere(args: ParsedArgs): { clause: string; binds: unknown[] } {
  const where: string[] = [];
  const binds: unknown[] = [];

  if (args.minMag !== undefined) {
    where.push("magdefault >= ?");
    binds.push(args.minMag);
  }
  if (args.since !== undefined) {
    where.push("utcdatetime >= ?");
    binds.push(args.since);
  }
  if (args.location !== undefined) {
    where.push("(location LIKE ? OR location_original LIKE ?)");
    const like = `%${args.location}%`;
    binds.push(like, like);
  }

  return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", binds };
}

/** Fetch filtered rows, newest first, capped at `limit`. */
async function queryRows(
  env: Env,
  args: ParsedArgs,
  limit: number,
): Promise<EarthquakeRow[]> {
  const { clause, binds } = buildWhere(args);
  const sql = `SELECT ${ROW_COLUMNS}
     FROM earthquakes
     ${clause}
     ORDER BY utcdatetime DESC
     LIMIT ?`;
  const { results } = await env.DB.prepare(sql)
    .bind(...binds, limit)
    .all<EarthquakeRow>();
  return results ?? [];
}

// --- Commands --------------------------------------------------------------

/** `list` — filtered, newest-first table plus map data. */
async function runList(env: Env, tokens: string[]): Promise<CommandResult> {
  const args = parseArgs(
    tokens,
    new Set<OptionKey>(["mag", "since", "location", "limit"]),
  );
  const limit = clamp(args.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
  const rows = await queryRows(env, args, limit);
  return { text: renderEarthquakeTable(rows), mapData: rowsToGeoJSON(rows) };
}

/**
 * `search` — a single 16-hex-char token is an id (exact lookup → detail view);
 * anything else is a free-text location search.
 */
async function runSearch(env: Env, tokens: string[]): Promise<CommandResult> {
  const query = tokens.join(" ").trim();
  if (!query) {
    throw new CommandError("Usage: search <id | location text>");
  }

  // Looks like an id: exact match, show the detail view.
  if (/^[0-9a-f]{16}$/i.test(query)) {
    const row = await env.DB.prepare(
      `SELECT ${ROW_COLUMNS} FROM earthquakes WHERE id = ?`,
    )
      .bind(query.toLowerCase())
      .first<EarthquakeRow>();

    if (row) {
      return {
        text: renderEarthquakeDetail(row),
        mapData: rowsToGeoJSON([row]),
      };
    }
    // Fall through to text search if no id matched.
  }

  const like = `%${query}%`;
  const { results } = await env.DB.prepare(
    `SELECT ${ROW_COLUMNS}
       FROM earthquakes
       WHERE location LIKE ? OR location_original LIKE ?
       ORDER BY utcdatetime DESC
       LIMIT ?`,
  )
    .bind(like, like, DEFAULT_LIMIT)
    .all<EarthquakeRow>();

  const rows = results ?? [];
  return { text: renderEarthquakeTable(rows), mapData: rowsToGeoJSON(rows) };
}

/** `export csv|json [filters]` — serialize the filtered set to a download. */
async function runExport(env: Env, tokens: string[]): Promise<CommandResult> {
  const format = tokens[0]?.toLowerCase();
  if (format !== "csv" && format !== "json") {
    throw new CommandError("Usage: export csv|json [filters]");
  }

  const args = parseArgs(
    tokens.slice(1),
    new Set<OptionKey>(["mag", "since", "location", "limit"]),
  );
  const limit = clamp(args.limit ?? MAX_EXPORT, 1, MAX_EXPORT);
  const rows = await queryRows(env, args, limit);

  if (rows.length === 0) {
    return { text: dim("No matching earthquakes — nothing to export.") };
  }

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const download =
    format === "csv"
      ? {
          filename: `earthquakes-${stamp}.csv`,
          mime: "text/csv;charset=utf-8",
          content: rowsToCSV(rows),
        }
      : {
          filename: `earthquakes-${stamp}.json`,
          mime: "application/json",
          content: rowsToJSON(rows),
        };

  const capped = rows.length === limit && limit === MAX_EXPORT;
  const text =
    color(`✓ Exported ${rows.length} record${rows.length === 1 ? "" : "s"}`, "green") +
    dim(` → ${download.filename}`) +
    (capped ? EOL + dim(`(capped at ${MAX_EXPORT}; narrow with filters)`) : "");

  return { text, download };
}

/** Accepted `--by` units for `trend`. */
type TrendUnit = "day" | "month";
const TREND_FORMATS: Record<TrendUnit, string> = {
  day: "%Y-%m-%d",
  month: "%Y-%m",
};

/**
 * Shared bucket query behind `trend` and `sparkline`: parse args, validate the
 * `--by` unit, and return the newest `limit` time buckets oldest-first (so the
 * caller draws time flowing left→right / top→bottom).
 */
async function queryBuckets(
  env: Env,
  tokens: string[],
): Promise<{ buckets: TrendBucket[]; by: TrendUnit }> {
  const args = parseArgs(
    tokens,
    new Set<OptionKey>(["mag", "since", "location", "limit", "by"]),
  );

  const by = (args.by ?? "day") as TrendUnit;
  if (by !== "day" && by !== "month") {
    throw new CommandError(`Invalid --by value: "${args.by}" (use day or month)`);
  }

  const limit = clamp(args.limit ?? TREND_DEFAULTS[by], 1, MAX_TREND_BUCKETS);
  const { clause, binds } = buildWhere(args);

  // strftime() bins the ISO-8601 utcdatetime; the alias is reused in GROUP BY /
  // ORDER BY. We pull the newest `limit` buckets DESC, then reverse to draw the
  // chart oldest-first.
  const sql = `SELECT strftime(?, utcdatetime) AS bucket,
                      count(*) AS count,
                      max(magdefault) AS maxmag
     FROM earthquakes
     ${clause}
     GROUP BY bucket
     ORDER BY bucket DESC
     LIMIT ?`;
  const { results } = await env.DB.prepare(sql)
    .bind(TREND_FORMATS[by], ...binds, limit)
    .all<TrendBucket>();

  return { buckets: (results ?? []).reverse(), by };
}

/** `trend [--by day|month] [filters]` — ASCII histogram of counts over time. */
async function runTrend(env: Env, tokens: string[]): Promise<CommandResult> {
  const { buckets, by } = await queryBuckets(env, tokens);
  return { text: renderTrend(buckets, by) };
}

/** `sparkline [--by day|month] [filters]` — one-line Unicode trend. */
async function runSparkline(env: Env, tokens: string[]): Promise<CommandResult> {
  const { buckets, by } = await queryBuckets(env, tokens);
  return { text: renderSparkline(buckets, by) };
}

/** `stats [filters]` — aggregate summary card for the filtered slice. */
async function runStats(env: Env, tokens: string[]): Promise<CommandResult> {
  const args = parseArgs(
    tokens,
    new Set<OptionKey>(["mag", "since", "location"]),
  );
  const { clause, binds } = buildWhere(args);

  const agg = await env.DB.prepare(
    `SELECT count(*) AS total,
            max(magdefault) AS maxmag,
            avg(magdefault) AS avgmag,
            avg(depth) AS avgdepth,
            min(utcdatetime) AS first,
            max(utcdatetime) AS last
       FROM earthquakes ${clause}`,
  )
    .bind(...binds)
    .first<Omit<QuakeStats, "strongest">>();

  const total = agg?.total ?? 0;
  let strongest: EarthquakeRow | null = null;
  if (total > 0) {
    strongest = await env.DB.prepare(
      `SELECT ${ROW_COLUMNS} FROM earthquakes ${clause}
         ORDER BY magdefault DESC LIMIT 1`,
    )
      .bind(...binds)
      .first<EarthquakeRow>();
  }

  const stats: QuakeStats = {
    total,
    maxmag: agg?.maxmag ?? null,
    avgmag: agg?.avgmag ?? null,
    avgdepth: agg?.avgdepth ?? null,
    first: agg?.first ?? null,
    last: agg?.last ?? null,
    strongest,
  };
  return { text: renderStats(stats), mapData: strongest ? rowsToGeoJSON([strongest]) : undefined };
}

/** Earth radius in km for the haversine distance used by `nearby`. */
const EARTH_RADIUS_KM = 6371;

/** Great-circle distance (km) between two lat/lon points. */
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Default and max search radius (km) for `nearby`. */
const NEARBY_DEFAULT_RADIUS = 500;
const NEARBY_MAX_RADIUS = 20_000;
/** Candidate cap: bounding-box rows refined in JS before distance sorting. */
const NEARBY_CANDIDATES = 2000;

/** `nearby <lat> <lon> [--radius km] [--mag>N] [--limit N]` — closest quakes. */
async function runNearby(env: Env, tokens: string[]): Promise<CommandResult> {
  const lat = Number(tokens[0]);
  const lon = Number(tokens[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw new CommandError("Usage: nearby <lat> <lon> [--radius km] [--mag>N] [--limit N]");
  }

  const args = parseArgs(
    tokens.slice(2),
    new Set<OptionKey>(["mag", "since", "location", "limit", "radius"]),
  );
  const radius = clamp(args.radius ?? NEARBY_DEFAULT_RADIUS, 1, NEARBY_MAX_RADIUS);
  const limit = clamp(args.limit ?? 10, 1, MAX_LIMIT);

  // Pre-filter with a bounding box so we don't scan the whole (unbounded) table;
  // JS then computes exact great-circle distance and sorts. 1° lat ≈ 111km;
  // longitude degrees shrink with latitude, so widen the lon box by 1/cos(lat).
  const latPad = radius / 111;
  const lonPad = radius / (111 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
  const box = buildWhere(args);
  const clause =
    (box.clause ? box.clause + " AND " : "WHERE ") +
    "lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?";
  const { results } = await env.DB.prepare(
    `SELECT ${ROW_COLUMNS} FROM earthquakes ${clause}
       ORDER BY utcdatetime DESC LIMIT ?`,
  )
    .bind(...box.binds, lat - latPad, lat + latPad, lon - lonPad, lon + lonPad, NEARBY_CANDIDATES)
    .all<EarthquakeRow>();

  const ranked: RowWithDistance[] = (results ?? [])
    .map((r) => ({ ...r, distanceKm: haversineKm(lat, lon, r.lat, r.lon) }))
    .filter((r) => r.distanceKm <= radius)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, limit);

  return {
    text: renderNearbyTable(ranked, { lat, lon }),
    mapData: rowsToGeoJSON(ranked),
  };
}

/** `top [--by mag|depth] [filters]` — biggest / deepest quakes on record. */
async function runTop(env: Env, tokens: string[]): Promise<CommandResult> {
  const args = parseArgs(
    tokens,
    new Set<OptionKey>(["mag", "since", "location", "limit", "by"]),
  );
  const by = args.by ?? "mag";
  if (by !== "mag" && by !== "depth") {
    throw new CommandError(`Invalid --by value: "${args.by}" (use mag or depth)`);
  }
  const orderCol = by === "depth" ? "depth" : "magdefault";
  const limit = clamp(args.limit ?? 10, 1, MAX_LIMIT);
  const { clause, binds } = buildWhere(args);

  const { results } = await env.DB.prepare(
    `SELECT ${ROW_COLUMNS} FROM earthquakes ${clause}
       ORDER BY ${orderCol} DESC NULLS LAST LIMIT ?`,
  )
    .bind(...binds, limit)
    .all<EarthquakeRow>();

  const rows = results ?? [];
  const heading = bold(`Top ${rows.length} by ${by === "depth" ? "depth" : "magnitude"}`) + EOL + EOL;
  return { text: heading + renderEarthquakeTable(rows), mapData: rowsToGeoJSON(rows) };
}

/** `compare <A> <B>` — side-by-side counts/magnitudes for two location terms. */
async function runCompare(env: Env, tokens: string[]): Promise<CommandResult> {
  if (tokens.length < 2) {
    throw new CommandError('Usage: compare <regionA> <regionB>  (e.g. compare Sabah Sumatra)');
  }
  const [a, b] = tokens;

  const sideFor = async (term: string): Promise<CompareSide> => {
    const like = `%${term}%`;
    const row = await env.DB.prepare(
      `SELECT count(*) AS total, max(magdefault) AS maxmag, avg(magdefault) AS avgmag
         FROM earthquakes WHERE location LIKE ? OR location_original LIKE ?`,
    )
      .bind(like, like)
      .first<{ total: number; maxmag: number | null; avgmag: number | null }>();
    return {
      label: term,
      total: row?.total ?? 0,
      maxmag: row?.maxmag ?? null,
      avgmag: row?.avgmag ?? null,
    };
  };

  return { text: renderCompare(await sideFor(a), await sideFor(b)) };
}

/** `richter <mag>` — explain what a magnitude means (severity + energy). */
function runRichter(_env: Env, tokens: string[]): CommandResult {
  const mag = Number(tokens[0]);
  if (!Number.isFinite(mag) || mag < 0 || mag > 12) {
    throw new CommandError("Usage: richter <magnitude>  (e.g. richter 6.5)");
  }
  return { text: renderRichter(mag) };
}

/** `random [filters]` — surface one random quake as a detail card (aka `quake`). */
async function runRandom(env: Env, tokens: string[]): Promise<CommandResult> {
  const args = parseArgs(tokens, new Set<OptionKey>(["mag", "since", "location"]));
  const { clause, binds } = buildWhere(args);
  const row = await env.DB.prepare(
    `SELECT ${ROW_COLUMNS} FROM earthquakes ${clause} ORDER BY RANDOM() LIMIT 1`,
  )
    .bind(...binds)
    .first<EarthquakeRow>();

  if (!row) return { text: dim("No earthquakes match — nothing to show.") };
  return {
    text: dim("🎲 Random earthquake") + EOL + EOL + renderEarthquakeDetail(row),
    mapData: rowsToGeoJSON([row]),
  };
}

/** `felt <id>` — a quake's detail card plus a plain-language impact explainer. */
async function runFelt(env: Env, tokens: string[]): Promise<CommandResult> {
  const id = tokens[0]?.toLowerCase();
  if (!id || !/^[0-9a-f]{16}$/i.test(id)) {
    throw new CommandError("Usage: felt <id>  (a 16-hex earthquake id from list/search)");
  }
  const row = await env.DB.prepare(
    `SELECT ${ROW_COLUMNS} FROM earthquakes WHERE id = ?`,
  )
    .bind(id)
    .first<EarthquakeRow>();

  if (!row) return { text: color(`No earthquake with id ${id}.`, "red") };

  const detail = renderEarthquakeDetail(row);
  const impact =
    row.magdefault === null
      ? dim("Magnitude unknown — no impact estimate.")
      : renderRichter(row.magdefault);
  return {
    text: detail + EOL + EOL + impact,
    mapData: rowsToGeoJSON([row]),
  };
}

/** `minimap [filters]` — plot recent quakes on a small ASCII lat/lon grid. */
async function runMinimap(env: Env, tokens: string[]): Promise<CommandResult> {
  const args = parseArgs(
    tokens,
    new Set<OptionKey>(["mag", "since", "location", "limit"]),
  );
  const limit = clamp(args.limit ?? 200, 1, 1000);
  const rows = await queryRows(env, args, limit);
  return { text: renderMinimap(rows), mapData: rowsToGeoJSON(rows) };
}

/** Newest rows the `banner` year summary plots on the map. */
const BANNER_MAP_ROWS = 100;

/**
 * Build the year-at-a-glance banner: the welcome art plus this year's headline
 * figures (total, strongest, latest, monthly trend), with the year's newest
 * rows attached as map data. Shared by the `banner` command and the
 * TerminalHub's welcome frame, so opening the site shows the same summary.
 * The "year" is the newest record's year (falling back to the current UTC year
 * on an empty table), so a stale feed still summarises the latest data.
 */
export async function buildBanner(env: Env): Promise<CommandResult> {
  const newest = await env.DB.prepare(
    `SELECT max(utcdatetime) AS last FROM earthquakes`,
  ).first<{ last: string | null }>();
  const year = (newest?.last ?? new Date().toISOString()).slice(0, 4);
  const since = `${year}-01-01`;

  const agg = await env.DB.prepare(
    `SELECT count(*) AS total,
            max(magdefault) AS maxmag,
            avg(magdefault) AS avgmag,
            sum(CASE WHEN magdefault >= 5 THEN 1 ELSE 0 END) AS significant
       FROM earthquakes WHERE utcdatetime >= ?`,
  )
    .bind(since)
    .first<{
      total: number;
      maxmag: number | null;
      avgmag: number | null;
      significant: number | null;
    }>();
  const total = agg?.total ?? 0;

  let rows: EarthquakeRow[] = [];
  let strongest: EarthquakeRow | null = null;
  let months: TrendBucket[] = [];
  if (total > 0) {
    rows = await queryRows(env, { since }, BANNER_MAP_ROWS);
    strongest =
      (await env.DB.prepare(
        `SELECT ${ROW_COLUMNS} FROM earthquakes
           WHERE utcdatetime >= ?
           ORDER BY magdefault DESC NULLS LAST LIMIT 1`,
      )
        .bind(since)
        .first<EarthquakeRow>()) ?? null;
    const { results } = await env.DB.prepare(
      `SELECT strftime('%Y-%m', utcdatetime) AS bucket,
              count(*) AS count,
              max(magdefault) AS maxmag
         FROM earthquakes WHERE utcdatetime >= ?
         GROUP BY bucket ORDER BY bucket`,
    )
      .bind(since)
      .all<TrendBucket>();
    months = results ?? [];
  }

  const summary: YearSummary = {
    year,
    total,
    maxmag: agg?.maxmag ?? null,
    avgmag: agg?.avgmag ?? null,
    significant: agg?.significant ?? 0,
    latest: rows[0] ?? null,
    strongest,
    months,
  };

  return {
    text: renderWelcome(summary),
    mapData: rows.length ? rowsToGeoJSON(rows) : undefined,
  };
}

/** `banner` — the year-at-a-glance welcome screen (aka `about`). */
function runBanner(env: Env): Promise<CommandResult> {
  return buildBanner(env);
}

/** `watch [--mag>N] [--location STR]` — subscribe this terminal to matching alerts. */
function runWatch(_env: Env, tokens: string[]): CommandResult {
  const args = parseArgs(tokens, new Set<OptionKey>(["mag", "location"]));
  const filter: WatchFilter = {};
  if (args.minMag !== undefined) filter.minMag = args.minMag;
  if (args.location !== undefined) filter.location = args.location;

  if (filter.minMag === undefined && filter.location === undefined) {
    throw new CommandError(
      "Usage: watch [--mag>N] [--location STR]  (at least one filter). Use unwatch to clear.",
    );
  }

  const parts: string[] = [];
  if (filter.minMag !== undefined) parts.push(`magnitude ≥ ${filter.minMag}`);
  if (filter.location !== undefined) parts.push(`location matching "${filter.location}"`);
  const text =
    color("👁  Watching", "cyan") +
    " for new quakes with " +
    parts.join(" and ") +
    "." +
    EOL +
    dim('Other alerts are muted for this terminal. Run "unwatch" to hear them all again.');
  return { text, watch: filter };
}

/** `unwatch` — clear any alert filter; receive all real-time alerts again. */
function runUnwatch(): CommandResult {
  return {
    text: color("Watch cleared", "green") + dim(" — you'll receive all alerts again."),
    watch: null,
  };
}

/** Clamp `n` to the inclusive range [min, max]. */
function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

// --- Registry + dispatch ---------------------------------------------------

/** A documented option for the help text. */
interface OptionDoc {
  flag: string;
  desc: string;
}

/** A single command: its spellings, help text, and handler. */
interface CommandSpec {
  name: string;
  aliases: string[];
  usage: string;
  summary: string;
  options: OptionDoc[];
  run: (env: Env, args: string[]) => Promise<CommandResult> | CommandResult;
}

/**
 * The single source of truth for commands. `help` renders from this list, so
 * it can't fall out of sync with what dispatch actually accepts.
 */
const COMMANDS: CommandSpec[] = [
  {
    name: "help",
    aliases: ["?"],
    usage: "help",
    summary: "Show this help.",
    options: [],
    run: () => ({ text: helpText() }),
  },
  {
    name: "clear",
    aliases: ["cls"],
    usage: "clear",
    summary: "Clear the terminal screen.",
    options: [],
    // The browser client short-circuits this locally for an instant, top-anchored
    // redraw (see public/app.js); this handler is the fallback for raw ws clients,
    // returning the ANSI clear-screen + clear-scrollback + home sequence.
    run: () => ({ text: "\x1b[2J\x1b[3J\x1b[H" }),
  },
  {
    name: "list",
    aliases: ["ls"],
    usage: "list [options]",
    summary: "List recent earthquakes (newest first).",
    options: [
      { flag: "--mag>N", desc: "Minimum magnitude (e.g. --mag>5)." },
      { flag: "--since YYYY-MM-DD", desc: "Only on/after this UTC date." },
      { flag: "--location STR", desc: "Filter by location substring." },
      { flag: "--limit N", desc: `Max rows (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` },
    ],
    run: runList,
  },
  {
    name: "search",
    aliases: ["find"],
    usage: "search <id | text>",
    summary: "Look up by id, or search by location text.",
    options: [],
    run: runSearch,
  },
  {
    name: "export",
    aliases: [],
    usage: "export csv|json [filters]",
    summary: "Download the filtered set as a CSV or JSON file.",
    options: [
      { flag: "csv | json", desc: "Output format." },
      { flag: "[list filters]", desc: `Same --mag/--since/--location/--limit (max ${MAX_EXPORT}).` },
    ],
    run: runExport,
  },
  {
    name: "trend",
    aliases: [],
    usage: "trend [options]",
    summary: "ASCII bar chart of quake counts over time.",
    options: [
      { flag: "--by day|month", desc: "Time bucket (default day)." },
      { flag: "[list filters]", desc: "Same --mag/--since/--location/--limit (buckets)." },
    ],
    run: runTrend,
  },
  {
    name: "stats",
    aliases: ["summary"],
    usage: "stats [filters]",
    summary: "Summary card: totals, averages, and the strongest quake.",
    options: [
      { flag: "[list filters]", desc: "Same --mag/--since/--location." },
    ],
    run: runStats,
  },
  {
    name: "sparkline",
    aliases: ["spark"],
    usage: "sparkline [options]",
    summary: "One-line Unicode trend of counts over time.",
    options: [
      { flag: "--by day|month", desc: "Time bucket (default day)." },
      { flag: "[list filters]", desc: "Same --mag/--since/--location/--limit." },
    ],
    run: runSparkline,
  },
  {
    name: "top",
    aliases: ["biggest"],
    usage: "top [options]",
    summary: "Leaderboard of the biggest (or deepest) quakes.",
    options: [
      { flag: "--by mag|depth", desc: "Rank by magnitude (default) or depth." },
      { flag: "[list filters]", desc: "Same --mag/--since/--location/--limit." },
    ],
    run: runTop,
  },
  {
    name: "nearby",
    aliases: ["near"],
    usage: "nearby <lat> <lon> [options]",
    summary: "Closest quakes to a point, sorted by distance.",
    options: [
      { flag: "--radius KM", desc: `Search radius (default ${NEARBY_DEFAULT_RADIUS}km).` },
      { flag: "--mag>N / --limit N", desc: "Also accepts magnitude / row-count filters." },
    ],
    run: runNearby,
  },
  {
    name: "minimap",
    aliases: ["ascii"],
    usage: "minimap [filters]",
    summary: "Plot recent quakes on a small ASCII lat/lon grid.",
    options: [
      { flag: "[list filters]", desc: "Same --mag/--since/--location/--limit." },
    ],
    run: runMinimap,
  },
  {
    name: "compare",
    aliases: ["vs"],
    usage: "compare <A> <B>",
    summary: "Side-by-side counts & magnitudes for two regions.",
    options: [
      { flag: "<A> <B>", desc: "Two location terms (e.g. compare Sabah Sumatra)." },
    ],
    run: runCompare,
  },
  {
    name: "richter",
    aliases: ["scale"],
    usage: "richter <mag>",
    summary: "Explain what a magnitude means (severity + energy).",
    options: [
      { flag: "<mag>", desc: "A magnitude value (e.g. richter 6.5)." },
    ],
    run: runRichter,
  },
  {
    name: "felt",
    aliases: [],
    usage: "felt <id>",
    summary: "A quake's detail card plus a plain-language impact note.",
    options: [
      { flag: "<id>", desc: "A 16-hex earthquake id (from list/search)." },
    ],
    run: runFelt,
  },
  {
    name: "random",
    aliases: ["quake", "roll"],
    usage: "random [filters]",
    summary: "Surface one random earthquake as a detail card.",
    options: [
      { flag: "[list filters]", desc: "Bias the draw with --mag/--since/--location." },
    ],
    run: runRandom,
  },
  {
    name: "watch",
    aliases: [],
    usage: "watch [--mag>N] [--location STR]",
    summary: "Alert this terminal only on quakes matching a filter.",
    options: [
      { flag: "--mag>N", desc: "Only alert at/above this magnitude." },
      { flag: "--location STR", desc: "Only alert for matching locations." },
    ],
    run: runWatch,
  },
  {
    name: "unwatch",
    aliases: [],
    usage: "unwatch",
    summary: "Clear the alert filter (hear every alert again).",
    options: [],
    run: runUnwatch,
  },
  {
    name: "banner",
    aliases: ["about"],
    usage: "banner",
    summary: "Year-at-a-glance summary (also shown on connect).",
    options: [],
    run: runBanner,
  },
];

/** Alias/name → spec lookup, built once from {@link COMMANDS}. */
const COMMAND_LOOKUP = new Map<string, CommandSpec>();
for (const spec of COMMANDS) {
  COMMAND_LOOKUP.set(spec.name, spec);
  for (const alias of spec.aliases) COMMAND_LOOKUP.set(alias, spec);
}

/** Render the help screen from the command registry. */
function helpText(): string {
  const lines: string[] = [
    bold("Earthquake CLI — available commands"),
    "",
  ];

  for (const spec of COMMANDS) {
    lines.push(`  ${bold(color(spec.usage.padEnd(30), "cyan"))}${spec.summary}`);
    for (const opt of spec.options) {
      lines.push(dim(`      ${opt.flag.padEnd(19)}`) + opt.desc);
    }
  }

  lines.push("");
  lines.push(dim("Example: ") + "list --mag>5 --since 2026-01-01 --location Sabah");
  return lines.join(EOL);
}

/**
 * Parse and execute a single command line, returning a {@link CommandResult}.
 * User-facing problems (bad flags, unknown commands) return a friendly error
 * string; unexpected failures (e.g. D1 errors) are re-thrown for the caller.
 */
export async function executeCommand(
  line: string,
  env: Env,
): Promise<CommandResult> {
  const tokens = tokenize(line.trim());
  if (tokens.length === 0) return { text: "" };

  const [command, ...args] = tokens;
  const spec = COMMAND_LOOKUP.get(command.toLowerCase());

  if (!spec) {
    return {
      text:
        color(`Unknown command: ${command}`, "red") +
        EOL +
        dim('Type "help" for a list of commands.'),
    };
  }

  try {
    return await spec.run(env, args);
  } catch (error) {
    if (error instanceof CommandError) {
      return { text: color(`Error: ${error.message}`, "red") };
    }
    throw error;
  }
}
