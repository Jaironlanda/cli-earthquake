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
import { executeCommand, matchesWatch } from "../src/lib/commands";
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

// --- Phase 8 commands ------------------------------------------------------

describe("stats", () => {
  it("summarises totals, peak, and the strongest quake", async () => {
    const { text, mapData } = await executeCommand("stats", env);
    const plain = stripAnsi(text);
    expect(plain).toContain("Earthquake statistics");
    expect(plain).toContain("Records"); // 3 rows
    expect(plain).toContain("6.2"); // peak magnitude
    expect(plain).toContain("Aceh, Indonesia"); // strongest
    expect(mapData?.features).toHaveLength(1); // plots the strongest
  });

  it("reports an empty slice cleanly", async () => {
    const { text } = await executeCommand("stats --mag>9", env);
    expect(text).toContain("nothing to summarise");
  });
});

describe("top", () => {
  it("ranks by magnitude (biggest first)", async () => {
    const { text } = await executeCommand("top --by mag", env);
    expect(text).toContain("by magnitude");
    // Aceh (6.2) before Jakarta (5.5) before Selangor (4.1).
    expect(text.indexOf("Aceh")).toBeLessThan(text.indexOf("Jakarta"));
    expect(text.indexOf("Jakarta")).toBeLessThan(text.indexOf("Selangor"));
  });

  it("ranks by depth when asked", async () => {
    const { text } = await executeCommand("top --by depth", env);
    // Selangor (33km) is deepest, so it comes first.
    expect(text.indexOf("Selangor")).toBeLessThan(text.indexOf("Aceh"));
  });

  it("rejects an invalid --by unit", async () => {
    const { text } = await executeCommand("top --by size", env);
    expect(text).toContain("Invalid --by value");
  });
});

describe("nearby", () => {
  it("finds and orders quakes by distance from a point", async () => {
    // Aceh's own coordinates: it should be the single hit within 100km.
    const { text, mapData } = await executeCommand("nearby 5.4 95.2 --radius 100", env);
    expect(text).toContain("Aceh");
    expect(text).not.toContain("Jakarta");
    expect(mapData?.features).toHaveLength(1);
  });

  it("returns a usage error for bad coordinates", async () => {
    const { text } = await executeCommand("nearby 999 999", env);
    expect(text).toContain("Usage: nearby");
  });
});

describe("compare", () => {
  it("tallies two regions side by side", async () => {
    const { text } = await executeCommand("compare Indonesia Malaysia", env);
    const plain = stripAnsi(text);
    expect(plain).toContain("Indonesia");
    expect(plain).toContain("Malaysia");
    // Indonesia = Aceh + Jakarta (2); Malaysia = Selangor (1).
    expect(plain).toMatch(/Indonesia\s+count\s+2/);
    expect(plain).toMatch(/Malaysia\s+count\s+1/);
  });

  it("requires two terms", async () => {
    const { text } = await executeCommand("compare Sabah", env);
    expect(text).toContain("Usage: compare");
  });
});

describe("richter", () => {
  it("explains a magnitude with a severity band and energy", async () => {
    const { text } = await executeCommand("richter 6.5", env);
    const plain = stripAnsi(text);
    expect(plain).toContain("Magnitude 6.5");
    expect(plain).toContain("Strong");
    expect(plain).toContain("TNT");
  });

  it("rejects a non-numeric magnitude", async () => {
    const { text } = await executeCommand("richter huge", env);
    expect(text).toContain("Usage: richter");
  });
});

describe("sparkline", () => {
  it("renders a one-line trend", async () => {
    const { text } = await executeCommand("sparkline", env);
    expect(text).toContain("per day");
    expect(text).toContain("3 quakes");
  });
});

describe("minimap", () => {
  it("plots quakes on an ASCII grid", async () => {
    const { text, mapData } = await executeCommand("minimap", env);
    const plain = stripAnsi(text);
    expect(plain).toContain("Recent earthquakes");
    expect(plain).toContain("+--"); // grid border
    expect(plain).toContain("●"); // at least one plotted point
    expect(mapData?.features).toHaveLength(3);
  });
});

describe("felt", () => {
  it("shows a quake's detail plus an impact explainer", async () => {
    const { text } = await executeCommand("felt aaaa000000000001", env);
    const plain = stripAnsi(text);
    expect(plain).toContain("Aceh, Indonesia");
    expect(plain).toContain("Strong"); // 6.2 impact band
  });

  it("rejects a non-id argument", async () => {
    const { text } = await executeCommand("felt Aceh", env);
    expect(text).toContain("Usage: felt");
  });

  it("reports a missing id", async () => {
    const { text } = await executeCommand("felt 0000000000000000", env);
    expect(text).toContain("No earthquake with id");
  });
});

describe("random", () => {
  it("returns one quake as a detail card", async () => {
    const { text, mapData } = await executeCommand("random", env);
    expect(stripAnsi(text)).toContain("Random earthquake");
    expect(mapData?.features).toHaveLength(1);
  });

  it("reports when nothing matches the filter", async () => {
    const { text } = await executeCommand("random --mag>9", env);
    expect(text).toContain("nothing to show");
  });
});

describe("watch / unwatch", () => {
  it("watch returns a filter directive", async () => {
    const result = await executeCommand("watch --mag>5 --location Sabah", env);
    expect(result.text).toContain("Watching");
    expect(result.watch).toEqual({ minMag: 5, location: "Sabah" });
  });

  it("watch with no filter is a usage error", async () => {
    const { text, watch } = await executeCommand("watch", env);
    expect(text).toContain("Usage: watch");
    expect(watch).toBeUndefined();
  });

  it("unwatch clears the filter (watch: null)", async () => {
    const result = await executeCommand("unwatch", env);
    expect(result.text).toContain("Watch cleared");
    expect(result.watch).toBeNull();
  });
});

describe("matchesWatch", () => {
  const aceh = SAMPLE_ROW_ACEH();
  it("passes rows meeting the magnitude threshold", () => {
    expect(matchesWatch(aceh, { minMag: 6 })).toBe(true);
    expect(matchesWatch(aceh, { minMag: 7 })).toBe(false);
  });
  it("matches location case-insensitively", () => {
    expect(matchesWatch(aceh, { location: "indonesia" })).toBe(true);
    expect(matchesWatch(aceh, { location: "japan" })).toBe(false);
  });
  it("AND-s magnitude and location", () => {
    expect(matchesWatch(aceh, { minMag: 6, location: "Aceh" })).toBe(true);
    expect(matchesWatch(aceh, { minMag: 7, location: "Aceh" })).toBe(false);
  });
});

describe("banner", () => {
  it("reprints the welcome screen", async () => {
    const { text } = await executeCommand("banner", env);
    expect(stripAnsi(text)).toContain("E A R T H Q U A K E");
  });
});

/** The seeded Aceh row (6.2), for direct matchesWatch unit tests. */
function SAMPLE_ROW_ACEH() {
  return {
    id: "aaaa000000000001",
    utcdatetime: "2026-06-01T10:00:00",
    localdatetime: "2026-06-01T18:00:00",
    lat: 5.4,
    lon: 95.2,
    depth: 10,
    location: "Aceh, Indonesia",
    location_original: "Aceh",
    magdefault: 6.2,
    magtypedefault: "mb",
    status: "NORMAL",
  };
}
