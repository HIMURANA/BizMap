import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CATEGORIES, getCategory } from '../config/categories.js';
import { prepare } from '../db/db.js';
import { loadBoundaries } from '../geo/boundaries.js';
import { DIAGNOSTIC_NAME } from '../osm/classify.js';
import { LOCAL_ELEMENTS_FILE, NATIONAL_ELEMENTS_FILE, type ExtractScope, type ExtractSummary, type LocalElement } from '../osm/extractLocal.js';
import { ingestElements, type IngestCounters } from './runDiscovery.js';

export const LOCAL_AREA_NAME = 'Dhaka (local extract)';
export const NATIONAL_AREA_NAME = 'Bangladesh (local extract)';

export interface ImportResult extends IngestCounters {
  categoryKey: string;
  elements: number;
  status: 'completed' | 'skipped';
}

/**
 * Import elements from the local Geofabrik extract. One job per category (resumable: a completed job is
 * skipped unless force). Goes through the same ingest rules as Overpass discovery.
 */
export function importLocal(opts: { force?: boolean; scope?: ExtractScope } = {}, log: (m: string) => void = console.log): { summary: ExtractSummary; results: ImportResult[] } {
  const areaName = opts.scope === 'bangladesh' ? NATIONAL_AREA_NAME : LOCAL_AREA_NAME;
  const file = JSON.parse(readFileSync(opts.scope === 'bangladesh' ? NATIONAL_ELEMENTS_FILE : LOCAL_ELEMENTS_FILE, 'utf-8')) as { summary: ExtractSummary; elements: LocalElement[] };
  const boundaries = loadBoundaries();
  // Diagnostic-looking names tagged only as clinic/doctors move out of hospitals (kept separate per spec).
  // Real hospitals (amenity/healthcare=hospital) are never moved. They stay review-flagged via the classifier.
  let movedToDiagnostics = 0;
  for (const e of file.elements) {
    const nm = (e.tags?.name ?? e.tags?.['name:en'] ?? '').trim();
    if (e.categoryKey === 'hospitals' && nm && DIAGNOSTIC_NAME.test(nm) && e.tags?.amenity !== 'hospital' && e.tags?.healthcare !== 'hospital') {
      e.categoryKey = 'diagnostics';
      movedToDiagnostics++;
    }
  }
  if (movedToDiagnostics) log(`  ${movedToDiagnostics} clinic-tagged elements with diagnostic-style names moved from hospitals to diagnostics (review-flagged)`);
  const note = `geofabrik bangladesh-latest.osm.pbf md5=${file.summary.sourceMd5} extracted=${file.summary.extractedAt}`;
  const results: ImportResult[] = [];

  for (const cat of CATEGORIES) {
    const els = file.elements.filter((e) => e.categoryKey === cat.key);
    if (els.length === 0) continue;
    const base: ImportResult = { categoryKey: cat.key, elements: els.length, status: 'completed', businessesCreated: 0, skippedNoName: 0, alreadyKnown: 0, needsReview: 0, unassigned: 0 };

    if (!opts.force) {
      const done = prepare<{ job_id: string }>(`SELECT job_id FROM discovery_jobs WHERE area_name=? AND category_id=? AND status='completed' LIMIT 1`).get(areaName, cat.key);
      if (done) { log(`  skip ${cat.key}: already imported (job ${done.job_id})`); results.push({ ...base, status: 'skipped' }); continue; }
    }
    const jobId = randomUUID();
    const t = () => new Date().toISOString();
    prepare(`INSERT INTO discovery_jobs (job_id, area_name, category_id, status, endpoint_used, started_at) VALUES (?, ?, ?, 'running', 'local:geofabrik-pbf', ?)`).run(jobId, areaName, cat.key, t());
    try {
      ingestElements(els, getCategory(cat.key), cat.key, boundaries, base, note);
      prepare(`UPDATE discovery_jobs SET status='completed', finished_at=?, element_count=?, business_count=? WHERE job_id=?`).run(t(), els.length, base.businessesCreated, jobId);
      prepare(`INSERT INTO discovery_logs (log_level, job_id, endpoint, message, detail) VALUES ('info', ?, 'local:geofabrik-pbf', 'Local import completed', ?)`).run(jobId, JSON.stringify({ ...base }));
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      prepare(`UPDATE discovery_jobs SET status='failed', finished_at=?, error_message=? WHERE job_id=?`).run(t(), m, jobId);
      throw e;
    }
    results.push(base);
  }
  return { summary: file.summary, results };
}
