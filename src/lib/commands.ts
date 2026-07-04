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
  renderEarthquakeDetail,
  renderEarthquakeTable,
  renderTrend,
  type TrendBucket,
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
type OptionKey = "mag" | "since" | "location" | "limit" | "by";

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
};

/** Options parsed off a command line (all optional; each command uses a subset). */
interface ParsedArgs {
  minMag?: number;
  since?: string;
  location?: string;
  limit?: number;
  by?: string;
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

/** `trend [--by day|month] [filters]` — ASCII histogram of counts over time. */
async function runTrend(env: Env, tokens: string[]): Promise<CommandResult> {
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
  // chart oldest-first (time flowing top→bottom).
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

  const buckets = (results ?? []).reverse();
  return { text: renderTrend(buckets, by) };
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
