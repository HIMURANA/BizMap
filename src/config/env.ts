import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

function list(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

const contact = process.env.CONTACT_EMAIL?.trim();

export const env = {
  /** Only credential the system needs. May be undefined until enrichment runs. */
  firecrawlApiKey: process.env.FIRECRAWL_API_KEY?.trim() || undefined,

  /** Primary first; alternates are only used when the primary fails. */
  overpassEndpoints: list(process.env.OVERPASS_ENDPOINTS, [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ]),

  nominatimEndpoint: process.env.NOMINATIM_ENDPOINT?.trim() || 'https://nominatim.openstreetmap.org',

  /** OSM usage policies require an identifying User-Agent. */
  userAgent: `DhakaBusinessDiscovery/0.1 (non-commercial research${contact ? `; ${contact}` : ''})`,

  dbPath: resolve(process.cwd(), 'data/db/dhaka.sqlite'),
  cacheDir: resolve(process.cwd(), 'data/cache'),
  exportDir: resolve(process.cwd(), 'data/exports'),
} as const;

export function requireFirecrawlKey(): string {
  if (!env.firecrawlApiKey) {
    throw new Error('FIRECRAWL_API_KEY is not set. Add it to .env (see .env.example).');
  }
  return env.firecrawlApiKey;
}
