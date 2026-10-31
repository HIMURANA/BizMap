import { prepare, transaction, type Param } from '../db/db.js';
import { haversineKm } from '../geo/boundaries.js';
import { DHAKA_ENVELOPE } from '../geo/nominatim.js';
import { fold, hasDistinctiveName, hostOf } from '../enrich/match.js';
import { normName } from '../discovery/overtureMap.js';

/**
 * Confidence = an INTERNAL data-quality measure (how much independent evidence supports the record).
 * It is not a claim that the business is legitimate. Weights follow the project spec (total 100);
 * weaker evidence earns partial credit, never full credit.
 *
 *  identity  25  named + tag-classified (15); +10 when a verified external source (website/social) corroborates it
 *  location  20  real neighbourhood polygon (20) | approximate area / real upazila (15) | real district (12) | in Dhaka envelope only (10)
 *  website   15  verified (15) | unverified OSM tag (5)
 *  facebook  10  verified (10) | search-snippet match (4) | unverified OSM tag (2)
 *  instagram 10  same as facebook
 *  contact   15  verified phone/email (15) | unverified OSM phone/email (6)
 *  category   5  tag rule (5) | name heuristic (2) | unclassified (0)
 */
export type Band = 'high' | 'medium' | 'low';

export function band(score: number): Band {
  return score >= 85 ? 'high' : score >= 65 ? 'medium' : 'low';
}

interface BizRow {
  business_id: string;
  name: string;
  category_id: string;
  record_status: string;
  classification_method: string | null;
  latitude: number | null;
  longitude: number | null;
  area_name: string | null;
  area_method: string | null;
  admin_district: string | null;
  admin_upazila: string | null;
  source_confidence: number | null;
}
interface ContactRow { business_id: string; contact_type: string; verification_status: string }
interface SocialRow { business_id: string; platform: string; verification_status: string }

function group<T extends { business_id: string }>(rows: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) (m.get(r.business_id) ?? m.set(r.business_id, []).get(r.business_id)!).push(r);
  return m;
}

export function scoreAll(): { total: number; bands: Record<Band, number> } {
  const biz = prepare<BizRow>(
    `SELECT b.business_id, b.name, b.category_id, b.record_status, b.classification_method,
            l.latitude, l.longitude, l.area_name, l.area_method, l.admin_district, l.admin_upazila, b.source_confidence
     FROM businesses b LEFT JOIN business_locations l USING(business_id)`,
  ).all();
  const contacts = group(prepare<ContactRow>(`SELECT business_id, contact_type, verification_status FROM business_contacts`).all());
  const socials = group(prepare<SocialRow>(`SELECT business_id, platform, verification_status FROM business_social_links`).all());
  const e = DHAKA_ENVELOPE;

  const upd = prepare(`UPDATE businesses SET data_confidence=?, confidence_band=?, updated_at=CURRENT_TIMESTAMP WHERE business_id=?`);
  const bands: Record<Band, number> = { high: 0, medium: 0, low: 0 };

  transaction(() => {
    for (const b of biz) {
      const cs = contacts.get(b.business_id) ?? [];
      const ss = socials.get(b.business_id) ?? [];
      const best = (rows: { verification_status: string }[], strong: string[]) =>
        rows.some((r) => r.verification_status === 'verified') ? 'verified'
          : rows.some((r) => strong.includes(r.verification_status)) ? 'search_match'
            : rows.length ? 'unverified' : 'none';

      const web = best(cs.filter((c) => c.contact_type === 'website'), []);
      const fb = best(ss.filter((s) => s.platform === 'facebook'), ['search_match']);
      const ig = best(ss.filter((s) => s.platform === 'instagram'), ['search_match']);
      const reach = cs.filter((c) => (c.contact_type === 'phone' || c.contact_type === 'email') && c.verification_status !== 'invalid');
      const reachStatus = reach.some((c) => c.verification_status === 'verified') ? 'verified' : reach.length ? 'unverified' : 'none';

      let score = 0;
      // Identity: flagged-for-review records get nothing; corroboration needs an independent (non-OSM) source.
      const identityOk = b.record_status !== 'needs_review' && b.classification_method !== 'unclassified' && hasDistinctiveName(b.name);
      // Overture listings below 0.8 source confidence are Facebook-derived leads: weaker identity evidence.
      if (identityOk) score += b.source_confidence !== null && b.source_confidence < 0.8 ? 8 : 15;
      // Only VERIFIED external evidence corroborates identity; search-snippet matches are leads, not proof.
      if (identityOk && (web === 'verified' || fb === 'verified' || ig === 'verified')) score += 10;

      // Location: real neighbourhood polygon 20 | approximate neighbourhood or real upazila polygon 15 | real district polygon 12 |
      // inside the Dhaka envelope but in no known boundary 10 | otherwise 0 (no coordinates, or outside Bangladesh's boundaries).
      if (b.latitude !== null && b.longitude !== null) {
        if (b.area_method === 'osm_polygon') score += 20;
        else if (b.area_name || b.admin_upazila) score += 15;
        else if (b.admin_district) score += 12;
        else if (b.latitude >= e.minLat && b.latitude <= e.maxLat && b.longitude >= e.minLon && b.longitude <= e.maxLon) score += 10;
      }
      score += web === 'verified' ? 15 : web === 'unverified' ? 5 : 0;
      score += fb === 'verified' ? 10 : fb === 'search_match' ? 4 : fb === 'unverified' ? 2 : 0;
      score += ig === 'verified' ? 10 : ig === 'search_match' ? 4 : ig === 'unverified' ? 2 : 0;
      score += reachStatus === 'verified' ? 15 : reachStatus === 'unverified' ? 6 : 0;
      score += b.classification_method === 'tag_rule' || b.classification_method === 'tag_rule+cuisine' ? 5
        : b.classification_method === 'name_heuristic' ? 2 : b.classification_method === 'overture_taxonomy' || b.classification_method === 'manual_ad_library' ? 3 : 0;

      const bd = band(score);
      bands[bd]++;
      upd.run(score, bd, b.business_id);
    }
  });
  return { total: biz.length, bands };
}

/* ------------------------------------------------------------------ duplicates ------------- */

interface DupRow {
  business_id: string;
  name: string;
  category_id: string;
  record_status: string;
  latitude: number | null;
  longitude: number | null;
}

const SAME_SPOT_KM = 0.15;

/**
 * Finds duplicate CANDIDATES (never auto-merges; a human or later rule confirms them):
 *  - name_and_proximity: same normalized name within 150 m
 *  - website_domain / phone / social_url: shared by different businesses at different spots
 * Same normalized name but FAR apart is a branch, not a duplicate: those get a shared parent_business_id.
 * Exact OSM-id duplicates are already impossible (business_id is the OSM element).
 */
/** A key shared by more businesses than this is a chain (agents, dealers) or a platform, not one place recorded twice. */
const MAX_SHARED = 5;
/** Hosts that many unrelated places link to (platforms, map links, mail, link shorteners): never evidence of identity. */
const PLATFORM_HOSTS = /(^|.)(youtube.com|youtu.be|facebook.com|fb.com|instagram.com|linkedin.com|twitter.com|x.com|tiktok.com|wa.me|whatsapp.com|google.com|goo.gl|g.page|maps.app.goo.gl|sites.google.com|blogspot.com|wordpress.com|wikipedia.org|gmail.com|yahoo.com|hotmail.com|outlook.com|findlocality.com|bit.ly|linktr.ee)$/i;

export function findDuplicates(): { candidates: number; branchGroups: number; branchRecords: number; sharedKeysSkipped: number } {
  const rows = prepare<DupRow>(
    `SELECT b.business_id, b.name, b.category_id, b.record_status, l.latitude, l.longitude
     FROM businesses b JOIN business_locations l USING(business_id) WHERE b.record_status != 'needs_review'`,
  ).all().filter((r) => hasDistinctiveName(r.name) && r.latitude !== null && r.longitude !== null);

  const cands: { a: string; b: string; rule: string; score: number; note: string }[] = [];
  const seenPair = new Set<string>();
  const add = (a: string, b: string, rule: string, score: number, note: string) => {
    const k = [a, b].sort().join('|') + rule;
    if (seenPair.has(k)) return;
    seenPair.add(k);
    cands.push({ a, b, rule, score, note });
  };

  // name + proximity, and branch grouping
  const byName = new Map<string, DupRow[]>();
  for (const r of rows) {
    const k = `${r.category_id}|${fold(r.name)}`;
    (byName.get(k) ?? byName.set(k, []).get(k)!).push(r);
  }
  const branchParent = new Map<string, string>();
  let branchGroups = 0;
  for (const g of byName.values()) {
    if (g.length < 2) continue;
    let hasBranch = false;
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        const x = g[i]!, y = g[j]!;
        const km = haversineKm(x.latitude!, x.longitude!, y.latitude!, y.longitude!);
        if (km <= SAME_SPOT_KM) add(x.business_id, y.business_id, 'name_and_proximity', Math.max(0.5, 1 - km / SAME_SPOT_KM / 2), `same name, ${Math.round(km * 1000)} m apart`);
        else hasBranch = true;
      }
    }
    if (hasBranch) {
      branchGroups++;
      const parent = g.map((r) => r.business_id).sort()[0]!;
      for (const r of g) if (r.business_id !== parent) branchParent.set(r.business_id, parent);
    }
  }

  // shared website domain / phone / social URL across a few different businesses
  // a shared contact plus the same (Latin or Bangla) name is strong evidence; a shared contact alone is weak
  let sharedKeysSkipped = 0;
  const nameOf = new Map(prepare<{ business_id: string; name: string }>(`SELECT business_id, name FROM businesses`).all().map((r) => [r.business_id, normName(r.name)]));
  const sameName = (a: string, b: string) => { const x = nameOf.get(a); return !!x && x === nameOf.get(b); };
  const shared = (sql: string, rule: string, key: (v: string) => string | null) => {
    const m = new Map<string, Set<string>>();
    for (const r of prepare<{ business_id: string; v: string }>(sql).all()) {
      const k = key(r.v);
      if (k) (m.get(k) ?? m.set(k, new Set()).get(k)!).add(r.business_id);
    }
    for (const [k, ids] of m) {
      const list = [...ids];
      if (list.length > MAX_SHARED) { sharedKeysSkipped++; continue; }
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!, b = list[j]!, named = sameName(a, b);
        add(a, b, rule, named ? 0.9 : 0.6, `shared ${rule.replace('_', ' ')}: ${k}${named ? ' + same name' : ''}`);
      }
    }
  };
  shared(`SELECT business_id, value_normalized v FROM business_contacts WHERE contact_type='website' AND value_normalized IS NOT NULL`, 'website_domain', (u) => { const h = hostOf(u); return h && !PLATFORM_HOSTS.test(h) ? h : null; });
  shared(`SELECT business_id, value_normalized v FROM business_contacts WHERE contact_type='phone' AND value_normalized IS NOT NULL`, 'phone', (p) => p);
  shared(`SELECT business_id, url v FROM business_social_links WHERE verification_status != 'invalid'`, 'social_url', (u) => u.toLowerCase());

  const ins = prepare(`INSERT INTO duplicate_candidates (business_id_a, business_id_b, match_rule, score, status, reviewer_notes) VALUES (?, ?, ?, ?, 'pending', ?)`);
  transaction(() => {
    // Regenerate unreviewed candidates only; reviewer decisions are kept.
    prepare(`DELETE FROM duplicate_candidates WHERE status='pending'`).run();
    for (const c of cands) ins.run(c.a, c.b, c.rule, c.score, c.note);
    prepare(`UPDATE businesses SET parent_business_id=NULL WHERE parent_business_id IS NOT NULL`).run();
    const setParent = prepare(`UPDATE businesses SET parent_business_id=? WHERE business_id=?`);
    for (const [child, parent] of branchParent) setParent.run(parent as Param, child);
  });
  return { candidates: cands.length, branchGroups, branchRecords: branchParent.size, sharedKeysSkipped };
}
