-- migrations/0001_init.sql
-- Core table for earthquake records ingested from api.data.gov.my.
--
-- The upstream API exposes no native id field, so `id` is a truncated SHA-256
-- of `utcdatetime|lat|lon` (see computeId() in src/lib/ingest.ts). That makes
-- ingestion idempotent: re-fetching the same feed produces the same ids, and
-- `INSERT OR IGNORE` silently drops duplicates.
--
-- We deliberately store only the structured fields the app needs (no raw-JSON
-- blob column) to keep this indefinitely-growing table small.
CREATE TABLE IF NOT EXISTS earthquakes (
  id                TEXT    PRIMARY KEY,           -- truncated SHA-256(utcdatetime|lat|lon)
  utcdatetime       TEXT    NOT NULL,              -- ISO 8601, e.g. "2026-07-03T04:04:49"
  localdatetime     TEXT,                          -- ISO 8601 in local (Malaysia) time
  lat               REAL    NOT NULL,
  lon               REAL    NOT NULL,
  depth             REAL,                          -- km
  location          TEXT,                          -- Malay place name (as displayed)
  location_original TEXT,                          -- English/original place name
  magdefault        REAL,                          -- magnitude
  magtypedefault    TEXT,                          -- magnitude type, e.g. "mb"
  status            TEXT                            -- e.g. "NORMAL"
);

-- Indexes matching the Phase 3+ query patterns: recency ordering, magnitude
-- filters, and location search.
CREATE INDEX IF NOT EXISTS idx_earthquakes_utcdatetime ON earthquakes(utcdatetime);
CREATE INDEX IF NOT EXISTS idx_earthquakes_magdefault  ON earthquakes(magdefault);
CREATE INDEX IF NOT EXISTS idx_earthquakes_location    ON earthquakes(location);
