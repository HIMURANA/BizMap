import { normalizeBdPhone } from '../osm/extractContacts.js';

/**
 * Identity / evidence rules for enrichment. Deliberately conservative: when evidence is thin the
 * answer is "no match", never a guess.
 */

const STOPWORDS = new Set([
  'the', 'and', 'restaurant', 'restaurants', 'cafe', 'caffe', 'coffee', 'shop', 'house', 'ltd', 'limited', 'bd',
  'bangladesh', 'dhaka', 'bar', 'grill', 'kitchen', 'food', 'foods', 'fast', 'bakery', 'store', 'of', 'in', 'at', 'hotel', 'hotels', 'resort', 'club', 'corner', 'center', 'centre',
  'greengrocer', 'grocer', 'grocery', 'green', 'butcher', 'cng', 'fish', 'meat', 'vegetable', 'vegetables', 'fruit', 'fruits',
  'general', 'tea', 'stall', 'medicine', 'pharmacy', 'shop', 'point', 'cafeteria', 'diner', 'pizza', 'burger', 'biryani', 'biriyani', 'kabab', 'sweets', 'mart', 'super',
]);

export function fold(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Distinctive words of a business name (falls back to all words if every word is generic). */
export function nameTokens(name: string): string[] {
  const all = fold(name).split(' ').filter((t) => t.length >= 2);
  const distinctive = all.filter((t) => !STOPWORDS.has(t));
  return distinctive.length ? distinctive : all;
}

/** True when EVERY distinctive token of the name appears as a whole word in the text. */
export function textMatchesName(text: string, name: string): boolean {
  const tokens = nameTokens(name);
  if (tokens.length === 0) return false;
  const words = new Set(fold(text).split(' '));
  return tokens.every((t) => words.has(t));
}

const LOCATION_RE = /dhaka|ঢাকা|bangladesh|বাংলাদেশ|gulshan|গুলশান|banani|বনানী|baridhara|বারিধারা|\+?880|\.bd\b/i;

export function hasDhakaEvidence(text: string): boolean {
  return LOCATION_RE.test(text);
}

/** Directories, delivery apps, review sites and social networks are never "official websites". */
const NOT_OFFICIAL = [
  'facebook.com', 'fb.com', 'instagram.com', 'tiktok.com', 'twitter.com', 'x.com', 'youtube.com', 'linkedin.com',
  'pinterest.com', 'tripadvisor.', 'foodpanda.', 'pathao.com', 'hungrynaki.com', 'google.', 'yelp.com', 'zomato.com',
  'foursquare.com', 'wikipedia.org', 'wikimedia.org', 'openstreetmap.org', 'booking.com', 'agoda.com', 'wanderlog.com',
  'restaurantguru.com', 'mapcarta.com', 'yellowpages', 'bdyellow', 'cybo.com', 'uber.com', 'ubereats.com', 'justeat',
  'doordash.com', 'menuism', 'dhakamenu', 'sluurpy.', 'happycow.net', 'opentable.', 'bing.com', 'maps.apple.com',
  'yandex.', 'geoview.info', 'mindtrip.ai', 'scribd.com', 'dhakatribune.com', 'thedailystar.net', 'prothomalo.com', 'tbsnews.net', 'sites.google.com', 'wixsite.com', 'blogspot.', 'wordpress.com', 'medium.com', 'reddit.com', 'quora.com',
];

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

export function isOfficialSiteCandidate(url: string): boolean {
  const host = hostOf(url);
  if (!host) return false;
  return !NOT_OFFICIAL.some((bad) => host.includes(bad));
}

const FB_BAD_PATH = /\/(posts|photos|photo|videos|video|reel|reels|groups|events|share|watch|story\.php|permalink\.php|hashtag|marketplace|login|sharer|plugins)\b/i;
const IG_BAD_PATH = /^\/(p|reel|reels|explore|tv|stories|accounts|directory)(\/|$)/i;

/** A canonical public profile/page URL, or null for posts, photos, shares, groups and the like. */
export function socialProfile(url: string): { platform: 'facebook' | 'instagram'; url: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\.|^m\.|^web\.|^mbasic\./, '');
  const segs = u.pathname.split('/').filter(Boolean);
  if (host === 'facebook.com' || host === 'fb.com') {
    if (segs.length === 0 || FB_BAD_PATH.test(u.pathname)) return null;
    if (segs[0] === 'profile.php') return null; // personal-profile style ids: not a business page URL
    if (segs[0] === 'pages' && segs.length >= 3) return { platform: 'facebook', url: `https://www.facebook.com/pages/${segs[1]}/${segs[2]}` };
    return { platform: 'facebook', url: `https://www.facebook.com/${segs[0]}` };
  }
  if (host === 'instagram.com') {
    if (segs.length === 0 || IG_BAD_PATH.test(u.pathname)) return null;
    return { platform: 'instagram', url: `https://www.instagram.com/${segs[0]}` };
  }
  return null;
}

const EMAIL_FIND = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;
const JUNK_EMAIL = /\.(png|jpe?g|gif|webp|svg)$|sentry|wixpress|example\.|your-?email|@domain\.|user@|name@|email@/i;

export function findEmails(markdown: string, links: string[]): string[] {
  const out = new Set<string>();
  for (const l of links) {
    if (/^mailto:/i.test(l)) {
      const e = decodeURIComponent(l.slice(7).split('?')[0] ?? '').trim().toLowerCase();
      if (e && !JUNK_EMAIL.test(e)) out.add(e);
    }
  }
  for (const m of markdown.match(EMAIL_FIND) ?? []) {
    const e = m.toLowerCase();
    if (!JUNK_EMAIL.test(e)) out.add(e);
  }
  return [...out].slice(0, 3);
}

const PHONE_FIND = /(?:\+?88[\s-]?)?0?1[3-9]\d{2}[\s-]?\d{6}|(?:\+?88[\s-]?)?0?2[\s-]?\d{7,8}|\+?880[\s-]?\d[\d\s-]{8,12}/g;
const PHONE_CONTEXT = /call|phone|tel|mobile|contact|reservation|hotline|booking|order|whatsapp|helpline|📞|☎/i;

/** Phones from tel: links (strong), plus numbers on lines that are clearly labelled as contact lines. */
export function findPhones(markdown: string, links: string[]): { raw: string; normalized: string; via: 'tel_link' | 'labelled_text' }[] {
  const out = new Map<string, { raw: string; normalized: string; via: 'tel_link' | 'labelled_text' }>();
  for (const l of links) {
    if (/^tel:/i.test(l)) {
      const raw = decodeURIComponent(l.slice(4)).trim();
      const n = normalizeBdPhone(raw);
      if (n) out.set(n, { raw, normalized: n, via: 'tel_link' });
    }
  }
  for (const line of markdown.split('\n')) {
    if (!PHONE_CONTEXT.test(line)) continue;
    for (const m of line.match(PHONE_FIND) ?? []) {
      const n = normalizeBdPhone(m);
      if (n && !out.has(n)) out.set(n, { raw: m.trim(), normalized: n, via: 'labelled_text' });
    }
  }
  return [...out.values()].slice(0, 4);
}

/** First same-site link that looks like a contact page. */
export function findContactPage(siteUrl: string, links: string[]): string | null {
  const host = hostOf(siteUrl);
  for (const l of links) {
    if (hostOf(l) === host && /contact|reach-us|find-us|location/i.test(l) && !/\.(png|jpe?g|pdf)$/i.test(l)) return l;
  }
  return null;
}

/**
 * Does the site's domain plausibly belong to this business? Uses only DISTINCTIVE name words
 * (generic words such as "hotel" are ignored) so e.g. "Madina Hotel" cannot match medina-hotels-sa.com.
 */
export function domainRelatesToName(host: string, name: string): boolean {
  const label = (host.replace(/^www./, '').split('.')[0] ?? '').replace(/[-_]/g, '');
  if (label.length < 4) return false;
  const tokens = nameTokens(name);
  const compact = tokens.join('');
  if (compact.length >= 4 && (label.includes(compact) || compact.includes(label))) return true;
  return tokens.some((t) => t.length >= 5 && label.includes(t));
}

const DHAKA_SPECIFIC = /dhaka|ঢাকা|gulshan|গুলশান|banani|বনানী|baridhara|বারিধারা|uttara|dhanmondi|mohakhali/i;

/** Evidence the business is in Dhaka: Dhaka/area named, or a Bangladeshi (.bd / 'bd') domain naming Bangladesh. */
export function dhakaEvidenceOnPage(text: string, host: string): boolean {
  if (DHAKA_SPECIFIC.test(text)) return true;
  const bdDomain = /.bd$/.test(host) || /bd./.test(host) || /-bd|bd$/.test(host.split('.')[0] ?? '');
  return bdDomain && /bangladesh|বাংলাদেশ/i.test(text);
}

/** False for names made only of generic words (e.g. "Hotel", "CNG restaurant"): they cannot be identified by search. */
export function hasDistinctiveName(name: string): boolean {
  return fold(name).split(' ').some((t) => t.length >= 3 && !STOPWORDS.has(t));
}
