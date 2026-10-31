#!/usr/bin/env node

import { initializeDatabase, prepare, transaction } from './db/db.js';
import { env } from './config/env.js';
import { CATEGORIES, CATEGORY_BY_KEY } from './config/categories.js';
import { AREAS, getPilotAreas } from './config/areas.js';
import { discoverAreaCategory, discoverMultiple } from './discovery/runDiscovery.js';
import { lookupBoundary, parseBoundingBox } from './geo/nominatim.js';
import { scoreAll, findDuplicates } from './quality/quality.js';
import { runExport } from './export/exporter.js';
import { runWebDiscovery, PLANS } from './discovery/webDiscovery.js';
import { importOverture, writeOvertureSample } from './discovery/importOverture.js';
import { importAdLibrary } from './discovery/importAdLibrary.js';
import { buildSearchIndex } from './export/searchIndex.js';
import { runOvertureCoverage } from './analysis/overtureCoverage.js';
import { assignAdmin, resolveAdmin } from './geo/admin.js';
import { loadPopulation } from './geo/population.js';
import { writeDashboard } from './export/dashboard.js';
import { extractLocal } from './osm/extractLocal.js';
import { importLocal } from './discovery/importLocal.js';
import { runEnrichBatch, runEnrichSample } from './enrich/enrichSample.js';
import { assignArea, loadBoundaries, loadCityPolygon, scopeOf, POINT_RADIUS_KM } from './geo/boundaries.js';

const args = process.argv.slice(2);
const command = args[0] || 'help';

async function initDb() {
  console.log('Initializing database...');
  initializeDatabase();

  console.log('Populating reference data...');

  // Populate categories and subcategories
  const insertCategory = prepare(
    `INSERT OR IGNORE INTO business_categories (category_id, label, export_file, discovery_mode, notes)
     VALUES (?, ?, ?, ?, ?)`,
  );

  const insertSubcategory = prepare(
    `INSERT OR IGNORE INTO business_subcategories (subcategory_id, category_id, label)
     VALUES (?, ?, ?)`,
  );

  transaction(() => {
    for (const cat of CATEGORIES) {
      insertCategory.run(cat.key, cat.label, cat.exportFile, cat.mode, cat.notes ?? null);
      for (const sub of cat.subcategories) {
        insertSubcategory.run(sub.key, cat.key, sub.label);
      }
    }
  });

  // Populate areas
  const insertArea = prepare(
    `INSERT OR IGNORE INTO discovery_areas (name, classification, city_corporation, parent_area, notes)
     VALUES (?, ?, ?, ?, ?)`,
  );

  transaction(() => {
    for (const area of AREAS) {
      insertArea.run(area.name, area.classification, area.cityCorporation, area.parentArea || null, area.notes ?? null);
    }
  });

  console.log(`✓ Database initialized with ${CATEGORIES.length} categories and ${AREAS.length} areas.`);
}

async function resolveBoundaries() {
  const flags = args.slice(1).filter((a) => a.startsWith('--'));
  const names = args.slice(1).filter((a) => !a.startsWith('--'));
  const all = flags.includes('--all');
  const force = flags.includes('--force');
  // Gulshan 1/2 have no OSM boundary (covered by "Gulshan"); never geocode them.
  const SKIP = new Set(['Gulshan 1', 'Gulshan 2']);
  const targets = all
    ? AREAS.map((a) => a.name).filter((n) => !SKIP.has(n) && (force || !prepare<{ m: string | null }>(`SELECT boundary_method m FROM discovery_areas WHERE name=?`).get(n)?.m))
    : names.length ? names : getPilotAreas().map((a) => a.name);
  console.log(`Resolving boundaries for ${targets.length} areas`);
  const counts = { polygon: 0, point: 0, none: 0, collided: 0 };

  for (const name of targets) {
    const def = AREAS.find((a) => a.name === name);
    if (!def) { console.warn(`  ? "${name}" is not a known area, skipped`); continue; }
    const found = await lookupBoundary(name, def.parentArea);
    // Guard: two different areas must never resolve to the same OSM place (e.g. "Sector 3" falling back to "Uttara").
    if (found.kind !== 'none') {
      const clash = prepare<{ name: string }>(`SELECT name FROM discovery_areas WHERE osm_type=? AND osm_id=? AND name != ? LIMIT 1`).get(found.result.osm_type, found.result.osm_id, name);
      if (clash) {
        prepare(`UPDATE discovery_areas SET boundary_method='none', boundary_resolved=0, notes=? WHERE name=?`).run(`Rejected: resolved to the same OSM place (${found.result.osm_type}/${found.result.osm_id}) as "${clash.name}", so it is not a distinct boundary.`, name);
        console.warn(`  ✗ ${name}: resolves to the same place as "${clash.name}"; left unresolved`);
        counts.collided++;
        continue;
      }
    }
    if (found.kind === 'polygon') {
      counts.polygon++;
      const r = found.result;
      const bb = parseBoundingBox(r.boundingbox);
      prepare(`UPDATE discovery_areas SET boundary_geojson=?, boundary_method='osm_polygon', min_lat=?, min_lon=?, max_lat=?, max_lon=?,
        center_lat=?, center_lon=?, osm_type=?, osm_id=?, boundary_resolved=1, resolved_at=?, notes=? WHERE name=?`).run(
        JSON.stringify(found.geojson), bb[0], bb[1], bb[2], bb[3], Number(r.lat), Number(r.lon), r.osm_type, r.osm_id,
        new Date().toISOString(), `Real OSM polygon ${r.osm_type}/${r.osm_id} (${r.class}=${r.type}).`, name);
      console.log(`  ✓ ${name}: REAL polygon ${r.osm_type}/${r.osm_id} (${found.geojson.type}), bbox [${bb.map((n) => n.toFixed(4)).join(', ')}]`);
    } else if (found.kind === 'point') {
      counts.point++;
      const r = found.result;
      prepare(`UPDATE discovery_areas SET boundary_geojson=NULL, boundary_method='point_radius', center_lat=?, center_lon=?, osm_type=?, osm_id=?,
        min_lat=NULL, min_lon=NULL, max_lat=NULL, max_lon=NULL, boundary_resolved=1, resolved_at=?, notes=? WHERE name=?`).run(
        Number(r.lat), Number(r.lon), r.osm_type, r.osm_id, new Date().toISOString(),
        `APPROXIMATE: OSM has only a point (${r.osm_type}/${r.osm_id}); using a ${POINT_RADIUS_KM} km radius, not a real boundary.`, name);
      console.log(`  ~ ${name}: only a POINT in OSM -> approximate ${POINT_RADIUS_KM} km radius around ${r.lat}, ${r.lon}`);
    } else {
      counts.none++;
      prepare(`UPDATE discovery_areas SET boundary_method='none', boundary_resolved=0, notes=? WHERE name=?`).run('No usable OSM place found.', name);
      console.warn(`  ✗ ${name}: nothing usable found; left unresolved`);
    }
  }
  console.log(`Done: ${counts.polygon} real polygons, ${counts.point} point-only (approximate), ${counts.none} not found, ${counts.collided} rejected as duplicates of another area`);
}

/** Re-assign every stored business to an area from its coordinates (local, no network). */
async function assignAreas() {
  const boundaries = loadBoundaries();
  console.log(`Assigning with ${boundaries.length} resolved boundaries: ${boundaries.map((b) => `${b.name} [${b.method}]`).join(', ')}`);
  const rows = prepare<{ location_id: number; latitude: number | null; longitude: number | null }>(
    `SELECT location_id, latitude, longitude FROM business_locations`).all();
  const upd = prepare(`UPDATE business_locations SET area_name=?, area_method=?, city_corporation=?, dhaka_scope=? WHERE location_id=?`);
  const city = loadCityPolygon();
  console.log(city ? 'Dhaka Metropolitan polygon loaded: scope will be set.' : 'No city polygon (run resolve-city): dhaka_scope left empty.');
  const scopeTally = new Map<string, number>();
  const tally = new Map<string, number>();
  transaction(() => {
    for (const r of rows) {
      const a = r.latitude !== null && r.longitude !== null ? assignArea(r.latitude, r.longitude, boundaries)
        : { area: null, cityCorporation: null, method: 'none' as const };
      const scope = city && r.latitude !== null && r.longitude !== null ? scopeOf(r.latitude, r.longitude, city) : null;
      upd.run(a.area, a.method, a.cityCorporation, scope, r.location_id);
      scopeTally.set(scope ?? '(unknown)', (scopeTally.get(scope ?? '(unknown)') ?? 0) + 1);
      const key = `${a.area ?? '(unassigned)'} [${a.method}]`;
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
  });
  for (const [k, n] of [...tally].sort((x, y) => y[1] - x[1])) console.log(`  ${String(n).padStart(5)}  ${k}`);
  console.log('Scope:', Object.fromEntries(scopeTally));
}

async function resolveCity() {
  const res = await fetch('https://nominatim.openstreetmap.org/lookup?osm_ids=R13663697&format=json&polygon_geojson=1&polygon_threshold=0.0001', { headers: { 'User-Agent': env.userAgent } });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const [r] = (await res.json()) as { osm_type: string; osm_id: number; class: string; type: string; lat: string; lon: string; display_name: string; boundingbox: string[]; geojson?: { type: string } }[];
  if (!r || r.class !== 'boundary' || !r.geojson || (r.geojson.type !== 'Polygon' && r.geojson.type !== 'MultiPolygon')) throw new Error('Relation 13663697 did not return a boundary polygon');
  const bb = r.boundingbox.map(Number);
  prepare(`INSERT OR REPLACE INTO discovery_areas (name, classification, city_corporation, boundary_geojson, boundary_method, min_lat, max_lat, min_lon, max_lon, center_lat, center_lon, osm_type, osm_id, boundary_resolved, resolved_at, notes)
    VALUES ('Dhaka Metropolitan', 'city', 'Dhaka Metropolitan', ?, 'city_polygon', ?, ?, ?, ?, ?, ?, 'relation', 13663697, 1, ?, ?)`).run(
    JSON.stringify(r.geojson), bb[0]!, bb[1]!, bb[2]!, bb[3]!, Number(r.lat), Number(r.lon), new Date().toISOString(),
    'OSM relation 13663697 (boundary=administrative), simplified ~11 m. Separates Dhaka city from Greater Dhaka. OSM has no DNCC/DSCC polygons, so no DNCC/DSCC split is derived from geometry.');
  console.log(`Dhaka Metropolitan polygon stored (${r.geojson.type}): ${r.display_name}`);
}

async function extractLocalCmd() {
  const s = await extractLocal(console.log, args.includes('--bangladesh') ? 'bangladesh' : 'dhaka');
  console.log(JSON.stringify(s, null, 2));
}

async function importLocalCmd() {
  const { results } = importLocal({ force: args.includes('--force'), scope: args.includes('--bangladesh') ? 'bangladesh' : 'dhaka' });
  for (const r of results) console.log(`  ${r.categoryKey.padEnd(12)} ${r.status.padEnd(9)} elements ${String(r.elements).padStart(5)}  created ${String(r.businessesCreated).padStart(5)}  already known ${String(r.alreadyKnown).padStart(4)}  no name ${String(r.skippedNoName).padStart(5)}  needs review ${String(r.needsReview).padStart(4)}`);
}

async function discover() {
  const area = args[1];
  const category = args[2];

  if (!area || !category) {
    console.error('Usage: discover <area> <category>');
    console.error(`  Area: one of ${AREAS.slice(0, 3).map((a) => a.name).join(', ')}, ...`);
    console.error(`  Category: ${CATEGORIES.map((c) => c.key).join(', ')}`);
    process.exit(1);
  }

  if (!CATEGORY_BY_KEY.has(category)) {
    console.error(`Unknown category: ${category}`);
    process.exit(1);
  }

  const result = await discoverAreaCategory(area, category);

  console.log(`\nDiscovery Result:`);
  console.log(`  Job ID: ${result.jobId}`);
  console.log(`  Area: ${result.areaName}`);
  console.log(`  Category: ${result.categoryKey}`);
  console.log(`  Elements found: ${result.elementsFound}`);
  console.log(`  Businesses created: ${result.businessesCreated}`);
  if (result.error) {
    console.log(`  Error: ${result.error}`);
  }
}

async function pilot() {
  console.log('Running PILOT discovery for Gulshan, Banani, Baridhara × Restaurants, Gyms, Grocery');
  console.log('='.repeat(80));

  const pilotAreas = getPilotAreas().map((a) => a.name);
  const pilotCategories = ['restaurants', 'gyms', 'grocery'];

  const results = await discoverMultiple(pilotAreas, pilotCategories);

  // Summary
  console.log(`\n${'='.repeat(80)}`);
  console.log('PILOT SUMMARY');
  console.log('='.repeat(80));

  let totalElements = 0;
  let totalBusinesses = 0;
  let failures = 0;

  for (const result of results) {
    const status = result.error ? '✗' : '✓';
    console.log(
      `${status} ${result.areaName.padEnd(25)} × ${result.categoryKey.padEnd(15)} → ${result.businessesCreated} businesses (from ${result.elementsFound} OSM elements)`,
    );
    totalElements += result.elementsFound;
    totalBusinesses += result.businessesCreated;
    if (result.error) failures++;
  }

  console.log(`\nTotal: ${totalBusinesses} businesses created from ${totalElements} OSM elements (${failures} failures)`);
}

async function enrichSample() {
  const n = Number(args[1] ?? 30);
  const withWebsite = Number(args[2] ?? 6);
  const ceiling = Number(args[3] ?? 120);
  await runEnrichSample(n, withWebsite, ceiling);
}

async function quality() {
  const dup = findDuplicates();
  console.log(`Duplicates: ${dup.candidates} candidate pairs (pending review, nothing merged); ${dup.branchGroups} multi-branch name groups -> ${dup.branchRecords} records given a parent_business_id; ${dup.sharedKeysSkipped} website/phone/social keys skipped (shared by > 5 businesses: chains or platforms)`);
  const sc = scoreAll();
  console.log(`Confidence scored for ${sc.total} records: high ${sc.bands.high}, medium ${sc.bands.medium}, low ${sc.bands.low}`);
}

async function exportAll() {
  const r = runExport();
  const d = writeDashboard();
  console.log(`Exports written to ${r.dir}`);
  console.log(`Dashboard: ${d.file} (${d.groups} aggregated groups from ${d.records} records)`);
  for (const [f, n] of Object.entries(r.files)) console.log(`  ${f.padEnd(32)} ${n} rows`);
}

async function webDiscover() {
  const ceiling = Number(args[1] ?? 250);
  console.log(`Web discovery: ${PLANS.length} searches, credit ceiling ${ceiling}`);
  const r = await runWebDiscovery(ceiling);
  console.log(JSON.stringify(r, null, 2));
}

async function enrichBatch() {
  const n = Number(args[1] ?? 150);
  const ceiling = Number(args[2] ?? 400);
  await runEnrichBatch(n, ceiling);
}

async function resolveAdminCmd() {
  const r = await resolveAdmin();
  console.log(JSON.stringify(r, null, 2));
}

async function assignAdminCmd() {
  const r = assignAdmin();
  console.log(JSON.stringify(r, null, 2));
}

async function loadPopulationCmd() {
  console.log(JSON.stringify(loadPopulation(), null, 2));
}

async function overtureTest() {
  const r = runOvertureCoverage();
  console.log(JSON.stringify(r.summary, null, 2));
  console.table(r.rows);
  console.log('Eyeball sample (Overture-only, Dhaka, confidence >= 0.5):');
  console.table(r.sample);
}

async function importOvertureCmd() {
  const r = importOverture();
  console.log(JSON.stringify(r, null, 2));
}

async function importAdLibraryCmd() {
  const files = args.slice(1);
  if (!files.length) throw new Error('Usage: import-adlibrary <file.csv> [more.csv]  (hand-collected, see data/fcommerce/HOW_TO_COLLECT.md)');
  for (const f of files) importAdLibrary(f);
}

async function buildSearchCmd() {
  const t = Date.now();
  const r = buildSearchIndex();
  console.log(`search_businesses rebuilt: ${r.rows} rows in ${((Date.now() - t) / 1000).toFixed(1)} s (read by the SaaS app)`);
}

async function overtureSampleCmd() {
  writeOvertureSample();
}

async function stats() {
  const countBusinesses = prepare<{ count: number }>(`SELECT COUNT(*) as count FROM businesses`);
  const countLocations = prepare<{ count: number }>(`SELECT COUNT(*) as count FROM business_locations`);
  const countSources = prepare<{ count: number }>(`SELECT COUNT(*) as count FROM business_sources`);
  const countJobs = prepare<{ count: number }>(`SELECT COUNT(*) as count FROM discovery_jobs`);

  const businesses = countBusinesses.get();
  const locations = countLocations.get();
  const sources = countSources.get();
  const jobs = countJobs.get();

  console.log(`Database Statistics:`);
  console.log(`  Businesses: ${businesses?.count || 0}`);
  console.log(`  Locations: ${locations?.count || 0}`);
  console.log(`  Sources: ${sources?.count || 0}`);
  console.log(`  Discovery jobs: ${jobs?.count || 0}`);
}

async function help() {
  console.log(`
Dhaka Business Discovery System
version 0.1.0

Usage: tsx cli.ts <command>

Commands:
  init-db              Initialize database and populate reference data
  resolve-boundaries [area...]  Fetch real OSM polygons (or flagged point fallback); default: pilot areas
  enrich-sample [n] [withSite] [maxCredits]  Firecrawl enrichment of a restaurant sample (default 30, 6, 120)
  quality              Score confidence (0-100) and find duplicate candidates / branches
  export               Write CSV/JSON exports, coverage and summary reports
  resolve-city         Store the real OSM Dhaka Metropolitan polygon (city vs Greater Dhaka)
  extract-local        Stream the local Geofabrik .pbf and extract matching Dhaka elements
  import-local [--force]  Classify and store the extracted elements
  web-discover [maxCredits]  Firecrawl web discovery for garments, tech companies, online businesses (default 250)
  enrich-batch [n] [maxCredits]  Firecrawl enrichment of the highest-value OSM records (default 150, 400)
  resolve-admin        Fetch real division/district/upazila polygons (OSM) and link them by geometry
  assign-admin         Assign every business to its division/district/upazila
  load-population      Load 2022 district/upazila population (HDX CSVs in data/population)
  overture-test        Compare local Overture Places extract against our OSM records (data/overture)
  import-overture      Import Overture Places (confidence >= 0.5) as a separate labelled layer; <0.8 = leads
  import-adlibrary <csv...>  Import F-commerce pages collected BY HAND from the Meta Ad Library (data/fcommerce)
  build-search         Rebuild the flat search table the SaaS app reads (run after quality)
  overture-sample      Rebuild overture_validation_sample.csv from all Overture records in the database
  assign-areas         Re-assign stored businesses to areas by coordinates
  discover <area> <cat> Discover businesses for a single area + category
  pilot                Run pilot discovery (Gulshan × 3 categories)
  stats                Show database statistics
  help                 Show this help
`);
}

// Run command
(async () => {
  try {
    switch (command) {
      case 'init-db':
        await initDb();
        break;
      case 'resolve-boundaries':
        await resolveBoundaries();
        break;
      case 'resolve-city':
        await resolveCity();
        break;
      case 'extract-local':
        await extractLocalCmd();
        break;
      case 'import-local':
        await importLocalCmd();
        break;
      case 'assign-areas':
        await assignAreas();
        break;
      case 'discover':
        await discover();
        break;
      case 'pilot':
        await pilot();
        break;
      case 'enrich-sample':
        await enrichSample();
        break;
      case 'quality':
        await quality();
        break;
      case 'export':
        await exportAll();
        break;
      case 'web-discover':
        await webDiscover();
        break;
      case 'enrich-batch':
        await enrichBatch();
        break;
      case 'resolve-admin':
        await resolveAdminCmd();
        break;
      case 'assign-admin':
        await assignAdminCmd();
        break;
      case 'load-population':
        await loadPopulationCmd();
        break;
      case 'overture-test':
        await overtureTest();
        break;
      case 'import-overture':
        await importOvertureCmd();
        break;
      case 'import-adlibrary':
        await importAdLibraryCmd();
        break;
      case 'build-search':
        await buildSearchCmd();
        break;
      case 'overture-sample':
        await overtureSampleCmd();
        break;
      case 'stats':
        await stats();
        break;
      case 'help':
      default:
        await help();
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
})();
