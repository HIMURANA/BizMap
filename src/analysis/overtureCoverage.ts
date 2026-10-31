import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { env } from '../config/env.js';
import { prepare } from '../db/db.js';
import { geoBBox, geoContains, type GeoPolygon } from '../geo/boundaries.js';
import { distance, norm, parseCsv } from '../geo/population.js';

/**
 * Coverage test: how much would Overture Places add to the OpenStreetMap data we already hold?
 *  1. keep only Overture places that lie inside a real Bangladeshi district polygon (drops India/Myanmar);
 *  2. map Overture taxonomy -> our categories (rule-based, printed so it can be reviewed);
 *  3. a place counts as ALREADY COVERED if one of our OSM records has a similar name within 100 m;
 *  4. report "Overture-only" counts at two confidence levels, plus contact completeness for each source.
 * Nothing is imported into the main database by this test.
 */

const MAP: [string, RegExp][] = [
  ['diagnostics', /laborator|diagnostic|radiolog|imaging/],
  ['pharmacies', /^(pharmacy|drugstore)$|pharmac/],
  ['hospitals', /^(hospital|medical_center|clinic|urgent_care|emergency_room|dentist|dental)/],
  ['education', /school|college|university|kindergarten|preschool|^education$|educational_service|coaching|tutor/],
  ['banking', /^(bank|bank_or_credit_union|atm|credit_union)$|^atm/],
  ['markets', /shopping_mall|shopping_center|marketplace|bazaar|^market$/],
  ['transport_hubs', /bus_station|train_station|railway_station|ferry|transit_station/],
  ['hospitality', /^(hotel|lodging|guest_house|hostel|resort|bed_and_breakfast|motel)$/],
  ['fuel_stations', /gas_station|fuel/],
  ['gyms', /^(gym|fitness|yoga|pilates|sports_club|martial_arts)/],
  ['startups', /software|information_technology|it_service|web_design|app_development|data_processing|computer_programming|web_hosting|digital_marketing/],
  ['garments', /garment|apparel_manufactur|textile|clothing_manufactur|knit|sewing|spinning/],
  ['factories', /manufactur|factory|industrial/],
  ['electronics_retail', /electronics_store|mobile_phone_store|computer_store|mobile_phone/],
  ['building_supplies', /furniture_store|hardware_store|home_improvement|building_material/],
  ['apparel_retail', /clothing|shoe|jewelry|tailor|fabric|boutique/],
  ['grocery', /grocery|supermarket|convenience_store|butcher|seafood|fruits|vegetable|dairy/],
  ['restaurants', /restaurant|^cafe$|bakery|coffee|ice_cream|dessert|food_court|fast_food|diner|pizza|burger/],
  ['online_businesses', /online|ecommerce|e_commerce/],
];
const categoryOf = (cat: string): string | null => { for (const [k, re] of MAP) if (re.test(cat)) return k; return null; };

interface Ov { id: string; name: string; cat: string; conf: number; lat: number; lon: number; phone: boolean; web: boolean; social: boolean; email: boolean; ours: string | null; dhaka: boolean }

const cellKey = (lat: number, lon: number) => `${Math.floor(lat * 1000)}:${Math.floor(lon * 1000)}`; // ~110 m cells

function similar(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const min = Math.min(a.length, b.length);
  if (min >= 5 && (a.includes(b) || b.includes(a))) return true;
  return min >= 4 && distance(a, b) <= Math.max(1, Math.floor(min * 0.2));
}

export interface CoverageRow {
  category: string; osmRecords: number; overtureInBd: number; overtureConf50: number; alreadyInOsm: number;
  overtureOnlyConf50: number; overtureOnlyConf80: number; upliftPct: number | null;
  ovPctPhone: number; ovPctWebsite: number; ovPctEmail: number; osmPctPhone: number;
}

export function runOvertureCoverage(log: (m: string) => void = console.log) {
  const t0 = Date.now();
  const lap = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;

  // districts (real polygons) for filtering to Bangladesh and tagging Dhaka
  const districts = prepare<{ name: string; boundary_geojson: string }>(`SELECT name, boundary_geojson FROM admin_areas WHERE level='district'`).all()
    .map((d) => { const geo = JSON.parse(d.boundary_geojson) as GeoPolygon; return { name: d.name, geo, bbox: geoBBox(geo) }; });
  const metro = prepare<{ boundary_geojson: string }>(`SELECT boundary_geojson FROM discovery_areas WHERE boundary_method='city_polygon'`).get();
  const metroGeo = metro ? (JSON.parse(metro.boundary_geojson) as GeoPolygon) : null;

  const rows = parseCsv(readFileSync(resolve(process.cwd(), 'data/overture/bd_places.csv'), 'utf-8'));
  log(`read ${rows.length} Overture rows (${lap()})`);

  const ov: Ov[] = [];
  let outside = 0;
  for (const r of rows) {
    const lat = Number(r.lat), lon = Number(r.lon);
    const inBd = districts.some((d) => lat >= d.bbox[0] && lat <= d.bbox[2] && lon >= d.bbox[1] && lon <= d.bbox[3] && geoContains(d.geo, lat, lon));
    if (!inBd) { outside++; continue; }
    ov.push({
      id: r.id!, name: r.name!, cat: r.cat!, conf: Number(r.confidence), lat, lon,
      phone: r.has_phone === '1', web: r.has_website === '1', social: r.has_social === '1', email: r.has_email === '1',
      ours: categoryOf(r.cat!), dhaka: metroGeo ? geoContains(metroGeo, lat, lon) : false,
    });
  }
  log(`inside Bangladesh district polygons: ${ov.length}; dropped as outside: ${outside} (${lap()})`);

  // OSM records we hold, indexed by ~110 m grid cell
  const osm = prepare<{ name: string; latitude: number; longitude: number; category_id: string; status: string; has_phone: number }>(
    `SELECT b.name, l.latitude, l.longitude, b.category_id, b.record_status status,
       EXISTS(SELECT 1 FROM business_contacts c WHERE c.business_id=b.business_id AND c.contact_type='phone') AS has_phone
     FROM businesses b JOIN business_locations l USING(business_id) WHERE l.latitude IS NOT NULL AND b.business_id LIKE 'osm:%'`,
  ).all();
  const grid = new Map<string, { n: string; lat: number; lon: number }[]>();
  for (const o of osm) {
    const k = cellKey(o.latitude, o.longitude);
    (grid.get(k) ?? grid.set(k, []).get(k)!).push({ n: norm(o.name), lat: o.latitude, lon: o.longitude });
  }
  const covered = (x: Ov): boolean => {
    const n = norm(x.name);
    const ci = Math.floor(x.lat * 1000), cj = Math.floor(x.lon * 1000);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      for (const o of grid.get(`${ci + di}:${cj + dj}`) ?? []) {
        const km = Math.hypot((o.lat - x.lat) * 111.32, (o.lon - x.lon) * 111.32 * Math.cos((x.lat * Math.PI) / 180));
        if (km <= 0.1 && similar(n, o.n)) return true;
      }
    }
    return false;
  };

  const flagged = new Map<string, boolean>();
  for (const x of ov) flagged.set(x.id, covered(x));
  log(`matched against ${osm.length} OSM records (${lap()})`);

  const cats = [...new Set([...MAP.map(([k]) => k)])];
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  const out: CoverageRow[] = [];
  const osmBy = (c: string) => osm.filter((o) => o.category_id === c && o.status !== 'needs_review');
  for (const c of cats) {
    const all = ov.filter((x) => x.ours === c);
    const c50 = all.filter((x) => x.conf >= 0.5);
    const only50 = c50.filter((x) => !flagged.get(x.id));
    const only80 = all.filter((x) => x.conf >= 0.8 && !flagged.get(x.id));
    const o = osmBy(c);
    out.push({
      category: c, osmRecords: o.length, overtureInBd: all.length, overtureConf50: c50.length, alreadyInOsm: c50.length - only50.length,
      overtureOnlyConf50: only50.length, overtureOnlyConf80: only80.length, upliftPct: o.length ? pct(only50.length, o.length) : null,
      ovPctPhone: pct(c50.filter((x) => x.phone).length, c50.length), ovPctWebsite: pct(c50.filter((x) => x.web).length, c50.length),
      ovPctEmail: pct(c50.filter((x) => x.email).length, c50.length), osmPctPhone: pct(o.filter((x) => x.has_phone).length, o.length),
    });
  }
  const dhaka50 = ov.filter((x) => x.dhaka && x.conf >= 0.5 && x.ours);
  const rest50 = ov.filter((x) => !x.dhaka && x.conf >= 0.5 && x.ours);
  const summary = {
    overtureRowsInBox: rows.length, droppedOutsideBangladesh: outside, overtureInBangladesh: ov.length,
    mappedToOurCategories: ov.filter((x) => x.ours).length, unmappedCategory: ov.filter((x) => !x.ours).length,
    mappedConf50: ov.filter((x) => x.ours && x.conf >= 0.5).length,
    overtureOnlyConf50Total: out.reduce((a, r) => a + r.overtureOnlyConf50, 0),
    overtureOnlyConf80Total: out.reduce((a, r) => a + r.overtureOnlyConf80, 0),
    dhakaMetro: { overtureConf50: dhaka50.length, overtureOnly: dhaka50.filter((x) => !flagged.get(x.id)).length },
    restOfCountry: { overtureConf50: rest50.length, overtureOnly: rest50.filter((x) => !flagged.get(x.id)).length },
  };

  // eyeball sample: Overture-only, Dhaka metro, confidence >= 0.5, deterministic
  const sample = dhaka50.filter((x) => !flagged.get(x.id)).filter((_, i) => i % Math.max(1, Math.floor(dhaka50.length / 40)) === 0).slice(0, 14)
    .map((x) => ({ name: x.name.slice(0, 40), taxonomy: x.cat, ourCategory: x.ours, conf: x.conf, phone: x.phone, website: x.web }));

  mkdirSync(env.exportDir, { recursive: true });
  const header = Object.keys(out[0]!).join(',');
  writeFileSync(resolve(env.exportDir, 'overture_coverage_test.csv'), '﻿' + header + '\r\n' + out.map((r) => Object.values(r).map((v) => v ?? '').join(',')).join('\r\n') + '\r\n');
  writeFileSync(resolve(env.exportDir, 'overture_coverage_test.json'), JSON.stringify({ generatedAt: new Date().toISOString(), release: '2026-10-21.0', summary, rows: out, eyeballSample: sample }, null, 2));
  return { summary, rows: out, sample };
}
