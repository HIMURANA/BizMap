import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { prepare, transaction } from '../db/db.js';

/**
 * Loads 2022 subnational population (UNFPA / US Census Bureau, via the Humanitarian Data Exchange,
 * licence CC BY-IGO) onto the OSM admin areas. The CSVs use older spellings (Barisal, Chittagong,
 * Comilla, Jessore ...) than OSM (Barishal, Chattogram, Cumilla, Jashore) and a different code system,
 * so areas are matched by name: known renames first, then a small spelling distance. Matching is
 * one-to-one and every non-exact pair is printed so it can be checked by eye. Unmatched areas keep
 * population NULL - nothing is guessed.
 */

export const POP_DIR = resolve(process.cwd(), 'data', 'population');
export const POP_SOURCE = 'UNFPA / US Census Bureau 2022 estimates via HDX (bgd_admpop_2022), CC BY-IGO';

const ALIASES: Record<string, string> = {
  chittagong: 'chattogram', comilla: 'cumilla', jessore: 'jashore', bogra: 'bogura', barisal: 'barishal',
  nawabganj: 'chapai nawabganj', 'cox s bazar': 'coxs bazar', brahamanbaria: 'brahmanbaria', maulvibazar: 'moulvibazar',
  netrokona: 'netrakona', jhalokati: 'jhalakathi', khagrachhari: 'khagrachari', lakshmipur: 'laxmipur', narsingdi: 'narsinghdi',
  munshiganj: 'munshiganj', panchagar: 'panchagarh', jaipurhat: 'joypurhat', rajbari: 'rajbari', sirajganj: 'sirajganj',
};

export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], cur = '', q = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (q) {
      if (c === '"') { if (src[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && src[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.length > 1 || row[0] !== '') rows.push(row); row = []; }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  const [head, ...body] = rows;
  if (!head) return [];
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

export function norm(name: string): string {
  let n = name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  n = n.replace(/\b(hill district|division|district|zila|upazila|upazilla|thana|subdistrict|sbdistrict)\b/g, ' ').replace(/['’`]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
  return ALIASES[n] ?? n;
}

export function distance(a: string, b: string): number {
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
}

interface Pair { osm: number; pop: number; d: number; osmName: string; popName: string }

/** One-to-one greedy match by smallest spelling distance; pairs above the tolerance stay unmatched. */
export function matchNames(osm: { id: number; name: string }[], pop: { key: number; name: string }[]): { pairs: Pair[]; unmatchedOsm: string[]; unmatchedPop: string[] } {
  const cands: Pair[] = [];
  for (const o of osm) for (const p of pop) {
    const a = norm(o.name), b = norm(p.name);
    const d = distance(a, b);
    if (d <= Math.max(2, Math.floor(Math.min(a.length, b.length) * 0.25))) cands.push({ osm: o.id, pop: p.key, d, osmName: o.name, popName: p.name });
  }
  cands.sort((x, y) => x.d - y.d);
  const usedO = new Set<number>(), usedP = new Set<number>(), pairs: Pair[] = [];
  for (const c of cands) if (!usedO.has(c.osm) && !usedP.has(c.pop)) { usedO.add(c.osm); usedP.add(c.pop); pairs.push(c); }
  return {
    pairs,
    unmatchedOsm: osm.filter((o) => !usedO.has(o.id)).map((o) => o.name),
    unmatchedPop: pop.filter((p) => !usedP.has(p.key)).map((p) => p.name),
  };
}

export interface PopSummary { divisions: string; districts: string; upazilas: string; totalPopulationMatchedDistricts: number; notes: string[] }

export function loadPopulation(log: (m: string) => void = console.log): PopSummary {
  for (const f of ['adm1.csv', 'adm2.csv', 'adm3.csv']) if (!existsSync(resolve(POP_DIR, f))) throw new Error(`Missing ${resolve(POP_DIR, f)} (download the HDX bgd_admpop_adm1/2/3_2022.csv files)`);
  const adm1 = parseCsv(readFileSync(resolve(POP_DIR, 'adm1.csv'), 'utf-8'));
  const adm2 = parseCsv(readFileSync(resolve(POP_DIR, 'adm2.csv'), 'utf-8'));
  const adm3 = parseCsv(readFileSync(resolve(POP_DIR, 'adm3.csv'), 'utf-8'));
  const areas = prepare<{ osm_relation_id: number; level: string; name: string; parent_id: number | null }>(`SELECT osm_relation_id, level, name, parent_id FROM admin_areas`).all();
  const set = prepare(`UPDATE admin_areas SET population=?, population_source=?, population_year=2022 WHERE osm_relation_id=?`);
  const notes: string[] = [];
  const show = (label: string, m: ReturnType<typeof matchNames>) => {
    const fuzzy = m.pairs.filter((p) => norm(p.osmName) !== norm(p.popName));
    log(`${label}: ${m.pairs.length} matched (${m.pairs.length - fuzzy.length} exact after known renames, ${fuzzy.length} by spelling distance), unmatched OSM ${m.unmatchedOsm.length}, unmatched census ${m.unmatchedPop.length}`);
    for (const p of fuzzy.slice(0, 12)) log(`    ${p.osmName}  <->  ${p.popName}  (distance ${p.d})`);
  };

  let total = 0;
  const divOsm = areas.filter((a) => a.level === 'division');
  const divM = matchNames(divOsm.map((a) => ({ id: a.osm_relation_id, name: a.name })), adm1.map((r, i) => ({ key: i, name: r.ADM1_NAME ?? '' })));
  show('divisions', divM);
  transaction(() => { for (const p of divM.pairs) set.run(Number(adm1[p.pop]!.T_TL), POP_SOURCE, p.osm); });

  const distOsm = areas.filter((a) => a.level === 'district');
  const distM = matchNames(distOsm.map((a) => ({ id: a.osm_relation_id, name: a.name })), adm2.map((r, i) => ({ key: i, name: r.ADM2_NAME ?? '' })));
  show('districts', distM);
  if (distM.unmatchedOsm.length) notes.push(`unmatched OSM districts: ${distM.unmatchedOsm.join(', ')}`);
  if (distM.unmatchedPop.length) notes.push(`unmatched census districts: ${distM.unmatchedPop.join(', ')}`);
  transaction(() => { for (const p of distM.pairs) { const t = Number(adm2[p.pop]!.T_TL); total += t; set.run(t, POP_SOURCE, p.osm); } });

  // Upazilas are matched only inside the already-matched district, so same-named upazilas elsewhere cannot collide.
  let upMatched = 0, upOsm = 0;
  for (const dp of distM.pairs) {
    const o = areas.filter((a) => a.level === 'upazila' && a.parent_id === dp.osm).map((a) => ({ id: a.osm_relation_id, name: a.name }));
    const censusDistrict = adm2[dp.pop]!.ADM2_PCODE;
    const c = adm3.map((r, i) => ({ r, i })).filter((x) => x.r.ADM2_PCODE === censusDistrict).map((x) => ({ key: x.i, name: x.r.ADM3_NAME ?? '' }));
    const m = matchNames(o, c);
    upOsm += o.length; upMatched += m.pairs.length;
    transaction(() => { for (const p of m.pairs) set.run(Number(adm3[p.pop]!.T_TL), POP_SOURCE, p.osm); });
  }
  log(`upazilas: ${upMatched} of ${upOsm} OSM upazilas matched to census within their district`);
  return {
    divisions: `${divM.pairs.length}/${divOsm.length}`, districts: `${distM.pairs.length}/${distOsm.length}`, upazilas: `${upMatched}/${upOsm}`,
    totalPopulationMatchedDistricts: total, notes,
  };
}
