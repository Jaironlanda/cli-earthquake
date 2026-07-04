/**
 * Command-layer tests (`src/lib/commands.ts`).
 *
 * `executeCommand` is the shared engine behind the `/ws` terminal: it parses a
 * raw line, runs a parameterized D1 query, and returns a `CommandResult`. These
 * tests drive it directly against the real `DB` binding with a fixed seed set,
 * covering parsing, filtering, the `search`/`export`/`trend` variants, and the
 * friendly-error path.
 */
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { executeCommand } from "../src/lib/commands";
import { seedRows, stripAnsi } from "./helpers";

beforeAll(async () => {
  await seedRows();
});

describe("help / unknown", () => {
  it("help lists the available commands", async () => {
    const { text } = await executeCommand("help", env);
    expect(text).toContain("available commands");
    expect(text).toContain("list");
    expect(text).toContain("export");
  });

  it("an unknown command returns a friendly error", async () => {
    const { text } = await executeCommand("frobnicate", env);
    expect(text).toContain("Unknown command: frobnicate");
  });

  it("a blank line is a no-op", async () => {
    const result = await executeCommand("   ", env);
    expect(result).toEqual({ text: "" });
  });
});

describe("list", () => {
  it("returns all seeded rows with map data, newest first", async () => {
    const { text, mapData } = await executeCommand("list", env);
    expect(text).toContain("Jakarta, Indonesia");
    expect(text).toContain("Aceh, Indonesia");
    expect(text).toContain("3 records");
    // Newest (2026-07-01 Jakarta) should render before oldest (2026-06-01 Aceh).
    expect(text.indexOf("Jakarta")).toBeLessThan(text.indexOf("Aceh"));
    expect(mapData?.features).toHaveLength(3);
  });

  it("--mag>5 filters out the low-magnitude row", async () => {
    const { text } = await executeCommand("list --mag>5", env);
    expect(text).toContain("Aceh, Indonesia"); // 6.2
    expect(text).toContain("Jakarta, Indonesia"); // 5.5
    expect(text).not.toContain("Selangor"); // 4.1, excluded
  });

  it("--location filters by substring", async () => {
    const { text } = await executeCommand("list --location Malaysia", env);
    expect(text).toContain("Selangor, Malaysia");
    expect(text).not.toContain("Aceh");
  });

  it("--limit caps the row count", async () => {
    const { text } = await executeCommand("list --limit 1", env);
    expect(text).toContain("1 record");
  });

  it("an unknown flag returns a friendly error", async () => {
    const { text } = await executeCommand("list --bogus 1", env);
    expect(text).toContain("Unknown option: --bogus");
  });

  it("a non-numeric magnitude returns a friendly error", async () => {
    const { text } = await executeCommand("list --mag>abc", env);
    expect(text).toContain("Invalid number");
  });
});

describe("search", () => {
  it("a 16-hex id shows the detail view", async () => {
    const { text, mapData } = await executeCommand("search aaaa000000000001", env);
    expect(stripAnsi(text)).toContain("Earthquake aaaa000000000001");
    expect(text).toContain("Aceh, Indonesia");
    expect(mapData?.features).toHaveLength(1);
  });

  it("free text searches the location", async () => {
    const { text } = await executeCommand("search Indonesia", env);
    expect(text).toContain("Aceh, Indonesia");
    expect(text).toContain("Jakarta, Indonesia");
    expect(text).not.toContain("Selangor");
  });

  it("with no argument returns a usage error", async () => {
    const { text } = await executeCommand("search", env);
    expect(text).toContain("Usage: search");
  });
});

describe("export", () => {
  it("csv produces a CSV download of the filtered set", async () => {
    const { download } = await executeCommand("export csv --mag>5", env);
    expect(download?.filename).toMatch(/\.csv$/);
    expect(download?.mime).toContain("text/csv");
    expect(download?.content).toContain("Aceh, Indonesia");
    expect(download?.content).not.toContain("Selangor");
  });

  it("json produces valid JSON of the rows", async () => {
    const { download } = await executeCommand("export json", env);
    expect(download?.mime).toContain("application/json");
    const parsed = JSON.parse(download!.content);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(3);
  });

  it("an unknown format returns a usage error", async () => {
    const { text, download } = await executeCommand("export xml", env);
    expect(download).toBeUndefined();
    expect(text).toContain("Usage: export");
  });

  it("an empty result set reports nothing to export", async () => {
    const { text, download } = await executeCommand("export csv --mag>9", env);
    expect(download).toBeUndefined();
    expect(text).toContain("nothing to export");
  });
});

describe("trend", () => {
  it("buckets counts by day and charts them", async () => {
    const { text } = await executeCommand("trend --by day", env);
    expect(text).toContain("Earthquakes per day");
    expect(text).toContain("3 records");
  });

  it("rejects an invalid --by unit", async () => {
    const { text } = await executeCommand("trend --by week", env);
    expect(text).toContain("Invalid --by value");
  });
});
