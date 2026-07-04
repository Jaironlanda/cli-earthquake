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
import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { openTerminal, seedRows } from "./helpers";

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
