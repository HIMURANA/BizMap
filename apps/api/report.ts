/**
 * Site-selection radius report: what is around a point, how many people live there (estimate) and how crowded the
 * chosen category already is. Every number carries its method; nothing here claims completeness.
 */
import { q, one } from './db.js';

const ANCHORS = ['education', 'hospitals', 'markets', 'transport_hubs', 'banking', 'pharmacies'] as const;

export interface SiteReport {
  point: { lat: number; lon: number }; radius_km: number; generated_at: string;
  totals: { cat: string; label: string; ready: number; lead: number }[];
  focus: null | { cat: string; label: string; ready: number; lead: number; per_10k: number | null;
    nearest: { id: string; name: string; distance_m: number; status: string; phone: string | null }[] };
  anchors: { cat: string; label: string; count: number; nearest: { id: string; name: string; distance_m: number } | null }[];
  population: { estimate: number | null; from_upazilas: number; from_districts: number; covered_share: number;
    /** grid = WorldPop 100 m cells (best); upazila = good; mixed = partly district averages; district_average = rough (cities without upazila polygons) */
    quality: 'grid' | 'upazila' | 'mixed' | 'district_average' | 'none';
    /** area-weighted census estimate, kept for comparison when the grid is used */
    admin_estimate: number | null; source: string;
    areas: { name: string; level: string; population: number; share: number }[]; method: string };
  per_10k_all: number | null;
  caveats: string[];
}

export async function siteReport(lat: number, lon: number, radiusKm: number, focusCat: string | null): Promise<SiteReport> {
  const pt = `ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography`;
  const within = `ST_DWithin(b.geog, ${pt}, $3) AND b.status <> 'needs_review'`;
  const base = [lon, lat, radiusKm * 1000];

  const totals = await q<{ cat: string; label: string; ready: number; lead: number }>(
    `SELECT b.cat, c.label, COUNT(*) FILTER (WHERE b.status <> 'lead')::int AS ready, COUNT(*) FILTER (WHERE b.status = 'lead')::int AS lead
     FROM biz b JOIN biz_categories c ON c.id = b.cat WHERE ${within} GROUP BY b.cat, c.label ORDER BY COUNT(*) DESC`, base);

  const anchors = await Promise.all(ANCHORS.map(async (cat) => {
    const near = await one<{ id: string; name: string; distance_m: number; n: number }>(
      `SELECT b.id, b.name, ST_Distance(b.geog, ${pt})::int AS distance_m, COUNT(*) OVER ()::int AS n
       FROM biz b WHERE ${within} AND b.cat = $4 ORDER BY b.geog <-> ${pt} LIMIT 1`, [...base, cat]);
    const label = (await one<{ label: string }>(`SELECT label FROM biz_categories WHERE id = $1`, [cat]))?.label ?? cat;
    return { cat, label, count: near?.n ?? 0, nearest: near ? { id: near.id, name: near.name, distance_m: near.distance_m } : null };
  }));

  // Population: area-weighted from upazilas that have 2022 population; the rest of the circle falls back to districts.
  const pop = await q<{ name: string; level: string; population: string; share: number }>(
    `WITH circle AS (SELECT ST_Buffer(${pt}, $3)::geometry AS g),
     up AS (SELECT a.name, a.population, a.geom FROM admin_areas a, circle c WHERE a.level = 'upazila' AND a.population IS NOT NULL AND ST_Intersects(a.geom, c.g)),
     covered AS (SELECT ST_Union(ST_Intersection(up.geom, c.g)) AS g FROM up, circle c),
     rest AS (SELECT COALESCE(ST_Difference(c.g, cv.g), c.g) AS g FROM circle c LEFT JOIN covered cv ON true)
     SELECT up.name, 'upazila' AS level, up.population, ST_Area(ST_Intersection(up.geom, c.g)::geography) / NULLIF(ST_Area(up.geom::geography), 0) AS share
       FROM up, circle c
     UNION ALL
     SELECT a.name, 'district', a.population, ST_Area(ST_Intersection(a.geom, r.g)::geography) / NULLIF(ST_Area(a.geom::geography), 0)
       FROM admin_areas a, rest r WHERE a.level = 'district' AND a.population IS NOT NULL AND NOT ST_IsEmpty(r.g) AND ST_Intersects(a.geom, r.g)`, base);
  const coveredShare = (await one<{ s: number }>(
    `WITH circle AS (SELECT ST_Buffer(${pt}, $3)::geometry AS g)
     SELECT COALESCE(ST_Area(ST_Intersection(ST_Union(a.geom), c.g)::geography) / NULLIF(ST_Area(c.g::geography), 0), 0) AS s
     FROM admin_areas a, circle c WHERE a.level = 'upazila' AND a.population IS NOT NULL AND ST_Intersects(a.geom, c.g) GROUP BY c.g`, base))?.s ?? 0;
  const areas = pop.filter((p) => p.share > 0.0005).map((p) => ({ name: p.name, level: p.level, population: Number(p.population), share: Math.min(1, p.share) }));
  const fromUp = areas.filter((a) => a.level === 'upazila').reduce((s, a) => s + a.population * a.share, 0);
  const fromDist = areas.filter((a) => a.level === 'district').reduce((s, a) => s + a.population * a.share, 0);
  const adminEstimate = areas.length ? Math.round(fromUp + fromDist) : null;
  const adminQuality: SiteReport['population']['quality'] = adminEstimate === null ? 'none' : coveredShare >= 0.9 ? 'upazila' : coveredShare >= 0.3 ? 'mixed' : 'district_average';

  // Preferred: WorldPop 100 m grid (people per cell, placed on built-up areas), summed over cells whose centre is inside the circle.
  const grid = await one<{ source: string; year: number; license: string }>(`SELECT source, year, license FROM pop_grid_info WHERE id = 1`);
  const gridSum = grid ? Number((await one<{ s: number | null }>(`SELECT SUM(pop) AS s FROM pop_grid WHERE ST_DWithin(geog, ${pt}, $3)`, base))?.s ?? 0) : null;
  const estimate = gridSum !== null ? Math.round(gridSum) : adminEstimate;
  const quality: SiteReport['population']['quality'] = gridSum !== null ? 'grid' : adminQuality;
  const all = totals.reduce((s, t) => s + t.ready + t.lead, 0);
  const per10k = (n: number) => (estimate && estimate > 0 ? Math.round((n / estimate) * 10000 * 10) / 10 : null);

  let focus: SiteReport['focus'] = null;
  if (focusCat) {
    const t = totals.find((x) => x.cat === focusCat);
    const label = (await one<{ label: string }>(`SELECT label FROM biz_categories WHERE id = $1`, [focusCat]))?.label ?? focusCat;
    const nearest = await q<{ id: string; name: string; distance_m: number; status: string; phone: string | null }>(
      `SELECT b.id, b.name, ST_Distance(b.geog, ${pt})::int AS distance_m, b.status, b.phone FROM biz b
       WHERE ${within} AND b.cat = $4 ORDER BY b.geog <-> ${pt} LIMIT 25`, [...base, focusCat]);
    focus = { cat: focusCat, label, ready: t?.ready ?? 0, lead: t?.lead ?? 0, per_10k: per10k((t?.ready ?? 0) + (t?.lead ?? 0)), nearest };
  }

  return {
    point: { lat, lon }, radius_km: radiusKm, generated_at: new Date().toISOString(),
    totals, focus, anchors, per_10k_all: per10k(all),
    population: {
      estimate, from_upazilas: Math.round(fromUp), from_districts: Math.round(fromDist), covered_share: Math.round(coveredShare * 1000) / 1000, areas, quality,
      admin_estimate: adminEstimate,
      source: grid ? `${grid.source} · ${grid.license}` : '2022 census-based population (UNFPA / US Census Bureau via HDX, CC BY-IGO)',
      method: grid
        ? `Sum of WorldPop ${grid.year} 100 m grid cells whose centre lies inside the circle. WorldPop models where people live from census totals, satellite-mapped buildings and other data, and places people only in built-up areas, so dense neighbourhoods are captured. It is a model: individual cells can be off, but totals over a radius are much closer to reality than district averages.`
        : 'Area-weighted from 2022 census-based population (UNFPA / US Census Bureau via HDX): each upazila contributes its population × the share of its area inside the circle; parts of the circle without upazila population use district figures. Assumes people are spread evenly inside each area, so dense centres are underestimated and empty land overestimated.',
    },
    caveats: [
      ...(quality === 'district_average' || quality === 'mixed' ? ['Population here is mostly a DISTRICT AVERAGE (no upazila boundary with population covers this spot, which is common in city areas). In dense neighbourhoods the real number can be several times higher, so treat people counts and per-10,000 densities as rough.'] : []),
      'Business counts are what open map sources (OpenStreetMap, Overture) contain: real totals are higher, especially for small shops.',
      '"Lead" places come from Overture with confidence below 0.8 (mostly Facebook-derived) and are unconfirmed.',
      'Density per 10,000 people compares places with each other; it is not a market-size measurement.',
    ],
  };
}
