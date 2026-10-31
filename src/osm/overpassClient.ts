import { env } from '../config/env.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

export interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export interface OverpassResponse {
  version: number;
  generator: string;
  elements: OverpassElement[];
  remark?: string;
}

interface CachedResponse {
  timestamp: number;
  query: string;
  response: OverpassResponse;
  endpoint: string;
}

class OverpassClient {
  private endpoints: string[];
  private currentEndpointIndex = 0;
  private cacheDir: string;
  private maxRetries = 3;
  private initialBackoffMs = 2000;
  private maxBackoffMs = 30000;

  constructor() {
    this.endpoints = env.overpassEndpoints;
    this.cacheDir = resolve(env.cacheDir, 'overpass');
    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  private getQueryHash(query: string): string {
    return createHash('sha256').update(query).digest('hex').slice(0, 12);
  }

  private getCachePath(query: string): string {
    return resolve(this.cacheDir, `${this.getQueryHash(query)}.json`);
  }

  private loadFromCache(query: string): OverpassResponse | null {
    const path = this.getCachePath(query);
    try {
      if (!existsSync(path)) return null;
      const cached: CachedResponse = JSON.parse(readFileSync(path, 'utf-8'));
      const ageMinutes = (Date.now() - cached.timestamp) / 1000 / 60;
      if (ageMinutes > 7 * 24 * 60) {
        // Cache older than 7 days is stale
        return null;
      }
      return cached.response;
    } catch {
      return null;
    }
  }

  private saveToCache(query: string, response: OverpassResponse, endpoint: string): void {
    const path = this.getCachePath(query);
    const cached: CachedResponse = {
      timestamp: Date.now(),
      query,
      response,
      endpoint,
    };
    try {
      writeFileSync(path, JSON.stringify(cached, null, 2));
    } catch (error) {
      console.warn(`Failed to cache Overpass response: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async executeQuery(query: string, endpoint: string): Promise<OverpassResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000); // 90 second timeout

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'User-Agent': env.userAgent,
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal,
      });

      if (!response.ok) {
        // 429 = too many requests; treat as temporary
        if (response.status === 429) {
          throw new Error(`HTTP 429: rate limited`);
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const text = await response.text();
      let result: OverpassResponse;
      try {
        result = JSON.parse(text) as OverpassResponse;
      } catch {
        // Busy servers answer 200 with an HTML/XML error page instead of JSON.
        const msg = /<strong[^>]*>Error<\/strong>:\s*([^<]+)/.exec(text)?.[1]?.trim();
        throw new Error(`non-JSON response${msg ? `: ${msg}` : ''}`);
      }
      // Timeouts / memory exhaustion come back as HTTP 200 + remark + partial/empty elements.
      // Treat as failure so it is neither cached nor recorded as "0 businesses".
      if (result.remark && /runtime error|timed out|out of memory/i.test(result.remark)) {
        throw new Error(`Overpass runtime error: ${result.remark}`);
      }
      return result;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Endpoint that served the most recent successful query ('cache' when served from disk). */
  lastEndpoint: string | null = null;

  private currentEndpoint(): string {
    const ep = this.endpoints[this.currentEndpointIndex % this.endpoints.length];
    if (!ep) throw new Error('No Overpass endpoints configured');
    return ep;
  }

  private nextEndpoint(): void {
    this.currentEndpointIndex++;
    if (this.currentEndpointIndex >= this.endpoints.length) {
      this.currentEndpointIndex = 0;
    }
  }

  async query(query: string): Promise<OverpassResponse> {
    // Try cache first
    const cached = this.loadFromCache(query);
    if (cached) {
      console.log(`[cache hit] Overpass query (${this.getQueryHash(query)})`);
      this.lastEndpoint = 'cache';
      return cached;
    }

    let lastError: Error | null = null;
    let backoffMs = this.initialBackoffMs;

    // Try each endpoint with exponential backoff
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      const endpoint = this.currentEndpoint();
      console.log(`[attempt ${attempt + 1}/${this.maxRetries}] Overpass query on ${endpoint.split('/')[2]}`);

      try {
        const result = await this.executeQuery(query, endpoint);
        this.saveToCache(query, result, endpoint);
        this.lastEndpoint = endpoint;
        console.log(`✓ Overpass query returned ${result.elements.length} elements`);
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.warn(`  ✗ Attempt ${attempt + 1} failed: ${lastError.message}`);

        if (attempt < this.maxRetries - 1) {
          // Try next endpoint, then back off if we've cycled through all
          this.nextEndpoint();
          if (this.currentEndpointIndex === 0) {
            // Cycled through all endpoints; wait before retrying
            const wait = Math.min(backoffMs, this.maxBackoffMs);
            console.log(`  Waiting ${wait}ms before retry...`);
            await new Promise((resolve) => setTimeout(resolve, wait));
            backoffMs *= 2;
          }
        }
      }
    }

    throw new Error(`Overpass query failed after ${this.maxRetries} attempts: ${lastError?.message || 'unknown'}`);
  }
}

export const overpass = new OverpassClient();
