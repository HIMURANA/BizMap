import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { env, requireFirecrawlKey } from '../config/env.js';

const BASE = 'https://api.firecrawl.dev/v2';

export interface SearchHit {
  url: string;
  title: string;
  description: string;
}

export interface ScrapeResult {
  url: string;
  markdown: string;
  links: string[];
  title: string;
  statusCode: number | null;
}

/**
 * Minimal Firecrawl v2 client: disk cache (a request is never paid for twice), a hard credit
 * ceiling, conservative pacing and exponential backoff on temporary failures.
 *
 * Credits: search reports `creditsUsed`; scrape does not always, so scrape is counted as 1 credit
 * (the documented base cost) and the real balance should be compared with `firecrawl credit-usage`.
 */
export class FirecrawlClient {
  private cacheDir = resolve(env.cacheDir, 'firecrawl');
  private lastCallAt = 0;
  creditsSpent = 0;
  cacheHits = 0;
  calls = 0;

  constructor(private readonly creditCeiling: number) {
    if (!existsSync(this.cacheDir)) mkdirSync(this.cacheDir, { recursive: true });
  }

  get remainingBudget(): number {
    return this.creditCeiling - this.creditsSpent;
  }

  private cachePath(key: string): string {
    return resolve(this.cacheDir, `${createHash('sha256').update(key).digest('hex').slice(0, 20)}.json`);
  }

  private async post(path: string, body: object, estimatedCredits: number): Promise<Record<string, unknown>> {
    const key = `${path}|${JSON.stringify(body)}`;
    const file = this.cachePath(key);
    if (existsSync(file)) {
      this.cacheHits++;
      return JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
    }
    if (estimatedCredits > this.remainingBudget) {
      throw new Error(`Credit ceiling reached (${this.creditsSpent}/${this.creditCeiling}); refusing ${path}`);
    }

    let backoff = 2000;
    let lastError = 'unknown';
    for (let attempt = 1; attempt <= 3; attempt++) {
      // Pace calls (~1 per 3s; the plan allows few concurrent jobs and rate-limits bursts) to stay well inside the plan's concurrency limit.
      const wait = this.lastCallAt + 3000 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastCallAt = Date.now();
      try {
        const res = await fetch(`${BASE}${path}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${requireFirecrawlKey()}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(90_000),
        });
        const text = await res.text();
        if (res.status === 429 || res.status >= 500) {
          const ra = Number(res.headers.get('retry-after'));
          if (res.status === 429) backoff = Math.min(Math.max(backoff, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 20_000), 90_000);
          throw new Error(`HTTP ${res.status}`);
        }
        const json = JSON.parse(text) as Record<string, unknown>;
        if (!res.ok || json.success === false) {
          // 4xx other than 429 is permanent (e.g. unscrapable URL): cache nothing, do not retry.
          throw Object.assign(new Error(`HTTP ${res.status}: ${String(json.error ?? text).slice(0, 160)}`), { permanent: true });
        }
        this.calls++;
        const used = typeof json.creditsUsed === 'number' ? json.creditsUsed : estimatedCredits;
        this.creditsSpent += used;
        writeFileSync(file, JSON.stringify(json));
        return json;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        if ((e as { permanent?: boolean }).permanent) throw new Error(lastError);
        if (attempt < 3) await new Promise((r) => setTimeout(r, backoff));
        backoff *= 2;
      }
    }
    throw new Error(`Firecrawl ${path} failed after 3 attempts: ${lastError}`);
  }

  async search(query: string, limit = 5): Promise<SearchHit[]> {
    const json = await this.post('/search', { query, limit, country: 'BD' }, 2);
    const data = json.data as unknown;
    const rows = Array.isArray(data) ? data : ((data as { web?: unknown[] } | undefined)?.web ?? []);
    return (rows as Record<string, unknown>[])
      .filter((r) => typeof r.url === 'string')
      .map((r) => ({
        url: String(r.url),
        title: typeof r.title === 'string' ? r.title : '',
        description: typeof r.description === 'string' ? r.description : '',
      }));
  }

  /** Scrape the full page (not just "main content") so footer contact details are included. */
  async scrape(url: string): Promise<ScrapeResult> {
    const json = await this.post('/scrape', { url, formats: ['markdown', 'links'], onlyMainContent: false }, 1);
    const d = (json.data ?? {}) as Record<string, unknown>;
    const meta = (d.metadata ?? {}) as Record<string, unknown>;
    return {
      url,
      markdown: typeof d.markdown === 'string' ? d.markdown : '',
      links: Array.isArray(d.links) ? (d.links as unknown[]).filter((l): l is string => typeof l === 'string') : [],
      title: typeof meta.title === 'string' ? meta.title : '',
      statusCode: typeof meta.statusCode === 'number' ? meta.statusCode : null,
    };
  }
}
