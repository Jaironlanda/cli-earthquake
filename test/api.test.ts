/**
 * HTTP + WebSocket API tests for the Worker (`src/index.ts`).
 *
 * Exercises the request-routing surface end-to-end through the in-process
 * Worker: the JSON config route, the bearer-guarded admin route, and the `/ws`
 * terminal (upgrade handling + a real command round-trip through the Durable
 * Object). The success path of `POST /admin/ingest` calls the live upstream API
 * over the network, so it is intentionally not covered here — the pipeline
 * itself is unit-tested in `ingest.test.ts`.
 */
import { SELF, env } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTerminal, seedRows, SAMPLE_ROWS } from "./helpers";
import type { EarthquakeRow } from "../src/types";

const BASE = "https://example.com";

describe("GET /api/config", () => {
  it("returns the (empty) Protomaps key as JSON", async () => {
    const resp = await SELF.fetch(`${BASE}/api/config`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("application/json");
    expect(await resp.json()).toEqual({ protomapsKey: "" });
  });
});

describe("POST /admin/ingest (auth)", () => {
  it("rejects a missing bearer token with 401", async () => {
    const resp = await SELF.fetch(`${BASE}/admin/ingest`, { method: "POST" });
    expect(resp.status).toBe(401);
    expect(await resp.json()).toEqual({ error: "Unauthorized" });
  });

  it("rejects a wrong bearer token with 401", async () => {
    const resp = await SELF.fetch(`${BASE}/admin/ingest`, {
      method: "POST",
      headers: { Authorization: "Bearer nope" },
    });
    expect(resp.status).toBe(401);
  });

  it("rejects a non-POST method with 405 + Allow header", async () => {
    const resp = await SELF.fetch(`${BASE}/admin/ingest`, { method: "GET" });
    expect(resp.status).toBe(405);
    expect(resp.headers.get("Allow")).toBe("POST");
  });
});

describe("GET /ws (upgrade handling)", () => {
  it("returns 426 without the WebSocket upgrade header", async () => {
    const resp = await SELF.fetch(`${BASE}/ws`);
    expect(resp.status).toBe(426);
  });

  it("completes the upgrade with a 101 + welcome frame", async () => {
    const term = await openTerminal();
    const welcome = await term.recv((f) => f.type === "welcome");
    expect(welcome.text).toContain("live seismic data");
    term.close();
  });
});

describe("/ws terminal round-trip", () => {
  beforeAll(async () => {
    await seedRows();
  });

  it("greets with the year banner and its map markers", async () => {
    const term = await openTerminal();
    const welcome = await term.recv((f) => f.type === "welcome");
    expect(welcome.text).toContain("at a glance");
    // The year's quakes ride along so the map plots markers on page open.
    expect(
      (welcome.mapData as { features: unknown[] } | undefined)?.features,
    ).toHaveLength(3);
    term.close();
  });

  it("runs `help` and returns an output frame", async () => {
    const term = await openTerminal();
    term.send("help");
    const frame = await term.recv((f) => f.type === "output");
    expect(frame.text).toContain("available commands");
    term.close();
  });

  it("runs `list` and returns rows plus GeoJSON mapData", async () => {
    const term = await openTerminal();
    term.send("list");
    const frame = await term.recv((f) => f.type === "output");
    expect(frame.text).toContain("Aceh, Indonesia");
    expect((frame.mapData as { type: string }).type).toBe("FeatureCollection");
    term.close();
  });

  it("returns a download frame for `export csv`", async () => {
    const term = await openTerminal();
    term.send("export csv");
    const frame = await term.recv((f) => f.type === "download");
    expect(frame.filename).toMatch(/^earthquakes-.*\.csv$/);
    expect(frame.mime).toContain("text/csv");
    expect(frame.content).toContain("Aceh, Indonesia");
    term.close();
  });

  it("replies with an error frame for a malformed (non-JSON) message", async () => {
    const term = await openTerminal();
    // Drain the welcome first so the error frame is unambiguous.
    await term.recv((f) => f.type === "welcome");
    // Bypass the input helper to send raw junk.
    const resp = await SELF.fetch(`${BASE}/ws`, { headers: { Upgrade: "websocket" } });
    const ws = resp.webSocket!;
    ws.accept();
    const errored = new Promise<string>((resolve) => {
      ws.addEventListener("message", (e) => {
        const f = JSON.parse(e.data as string);
        if (f.type === "error") resolve(f.text);
      });
    });
    ws.send("this is not json");
    expect(await errored).toContain("Malformed");
    ws.close();
    term.close();
  });
});

describe("real-time alerts + watch filtering (Phase 8)", () => {
  const minor: EarthquakeRow = {
    id: "dddd000000000004",
    utcdatetime: "2026-07-03T00:00:00",
    localdatetime: "2026-07-03T08:00:00",
    lat: 3.1,
    lon: 101.6,
    depth: 20,
    location: "Selangor, Malaysia",
    location_original: "Selangor",
    magdefault: 4.0,
    magtypedefault: "mb",
    status: "NORMAL",
  };
  const major: EarthquakeRow = {
    id: "eeee000000000005",
    utcdatetime: "2026-07-03T01:00:00",
    localdatetime: "2026-07-03T09:00:00",
    lat: 5.4,
    lon: 95.2,
    depth: 12,
    location: "Aceh, Indonesia",
    location_original: "Aceh",
    magdefault: 6.5,
    magtypedefault: "mb",
    status: "NORMAL",
  };

  it("a watcher gets only matching quakes; an unfiltered terminal gets all", async () => {
    const plain = await openTerminal();
    const watcher = await openTerminal();

    // Subscribe the second terminal to strong quakes only, and wait for the DO
    // to acknowledge (so its serializeAttachment has run before we broadcast).
    watcher.send("watch --mag>6");
    await watcher.recv((f) => f.type === "output");

    // Fan out one minor + one major quake via the hub's RPC (as scheduled() does).
    const hub = env.TERMINAL_HUB.getByName("global-hub");
    await hub.broadcastNewEarthquakes([minor, major]);

    const plainAlert = await plain.recv((f) => f.type === "alert");
    expect(plainAlert.text).toContain("Aceh, Indonesia"); // major
    expect(plainAlert.text).toContain("Selangor, Malaysia"); // minor
    expect(plainAlert.bell).toBe(true); // 6.5 ≥ bell threshold

    const watcherAlert = await watcher.recv((f) => f.type === "alert");
    expect(watcherAlert.text).toContain("Aceh, Indonesia"); // major only
    expect(watcherAlert.text).not.toContain("Selangor"); // minor filtered out
    expect(watcherAlert.bell).toBe(true);

    plain.close();
    watcher.close();
  });
});

describe("welcome banner reflects data added out-of-band (cache)", () => {
  beforeAll(async () => {
    await seedRows();
  });
  afterAll(async () => {
    await seedRows();
  });

  it("a later connection sees a row added after an earlier one", async () => {
    const first = await openTerminal();
    const w1 = await first.recv((f) => f.type === "welcome");
    expect((w1.mapData as { features: unknown[] }).features).toHaveLength(3);
    first.close();

    // A row enters D1 by a path that never calls broadcastNewEarthquakes (as
    // the admin ingest route or a manual write would). The cached banner must
    // still refresh — the DO validates its cache against a table fingerprint.
    await seedRows([
      ...SAMPLE_ROWS,
      {
        id: "ffff000000000006",
        utcdatetime: "2026-07-05T00:00:00",
        localdatetime: null,
        lat: 2.0,
        lon: 100.0,
        depth: 10,
        location: "Riau, Indonesia",
        location_original: "Riau",
        magdefault: 4.5,
        magtypedefault: "mb",
        status: "NORMAL",
      },
    ]);

    const second = await openTerminal();
    const w2 = await second.recv((f) => f.type === "welcome");
    expect((w2.mapData as { features: unknown[] }).features).toHaveLength(4);
    second.close();
  });
});
