import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { env } from '../config/env.js';
import { prepare, transaction } from '../db/db.js';
import { FirecrawlClient, type SearchHit } from '../enrich/firecrawlClient.js';
import {
  dhakaEvidenceOnPage, domainRelatesToName, findContactPage, findEmails, findPhones, hasDistinctiveName,
  hostOf, isOfficialSiteCandidate, socialProfile, textMatchesName,
} from '../enrich/match.js';

/**
 * Web discovery for categories OpenStreetMap cannot cover (garments, tech companies, online businesses).
 * Accuracy over quantity: a result becomes a record only with specific Dhaka evidence AND category evidence.
 *  - Company websites need a domain that relates to the company name, and must verify after a homepage scrape.
 *  - Facebook/Instagram pages are stored as 'search_match' leads (never 'verified') and only when the search
 *    snippet itself names Dhaka.
 *  - Directories, job boards, marketplaces and list-style articles ("Top 10 ...") are never records.
 *  - Anything already stored (same website domain or social URL) is skipped, not duplicated.
 */

interface Plan { query: string; category: 'garments' | 'startups' | 'online_businesses'; sub: string }

export const PLANS: Plan[] = [
  { query: 'garment factory Dhaka Bangladesh company', category: 'garments', sub: 'garment_factory' },
  { query: 'knitwear manufacturer Dhaka Bangladesh', category: 'garments', sub: 'knitwear_manufacturer' },
  { query: 'woven garments manufacturer Dhaka Bangladesh', category: 'garments', sub: 'woven_manufacturer' },
  { query: 'sweater manufacturer Dhaka Bangladesh', category: 'garments', sub: 'sweater_manufacturer' },
  { query: 'buying house Dhaka Bangladesh apparel', category: 'garments', sub: 'buying_house' },
  { query: 'textile mill Dhaka Bangladesh', category: 'garments', sub: 'textile_mill' },
  { query: 'garment accessories manufacturer Dhaka Bangladesh', category: 'garments', sub: 'accessories_manufacturer' },
  { query: 'apparel exporter Dhaka Bangladesh', category: 'garments', sub: 'clothing_exporter' },
  { query: 'software company Dhaka Bangladesh', category: 'startups', sub: 'software_company' },
  { query: 'IT company Dhaka Bangladesh', category: 'startups', sub: 'it_company' },
  { query: 'fintech company Dhaka Bangladesh', category: 'startups', sub: 'fintech_company' },
  { query: 'SaaS company Dhaka Bangladesh', category: 'startups', sub: 'saas_company' },
  { query: 'mobile app development company Dhaka Bangladesh', category: 'startups', sub: 'mobile_app_company' },
  { query: 'web development company Dhaka Bangladesh', category: 'startups', sub: 'web_development' },
  { query: 'digital marketing agency Dhaka Bangladesh', category: 'startups', sub: 'digital_agency' },
  { query: 'tech startup Dhaka Bangladesh founded funding', category: 'startups', sub: 'it_company' },
  { query: 'Facebook clothing shop Dhaka', category: 'online_businesses', sub: 'facebook_clothing' },
  { query: 'Facebook cosmetics shop Dhaka', category: 'online_businesses', sub: 'facebook_cosmetics' },
  { query: 'Instagram fashion store Dhaka', category: 'online_businesses', sub: 'instagram_fashion' },
  { query: 'online electronics shop Dhaka Bangladesh', category: 'online_businesses', sub: 'online_electronics' },
  { query: 'online grocery shop Dhaka Bangladesh', category: 'online_businesses', sub: 'online_grocery' },
  { query: 'online baby products store Dhaka Bangladesh', category: 'online_businesses', sub: 'online_baby_products' },
  { query: 'online footwear shop Dhaka Bangladesh', category: 'online_businesses', sub: 'online_footwear' },
  { query: 'online gift shop Dhaka Bangladesh', category: 'online_businesses', sub: 'online_gifts' },
  { query: 'Facebook home food business Dhaka order', category: 'online_businesses', sub: 'facebook_food' },
  { query: 'independent ecommerce brand Dhaka Bangladesh', category: 'online_businesses', sub: 'ecommerce_brand' },
];

const CATEGORY_WORDS: Record<Plan['category'], RegExp> = {
  garments: /garment|apparel|knit|woven|sweater|textile|denim|fabric|buying house|\brmg\b|ready[- ]?made|hosiery|spinning|dyeing|accessories|clothing/i,
  startups: /software|saas|fintech|\bit\b|information technology|app development|web development|digital|technology|\bai\b|cloud|\berp\b|solutions|agency|startup/i,
  online_businesses: /shop|store|boutique|fashion|cosmetic|electronics|grocery|baby|footwear|gift|online|delivery|food|clothing|brand|collection|order/i,
};

/** Never records: directories, job boards, marketplaces, B2B listings, news. */
const EXTRA_BLOCK = [
  'clutch.co', 'goodfirms', 'topdevelopers', 'designrush', 'glassdoor', 'indeed.com', 'bdjobs', 'alibaba', 'made-in-china',
  'exporthub', 'tradeindia', 'indiamart', 'ec21', 'tradekey', 'globalsources', 'bgmea.com.bd', 'bkmea', 'crunchbase',
  'f6s.com', 'startupranking', 'themanufacturer', 'sourcingjournal', 'fibre2fashion', 'textiletoday', 'thedailystar',
  'tbsnews', 'dhakatribune', 'prothomalo', 'bdnews24', 'wikipedia', 'daraz.com.bd', 'bikroy.com', 'ajkerdeal', 'rokomari',
  'chaldal', 'pickaboo', 'startech.com.bd', 'ryans.com', 'techland', 'bdstall', 'aamarpay', 'sslcommerz', 'quora', 'reddit',
];
const LISTICLE = /\b(top|best)\s+\d+|\b\d+\s+(best|top)\b|\blist of\b|\bdirectory\b|\bcompanies in\b|\bshops in\b|\bstores in\b|\bfactories in\b/i;

function blocked(url: string): boolean {
  const host = hostOf(url) ?? '';
  return !isOfficialSiteCandidate(url) || EXTRA_BLOCK.some((b) => host.includes(b));
}

/** "Acme Knitwear Ltd | Dhaka - Facebook" -> "Acme Knitwear Ltd". */
export function cleanTitle(title: string): string {
  let t = title.split(/\s[|–—·•-]\s|\s?:\s/)[0] ?? title;
  t = t.replace(/\s*\(@[^)]*\)\s*/g, ' ').replace(/\s*[-–|]\s*(facebook|instagram|home)\s*$/i, '');
  return t.replace(/\s+/g, ' ').trim().slice(0, 120);
}

/**
 * A "name" taken from a page title is often an SEO phrase, not a company name
 * (e.g. "Garment factory Bangladesh clothing manufacturer"). Such records are kept but held for review.
 */
export function looksLikeSlogan(name: string): boolean {
  const words = name.trim().split(/\s+/);
  return words.length > 5 || /\b(best|top|buy|cheap|online shop|company in|manufacturer in|factory in|in bangladesh|bangladesh)\b/i.test(name) && words.length > 3;
}

function refineSub(plan: Plan, text: string): string {
  if (plan.category === 'startups') {
    if (/startup/i.test(text) && /(founded|funded|seed|series [abc]|raised|angel)/i.test(text)) return 'technology_startup';
    if (/fintech|payment|mobile financial/i.test(text)) return 'fintech_company';
    if (/saas/i.test(text)) return 'saas_company';
  }
  if (plan.category === 'garments') {
    if (/knit/i.test(text)) return 'knitwear_manufacturer';
    if (/sweater/i.test(text)) return 'sweater_manufacturer';
    if (/woven|denim/i.test(text)) return 'woven_manufacturer';
    if (/buying house/i.test(text)) return 'buying_house';
  }
  return plan.sub;
}

export interface WebCandidate {
  plan: Plan; kind: 'website' | 'social'; name: string; url: string; hit: SearchHit;
  platform?: 'facebook' | 'instagram'; sub: string;
}

/** Pure rules: turns one search hit into a candidate, or null with the reason it was rejected. */
export function evaluateHit(plan: Plan, hit: SearchHit): { cand: WebCandidate | null; reason: string } {
  const text = `${hit.title} ${hit.description}`;
  const sp = socialProfile(hit.url);
  if (sp) {
    if (plan.category !== 'online_businesses') return { cand: null, reason: 'social page outside online category' };
    if (/\bgroup\b/i.test(text) && !/\bpage\b/i.test(text)) return { cand: null, reason: 'looks like a group' };
    if (!/dhaka|ঢাকা/i.test(text)) return { cand: null, reason: 'no Dhaka in snippet' };
    const name = cleanTitle(hit.title);
    if (!hasDistinctiveName(name)) return { cand: null, reason: 'no distinctive name' };
    return { cand: { plan, kind: 'social', name, url: sp.url, hit, platform: sp.platform, sub: plan.sub }, reason: 'ok' };
  }
  if (blocked(hit.url)) return { cand: null, reason: 'directory / marketplace / social / news' };
  if (LISTICLE.test(hit.title)) return { cand: null, reason: 'list-style article' };
  const host = hostOf(hit.url) ?? '';
  const name = cleanTitle(hit.title);
  if (!hasDistinctiveName(name)) return { cand: null, reason: 'no distinctive name' };
  if (!domainRelatesToName(host, name)) return { cand: null, reason: 'domain does not relate to company name' };
  if (!dhakaEvidenceOnPage(`${text} ${hit.url}`, host)) return { cand: null, reason: 'no Dhaka evidence' };
  if (!CATEGORY_WORDS[plan.category].test(text)) return { cand: null, reason: 'no category evidence in snippet' };
  return { cand: { plan, kind: 'website', name, url: `https://${host}`, hit, sub: refineSub(plan, text) }, reason: 'ok' };
}

export interface WebRunSummary {
  ceiling: number; creditsSpent: number; queries: number; hits: number;
  rejected: Record<string, number>; created: Record<string, number>;
  skippedDuplicate: number; scrapeFailed: number; scrapeUnverified: number;
}

function hostKnown(host: string): boolean {
  const rows = prepare<{ v: string }>(`SELECT value_normalized v FROM business_contacts WHERE contact_type='website' AND value_normalized IS NOT NULL`).all();
  return rows.some((r) => hostOf(r.v) === host);
}

export async function runWebDiscovery(ceiling: number, log: (m: string) => void = console.log): Promise<WebRunSummary> {
  const client = new FirecrawlClient(ceiling);
  const sum: WebRunSummary = { ceiling, creditsSpent: 0, queries: 0, hits: 0, rejected: {}, created: {}, skippedDuplicate: 0, scrapeFailed: 0, scrapeUnverified: 0 };
  const now = () => new Date().toISOString();
  const jobs = new Map<string, string>();
  for (const cat of new Set(PLANS.map((p) => p.category))) {
    const id = randomUUID();
    jobs.set(cat, id);
    prepare(`INSERT INTO discovery_jobs (job_id, area_name, category_id, status, endpoint_used, started_at) VALUES (?, 'Dhaka (web search)', ?, 'running', 'firecrawl:search', ?)`).run(id, cat, now());
  }
  const seen = new Set<string>();
  const audit: unknown[] = [];

  const insBiz = prepare(`INSERT INTO businesses (business_id, name, category_id, subcategory_id, record_status, classification_method, classification_note, first_discovered_at) VALUES (?, ?, ?, ?, 'new', 'web_search', ?, ?)`);
  const insLoc = prepare(`INSERT INTO business_locations (business_id, area_method) VALUES (?, 'none')`);
  const insSrc = prepare(`INSERT INTO business_sources (business_id, source_type, source_url, source_reference, raw_payload, fetched_at) VALUES (?, ?, ?, ?, ?, ?)`);
  const insContact = prepare(`INSERT INTO business_contacts (business_id, contact_type, value_raw, value_normalized, verification_status, source_url) VALUES (?, ?, ?, ?, ?, ?)`);
  const insSocial = prepare(`INSERT INTO business_social_links (business_id, platform, url, verification_status, source_url) VALUES (?, ?, ?, ?, ?)`);
  const socialKnown = prepare<{ x: number }>(`SELECT 1 x FROM business_social_links WHERE lower(url)=lower(?) LIMIT 1`);
  const bump = (o: Record<string, number>, k: string) => { o[k] = (o[k] ?? 0) + 1; };

  for (const plan of PLANS) {
    if (client.remainingBudget < 6) { log(`Stopping: credit ceiling nearly reached (${client.creditsSpent}/${ceiling}).`); break; }
    let hits: SearchHit[];
    try {
      hits = await client.search(plan.query, 10);
    } catch (e) {
      log(`  search failed "${plan.query}": ${e instanceof Error ? e.message : e}`);
      continue;
    }
    sum.queries++; sum.hits += hits.length;
    let made = 0;
    for (const hit of hits) {
      const { cand, reason } = evaluateHit(plan, hit);
      if (!cand) { bump(sum.rejected, reason); continue; }
      const key = cand.kind === 'website' ? `h:${hostOf(cand.url)}` : `s:${cand.url.toLowerCase()}`;
      if (seen.has(key)) { sum.skippedDuplicate++; continue; }
      seen.add(key);
      if (cand.kind === 'website' ? hostKnown(hostOf(cand.url)!) : !!socialKnown.get(cand.url)) { sum.skippedDuplicate++; continue; }

      const id = `web:${createHash('sha1').update(key).digest('hex').slice(0, 16)}`;
      if (prepare(`SELECT 1 x FROM businesses WHERE business_id=?`).get(id)) { sum.skippedDuplicate++; continue; }

      if (cand.kind === 'social') {
        transaction(() => {
          insBiz.run(id, cand.name, plan.category, cand.sub, 'Discovered by web search; page identity taken from the search snippet only (not verified).', now());
          insLoc.run(id);
          insSrc.run(id, 'firecrawl_search', cand.hit.url, plan.query, JSON.stringify(cand.hit), now());
          insSocial.run(id, cand.platform!, cand.url, 'search_match', cand.hit.url);
        });
        bump(sum.created, plan.category); made++;
        audit.push({ id, kind: 'social', name: cand.name, url: cand.url, query: plan.query });
        continue;
      }

      // Company website: must verify on the real page before it becomes a record.
      if (client.remainingBudget < 3) break;
      let page;
      try { page = await client.scrape(cand.url); } catch { sum.scrapeFailed++; continue; }
      const host = hostOf(cand.url) ?? '';
      const text = `${page.title}\n${page.markdown}`;
      if (!(page.markdown.length > 0 && textMatchesName(text, cand.name) && dhakaEvidenceOnPage(text, host) && CATEGORY_WORDS[plan.category].test(text))) {
        sum.scrapeUnverified++; continue;
      }
      let links = page.links; let md = page.markdown;
      let phones = findPhones(md, links); let emails = findEmails(md, links);
      if (!phones.length && !emails.length && client.remainingBudget > 2) {
        const cp = findContactPage(cand.url, links);
        if (cp) { try { const c2 = await client.scrape(cp); md = c2.markdown; links = [...links, ...c2.links]; phones = findPhones(md, c2.links); emails = findEmails(md, c2.links); } catch { /* optional page */ } }
      }
      const socials = new Map<string, string>();
      for (const l of links) { const s = socialProfile(l); if (s && !socials.has(s.platform)) socials.set(s.platform, s.url); }

      transaction(() => {
        const slogan = looksLikeSlogan(cand.name);
        insBiz.run(id, cand.name, plan.category, cand.sub, slogan ? 'Name taken from a page title and looks like an SEO phrase, not a company name; website itself verified.' : 'Discovered by web search; website verified (name + Dhaka + category evidence on page).', now());
        if (slogan) prepare(`UPDATE businesses SET record_status='needs_review' WHERE business_id=?`).run(id);
        insLoc.run(id);
        insSrc.run(id, 'firecrawl_search', cand.hit.url, plan.query, JSON.stringify(cand.hit), now());
        insSrc.run(id, 'firecrawl_scrape', cand.url, 'homepage', JSON.stringify({ title: page.title, chars: page.markdown.length }), now());
        insContact.run(id, 'website', cand.url, cand.url, 'verified', cand.url);
        for (const p of phones) insContact.run(id, 'phone', p.raw, p.normalized, 'verified', cand.url);
        for (const e of emails) insContact.run(id, 'email', e, e, 'verified', cand.url);
        for (const [platform, url] of socials) insSocial.run(id, platform, url, 'verified', cand.url);
      });
      bump(sum.created, plan.category); made++;
      audit.push({ id, kind: 'website', name: cand.name, url: cand.url, phones: phones.length, emails: emails.length, socials: [...socials.keys()], query: plan.query });
    }
    log(`  ${plan.category.padEnd(18)} "${plan.query}": ${hits.length} hits -> ${made} new records (credits ${client.creditsSpent}/${ceiling})`);
  }

  for (const [cat, id] of jobs) {
    prepare(`UPDATE discovery_jobs SET status='completed', finished_at=?, element_count=?, business_count=? WHERE job_id=?`).run(now(), sum.hits, sum.created[cat] ?? 0, id);
  }
  sum.creditsSpent = client.creditsSpent;
  mkdirSync(env.exportDir, { recursive: true });
  writeFileSync(resolve(env.exportDir, 'web_discovery_audit.json'), JSON.stringify({ generatedAt: now(), summary: sum, created: audit }, null, 2));
  return sum;
}
