import { getDatabase } from '../db/db.js';

/**
 * Builds `search_businesses`: one flat row per business for the SaaS app (fast filtering, no joins at query time).
 * Rebuilt from the pipeline tables; the app only ever reads it. Run after `quality` (scores) and before starting the app.
 * Contact columns hold the best value per channel (verified first) and its verification status.
 */
const FB_RETAIL = `('apparel_retail','electronics_retail','beauty','grocery','garments')`;

export function buildSearchIndex(): { rows: number } {
  const d = getDatabase();
  const best = (type: string, col: 'value_normalized' | 'verification_status') =>
    `(SELECT ${col === 'value_normalized' ? 'COALESCE(c.value_normalized, c.value_raw)' : 'c.verification_status'} FROM business_contacts c
      WHERE c.business_id = b.business_id AND c.contact_type = '${type}' AND c.verification_status != 'invalid'
      ORDER BY c.verification_status = 'verified' DESC, c.contact_id LIMIT 1)`;
  const social = (platform: string, col: 'url' | 'verification_status') =>
    `(SELECT s.${col} FROM business_social_links s WHERE s.business_id = b.business_id AND s.platform = '${platform}' AND s.verification_status != 'invalid'
      ORDER BY s.verification_status = 'verified' DESC, s.verification_status = 'search_match' DESC, s.social_id LIMIT 1)`;

  d.exec(`
    DROP TABLE IF EXISTS search_businesses_new;
    CREATE TABLE search_businesses_new AS
    SELECT b.business_id AS id, b.name, lower(b.name) AS name_lc, b.category_id AS cat, b.subcategory_id AS sub,
           b.record_status AS status,
           CASE WHEN b.business_id LIKE 'osm:%' THEN 'osm' WHEN b.business_id LIKE 'ovt:%' THEN 'overture'
                WHEN b.business_id LIKE 'adl:%' THEN 'ad_library' ELSE 'web' END AS layer,
           b.source_confidence AS src_conf, COALESCE(b.data_confidence, 0) AS score, b.confidence_band AS band,
           b.parent_business_id AS parent, b.first_discovered_at AS first_seen, b.description,
           l.latitude AS lat, l.longitude AS lon, l.admin_division AS division, l.admin_district AS district,
           l.admin_upazila AS upazila, l.area_name AS area, l.dhaka_scope AS scope,
           ${best('phone', 'value_normalized')} AS phone, ${best('phone', 'verification_status')} AS phone_status,
           ${best('email', 'value_normalized')} AS email, ${best('email', 'verification_status')} AS email_status,
           ${best('website', 'value_normalized')} AS website, ${best('website', 'verification_status')} AS website_status,
           ${social('facebook', 'url')} AS facebook, ${social('facebook', 'verification_status')} AS facebook_status,
           ${social('instagram', 'url')} AS instagram, ${social('instagram', 'verification_status')} AS instagram_status
    FROM businesses b
    LEFT JOIN business_locations l ON l.location_id = (SELECT MIN(location_id) FROM business_locations x WHERE x.business_id = b.business_id);

    ALTER TABLE search_businesses_new ADD COLUMN fcommerce INTEGER DEFAULT 0;
    UPDATE search_businesses_new SET fcommerce = 1
      WHERE status != 'needs_review' AND (cat = 'online_businesses' OR (cat IN ${FB_RETAIL} AND (facebook IS NOT NULL OR instagram IS NOT NULL) AND website IS NULL));

    DROP TABLE IF EXISTS search_businesses;
    ALTER TABLE search_businesses_new RENAME TO search_businesses;
    CREATE UNIQUE INDEX idx_sb_id ON search_businesses(id);
    CREATE INDEX idx_sb_cat ON search_businesses(cat, sub);
    CREATE INDEX idx_sb_district ON search_businesses(district);
    CREATE INDEX idx_sb_division ON search_businesses(division);
    CREATE INDEX idx_sb_status ON search_businesses(status);
    CREATE INDEX idx_sb_latlon ON search_businesses(lat, lon);
    CREATE INDEX idx_sb_score ON search_businesses(score);
    ANALYZE search_businesses;
  `);
  const n = d.prepare(`SELECT COUNT(*) n FROM search_businesses`).get() as { n: number };
  return { rows: n.n };
}
