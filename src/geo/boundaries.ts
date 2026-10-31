import { prepare } from '../db/db.js';
import type { BBox } from '../osm/queryBuilder.js';
import { DHAKA_ENVELOPE } from './nominatim.js';

/**
 * How an area's extent was established. Recorded per area and per business assignment so that
 * approximate results are never mistaken for verified ones.
 *   osm_polygon  - real OSM polygon (way/relation) returned by Nominatim
 *   point_radius - OSM only has a single point for this place; a fixed radius is used (APPROXIMATE)
 *   nearest_center - point sits inside an OSM polygon AND within a point-only area's radius; the
 *                    two overlap, so the nearest area center wins (APPROXIMATE)
 *   none         - no usable boundary; businesses cannot be assigned to this area
 */
export type BoundaryMethod = 'osm_polygon' | 'point_radius' | 'nearest_center' | 'none';

/** Radius used for point-only areas. Deliberately a stated approximation, not a boundary. */
export const POINT_RADIUS_KM = 1.0;

type Ring = [number, number][]; // [lon, lat]
export type GeoPolygon = { type: 'Polygon'; coordinates: Ring[] } | { type: 'MultiPolygon'; coordinates: Ring[][] };

function ringContains(ring: Ring, lon: number, lat: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function polygonContains(rings: Ring[], lon: number, lat: number): boolean {
  const [outer, ...holes] = rings;
  if (!outer || !ringContains(outer, lon, lat)) return false;
  return !holes.some((h) => ringContains(h, lon, lat));
}

export function geoContains(geo: GeoPolygon, lat: number, lon: number): boolean {
  return geo.type === 'Polygon'
    ? polygonContains(geo.coordinates, lon, lat)
    : geo.coordinates.some((p) => polygonContains(p, lon, lat));
}

export function geoBBox(geo: GeoPolygon): BBox {
  const rings = geo.type === 'Polygon' ? geo.coordinates : geo.coordinates.flat();
  let minLat = 90, minLon = 180, maxLat = -90, maxLon = -180;
  for (const ring of rings) {
    for (const [lon, lat] of ring) {
      minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
      minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
    }
  }
  return [minLat, minLon, maxLat, maxLon];
}

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

/** BBox of a circle of POINT_RADIUS_KM around a point, [minLat, minLon, maxLat, maxLon]. */
export function radiusBBox(lat: number, lon: number, km = POINT_RADIUS_KM): BBox {
  const dLat = km / 111.32;
  const dLon = km / (111.32 * Math.cos((lat * Math.PI) / 180));
  return [lat - dLat, lon - dLon, lat + dLat, lon + dLon];
}

interface BoundaryRow {
  name: string;
  city_corporation: string;
  center_lat: number | null;
  center_lon: number | null;
  boundary_geojson: string | null;
  boundary_method: BoundaryMethod | null;
}

export interface LoadedBoundary {
  name: string;
  cityCorporation: string;
  method: Exclude<BoundaryMethod, 'none'>;
  geo: GeoPolygon | null;
  center: [number, number] | null;
  bboxArea: number;
}

export function loadBoundaries(): LoadedBoundary[] {
  const rows = prepare<BoundaryRow>(
    `SELECT name, city_corporation, center_lat, center_lon, boundary_geojson, boundary_method
     FROM discovery_areas WHERE boundary_method IN ('osm_polygon','point_radius')`,
  ).all();
  const out: LoadedBoundary[] = [];
  for (const r of rows) {
    const center: [number, number] | null = r.center_lat !== null && r.center_lon !== null ? [r.center_lat, r.center_lon] : null;
    if (r.boundary_method === 'osm_polygon' && r.boundary_geojson) {
      const geo = JSON.parse(r.boundary_geojson) as GeoPolygon;
      const [a, b, c, d] = geoBBox(geo);
      out.push({ name: r.name, cityCorporation: r.city_corporation, method: 'osm_polygon', geo, center, bboxArea: (c - a) * (d - b) });
    } else if (r.boundary_method === 'point_radius' && center) {
      out.push({ name: r.name, cityCorporation: r.city_corporation, method: 'point_radius', geo: null, center, bboxArea: 0 });
    }
  }
  return out;
}

export interface Assignment {
  area: string | null;
  cityCorporation: string | null;
  method: BoundaryMethod;
}

/**
 * Assign a coordinate to an area.
 *  1. Collect the real polygons that contain the point and the point-only areas whose radius covers it.
 *  2. Polygons only  -> the smallest containing polygon ('osm_polygon').
 *  3. Point areas only -> the nearest one ('point_radius').
 *  4. Both (OSM polygons are often overbroad, e.g. Gulshan swallows Banani's point) -> the nearest
 *     area center among all candidates ('nearest_center', approximate).
 *  5. Neither -> unassigned. The business stays a Dhaka record; it is never forced into a neighbourhood.
 */
export function assignArea(lat: number, lon: number, boundaries: LoadedBoundary[]): Assignment {
  const polys = boundaries
    .filter((b) => b.method === 'osm_polygon' && b.geo && geoContains(b.geo, lat, lon))
    .sort((a, b) => a.bboxArea - b.bboxArea);

  const points: { b: LoadedBoundary; km: number }[] = [];
  for (const b of boundaries) {
    if (b.method !== 'point_radius' || !b.center) continue;
    const km = haversineKm(lat, lon, b.center[0], b.center[1]);
    if (km <= POINT_RADIUS_KM) points.push({ b, km });
  }
  points.sort((x, y) => x.km - y.km);

  const hit = (b: LoadedBoundary, method: BoundaryMethod): Assignment => ({ area: b.name, cityCorporation: b.cityCorporation, method });

  if (polys[0] && points.length === 0) return hit(polys[0], 'osm_polygon');
  if (!polys[0] && points[0]) return hit(points[0].b, 'point_radius');
  if (polys[0] && points[0]) {
    const cands = [...points.map((p) => ({ b: p.b, km: p.km })),
      ...polys.filter((b) => b.center).map((b) => ({ b, km: haversineKm(lat, lon, b.center![0], b.center![1]) }))];
    cands.sort((x, y) => x.km - y.km);
    return hit(cands[0]!.b, 'nearest_center');
  }
  return { area: null, cityCorporation: null, method: 'none' };
}

export type DhakaScope = 'dhaka_metropolitan' | 'greater_dhaka' | 'outside_dhaka';

/** The real OSM "Dhaka Metropolitan" polygon, if resolved (run: resolve-city). */
export function loadCityPolygon(): GeoPolygon | null {
  const r = prepare<{ boundary_geojson: string | null }>(`SELECT boundary_geojson FROM discovery_areas WHERE boundary_method='city_polygon' LIMIT 1`).get();
  return r?.boundary_geojson ? (JSON.parse(r.boundary_geojson) as GeoPolygon) : null;
}

/** Inside the metropolitan polygon -> Dhaka city; elsewhere in the Dhaka envelope -> Greater Dhaka (kept separate, per spec). */
export function scopeOf(lat: number, lon: number, city: GeoPolygon): DhakaScope {
  if (geoContains(city, lat, lon)) return 'dhaka_metropolitan';
  const e = DHAKA_ENVELOPE;
  const nearDhaka = lat >= e.minLat && lat <= e.maxLat && lon >= e.minLon && lon <= e.maxLon;
  return nearDhaka ? 'greater_dhaka' : 'outside_dhaka';
}
