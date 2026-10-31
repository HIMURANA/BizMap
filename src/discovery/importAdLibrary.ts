import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { prepare, transaction } from '../db/db.js';
import { parseCsv } from '../geo/population.js';
import { normalizeBdPhone } from '../osm/extractContacts.js';
import { socialProfile } from '../enrich/match.js';

/**
 * Imports F-commerce sellers that a PERSON collected by hand from the Meta Ad Library (see data/fcommerce/HOW_TO_COLLECT.md).
 * Nothing here fetches Facebook: the CSV is the only input.
 *  - each row must have a page name, a Facebook/Instagram PAGE link, a product type, the search keyword, the date seen and the collector;
 *  - a page already linked to an existing record only adds an 'meta_ad_library_manual' source to that record (no duplicate);
 *  - new pages become 'online_businesses' records with business_id 'adl:<hash of page url>', status 'new' (seen advertising),
 *    social link 'unverified'; no coordinates (a page-stated district is kept as text, never as a location);
 *  - rows that fail a check are written to <file>.rejected.csv with the reason.
 */

const PRODUCT_TYPES = new Set(['facebook_clothing', 'facebook_cosmetics', 'instagram_fashion', 'online_electronics', 'online_grocery',
  'online_baby_products', 'online_footwear', 'ecommerce_brand', 'facebook_food', 'online_gifts', 'other']);
const REQUIRED = ['PageName', 'PageUrl', 'ProductType', 'SearchKeyword', 'SeenOn', 'CollectedBy'];

export interface AdLibraryImportSummary {
  file: string; rows: number; created: number; addedToExisting: number; alreadyImported: number; rejected: number; rejectedFile: string | null;
}

export function importAdLibrary(file: string, log: (m: string) => void = console.log): AdLibraryImportSummary {
  const rows = parseCsv(readFileSync(file, 'utf-8'));
  const sum: AdLibraryImportSummary = { file, rows: rows.length, created: 0, addedToExisting: 0, alreadyImported: 0, rejected: 0, rejectedFile: null };
  const rejects: { row: Record<string, string>; reason: string }[] = [];

  const bySocial = prepare<{ business_id: string }>(`SELECT business_id FROM business_social_links WHERE platform=? AND lower(url)=lower(?) LIMIT 1`);
  const hasSource = prepare<{ x: number }>(`SELECT 1 x FROM business_sources WHERE business_id=? AND source_type='meta_ad_library_manual' AND source_url=? LIMIT 1`);
  const exists = prepare<{ x: number }>(`SELECT 1 x FROM businesses WHERE business_id=?`);
  const insBiz = prepare(`INSERT INTO businesses (business_id, name, category_id, subcategory_id, description, record_status, classification_method, classification_note, first_discovered_at)
    VALUES (?, ?, 'online_businesses', ?, ?, 'new', 'manual_ad_library', ?, ?)`);
  const insSrc = prepare(`INSERT INTO business_sources (business_id, source_type, source_url, source_reference, raw_payload, fetched_at) VALUES (?, 'meta_ad_library_manual', ?, ?, ?, ?)`);
  const insSocial = prepare(`INSERT INTO business_social_links (business_id, platform, url, verification_status, source_url) VALUES (?, ?, ?, 'unverified', 'meta_ad_library_manual')`);
  const insPhone = prepare(`INSERT INTO business_contacts (business_id, contact_type, value_raw, value_normalized, verification_status, source_url) VALUES (?, 'phone', ?, ?, 'unverified', 'meta_ad_library_manual')`);
  const now = new Date().toISOString();

  transaction(() => {
    for (const r of rows) {
      const v = (k: string) => (r[k] ?? '').trim();
      const missing = REQUIRED.filter((k) => !v(k));
      if (missing.length) { rejects.push({ row: r, reason: `missing ${missing.join(', ')}` }); continue; }
      if (/delete this row/i.test(v('PageName'))) { rejects.push({ row: r, reason: 'template example row' }); continue; }
      const sp = socialProfile(v('PageUrl'));
      if (!sp) { rejects.push({ row: r, reason: 'PageUrl is not a Facebook/Instagram page link (posts, ads, profile.php and groups are not accepted)' }); continue; }
      const type = v('ProductType').toLowerCase();
      if (!PRODUCT_TYPES.has(type)) { rejects.push({ row: r, reason: `unknown ProductType "${v('ProductType')}"` }); continue; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v('SeenOn')) || Number.isNaN(Date.parse(v('SeenOn')))) { rejects.push({ row: r, reason: 'SeenOn must be YYYY-MM-DD' }); continue; }
      const phoneRaw = v('PhoneShownOnPage');
      const phone = phoneRaw ? normalizeBdPhone(phoneRaw) : null;
      if (phoneRaw && !phone) { rejects.push({ row: r, reason: `PhoneShownOnPage "${phoneRaw}" is not a valid Bangladeshi number` }); continue; }

      const payload = JSON.stringify({ pageName: v('PageName'), productType: type, searchKeyword: v('SearchKeyword'), seenOn: v('SeenOn'),
        statedDistrict: v('StatedDistrict') || null, collectedBy: v('CollectedBy'), notes: v('Notes') || null, file });
      const existing = bySocial.get(sp.platform, sp.url)?.business_id;
      if (existing) {
        if (hasSource.get(existing, sp.url)) { sum.alreadyImported++; continue; }
        insSrc.run(existing, sp.url, v('SeenOn'), payload, now);
        if (phone) insPhone.run(existing, phoneRaw, phone);
        sum.addedToExisting++;
        continue;
      }
      const id = `adl:${createHash('sha1').update(sp.url.toLowerCase()).digest('hex').slice(0, 16)}`;
      if (exists.get(id)) { sum.alreadyImported++; continue; }
      const stated = v('StatedDistrict');
      insBiz.run(id, v('PageName'), type === 'other' ? null : type, stated ? `Location stated on the page: ${stated} (not verified)` : null,
        `Seen advertising in the Meta Ad Library on ${v('SeenOn')} (keyword "${v('SearchKeyword')}", collected by hand by ${v('CollectedBy')}); business not verified`, now);
      insSocial.run(id, sp.platform, sp.url);
      insSrc.run(id, sp.url, v('SeenOn'), payload, now);
      if (phone) insPhone.run(id, phoneRaw, phone);
      sum.created++;
    }
  });

  sum.rejected = rejects.length;
  if (rejects.length) {
    const cols = [...REQUIRED, 'StatedDistrict', 'PhoneShownOnPage', 'Notes'];
    const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
    sum.rejectedFile = file.replace(/\.csv$/i, '') + '.rejected.csv';
    writeFileSync(sum.rejectedFile, '﻿' + [['Reason', ...cols].join(','), ...rejects.map((x) => [q(x.reason), ...cols.map((c) => q(x.row[c] ?? ''))].join(','))].join('\r\n') + '\r\n');
  }
  log(`Ad Library import: ${sum.rows} rows -> ${sum.created} new records, ${sum.addedToExisting} matched existing records, ${sum.alreadyImported} already imported, ${sum.rejected} rejected${sum.rejectedFile ? ` (see ${sum.rejectedFile})` : ''}`);
  return sum;
}
