/**
 * Export serializers for the Earthquake CLI (Phase 7).
 *
 * The `export csv|json` command turns a result set into a downloadable file
 * rather than terminal text. These helpers produce the file *content* as a
 * string; the browser (public/app.js) wraps it in a Blob and triggers the
 * download. Kept dependency-free so it runs unchanged on the Worker.
 */

import type { EarthquakeRow } from "../types";

/**
 * Column order for CSV output. Mirrors the persisted `EarthquakeRow` fields so
 * a round-trip export/re-import loses nothing.
 */
const CSV_COLUMNS: (keyof EarthquakeRow)[] = [
  "id",
  "utcdatetime",
  "localdatetime",
  "lat",
  "lon",
  "depth",
  "location",
  "location_original",
  "magdefault",
  "magtypedefault",
  "status",
];

/**
 * Quote a single CSV field per RFC 4180: wrap in double quotes when the value
 * contains a comma, quote, or newline, doubling any embedded quotes. `null`
 * becomes an empty field.
 */
function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** Serialize rows to CSV (header row + one line per row, CRLF-terminated). */
export function rowsToCSV(rows: EarthquakeRow[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(CSV_COLUMNS.map((col) => csvField(row[col])).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

/** Serialize rows to pretty-printed JSON (an array of row objects). */
export function rowsToJSON(rows: EarthquakeRow[]): string {
  return JSON.stringify(rows, null, 2);
}
