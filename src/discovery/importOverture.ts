import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { env } from '../config/env.js';
import { prepare, transaction } from '../db/db.js';
import { geoBBox, geoContains, type GeoPolygon } from '../geo/boundaries.js';
import { distance, parseCsv } from '../geo/population.js';
import { normalizeBdPhone, normalizeUrl } from '../osm/extractContacts.js';
import { socialProfile } from '../enrich/match.js';
import { badName, categoryOf, normName, subOf } from './overtureMap.js';

/**
 * Imports Overture Places as a SEPARATE, labelled source layer.
 *  - only places inside real Bangladeshi district polygons, confidence >= 0.5, in a mapped category, with a usable name,
 *    and not marked closed;
 *  - confidence >= 0.8 -> record_status 'new'; 0.5-0.8 -> 'lead' (kept out of the main category files);
 *  - a place that matches an existing OSM record (<=15 m & same category, or <=50 m & similar name, or <=100 m & identical
 *    name; Latin and Bangla names both compared) does NOT create a record: its contacts are added to the OSM record as
 *    'unverified', with the Overture id as source;
 *  - duplicates inside Overture (same name within 30 m) are merged;
 *  - every contact is stored 'unverified' (Overture's phones/emails mostly come from Facebook business pages).
 */

const RELEASE = '2026-10-21.0';
export const OVERTURE_FULL_CSV = resolve(process.cwd(), 'data/overture/bd_places_full.csv');
const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const cell = (lat: number, lon: number) => `${Math.floor(lat * 1000)}:${Math.floor(lon * 1000)}`;
const kmBetween = (a: [number, number], b: [number, number]) => Math.hypot((a[0] - b[0]) * 111.32, (a[1] - b[1]) * 111.32 * Math.cos((a[0] * Math.PI) / 180));

function similar(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const min = Math.min(a.length, b.length);
  if (min >= 5 && (a.includes(b) || b.includes(a))) return true;
  return min >= 4 && distance(a, b) <= Math.max(1, Math.floor(min * 0.2));
}

interface Place {
  id: string; names: string[]; display: string; cat: string; ours: string; sub: string | null; conf: number;
  lat: number; lon: number; phones: string[]; emails: string[]; websites: string[]; socials: string[]; datasets: string; locality: string; address: string;
}
interface Indexed { names: string[]; lat: number; lon: number; ours: string; id: string }

export interface OvertureImportSummary {
  release: string; csvRows: number; outsideBangladesh: number; unmappedCategory: number; badNameDropped: number; closedDropped: number;
  candidates: number; matchedToOsm: number; contactsAddedToOsm: number; mergedInsideOverture: number; alreadyImported: number;
  created: number; createdNew: number; createdLead: number; byCategory: Record<string, number>; validationSample: string;
}

export function importOverture(log: (m: string) => void = console.log): OvertureImportSummary {
  const districts = prepare<{ boundary_geojson: string }>(`SELECT boundary_geojson FROM admin_areas WHERE level='district'`).all()
    .map((d) => { const geo = JSON.parse(d.boundary_geojson) as GeoPolygon; return { geo, bbox: geoBBox(geo) }; });
  const placeNames = new Set(prepare<{ name: string }>(`SELECT name FROM admin_areas`).all().flatMap((a) => [normName(a.name), normName(a.name.replace(/ (district|division|upazila|thana|subdistrict)$/i, ''))]).concat(['dhaka', 'bangladesh', 'chittagong', 'dhaka bangladesh']));

  const rows = parseCsv(readFileSync(OVERTURE_FULL_CSV, 'utf-8'));
  const sum: OvertureImportSummary = {
    release: RELEASE, csvRows: rows.length, outsideBangladesh: 0, unmappedCategory: 0, badNameDropped: 0, closedDropped: 0, candidates: 0,
    matchedToOsm: 0, contactsAddedToOsm: 0, mergedInsideOverture: 0, alreadyImported: 0, created: 0, createdNew: 0, createdLead: 0, byCategory: {}, validationSample: '',
  };

  // 1. filter + map
  const places: Place[] = [];
  for (const r of rows) {
    const lat = Number(r.lat), lon = Number(r.lon), conf = Number(r.confidence);
    if (!(conf >= 0.5)) continue;
    if (!districts.some((d) => lat >= d.bbox[0] && lat <= d.bbox[2] && lon >= d.bbox[1] && lon <= d.bbox[3] && geoContains(d.geo, lat, lon))) { sum.outsideBangladesh++; continue; }
    const ours = categoryOf(r.cat ?? '');
    if (!ours) { sum.unmappedCategory++; continue; }
    if (r.status === 'permanently_closed' || r.status === 'temporarily_closed') { sum.closedDropped++; continue; }
    const name = (r.name ?? '').trim();
    if (!name || badName(name, placeNames)) { sum.badNameDropped++; continue; }
    const split = (v: string | undefined) => (v ?? '').split(';').map((x) => x.trim()).filter(Boolean);
    places.push({
      id: r.id!, names: [name, (r.name_bn ?? '').trim()].filter(Boolean).map(normName), display: name, cat: r.cat!, ours, sub: subOf(ours, r.cat!), conf, lat, lon,
      phones: split(r.phones), emails: split(r.emails), websites: split(r.websites), socials: split(r.socials), datasets: r.datasets ?? '', locality: r.locality ?? '', address: r.address ?? '',
    });
  }
  sum.candidates = places.length;
  log(`candidates after filters: ${places.length} (outside BD ${sum.outsideBangladesh}, unmapped ${sum.unmappedCategory}, bad names ${sum.badNameDropped}, closed ${sum.closedDropped})`);

  // 2. index existing OSM records (all name variants: name, name:en, name:bn)
  const osmRows = prepare<{ business_id: string; category_id: string; latitude: number; longitude: number; raw_payload: string; name: string }>(
    `SELECT b.business_id, b.category_id, b.name, l.latitude, l.longitude, s.raw_payload FROM businesses b
     JOIN business_locations l USING(business_id) JOIN business_sources s ON s.business_id=b.business_id AND s.source_type='osm'
     WHERE b.business_id LIKE 'osm:%' AND l.latitude IS NOT NULL`).all();
  const grid = new Map<string, Indexed[]>();
  for (const o of osmRows) {
    let tags: Record<string, string> = {};
    try { tags = (JSON.parse(o.raw_payload) as { tags?: Record<string, string> }).tags ?? {}; } catch { /* keep empty */ }
    const names = [...new Set([o.name, tags.name, tags['name:en'], tags['name:bn']].filter((x): x is string => !!x).map(normName))];
    const ix: Indexed = { names, lat: o.latitude, lon: o.longitude, ours: o.category_id, id: o.business_id };
    const k = cell(o.latitude, o.longitude);
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(ix);
  }
  const findOsm = (p: Place): Indexed | null => {
    const ci = Math.floor(p.lat * 1000), cj = Math.floor(p.lon * 1000);
    let best: { ix: Indexed; km: number } | null = null;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const ix of grid.get(`${ci + a}:${cj + b}`) ?? []) {
      const km = kmBetween([p.lat, p.lon], [ix.lat, ix.lon]);
      if (km > 0.1) continue;
      const nameAny = p.names.some((n) => ix.names.some((m) => similar(n, m)));
      const nameExact = p.names.some((n) => ix.names.includes(n));
      const ok = (km <= 0.015 && ix.ours === p.ours) || (km <= 0.05 && nameAny) || nameExact;
      if (ok && (!best || km < best.km)) best = { ix, km };
    }
    return best?.ix ?? null;
  };

  // 3. statements
  const existing = new Set(prepare<{ business_id: string }>(`SELECT business_id FROM businesses WHERE business_id LIKE 'ovt:%'`).all().map((r) => r.business_id));
  const insBiz = prepare(`INSERT INTO businesses (business_id, name, category_id, subcategory_id, record_status, classification_method, classification_note, first_discovered_at, source_confidence) VALUES (?, ?, ?, ?, ?, 'overture_taxonomy', ?, ?, ?)`);
  const insLoc = prepare(`INSERT INTO business_locations (business_id, latitude, longitude, area_method) VALUES (?, ?, ?, 'none')`);
  const insSrc = prepare(`INSERT INTO business_sources (business_id, source_type, source_url, source_reference, raw_payload, fetched_at) VALUES (?, 'overture', ?, ?, ?, ?)`);
  const insContact = prepare(`INSERT INTO business_contacts (business_id, contact_type, value_raw, value_normalized, verification_status, source_url) VALUES (?, ?, ?, ?, ?, ?)`);
  const insSocial = prepare(`INSERT INTO business_social_links (business_id, platform, url, verification_status, source_url) VALUES (?, ?, ?, 'unverified', ?)`);
  const hasContact = prepare<{ x: number }>(`SELECT 1 x FROM business_contacts WHERE business_id=? AND contact_type=? AND (value_normalized=? OR value_raw=?) LIMIT 1`);
  const hasSocial = prepare<{ x: number }>(`SELECT 1 x FROM business_social_links WHERE business_id=? AND platform=? AND lower(url)=lower(?) LIMIT 1`);
  const now = new Date().toISOString();

  const addContacts = (bizId: string, p: Place): number => {
    const src = `overture:place/${p.id}`;
    let added = 0;
    const put = (type: string, raw: string, norm: string | null) => {
      if (norm && hasContact.get(bizId, type, norm, raw)) return;
      insContact.run(bizId, type, raw, norm, norm ? 'unverified' : 'invalid', src);
      added++;
    };
    for (const ph of p.phones.slice(0, 3)) put('phone', ph, normalizeBdPhone(ph));
    for (const em of p.emails.slice(0, 2)) if (EMAIL.test(em)) put('email', em, em.toLowerCase());
    for (const w of p.websites.slice(0, 2)) {
      const u = normalizeUrl(w);
      const sp = u ? socialProfile(u) : null;
      if (sp) { if (!hasSocial.get(bizId, sp.platform, sp.url)) { insSocial.run(bizId, sp.platform, sp.url, src); added++; } }
      else if (u) put('website', w, u);
    }
    for (const s of p.socials.slice(0, 3)) {
      const sp = socialProfile(s);
      if (sp && !hasSocial.get(bizId, sp.platform, sp.url)) { insSocial.run(bizId, sp.platform, sp.url, src); added++; }
    }
    return added;
  };

  // 4. import in batches. Each batch is its own transaction, so progress is visible, a crash loses at most one batch,
  // and a re-run resumes (places already processed are recognised by their Overture id).
  rows.length = 0; // free memory: the raw CSV rows are no longer needed
  const done = new Set(prepare<{ r: string }>(`SELECT source_reference r FROM business_sources WHERE source_type='overture'`).all().map((x) => x.r));
  const placed = new Map<string, { names: string[]; lat: number; lon: number; ours: string; bizId: string }[]>();
  for (const e of prepare<{ business_id: string; name: string; category_id: string; latitude: number; longitude: number }>(
    `SELECT b.business_id, b.name, b.category_id, l.latitude, l.longitude FROM businesses b JOIN business_locations l USING(business_id) WHERE b.business_id LIKE 'ovt:%'`).all()) {
    const k = cell(e.latitude, e.longitude);
    (placed.get(k) ?? placed.set(k, []).get(k)!).push({ names: [normName(e.name)], lat: e.latitude, lon: e.longitude, ours: e.category_id, bizId: e.business_id });
  }
  const limit = Number(process.env.OVT_LIMIT ?? 0);
  const todo = limit > 0 ? places.slice(0, limit) : places;
  const T = { find: 0, dup: 0, write: 0 };
  const t0 = performance.now();
  const BATCH = 2000;

  for (let from = 0; from < todo.length; from += BATCH) {
    transaction(() => {
      for (const p of todo.slice(from, from + BATCH)) {
        const bizId = `ovt:${p.id}`;
        if (existing.has(bizId) || done.has(p.id)) { sum.alreadyImported++; continue; }

        let t = performance.now();
        const osm = findOsm(p);
        T.find += performance.now() - t;
        if (osm) {
          sum.matchedToOsm++;
          t = performance.now();
          insSrc.run(osm.id, `overture:place/${p.id}`, p.id, JSON.stringify({ release: RELEASE, name: p.display, taxonomy: p.cat, confidence: p.conf, datasets: p.datasets }), now);
          sum.contactsAddedToOsm += addContacts(osm.id, p);
          T.write += performance.now() - t;
          continue;
        }
        // duplicate inside Overture: same name within 30 m
        t = performance.now();
        const ci = Math.floor(p.lat * 1000), cj = Math.floor(p.lon * 1000);
        let dupOf: string | null = null;
        for (let a = -1; a <= 1 && !dupOf; a++) for (let b = -1; b <= 1 && !dupOf; b++) for (const q of placed.get(`${ci + a}:${cj + b}`) ?? []) {
          if (q.ours === p.ours && kmBetween([p.lat, p.lon], [q.lat, q.lon]) <= 0.03 && p.names.some((n) => q.names.some((m) => similar(n, m)))) { dupOf = q.bizId; break; }
        }
        T.dup += performance.now() - t;
        t = performance.now();
        if (dupOf) {
          sum.mergedInsideOverture++;
          insSrc.run(dupOf, `overture:place/${p.id}`, p.id, JSON.stringify({ release: RELEASE, name: p.display, taxonomy: p.cat, confidence: p.conf, mergedDuplicate: true }), now);
          addContacts(dupOf, p);
          T.write += performance.now() - t;
          continue;
        }

        const lead = p.conf < 0.8;
        insBiz.run(bizId, p.display, p.ours, p.sub, lead ? 'lead' : 'new',
          lead ? `Lead: Overture confidence ${p.conf.toFixed(2)}; Facebook-derived listing, unverified (taxonomy: ${p.cat})` : null, now, p.conf);
        insLoc.run(bizId, p.lat, p.lon);
        insSrc.run(bizId, `overture:place/${p.id}`, p.id, JSON.stringify({ release: RELEASE, name: p.display, taxonomy: p.cat, confidence: p.conf, datasets: p.datasets, locality: p.locality, address: p.address }), now);
        addContacts(bizId, p);
        T.write += performance.now() - t;
        const rec = { names: p.names, lat: p.lat, lon: p.lon, ours: p.ours, bizId };
        const k = cell(p.lat, p.lon);
        (placed.get(k) ?? placed.set(k, []).get(k)!).push(rec);
        sum.created++;
        if (lead) sum.createdLead++; else sum.createdNew++;
        sum.byCategory[p.ours] = (sum.byCategory[p.ours] ?? 0) + 1;
      }
    });
    const doneCount = Math.min(from + BATCH, todo.length);
    const secs = (performance.now() - t0) / 1000;
    const rate = doneCount / secs;
    log(`  ${doneCount}/${todo.length} places (${(doneCount / todo.length * 100).toFixed(0)}%) | ${rate.toFixed(0)}/s | ETA ${((todo.length - doneCount) / rate / 60).toFixed(1)} min | created ${sum.created}, matched-to-OSM ${sum.matchedToOsm}, merged ${sum.mergedInsideOverture} | time: osm-match ${(T.find / 1000).toFixed(0)}s, dup-check ${(T.dup / 1000).toFixed(0)}s, writes ${(T.write / 1000).toFixed(0)}s`);
  }

  // 5. validation sample, built from the database so it covers every run (the import may be resumed several times)
  sum.validationSample = writeOvertureSample(log);
  writeFileSync(resolve(env.exportDir, 'overture_import_summary.json'), JSON.stringify(sum, null, 2));
  return sum;
}

/**
 * Validation sample for a human reviewer: every Overture-created record in the database, 100 per confidence band,
 * picked by a seeded hash so re-running gives the same rows (plus newcomers) instead of a fresh random draw.
 */
export function writeOvertureSample(log: (m: string) => void = console.log): string {
  const band = (c: number) => (c >= 0.8 ? 'high (>=0.8)' : c >= 0.65 ? 'medium (0.65-0.8)' : 'low (0.5-0.65)');
  const hash = (s: string) => createHash('sha1').update(s).digest('hex');
  const rows = prepare<{ business_id: string; name: string; category_id: string; conf: number; latitude: number; longitude: number; raw_payload: string; source_url: string }>(
    `SELECT b.business_id, b.name, b.category_id, b.source_confidence conf, l.latitude, l.longitude, s.raw_payload, s.source_url
     FROM businesses b JOIN business_locations l USING(business_id)
     JOIN business_sources s ON s.business_id = b.business_id AND s.source_type = 'overture' AND 'ovt:' || s.source_reference = b.business_id
     WHERE b.business_id LIKE 'ovt:%'`).all();
  const contact = prepare<{ value_raw: string }>(`SELECT value_raw FROM business_contacts WHERE business_id=? AND contact_type=? AND source_url=? ORDER BY contact_id LIMIT 1`);
  const q = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const lines = ['BusinessId,Name,OurCategory,OvertureTaxonomy,Confidence,Band,Locality,Address,Phone,Website,CheckOnMap,ReviewerVerdict(real|wrong_category|not_a_business|closed|duplicate),ReviewerNotes'];
  const counts: Record<string, number> = {};
  for (const b of ['high (>=0.8)', 'medium (0.65-0.8)', 'low (0.5-0.65)']) {
    const pick = rows.filter((r) => band(r.conf) === b).sort((x, y) => hash(x.business_id).localeCompare(hash(y.business_id))).slice(0, 100);
    counts[b] = pick.length;
    for (const r of pick) {
      const p = JSON.parse(r.raw_payload) as { taxonomy?: string; locality?: string; address?: string };
      lines.push([r.business_id, q(r.name), r.category_id, p.taxonomy ?? '', r.conf, b, q(p.locality ?? ''), q(p.address ?? ''),
        q(contact.get(r.business_id, 'phone', r.source_url)?.value_raw ?? ''), q(contact.get(r.business_id, 'website', r.source_url)?.value_raw ?? ''),
        `https://www.openstreetmap.org/?mlat=${r.latitude}&mlon=${r.longitude}#map=19/${r.latitude}/${r.longitude}`, '', ''].join(','));
    }
  }
  mkdirSync(env.exportDir, { recursive: true });
  const sampleFile = resolve(env.exportDir, 'overture_validation_sample.csv');
  writeFileSync(sampleFile, '﻿' + lines.join('\r\n') + '\r\n');
  log(`Validation sample: ${Object.entries(counts).map(([b, n]) => `${b} ${n}`).join(', ')} (from ${rows.length} Overture records) -> ${sampleFile}`);
  return sampleFile;
}
