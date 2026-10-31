import { useCallback, useMemo } from 'react';
import { navigate, useLocation } from './router';

/** All Explore filters live in the URL, so every search can be bookmarked, shared and saved as a view. */
export const MULTI = ['cat', 'sub', 'division', 'district', 'upazila', 'area', 'scope', 'layer', 'status', 'has', 'verified'] as const;
export const SINGLE = ['q', 'score_min', 'score_max', 'src_conf_min', 'fcommerce', 'chain', 'first_seen_after', 'list', 'not_list',
  'lat', 'lon', 'radius_km', 'bbox', 'sort', 'dir', 'page', 'page_size', 'open'] as const;
export type MultiKey = (typeof MULTI)[number];
export type SingleKey = (typeof SINGLE)[number];
/** Keys that change how results are shown, not which records match. */
const VIEW_ONLY = new Set(['sort', 'dir', 'page', 'page_size', 'open']);

export interface Filters {
  multi: Record<MultiKey, string[]>;
  single: Partial<Record<SingleKey, string>>;
}

export function parse(search: string): Filters {
  const p = new URLSearchParams(search);
  const multi = Object.fromEntries(MULTI.map((k) => [k, (p.get(k) ?? '').split(',').filter(Boolean)])) as Record<MultiKey, string[]>;
  const single: Filters['single'] = {};
  for (const k of SINGLE) { const v = p.get(k); if (v !== null && v !== '') single[k] = v; }
  return { multi, single };
}

export function serialize(f: Filters, opts: { matchOnly?: boolean } = {}): string {
  const p = new URLSearchParams();
  for (const k of MULTI) if (f.multi[k].length) p.set(k, f.multi[k].join(','));
  for (const k of SINGLE) {
    const v = f.single[k];
    if (v === undefined || v === '' || (opts.matchOnly && VIEW_ONLY.has(k))) continue;
    p.set(k, v);
  }
  return p.toString();
}

export function useFilters() {
  const { path, search } = useLocation();
  const filters = useMemo(() => parse(search), [search]);
  const commit = useCallback((next: Filters, keepPage = false) => {
    if (!keepPage) delete next.single.page;
    const qs = serialize(next);
    navigate(`${path}${qs ? `?${qs}` : ''}`, true);
  }, [path]);

  const toggle = useCallback((k: MultiKey, v: string) => {
    const cur = filters.multi[k];
    commit({ ...filters, multi: { ...filters.multi, [k]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] } });
  }, [filters, commit]);
  const setMulti = useCallback((k: MultiKey, vals: string[]) => commit({ ...filters, multi: { ...filters.multi, [k]: vals } }), [filters, commit]);
  const set = useCallback((patch: Partial<Record<SingleKey, string | undefined>>, keepPage = false) => {
    const single = { ...filters.single };
    for (const [k, v] of Object.entries(patch)) { if (v === undefined || v === '') delete single[k as SingleKey]; else single[k as SingleKey] = v; }
    commit({ ...filters, single }, keepPage || Object.keys(patch).every((k) => VIEW_ONLY.has(k) && k !== 'sort'));
  }, [filters, commit]);
  const reset = useCallback(() => navigate(path, true), [path]);

  /** query string of the filters that decide WHICH records match (used for map, facets, lists, exports) */
  const matchQuery = useMemo(() => serialize(filters, { matchOnly: true }), [filters]);
  const fullQuery = useMemo(() => serialize({ ...filters, single: { ...filters.single, open: undefined } }), [filters]);
  return { filters, toggle, setMulti, set, reset, matchQuery, fullQuery };
}
