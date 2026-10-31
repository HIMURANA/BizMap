import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { env } from '../config/env.js';
import { prepare } from '../db/db.js';

export const ATTRIBUTION = '© OpenStreetMap contributors (ODbL 1.0) https://www.openstreetmap.org/copyright';
export const AD_LIBRARY_ATTRIBUTION = 'Collected by hand from the Meta Ad Library (https://www.facebook.com/ads/library): page seen advertising, business not verified';
export const OVERTURE_ATTRIBUTION = 'Overture Maps Foundation, Places release 2026-10-21.0 (data from Meta, Microsoft, Foursquare and others; licences CDLA-Permissive-2.0, Apache-2.0, CC0-1.0) https://overturemaps.org';

interface Row {
  business_id: string; name: string; category_id: string; category_label: string; export_file: string;
  subcategory_label: string | null; description: string | null; record_status: string; classification_note: string | null; source_confidence: number | null;
  data_confidence: number; confidence_band: string | null; parent_business_id: string | null;
  first_discovered_at: string; last_verified_at: string | null;
  osm_element_type: string | null; osm_element_id: number | null; osm_url: string | null;
  latitude: number | null; longitude: number | null; area_name: string | null; area_method: string | null;
  city_corporation: string | null; district: string | null; country: string | null; dhaka_scope: string | null;
  admin_division: string | null; admin_district: string | null; admin_upazila: string | null;
}
interface Contact { business_id: string; contact_type: string; value_raw: string; value_normalized: string | null; verification_status: string; source_url: string | null }
interface Social { business_id: string; platform: string; url: string; verification_status: string; source_url: string | null }

const RANK: Record<string, number> = { verified: 0, search_match: 1, unverified: 2 };
const rank = (s: string) => RANK[s] ?? 3;

/** CSV cell: quotes/newlines escaped; leading = + - @ neutralised so spreadsheets can't run cell content as a formula. */
export function cell(v: unknown, opts: { raw?: boolean } = {}): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (!opts.raw && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(columns: string[], rows: Record<string, unknown>[], rawCols: Set<string> = new Set()): string {
  const lines = [columns.join(',')];
  for (const r of rows) lines.push(columns.map((c) => cell(r[c], { raw: rawCols.has(c) })).join(','));
  // BOM so Excel opens UTF-8 (Bengali names) correctly; the file itself is plain UTF-8.
  return '﻿' + lines.join('\r\n') + '\r\n';
}

export const BUSINESS_COLUMNS = [
  'BusinessId', 'BusinessName', 'BusinessCategory', 'BusinessSubCategory', 'BusinessDescription',
  'FacebookPageUrl', 'WebsiteUrl', 'InstagramUrl', 'PublicBusinessPhone', 'PublicBusinessEmail', 'SourceUrl',
  'OSMElementType', 'OSMElementId', 'OSMUrl', 'Latitude', 'Longitude', 'AdminDivision', 'AdminDistrict', 'AdminUpazila', 'Area', 'AreaMethod', 'DhakaScope', 'CityCorporation', 'District', 'Country',
  'DiscoverySource', 'WebsiteVerificationStatus', 'FacebookVerificationStatus', 'InstagramVerificationStatus', 'ContactVerificationStatus',
  'DataConfidence', 'ConfidenceBand', 'FirstDiscoveredAt', 'LastVerifiedAt', 'RecordStatus', 'SourceLayer', 'SourceConfidence', 'ParentBusinessId', 'ReviewNote',
  'OwnershipEvidence', 'EnrichmentSourceUrls', 'Attribution',
];
const RAW_COLS = new Set(['PublicBusinessPhone', 'Latitude', 'Longitude', 'OSMElementId', 'DataConfidence']);

function load() {
  const rows = prepare<Row>(
    `SELECT b.business_id, b.name, b.category_id, c.label AS category_label, c.export_file, s.label AS subcategory_label,
            b.description, b.record_status, b.classification_note, b.source_confidence, b.data_confidence, b.confidence_band, b.parent_business_id,
            b.first_discovered_at, b.last_verified_at, l.osm_element_type, l.osm_element_id, l.osm_url, l.latitude, l.longitude,
            l.area_name, l.area_method, l.city_corporation, l.district, l.country, l.dhaka_scope, l.admin_division, l.admin_district, l.admin_upazila
     FROM businesses b
     JOIN business_categories c ON c.category_id = b.category_id
     LEFT JOIN business_subcategories s ON s.subcategory_id = b.subcategory_id
     LEFT JOIN business_locations l ON l.business_id = b.business_id
     ORDER BY b.category_id, l.area_name, b.name`,
  ).all();
  const group = <T extends { business_id: string }>(xs: T[]) => {
    const m = new Map<string, T[]>();
    for (const x of xs) (m.get(x.business_id) ?? m.set(x.business_id, []).get(x.business_id)!).push(x);
    return m;
  };
  const contacts = group(prepare<Contact>(`SELECT business_id, contact_type, value_raw, value_normalized, verification_status, source_url FROM business_contacts WHERE verification_status != 'invalid'`).all());
  const socials = group(prepare<Social>(`SELECT business_id, platform, url, verification_status, source_url FROM business_social_links WHERE verification_status != 'invalid'`).all());
  const fc = new Set(prepare<{ business_id: string }>(`SELECT DISTINCT business_id FROM business_sources WHERE source_type LIKE 'firecrawl_%'`).all().map((r) => r.business_id));
  const adl = new Set(prepare<{ business_id: string }>(`SELECT DISTINCT business_id FROM business_sources WHERE source_type = 'meta_ad_library_manual'`).all().map((r) => r.business_id));
  // Ownership (public/private) is never inferred; only an explicit OSM operator:type tag is reported.
  const ownership = new Map<string, string>();
  for (const r of prepare<{ business_id: string; raw_payload: string }>(
    `SELECT s.business_id, s.raw_payload FROM business_sources s JOIN businesses b USING(business_id)
     WHERE s.source_type='osm' AND b.category_id IN ('hospitals','diagnostics')`).all()) {
    try {
      const t = (JSON.parse(r.raw_payload) as { tags?: Record<string, string> }).tags ?? {};
      const v = t['operator:type'] ?? null;
      if (v) ownership.set(r.business_id, `operator:type=${v}`);
    } catch { /* malformed payload: no evidence */ }
  }
  return { rows, contacts, socials, fc, adl, ownership };
}

export interface Flat extends Record<string, unknown> { _missing: string[]; _row: Row }

export function flattenForReports(): Flat[] {
  return flatten();
}

function flatten(): Flat[] {
  const { rows, contacts, socials, fc, adl, ownership } = load();
  return rows.map((r) => {
    const cs = (contacts.get(r.business_id) ?? []).sort((a, b) => rank(a.verification_status) - rank(b.verification_status));
    const ss = (socials.get(r.business_id) ?? []).sort((a, b) => rank(a.verification_status) - rank(b.verification_status));
    const ofType = (t: string) => cs.filter((c) => c.contact_type === t);
    const values = (t: string) => [...new Set(ofType(t).map((c) => c.value_normalized ?? c.value_raw))].join('; ');
    const web = ofType('website')[0];
    const fb = ss.find((s) => s.platform === 'facebook');
    const ig = ss.find((s) => s.platform === 'instagram');
    const reach = [...ofType('phone'), ...ofType('email')];
    const reachStatus = reach.some((c) => c.verification_status === 'verified') ? 'verified' : reach.length ? 'unverified' : '';
    const enrichUrls = [...new Set([...cs, ...ss].filter((x) => x.verification_status === 'verified' && x.source_url && !x.source_url.includes('openstreetmap.org')).map((x) => x.source_url!))].join('; ');

    const layer = r.business_id.startsWith('osm:') ? 'osm' : r.business_id.startsWith('ovt:') ? 'overture' : r.business_id.startsWith('adl:') ? 'ad_library' : 'web';
    const usesOverture = layer === 'overture' || [...cs, ...ss].some((x) => (x.source_url ?? '').startsWith('overture:'));
    const attribution = layer === 'osm' ? (usesOverture ? `${ATTRIBUTION}; contact details also from ${OVERTURE_ATTRIBUTION}` : ATTRIBUTION)
      : layer === 'overture' ? OVERTURE_ATTRIBUTION : layer === 'ad_library' ? AD_LIBRARY_ATTRIBUTION : `${ATTRIBUTION}; web sources as listed in EnrichmentSourceUrls`;
    const flat: Flat = {
      BusinessId: r.business_id, BusinessName: r.name, BusinessCategory: r.category_label, BusinessSubCategory: r.subcategory_label,
      BusinessDescription: r.description, FacebookPageUrl: fb?.url ?? null, WebsiteUrl: web ? (web.value_normalized ?? web.value_raw) : null,
      InstagramUrl: ig?.url ?? null, PublicBusinessPhone: values('phone') || null, PublicBusinessEmail: values('email') || null,
      SourceUrl: r.osm_url, OSMElementType: r.osm_element_type, OSMElementId: r.osm_element_id, OSMUrl: r.osm_url,
      Latitude: r.latitude, Longitude: r.longitude, AdminDivision: r.admin_division, AdminDistrict: r.admin_district, AdminUpazila: r.admin_upazila, Area: r.area_name, AreaMethod: r.area_method, DhakaScope: r.dhaka_scope, CityCorporation: r.city_corporation,
      District: r.district, Country: r.country, DiscoverySource: [layer === 'osm' ? 'OpenStreetMap' : layer === 'overture' ? 'Overture Maps' : layer === 'ad_library' ? 'Meta Ad Library (manual)' : 'Web search (Firecrawl)', layer === 'osm' && usesOverture ? 'Overture Maps (contacts)' : '', adl.has(r.business_id) && layer !== 'ad_library' ? 'Meta Ad Library (manual)' : '', fc.has(r.business_id) && layer !== 'web' ? 'Firecrawl' : ''].filter(Boolean).join('; '),
      WebsiteVerificationStatus: web?.verification_status ?? null, FacebookVerificationStatus: fb?.verification_status ?? null,
      InstagramVerificationStatus: ig?.verification_status ?? null, ContactVerificationStatus: reachStatus || null,
      DataConfidence: r.data_confidence, ConfidenceBand: r.confidence_band, FirstDiscoveredAt: r.first_discovered_at,
      LastVerifiedAt: r.last_verified_at, RecordStatus: r.record_status, ParentBusinessId: r.parent_business_id,
      SourceLayer: layer, SourceConfidence: r.source_confidence, ReviewNote: r.classification_note, OwnershipEvidence: ownership.get(r.business_id) ?? null, EnrichmentSourceUrls: enrichUrls || null, Attribution: attribution,
      _missing: [], _row: r,
    };
    for (const [col, label] of [['WebsiteUrl', 'website'], ['PublicBusinessPhone', 'phone'], ['PublicBusinessEmail', 'email'], ['FacebookPageUrl', 'facebook'], ['InstagramUrl', 'instagram']] as const) {
      if (!flat[col]) flat._missing.push(label);
    }
    return flat;
  });
}

const count = (xs: unknown[]) => xs.length;

export function runExport(): { dir: string; files: Record<string, number> } {
  const dir = env.exportDir;
  mkdirSync(dir, { recursive: true });
  const all = flatten();
  const files: Record<string, number> = {};
  const write = (name: string, content: string, n: number) => { writeFileSync(resolve(dir, name), content, 'utf-8'); files[name] = n; };

  // Records flagged for review are exported separately, never mixed into the category lists.
  const clean = all.filter((f) => f.RecordStatus !== 'needs_review' && f.RecordStatus !== 'lead');
  const flagged = all.filter((f) => f.RecordStatus === 'needs_review');
  const leads = all.filter((f) => f.RecordStatus === 'lead');

  const exportFiles = prepare<{ category_id: string; export_file: string }>(`SELECT category_id, export_file FROM business_categories ORDER BY category_id`).all();
  for (const ef of exportFiles) {
    const rows = clean.filter((f) => f._row.category_id === ef.category_id);
    write(ef.export_file, toCsv(BUSINESS_COLUMNS, rows, RAW_COLS), rows.length);
  }
  // private_hospitals.csv follows the project's required file name but holds ALL hospitals/clinics: OSM has no
  // reliable ownership tag. This companion file lists only records where OSM itself says operator:type=private.
  const privateEvidence = clean.filter((f) => f._row.category_id === 'hospitals' && f.OwnershipEvidence === 'operator:type=private');
  write('hospitals_private_by_osm_tag.csv', toCsv(BUSINESS_COLUMNS, privateEvidence, RAW_COLS), privateEvidence.length);
  write('leads_overture.csv', toCsv(BUSINESS_COLUMNS, leads, RAW_COLS), leads.length);
  write('needs_review.csv', toCsv(BUSINESS_COLUMNS, flagged, RAW_COLS), flagged.length);
  // F-commerce candidates: the online category, plus retail records whose only web presence is a Facebook/Instagram page.
  // A candidate list, not a census: most home-based sellers are on no map and appear only once collected from the Ad Library.
  const FB_RETAIL = new Set(['apparel_retail', 'electronics_retail', 'beauty', 'grocery', 'garments']);
  const fcom = all.filter((f) => f.RecordStatus !== 'needs_review').flatMap((f) => {
    const reason = f._row.category_id === 'online_businesses' ? 'online / F-commerce category'
      : FB_RETAIL.has(f._row.category_id) && (f.FacebookPageUrl || f.InstagramUrl) && !f.WebsiteUrl ? 'retail with Facebook/Instagram page and no website' : null;
    return reason ? [{ ...f, CandidateReason: reason }] : [];
  });
  write('fcommerce_candidates.csv', toCsv([...BUSINESS_COLUMNS, 'CandidateReason'], fcom, RAW_COLS), fcom.length);
  write('all_businesses.csv', toCsv(BUSINESS_COLUMNS, all, RAW_COLS), all.length);
  write('all_businesses.json', JSON.stringify({
    attribution: ATTRIBUTION, generatedAt: new Date().toISOString(),
    note: 'Not an exhaustive directory. Empty values mean no public data was found, not that none exists.',
    businesses: all.map(({ _missing, _row, ...rest }) => { void _missing; void _row; return rest; }),
  }, null, 2), all.length);

  // Missing-information report (one row per exported business).
  const missCols = ['BusinessId', 'BusinessName', 'BusinessCategory', 'Area', 'RecordStatus', 'MissingWebsite', 'MissingPhone', 'MissingEmail', 'MissingFacebook', 'MissingInstagram', 'MissingCount', 'Attribution'];
  write('missing_information_report.csv', toCsv(missCols, clean.map((f) => ({
    BusinessId: f.BusinessId, BusinessName: f.BusinessName, BusinessCategory: f.BusinessCategory, Area: f.Area, RecordStatus: f.RecordStatus,
    MissingWebsite: f._missing.includes('website') ? 'yes' : 'no', MissingPhone: f._missing.includes('phone') ? 'yes' : 'no',
    MissingEmail: f._missing.includes('email') ? 'yes' : 'no', MissingFacebook: f._missing.includes('facebook') ? 'yes' : 'no',
    MissingInstagram: f._missing.includes('instagram') ? 'yes' : 'no', MissingCount: f._missing.length, Attribution: ATTRIBUTION,
  }))), clean.length);

  // Duplicate report.
  const dups = prepare<Record<string, unknown>>(
    `SELECT d.dupe_id AS DuplicateId, d.match_rule AS MatchRule, d.score AS Score, d.status AS Status, d.reviewer_notes AS Notes,
            a.business_id AS BusinessIdA, a.name AS NameA, b.business_id AS BusinessIdB, b.name AS NameB
     FROM duplicate_candidates d JOIN businesses a ON a.business_id=d.business_id_a JOIN businesses b ON b.business_id=d.business_id_b
     ORDER BY d.score DESC`,
  ).all();
  write('duplicate_report.csv', toCsv(['DuplicateId', 'MatchRule', 'Score', 'Status', 'Notes', 'BusinessIdA', 'NameA', 'BusinessIdB', 'NameB'], dups, new Set(['Score'])), dups.length);

  // Coverage report: every configured area, whether searched, and what was found.
  const cats = prepare<{ category_id: string; label: string }>(`SELECT category_id, label FROM business_categories ORDER BY category_id`).all();
  const areas = prepare<{ name: string; classification: string; city_corporation: string; boundary_method: string | null; jobs: number }>(
    `SELECT a.name, a.classification, a.city_corporation, a.boundary_method,
            (SELECT COUNT(*) FROM discovery_jobs j WHERE j.area_name=a.name AND j.status='completed') AS jobs
     FROM discovery_areas a ORDER BY a.classification, a.name`,
  ).all();
  const covRows = areas.map((a) => {
    const row: Record<string, unknown> = {
      Area: a.name, Classification: a.classification, CityCorporation: a.city_corporation, BoundaryMethod: a.boundary_method ?? 'unresolved',
      Searched: a.jobs > 0 ? 'yes' : 'no', CompletedJobs: a.jobs,
    };
    let total = 0;
    for (const c of cats) {
      const n = clean.filter((f) => f.Area === a.name && f._row.category_id === c.category_id).length;
      row[c.category_id] = n; total += n;
    }
    row.TotalExported = total;
    row.Attribution = ATTRIBUTION;
    return row;
  });
  const unassigned = clean.filter((f) => !f.Area);
  if (unassigned.length) {
    const row: Record<string, unknown> = { Area: '(inside Dhaka, no known boundary)', Classification: '', CityCorporation: '', BoundaryMethod: 'none', Searched: 'n/a', CompletedJobs: '' };
    for (const c of cats) row[c.category_id] = unassigned.filter((f) => f._row.category_id === c.category_id).length;
    row.TotalExported = unassigned.length; row.Attribution = ATTRIBUTION;
    covRows.push(row);
  }
  write('coverage_report.csv', toCsv(['Area', 'Classification', 'CityCorporation', 'BoundaryMethod', 'Searched', 'CompletedJobs', ...cats.map((c) => c.category_id), 'TotalExported', 'Attribution'], covRows, new Set(['CompletedJobs'])), covRows.length);

  // Coverage by district: counts per category, completeness, and density per 10,000 people (2022 population estimates).
  const dist = prepare<{ name: string; division: string | null; population: number | null }>(
    `SELECT d.name, v.name AS division, d.population FROM admin_areas d LEFT JOIN admin_areas v ON v.osm_relation_id = d.parent_id WHERE d.level='district' ORDER BY v.name, d.name`,
  ).all();
  const distStats = dist.map((d) => {
    const rows = clean.filter((f) => f.AdminDistrict === d.name);
    const per10k = d.population ? (rows.length / d.population) * 10000 : null;
    return { d, rows, per10k };
  });
  const sortedDensity = distStats.map((x) => x.per10k).filter((x): x is number => x !== null).sort((a, b) => a - b);
  const median = sortedDensity.length ? sortedDensity[Math.floor(sortedDensity.length / 2)]! : 0;
  const rating = (x: number | null) => (x === null ? 'unknown (no population)' : x >= median * 0.75 ? 'adequate vs other districts' : x >= median * 0.35 ? 'thin' : 'very thin');
  const pctOf = (n: number, d: number) => (d ? ((n / d) * 100).toFixed(1) : '');
  const distCols = ['Division', 'District', 'Population2022', 'TotalRecords', 'RecordsPer10kPeople', 'CoverageRating', ...cats.map((c) => c.category_id), 'PctWithPhone', 'PctWithWebsite', 'PctVerifiedAny', 'PopulationSource', 'Attribution'];
  const distRows = distStats.map(({ d, rows, per10k }) => {
    const r: Record<string, unknown> = {
      Division: d.division, District: d.name, Population2022: d.population, TotalRecords: rows.length,
      RecordsPer10kPeople: per10k === null ? null : per10k.toFixed(2), CoverageRating: rating(per10k),
      PctWithPhone: pctOf(rows.filter((f) => f.PublicBusinessPhone).length, rows.length), PctWithWebsite: pctOf(rows.filter((f) => f.WebsiteUrl).length, rows.length),
      PctVerifiedAny: pctOf(rows.filter((f) => f.WebsiteVerificationStatus === 'verified' || f.ContactVerificationStatus === 'verified').length, rows.length),
      PopulationSource: 'UNFPA / US Census Bureau 2022 via HDX (CC BY-IGO)', Attribution: ATTRIBUTION,
    };
    for (const c of cats) r[c.category_id] = rows.filter((f) => f._row.category_id === c.category_id).length;
    return r;
  });
  write('coverage_by_district.csv', toCsv(distCols, distRows, new Set(['Population2022', 'TotalRecords', 'RecordsPer10kPeople', ...cats.map((c) => c.category_id)])), distRows.length);

  // Human-readable summary.
  const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : 'n/a');
  const has = (col: string) => count(clean.filter((f) => f[col]));
  const verified = (col: string) => count(clean.filter((f) => f[col] === 'verified'));
  const bands = (b: string) => count(all.filter((f) => f.ConfidenceBand === b));
  const searched = areas.filter((a) => a.jobs > 0).length;
  const summary = `# Dhaka Business Discovery — Summary

Generated: ${new Date().toISOString()}

> **Attribution:** Business locations and tags are ${ATTRIBUTION}. Data derived from OpenStreetMap is subject to the Open Database License (ODbL); share-alike applies to derived databases.
>
> **Second source:** Records with SourceLayer \`overture\` come from ${OVERTURE_ATTRIBUTION}. They are mostly Facebook-derived listings: contacts are unverified and the listings may be stale. Records below confidence 0.8 are leads.
>
> **This is not an exhaustive directory.** OpenStreetMap coverage in Dhaka is incomplete, and enrichment only finds contact details that businesses have published on their own websites.

## Totals
| | Count |
|---|---|
| All records in database | ${all.length} |
| Exported in category files | ${clean.length} |
| Flagged for review (\`needs_review.csv\`, excluded from category files) | ${flagged.length} |
| Leads: Overture confidence below 0.8 (\`leads_overture.csv\`, excluded from category files) | ${leads.length} |
| By source layer (all records) | OSM ${all.filter((f) => f.SourceLayer === 'osm').length} · Overture ${all.filter((f) => f.SourceLayer === 'overture').length} · web search ${all.filter((f) => f.SourceLayer === 'web').length} · Meta Ad Library (manual) ${all.filter((f) => f.SourceLayer === 'ad_library').length} |
| Duplicate candidates awaiting review | ${dups.length} |

## By category (exported records)
| Category | Records |
|---|---|
${cats.map((c) => `| ${c.label} | ${clean.filter((f) => f._row.category_id === c.category_id).length} |`).join('\n')}

## Data completeness (exported records, n = ${clean.length})
| Field | Present | Verified |
|---|---|---|
| Website | ${has('WebsiteUrl')} (${pct(has('WebsiteUrl'), clean.length)}) | ${verified('WebsiteVerificationStatus')} |
| Public phone | ${has('PublicBusinessPhone')} (${pct(has('PublicBusinessPhone'), clean.length)}) | ${count(clean.filter((f) => f.PublicBusinessPhone && f.ContactVerificationStatus === 'verified'))} |
| Public email | ${has('PublicBusinessEmail')} (${pct(has('PublicBusinessEmail'), clean.length)}) | see ContactVerificationStatus |
| Facebook page | ${has('FacebookPageUrl')} (${pct(has('FacebookPageUrl'), clean.length)}) | ${verified('FacebookVerificationStatus')} |
| Instagram | ${has('InstagramUrl')} (${pct(has('InstagramUrl'), clean.length)}) | ${verified('InstagramVerificationStatus')} |

"Verified" means confirmed from the business's own verified website. Other social links are search-snippet matches or unverified OSM tags — treat them as leads.

## Confidence (internal quality measure, not a claim of legitimacy)
High (85–100): ${bands('high')} · Medium (65–84): ${bands('medium')} · Low (<65): ${bands('low')}

## Geographic coverage
- Dhaka neighbourhoods configured: ${areas.length}; with data: ${searched}. District-level coverage for all 64 districts, with records per 10,000 people, is in \`coverage_by_district.csv\` (ratings are relative to other districts, not to a ground truth).
- Area assignment method is recorded per record (\`AreaMethod\`): \`osm_polygon\` is a real OSM boundary; \`point_radius\` and \`nearest_center\` are approximate; empty means inside Dhaka but in no known boundary.

## Known limitations
- \`private_hospitals.csv\` is the required file name, but it lists **all** hospitals and clinics: OpenStreetMap has no reliable ownership tag and ownership is never inferred. Only records whose OSM tag says \`operator:type=private\` are in \`hospitals_private_by_osm_tag.csv\`; see the \`OwnershipEvidence\` column.
- Dhaka Metropolitan vs Greater Dhaka comes from the real OSM Dhaka Metropolitan polygon (\`DhakaScope\`). OSM has no DNCC/DSCC polygons, so no DNCC/DSCC split is derived from geometry.
- Garment, tech-company and online-business records come from web search, not OSM: they have no coordinates or area, and only the evidence in their source URLs. Facebook/Instagram pages from search results are leads (\`search_match\`), not verified businesses.
- A technology company is not labelled a startup unless supporting evidence was found.
- Generic-name shop records (e.g. "General Store") are in \`needs_review.csv\`, not in category files.
- Empty cells mean no public data was found, not that none exists.
`;
  write('discovery_summary.md', summary, all.length);
  return { dir, files };
}
