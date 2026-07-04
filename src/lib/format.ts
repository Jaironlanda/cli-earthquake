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
