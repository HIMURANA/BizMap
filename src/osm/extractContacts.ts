/**
 * Extract contact data that mappers already recorded in OSM tags.
 * Everything here is stored as 'unverified' with the OSM element URL as its source:
 * OSM tags are community-edited and may be stale. Nothing is guessed or generated.
 */

export interface ExtractedContact {
  type: 'phone' | 'email' | 'website';
  raw: string;
  normalized: string | null;
}

export interface ExtractedSocial {
  platform: 'facebook' | 'instagram';
  url: string;
}

const PHONE_KEYS = ['phone', 'contact:phone', 'contact:mobile', 'mobile'];
const EMAIL_KEYS = ['email', 'contact:email'];
const WEBSITE_KEYS = ['website', 'contact:website', 'url'];

function splitMulti(v: string): string[] {
  return v.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
}

/** Normalize Bangladeshi numbers to E.164 (+880...). Returns null when not confidently parseable. */
export function normalizeBdPhone(raw: string): string | null {
  let d = raw.replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('880')) d = d.slice(3);
  if (d.startsWith('0')) d = d.slice(1);
  // Mobile: 1[3-9]XXXXXXXX (10 digits). Dhaka landline: 2 + 7–8 digits. Other landlines/IP: 9–10 digits.
  if (/^1[3-9]\d{8}$/.test(d)) return `+880${d}`;
  if (/^2\d{7,8}$/.test(d)) return `+880${d}`;
  if (/^[3-9]\d{7,9}$/.test(d)) return `+880${d}`;
  return null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

export function normalizeUrl(raw: string): string | null {
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(candidate);
    if (!u.hostname.includes('.')) return null;
    u.hash = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function socialPlatform(url: string): ExtractedSocial['platform'] | null {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\.|^m\.|^web\./, '');
    if (host === 'facebook.com' || host === 'fb.com' || host === 'fb.me') return 'facebook';
    if (host === 'instagram.com' || host === 'instagr.am') return 'instagram';
  } catch {
    /* not a URL */
  }
  return null;
}

export function extractFromTags(tags: Record<string, string>): { contacts: ExtractedContact[]; socials: ExtractedSocial[] } {
  const contacts: ExtractedContact[] = [];
  const socials: ExtractedSocial[] = [];
  const seen = new Set<string>();
  const push = (c: ExtractedContact) => {
    const k = `${c.type}:${c.normalized ?? c.raw}`;
    if (!seen.has(k)) {
      seen.add(k);
      contacts.push(c);
    }
  };
  const pushSocial = (s: ExtractedSocial) => {
    const k = `${s.platform}:${s.url}`;
    if (!seen.has(k)) {
      seen.add(k);
      socials.push(s);
    }
  };

  for (const key of PHONE_KEYS) {
    for (const raw of splitMulti(tags[key] ?? '')) push({ type: 'phone', raw, normalized: normalizeBdPhone(raw) });
  }
  for (const key of EMAIL_KEYS) {
    for (const raw of splitMulti(tags[key] ?? '')) {
      push({ type: 'email', raw, normalized: EMAIL_RE.test(raw) ? raw.toLowerCase() : null });
    }
  }
  for (const key of WEBSITE_KEYS) {
    for (const raw of splitMulti(tags[key] ?? '')) {
      const url = normalizeUrl(raw);
      // A facebook/instagram URL in the website tag is a social link, not an official website.
      const platform = url ? socialPlatform(url) : null;
      if (url && platform) pushSocial({ platform, url });
      else push({ type: 'website', raw, normalized: url });
    }
  }
  for (const [key, platform] of [
    ['contact:facebook', 'facebook'],
    ['facebook', 'facebook'],
    ['contact:instagram', 'instagram'],
    ['instagram', 'instagram'],
  ] as const) {
    const raw = tags[key]?.trim();
    if (!raw) continue;
    // Values may be full URLs or bare handles/page names.
    const url = raw.includes('/') || raw.includes('.')
      ? normalizeUrl(raw)
      : `https://www.${platform}.com/${raw.replace(/^@/, '')}`;
    if (url && socialPlatform(url) === platform) pushSocial({ platform, url });
  }
  return { contacts, socials };
}
