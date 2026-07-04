/**
 * Ingestion pipeline tests (`src/lib/ingest.ts`).
 *
 * `computeId` derives stable ids, and `upsertEarthquakes` must be idempotent:
 * re-ingesting the same feed inserts zero new rows. These run against the real
 * `DB` binding but never touch the network (the live-fetch `ingest()` wrapper is
 * left to manual/integration testing).
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { computeId, upsertEarthquakes } from "../src/lib/ingest";
import { SAMPLE_API_RECORDS } from "./helpers";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM earthquakes").run();
});

describe("computeId", () => {
  it("is deterministic for the same natural key", async () => {
    const a = await computeId("2026-07-02T09:15:00", 4.2, 96.1);
    const b = await computeId("2026-07-02T09:15:00", 4.2, 96.1);
    expect(a).toBe(b);
  });

  it("returns a 16-char hex id and differs when the key differs", async () => {
    const a = await computeId("2026-07-02T09:15:00", 4.2, 96.1);
    const b = await computeId("2026-07-02T09:15:00", 4.2, 96.2);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
  });
});

describe("upsertEarthquakes", () => {
  it("inserts all new records and reports the inserted rows", async () => {
    const result = await upsertEarthquakes(env.DB, SAMPLE_API_RECORDS);
    expect(result.fetched).toBe(2);
    expect(result.inserted).toBe(2);
    expect(result.insertedRows).toHaveLength(2);
    expect(result.insertedRows.map((r) => r.location)).toContain("Sumatra, Indonesia");

    const { count } = (await env.DB.prepare(
      "SELECT count(*) AS count FROM earthquakes",
    ).first<{ count: number }>())!;
    expect(count).toBe(2);
  });

  it("is idempotent — re-ingesting the same feed inserts nothing", async () => {
    await upsertEarthquakes(env.DB, SAMPLE_API_RECORDS);
    const second = await upsertEarthquakes(env.DB, SAMPLE_API_RECORDS);
    expect(second.fetched).toBe(2);
    expect(second.inserted).toBe(0);
    expect(second.insertedRows).toHaveLength(0);
  });

  it("only reports genuinely-new rows on a partial overlap", async () => {
    await upsertEarthquakes(env.DB, [SAMPLE_API_RECORDS[0]]);
    const result = await upsertEarthquakes(env.DB, SAMPLE_API_RECORDS);
    expect(result.inserted).toBe(1);
    expect(result.insertedRows[0].location).toBe("Sarawak, Malaysia");
  });
});
