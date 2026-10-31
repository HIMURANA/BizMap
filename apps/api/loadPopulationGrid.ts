/**
 * Loads the WorldPop 100 m population grid for Bangladesh into PostGIS (`pop_grid`): one row per populated cell, as the
 * cell centre plus its population. Site reports sum the cells whose centre lies inside the circle.
 * Source: WorldPop R2025A, 2025, constrained (people placed only in built-up areas), CC BY 4.0, data.worldpop.org.
 * Run: `npm run pg:population` (full refresh in one transaction; the previous grid stays usable until it commits).
 */
import { resolve } from 'node:path';
import { fromFile } from 'geotiff';
import { ROOT, migrate, pool, tx } from './db.js';

const FILE = resolve(ROOT, 'data/population_grid/bgd_pop_2025_CN_100m_R2025A_v1.tif');
const INFO = { source: 'WorldPop R2025A, 2025, 100 m constrained (bgd_pop_2025_CN_100m_R2025A_v1)', year: 2025, cell_m: 100, license: 'CC BY 4.0 (WorldPop, University of Southampton)' };
const BAND_ROWS = 512;
const BATCH = 20000;

export async function loadPopulationGrid(log: (m: string) => void = console.log) {
  const t0 = Date.now();
  const tiff = await fromFile(FILE);
  const image = await tiff.getImage();
  const [w, h] = [image.getWidth(), image.getHeight()];
  const [ox, oy] = image.getOrigin() as [number, number];
  const [rx, ry] = image.getResolution() as [number, number];
  const nodata = Number(image.getGDALNoData() ?? -99999);
  if (image.getGeoKeys()?.GeographicTypeGeoKey !== 4326) throw new Error('expected a WGS84 (EPSG:4326) raster');
  log(`raster ${w} x ${h}, cell ${(Math.abs(rx) * 111320).toFixed(0)} m, no-data ${nodata}`);

  await migrate();
  let cells = 0, total = 0;
  await tx(async (c) => {
    await c.query(`TRUNCATE pop_grid`);
    await c.query(`DROP INDEX IF EXISTS pop_grid_geog_idx`); // building the index once at the end is much faster
    let lon: number[] = [], lat: number[] = [], pop: number[] = [];
    const flush = async () => {
      if (!lon.length) return;
      await c.query(`INSERT INTO pop_grid (geog, pop) SELECT ST_SetSRID(ST_MakePoint(x, y), 4326)::geography, p FROM unnest($1::float8[], $2::float8[], $3::real[]) AS t(x, y, p)`, [lon, lat, pop]);
      lon = []; lat = []; pop = [];
    };
    for (let y0 = 0; y0 < h; y0 += BAND_ROWS) {
      const rows = Math.min(BAND_ROWS, h - y0);
      const [band] = (await image.readRasters({ window: [0, y0, w, y0 + rows], samples: [0] })) as unknown as Float32Array[];
      for (let i = 0; i < band!.length; i++) {
        const v = band![i]!;
        if (!(v > 0) || v === nodata) continue; // skip no-data and empty cells
        const x = i % w, y = y0 + Math.floor(i / w);
        lon.push(ox + (x + 0.5) * rx); lat.push(oy + (y + 0.5) * ry); pop.push(v);
        cells++; total += v;
        if (lon.length >= BATCH) await flush();
      }
      await flush();
      log(`  rows ${Math.min(y0 + rows, h)}/${h} · ${cells.toLocaleString()} populated cells · ${Math.round(total).toLocaleString()} people`);
    }
    log('building spatial index…');
    await c.query(`CREATE INDEX pop_grid_geog_idx ON pop_grid USING gist (geog)`);
    await c.query(`INSERT INTO pop_grid_info (id, source, year, cell_m, cells, total, license, loaded_at) VALUES (1, $1, $2, $3, $4, $5, $6, now())
      ON CONFLICT (id) DO UPDATE SET source = EXCLUDED.source, year = EXCLUDED.year, cell_m = EXCLUDED.cell_m, cells = EXCLUDED.cells, total = EXCLUDED.total, license = EXCLUDED.license, loaded_at = now()`,
      [INFO.source, INFO.year, INFO.cell_m, cells, Math.round(total), INFO.license]);
  });
  await pool.query(`ANALYZE pop_grid`);
  log(`loaded ${cells.toLocaleString()} cells, ${Math.round(total).toLocaleString()} people in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  loadPopulationGrid().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}
