import { CATEGORY_BY_KEY } from '../config/categories.js';

/**
 * Overture taxonomy -> our categories/subcategories. Rule-based and deliberately conservative:
 * anything not matched is NOT imported (we never force a place into a category).
 * First matching rule wins, so more specific categories come first.
 */
export const OVERTURE_MAP: [string, RegExp][] = [
  ['events', /party_and_event|event_planning|wedding|event_/],
  ['travel', /travel_service|tour_operator|travel_agen|^tour/],
  ['beauty', /beauty|salon|^spa$|barber|hair_|nail_/],
  ['real_estate', /real_estate/],
  ['automotive', /auto_dealer|auto_parts|auto_repair|car_dealer|motorcycle_dealer|motorcycle_repair|vehicle_dealer/],
  ['money_transfer', /money_transfer/],
  ['internet_providers', /internet_service_provider/],
  ['diagnostics', /laborator|diagnostic|radiolog|imaging/],
  ['pharmacies', /^(pharmacy|drugstore)$|pharmac/],
  ['hospitals', /^(hospital|medical_center|clinic|urgent_care|emergency_room|dentist|dental)/],
  ['education', /school|college|university|kindergarten|preschool|^education$|educational_service|coaching|tutor/],
  ['banking', /^(bank|bank_or_credit_union|atm|credit_union)$|^atm/],
  ['markets', /shopping_mall|shopping_center|marketplace|bazaar|^market$/],
  ['transport_hubs', /bus_station|train_station|railway_station|ferry|transit_station/],
  ['hospitality', /^(hotel|lodging|guest_house|hostel|resort|bed_and_breakfast|motel)$/],
  ['fuel_stations', /gas_station|fuel/],
  ['gyms', /^(gym|fitness|yoga|pilates|sports_club|martial_arts)/],
  ['startups', /software|information_technology|it_service|web_design|app_development|data_processing|computer_programming|web_hosting|digital_marketing/],
  ['garments', /garment|apparel_manufactur|textile|clothing_manufactur|knit|sewing|spinning/],
  ['factories', /manufactur|factory|industrial/],
  ['electronics_retail', /electronics_store|mobile_phone|computer_store/],
  ['building_supplies', /furniture_store|hardware_store|home_improvement|building_material/],
  ['apparel_retail', /clothing|shoe|jewelry|tailor|fabric|boutique/],
  ['grocery', /grocery|supermarket|convenience_store|butcher|seafood|fruits|vegetable|dairy/],
  ['restaurants', /restaurant|^cafe$|bakery|coffee|ice_cream|dessert|food_court|fast_food|diner|pizza|burger/],
  ['online_businesses', /online|ecommerce|e_commerce/],
];

export function categoryOf(taxonomy: string): string | null {
  for (const [k, re] of OVERTURE_MAP) if (re.test(taxonomy)) return k;
  return null;
}

/** Subcategory for a (category, taxonomy) pair; null when no safe choice exists. */
export function subOf(category: string, t: string): string | null {
  const pick = (rules: [RegExp, string][], fallback: string | null): string | null => {
    for (const [re, s] of rules) if (re.test(t)) return s;
    return fallback;
  };
  let sub: string | null = null;
  switch (category) {
    case 'restaurants': sub = pick([[/chinese/, 'chinese_restaurant'], [/indian/, 'indian_restaurant'], [/thai/, 'thai_restaurant'], [/bangladesh|bengali/, 'bangladeshi_restaurant'], [/pizza/, 'pizza_shop'], [/burger/, 'burger_shop'], [/fast_food/, 'fast_food'], [/coffee/, 'coffee_shop'], [/^cafe$/, 'cafe'], [/bakery/, 'bakery'], [/ice_cream/, 'ice_cream_shop'], [/dessert/, 'dessert_shop'], [/food_court/, 'food_court']], 'restaurant'); break;
    case 'gyms': sub = pick([[/yoga/, 'yoga_studio']], 'gym'); break;
    case 'grocery': sub = pick([[/supermarket/, 'supermarket'], [/convenience/, 'convenience_store'], [/butcher/, 'meat_shop'], [/seafood/, 'fish_shop'], [/fruit/, 'fruit_shop'], [/vegetable/, 'vegetable_shop'], [/dairy/, 'dairy_shop']], 'grocery_store'); break;
    case 'hospitals': sub = pick([[/^hospital/, 'general_hospital'], [/medical_center/, 'medical_center'], [/dent/, 'dental_clinic']], 'clinic'); break;
    case 'diagnostics': sub = pick([[/patholog/, 'pathology_laboratory'], [/radiolog/, 'radiology_center'], [/imaging/, 'imaging_center']], 'diagnostic_center'); break;
    case 'education': sub = pick([[/coaching|tutor/, 'coaching_center'], [/university/, 'university'], [/college/, 'college'], [/kindergarten|preschool/, 'kindergarten'], [/school/, 'school']], 'education_service'); break;
    case 'pharmacies': sub = 'pharmacy'; break;
    case 'banking': sub = /atm/.test(t) ? 'atm' : 'bank_branch'; break;
    case 'markets': sub = /mall|center/.test(t) ? 'shopping_mall' : 'bazaar_market'; break;
    case 'transport_hubs': sub = pick([[/bus/, 'bus_station'], [/train|railway/, 'railway_station']], 'transit_station'); break;
    case 'hospitality': sub = pick([[/guest_house|bed_and_breakfast/, 'guest_house'], [/hostel/, 'hostel']], 'hotel'); break;
    case 'fuel_stations': sub = 'fuel_station'; break;
    case 'startups': sub = pick([[/digital_marketing/, 'digital_agency'], [/web_design|web_hosting/, 'web_development'], [/app_development/, 'mobile_app_company'], [/software|programming/, 'software_company']], 'it_company'); break;
    case 'garments': sub = pick([[/knit/, 'knitwear_manufacturer'], [/textile|spinning/, 'textile_factory']], 'apparel_manufacturer'); break;
    case 'factories': sub = 'factory_unspecified'; break;
    case 'electronics_retail': sub = pick([[/mobile/, 'mobile_shop'], [/computer/, 'computer_shop']], 'electronics_shop'); break;
    case 'building_supplies': sub = /furniture/.test(t) ? 'furniture_shop' : 'hardware_shop'; break;
    case 'apparel_retail': sub = pick([[/shoe/, 'footwear_shop'], [/jewelry/, 'jewelry_shop'], [/tailor/, 'tailor'], [/fabric/, 'fabric_shop']], 'clothing_shop'); break;
    case 'online_businesses': sub = 'ecommerce_brand'; break;
    case 'events': sub = 'event_planner'; break;
    case 'travel': sub = /tour/.test(t) ? 'tour_operator' : 'travel_agency'; break;
    case 'beauty': sub = pick([[/barber/, 'barber'], [/^spa$/, 'spa']], 'beauty_salon'); break;
    case 'real_estate': sub = 'real_estate_agency'; break;
    case 'automotive': sub = pick([[/parts/, 'auto_parts_store'], [/repair/, 'auto_repair'], [/motorcycle/, 'motorcycle_dealer']], 'auto_dealer'); break;
    case 'money_transfer': sub = 'money_transfer_service'; break;
    case 'internet_providers': sub = 'internet_provider'; break;
  }
  const valid = CATEGORY_BY_KEY.get(category)?.subcategories.some((s) => s.key === sub);
  return sub && valid ? sub : null;
}

/** Latin + Bangla aware normalization (the OSM normalizer strips non-Latin letters, which would erase Bangla names). */
export function normName(s: string): string {
  return s.toLowerCase().normalize('NFKC').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

export function badName(name: string, placeNames: Set<string>): boolean {
  const n = normName(name);
  if (n.length < 3) return true;
  if (/^[\d\s]+$/.test(n)) return true;
  if (placeNames.has(n)) return true; // a place called just "Dhaka" is a location, not a business
  return false;
}
