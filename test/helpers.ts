/**
 * Shared test fixtures and helpers.
 *
 * `SAMPLE_ROWS` / `SAMPLE_API_RECORDS` are deterministic earthquake records used
 * across the suite; `seedRows` resets the table to a known set; `openTerminal`
 * wraps the `/ws` WebSocket into an async, message-at-a-time reader.
 */
import { SELF, env } from "cloudflare:test";
import type { EarthquakeApiRecord, EarthquakeRow } from "../src/types";

/** Three persisted rows spanning the magnitude bands used by list/trend/search. */
export const SAMPLE_ROWS: EarthquakeRow[] = [
  {
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
  },
  {
    id: "bbbb000000000002",
    utcdatetime: "2026-06-15T12:30:00",
    localdatetime: "2026-06-15T20:30:00",
    lat: 3.1,
    lon: 101.6,
    depth: 33,
    location: "Selangor, Malaysia",
    location_original: "Selangor",
    magdefault: 4.1,
    magtypedefault: "mb",
    status: "NORMAL",
  },
  {
    id: "cccc000000000003",
    utcdatetime: "2026-07-01T08:00:00",
    localdatetime: "2026-07-01T16:00:00",
    lat: -6.2,
    lon: 106.8,
    depth: 15,
    location: "Jakarta, Indonesia",
    location_original: "Jakarta",
    magdefault: 5.5,
    magtypedefault: "mb",
    status: "NORMAL",
  },
];

/** Two raw API records (superset shape) for exercising the ingest pipeline. */
export const SAMPLE_API_RECORDS: EarthquakeApiRecord[] = [
  {
    utcdatetime: "2026-07-02T09:15:00",
    localdatetime: "2026-07-02T17:15:00",
    lat: 4.2,
    lon: 96.1,
    depth: 25,
    location: "Sumatra, Indonesia",
    location_original: "Sumatra",
    n_distancemas: "",
    n_distancerest: "",
    nbm_distancemas: "",
    nbm_distancerest: "",
    magdefault: 5.8,
    magtypedefault: "mb",
    status: "NORMAL",
    visible: true,
    lat_vector: "",
    lon_vector: "",
  },
  {
    utcdatetime: "2026-07-02T11:45:00",
    localdatetime: "2026-07-02T19:45:00",
    lat: 1.5,
    lon: 110.3,
    depth: 8,
    location: "Sarawak, Malaysia",
    location_original: "Sarawak",
    n_distancemas: "",
    n_distancerest: "",
    nbm_distancemas: "",
    nbm_distancerest: "",
    magdefault: 3.9,
    magtypedefault: "mb",
    status: "NORMAL",
    visible: true,
    lat_vector: "",
    lon_vector: "",
  },
];

/** Strip ANSI SGR escape codes so assertions can match plain text spans that
 *  the renderers colour piecewise (e.g. a coloured label next to a plain id). */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

const INSERT_SQL = `INSERT OR REPLACE INTO earthquakes
   (id, utcdatetime, localdatetime, lat, lon, depth,
    location, location_original, magdefault, magtypedefault, status)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** Reset the `earthquakes` table to exactly `rows` (defaults to SAMPLE_ROWS). */
export async function seedRows(rows: EarthquakeRow[] = SAMPLE_ROWS): Promise<void> {
  await env.DB.prepare("DELETE FROM earthquakes").run();
  if (rows.length === 0) return;
  const insert = env.DB.prepare(INSERT_SQL);
  await env.DB.batch(
    rows.map((r) =>
      insert.bind(
        r.id,
        r.utcdatetime,
        r.localdatetime,
        r.lat,
        r.lon,
        r.depth,
        r.location,
        r.location_original,
        r.magdefault,
        r.magtypedefault,
        r.status,
      ),
    ),
  );
}

/** A parsed server → client frame (`welcome` / `output` / `download` / …). */
export interface ServerFrame {
  type: string;
  text?: string;
  mapData?: unknown;
  filename?: string;
  mime?: string;
  content?: string;
  [key: string]: unknown;
}

/** A live terminal connection with an async, predicate-based frame reader. */
export interface Terminal {
  /** Send a raw command line (wrapped in the `{type:"input"}` envelope). */
  send(line: string): void;
  /** Resolve with the next frame matching `predicate` (scans buffered frames first). */
  recv(predicate?: (frame: ServerFrame) => boolean): Promise<ServerFrame>;
  close(): void;
}

/**
 * Open the `/ws` terminal against the in-process Worker and return a helper that
 * buffers every inbound frame, so `recv()` never races the socket regardless of
 * when frames arrive (e.g. the unsolicited `welcome`).
 */
export async function openTerminal(): Promise<Terminal> {
  const resp = await SELF.fetch("https://example.com/ws", {
    headers: { Upgrade: "websocket" },
  });
  const ws = resp.webSocket;
  if (!ws) throw new Error(`Expected a WebSocket upgrade, got status ${resp.status}`);
  ws.accept();

  const buffered: ServerFrame[] = [];
  const waiters: Array<{
    predicate: (frame: ServerFrame) => boolean;
    resolve: (frame: ServerFrame) => void;
  }> = [];

  ws.addEventListener("message", (event) => {
    const frame = JSON.parse(event.data as string) as ServerFrame;
    const idx = waiters.findIndex((w) => w.predicate(frame));
    if (idx !== -1) {
      const [waiter] = waiters.splice(idx, 1);
      waiter.resolve(frame);
    } else {
      buffered.push(frame);
    }
  });

  return {
    send(line: string) {
      ws.send(JSON.stringify({ type: "input", line }));
    },
    recv(predicate = () => true) {
      const idx = buffered.findIndex(predicate);
      if (idx !== -1) return Promise.resolve(buffered.splice(idx, 1)[0]);
      return new Promise<ServerFrame>((resolve) => waiters.push({ predicate, resolve }));
    },
    close() {
      ws.close();
    },
  };
}
