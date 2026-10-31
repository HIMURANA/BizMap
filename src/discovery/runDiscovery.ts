import { randomUUID } from 'node:crypto';
import { overpass, type OverpassElement } from '../osm/overpassClient.js';
import { buildCategoryQuery, type BBox } from '../osm/queryBuilder.js';
import { classifyElement } from '../osm/classify.js';
import { extractFromTags } from '../osm/extractContacts.js';
import { prepare, transaction, type Param } from '../db/db.js';
import { assignArea, geoBBox, loadBoundaries, radiusBBox, type GeoPolygon, type LoadedBoundary } from '../geo/boundaries.js';
import { getCategory, type CategoryConfig } from '../config/categories.js';

export interface DiscoveryResult {
  jobId: string | null;
  areaName: string;
  categoryKey: string;
  status: 'completed' | 'failed' | 'skipped';
  elementsFound: number;
  businessesCreated: number;
  skippedNoName: number;
  alreadyKnown: number;
  needsReview: number;
  /** Inside the query box but in no known area boundary (kept, area left NULL). */
  unassigned: number;
  error?: string;
}

interface AreaRow {
  name: string;
  classification: string;
  city_corporation: string;
  parent_area: string | null;
  min_lat: number | null;
  min_lon: number | null;
  max_lat: number | null;
  max_lon: number | null;
  center_lat: number | null;
  center_lon: number | null;
  boundary_geojson: string | null;
  boundary_method: string | null;
  notes: string | null;
}

function log(jobId: string, level: 'debug' | 'info' | 'warn' | 'error', message: string, detail?: string, endpoint?: string) {
  prepare(`INSERT INTO discovery_logs (log_level, job_id, endpoint, message, detail) VALUES (?, ?, ?, ?, ?)`).run(
    level, jobId, endpoint ?? null, message, detail ?? null,
  );
}

/**
 * Query box for an area, derived ONLY from a resolved boundary (OSM polygon bbox, or the stated
 * point-radius approximation). Never guessed; run `resolve-boundaries` first.
 */
export function resolveAreaBBox(areaName: string): { bbox: BBox; area: AreaRow } {
  const area = prepare<AreaRow>(`SELECT * FROM discovery_areas WHERE name = ?`).get(areaName);
  if (!area) throw new Error(`Area "${areaName}" is not in discovery_areas (run init-db)`);

  if (area.boundary_method === 'osm_polygon' && area.boundary_geojson) {
    return { bbox: geoBBox(JSON.parse(area.boundary_geojson) as GeoPolygon), area };
  }
  if (area.boundary_method === 'point_radius' && area.center_lat !== null && area.center_lon !== null) {
    return { bbox: radiusBBox(area.center_lat, area.center_lon), area };
  }
  throw new Error(`Area "${areaName}" has no resolved boundary (run: resolve-boundaries "${areaName}")`);
}

function coords(el: OverpassElement): [number | null, number | null] {
  if (el.center) return [el.center.lat, el.center.lon];
  if (el.lat !== undefined && el.lon !== undefined) return [el.lat, el.lon];
  return [null, null];
}

export interface IngestCounters {
  businessesCreated: number; skippedNoName: number; alreadyKnown: number; needsReview: number; unassigned: number;
}

/**
 * Classify and store OSM elements for one category. Shared by Overpass discovery and the local-extract
 * import, so both paths apply identical rules (name required, exact OSM-id dedup, review flags, provenance).
 */
export function ingestElements(
  elements: OverpassElement[], category: CategoryConfig, categoryKey: string,
  boundaries: LoadedBoundary[], base: IngestCounters, sourceNote?: string,
): void {
  const now = () => new Date().toISOString();
  const existsStmt = prepare<{ business_id: string }>(`SELECT business_id FROM businesses WHERE business_id = ?`);
  const insBusiness = prepare(
    `INSERT INTO businesses (business_id, name, category_id, subcategory_id, description, record_status,
       classification_method, classification_note, first_discovered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insLocation = prepare(
    `INSERT INTO business_locations (business_id, osm_element_type, osm_element_id, osm_url, latitude, longitude, area_name, area_method, city_corporation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insSource = prepare(
    `INSERT INTO business_sources (business_id, source_type, source_url, source_reference, raw_payload, fetched_at)
     VALUES (?, 'osm', ?, ?, ?, ?)`,
  );
  const insContact = prepare(
    `INSERT INTO business_contacts (business_id, contact_type, value_raw, value_normalized, verification_status, source_url)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insSocial = prepare(
    `INSERT INTO business_social_links (business_id, platform, url, verification_status, source_url) VALUES (?, ?, ?, 'unverified', ?)`,
  );

  transaction(() => {
    for (const el of elements) {
      const tags = el.tags ?? {};
      const name = (tags.name ?? tags['name:en'] ?? '').trim();
      if (!name) {
        base.skippedNoName++;
        continue;
      }
      const businessId = `osm:${el.type}:${el.id}`;
      // Priority-1 dedup rule: exact OSM element type+id. Overlapping area boxes return the
      // same element twice; keep the first area assignment and don't duplicate locations.
      if (existsStmt.get(businessId)) {
        base.alreadyKnown++;
        continue;
      }

      const cls = classifyElement(el, category);
      const osmUrl = `https://www.openstreetmap.org/${el.type}/${el.id}`;
      const [lat, lon] = coords(el);
      const fetchedAt = now();
      const status = cls.needsReview ? 'needs_review' : 'new';
      if (cls.needsReview) base.needsReview++;

      insBusiness.run(
        businessId, name, categoryKey, cls.subcategoryKey, tags.description ?? null, status,
        cls.method, cls.reviewNote, fetchedAt,
      );
      const asg = lat !== null && lon !== null ? assignArea(lat, lon, boundaries) : { area: null, cityCorporation: null, method: 'none' as const };
      if (!asg.area) base.unassigned++;
      insLocation.run(businessId, el.type, el.id, osmUrl, lat, lon, asg.area, asg.method, asg.cityCorporation);
      insSource.run(businessId, osmUrl, `${el.type}/${el.id}`, JSON.stringify(sourceNote ? { ...el, _source: sourceNote } : el), fetchedAt);

      const { contacts, socials } = extractFromTags(tags);
      for (const c of contacts) {
        // Unparseable values are kept raw but marked invalid; never "fixed" by guessing.
        const verification = c.normalized ? 'unverified' : 'invalid';
        insContact.run(businessId, c.type, c.raw, c.normalized as Param, verification, osmUrl);
      }
      for (const s of socials) insSocial.run(businessId, s.platform, s.url, osmUrl);

      base.businessesCreated++;
    }
  });

}

export async function discoverAreaCategory(areaName: string, categoryKey: string, opts: { force?: boolean } = {}): Promise<DiscoveryResult> {
  const category = getCategory(categoryKey);
  const base: DiscoveryResult = {
    jobId: null, areaName, categoryKey, status: 'failed',
    elementsFound: 0, businessesCreated: 0, skippedNoName: 0, alreadyKnown: 0, needsReview: 0, unassigned: 0,
  };

  // Resumability: a completed job for the same area x category is not repeated.
  if (!opts.force) {
    const done = prepare<{ job_id: string }>(
      `SELECT job_id FROM discovery_jobs WHERE area_name=? AND category_id=? AND status='completed' LIMIT 1`,
    ).get(areaName, categoryKey);
    if (done) {
      console.log(`  skip: ${areaName} x ${categoryKey} already completed (job ${done.job_id}); use --force to redo`);
      return { ...base, jobId: done.job_id, status: 'skipped' };
    }
  }

  const jobId = randomUUID();
  base.jobId = jobId;
  const now = () => new Date().toISOString();
  prepare(`INSERT INTO discovery_jobs (job_id, area_name, category_id, status, started_at) VALUES (?, ?, ?, 'running', ?)`).run(
    jobId, areaName, categoryKey, now(),
  );

  try {
    const { bbox } = resolveAreaBBox(areaName);
    const boundaries = loadBoundaries();
    const query = buildCategoryQuery(category, bbox);
    log(jobId, 'info', 'Overpass query built', query);

    const response = await overpass.query(query);
    const endpoint = overpass.lastEndpoint ?? 'unknown';
    base.elementsFound = response.elements.length;

    ingestElements(response.elements, category, categoryKey, boundaries, base);

    prepare(
      `UPDATE discovery_jobs SET status='completed', endpoint_used=?, finished_at=?, element_count=?, business_count=? WHERE job_id=?`,
    ).run(endpoint, now(), base.elementsFound, base.businessesCreated, jobId);
    log(jobId, 'info', 'Job completed',
      JSON.stringify({ elements: base.elementsFound, created: base.businessesCreated, noName: base.skippedNoName, alreadyKnown: base.alreadyKnown, needsReview: base.needsReview, unassigned: base.unassigned }),
      endpoint);
    base.status = 'completed';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    base.error = message;
    prepare(`UPDATE discovery_jobs SET status='failed', finished_at=?, error_message=? WHERE job_id=?`).run(now(), message, jobId);
    log(jobId, 'error', 'Job failed', message);
  }
  return base;
}

export async function discoverMultiple(areas: string[], categories: string[], opts: { force?: boolean } = {}): Promise<DiscoveryResult[]> {
  const results: DiscoveryResult[] = [];
  for (const area of areas) {
    for (const category of categories) {
      console.log(`\n-- ${area} x ${category}`);
      const r = await discoverAreaCategory(area, category, opts);
      results.push(r);
      if (r.error) console.log(`  FAILED: ${r.error}`);
      // Stop the batch on Overpass failure instead of hammering a busy server with every remaining job.
      if (r.status === 'failed' && /Overpass/i.test(r.error ?? '')) {
        console.log('  Overpass is failing; stopping the batch. Re-run later - completed jobs will be skipped.');
        return results;
      }
      // Be polite between live queries.
      if (r.status === 'completed' && overpass.lastEndpoint !== 'cache') await new Promise((res) => setTimeout(res, 3000));
    }
  }
  return results;
}
