/**
 * Terminal output formatting helpers for the Earthquake CLI.
 *
 * Output travels over the WebSocket as plain strings and is written verbatim
 * into xterm.js (Phase 4), which interprets ANSI escape codes natively. So we
 * emit raw ANSI here: colour by magnitude severity plus a fixed-width table
 * renderer. Kept dependency-free and framework-agnostic.
 */

import type { EarthquakeRow } from "../types";

/** ANSI SGR escape codes we use. `RESET` clears all attributes. */
const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  brightRed: "\x1b[91m",
} as const;

/** Wrap `text` in an ANSI colour, resetting afterwards. */
export function color(text: string, code: keyof typeof ANSI): string {
  return `${ANSI[code]}${text}${ANSI.reset}`;
}

export function bold(text: string): string {
  return `${ANSI.bold}${text}${ANSI.reset}`;
}

export function dim(text: string): string {
  return `${ANSI.dim}${text}${ANSI.reset}`;
}

/**
 * Pick an ANSI colour for a magnitude, matching common seismic-severity bands:
 * <4 minor (gray), 4–4.9 light (green), 5–5.9 moderate (yellow),
 * 6–6.9 strong (red), 7+ major (bold bright red).
 */
export function magnitudeColor(mag: number | null): keyof typeof ANSI {
  if (mag === null) return "gray";
  if (mag >= 7) return "brightRed";
  if (mag >= 6) return "red";
  if (mag >= 5) return "yellow";
  if (mag >= 4) return "green";
  return "gray";
}

/** Format a magnitude value, colour-coded by severity. Right-padded to `width`. */
function formatMagnitude(mag: number | null, width: number): string {
  const text = mag === null ? "—" : mag.toFixed(1);
  const padded = text.padEnd(width);
  return color(padded, magnitudeColor(mag));
}

/** A column spec for the table renderer. */
interface Column {
  header: string;
  width: number;
}

/**
 * Truncate `text` to `width`, appending "…" when it overflows. Pads to `width`
 * otherwise so columns stay aligned. Newlines are stripped to keep rows intact.
 */
function cell(text: string, width: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= width) return clean.padEnd(width);
  if (width <= 1) return clean.slice(0, width);
  return clean.slice(0, width - 1) + "…";
}

/** Newline used between terminal lines. `\r\n` so xterm.js returns the cursor. */
export const EOL = "\r\n";

/**
 * Render a list of earthquake rows as a fixed-width, colour-coded table.
 * Magnitude is coloured per {@link magnitudeColor}; the header is bold.
 */
export function renderEarthquakeTable(rows: EarthquakeRow[]): string {
  if (rows.length === 0) {
    return dim("No matching earthquakes.");
  }

  const columns: Column[] = [
    { header: "TIME (UTC)", width: 19 },
    { header: "MAG", width: 4 },
    { header: "DEPTH", width: 6 },
    { header: "LOCATION", width: 34 },
    { header: "ID", width: 16 },
  ];

  const gap = "  ";
  const headerLine = bold(
    columns.map((c) => c.header.padEnd(c.width)).join(gap),
  );

  const lines = rows.map((row) => {
    const time = cell(row.utcdatetime.replace("T", " "), columns[0].width);
    const mag = formatMagnitude(row.magdefault, columns[1].width);
    const depth = cell(
      row.depth === null ? "—" : `${row.depth}km`,
      columns[2].width,
    );
    const location = cell(row.location ?? "—", columns[3].width);
    const id = dim(cell(row.id, columns[4].width));
    return [time, mag, depth, location, id].join(gap);
  });

  const footer = dim(
    `${rows.length} record${rows.length === 1 ? "" : "s"}.`,
  );

  return [headerLine, ...lines, "", footer].join(EOL);
}

/**
 * The year-at-a-glance figures rendered into the welcome/`banner` screen:
 * headline counts plus the latest and strongest events of the year, and the
 * per-month buckets behind the trend sparkline.
 */
export interface YearSummary {
  year: string;
  total: number;
  maxmag: number | null;
  avgmag: number | null;
  /** Events at or above magnitude 5 this year. */
  significant: number;
  latest: EarthquakeRow | null;
  strongest: EarthquakeRow | null;
  months: TrendBucket[];
}

/**
 * Render the terminal "init screen" shown once on connect (see TerminalHub's
 * welcome frame): a framed banner with a seismograph trace and wordmark, a short
 * status readout, an optional year-at-a-glance summary, and a getting-started
 * hint. Pure ANSI + ASCII in the frame (no wide Unicode) so the box stays
 * aligned in xterm.js at any width.
 */
export function renderWelcome(summary?: YearSummary): string {
  const W = 54; // inner content width, in characters
  const top = dim("╭" + "─".repeat(W + 2) + "╮");
  const bot = dim("╰" + "─".repeat(W + 2) + "╯");
  // Pad the plain content to `W`, then colour it, so the ANSI codes never throw
  // off the width maths. Each boxed line uses a single colour for its content.
  const boxLine = (plain: string, paint: (s: string) => string): string =>
    dim("│ ") + paint(plain.padEnd(W)) + dim(" │");

  const trace = "_/\\".repeat(18); // 54-char seismograph sawtooth
  const banner = [
    top,
    boxLine(trace, (s) => color(s, "gray")),
    boxLine("", (s) => s),
    boxLine("    E A R T H Q U A K E   C L I", (s) => bold(color(s, "cyan"))),
    boxLine("    live seismic data · api.data.gov.my", dim),
    boxLine("    by Jairon Landa · https://github.com/Jaironlanda", dim),
    boxLine("", (s) => s),
    bot,
  ];

  const bullet = (label: string, value: string) =>
    "  " + color("•", "cyan") + " " + dim(label.padEnd(10)) + value;
  const status = [
    bullet("feed", "api.data.gov.my — Malaysia MET"),
    bullet("updates", "every 15 min · real-time alerts on"),
    bullet("map", "MapLibre + Protomaps"),
  ];

  const hint =
    dim("Type ") +
    bold(color("help", "cyan")) +
    dim(" for all commands, or ") +
    bold(color("list", "cyan")) +
    dim(" for the latest quakes.");

  const lines = [...banner, "", ...status];
  if (summary) lines.push("", ...yearSummaryLines(summary));
  lines.push("", hint);
  return lines.join(EOL);
}

/**
 * The year-at-a-glance block inside {@link renderWelcome}: headline count,
 * strongest and latest events, average magnitude, and a per-month trend
 * sparkline. Bullet style matches the status readout above it.
 */
function yearSummaryLines(s: YearSummary): string[] {
  const heading = "  " + bold(color(`${s.year} at a glance`, "cyan"));
  if (s.total === 0) {
    return [heading, dim(`    No earthquakes recorded in ${s.year} yet.`)];
  }

  const bullet = (label: string, value: string) =>
    "  " + color("•", "cyan") + " " + dim(label.padEnd(10)) + value;

  /** One-line event readout: coloured magnitude, location, dimmed UTC time. */
  const event = (row: EarthquakeRow) =>
    color(
      row.magdefault === null ? "M?" : `M${row.magdefault.toFixed(1)}`,
      magnitudeColor(row.magdefault),
    ) +
    ` ${row.location ?? "—"}` +
    dim(`  ${row.utcdatetime.slice(0, 16).replace("T", " ")} UTC`);

  const lines = [
    heading,
    bullet(
      "total",
      `${s.total} earthquake${s.total === 1 ? "" : "s"}` +
        (s.significant > 0
          ? dim(" · ") + color(`${s.significant} at mag 5+`, "yellow")
          : ""),
    ),
  ];
  if (s.strongest) lines.push(bullet("strongest", event(s.strongest)));
  if (s.latest) lines.push(bullet("latest", event(s.latest)));
  if (s.avgmag !== null) {
    lines.push(bullet("avg mag", s.avgmag.toFixed(2)));
  }
  if (s.months.length > 1) {
    const maxCount = Math.max(...s.months.map((m) => m.count));
    const spark = s.months
      .map((m) => {
        const level =
          maxCount === 0
            ? 0
            : Math.round((m.count / maxCount) * (SPARK_CHARS.length - 1));
        return color(SPARK_CHARS[level], magnitudeColor(m.maxmag));
      })
      .join("");
    lines.push(
      bullet(
        "by month",
        spark + dim(`  ${s.months[0].bucket} → ${s.months[s.months.length - 1].bucket}`),
      ),
    );
  }
  return lines;
}

/** Cap on how many rows a single alert banner enumerates before summarising. */
const ALERT_MAX_ROWS = 10;

/**
 * Render a real-time alert banner announcing newly-ingested earthquakes
 * (Phase 5). Broadcast to every open terminal by the TerminalHub when the cron
 * ingest finds unseen records. The most significant events (highest magnitude)
 * are shown first, capped at {@link ALERT_MAX_ROWS}, with a count of the rest.
 */
export function renderAlertBanner(rows: EarthquakeRow[]): string {
  if (rows.length === 0) return "";

  const sorted = [...rows].sort(
    (a, b) => (b.magdefault ?? -Infinity) - (a.magdefault ?? -Infinity),
  );
  const shown = sorted.slice(0, ALERT_MAX_ROWS);

  const heading =
    bold(color("⚡ ALERT", "brightRed")) +
    " " +
    bold(
      `${rows.length} new earthquake${rows.length === 1 ? "" : "s"} detected`,
    );

  const body = renderEarthquakeTable(shown);

  const lines = [heading, "", body];
  const hidden = rows.length - shown.length;
  if (hidden > 0) {
    lines.push(dim(`…and ${hidden} more. Run "list" to see the full feed.`));
  }

  return lines.join(EOL);
}

/** One bucket of the `trend` histogram: a time label, its count, and peak mag. */
export interface TrendBucket {
  bucket: string;
  count: number;
  maxmag: number | null;
}

/** Widest bar (in block characters) drawn for the busiest bucket. */
const TREND_BAR_WIDTH = 40;

/**
 * Render an ASCII bar chart of earthquake counts per time bucket (Phase 7's
 * `trend --by day|month`). Buckets arrive oldest-first; each bar is scaled to
 * the busiest bucket and coloured by that bucket's peak magnitude.
 */
export function renderTrend(buckets: TrendBucket[], by: string): string {
  if (buckets.length === 0) {
    return dim("No earthquakes match — nothing to chart.");
  }

  const maxCount = Math.max(...buckets.map((b) => b.count));
  const labelWidth = Math.max(...buckets.map((b) => b.bucket.length));
  const countWidth = String(maxCount).length;

  const heading = bold(`Earthquakes per ${by}`);

  const lines = buckets.map((b) => {
    const label = dim(b.bucket.padEnd(labelWidth));
    // At least one block for any non-zero bucket so small counts stay visible.
    const filled = Math.max(1, Math.round((b.count / maxCount) * TREND_BAR_WIDTH));
    const bar = color("█".repeat(filled), magnitudeColor(b.maxmag));
    const count = String(b.count).padStart(countWidth);
    return `${label}  ${bar} ${count}`;
  });

  const total = buckets.reduce((sum, b) => sum + b.count, 0);
  const footer = dim(
    `${total} record${total === 1 ? "" : "s"} across ${buckets.length} ${by}${
      buckets.length === 1 ? "" : "s"
    }. Bar colour = peak magnitude.`,
  );

  return [heading, "", ...lines, "", footer].join(EOL);
}

// --- Phase 8: stats / nearby / richter / sparkline / minimap / compare -----

/** Aggregate figures for the `stats` command (one filtered slice of the table). */
export interface QuakeStats {
  total: number;
  maxmag: number | null;
  avgmag: number | null;
  avgdepth: number | null;
  first: string | null;
  last: string | null;
  strongest: EarthquakeRow | null;
}

/** Render the `stats` summary card: totals, extremes, and the strongest event. */
export function renderStats(stats: QuakeStats): string {
  if (stats.total === 0) {
    return dim("No earthquakes match — nothing to summarise.");
  }

  const field = (label: string, value: string) =>
    "  " + dim(label.padEnd(14)) + value;

  const spanDays = daysBetween(stats.first, stats.last);
  const perDay = spanDays > 0 ? stats.total / spanDays : stats.total;

  const lines = [
    bold(color("Earthquake statistics", "cyan")),
    "",
    field("Records", String(stats.total)),
    field(
      "Peak magnitude",
      stats.maxmag === null
        ? "—"
        : color(stats.maxmag.toFixed(1), magnitudeColor(stats.maxmag)),
    ),
    field("Avg magnitude", stats.avgmag === null ? "—" : stats.avgmag.toFixed(2)),
    field("Avg depth", stats.avgdepth === null ? "—" : `${stats.avgdepth.toFixed(1)} km`),
    field("Per day", `${perDay.toFixed(1)}`),
    field(
      "Time span",
      stats.first === null
        ? "—"
        : `${stats.first.slice(0, 10)} → ${(stats.last ?? "").slice(0, 10)}` +
          dim(` (${spanDays} day${spanDays === 1 ? "" : "s"})`),
    ),
  ];

  if (stats.strongest) {
    const s = stats.strongest;
    lines.push(
      "",
      field(
        "Strongest",
        color(
          (s.magdefault ?? 0).toFixed(1),
          magnitudeColor(s.magdefault),
        ) +
          "  " +
          (s.location ?? "—") +
          dim(`  ${s.utcdatetime.slice(0, 10)}`),
      ),
    );
  }

  return lines.join(EOL);
}

/** Convert a whole-earth day count between two ISO timestamps (0 if unknown). */
function daysBetween(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  const ms = Date.parse(b) - Date.parse(a);
  if (!Number.isFinite(ms)) return 0;
  return Math.max(1, Math.round(ms / 86_400_000));
}

/** An earthquake row annotated with its distance from a query point. */
export type RowWithDistance = EarthquakeRow & { distanceKm: number };

/** Render the `nearby` result: rows ordered by distance, with a distance column. */
export function renderNearbyTable(
  rows: RowWithDistance[],
  origin: { lat: number; lon: number },
): string {
  const head =
    bold(`Earthquakes near ${origin.lat.toFixed(3)}, ${origin.lon.toFixed(3)}`) +
    EOL +
    "";
  if (rows.length === 0) {
    return head + EOL + dim("None found within the search radius.");
  }

  const gap = "  ";
  const cols = [
    { header: "DIST", width: 8 },
    { header: "MAG", width: 4 },
    { header: "DEPTH", width: 6 },
    { header: "LOCATION", width: 30 },
    { header: "TIME (UTC)", width: 19 },
  ];
  const headerLine = bold(cols.map((c) => c.header.padEnd(c.width)).join(gap));

  const body = rows.map((r) => {
    const dist = cell(`${r.distanceKm.toFixed(0)}km`, cols[0].width);
    const mag = formatMagnitude(r.magdefault, cols[1].width);
    const depth = cell(r.depth === null ? "—" : `${r.depth}km`, cols[2].width);
    const loc = cell(r.location ?? "—", cols[3].width);
    const time = dim(cell(r.utcdatetime.replace("T", " "), cols[4].width));
    return [dist, mag, depth, loc, time].join(gap);
  });

  const footer = dim(`${rows.length} within range.`);
  return [head + headerLine, ...body, "", footer].join(EOL);
}

/** A Richter-scale severity band: threshold, label, and a plain-language effect. */
const RICHTER_BANDS: { min: number; label: string; effect: string }[] = [
  { min: 8, label: "Great", effect: "Catastrophic — total destruction over vast areas." },
  { min: 7, label: "Major", effect: "Serious damage across large regions." },
  { min: 6, label: "Strong", effect: "Destructive in populated areas up to ~150km across." },
  { min: 5, label: "Moderate", effect: "Damage to poorly built structures; felt widely." },
  { min: 4, label: "Light", effect: "Noticeable shaking; rattles indoors, rarely damaging." },
  { min: 2, label: "Minor", effect: "Often felt, but seldom causes damage." },
  { min: -Infinity, label: "Micro", effect: "Not felt by people; recorded by instruments only." },
];

/**
 * Explain what a magnitude means (`richter <mag>`): its severity band, a
 * plain-language effect, and its energy relative to lower magnitudes (each whole
 * step ≈ 31.6× the energy, since E ∝ 10^(1.5·M)).
 */
export function renderRichter(mag: number): string {
  const band = RICHTER_BANDS.find((b) => mag >= b.min) ?? RICHTER_BANDS[RICHTER_BANDS.length - 1];
  const paint = magnitudeColor(mag);

  // Gutenberg–Richter energy (joules) ≈ 10^(1.5·M + 4.8); express as tons of TNT.
  const joules = Math.pow(10, 1.5 * mag + 4.8);
  const tonsTnt = joules / 4.184e9;

  const lines = [
    bold("Magnitude ") + color(mag.toFixed(1), paint) + "  " + color(`— ${band.label}`, paint),
    "",
    "  " + band.effect,
    "",
    "  " + dim("Energy    ") + `≈ ${formatTnt(tonsTnt)} of TNT`,
    "  " + dim("Vs M") + dim((mag - 1).toFixed(0).padEnd(6)) + `≈ 32× more energy per whole step`,
  ];
  return lines.join(EOL);
}

/** Human-friendly TNT mass (kg → kilotons) for the richter energy readout. */
function formatTnt(tons: number): string {
  if (tons < 0.001) return `${(tons * 1e6).toFixed(0)} g`;
  if (tons < 1) return `${(tons * 1000).toFixed(0)} kg`;
  if (tons < 1000) return `${tons.toFixed(0)} tons`;
  if (tons < 1e6) return `${(tons / 1000).toFixed(1)} kilotons`;
  return `${(tons / 1e6).toFixed(1)} megatons`;
}

/** Unicode ramp for the `sparkline` command, low → high. */
const SPARK_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/** Render a compact one-line `sparkline` of counts per bucket, coloured by peak mag. */
export function renderSparkline(buckets: TrendBucket[], by: string): string {
  if (buckets.length === 0) {
    return dim("No earthquakes match — nothing to chart.");
  }

  const maxCount = Math.max(...buckets.map((b) => b.count));
  const spark = buckets
    .map((b) => {
      const level = maxCount === 0 ? 0 : Math.round((b.count / maxCount) * (SPARK_CHARS.length - 1));
      return color(SPARK_CHARS[level], magnitudeColor(b.maxmag));
    })
    .join("");

  const total = buckets.reduce((sum, b) => sum + b.count, 0);
  const range =
    buckets.length > 1
      ? `${buckets[0].bucket} → ${buckets[buckets.length - 1].bucket}`
      : buckets[0].bucket;

  return (
    dim(`per ${by}  `) +
    spark +
    dim(`  ${total} quake${total === 1 ? "" : "s"}, ${range}`)
  );
}

/** Render recent quakes as points on a small ASCII lat/lon grid (`minimap`). */
export function renderMinimap(rows: EarthquakeRow[]): string {
  const pts = rows.filter(
    (r) => Number.isFinite(r.lat) && Number.isFinite(r.lon),
  );
  if (pts.length === 0) {
    return dim("No plottable earthquakes (missing coordinates).");
  }

  const W = 48;
  const H = 16;
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const p of pts) {
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLon = Math.min(minLon, p.lon);
    maxLon = Math.max(maxLon, p.lon);
  }
  // Pad a degenerate (single-point or colinear) extent so the maths stays finite.
  if (maxLat - minLat < 0.5) { minLat -= 0.5; maxLat += 0.5; }
  if (maxLon - minLon < 0.5) { minLon -= 0.5; maxLon += 0.5; }

  // Grid holds the peak magnitude seen in each cell (null = empty).
  const grid: (number | null)[][] = Array.from({ length: H }, () =>
    Array<number | null>(W).fill(null),
  );
  for (const p of pts) {
    const x = Math.round(((p.lon - minLon) / (maxLon - minLon)) * (W - 1));
    const y = Math.round(((maxLat - p.lat) / (maxLat - minLat)) * (H - 1));
    const mag = p.magdefault ?? 0;
    if (grid[y][x] === null || mag > (grid[y][x] as number)) grid[y][x] = mag;
  }

  const border = dim("+" + "-".repeat(W) + "+");
  const lines = [border];
  for (let y = 0; y < H; y++) {
    let rowStr = dim("|");
    for (let x = 0; x < W; x++) {
      const mag = grid[y][x];
      rowStr += mag === null ? " " : color("●", magnitudeColor(mag));
    }
    rowStr += dim("|");
    lines.push(rowStr);
  }
  lines.push(border);

  const bounds = dim(
    `lat ${minLat.toFixed(1)}…${maxLat.toFixed(1)}  ` +
      `lon ${minLon.toFixed(1)}…${maxLon.toFixed(1)}  ` +
      `${pts.length} plotted`,
  );
  return [bold("Recent earthquakes"), ...lines, bounds].join(EOL);
}

/** One side of a `compare` — a named region's aggregate figures. */
export interface CompareSide {
  label: string;
  total: number;
  maxmag: number | null;
  avgmag: number | null;
}

/** Render a side-by-side `compare` of two regions' counts and magnitudes. */
export function renderCompare(a: CompareSide, b: CompareSide): string {
  const nameW = Math.max(a.label.length, b.label.length, 8);
  const row = (side: CompareSide) => {
    const mag = side.maxmag === null ? "—" : side.maxmag.toFixed(1);
    return (
      "  " +
      bold(side.label.padEnd(nameW)) +
      "  " +
      dim("count ") +
      String(side.total).padStart(5) +
      "   " +
      dim("peak ") +
      color(mag.padStart(4), magnitudeColor(side.maxmag)) +
      "   " +
      dim("avg ") +
      (side.avgmag === null ? "—" : side.avgmag.toFixed(2))
    );
  };
  return [bold(color("Region comparison", "cyan")), "", row(a), row(b)].join(EOL);
}

/** Render a single earthquake as a detailed key/value block (for `search <id>`). */
export function renderEarthquakeDetail(row: EarthquakeRow): string {
  const field = (label: string, value: string) =>
    `${dim(label.padEnd(14))}${value}`;

  return [
    bold(color("Earthquake ", "cyan") + row.id),
    field("Time (UTC)", row.utcdatetime.replace("T", " ")),
    field("Time (local)", (row.localdatetime ?? "—").replace("T", " ")),
    field(
      "Magnitude",
      color(
        row.magdefault === null ? "—" : row.magdefault.toFixed(1),
        magnitudeColor(row.magdefault),
      ) + (row.magtypedefault ? dim(` (${row.magtypedefault})`) : ""),
    ),
    field("Depth", row.depth === null ? "—" : `${row.depth} km`),
    field("Coordinates", `${row.lat}, ${row.lon}`),
    field("Location", row.location ?? "—"),
    field("Original", row.location_original ?? "—"),
    field("Status", row.status ?? "—"),
  ].join(EOL);
}
