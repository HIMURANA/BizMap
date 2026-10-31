import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { env } from '../config/env.js';
import { prepare, transaction, type Param } from '../db/db.js';
import { scanPbf } from '../osm/pbf.js';
import { PBF_FILE } from '../osm/extractLocal.js';
import { geoBBox, geoContains, type GeoPolygon } from './boundaries.js';
import { lookupRelations } from './nominatim.js';

/**
 * Official administrative areas from OpenStreetMap relations:
 *   division = admin_level 4 with ISO 3166-2 BD-*      (8 expected)
 *   district = admin_level 5 with ISO 3166-2 BD-*      (64 expected)
 *   upazila  = admin_level 6 named Upazila/Thana/Subdistrict, KEPT ONLY if its geometry lies inside a
 *              Bangladeshi district (this drops Indian/Myanmar look-alikes present in the regional extract).
 * Parent links come from geometry, because the mapped relation hierarchy is incomplete (only 25 of 64
 * districts are linked under their divisions in OSM).
 */

type Level = 'division' | 'district' | 'upazila';
interface Rel { id: number; level: Level; name: string; nameBn: string | null; iso: string | null }

const UPAZILA_NAME = /upazil|thana|subdistrict|sbdistrict/i;

export function collectAdminRelations(): Rel[] {
  const out: Rel[] = [];
  scanPbf(PBF_FILE, {
    relation: (id, _m, tags) => {
      if (!tags || tags.boundary !== 'administrative') return;
      const name = tags['name:en'] ?? tags.name ?? '';
      if (!name) return;
      const iso = tags['ISO3166-2'] ?? null;
      const base = { id, name, nameBn: tags['name:bn'] ?? null, iso };
      if (tags.admin_level === '4' && iso?.startsWith('BD-')) out.push({ ...base, level: 'division' });
      else if (tags.admin_level === '5' && iso?.startsWith('BD-')) out.push({ ...base, level: 'district' });
      else if (tags.admin_level === '6' && UPAZILA_NAME.test(name)) out.push({ ...base, level: 'upazila' });
    },
  });
  return out;
}

async function geometriesFor(ids: number[], log: (m: string) => void): Promise<Map<number, GeoPolygon>> {
  const dir = resolve(env.cacheDir, 'nominatim-admin');
  mkdirSync(dir, { recursive: true });
  const result = new Map<number, GeoPolygon>();
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const file = resolve(dir, `${createHash('sha1').update(batch.join(',')).digest('hex').slice(0, 16)}.json`);
    let rows: { osm_id: number; geojson: { type: string; coordinates: unknown } | null }[];
    if (existsSync(file)) rows = JSON.parse(readFileSync(file, 'utf-8'));
    else {
      rows = await lookupRelations(batch);
      writeFileSync(file, JSON.stringify(rows));
    }
    for (const r of rows) {
      if (r.geojson && (r.geojson.type === 'Polygon' || r.geojson.type === 'MultiPolygon')) result.set(r.osm_id, r.geojson as GeoPolygon);
    }
    log(`  geometries ${Math.min(i + 50, ids.length)}/${ids.length}`);
  }
  return result;
}

/** A few points that represent a polygon: bbox centre plus sampled boundary vertices. */
function samplePoints(geo: GeoPolygon): [number, number][] {
  const [a, b, c, d] = geoBBox(geo);
  const pts: [number, number][] = [[(a + c) / 2, (b + d) / 2]];
  const ring = geo.type === 'Polygon' ? geo.coordinates[0]! : geo.coordinates[0]![0]!;
  const step = Math.max(1, Math.floor(ring.length / 12));
  for (let i = 0; i < ring.length; i += step) pts.push([ring[i]![1], ring[i]![0]]);
  return pts;
}

function parentOf(geo: GeoPolygon, candidates: { id: number; geo: GeoPolygon }[]): number | null {
  const pts = samplePoints(geo);
  let best: { id: number; votes: number } | null = null;
  for (const c of candidates) {
    const votes = pts.filter(([lat, lon]) => geoContains(c.geo, lat, lon)).length;
    if (votes > 0 && (!best || votes > best.votes)) best = { id: c.id, votes };
  }
  return best?.id ?? null;
}

export interface AdminSummary { divisions: number; districts: number; upazilas: number; upazilasDropped: number; missingGeometry: number }

export async function resolveAdmin(log: (m: string) => void = console.log): Promise<AdminSummary> {
  const rels = collectAdminRelations();
  const by = (l: Level) => rels.filter((r) => r.level === l);
  log(`Found in OSM: ${by('division').length} divisions, ${by('district').length} districts, ${by('upazila').length} upazila-like candidates`);
  const geos = await geometriesFor(rels.map((r) => r.id), log);

  const withGeo = (l: Level) => by(l).filter((r) => geos.has(r.id)).map((r) => ({ id: r.id, geo: geos.get(r.id)!, rel: r }));
  const divs = withGeo('division'), dists = withGeo('district'), upas = withGeo('upazila');
  const missingGeometry = rels.length - divs.length - dists.length - upas.length;

  const rows: { rel: Rel; geo: GeoPolygon; parent: number | null }[] = [];
  for (const d of divs) rows.push({ rel: d.rel, geo: d.geo, parent: null });
  for (const d of dists) rows.push({ rel: d.rel, geo: d.geo, parent: parentOf(d.geo, divs) });
  let dropped = 0;
  for (const u of upas) {
    const parent = parentOf(u.geo, dists);
    if (parent === null) { dropped++; continue; } // not inside any Bangladeshi district
    rows.push({ rel: u.rel, geo: u.geo, parent });
  }

  const ins = prepare(
    `INSERT OR REPLACE INTO admin_areas (osm_relation_id, level, name, name_bn, iso_code, parent_id, min_lat, min_lon, max_lat, max_lon, boundary_geojson, population, population_source, population_year, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT population FROM admin_areas WHERE osm_relation_id=?), (SELECT population_source FROM admin_areas WHERE osm_relation_id=?), (SELECT population_year FROM admin_areas WHERE osm_relation_id=?), ?)`,
  );
  transaction(() => {
    for (const r of rows) {
      const [a, b, c, d] = geoBBox(r.geo);
      ins.run(r.rel.id, r.rel.level, r.rel.name, r.rel.nameBn, r.rel.iso, r.parent as Param, a, b, c, d, JSON.stringify(r.geo), r.rel.id, r.rel.id, r.rel.id, new Date().toISOString());
    }
  });
  return {
    divisions: divs.length, districts: dists.length, upazilas: upas.length - dropped, upazilasDropped: dropped, missingGeometry,
  };
}

interface Loaded { id: number; level: Level; name: string; parent: number | null; geo: GeoPolygon; bbox: [number, number, number, number] }

function loadAdmin(): Loaded[] {
  return prepare<{ osm_relation_id: number; level: Level; name: string; parent_id: number | null; boundary_geojson: string }>(
    `SELECT osm_relation_id, level, name, parent_id, boundary_geojson FROM admin_areas WHERE boundary_geojson IS NOT NULL`,
  ).all().map((r) => {
    const geo = JSON.parse(r.boundary_geojson) as GeoPolygon;
    return { id: r.osm_relation_id, level: r.level, name: r.name, parent: r.parent_id, geo, bbox: geoBBox(geo) };
  });
}

const inBox = (b: [number, number, number, number], lat: number, lon: number) => lat >= b[0] && lat <= b[2] && lon >= b[1] && lon <= b[3];

export interface AssignSummary { total: number; inDistrict: number; inUpazila: number; outsideBangladesh: number }

/** Assigns every stored location to its division / district / upazila. Points in no district polygon are counted, not forced. */
export function assignAdmin(): AssignSummary {
  const all = loadAdmin();
  const divisions = new Map(all.filter((a) => a.level === 'division').map((a) => [a.id, a]));
  const districts = all.filter((a) => a.level === 'district');
  const upazilasByDistrict = new Map<number, Loaded[]>();
  for (const u of all.filter((a) => a.level === 'upazila')) (upazilasByDistrict.get(u.parent!) ?? upazilasByDistrict.set(u.parent!, []).get(u.parent!)!).push(u);

  const locs = prepare<{ location_id: number; latitude: number | null; longitude: number | null }>(`SELECT location_id, latitude, longitude FROM business_locations`).all();
  const upd = prepare(`UPDATE business_locations SET admin_division=?, admin_district=?, admin_upazila=?, district=? WHERE location_id=?`);
  const sum: AssignSummary = { total: locs.length, inDistrict: 0, inUpazila: 0, outsideBangladesh: 0 };

  transaction(() => {
    for (const l of locs) {
      if (l.latitude === null || l.longitude === null) { upd.run(null, null, null, null, l.location_id); continue; }
      const d = districts.find((x) => inBox(x.bbox, l.latitude!, l.longitude!) && geoContains(x.geo, l.latitude!, l.longitude!));
      if (!d) { upd.run(null, null, null, null, l.location_id); sum.outsideBangladesh++; continue; }
      sum.inDistrict++;
      const u = (upazilasByDistrict.get(d.id) ?? []).find((x) => inBox(x.bbox, l.latitude!, l.longitude!) && geoContains(x.geo, l.latitude!, l.longitude!));
      if (u) sum.inUpazila++;
      const div = d.parent !== null ? divisions.get(d.parent) : undefined;
      upd.run(div?.name ?? null, d.name, u?.name ?? null, d.name, l.location_id);
    }
  });
  // Border-area points that fall outside the (simplified) district polygons are held for review, never forced into a district.
  prepare(`UPDATE businesses SET record_status='needs_review',
      classification_note = CASE WHEN classification_note IS NULL THEN 'location is outside the simplified Bangladesh district boundaries (within ~5 km of the border): border-area record or outside Bangladesh'
        ELSE classification_note || '; location outside the simplified Bangladesh district boundaries' END
    WHERE record_status != 'needs_review'
      AND business_id IN (SELECT business_id FROM business_locations WHERE admin_district IS NULL AND latitude IS NOT NULL)`).run();
  return sum;
}
