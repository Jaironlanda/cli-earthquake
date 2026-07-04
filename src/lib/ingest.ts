/**
 * Ingestion pipeline: fetch the live earthquake feed, derive stable ids, and
 * upsert into D1. Deduplication is inherent — the id is a hash of the record's
 * natural key, so `INSERT OR IGNORE` drops anything already stored.
 */

import type { EarthquakeApiRecord, EarthquakeRow } from "../types";

const EARTHQUAKE_API_URL =
  "https://api.data.gov.my/weather/warning/earthquake/";

/** Number of hex chars kept from the SHA-256 (64 bits — collision-safe here). */
const ID_HEX_LENGTH = 16;

/** D1's per-batch statement cap is 1,000 (free) / 10,000 (paid). Stay well under. */
const BATCH_SIZE = 500;

/**
 * Derive a stable id for a record from its natural key (`utcdatetime|lat|lon`).
 * The upstream API has no id field, so the same physical event always hashes to
 * the same id, making ingestion idempotent.
 */
export async function computeId(
  utcdatetime: string,
  lat: number,
  lon: number,
): Promise<string> {
  const key = `${utcdatetime}|${lat}|${lon}`;
  const data = new TextEncoder().encode(key);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex.slice(0, ID_HEX_LENGTH);
}

/** Fetch and parse the full earthquake feed. Throws on non-2xx or bad JSON. */
export async function fetchLatestEarthquakes(): Promise<EarthquakeApiRecord[]> {
  const response = await fetch(EARTHQUAKE_API_URL, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(
      `Earthquake API request failed: ${response.status} ${response.statusText}`,
    );
  }
  const data = await response.json();
  if (!Array.isArray(data)) {
    throw new Error("Earthquake API returned a non-array payload");
  }
  return data as EarthquakeApiRecord[];
}

/** Convert an API record into the row shape we persist (with derived id). */
async function toRow(record: EarthquakeApiRecord): Promise<EarthquakeRow> {
  return {
    id: await computeId(record.utcdatetime, record.lat, record.lon),
    utcdatetime: record.utcdatetime,
    localdatetime: record.localdatetime ?? null,
    lat: record.lat,
    lon: record.lon,
    depth: record.depth ?? null,
    location: record.location ?? null,
    location_original: record.location_original ?? null,
    magdefault: record.magdefault ?? null,
    magtypedefault: record.magtypedefault ?? null,
    status: record.status ?? null,
  };
}

export interface UpsertResult {
  /** How many records were seen in the input. */
  fetched: number;
  /** How many rows were newly inserted (i.e. not already present). */
  inserted: number;
  /**
   * The rows that were actually newly inserted this run. Phase 5 broadcasts
   * these to open terminals as real-time alerts, so we return the rows
   * themselves, not just the count.
   */
  insertedRows: EarthquakeRow[];
}

/**
 * Upsert records into D1 using batched `INSERT OR IGNORE`. Because `id` is the
 * primary key, already-stored events are ignored. Each statement inserts one
 * row, so a statement whose `meta.changes` is non-zero identifies a genuinely
 * new record — those rows are collected and returned for alert fan-out.
 */
export async function upsertEarthquakes(
  db: D1Database,
  records: EarthquakeApiRecord[],
): Promise<UpsertResult> {
  const rows = await Promise.all(records.map(toRow));

  const insert = db.prepare(
    `INSERT OR IGNORE INTO earthquakes
       (id, utcdatetime, localdatetime, lat, lon, depth,
        location, location_original, magdefault, magtypedefault, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const insertedRows: EarthquakeRow[] = [];
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const statements = chunk.map((row) =>
      insert.bind(
        row.id,
        row.utcdatetime,
        row.localdatetime,
        row.lat,
        row.lon,
        row.depth,
        row.location,
        row.location_original,
        row.magdefault,
        row.magtypedefault,
        row.status,
      ),
    );
    const results = await db.batch(statements);
    // `batch()` preserves order, so result[j] corresponds to chunk[j]: a
    // non-zero `changes` means that row was newly inserted (not a dedupe hit).
    results.forEach((result, j) => {
      if ((result.meta?.changes ?? 0) > 0) insertedRows.push(chunk[j]);
    });
  }

  return { fetched: records.length, inserted: insertedRows.length, insertedRows };
}

/** Convenience: run the full fetch → upsert pipeline. */
export async function ingest(db: D1Database): Promise<UpsertResult> {
  const records = await fetchLatestEarthquakes();
  return upsertEarthquakes(db, records);
}
