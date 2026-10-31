import { enabledTags, type CategoryConfig } from '../config/categories.js';
import type { OverpassElement } from './overpassClient.js';

/**
 * Classify an OSM element within a category.
 *
 * Order of evidence (strongest first):
 *   1. The OSM tag rule that matched (e.g. shop=supermarket -> supermarket).
 *   2. Structured refinement tags (cuisine=*).
 *   3. Name keywords (heuristic, recorded as such).
 *
 * Uncertain records are NOT silently classified: they are flagged `needsReview`
 * with the reason, and the pipeline stores them with record_status='needs_review'.
 */

export interface Classification {
  subcategoryKey: string | null;
  method: 'tag_rule' | 'tag_rule+cuisine' | 'name_heuristic' | 'unclassified';
  needsReview: boolean;
  reviewNote: string | null;
}

const CUISINE_TO_SUB: Array<[RegExp, string]> = [
  [/chinese/, 'chinese_restaurant'],
  [/bangladeshi|bengali/, 'bangladeshi_restaurant'],
  [/indian|biryani/, 'indian_restaurant'],
  [/thai/, 'thai_restaurant'],
  [/burger/, 'burger_shop'],
  [/pizza/, 'pizza_shop'],
  [/coffee/, 'coffee_shop'],
  [/ice_cream/, 'ice_cream_shop'],
];

const NAME_KEYWORDS: Record<string, Array<[RegExp, string]>> = {
  restaurants: [
    [/\bcoffee\b/i, 'coffee_shop'],
    [/\bpizza\b/i, 'pizza_shop'],
    [/\bburger\b/i, 'burger_shop'],
    [/\bcater(ing|ers?)\b/i, 'catering_service'],
  ],
  gyms: [
    [/\bwomen'?s?\b|\bladies\b/i, 'womens_gym'],
    [/\byoga\b/i, 'yoga_studio'],
    [/\bswim/i, 'swimming_center'],
  ],
  grocery: [
    [/\bfruit/i, 'fruit_shop'],
    [/\bmini ?mart\b/i, 'mini_mart'],
  ],
  hospitals: [
    [/\beye\b|ophthalm/i, 'eye_hospital'],
    [/\bdental\b|dentist/i, 'dental_clinic'],
    [/cardi|\bheart\b/i, 'cardiology_center'],
    [/\bchild(ren)?\b|paediatric|pediatric/i, 'child_hospital'],
    [/\bwomen'?s?\b|maternity|gynae?c/i, 'womens_hospital'],
  ],
};

export const DIAGNOSTIC_NAME = /diagnostic|pathology|patholog|laborator|lab|imaging|radiolog|x-?ray|ultrasonogra|mri|ct scan|ecg/i;

const GYM_EVIDENCE_SPORTS = new Set(['fitness', 'yoga', 'pilates', 'crossfit', 'bodybuilding', 'swimming']);
const GYM_NAME = /\bgym\b|fitness|\bfit\b|crossfit|bodybuilding|health club|workout/i;

export function classifyElement(element: OverpassElement, category: CategoryConfig): Classification {
  const tags = element.tags ?? {};
  const name = tags.name ?? '';
  const valid = new Set(category.subcategories.map((s) => s.key));

  // 1. Which enabled tag rule matched this element?
  const rule = enabledTags(category).find((r) => tags[r.key] === r.value);
  let sub: string | null = rule && valid.has(rule.defaultSubCategory) ? rule.defaultSubCategory : null;
  let method: Classification['method'] = sub ? 'tag_rule' : 'unclassified';
  let needsReview = false;
  let reviewNote: string | null = null;

  // 2. cuisine refinement (restaurants only)
  if (category.key === 'restaurants' && tags.cuisine) {
    const cuisine = tags.cuisine.toLowerCase();
    const hit = CUISINE_TO_SUB.find(([re]) => re.test(cuisine));
    if (hit && valid.has(hit[1]) && (sub === 'restaurant' || sub === 'fast_food' || sub === 'cafe')) {
      sub = hit[1];
      method = 'tag_rule+cuisine';
    }
  }

  // 2b. Ownership: "private" is assigned ONLY when OSM says so (operator:type=private), never inferred.
  if (category.key === 'hospitals' && (tags['operator:type'] ?? '').toLowerCase() === 'private') {
    if (sub === 'general_hospital' && valid.has('private_hospital')) sub = 'private_hospital';
    else if (sub === 'clinic' && valid.has('private_clinic')) sub = 'private_clinic';
  }

  // 3. name keyword refinement - only upgrades a generic result, always labelled heuristic
  const genericSubs = new Set(['restaurant', 'cafe', 'gym', 'grocery_store', 'clinic', 'general_hospital']);
  if (name && (sub === null || genericSubs.has(sub))) {
    const hit = (NAME_KEYWORDS[category.key] ?? []).find(([re]) => re.test(name));
    if (hit && valid.has(hit[1])) {
      sub = hit[1];
      method = 'name_heuristic';
    }
  }

  // 4. Review flags for tags known to be ambiguous
  if (category.key === 'gyms' && tags.leisure === 'sports_centre') {
    const hasEvidence = GYM_EVIDENCE_SPORTS.has((tags.sport ?? '').toLowerCase()) || GYM_NAME.test(name);
    if (!hasEvidence) {
      needsReview = true;
      reviewNote = 'leisure=sports_centre without fitness evidence (sport tag or gym-like name); may not be a gym';
    }
  }
  if (category.key === 'grocery' && tags.shop === 'general') {
    needsReview = true;
    reviewNote = 'shop=general is often used for non-grocery shops in Bangladesh';
  }
  if (category.key === 'hospitals' && tags.amenity === 'doctors' && !tags.healthcare) {
    needsReview = true;
    reviewNote = 'amenity=doctors is typically an individual practitioner, not a clinic';
  }
  // Diagnostic centers are mostly tagged amenity=clinic/hospital in Dhaka: name-only evidence, always held for review.
  if (category.key === 'diagnostics' && !rule && DIAGNOSTIC_NAME.test(name) && valid.has('diagnostic_center')) {
    sub = 'diagnostic_center';
    method = 'name_heuristic';
    needsReview = true;
    reviewNote = 'classified as a diagnostic center by name only (tagged as clinic/hospital in OSM); needs confirmation';
  }
  if (sub === null) {
    needsReview = true;
    reviewNote = reviewNote ?? 'no enabled tag rule matched';
  }

  return { subcategoryKey: sub, method, needsReview, reviewNote };
}
