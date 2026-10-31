import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { env } from '../config/env.js';
import { CATEGORIES, enabledTags } from '../config/categories.js';
import { DHAKA_ENVELOPE } from '../geo/nominatim.js';
import { scanPbf, type Tags } from './pbf.js';
import type { OverpassElement } from './overpassClient.js';

export const EXTRACT_DIR = resolve(env.cacheDir, '..', 'osm-extract');
export const PBF_FILE = resolve(EXTRACT_DIR, 'bangladesh-latest.osm.pbf');
export const LOCAL_ELEMENTS_FILE = resolve(env.cacheDir, 'osm-local', 'dhaka-elements.json');
export const NATIONAL_ELEMENTS_FILE = resolve(env.cacheDir, 'osm-local', 'bangladesh-elements.json');

export type ExtractScope = 'dhaka' | 'bangladesh';

/** When an element matches several categories, the more specific one wins. */
const PRIORITY = ['diagnostics', 'pharmacies', 'hospitals', 'education', 'banking', 'markets', 'transport_hubs', 'hospitality', 'fuel_stations', 'factories', 'gyms', 'startups', 'electronics_retail', 'building_supplies', 'apparel_retail', 'grocery', 'restaurants'];

export interface LocalElement extends OverpassElement {
  categoryKey: string;
  matchedRules: string[];
}

export interface ExtractSummary {
  sourceFile: string;
  sourceBytes: number;
  sourceMd5: string;
  sourceModified: string;
  extractedAt: string;
  envelope: typeof DHAKA_ENVELOPE;
  nationwideMatches: number;
  insideEnvelope: number;
  skippedNoGeometry: number;
  multiCategoryResolved: number;
  byCategory: Record<string, number>;
  byType: Record<string, number>;
}

type Hit = { categoryKey: string; rule: string };

/** key -> value -> category, built only from ENABLED tag rules (wildcards are never enabled). */
function buildMatcher() {
  const map = new Map<string, Map<string, Hit>>();
  for (const c of CATEGORIES) {
    for (const r of enabledTags(c)) {
      if (!r.value) continue;
      (map.get(r.key) ?? map.set(r.key, new Map()).get(r.key)!).set(r.value, { categoryKey: c.key, rule: `${r.key}=${r.value}` });
    }
  }
  return (tags: Tags | null): Hit[] => {
    if (!tags) return [];
    const hits: Hit[] = [];
    for (const [k, vals] of map) {
      const v = tags[k];
      if (v !== undefined) {
        const h = vals.get(v);
        if (h) hits.push(h);
      }
    }
    return hits;
  };
}

function md5Of(file: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash('md5');
    createReadStream(file).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej);
  });
}

function inEnvelope(lat: number, lon: number): boolean {
  const e = DHAKA_ENVELOPE;
  return lat >= e.minLat && lat <= e.maxLat && lon >= e.minLon && lon <= e.maxLon;
}

export async function extractLocal(log: (m: string) => void = console.log, scope: ExtractScope = 'dhaka'): Promise<ExtractSummary> {
  if (!existsSync(PBF_FILE)) throw new Error(`Missing ${PBF_FILE}. Download Geofabrik's bangladesh-latest.osm.pbf first.`);
  const match = buildMatcher();
  const t0 = Date.now();
  const lap = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;

  // Pass 1: matching relations (their member ways give them a location).
  const relations = new Map<number, { tags: Tags; hits: Hit[]; wayIds: number[] }>();
  scanPbf(PBF_FILE, {
    relation: (id, members, tags) => {
      const hits = match(tags);
      if (hits.length) relations.set(id, { tags: tags!, hits, wayIds: members.filter((m) => m.type === 'way').map((m) => m.ref) });
    },
  });
  const memberWays = new Set<number>();
  for (const r of relations.values()) for (const w of r.wayIds) memberWays.add(w);
  log(`pass 1/3 relations: ${relations.size} matching (${lap()})`);

  // Pass 2: matching ways + ways needed by matching relations -> which node ids we must locate.
  const ways = new Map<number, { tags: Tags | null; hits: Hit[]; refs: number[] }>();
  const needed = new Set<number>();
  scanPbf(PBF_FILE, {
    way: (id, refs, tags) => {
      const hits = match(tags);
      if (hits.length || memberWays.has(id)) {
        ways.set(id, { tags, hits, refs });
        for (const n of refs) needed.add(n);
      }
    },
  });
  log(`pass 2/3 ways: ${[...ways.values()].filter((w) => w.hits.length).length} matching, ${needed.size} node locations needed (${lap()})`);

  // Pass 3: node coordinates for needed ids + matching nodes.
  const coords = new Map<number, [number, number]>();
  const nodeHits: { id: number; lat: number; lon: number; tags: Tags; hits: Hit[] }[] = [];
  scanPbf(PBF_FILE, {
    node: (id, lat, lon, tags) => {
      if (needed.has(id)) coords.set(id, [lat, lon]);
      if (tags) {
        const hits = match(tags);
        if (hits.length) nodeHits.push({ id, lat, lon, tags, hits });
      }
    },
  });
  log(`pass 3/3 nodes: ${nodeHits.length} matching, ${coords.size} locations resolved (${lap()})`);

  // Centers (bounding-box centre of the geometry, same meaning as Overpass `out center`).
  const bboxCenter = (refs: number[]): [number, number] | null => {
    let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180, n = 0;
    for (const r of refs) {
      const c = coords.get(r);
      if (!c) continue;
      n++;
      minLat = Math.min(minLat, c[0]); maxLat = Math.max(maxLat, c[0]);
      minLon = Math.min(minLon, c[1]); maxLon = Math.max(maxLon, c[1]);
    }
    return n ? [(minLat + maxLat) / 2, (minLon + maxLon) / 2] : null;
  };

  const out: LocalElement[] = [];
  let nationwide = 0, noGeometry = 0, multi = 0;
  const push = (type: OverpassElement['type'], id: number, center: [number, number] | null, tags: Tags, hits: Hit[]) => {
    nationwide++;
    if (!center) { noGeometry++; return; }
    if (scope === 'dhaka' && !inEnvelope(center[0], center[1])) return;
    const cats = [...new Set(hits.map((h) => h.categoryKey))];
    if (cats.length > 1) multi++;
    const chosen = [...cats].sort((a, b) => PRIORITY.indexOf(a) - PRIORITY.indexOf(b))[0]!;
    const el: LocalElement = {
      type, id, tags, categoryKey: chosen, matchedRules: hits.map((h) => h.rule),
      ...(type === 'node' ? { lat: center[0], lon: center[1] } : { center: { lat: center[0], lon: center[1] } }),
    };
    out.push(el);
  };
  for (const n of nodeHits) push('node', n.id, [n.lat, n.lon], n.tags, n.hits);
  for (const [id, w] of ways) if (w.hits.length && w.tags) push('way', id, bboxCenter(w.refs), w.tags, w.hits);
  for (const [id, r] of relations) {
    const refs = r.wayIds.flatMap((wid) => ways.get(wid)?.refs ?? []);
    push('relation', id, bboxCenter(refs), r.tags, r.hits);
  }

  const byCategory: Record<string, number> = {};
  const byType: Record<string, number> = {};
  for (const e of out) {
    byCategory[e.categoryKey] = (byCategory[e.categoryKey] ?? 0) + 1;
    byType[e.type] = (byType[e.type] ?? 0) + 1;
  }
  const st = statSync(PBF_FILE);
  const summary: ExtractSummary = {
    sourceFile: 'bangladesh-latest.osm.pbf (Geofabrik)', sourceBytes: st.size, sourceMd5: await md5Of(PBF_FILE),
    sourceModified: st.mtime.toISOString(), extractedAt: new Date().toISOString(), envelope: DHAKA_ENVELOPE,
    nationwideMatches: nationwide, insideEnvelope: out.length, skippedNoGeometry: noGeometry, multiCategoryResolved: multi, byCategory, byType,
  };
  const outFile = scope === 'bangladesh' ? NATIONAL_ELEMENTS_FILE : LOCAL_ELEMENTS_FILE;
  mkdirSync(resolve(outFile, '..'), { recursive: true });
  writeFileSync(outFile, JSON.stringify({ summary, elements: out }));
  log(`done in ${lap()}: ${out.length} elements ${scope === 'dhaka' ? 'inside the Dhaka envelope' : 'nationwide'}`);
  return summary;
}
