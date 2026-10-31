/**
 * Neighborhood database for Dhaka.
 *
 * Rather than hardcoding guessed bounding boxes, these are resolved from Nominatim
 * to get authoritative coordinates. Geographic boundaries are kept separate from
 * names per the spec: "Do not assume neighborhood boundaries based solely on their names."
 *
 * Classification:
 *   - "dhaka_north" = DNCC (Dhaka North City Corporation) — Uttara, Gulshan, Banani, Dhanmondi, etc.
 *   - "dhaka_south" = DSCC (Dhaka South City Corporation) — Motijheel, Paltan, Lalbag, etc.
 *   - "greater_dhaka" = areas not in DNCC/DSCC. Kept separate per spec.
 */

export type AreaClassification = 'dhaka_north' | 'dhaka_south' | 'greater_dhaka';

export type CityCorporation = 'DNCC' | 'DSCC' | 'Greater Dhaka' | 'Other';

export interface AreaRecord {
  name: string;
  classification: AreaClassification;
  cityCorporation: CityCorporation;
  /** For hierarchical display (e.g. "Uttara" as parent of "Sector 1"). */
  parentArea?: string;
  /** Nominatim bounding box once resolved [minLat, minLon, maxLat, maxLon]. */
  boundingBox?: [number, number, number, number];
  /** Nominatim center point once resolved [lat, lon]. */
  centerPoint?: [number, number];
  /** OSM element type and ID once resolved (to use in area[] queries). */
  osmType?: 'node' | 'way' | 'relation';
  osmId?: number;
  /** Whether boundary resolution was attempted and succeeded. */
  resolvedAt?: Date;
  /** Arbitrary notes on boundary coverage. */
  notes?: string;
}

/**
 * Generate area entries for a hierarchical parent-child structure.
 * E.g. expandChildren('Uttara', 'dhaka_north', 'DNCC', 1, 18, 'Sector') =>
 *   Uttara (parent), Sector 1, Sector 2, ..., Sector 18 (with parent='Uttara')
 */
function expandChildren(
  parent: string,
  classification: AreaClassification,
  corp: CityCorporation,
  start: number,
  end: number,
  prefix: string,
): AreaRecord[] {
  const result: AreaRecord[] = [{ name: parent, classification, cityCorporation: corp }];
  for (let i = start; i <= end; i++) {
    result.push({
      name: `${prefix} ${i}`,
      classification,
      cityCorporation: corp,
      parentArea: parent,
    });
  }
  return result;
}

/** The seed list of all Dhaka neighborhoods mentioned in the spec. */
export const AREAS: AreaRecord[] = [
  // DHAKA NORTH (DNCC)
  ...expandChildren('Uttara', 'dhaka_north', 'DNCC', 1, 18, 'Sector'),
  { name: 'Gulshan', classification: 'dhaka_north', cityCorporation: 'DNCC', notes: 'OSM has one polygon for all of Gulshan (way 532916425); Gulshan 1/2 are not separately mapped.' },
  { name: 'Gulshan 1', classification: 'dhaka_north', cityCorporation: 'DNCC', parentArea: 'Gulshan', notes: 'No OSM boundary. Records fall under "Gulshan". Not used for discovery.' },
  { name: 'Gulshan 2', classification: 'dhaka_north', cityCorporation: 'DNCC', parentArea: 'Gulshan', notes: 'No OSM boundary. Records fall under "Gulshan". Not used for discovery.' },
  { name: 'Banani', classification: 'dhaka_north', cityCorporation: 'DNCC' },
  { name: 'Baridhara', classification: 'dhaka_north', cityCorporation: 'DNCC' },
  { name: 'Bashundhara Residential Area', classification: 'dhaka_north', cityCorporation: 'DNCC' },
  { name: 'Niketan', classification: 'dhaka_north', cityCorporation: 'DNCC' },
  { name: 'Badda', classification: 'dhaka_north', cityCorporation: 'DNCC' },
  { name: 'Middle Badda', classification: 'dhaka_north', cityCorporation: 'DNCC' },
  { name: 'Merul Badda', classification: 'dhaka_north', cityCorporation: 'DNCC' },
  { name: 'Rampura', classification: 'dhaka_north', cityCorporation: 'DNCC' },
  { name: 'Aftabnagar', classification: 'dhaka_north', cityCorporation: 'DNCC' },
  { name: 'Tejgaon', classification: 'dhaka_north', cityCorporation: 'DNCC' },
  { name: 'Mohakhali', classification: 'dhaka_north', cityCorporation: 'DNCC' },
  { name: 'Karwan Bazar', classification: 'dhaka_north', cityCorporation: 'DNCC' },
  { name: 'Farmgate', classification: 'dhaka_north', cityCorporation: 'DNCC' },
  { name: 'Dhanmondi', classification: 'dhaka_north', cityCorporation: 'DNCC' },
  { name: 'Kalabagan', classification: 'dhaka_north', cityCorporation: 'DNCC' },
  { name: 'Mohammadpur', classification: 'dhaka_north', cityCorporation: 'DNCC' },
  { name: 'Lalmatia', classification: 'dhaka_north', cityCorporation: 'DNCC' },
  { name: 'Shyamoli', classification: 'dhaka_north', cityCorporation: 'DNCC' },
  { name: 'Adabor', classification: 'dhaka_north', cityCorporation: 'DNCC' },
  { name: 'Kallyanpur', classification: 'dhaka_north', cityCorporation: 'DNCC' },
  ...expandChildren('Mirpur', 'dhaka_north', 'DNCC', 1, 14, 'Mirpur'),
  { name: 'Pallabi', classification: 'dhaka_north', cityCorporation: 'DNCC' },
  { name: 'Kafrul', classification: 'dhaka_north', cityCorporation: 'DNCC' },
  { name: 'Agargaon', classification: 'dhaka_north', cityCorporation: 'DNCC' },
  { name: 'Sher-e-Bangla Nagar', classification: 'dhaka_north', cityCorporation: 'DNCC' },
  { name: 'Khilkhet', classification: 'dhaka_north', cityCorporation: 'DNCC' },
  { name: 'Airport area', classification: 'dhaka_north', cityCorporation: 'DNCC', notes: 'Vague boundary; actual airport is Hazrat Shahjalal Intl.' },
  { name: 'Nikunja', classification: 'dhaka_north', cityCorporation: 'DNCC' },

  // DHAKA SOUTH (DSCC)
  { name: 'Motijheel', classification: 'dhaka_south', cityCorporation: 'DSCC' },
  { name: 'Paltan', classification: 'dhaka_south', cityCorporation: 'DSCC' },
  { name: 'Fakirapool', classification: 'dhaka_south', cityCorporation: 'DSCC' },
  { name: 'Kakrail', classification: 'dhaka_south', cityCorporation: 'DSCC' },
  { name: 'Segunbagicha', classification: 'dhaka_south', cityCorporation: 'DSCC' },
  { name: 'Shahbag', classification: 'dhaka_south', cityCorporation: 'DSCC' },
  { name: 'Hatirpool', classification: 'dhaka_south', cityCorporation: 'DSCC' },
  { name: 'Elephant Road', classification: 'dhaka_south', cityCorporation: 'DSCC' },
  { name: 'New Market', classification: 'dhaka_south', cityCorporation: 'DSCC' },
  { name: 'Wari', classification: 'dhaka_south', cityCorporation: 'DSCC' },
  { name: 'Gendaria', classification: 'dhaka_south', cityCorporation: 'DSCC' },
  { name: 'Sutrapur', classification: 'dhaka_south', cityCorporation: 'DSCC' },
  { name: 'Jatrabari', classification: 'dhaka_south', cityCorporation: 'DSCC' },
  { name: 'Dhania', classification: 'dhaka_south', cityCorporation: 'DSCC' },
  { name: 'Lalbagh', classification: 'dhaka_south', cityCorporation: 'DSCC' },
  { name: 'Chawkbazar', classification: 'dhaka_south', cityCorporation: 'DSCC' },
  { name: 'Bangshal', classification: 'dhaka_south', cityCorporation: 'DSCC' },
  { name: 'Kotwali', classification: 'dhaka_south', cityCorporation: 'DSCC' },
  { name: 'Kamrangirchar', classification: 'dhaka_south', cityCorporation: 'DSCC' },
  { name: 'Shantinagar', classification: 'dhaka_south', cityCorporation: 'DSCC' },
  { name: 'Malibagh', classification: 'dhaka_south', cityCorporation: 'DSCC' },
  { name: 'Khilgaon', classification: 'dhaka_south', cityCorporation: 'DSCC' },
  { name: 'Basabo', classification: 'dhaka_south', cityCorporation: 'DSCC' },
  { name: 'Mugda', classification: 'dhaka_south', cityCorporation: 'DSCC' },
  { name: 'Manda', classification: 'dhaka_south', cityCorporation: 'DSCC' },
  { name: 'Jurain', classification: 'dhaka_south', cityCorporation: 'DSCC' },
  { name: 'Postogola', classification: 'dhaka_south', cityCorporation: 'DSCC' },

  // GREATER DHAKA (outside DNCC/DSCC)
  { name: 'Tongi', classification: 'greater_dhaka', cityCorporation: 'Greater Dhaka', notes: 'Gazipur border area.' },
  { name: 'Gazipur border areas', classification: 'greater_dhaka', cityCorporation: 'Greater Dhaka', notes: 'Vaague boundary; for reference only.' },
  { name: 'Savar border areas', classification: 'greater_dhaka', cityCorporation: 'Greater Dhaka', notes: 'Vague boundary; for reference only.' },
  { name: 'Keraniganj border areas', classification: 'greater_dhaka', cityCorporation: 'Greater Dhaka', notes: 'Vague boundary; for reference only.' },
];

export function getArea(name: string): AreaRecord | undefined {
  return AREAS.find((a) => a.name === name);
}

export function getAreasByClassification(classification: AreaClassification): AreaRecord[] {
  return AREAS.filter((a) => a.classification === classification);
}

export function getPilotAreas(): AreaRecord[] {
  return AREAS.filter((a) => ['Gulshan', 'Banani', 'Baridhara'].includes(a.name));
}
