/**
 * Command parsing and execution for the Earthquake CLI terminal.
 *
 * `executeCommand(line, env)` takes a raw input line (as typed at the prompt),
 * parses it, runs the corresponding parameterized D1 query, and returns a
 * formatted string ready to write to the terminal. All queries are bound
 * (never string-interpolated) so user input can't inject SQL.
 *
 * Supported commands (see `help`):
 *   help
 *   list [--mag>N] [--since YYYY-MM-DD] [--location STR] [--limit N]
 *   search <id | text>
 */

import type { Env, EarthquakeRow } from "../types";
import {
  bold,
  color,
  dim,
  EOL,
  renderEarthquakeDetail,
  renderEarthquakeTable,
} from "./format";
import { rowsToGeoJSON, type EarthquakeFeatureCollection } from "./geojson";

/**
 * The result of running a command: ANSI `text` for the terminal, plus optional
 * `mapData` (Phase 6) that the browser plots on the MapLibre panel. Commands
 * that return rows (`list`, `search`) attach `mapData`; `help` and errors don't.
 */
export interface CommandResult {
  text: string;
  mapData?: EarthquakeFeatureCollection;
}

/** Columns selected for every row-returning query (matches EarthquakeRow). */
const ROW_COLUMNS = `id, utcdatetime, localdatetime, lat, lon, depth,
   location, location_original, magdefault, magtypedefault, status`;

/** Default and maximum number of rows returned by `list` / `search`. */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

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

/** Parsed filters for the `list` command. */
interface ListFilters {
  minMag?: number;
  since?: string;
  location?: string;
  limit: number;
}

/** Validate a `--mag>N` / `--mag>=N` style value. */
function parseNumber(flag: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new CommandError(`Invalid number for ${flag}: "${raw}"`);
  }
  return value;
}

/**
 * Parse `list` arguments. Accepts `--mag>N`, `--mag>=N`, `--mag N`,
 * `--since DATE`, `--location STR`, `--limit N` (and joined `--flag=value`).
 */
function parseListFilters(tokens: string[]): ListFilters {
  const filters: ListFilters = { limit: DEFAULT_LIMIT };

  for (let i = 0; i < tokens.length; i++) {
    let token = tokens[i];

    // Support `--mag>5`, `--mag>=5`, and `--flag=value` by splitting the value out.
    let inlineValue: string | undefined;
    const relMatch = token.match(/^(--mag)(>=|>)(.*)$/);
    if (relMatch) {
      token = relMatch[1];
      inlineValue = relMatch[3];
    } else if (token.includes("=")) {
      const eq = token.indexOf("=");
      inlineValue = token.slice(eq + 1);
      token = token.slice(0, eq);
    }

    const nextValue = (): string => {
      if (inlineValue !== undefined && inlineValue !== "") return inlineValue;
      const next = tokens[++i];
      if (next === undefined) {
        throw new CommandError(`Missing value for ${token}`);
      }
      return next;
    };

    switch (token) {
      case "--mag":
      case "--mag>":
      case "--min-mag":
        filters.minMag = parseNumber("--mag", nextValue());
        break;
      case "--since":
        filters.since = nextValue();
        break;
      case "--location":
      case "--loc":
        filters.location = nextValue();
        break;
      case "--limit":
        filters.limit = Math.min(
          Math.max(1, Math.trunc(parseNumber("--limit", nextValue()))),
          MAX_LIMIT,
        );
        break;
      default:
        throw new CommandError(`Unknown option: ${tokens[i]}`);
    }
  }

  return filters;
}

/** Run the `list` query with the parsed filters. */
async function runList(env: Env, tokens: string[]): Promise<CommandResult> {
  const filters = parseListFilters(tokens);

  const where: string[] = [];
  const binds: unknown[] = [];

  if (filters.minMag !== undefined) {
    where.push("magdefault >= ?");
    binds.push(filters.minMag);
  }
  if (filters.since !== undefined) {
    where.push("utcdatetime >= ?");
    binds.push(filters.since);
  }
  if (filters.location !== undefined) {
    where.push("(location LIKE ? OR location_original LIKE ?)");
    const like = `%${filters.location}%`;
    binds.push(like, like);
  }

  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const sql = `SELECT ${ROW_COLUMNS}
     FROM earthquakes
     ${whereClause}
     ORDER BY utcdatetime DESC
     LIMIT ?`;
  binds.push(filters.limit);

  const { results } = await env.DB.prepare(sql)
    .bind(...binds)
    .all<EarthquakeRow>();

  const rows = results ?? [];
  return { text: renderEarthquakeTable(rows), mapData: rowsToGeoJSON(rows) };
}

/**
 * Run the `search` command. A single 16-hex-char token is treated as an id
 * (exact lookup → detail view); anything else is a free-text location search.
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

/** The static help text, colour-coded to match the table output. */
function helpText(): string {
  const cmd = (name: string, desc: string) =>
    `  ${bold(color(name.padEnd(30), "cyan"))}${desc}`;

  return [
    bold("Earthquake CLI — available commands"),
    "",
    cmd("help", "Show this help."),
    cmd("list [options]", "List recent earthquakes (newest first)."),
    dim("      --mag>N            ") + "Minimum magnitude (e.g. --mag>5).",
    dim("      --since YYYY-MM-DD ") + "Only on/after this UTC date.",
    dim("      --location STR     ") + "Filter by location substring.",
    dim("      --limit N          ") +
      `Max rows (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
    cmd("search <id | text>", "Look up by id, or search by location text."),
    "",
    dim("Example: ") + "list --mag>5 --since 2026-01-01 --location Sabah",
  ].join(EOL);
}

/**
 * Parse and execute a single command line. Returns formatted terminal output
 * plus, for row-returning commands, `mapData` for the map panel (Phase 6).
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

  try {
    switch (command.toLowerCase()) {
      case "help":
      case "?":
        return { text: helpText() };
      case "list":
      case "ls":
        return await runList(env, args);
      case "search":
      case "find":
        return await runSearch(env, args);
      default:
        return {
          text:
            color(`Unknown command: ${command}`, "red") +
            EOL +
            dim('Type "help" for a list of commands.'),
        };
    }
  } catch (error) {
    if (error instanceof CommandError) {
      return { text: color(`Error: ${error.message}`, "red") };
    }
    throw error;
  }
}
