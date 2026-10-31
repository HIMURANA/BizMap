import { env } from '../config/env.js';

export interface NominatimResult {
  place_id: number;
  osm_type: 'node' | 'way' | 'relation';
  osm_id: number;
  lat: string;
  lon: string;
  /** Nominatim order: [minLat, maxLat, minLon, maxLon] (differs from Overpass!). */
  boundingbox: [string, string, string, string];
  name: string;
  display_name: string;
  class: string;
  type: string;
  addresstype?: string;
}

/** Nominatim usage policy: absolute max 1 request/second, identifying User-Agent. */
const MIN_INTERVAL_MS = 1100;
let lastRequestAt = 0;

async function politeFetch(url: string): Promise<Response> {
  const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
  return fetch(url, { headers: { 'User-Agent': env.userAgent, 'Accept-Language': 'en' } });
}

/** Rough Dhaka metro envelope used ONLY as a sanity guard against wrong geocodes. */
export const DHAKA_ENVELOPE = { minLat: 23.60, maxLat: 23.95, minLon: 90.25, maxLon: 90.55 } as const;

export async function geocodePlace(query: string): Promise<NominatimResult | null> {
  const params = new URLSearchParams({ q: query, format: 'json', limit: '1', countrycodes: 'bd' });
  const response = await politeFetch(`${env.nominatimEndpoint}/search?${params}`);
  if (!response.ok) throw new Error(`Nominatim HTTP ${response.status} for "${query}"`);
  const results = (await response.json()) as NominatimResult[];
  return results[0] ?? null;
}

export type BoundaryLookup =
  | { kind: 'polygon'; result: NominatimResult; geojson: { type: 'Polygon' | 'MultiPolygon'; coordinates: unknown } }
  | { kind: 'point'; result: NominatimResult }
  | { kind: 'none' };

/** Place classes that denote a neighbourhood-level area (not an embassy, shop, road, ...). */
const AREA_PLACE_TYPES = new Set(['suburb', 'neighbourhood', 'quarter', 'borough', 'city_block', 'locality', 'administrative']);

/**
 * Look up a neighbourhood and prefer a REAL polygon. Only accepts results that are inside the Dhaka
 * envelope, are place-type areas, and (for polygons) have a plausible neighbourhood size.
 */
export async function lookupBoundary(name: string, parent?: string): Promise<BoundaryLookup> {
  const params = new URLSearchParams({
    q: parent ? `${name}, ${parent}, Dhaka` : `${name}, Dhaka`, format: 'json', limit: '8', countrycodes: 'bd',
    polygon_geojson: '1', polygon_threshold: '0.00005',
  });
  const response = await politeFetch(`${env.nominatimEndpoint}/search?${params}`);
  if (!response.ok) throw new Error(`Nominatim HTTP ${response.status} for "${name}"`);
  const results = (await response.json()) as (NominatimResult & { geojson?: { type: string; coordinates: unknown } })[];

  const inDhaka = results.filter((r) => {
    const lat = Number(r.lat), lon = Number(r.lon), e = DHAKA_ENVELOPE;
    return r.class === 'place' && AREA_PLACE_TYPES.has(r.type) && lat >= e.minLat && lat <= e.maxLat && lon >= e.minLon && lon <= e.maxLon;
  });

  for (const r of inDhaka) {
    const g = r.geojson;
    if (g && (g.type === 'Polygon' || g.type === 'MultiPolygon') && bboxProblem(parseBoundingBox(r.boundingbox)) === null) {
      return { kind: 'polygon', result: r, geojson: g as { type: 'Polygon' | 'MultiPolygon'; coordinates: unknown } };
    }
  }
  const point = inDhaka.find((r) => r.osm_type === 'node');
  return point ? { kind: 'point', result: point } : { kind: 'none' };
}

export interface RelationGeometry { osm_id: number; geojson: { type: string; coordinates: unknown } | null }

/** Batched /lookup of OSM relations (max 50 per request, per Nominatim's documented limit) with simplified polygons. */
export async function lookupRelations(ids: number[]): Promise<RelationGeometry[]> {
  if (ids.length === 0) return [];
  if (ids.length > 50) throw new Error('Nominatim lookup accepts at most 50 ids per request');
  const params = new URLSearchParams({ osm_ids: ids.map((i) => `R${i}`).join(','), format: 'json', polygon_geojson: '1', polygon_threshold: '0.0005' });
  const response = await politeFetch(`${env.nominatimEndpoint}/lookup?${params}`);
  if (!response.ok) throw new Error(`Nominatim lookup HTTP ${response.status}`);
  const rows = (await response.json()) as { osm_type: string; osm_id: number; geojson?: { type: string; coordinates: unknown } }[];
  return rows.filter((r) => r.osm_type === 'relation').map((r) => ({ osm_id: r.osm_id, geojson: r.geojson ?? null }));
}

/** Convert Nominatim bbox to Overpass order [minLat, minLon, maxLat, maxLon]. */
export function parseBoundingBox(bb: NominatimResult['boundingbox']): [number, number, number, number] {
  const [minLat, maxLat, minLon, maxLon] = bb.map(Number) as [number, number, number, number];
  return [minLat, minLon, maxLat, maxLon];
}

/**
 * Reject geocodes that fall outside Dhaka or are implausibly large/small for a neighbourhood.
 * Returns a reason string when the box should NOT be used, otherwise null.
 */
export function bboxProblem(bbox: [number, number, number, number]): string | null {
  const [minLat, minLon, maxLat, maxLon] = bbox;
  const e = DHAKA_ENVELOPE;
  if (minLat < e.minLat || maxLat > e.maxLat || minLon < e.minLon || maxLon > e.maxLon) {
    return 'bounding box extends outside the Dhaka metro envelope';
  }
  const latSpan = maxLat - minLat;
  const lonSpan = maxLon - minLon;
  if (latSpan > 0.12 || lonSpan > 0.12) return `bounding box too large for a neighbourhood (${latSpan.toFixed(3)}° x ${lonSpan.toFixed(3)}°)`;
  if (latSpan < 0.002 || lonSpan < 0.002) return 'bounding box is a point/too small (geocoded to a single node, not an area)';
  return null;
}
