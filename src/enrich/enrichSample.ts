import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { env } from '../config/env.js';
import { prepare, transaction, type Param } from '../db/db.js';
import { normalizeUrl } from '../osm/extractContacts.js';
import { FirecrawlClient } from './firecrawlClient.js';
import {
  dhakaEvidenceOnPage, domainRelatesToName, findContactPage, findEmails, findPhones, hasDhakaEvidence, hasDistinctiveName, hostOf,
  isOfficialSiteCandidate, socialProfile, textMatchesName,
} from './match.js';

interface Candidate {
  business_id: string;
  name: string;
  area_name: string | null;
  area_method: string | null;
  osm_website: string | null;
}

export interface EnrichOutcome {
  business_id: string;
  name: string;
  area: string | null;
  osmHadWebsite: boolean;
  website: { url: string; status: 'verified' | 'unverified'; origin: 'osm' | 'search'; reason: string } | null;
  rejectedSites: string[];
  phones: string[];
  emails: string[];
  facebook: { url: string; status: 'verified' | 'search_match' } | null;
  instagram: { url: string; status: 'verified' | 'search_match' } | null;
  creditsSpent: number;
  error?: string;
}

/** Deterministic shuffle so the same sample can be reproduced (and hits the cache). */
function seededShuffle<T>(items: T[], seed: number): T[] {
  const a = [...items];
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/**
 * Sample: restaurants that already passed classification (not needs_review), have an area, and a
 * distinctive name. Mostly records with no website in OSM (the real use case) plus a few that have one
 * (to test verification of an existing URL).
 */
export function selectSample(n: number, withWebsite: number): Candidate[] {
  const rows = prepare<Candidate>(
    `SELECT b.business_id, b.name, l.area_name, l.area_method,
       (SELECT value_normalized FROM business_contacts c WHERE c.business_id=b.business_id AND c.contact_type='website' AND c.value_normalized IS NOT NULL LIMIT 1) AS osm_website
     FROM businesses b JOIN business_locations l USING(business_id)
     WHERE b.category_id='restaurants' AND b.record_status!='needs_review' AND l.area_name IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM business_sources s WHERE s.business_id=b.business_id AND s.source_type='firecrawl_search')`,
  ).all().filter((r) => hasDistinctiveName(r.name));

  const withSite = seededShuffle(rows.filter((r) => r.osm_website), 7).slice(0, withWebsite);
  const without = seededShuffle(rows.filter((r) => !r.osm_website), 7).slice(0, n - withSite.length);
  return [...without, ...withSite];
}

const CATEGORY_PRIORITY = ['startups', 'hospitals', 'diagnostics', 'gyms', 'grocery', 'restaurants'];

/**
 * Batch selection for the main enrichment run. OSM-origin records only (web-discovered records are already
 * verified or are leads). Not flagged for review, distinctive name, never searched before. Order:
 * records that already carry a website in OSM first (cheapest, highest yield), then by category value,
 * Dhaka Metropolitan before Greater Dhaka. Deterministic.
 */
export function selectBatch(n: number): Candidate[] {
  const rows = prepare<Candidate & { category_id: string; dhaka_scope: string | null }>(
    `SELECT b.business_id, b.name, b.category_id, l.area_name, l.area_method, l.dhaka_scope,
       (SELECT value_normalized FROM business_contacts c WHERE c.business_id=b.business_id AND c.contact_type='website' AND c.value_normalized IS NOT NULL LIMIT 1) AS osm_website
     FROM businesses b JOIN business_locations l USING(business_id)
     WHERE b.business_id LIKE 'osm:%' AND b.record_status!='needs_review'
       AND NOT EXISTS (SELECT 1 FROM business_sources s WHERE s.business_id=b.business_id AND s.source_type='firecrawl_search')`,
  ).all().filter((r) => hasDistinctiveName(r.name));
  const rank = (r: (typeof rows)[number]) =>
    (r.osm_website ? 0 : 1000) + CATEGORY_PRIORITY.indexOf(r.category_id) * 10 + (r.dhaka_scope === 'dhaka_metropolitan' ? 0 : 5);
  const shuffled = seededShuffle(rows, 11);
  return shuffled.sort((a, b) => rank(a) - rank(b)).slice(0, n);
}

async function enrichOne(client: FirecrawlClient, c: Candidate): Promise<EnrichOutcome> {
  const before = client.creditsSpent;
  const out: EnrichOutcome = {
    business_id: c.business_id, name: c.name, area: c.area_name, osmHadWebsite: !!c.osm_website,
    website: null, rejectedSites: [], phones: [], emails: [], facebook: null, instagram: null, creditsSpent: 0,
  };
  const now = new Date().toISOString();
  const addSource = prepare(
    `INSERT INTO business_sources (business_id, source_type, source_url, source_reference, raw_payload, fetched_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );

  try {
    // 1. Search: name + area + Dhaka.
    const query = `"${c.name}" ${c.area_name ?? ''} Dhaka`.replace(/\s+/g, ' ').trim();
    const hits = await client.search(query, 5);
    addSource.run(c.business_id, 'firecrawl_search', `firecrawl:search`, query, JSON.stringify(hits), now);

    // 2. Social profiles visible in search results: kept only as 'search_match' (name AND Dhaka in snippet).
    for (const h of hits) {
      const sp = socialProfile(h.url);
      if (!sp || out[sp.platform]) continue;
      const evidence = `${h.title} ${h.description}`;
      if (textMatchesName(evidence, c.name) && hasDhakaEvidence(evidence)) {
        out[sp.platform] = { url: sp.url, status: 'search_match' };
      }
    }

    // 3. Website: OSM's own URL, else a strictly-matched search hit (name in title AND in the domain, Dhaka evidence).
    let siteUrl: string | null = null;
    let origin: 'osm' | 'search' = 'search';
    if (c.osm_website) {
      siteUrl = c.osm_website;
      origin = 'osm';
    } else {
      for (const h of hits) {
        if (!isOfficialSiteCandidate(h.url)) continue;
        const host = hostOf(h.url) ?? '';
        const domainMatch = domainRelatesToName(host, c.name);
        const evidence = `${h.title} ${h.description} ${h.url}`;
        if (domainMatch && textMatchesName(h.title + ' ' + host.replace(/[.-]/g, ' '), c.name) && hasDhakaEvidence(evidence)) {
          siteUrl = h.url;
          break;
        }
        out.rejectedSites.push(`${host} (${domainMatch ? 'no Dhaka/name evidence in result' : 'domain does not match name'})`);
      }
    }

    // 4. Scrape and VERIFY the site is this business before trusting anything on it.
    if (siteUrl) {
      const page = await client.scrape(siteUrl).catch((e: unknown) => {
        out.website = { url: siteUrl!, status: 'unverified', origin, reason: `scrape failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 90)}` };
        return null;
      });
      if (page) {
      addSource.run(c.business_id, 'firecrawl_scrape', siteUrl, 'homepage', JSON.stringify({ title: page.title, statusCode: page.statusCode, chars: page.markdown.length }), now);
      const text = `${page.title}\n${page.markdown}`;
      const host = hostOf(siteUrl) ?? '';
      const nameOk = textMatchesName(text, c.name);
      const domainOk = domainRelatesToName(host, c.name);
      const dhakaOk = dhakaEvidenceOnPage(text, host);
      if (page.markdown.length > 0 && nameOk && domainOk && dhakaOk) {
        const root = normalizeUrl(new URL(siteUrl).origin) ?? siteUrl;
        out.website = { url: root, status: 'verified', origin, reason: 'name on page + domain matches name + Dhaka evidence on page' };

        let links = page.links;
        let md = page.markdown;
        let phones = findPhones(md, links);
        let emails = findEmails(md, links);
        // Contact page fallback (1 credit) only when the homepage shows neither a phone nor an email.
        if (phones.length === 0 && emails.length === 0) {
          const contact = findContactPage(siteUrl, links);
          if (contact && client.remainingBudget > 1) {
            const cp = await client.scrape(contact);
            addSource.run(c.business_id, 'firecrawl_scrape', contact, 'contact page', JSON.stringify({ title: cp.title, chars: cp.markdown.length }), now);
            md = cp.markdown;
            links = [...links, ...cp.links];
            phones = findPhones(md, cp.links);
            emails = findEmails(md, cp.links);
          }
        }
        out.phones = phones.map((p) => p.normalized);
        out.emails = emails;

        // Social links the official site itself points to are the strongest evidence.
        for (const l of links) {
          const sp = socialProfile(l);
          if (sp && (!out[sp.platform] || out[sp.platform]!.status !== 'verified')) out[sp.platform] = { url: sp.url, status: 'verified' };
        }

        transaction(() => {
          persist(c.business_id, out, phones.map((p) => ({ raw: p.raw, normalized: p.normalized })), siteUrl!);
        });
      } else {
        out.website = {
          url: siteUrl, status: 'unverified', origin,
          reason: `NOT stored - page did not verify (name ${nameOk ? 'ok' : 'missing'}, domain ${domainOk ? 'ok' : 'unrelated to name'}, Dhaka evidence ${dhakaOk ? 'ok' : 'missing'}, ${page.markdown.length} chars)`,
        };
      }
      }
    }

    // Persist social search matches even when no website was verified.
    if (!out.website || out.website.status !== 'verified') {
      transaction(() => persist(c.business_id, out, [], null));
    }
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
  }
  out.creditsSpent = client.creditsSpent - before;
  return out;
}

/** Insert only values that are not already stored; upgrade an existing unverified OSM value when verified. */
function persist(businessId: string, out: EnrichOutcome, phones: { raw: string; normalized: string }[], pageUrl: string | null) {
  const hasContact = prepare<{ contact_id: number }>(
    `SELECT contact_id FROM business_contacts WHERE business_id=? AND contact_type=? AND (value_normalized=? OR value_raw=?)`,
  );
  const insContact = prepare(
    `INSERT INTO business_contacts (business_id, contact_type, value_raw, value_normalized, verification_status, source_url) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const upContact = prepare(`UPDATE business_contacts SET verification_status=?, source_url=? WHERE contact_id=?`);
  const put = (type: string, raw: string, norm: string, status: string, source: string | null) => {
    const ex = hasContact.get(businessId, type, norm as Param, raw);
    if (!ex) insContact.run(businessId, type, raw, norm, status, source);
    else if (status === 'verified') upContact.run(status, source, ex.contact_id);
  };

  if (out.website?.status === 'verified') put('website', out.website.url, out.website.url, 'verified', out.website.url);
  for (const p of phones) put('phone', p.raw, p.normalized, 'verified', pageUrl);
  for (const e of out.emails) put('email', e, e, 'verified', pageUrl);

  const hasSocial = prepare<{ social_id: number }>(`SELECT social_id FROM business_social_links WHERE business_id=? AND platform=? AND url=?`);
  const insSocial = prepare(`INSERT INTO business_social_links (business_id, platform, url, verification_status, source_url) VALUES (?, ?, ?, ?, ?)`);
  const upSocial = prepare(`UPDATE business_social_links SET verification_status=?, source_url=? WHERE social_id=?`);
  for (const platform of ['facebook', 'instagram'] as const) {
    const s = out[platform];
    if (!s) continue;
    const source = s.status === 'verified' ? pageUrl : 'firecrawl:search';
    const ex = hasSocial.get(businessId, platform, s.url);
    if (!ex) insSocial.run(businessId, platform, s.url, s.status, source);
    else if (s.status === 'verified') upSocial.run(s.status, source, ex.social_id);
  }
}

export async function runEnrichSample(n: number, withWebsite: number, creditCeiling: number): Promise<EnrichOutcome[]> {
  return runEnrichOn(selectSample(n, withWebsite), creditCeiling, 'enrichment_sample.json');
}

export async function runEnrichBatch(n: number, creditCeiling: number): Promise<EnrichOutcome[]> {
  return runEnrichOn(selectBatch(n), creditCeiling, 'enrichment_batch.json');
}

async function runEnrichOn(sample: Candidate[], creditCeiling: number, outFile: string): Promise<EnrichOutcome[]> {
  const client = new FirecrawlClient(creditCeiling);
  console.log(`Enriching ${sample.length} businesses (${sample.filter((s) => s.osm_website).length} with an OSM website). Credit ceiling ${creditCeiling}.`);

  const results: EnrichOutcome[] = [];
  for (const [i, c] of sample.entries()) {
    if (client.remainingBudget < 3) {
      console.log(`Stopping: only ${client.remainingBudget} credits left under the ceiling.`);
      break;
    }
    const r = await enrichOne(client, c);
    results.push(r);
    const flags = [
      r.website ? `site:${r.website.status}` : 'site:none', `ph:${r.phones.length}`, `em:${r.emails.length}`,
      `fb:${r.facebook?.status ?? '-'}`, `ig:${r.instagram?.status ?? '-'}`,
    ].join(' ');
    console.log(`${String(i + 1).padStart(2)}. ${c.name.slice(0, 32).padEnd(32)} ${flags}${r.error ? `  ERROR: ${r.error}` : ''}`);
  }

  mkdirSync(env.exportDir, { recursive: true });
  const file = resolve(env.exportDir, outFile);
  writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), creditsSpentEstimate: client.creditsSpent, cacheHits: client.cacheHits, results }, null, 2));
  console.log(`\nEstimated credits spent: ${client.creditsSpent} (cache hits: ${client.cacheHits}). Report: ${file}`);
  return results;
}
