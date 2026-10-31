/**
 * Central category configuration.
 *
 * Every OSM tag below was checked against taginfo (taginfo.openstreetmap.org and
 * the Geofabrik Bangladesh instance). Tags from the original spec that are NOT in
 * real use are kept here with `enabled: false` and the reason, so they are never
 * silently queried and the decision stays auditable.
 */

export type DiscoveryMode =
  /** OSM is the main discovery source; Firecrawl only enriches. */
  | 'osm-primary'
  /** OSM finds some records but coverage in Dhaka is known to be thin. */
  | 'osm-partial'
  /** OSM cannot identify these; discovery must come from public directories/search. */
  | 'directory-primary';

export interface OsmTagRule {
  key: string;
  value: string;
  /** Subcategory key assigned when this tag matches (may be refined by name heuristics). */
  defaultSubCategory: string;
  enabled: boolean;
  /** Why the rule is disabled (or a coverage note when enabled). */
  note?: string;
  /** Approximate usage count in Bangladesh on taginfo when checked (2026-10-31). */
  bdCount?: number;
}

export interface SubCategory {
  key: string;
  label: string;
}

export interface CategoryConfig {
  key: string;
  label: string;
  exportFile: string;
  mode: DiscoveryMode;
  osmTags: OsmTagRule[];
  subcategories: SubCategory[];
  notes?: string;
}

const sub = (key: string, label: string): SubCategory => ({ key, label });

export const CATEGORIES: CategoryConfig[] = [
  {
    key: 'restaurants',
    label: 'Restaurants',
    exportFile: 'restaurants.csv',
    mode: 'osm-primary',
    osmTags: [
      { key: 'amenity', value: 'restaurant', defaultSubCategory: 'restaurant', enabled: true, bdCount: 4717 },
      { key: 'amenity', value: 'cafe', defaultSubCategory: 'cafe', enabled: true, bdCount: 691 },
      { key: 'amenity', value: 'fast_food', defaultSubCategory: 'fast_food', enabled: true, bdCount: 778 },
      { key: 'amenity', value: 'food_court', defaultSubCategory: 'food_court', enabled: true, bdCount: 180 },
      { key: 'amenity', value: 'ice_cream', defaultSubCategory: 'ice_cream_shop', enabled: true, bdCount: 27 },
      { key: 'amenity', value: 'bar', defaultSubCategory: 'restaurant', enabled: false, bdCount: 38,
        note: 'Bars are not restaurants; only 38 mapped in Bangladesh. Excluded to avoid misclassification.' },
      { key: 'shop', value: 'bakery', defaultSubCategory: 'bakery', enabled: true, bdCount: 362 },
      { key: 'craft', value: 'confectionery', defaultSubCategory: 'dessert_shop', enabled: true, bdCount: 69 },
    ],
    subcategories: [
      sub('restaurant', 'Restaurant'),
      sub('chinese_restaurant', 'Chinese restaurant'),
      sub('bangladeshi_restaurant', 'Bangladeshi restaurant'),
      sub('indian_restaurant', 'Indian restaurant'),
      sub('thai_restaurant', 'Thai restaurant'),
      sub('fast_food', 'Fast food'),
      sub('burger_shop', 'Burger shop'),
      sub('pizza_shop', 'Pizza shop'),
      sub('cafe', 'Cafe'),
      sub('coffee_shop', 'Coffee shop'),
      sub('bakery', 'Bakery'),
      sub('dessert_shop', 'Dessert shop'),
      sub('ice_cream_shop', 'Ice cream shop'),
      sub('food_court', 'Food court'),
      sub('catering_service', 'Catering service'),
    ],
    notes: 'Good coverage in Gulshan/Banani/Dhanmondi; sparse elsewhere. Catering has no reliable OSM tag.',
  },
  {
    key: 'gyms',
    label: 'Gyms and Fitness',
    exportFile: 'gyms.csv',
    mode: 'osm-partial',
    osmTags: [
      { key: 'leisure', value: 'fitness_centre', defaultSubCategory: 'gym', enabled: true, bdCount: 154,
        note: 'Only 154 mapped nationally; most Dhaka gyms are unmapped.' },
      { key: 'leisure', value: 'sports_centre', defaultSubCategory: 'sports_club', enabled: true, bdCount: 79,
        note: 'Broad tag (stadiums, courts). Kept only when sport=fitness/yoga/swimming or name suggests a gym; otherwise flagged for review.' },
      { key: 'leisure', value: 'fitness_station', defaultSubCategory: 'gym', enabled: false, bdCount: 10,
        note: 'Outdoor exercise equipment in parks — not a business. Excluded.' },
      { key: 'sport', value: 'fitness', defaultSubCategory: 'gym', enabled: true, bdCount: 12 },
      { key: 'leisure', value: 'swimming_pool', defaultSubCategory: 'swimming_center', enabled: false, bdCount: 225,
        note: 'Mostly private/hotel pools, not businesses. Excluded by default.' },
      { key: 'leisure', value: 'horse_riding', defaultSubCategory: 'sports_club', enabled: false, bdCount: 0,
        note: '0 uses in Bangladesh.' },
    ],
    subcategories: [
      sub('gym', 'Gym'),
      sub('fitness_center', 'Fitness center'),
      sub('womens_gym', "Women's gym"),
      sub('mens_gym', "Men's gym"),
      sub('yoga_studio', 'Yoga studio'),
      sub('swimming_center', 'Swimming center'),
      sub('sports_club', 'Sports club'),
      sub('personal_training', 'Personal training center'),
    ],
    notes: "Women's/men's gym and personal training cannot be derived from OSM tags; require website evidence.",
  },
  {
    key: 'grocery',
    label: 'Grocery and Retail',
    exportFile: 'grocery_shops.csv',
    mode: 'osm-partial',
    osmTags: [
      { key: 'shop', value: 'supermarket', defaultSubCategory: 'supermarket', enabled: true, bdCount: 811 },
      { key: 'shop', value: 'convenience', defaultSubCategory: 'convenience_store', enabled: true, bdCount: 770 },
      { key: 'shop', value: 'greengrocer', defaultSubCategory: 'vegetable_shop', enabled: true, bdCount: 136 },
      { key: 'shop', value: 'general', defaultSubCategory: 'general_store', enabled: true, bdCount: 753 },
      { key: 'shop', value: 'department_store', defaultSubCategory: 'department_store', enabled: true, bdCount: 411 },
      { key: 'shop', value: 'butcher', defaultSubCategory: 'meat_shop', enabled: true, bdCount: 129 },
      { key: 'shop', value: 'seafood', defaultSubCategory: 'fish_shop', enabled: true, bdCount: 58 },
      { key: 'shop', value: 'dairy', defaultSubCategory: 'dairy_shop', enabled: true, bdCount: 63 },
      { key: 'shop', value: 'health_food', defaultSubCategory: 'grocery_store', enabled: true, bdCount: 19 },
    ],
    subcategories: [
      sub('grocery_store', 'Grocery store'),
      sub('supermarket', 'Supermarket'),
      sub('mini_mart', 'Mini mart'),
      sub('convenience_store', 'Convenience store'),
      sub('general_store', 'General store'),
      sub('vegetable_shop', 'Vegetable shop'),
      sub('fruit_shop', 'Fruit shop'),
      sub('meat_shop', 'Meat shop'),
      sub('fish_shop', 'Fish shop'),
      sub('dairy_shop', 'Dairy shop'),
      sub('department_store', 'Department store'),
    ],
    notes: 'shop=general in Bangladesh (753) is frequently used for non-grocery shops; flagged for review.',
  },
  {
    key: 'hospitals',
    label: 'Hospitals and Clinics',
    exportFile: 'private_hospitals.csv',
    mode: 'osm-primary',
    osmTags: [
      { key: 'amenity', value: 'hospital', defaultSubCategory: 'general_hospital', enabled: true, bdCount: 2211 },
      { key: 'amenity', value: 'clinic', defaultSubCategory: 'clinic', enabled: true, bdCount: 932 },
      { key: 'amenity', value: 'doctors', defaultSubCategory: 'clinic', enabled: true, bdCount: 239,
        note: 'Individual practitioners; kept for review, not auto-published as clinics.' },
      { key: 'healthcare', value: 'hospital', defaultSubCategory: 'general_hospital', enabled: true, bdCount: 1493 },
      { key: 'healthcare', value: 'clinic', defaultSubCategory: 'clinic', enabled: true, bdCount: 470 },
      { key: 'healthcare', value: 'centre', defaultSubCategory: 'medical_center', enabled: true, bdCount: 90 },
      { key: 'healthcare', value: 'speciality', defaultSubCategory: 'specialized_hospital', enabled: false, bdCount: 0,
        note: 'Not a real value (12 uses worldwide). Specialty is expressed via the healthcare:speciality key instead.' },
    ],
    subcategories: [
      sub('private_hospital', 'Private hospital'),
      sub('general_hospital', 'General hospital'),
      sub('specialized_hospital', 'Specialized hospital'),
      sub('clinic', 'Clinic (ownership not verified)'),
      sub('private_clinic', 'Private clinic'),
      sub('medical_center', 'Medical center'),
      sub('eye_hospital', 'Eye hospital'),
      sub('dental_clinic', 'Dental clinic'),
      sub('cardiology_center', 'Cardiology center'),
      sub('child_hospital', 'Child hospital'),
      sub('womens_hospital', "Women's hospital"),
    ],
    notes:
      'OSM has no reliable ownership tag. Records are NEVER labelled "private" from OSM alone; ' +
      'operator:type=private is honoured only when present. Public/private stays NULL otherwise.',
  },
  {
    key: 'diagnostics',
    label: 'Diagnostic Centers',
    exportFile: 'diagnostic_centers.csv',
    mode: 'osm-partial',
    osmTags: [
      { key: 'healthcare', value: 'laboratory', defaultSubCategory: 'medical_laboratory', enabled: true, bdCount: 64 },
      { key: 'healthcare', value: 'diagnostic_centre', defaultSubCategory: 'diagnostic_center', enabled: false, bdCount: 0,
        note: 'Not a real OSM tag: 0 uses worldwide on taginfo.' },
      { key: 'healthcare', value: 'blood_donation', defaultSubCategory: 'blood_testing_center', enabled: false, bdCount: 12,
        note: 'Blood donation points are not diagnostic centers. Excluded.' },
      { key: 'healthcare', value: 'radiology', defaultSubCategory: 'radiology_center', enabled: false, bdCount: 0,
        note: '0 uses in Bangladesh (69 worldwide).' },
    ],
    subcategories: [
      sub('diagnostic_center', 'Diagnostic center'),
      sub('pathology_laboratory', 'Pathology laboratory'),
      sub('medical_laboratory', 'Medical laboratory'),
      sub('imaging_center', 'Imaging center'),
      sub('radiology_center', 'Radiology center'),
      sub('blood_testing_center', 'Blood testing center'),
      sub('medical_testing_center', 'Medical testing center'),
    ],
    notes:
      'Only 64 laboratories mapped nationally. Most Dhaka diagnostic centers are tagged amenity=clinic/hospital; ' +
      'a name heuristic (diagnostic|pathology|laborator|imaging|x-ray) is applied to those and recorded as a heuristic, ' +
      'with lower confidence.',
  },
  {
    key: 'garments',
    label: 'Garment and Textile Companies',
    exportFile: 'garment_companies.csv',
    mode: 'directory-primary',
    osmTags: [
      { key: 'landuse', value: 'industrial', defaultSubCategory: 'garment_factory', enabled: false,
        note: 'Industrial land is a zone, not a company. Never creates a record by itself.' },
      { key: 'shop', value: 'fabric', defaultSubCategory: 'textile_factory', enabled: false, bdCount: 55,
        note: 'Fabric RETAIL shops, not manufacturers. Excluded from the garment category.' },
      { key: 'craft', value: 'tailor', defaultSubCategory: 'apparel_manufacturer', enabled: false, bdCount: 132,
        note: 'Tailors are small craft businesses, not garment companies. Excluded.' },
    ],
    subcategories: [
      sub('garment_factory', 'Garment factory'),
      sub('textile_factory', 'Textile factory'),
      sub('knitwear_manufacturer', 'Knitwear manufacturer'),
      sub('woven_manufacturer', 'Woven garment manufacturer'),
      sub('sweater_manufacturer', 'Sweater manufacturer'),
      sub('apparel_manufacturer', 'Apparel manufacturer'),
      sub('clothing_exporter', 'Clothing exporter'),
      sub('buying_house', 'Buying house'),
      sub('textile_mill', 'Textile mill'),
      sub('accessories_manufacturer', 'Garment accessories manufacturer'),
    ],
    notes: 'Discovery must come from public directories (e.g. BGMEA/BKMEA member lists) via Firecrawl. OSM contributes nothing reliable.',
  },
  {
    key: 'startups',
    label: 'Startups and Technology Companies',
    exportFile: 'startups.csv',
    mode: 'directory-primary',
    osmTags: [
      { key: 'office', value: 'it', defaultSubCategory: 'it_company', enabled: true, bdCount: 107,
        note: 'Only 107 nationally. An IT office is NOT labelled a startup without evidence.' },
      { key: 'office', value: 'software', defaultSubCategory: 'software_company', enabled: true, bdCount: 1 },
      { key: 'office', value: 'consulting', defaultSubCategory: 'technology_consultancy', enabled: false, bdCount: 36,
        note: 'Generic consulting (not necessarily technology). Excluded unless name/website indicates tech.' },
      { key: 'office', value: 'company', defaultSubCategory: 'it_company', enabled: false, bdCount: 644,
        note: 'Far too generic to classify; would flood the category with unrelated companies.' },
    ],
    subcategories: [
      sub('technology_startup', 'Technology startup'),
      sub('software_company', 'Software company'),
      sub('saas_company', 'SaaS company'),
      sub('it_company', 'IT company'),
      sub('fintech_company', 'Fintech company'),
      sub('ai_startup', 'AI startup'),
      sub('digital_agency', 'Digital agency'),
      sub('web_development', 'Web development company'),
      sub('mobile_app_company', 'Mobile application company'),
      sub('technology_consultancy', 'Technology consultancy'),
    ],
    notes: '"Startup" requires supporting evidence (founding year, funding, self-description). Default subcategory is it_company.',
  },
  {
    key: 'online_businesses',
    label: 'F-commerce and Online Businesses',
    exportFile: 'online_businesses.csv',
    mode: 'directory-primary',
    osmTags: [],
    subcategories: [
      sub('facebook_clothing', 'Facebook clothing shop'),
      sub('facebook_cosmetics', 'Facebook cosmetics shop'),
      sub('instagram_fashion', 'Instagram fashion store'),
      sub('online_electronics', 'Online electronics shop'),
      sub('online_grocery', 'Online grocery shop'),
      sub('online_baby_products', 'Online baby product store'),
      sub('online_footwear', 'Online footwear shop'),
      sub('ecommerce_brand', 'Independent e-commerce brand'),
      sub('facebook_food', 'Facebook-based food business'),
      sub('online_gifts', 'Online gift shop'),
    ],
    notes: 'OSM has no data for this category. Discovery is search-driven (Firecrawl) with Dhaka-operation verification.',
  },
  {
    key: 'education',
    label: 'Education (schools, colleges, universities)',
    exportFile: 'education.csv',
    mode: 'osm-primary',
    osmTags: [
      { key: 'amenity', value: 'school', defaultSubCategory: 'school', enabled: true, bdCount: 8794 },
      { key: 'amenity', value: 'college', defaultSubCategory: 'college', enabled: true, bdCount: 1343 },
      { key: 'amenity', value: 'university', defaultSubCategory: 'university', enabled: true, bdCount: 307 },
      { key: 'amenity', value: 'kindergarten', defaultSubCategory: 'kindergarten', enabled: true, bdCount: 251 },
    ],
    subcategories: [
      sub('school', 'School'),
      sub('college', 'College'),
      sub('university', 'University'),
      sub('kindergarten', 'Kindergarten'),
      sub('coaching_center', 'Coaching / training center'),
      sub('education_service', 'Education service (type not specified)'),
    ],
    notes: 'Coaching centers are rarely mapped. Public/private is not inferred.',
  },
  {
    key: 'pharmacies',
    label: 'Pharmacies and medical supply',
    exportFile: 'pharmacies.csv',
    mode: 'osm-primary',
    osmTags: [
      { key: 'amenity', value: 'pharmacy', defaultSubCategory: 'pharmacy', enabled: true, bdCount: 4143 },
      { key: 'healthcare', value: 'pharmacy', defaultSubCategory: 'pharmacy', enabled: true, bdCount: 2144 },
      { key: 'shop', value: 'medical_supply', defaultSubCategory: 'medical_supply_store', enabled: true, bdCount: 108 },
    ],
    subcategories: [
      sub('pharmacy', 'Pharmacy'),
      sub('medical_supply_store', 'Medical supply store'),
    ],
    notes: 'amenity=pharmacy and healthcare=pharmacy are two tags for the same thing; an element carrying both is one record.',
  },
  {
    key: 'banking',
    label: 'Banks and ATMs',
    exportFile: 'banks_atms.csv',
    mode: 'osm-primary',
    osmTags: [
      { key: 'amenity', value: 'bank', defaultSubCategory: 'bank_branch', enabled: true, bdCount: 4047 },
      { key: 'amenity', value: 'atm', defaultSubCategory: 'atm', enabled: true, bdCount: 1451 },
    ],
    subcategories: [
      sub('bank_branch', 'Bank branch'),
      sub('atm', 'ATM'),
    ],
    notes: 'Many ATMs are unnamed in OSM and are skipped (a name is required).',
  },
  {
    key: 'markets',
    label: 'Markets and shopping malls',
    exportFile: 'markets_malls.csv',
    mode: 'osm-primary',
    osmTags: [
      { key: 'amenity', value: 'marketplace', defaultSubCategory: 'bazaar_market', enabled: true, bdCount: 3819 },
      { key: 'shop', value: 'mall', defaultSubCategory: 'shopping_mall', enabled: true, bdCount: 662 },
    ],
    subcategories: [
      sub('bazaar_market', 'Bazaar / market'),
      sub('shopping_mall', 'Shopping mall'),
    ],
    notes: 'Footfall anchors for site selection.',
  },
  {
    key: 'apparel_retail',
    label: 'Clothing, footwear and jewelry shops',
    exportFile: 'apparel_retail.csv',
    mode: 'osm-primary',
    osmTags: [
      { key: 'shop', value: 'clothes', defaultSubCategory: 'clothing_shop', enabled: true, bdCount: 2033 },
      { key: 'shop', value: 'shoes', defaultSubCategory: 'footwear_shop', enabled: true, bdCount: 491 },
      { key: 'shop', value: 'tailor', defaultSubCategory: 'tailor', enabled: true, bdCount: 426 },
      { key: 'craft', value: 'tailor', defaultSubCategory: 'tailor', enabled: true, bdCount: 132 },
      { key: 'shop', value: 'jewelry', defaultSubCategory: 'jewelry_shop', enabled: true, bdCount: 367 },
      { key: 'shop', value: 'fabric', defaultSubCategory: 'fabric_shop', enabled: true, bdCount: 55 },
    ],
    subcategories: [
      sub('clothing_shop', 'Clothing shop'),
      sub('footwear_shop', 'Footwear shop'),
      sub('tailor', 'Tailor'),
      sub('jewelry_shop', 'Jewelry shop'),
      sub('fabric_shop', 'Fabric shop'),
    ],
    notes: 'Retail only. These are shops, not garment manufacturers.',
  },
  {
    key: 'electronics_retail',
    label: 'Electronics, mobile and computer shops',
    exportFile: 'electronics_retail.csv',
    mode: 'osm-primary',
    osmTags: [
      { key: 'shop', value: 'electronics', defaultSubCategory: 'electronics_shop', enabled: true, bdCount: 1361 },
      { key: 'shop', value: 'mobile_phone', defaultSubCategory: 'mobile_shop', enabled: true, bdCount: 695 },
      { key: 'shop', value: 'computer', defaultSubCategory: 'computer_shop', enabled: true, bdCount: 369 },
    ],
    subcategories: [
      sub('electronics_shop', 'Electronics shop'),
      sub('mobile_shop', 'Mobile phone shop'),
      sub('computer_shop', 'Computer shop'),
    ],
    notes: 'Retail only.',
  },
  {
    key: 'building_supplies',
    label: 'Furniture and hardware shops',
    exportFile: 'building_supplies.csv',
    mode: 'osm-primary',
    osmTags: [
      { key: 'shop', value: 'furniture', defaultSubCategory: 'furniture_shop', enabled: true, bdCount: 962 },
      { key: 'shop', value: 'hardware', defaultSubCategory: 'hardware_shop', enabled: true, bdCount: 769 },
      { key: 'shop', value: 'doityourself', defaultSubCategory: 'hardware_shop', enabled: true, bdCount: 27 },
    ],
    subcategories: [
      sub('furniture_shop', 'Furniture shop'),
      sub('hardware_shop', 'Hardware shop'),
    ],
    notes: 'Retail only.',
  },
  {
    key: 'hospitality',
    label: 'Hotels, guest houses and hostels',
    exportFile: 'hospitality.csv',
    mode: 'osm-primary',
    osmTags: [
      { key: 'tourism', value: 'hotel', defaultSubCategory: 'hotel', enabled: true, bdCount: 939 },
      { key: 'tourism', value: 'guest_house', defaultSubCategory: 'guest_house', enabled: true, bdCount: 269 },
      { key: 'tourism', value: 'hostel', defaultSubCategory: 'hostel', enabled: true, bdCount: 502 },
    ],
    subcategories: [
      sub('hotel', 'Hotel'),
      sub('guest_house', 'Guest house'),
      sub('hostel', 'Hostel'),
    ],
    notes: 'Many Bangladeshi "hotels" are restaurants; tag-based only, not verified.',
  },
  {
    key: 'fuel_stations',
    label: 'Fuel stations',
    exportFile: 'fuel_stations.csv',
    mode: 'osm-primary',
    osmTags: [
      { key: 'amenity', value: 'fuel', defaultSubCategory: 'fuel_station', enabled: true, bdCount: 1886 },
    ],
    subcategories: [
      sub('fuel_station', 'Fuel station'),
    ],
    notes: '',
  },
  {
    key: 'factories',
    label: 'Factories (type not verified)',
    exportFile: 'factories.csv',
    mode: 'osm-primary',
    osmTags: [
      { key: 'man_made', value: 'works', defaultSubCategory: 'factory_unspecified', enabled: true, bdCount: 1933 },
    ],
    subcategories: [
      sub('factory_unspecified', 'Factory (product not verified)'),
    ],
    notes: 'man_made=works marks ANY factory. It is NOT a garment company until web evidence says so; use as a lead source only.',
  },
  {
    key: 'transport_hubs',
    label: 'Transport hubs',
    exportFile: 'transport_hubs.csv',
    mode: 'osm-primary',
    osmTags: [
      { key: 'amenity', value: 'bus_station', defaultSubCategory: 'bus_station', enabled: true, bdCount: 688 },
      { key: 'railway', value: 'station', defaultSubCategory: 'railway_station', enabled: true, bdCount: 512 },
      { key: 'public_transport', value: 'station', defaultSubCategory: 'transit_station', enabled: true, bdCount: 1014 },
    ],
    subcategories: [
      sub('bus_station', 'Bus station'),
      sub('railway_station', 'Railway station'),
      sub('transit_station', 'Transit station'),
    ],
    notes: 'Footfall anchors for site selection.',
  },
  {
    key: 'events',
    label: 'Events and party planning',
    exportFile: 'events.csv',
    mode: 'directory-primary',
    osmTags: [],
    subcategories: [
      sub('event_planner', 'Event / party planner'),
    ],
    notes: 'No OSM tag exists. Source: Overture Places (Facebook-derived, unverified leads).',
  },
  {
    key: 'travel',
    label: 'Travel agencies and tour operators',
    exportFile: 'travel.csv',
    mode: 'directory-primary',
    osmTags: [],
    subcategories: [
      sub('travel_agency', 'Travel agency'),
      sub('tour_operator', 'Tour operator'),
    ],
    notes: 'Source: Overture Places (unverified).',
  },
  {
    key: 'beauty',
    label: 'Beauty salons and spas',
    exportFile: 'beauty.csv',
    mode: 'directory-primary',
    osmTags: [],
    subcategories: [
      sub('beauty_salon', 'Beauty salon'),
      sub('barber', 'Barber'),
      sub('spa', 'Spa'),
    ],
    notes: 'Source: Overture Places (unverified).',
  },
  {
    key: 'real_estate',
    label: 'Real estate services',
    exportFile: 'real_estate.csv',
    mode: 'directory-primary',
    osmTags: [],
    subcategories: [
      sub('real_estate_agency', 'Real estate agency / developer'),
    ],
    notes: 'Source: Overture Places (unverified).',
  },
  {
    key: 'automotive',
    label: 'Automotive dealers and parts',
    exportFile: 'automotive.csv',
    mode: 'directory-primary',
    osmTags: [],
    subcategories: [
      sub('auto_dealer', 'Auto dealer'),
      sub('motorcycle_dealer', 'Motorcycle dealer'),
      sub('auto_parts_store', 'Auto parts store'),
      sub('auto_repair', 'Auto repair'),
    ],
    notes: 'Source: Overture Places (unverified).',
  },
  {
    key: 'money_transfer',
    label: 'Money transfer services',
    exportFile: 'money_transfer.csv',
    mode: 'directory-primary',
    osmTags: [],
    subcategories: [
      sub('money_transfer_service', 'Money transfer service'),
    ],
    notes: 'OSM has 1 mapped. Source: Overture Places (unverified).',
  },
  {
    key: 'internet_providers',
    label: 'Internet service providers',
    exportFile: 'internet_providers.csv',
    mode: 'directory-primary',
    osmTags: [],
    subcategories: [
      sub('internet_provider', 'Internet service provider'),
    ],
    notes: 'Source: Overture Places (unverified).',
  },
];

export const CATEGORY_BY_KEY: ReadonlyMap<string, CategoryConfig> = new Map(
  CATEGORIES.map((c) => [c.key, c]),
);

/** Categories that can be discovered through Overpass at all. */
export const OSM_CATEGORIES = CATEGORIES.filter((c) => c.osmTags.some((t) => t.enabled));

export function getCategory(key: string): CategoryConfig {
  const c = CATEGORY_BY_KEY.get(key);
  if (!c) throw new Error(`Unknown category "${key}". Known: ${CATEGORIES.map((x) => x.key).join(', ')}`);
  return c;
}

export function enabledTags(category: CategoryConfig): OsmTagRule[] {
  return category.osmTags.filter((t) => t.enabled);
}
