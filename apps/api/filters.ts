/** URL filter parameters -> parameterised Postgres WHERE clause over `biz b`. Values are always bound, never interpolated. */
export const CHANNELS = ['phone', 'email', 'website', 'facebook', 'instagram'] as const;
type Channel = (typeof CHANNELS)[number];

export interface Built { where: string; params: unknown[]; distance: string | null; next: () => string }

const list = (v: string | null) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
const num = (v: string | null) => (v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** workspaceId scopes list filters, so one workspace can never filter by another workspace's list. */
export function buildFilter(p: URLSearchParams, workspaceId: string): Built {
  const w: string[] = [];
  const params: unknown[] = [];
  const $ = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const inList = (col: string, vals: string[]) => { if (vals.length) w.push(`${col} = ANY(${$(vals)}::text[])`); };

  const qText = p.get('q')?.trim().toLowerCase();
  if (qText) {
    const digits = qText.replace(/\D/g, '');
    if (digits.length >= 6) w.push(`(b.name_lc LIKE ${$(`%${qText}%`)} OR replace(b.phone, '+', '') LIKE ${$(`%${digits.slice(-10)}%`)})`);
    else w.push(`b.name_lc LIKE ${$(`%${qText}%`)}`);
  }
  inList('b.cat', list(p.get('cat')));
  inList('b.sub', list(p.get('sub')));
  inList('b.division', list(p.get('division')));
  inList('b.district', list(p.get('district')));
  inList('b.upazila', list(p.get('upazila')));
  inList('b.area', list(p.get('area')));
  inList('b.scope', list(p.get('scope')));
  inList('b.layer', list(p.get('layer')));

  const status = list(p.get('status'));
  if (status.length) {
    const parts = status.map((s) => (s === 'ready' ? `b.status NOT IN ('lead','needs_review')` : s === 'lead' ? `b.status = 'lead'` : s === 'review' ? `b.status = 'needs_review'` : 'false'));
    w.push(`(${parts.join(' OR ')})`);
  } else {
    w.push(`b.status <> 'needs_review'`); // records held for review are hidden unless asked for
  }
  for (const ch of list(p.get('has')) as Channel[]) if (CHANNELS.includes(ch)) w.push(`b.${ch} IS NOT NULL`);
  for (const ch of list(p.get('verified')) as Channel[]) if (CHANNELS.includes(ch)) w.push(`b.${ch}_status = 'verified'`);
  const smin = num(p.get('score_min')), smax = num(p.get('score_max'));
  if (smin !== null) w.push(`b.score >= ${$(smin)}`);
  if (smax !== null) w.push(`b.score <= ${$(smax)}`);
  const cmin = num(p.get('src_conf_min'));
  if (cmin !== null) w.push(`(b.src_conf IS NULL OR b.src_conf >= ${$(cmin)})`);
  if (p.get('fcommerce') === '1') w.push(`b.fcommerce`);
  if (p.get('chain') === 'only') w.push(`(b.parent IS NOT NULL OR EXISTS (SELECT 1 FROM biz c WHERE c.parent = b.id))`);
  if (p.get('chain') === 'independent') w.push(`(b.parent IS NULL AND NOT EXISTS (SELECT 1 FROM biz c WHERE c.parent = b.id))`);
  const since = p.get('first_seen_after');
  if (since && /^\d{4}-\d{2}-\d{2}$/.test(since)) w.push(`b.first_seen >= ${$(since)}`);
  // bound only when used: Postgres rejects parameters that the query never references
  let wsRef: string | null = null;
  const ws = () => (wsRef ??= $(workspaceId));
  const inL = p.get('list');
  if (inL) w.push(UUID.test(inL) ? `b.id IN (SELECT i.biz_id FROM list_items i JOIN lists l ON l.id = i.list_id WHERE l.id = ${$(inL)} AND l.workspace_id = ${ws()})` : 'false');
  const notL = p.get('not_list');
  if (notL && UUID.test(notL)) w.push(`b.id NOT IN (SELECT i.biz_id FROM list_items i JOIN lists l ON l.id = i.list_id WHERE l.id = ${$(notL)} AND l.workspace_id = ${ws()})`);

  const bbox = list(p.get('bbox')).map(Number);
  if (bbox.length === 4 && bbox.every((x) => Number.isFinite(x))) {
    w.push(`b.geog && ST_MakeEnvelope(${$(bbox[0])}, ${$(bbox[1])}, ${$(bbox[2])}, ${$(bbox[3])}, 4326)::geography`);
  }
  let distance: string | null = null;
  const lat = num(p.get('lat')), lon = num(p.get('lon')), r = num(p.get('radius_km'));
  if (lat !== null && lon !== null && r !== null && r > 0 && r <= 100) {
    const pt = `ST_SetSRID(ST_MakePoint(${$(lon)}, ${$(lat)}), 4326)::geography`;
    w.push(`ST_DWithin(b.geog, ${pt}, ${$(r * 1000)})`);
    distance = `(ST_Distance(b.geog, ${pt}) / 1000.0)`;
  }
  // `next` lets callers append more bound values after the filter's own
  return { where: w.length ? `WHERE ${w.join(' AND ')}` : '', params, distance, next: () => `$${params.length + 1}` };
}

const SORTS: Record<string, string> = { name: 'b.name_lc', category: 'b.cat', district: 'b.district', area: 'b.area', score: 'b.score', first_seen: 'b.first_seen' };
export function orderBy(p: URLSearchParams, b: Built): string {
  const key = p.get('sort') ?? (b.distance ? 'distance' : 'score');
  if (key === 'distance' && b.distance) return `ORDER BY ${b.distance} ${p.get('dir') === 'desc' ? 'DESC' : 'ASC'}`;
  return `ORDER BY ${SORTS[key] ?? 'b.score'} ${p.get('dir') === 'asc' ? 'ASC' : 'DESC'} NULLS LAST, b.id`;
}
