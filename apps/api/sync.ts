/**
 * Copies business data from the pipeline (SQLite: search_businesses + contacts/socials/sources + admin areas) into Postgres/PostGIS.
 * Full refresh inside ONE transaction: the app keeps serving the previous copy until the new one commits.
 * App data (users, lists, exports...) is never touched. Run: `npm run build-search && npm run pg:sync`.
 */
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import type pg from 'pg';
import { ROOT, migrate, pool, tx } from './db.js';

const PIPELINE_DB = resolve(ROOT, 'data/db/dhaka.sqlite');
const BATCH = 5000;

/** Inserts rows column-wise with unnest(): one round trip per batch, no extra dependency. */
async function insertBatches(c: pg.PoolClient, table: string, cols: { name: string; type: string }[], rows: unknown[][], extraSelect = '') {
  const select = cols.map((col, i) => `$${i + 1}::${col.type}[]`).join(', ');
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const arrays = cols.map((_, j) => chunk.map((r) => r[j] ?? null));
    await c.query(`INSERT INTO ${table} (${cols.map((x) => x.name).join(', ')}${extraSelect ? ', geog' : ''})
      SELECT *${extraSelect} FROM unnest(${select}) AS t(${cols.map((x) => x.name).join(', ')})`, arrays);
  }
}

export async function syncFromPipeline(log: (m: string) => void = console.log) {
  const t0 = Date.now();
  const s = new DatabaseSync(PIPELINE_DB, { readOnly: true });
  const has = s.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='search_businesses'`).get();
  if (!has) throw new Error('search_businesses missing in the pipeline DB: run `npm run build-search` first');

  const biz = s.prepare(`SELECT sb.*, (SELECT osm_url FROM business_locations l WHERE l.business_id = sb.id AND osm_url IS NOT NULL LIMIT 1) AS osm_url FROM search_businesses sb`).all() as Record<string, unknown>[];
  const contacts = s.prepare(`SELECT business_id, contact_type, COALESCE(value_normalized, value_raw) v, verification_status, source_url FROM business_contacts`).all() as Record<string, unknown>[];
  const socials = s.prepare(`SELECT business_id, platform, url, verification_status, source_url FROM business_social_links`).all() as Record<string, unknown>[];
  const sources = s.prepare(`SELECT business_id, source_type, source_url, fetched_at FROM business_sources`).all() as Record<string, unknown>[];
  const cats = s.prepare(`SELECT category_id, label FROM business_categories`).all() as Record<string, unknown>[];
  const subs = s.prepare(`SELECT subcategory_id, category_id, label FROM business_subcategories`).all() as Record<string, unknown>[];
  const admin = s.prepare(`SELECT name, name_bn, level, population, boundary_geojson FROM admin_areas WHERE boundary_geojson IS NOT NULL`).all() as Record<string, unknown>[];
  s.close();
  log(`read pipeline: ${biz.length} businesses, ${contacts.length} contacts, ${socials.length} social links, ${sources.length} sources, ${admin.length} admin areas`);

  await migrate();
  const run = await pool.query(`INSERT INTO sync_runs DEFAULT VALUES RETURNING id`);
  await tx(async (c) => {
    await c.query(`TRUNCATE biz, biz_contacts, biz_socials, biz_sources, biz_categories, biz_subcategories, admin_areas`);
    // category order = by size, so colours and lists are stable and the biggest come first
    const catCount = new Map<string, number>();
    for (const b of biz) catCount.set(String(b.cat), (catCount.get(String(b.cat)) ?? 0) + 1);
    await insertBatches(c, 'biz_categories', [{ name: 'id', type: 'text' }, { name: 'label', type: 'text' }, { name: 'sort', type: 'int' }],
      cats.map((x) => [x.category_id, x.label, -(catCount.get(String(x.category_id)) ?? 0)]));
    await insertBatches(c, 'biz_subcategories', [{ name: 'id', type: 'text' }, { name: 'cat', type: 'text' }, { name: 'label', type: 'text' }],
      subs.map((x) => [x.subcategory_id, x.category_id, x.label]));

    const cols = ['id', 'name', 'name_lc', 'cat', 'sub', 'status', 'layer', 'src_conf', 'score', 'band', 'parent', 'first_seen', 'description',
      'division', 'district', 'upazila', 'area', 'scope', 'phone', 'phone_status', 'email', 'email_status', 'website', 'website_status',
      'facebook', 'facebook_status', 'instagram', 'instagram_status', 'fcommerce', 'osm_url', 'lat', 'lon'];
    const types: Record<string, string> = { src_conf: 'real', score: 'int', fcommerce: 'boolean', lat: 'float8', lon: 'float8' };
    await insertBatches(c, 'biz', cols.map((n) => ({ name: n, type: types[n] ?? 'text' })),
      biz.map((b) => cols.map((n) => (n === 'fcommerce' ? Boolean(b.fcommerce) : b[n]))),
      `, CASE WHEN lon IS NOT NULL AND lat IS NOT NULL THEN ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography END`);

    const T = (n: string) => ({ name: n, type: 'text' });
    await insertBatches(c, 'biz_contacts', ['biz_id', 'type', 'value', 'status', 'source'].map(T), contacts.map((x) => [x.business_id, x.contact_type, x.v, x.verification_status, x.source_url]));
    await insertBatches(c, 'biz_socials', ['biz_id', 'platform', 'url', 'status', 'source'].map(T), socials.map((x) => [x.business_id, x.platform, x.url, x.verification_status, x.source_url]));
    await insertBatches(c, 'biz_sources', ['biz_id', 'type', 'url', 'fetched_at'].map(T), sources.map((x) => [x.business_id, x.source_type, x.source_url, x.fetched_at]));

    for (const a of admin) {
      await c.query(`INSERT INTO admin_areas (name, name_bn, level, population, geom)
        VALUES ($1, $2, $3, $4, ST_Multi(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($5), 4326))))`,
        [a.name, a.name_bn, a.level, a.population, a.boundary_geojson]);
    }
    // ST_MakeValid can return a GeometryCollection for broken rings; keep only the polygon parts
    await c.query(`UPDATE admin_areas SET geom = ST_Multi(ST_CollectionExtract(geom, 3)) WHERE GeometryType(geom) <> 'MULTIPOLYGON'`);
  });
  await pool.query(`ANALYZE biz; ANALYZE biz_contacts; ANALYZE admin_areas`);
  await pool.query(`UPDATE sync_runs SET finished_at = now(), businesses = $2 WHERE id = $1`, [run.rows[0].id, biz.length]);
  log(`synced to Postgres in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  syncFromPipeline().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}
