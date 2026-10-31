import { type OsmTagRule, type CategoryConfig, enabledTags } from '../config/categories.js';

/**
 * Overpass QL query builder.
 *
 * Basic structure:
 * [out:json][timeout:60];
 * (
 *   queries here (node, way, relation with tag filters)
 * );
 * out center tags;
 */

/** A bounding box: [minLat, minLon, maxLat, maxLon] */
export type BBox = [minLat: number, minLon: number, maxLat: number, maxLon: number];

function bboxToOverpass(bbox: BBox): string {
  const [minLat, minLon, maxLat, maxLon] = bbox;
  return `(${minLat},${minLon},${maxLat},${maxLon})`;
}

function tagFilter(rule: OsmTagRule): string {
  // If rule.value is specified, match exactly: key="value"
  // If not, match any value: key
  return rule.value ? `["${rule.key}"="${rule.value}"]` : `["${rule.key}"]`;
}

/**
 * Build an Overpass QL query for a category within a geographic bbox.
 *
 * Searches nodes, ways, and relations in parallel (the `nwr` operator in Overpass),
 * requesting element center coordinates for ways/relations, and returning all tags.
 */
export function buildCategoryQuery(category: CategoryConfig, bbox: BBox): string {
  const tags = enabledTags(category);

  if (tags.length === 0) {
    throw new Error(`Category "${category.key}" has no enabled OSM tags`);
  }

  const bbox_str = bboxToOverpass(bbox);
  const filterLines = tags.map((rule) => {
    const filter = tagFilter(rule);
    return `  nwr${filter}${bbox_str};`;
  });

  return [
    '[out:json][timeout:60];',
    '(',
    ...filterLines,
    ');',
    'out center tags;',
  ].join('\n');
}

/**
 * Alternative: query by area name (e.g. "Gulshan") if you have a named OSM boundary.
 * This is more reliable than bbox but requires the area to be well-defined in OSM.
 *
 * Example: [out:json]; area["name"="Dhaka"][boundary="administrative"]->.a; ... (area.a); out ...
 *
 * For now we use bbox since Dhaka neighborhoods aren't consistently named in OSM.
 */
export function buildCategoryQueryByAreaName(category: CategoryConfig, areaName: string): string {
  const tags = enabledTags(category);

  if (tags.length === 0) {
    throw new Error(`Category "${category.key}" has no enabled OSM tags`);
  }

  const filterLines = tags.map((rule) => {
    const filter = tagFilter(rule);
    return `  nwr${filter}(area.search);`;
  });

  return [
    '[out:json][timeout:60];',
    `area["name"="${areaName}"][boundary="administrative"]->.search;`,
    '(',
    ...filterLines,
    ');',
    'out center tags;',
  ].join('\n');
}
