-- Central tables for the Dhaka Business Discovery System.
-- SQLite schema: OpenStreetMap primary source, Firecrawl enrichment, local business directory.

-- 1. Business Categories (enumeration; does not change per-data-load).
CREATE TABLE IF NOT EXISTS business_categories (
  category_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  export_file TEXT NOT NULL,
  discovery_mode TEXT NOT NULL,
  notes TEXT
);

-- 2. Business Subcategories.
CREATE TABLE IF NOT EXISTS business_subcategories (
  subcategory_id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES business_categories(category_id),
  label TEXT NOT NULL
);

-- 3. Discovery Areas (geographic scope).
CREATE TABLE IF NOT EXISTS discovery_areas (
  area_id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  classification TEXT NOT NULL, -- 'dhaka_north' | 'dhaka_south' | 'greater_dhaka'
  city_corporation TEXT NOT NULL,
  parent_area TEXT, -- hierarchical reference (e.g. "Sector 1" has parent "Uttara")
  min_lat REAL,
  min_lon REAL,
  max_lat REAL,
  max_lon REAL,
  center_lat REAL,
  center_lon REAL,
  osm_type TEXT, -- 'node', 'way', 'relation'
  osm_id INTEGER,
  boundary_geojson TEXT, -- real OSM polygon (GeoJSON) when boundary_method = 'osm_polygon'
  boundary_method TEXT, -- 'osm_polygon' | 'point_radius' | 'none'
  boundary_resolved BOOLEAN DEFAULT 0, -- whether Nominatim succeeded
  resolved_at TEXT, -- ISO datetime
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_discovery_areas_name ON discovery_areas(name);
CREATE INDEX IF NOT EXISTS idx_discovery_areas_classification ON discovery_areas(classification);

-- 4. Core business records.
CREATE TABLE IF NOT EXISTS businesses (
  business_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category_id TEXT NOT NULL REFERENCES business_categories(category_id),
  subcategory_id TEXT REFERENCES business_subcategories(subcategory_id),
  description TEXT,
  record_status TEXT DEFAULT 'new', -- 'new', 'needs_review', 'verified', 'duplicate', 'invalid'
  classification_method TEXT, -- 'tag_rule' | 'tag_rule+cuisine' | 'name_heuristic' | 'unclassified'
  classification_note TEXT, -- why the record was flagged for review (NULL when not flagged)
  source_confidence REAL, -- confidence reported by the source (e.g. Overture); NULL for OSM
  data_confidence INTEGER DEFAULT 0, -- 0–100
  confidence_band TEXT, -- 'high' (85–100), 'medium' (65–84), 'low' (<65)
  parent_business_id TEXT, -- e.g. a branch references its parent chain
  first_discovered_at TEXT NOT NULL, -- ISO datetime
  last_verified_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_businesses_category ON businesses(category_id);
CREATE INDEX IF NOT EXISTS idx_businesses_status ON businesses(record_status);

-- 5. Business locations (one business can have multiple locations; branches use parent_business_id).
CREATE TABLE IF NOT EXISTS business_locations (
  location_id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id TEXT NOT NULL REFERENCES businesses(business_id),
  osm_element_type TEXT, -- 'node', 'way', 'relation'
  osm_element_id INTEGER,
  osm_url TEXT,
  latitude REAL,
  longitude REAL,
  area_name TEXT, -- reference to discovery_areas.name; NULL = inside Dhaka but in no known boundary
  admin_division TEXT, -- official division (from OSM boundary polygons)
  admin_district TEXT, -- official district
  admin_upazila TEXT, -- official upazila/thana when the point is inside one
  dhaka_scope TEXT, -- 'dhaka_metropolitan' (inside the OSM Dhaka Metropolitan polygon) | 'greater_dhaka' (outside it) | NULL = not yet determined
  area_method TEXT, -- 'osm_polygon' | 'point_radius' (approximate) | 'none'
  city_corporation TEXT,
  district TEXT DEFAULT 'Dhaka',
  country TEXT DEFAULT 'Bangladesh',
  is_branch BOOLEAN DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_business_locations_business ON business_locations(business_id);
CREATE INDEX IF NOT EXISTS idx_business_locations_area ON business_locations(area_name);
CREATE INDEX IF NOT EXISTS idx_business_locations_osm ON business_locations(osm_element_type, osm_element_id);

-- 6. Contact information (phone, email).
CREATE TABLE IF NOT EXISTS business_contacts (
  contact_id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id TEXT NOT NULL REFERENCES businesses(business_id),
  contact_type TEXT NOT NULL, -- 'phone', 'email', 'website'
  value_raw TEXT NOT NULL, -- as found
  value_normalized TEXT, -- cleaned/standardized
  verification_status TEXT DEFAULT 'unverified', -- 'unverified', 'verified', 'invalid'
  source_url TEXT, -- where it was found
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_business_contacts_business ON business_contacts(business_id);
CREATE INDEX IF NOT EXISTS idx_business_contacts_type ON business_contacts(contact_type);

-- 7. Social media links.
CREATE TABLE IF NOT EXISTS business_social_links (
  social_id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id TEXT NOT NULL REFERENCES businesses(business_id),
  platform TEXT NOT NULL, -- 'facebook', 'instagram', 'tiktok', 'website', etc.
  url TEXT NOT NULL,
  verification_status TEXT DEFAULT 'unverified', -- 'unverified', 'search_match' (name+Dhaka in a search snippet only), 'verified' (linked from the business's verified website), 'invalid'
  source_url TEXT, -- where the link was found
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_business_social_links_business ON business_social_links(business_id);
CREATE INDEX IF NOT EXISTS idx_business_social_links_platform ON business_social_links(platform);

-- 8. Source provenance (every data point kept with its origin).
CREATE TABLE IF NOT EXISTS business_sources (
  source_id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id TEXT NOT NULL REFERENCES businesses(business_id),
  source_type TEXT NOT NULL, -- 'osm', 'firecrawl_search', 'firecrawl_scrape', 'directory', etc.
  source_url TEXT, -- the source document/page
  source_reference TEXT, -- OSM ID, Firecrawl result ID, etc.
  raw_payload TEXT, -- JSON of the source data
  fetched_at TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_business_sources_business ON business_sources(business_id);
CREATE INDEX IF NOT EXISTS idx_business_sources_type ON business_sources(source_type);

-- 9. Discovery jobs (track what was searched and when).
CREATE TABLE IF NOT EXISTS discovery_jobs (
  job_id TEXT PRIMARY KEY,
  area_name TEXT NOT NULL,
  category_id TEXT NOT NULL,
  status TEXT NOT NULL, -- 'pending', 'running', 'completed', 'failed'
  endpoint_used TEXT, -- which Overpass endpoint
  started_at TEXT,
  finished_at TEXT,
  element_count INTEGER DEFAULT 0,
  business_count INTEGER DEFAULT 0,
  error_message TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_discovery_jobs_status ON discovery_jobs(status);
CREATE INDEX IF NOT EXISTS idx_discovery_jobs_area ON discovery_jobs(area_name);

-- 10. Discovery logs (detailed trace of what happened).
CREATE TABLE IF NOT EXISTS discovery_logs (
  log_id INTEGER PRIMARY KEY AUTOINCREMENT,
  log_level TEXT NOT NULL, -- 'debug', 'info', 'warn', 'error'
  job_id TEXT REFERENCES discovery_jobs(job_id),
  endpoint TEXT,
  message TEXT NOT NULL,
  detail TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_discovery_logs_job ON discovery_logs(job_id);

-- 11. Duplicate candidates (flagged for review/merge).
CREATE TABLE IF NOT EXISTS duplicate_candidates (
  dupe_id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id_a TEXT NOT NULL REFERENCES businesses(business_id),
  business_id_b TEXT NOT NULL REFERENCES businesses(business_id),
  match_rule TEXT NOT NULL, -- 'osm_id', 'website_domain', 'social_url', 'name_and_proximity', 'phone'
  score REAL, -- 0.0–1.0 confidence in duplication
  status TEXT DEFAULT 'pending', -- 'pending', 'confirmed', 'rejected'
  reviewer_notes TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_duplicate_candidates_a ON duplicate_candidates(business_id_a);
CREATE INDEX IF NOT EXISTS idx_duplicate_candidates_b ON duplicate_candidates(business_id_b);

-- 12. Official administrative areas (divisions, districts, upazilas) with real OSM polygons.
CREATE TABLE IF NOT EXISTS admin_areas (
  osm_relation_id INTEGER PRIMARY KEY,
  level TEXT NOT NULL, -- 'division' | 'district' | 'upazila'
  name TEXT NOT NULL,
  name_bn TEXT,
  iso_code TEXT, -- e.g. BD-13 (divisions/districts)
  parent_id INTEGER, -- osm_relation_id of the containing area (found by geometry)
  min_lat REAL, min_lon REAL, max_lat REAL, max_lon REAL,
  boundary_geojson TEXT,
  population INTEGER, -- NULL until a verified census source is loaded
  population_source TEXT,
  population_year INTEGER,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_level ON admin_areas(level);
