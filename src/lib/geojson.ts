/**
 * GeoJSON conversion for the Earthquake CLI map panel (Phase 6).
 *
 * Command results carry a `mapData` FeatureCollection alongside their ANSI text
 * so the browser's MapLibre map (public/map.js) can plot the same rows the
 * terminal just listed. Each earthquake becomes a Point feature whose properties
 * drive the circle's size and colour (magnitude) and its popup (location/time).
 */

import type { EarthquakeRow } from "../types";

/** Properties attached to each map point; consumed by public/map.js. */
export interface EarthquakeFeatureProps {
  id: string;
  mag: number | null;
  depth: number | null;
  location: string;
  time: string;
}

export interface EarthquakePointFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: EarthquakeFeatureProps;
}

export interface EarthquakeFeatureCollection {
  type: "FeatureCollection";
  features: EarthquakePointFeature[];
}

/**
 * Convert D1 rows into a GeoJSON FeatureCollection. Rows without finite
 * coordinates are skipped (a point at 0,0 would misplace them in the ocean).
 */
export function rowsToGeoJSON(
  rows: EarthquakeRow[],
): EarthquakeFeatureCollection {
  const features: EarthquakePointFeature[] = [];
  for (const row of rows) {
    if (!Number.isFinite(row.lat) || !Number.isFinite(row.lon)) continue;
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [row.lon, row.lat] },
      properties: {
        id: row.id,
        mag: row.magdefault,
        depth: row.depth,
        location: row.location ?? row.location_original ?? "Unknown",
        time: row.utcdatetime,
      },
    });
  }
  return { type: "FeatureCollection", features };
}
