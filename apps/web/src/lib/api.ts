export type Status = 'verified' | 'search_match' | 'unverified' | 'invalid' | null;

export interface BusinessRow {
  id: string; name: string; cat: string; sub: string | null; status: string; layer: string; score: number; src_conf: number | null;
  lat: number | null; lon: number | null; division: string | null; district: string | null; upazila: string | null; area: string | null; scope: string | null;
  phone: string | null; phone_status: Status; email: string | null; email_status: Status; website: string | null; website_status: Status;
  facebook: string | null; facebook_status: Status; instagram: string | null; instagram_status: Status;
  fcommerce: number; parent: string | null; first_seen: string; distance_km?: number;
}
export interface SearchResult { total: number; page: number; page_size: number; rows: BusinessRow[] }
export interface Category { id: string; label: string; n: number; subcategories: { id: string; cat: string; label: string; n: number }[] }
export interface District { name: string; name_bn: string | null; population: number | null; n: number; upazilas: { name: string; n: number }[] }
export interface Division { name: string; name_bn: string | null; n: number; districts: District[] }
export interface Meta {
  categories: Category[]; divisions: Division[]; areas: { name: string; n: number }[];
  totals: { total: number; ready: number; leads: number; review: number }; attribution: string; credits: number;
  layers: { id: string; label: string }[];
}
export interface Facets {
  category: { k: string; n: number }[]; district: { k: string | null; n: number }[]; layer: { k: string; n: number }[]; status: { k: string; n: number }[];
  contact: Record<'phone' | 'email' | 'website' | 'facebook' | 'instagram', number>;
}
export interface MapData { total: number; truncated: boolean; points: [string, number, number, string, string][] }
export interface BusinessDetail extends BusinessRow {
  cat_label: string; sub_label: string | null; description: string | null; band: string | null; osm_url: string | null;
  contacts: { type: string; value: string; status: Status; source: string | null }[];
  socials: { platform: string; url: string; status: Status; source: string | null }[];
  sources: { type: string; url: string | null; fetched_at: string }[];
  nearby: { id: string; name: string; cat: string; distance_km: number }[];
  branches: { id: string; name: string; district: string | null; area: string | null }[];
  lists: { id: string; name: string }[];
  reports: { kind: string; note: string; status: string; created_at: string }[];
  attribution: string;
}
export interface UserList { id: string; name: string; created_at: string; n: number; contacts: number }
export interface SavedView { id: string; name: string; query: string; created_at: string }
export interface ExportPreset { id: string; label: string; cols: string[]; paid: boolean }
export interface ExportRecord { id: string; name: string; format: string; preset: string; query: string; rows: number; credits: number; created_at: string }
export type Role = 'owner' | 'admin' | 'member';
export interface Me { user: { id: string; email: string; name: string }; workspace: { id: string; name: string; role: Role; suspended: boolean } | null; workspaces: { id: string; name: string; role: Role; suspended: boolean }[]; credits: number; platform_admin: boolean }
export interface Team { members: { id: string; name: string; email: string; role: Role; created_at: string; last_login_at: string | null }[]; invites: { id: string; email: string; role: Role; created_at: string; expires_at: string }[]; me: string; role: Role }
export interface InviteInfo { workspace: string; email: string; role: Role; valid: boolean; has_account: boolean }
export interface Billing {
  mode: 'live' | 'sandbox' | 'test' | 'disabled'; packs: { id: string; label: string; credits: number; bdt: number }[]; balance: number; can_buy: boolean;
  payments: { tran_id: string; pack: string; amount_bdt: string; credits: number; status: string; provider: string; card_type: string | null; created_at: string; paid_at: string | null }[];
  ledger: { delta: number; reason: string; ref: string | null; created_at: string; by: string | null }[];
}
export interface SiteReportResult {
  point: { lat: number; lon: number }; radius_km: number; generated_at: string;
  totals: { cat: string; label: string; ready: number; lead: number }[];
  focus: null | { cat: string; label: string; ready: number; lead: number; per_10k: number | null; nearest: { id: string; name: string; distance_m: number; status: string; phone: string | null }[] };
  anchors: { cat: string; label: string; count: number; nearest: { id: string; name: string; distance_m: number } | null }[];
  population: { estimate: number | null; from_upazilas: number; from_districts: number; covered_share: number; quality?: 'grid' | 'upazila' | 'mixed' | 'district_average' | 'none'; admin_estimate?: number | null; source?: string; areas: { name: string; level: string; population: number; share: number }[]; method: string };
  per_10k_all: number | null; caveats: string[];
}
export interface SiteReportRecord { id: string; title: string; lat: number; lon: number; radius_km: number; focus_cat: string | null; created_at: string; by?: string; result?: SiteReportResult }
export interface Quote { rows: number; credits: number; balance: number; preset: string; columns: string[] }

/** Error carrying the HTTP status, so the app can tell "signed out" (401) from other failures. */
export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }

export async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body as T;
}
export const send = <T>(path: string, method: string, body?: unknown) => req<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  me: () => req<Me>('/auth/me'),
  login: (email: string, password: string) => send('/auth/login', 'POST', { email, password }),
  signup: (b: { name: string; email: string; password: string; workspace?: string; invite?: string }) => send('/auth/signup', 'POST', b),
  logout: () => send('/auth/logout', 'POST', {}),
  switchWorkspace: (id: string) => send('/auth/workspace', 'POST', { id }),
  createWorkspace: (name: string) => send<{ id: string }>('/workspaces', 'POST', { name }),
  changePassword: (current: string, next: string) => send('/auth/password', 'POST', { current, next }),
  invite: (token: string) => req<InviteInfo>(`/invites/${encodeURIComponent(token)}`),
  acceptInvite: (token: string) => send(`/invites/${encodeURIComponent(token)}/accept`, 'POST', {}),
  team: () => req<Team>('/team'),
  createInvite: (email: string, role: Role) => send<{ link: string; email: string; role: Role }>('/team/invites', 'POST', { email, role }),
  revokeInvite: (id: string) => send(`/team/invites/${id}`, 'DELETE', {}),
  setRole: (userId: string, role: Role) => send(`/team/members/${userId}`, 'PATCH', { role }),
  removeMember: (userId: string) => send(`/team/members/${userId}`, 'DELETE', {}),
  billing: () => req<Billing>('/billing'),
  checkout: (pack: string, phone: string) => send<{ redirect: string }>('/billing/checkout', 'POST', { pack, phone }),
  siteReport: (b: { lat: number; lon: number; radius_km: number; focus_cat?: string; title?: string }) => send<SiteReportRecord>('/reports/site', 'POST', b),
  reports: () => req<SiteReportRecord[]>('/reports'),
  getReport: (id: string) => req<SiteReportRecord>(`/reports/${id}`),
  deleteReport: (id: string) => send(`/reports/${id}`, 'DELETE', {}),
  meta: () => req<Meta>('/meta'),
  search: (qs: string) => req<SearchResult>(`/search?${qs}`),
  facets: (qs: string) => req<Facets>(`/facets?${qs}`),
  map: (qs: string) => req<MapData>(`/map?${qs}`),
  business: (id: string) => req<BusinessDetail>(`/business/${encodeURIComponent(id)}`),
  report: (id: string, kind: string, note: string) => send(`/business/${encodeURIComponent(id)}/report`, 'POST', { kind, note }),
  lists: () => req<UserList[]>('/lists'),
  createList: (name: string) => send<{ id: string; name: string }>('/lists', 'POST', { name }),
  renameList: (id: string, name: string) => send(`/lists/${id}`, 'PATCH', { name }),
  deleteList: (id: string) => send(`/lists/${id}`, 'DELETE', {}),
  addToList: (id: string, sel: { ids?: string[]; query?: string }) => send<{ changed: number }>(`/lists/${id}/items`, 'POST', sel),
  removeFromList: (id: string, ids: string[]) => send(`/lists/${id}/items`, 'DELETE', { ids }),
  views: () => req<SavedView[]>('/views'),
  saveView: (name: string, query: string) => send('/views', 'POST', { name, query }),
  deleteView: (id: string) => send(`/views/${id}`, 'DELETE', {}),
  presets: () => req<ExportPreset[]>('/export/presets'),
  quote: (b: { query?: string; ids?: string[]; preset: string }) => send<Quote>('/export/quote', 'POST', b),
  runExport: (b: { query?: string; ids?: string[]; preset: string; format: string; name: string }) =>
    send<{ id: string; rows: number; credits: number; balance: number; download: string }>('/export', 'POST', b),
  exports: () => req<ExportRecord[]>('/exports'),
};
