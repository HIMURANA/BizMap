/**
 * BizMap API (Phase 2): Postgres + PostGIS, email/password accounts, workspaces & teams, credits bought through
 * SSLCommerz, site-selection reports. Business data is a read-only copy synced from the pipeline (`npm run pg:sync`).
 * No web framework: node:http with a small router. Every SQL value is bound, never interpolated.
 */
import { createServer, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { ROOT, migrate, one, pool, q, tx } from './db.js';
import { buildFilter, orderBy, CHANNELS } from './filters.js';
import {
  atLeast, clearLoginFailures, clearSessionCookie, createSession, csrfOk, dummyVerify, getCtx, hashPassword, loginBlocked, newToken,
  passwordProblem, recordLoginFailure, sha256, validEmail, verifyPassword, clientIp, COOKIE, parseCookies, type Ctx,
} from './auth.js';
import { MODE as PAY_MODE, PACKS, appUrl, confirmPayment, markPayment, startCheckout, testGatewayHtml } from './billing.js';
import { siteReport } from './report.js';
import { HttpError, balance, body, json, need, on, rawBody, redirect, routes, str } from './http.js';
import './campaigns.js';
import './calls.js';
import './whatsapp.js';
import './waTemplates.js';
import './alerts.js';
import './contacts.js';
import { startWorkers } from './workers.js';

const EXPORT_DIR = resolve(ROOT, 'data/app_exports');
const WEB_DIST = resolve(ROOT, 'apps/web/dist');
const PORT = Number(process.env.API_PORT ?? 8787);
const TRIAL_CREDITS = Number(process.env.TRIAL_CREDITS ?? 200);
const ALLOW_SIGNUP = process.env.ALLOW_SIGNUP !== '0';
const MAP_POINT_LIMIT = 25000;
const ATTRIBUTION = '© OpenStreetMap contributors (ODbL 1.0) · Overture Maps Foundation (CDLA-Permissive-2.0 / Apache-2.0 / CC0) · Meta Ad Library entries collected by hand';
mkdirSync(EXPORT_DIR, { recursive: true });

// ------------------------------------------------------------------ accounts
async function createWorkspace(c: pg.Pool | pg.PoolClient, userId: string, name: string, trial: boolean) {
  const ws = (await c.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [name])).rows[0].id as string;
  await c.query(`INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [ws, userId]);
  if (trial && TRIAL_CREDITS > 0) await c.query(`INSERT INTO credit_ledger (workspace_id, delta, reason, user_id) VALUES ($1, $2, 'trial credits', $3)`, [ws, TRIAL_CREDITS, userId]);
  return ws;
}

async function me(ctx: Ctx) {
  const workspaces = await q(`SELECT w.id, w.name, m.role FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = $1 ORDER BY w.created_at`, [ctx.userId]);
  return { user: { id: ctx.userId, email: ctx.email, name: ctx.name }, workspace: workspaces.find((w) => w.id === ctx.workspaceId) ?? null, workspaces,
    credits: ctx.workspaceId ? await balance(ctx.workspaceId) : 0 };
}

async function inviteByToken(token: string) {
  return one<{ id: string; workspace_id: string; workspace: string; email: string; role: string; expires_at: Date; accepted_at: Date | null }>(
    `SELECT i.id, i.workspace_id, w.name AS workspace, i.email, i.role, i.expires_at, i.accepted_at FROM invites i JOIN workspaces w ON w.id = i.workspace_id WHERE i.token_hash = $1`, [sha256(token)]);
}
/** Throws unless the invite is usable by this email. Sign-up calls it BEFORE creating the account, so a bad invite leaves no orphan user. */
async function checkInvite(email: string, token: string) {
  const inv = await inviteByToken(token);
  if (!inv || inv.accepted_at || inv.expires_at < new Date()) throw new HttpError(410, 'This invite link is invalid or has expired.');
  if (inv.email.toLowerCase() !== email.toLowerCase()) throw new HttpError(403, `This invite was sent to ${inv.email}. Sign in with that email to accept it.`);
  return inv;
}
async function joinByInvite(userId: string, email: string, token: string) {
  const inv = await checkInvite(email, token);
  await tx(async (c) => {
    await c.query(`INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (workspace_id, user_id) DO NOTHING`, [inv.workspace_id, userId, inv.role]);
    await c.query(`UPDATE invites SET accepted_at = now() WHERE id = $1`, [inv.id]);
  });
  return inv.workspace_id;
}

// ------------------------------------------------------------------ business data
let metaCache: { syncId: number; data: unknown } | null = null;
async function meta() {
  const syncId = Number((await one<{ id: number }>(`SELECT COALESCE(MAX(id), 0) id FROM sync_runs WHERE finished_at IS NOT NULL`))?.id ?? 0);
  if (metaCache && metaCache.syncId === syncId) return metaCache.data;
  const [cats, subs, admin, names, areas, totals] = await Promise.all([
    q<{ id: string; label: string; n: number }>(`SELECT c.id, c.label, COUNT(b.id)::int n FROM biz_categories c LEFT JOIN biz b ON b.cat = c.id AND b.status <> 'needs_review' GROUP BY c.id, c.label, c.sort ORDER BY c.sort, c.id`),
    q<{ id: string; cat: string; label: string; n: number }>(`SELECT s.id, s.cat, s.label, COUNT(b.id)::int n FROM biz_subcategories s JOIN biz b ON b.sub = s.id AND b.status <> 'needs_review' GROUP BY s.id ORDER BY n DESC`),
    q<{ division: string; district: string; upazila: string | null; n: number }>(`SELECT division, district, upazila, COUNT(*)::int n FROM biz WHERE district IS NOT NULL AND status <> 'needs_review' GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`),
    q<{ name: string; name_bn: string | null; population: string | null }>(`SELECT name, name_bn, population FROM admin_areas WHERE level IN ('division', 'district')`),
    q(`SELECT area AS name, COUNT(*)::int n FROM biz WHERE area IS NOT NULL AND status <> 'needs_review' GROUP BY 1 ORDER BY 1`),
    one(`SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE status NOT IN ('lead','needs_review'))::int ready, COUNT(*) FILTER (WHERE status = 'lead')::int leads, COUNT(*) FILTER (WHERE status = 'needs_review')::int review FROM biz`),
  ]);
  const byName = new Map(names.map((a) => [a.name, a]));
  type D = { name: string; name_bn: string | null; population: number | null; n: number; upazilas: { name: string; n: number }[] };
  const divisions = new Map<string, { name: string; name_bn: string | null; n: number; districts: Map<string, D> }>();
  for (const r of admin) {
    const dv = divisions.get(r.division) ?? divisions.set(r.division, { name: r.division, name_bn: byName.get(r.division)?.name_bn ?? null, n: 0, districts: new Map() }).get(r.division)!;
    const pop = byName.get(r.district)?.population;
    const ds = dv.districts.get(r.district) ?? dv.districts.set(r.district, { name: r.district, name_bn: byName.get(r.district)?.name_bn ?? null, population: pop ? Number(pop) : null, n: 0, upazilas: [] }).get(r.district)!;
    dv.n += r.n; ds.n += r.n;
    if (r.upazila) ds.upazilas.push({ name: r.upazila, n: r.n });
  }
  const data = {
    categories: cats.map((c) => ({ ...c, subcategories: subs.filter((s) => s.cat === c.id) })),
    divisions: [...divisions.values()].map((d) => ({ ...d, districts: [...d.districts.values()] })),
    areas, totals, attribution: ATTRIBUTION,
    layers: [{ id: 'osm', label: 'OpenStreetMap' }, { id: 'overture', label: 'Overture Maps' }, { id: 'ad_library', label: 'Meta Ad Library (manual)' }, { id: 'web', label: 'Web search' }],
  };
  metaCache = { syncId, data };
  return data;
}

const ROW_COLS = `b.id, b.name, b.cat, b.sub, b.status, b.layer, b.score, b.src_conf, b.lat, b.lon, b.division, b.district, b.upazila, b.area, b.scope,
  b.phone, b.phone_status, b.email, b.email_status, b.website, b.website_status, b.facebook, b.facebook_status, b.instagram, b.instagram_status,
  b.fcommerce::int AS fcommerce, b.parent, b.first_seen`;

async function search(p: URLSearchParams, ws: string) {
  const f = buildFilter(p, ws);
  const page = Math.max(1, Number(p.get('page') ?? 1) || 1);
  const size = Math.min(200, Math.max(10, Number(p.get('page_size') ?? 50) || 50));
  const [total, rows] = await Promise.all([
    one<{ n: number }>(`SELECT COUNT(*)::int n FROM biz b ${f.where}`, f.params),
    q(`SELECT ${ROW_COLS}${f.distance ? `, ${f.distance} AS distance_km` : ''} FROM biz b ${f.where} ${orderBy(p, f)} LIMIT ${size} OFFSET ${(page - 1) * size}`, f.params),
  ]);
  return { total: total?.n ?? 0, page, page_size: size, rows };
}

async function facets(p: URLSearchParams, ws: string) {
  const f = buildFilter(p, ws);
  const by = (col: string) => q(`SELECT ${col} k, COUNT(*)::int n FROM biz b ${f.where} GROUP BY 1 ORDER BY n DESC`, f.params);
  const [category, district, layer, status, contact] = await Promise.all([
    by('b.cat'), by('b.district'), by('b.layer'),
    by(`CASE WHEN b.status = 'lead' THEN 'lead' WHEN b.status = 'needs_review' THEN 'review' ELSE 'ready' END`),
    one(`SELECT ${CHANNELS.map((c) => `COUNT(b.${c})::int ${c}`).join(', ')} FROM biz b ${f.where}`, f.params),
  ]);
  return { category, district, layer, status, contact };
}

async function mapPoints(p: URLSearchParams, ws: string) {
  const f = buildFilter(p, ws);
  const where = `${f.where ? `${f.where} AND` : 'WHERE'} b.geog IS NOT NULL`;
  const [total, rows] = await Promise.all([
    one<{ n: number }>(`SELECT COUNT(*)::int n FROM biz b ${where}`, f.params),
    q<{ id: string; lon: number; lat: number; cat: string; name: string }>(`SELECT b.id, round(b.lon::numeric, 5)::float8 lon, round(b.lat::numeric, 5)::float8 lat, b.cat, b.name FROM biz b ${where} ORDER BY b.score DESC LIMIT ${MAP_POINT_LIMIT}`, f.params),
  ]);
  return { total: total?.n ?? 0, truncated: (total?.n ?? 0) > rows.length, points: rows.map((r) => [r.id, r.lon, r.lat, r.cat, r.name]) };
}

async function business(id: string, ws: string) {
  const row = await one<Record<string, unknown>>(`SELECT b.*, b.fcommerce::int AS fcommerce, c.label AS cat_label, s.label AS sub_label FROM biz b JOIN biz_categories c ON c.id = b.cat LEFT JOIN biz_subcategories s ON s.id = b.sub WHERE b.id = $1`, [id]);
  if (!row) return null;
  delete row.geog; delete row.name_lc;
  const parentId = (row.parent as string | null) ?? id;
  const [contacts, socials, sources, nearby, branches, lists, reports] = await Promise.all([
    q(`SELECT type, value, status, source FROM biz_contacts WHERE biz_id = $1 ORDER BY type, status = 'verified' DESC`, [id]),
    q(`SELECT platform, url, status, source FROM biz_socials WHERE biz_id = $1`, [id]),
    q(`SELECT type, url, fetched_at FROM biz_sources WHERE biz_id = $1 ORDER BY fetched_at`, [id]),
    row.lat === null ? Promise.resolve([]) : q(`SELECT n.id, n.name, n.cat, ST_Distance(n.geog, b.geog) / 1000.0 AS distance_km FROM biz b JOIN biz n ON ST_DWithin(n.geog, b.geog, 500)
       WHERE b.id = $1 AND n.id <> b.id AND n.status <> 'needs_review' ORDER BY (n.cat = b.cat) DESC, n.geog <-> b.geog LIMIT 12`, [id]),
    q(`SELECT id, name, district, area FROM biz WHERE (parent = $1 OR id = $1) AND id <> $2 LIMIT 20`, [parentId, id]),
    q(`SELECT l.id, l.name FROM lists l JOIN list_items i ON i.list_id = l.id WHERE i.biz_id = $1 AND l.workspace_id = $2`, [id, ws]),
    q(`SELECT kind, note, status, created_at FROM data_reports WHERE biz_id = $1 ORDER BY id DESC LIMIT 20`, [id]),
  ]);
  return { ...row, contacts, socials, sources, nearby, branches, lists, reports, attribution: ATTRIBUTION };
}

// ------------------------------------------------------------------ exports
const PRESETS: Record<string, { label: string; cols: string[] }> = {
  sales_call: { label: 'Sales call sheet', cols: ['name', 'cat', 'sub', 'phone', 'phone_status', 'area', 'upazila', 'district', 'lat', 'lon'] },
  email: { label: 'Email list', cols: ['name', 'cat', 'email', 'email_status', 'website', 'district'] },
  location: { label: 'Locations only (no contacts)', cols: ['name', 'cat', 'sub', 'lat', 'lon', 'area', 'upazila', 'district', 'division'] },
  full: { label: 'Full record', cols: ['id', 'name', 'cat', 'sub', 'status', 'layer', 'score', 'src_conf', 'lat', 'lon', 'division', 'district', 'upazila', 'area', 'scope',
    'phone', 'phone_status', 'email', 'email_status', 'website', 'website_status', 'facebook', 'facebook_status', 'instagram', 'instagram_status', 'fcommerce', 'parent', 'first_seen'] },
};
const hasContacts = (cols: string[]) => cols.some((c) => (CHANNELS as readonly string[]).includes(c));
/** contact data costs 1 credit per row; location-only exports are free (no personal data) */
const costOf = (rows: number, cols: string[]) => (hasContacts(cols) ? rows : 0);

function exportScope(b: { query?: unknown; ids?: unknown; preset?: unknown }, ws: string) {
  const preset = PRESETS[String(b.preset ?? 'full')] ?? PRESETS.full!;
  const f = buildFilter(new URLSearchParams(typeof b.query === 'string' ? b.query : ''), ws);
  const params = [...f.params];
  const $ = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const parts = f.where ? [f.where.replace(/^WHERE /, '')] : [];
  if (Array.isArray(b.ids) && b.ids.length) parts.push(`b.id = ANY(${$(b.ids.slice(0, 100000).map(String))}::text[])`);
  // suppressed emails / phones of this workspace are never exported
  parts.push(`NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.workspace_id = ${$(ws)} AND s.value IN (b.email, b.phone))`);
  return { preset, where: `WHERE ${parts.join(' AND ')}`, params };
}

async function runExport(b: Record<string, unknown>, ctx: Ctx & { workspaceId: string }) {
  const format = ['csv', 'json', 'geojson'].includes(String(b.format)) ? String(b.format) : 'csv';
  const { preset, where, params } = exportScope(b, ctx.workspaceId);
  return tx(async (c) => {
    await c.query(`SELECT id FROM workspaces WHERE id = $1 FOR UPDATE`, [ctx.workspaceId]); // serialise credit spending per workspace
    const rows = (await c.query(`SELECT ${preset.cols.map((x) => (x === 'fcommerce' ? 'b.fcommerce::int AS fcommerce' : `b.${x}`)).join(', ')} FROM biz b ${where} ORDER BY b.cat, b.district, b.name_lc`, params)).rows as Record<string, unknown>[];
    const credits = costOf(rows.length, preset.cols);
    const bal = Number((await c.query(`SELECT COALESCE(SUM(delta), 0) b FROM credit_ledger WHERE workspace_id = $1`, [ctx.workspaceId])).rows[0].b);
    if (credits > bal) throw new HttpError(402, `Not enough credits: this export needs ${credits.toLocaleString()}, the workspace has ${bal.toLocaleString()}.`);
    const id = randomUUID();
    const file = resolve(EXPORT_DIR, `${id}.${format}`);
    if (format === 'csv') {
      const cell = (v: unknown) => (v === null || v === undefined ? '' : /[",\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
      writeFileSync(file, '﻿' + [[...preset.cols, 'attribution'].join(','), ...rows.map((r) => [...preset.cols.map((k) => cell(r[k])), cell(ATTRIBUTION)].join(','))].join('\r\n') + '\r\n');
    } else if (format === 'json') {
      writeFileSync(file, JSON.stringify({ attribution: ATTRIBUTION, generated_at: new Date().toISOString(), note: 'Not an exhaustive directory. Contacts are unverified unless marked verified.', rows }, null, 1));
    } else {
      writeFileSync(file, JSON.stringify({ type: 'FeatureCollection', attribution: ATTRIBUTION, features: rows.filter((r) => r.lat != null)
        .map((r) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.lon, r.lat] }, properties: r })) }));
    }
    const name = str(b.name, 80) || `${preset.label} ${new Date().toISOString().slice(0, 10)}`;
    await c.query(`INSERT INTO exports (id, workspace_id, user_id, name, format, preset, query, rows, credits, file) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, ctx.workspaceId, ctx.userId, name, format, String(b.preset ?? 'full'), typeof b.query === 'string' ? b.query : '', rows.length, credits, file]);
    if (credits) await c.query(`INSERT INTO credit_ledger (workspace_id, delta, reason, ref, user_id) VALUES ($1, $2, 'export', $3, $4)`, [ctx.workspaceId, -credits, id, ctx.userId]);
    return { id, rows: rows.length, credits, balance: bal - credits, download: `/api/exports/${id}/download` };
  });
}

// ------------------------------------------------------------------ static web app
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2' };
function serveWeb(path: string, res: ServerResponse) {
  if (!existsSync(WEB_DIST)) { res.writeHead(404).end('Web app not built: run `npm run app:build` (or use `npm run app:web` in development).'); return; }
  let file = resolve(WEB_DIST, '.' + path);
  if (!file.startsWith(WEB_DIST + sep) || !existsSync(file) || statSync(file).isDirectory()) file = resolve(WEB_DIST, 'index.html'); // SPA fallback
  const html = file.endsWith('.html');
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', ...(html ? { 'x-frame-options': 'DENY', 'cache-control': 'no-cache' } : { 'cache-control': 'public, max-age=31536000, immutable' }) });
  createReadStream(file).pipe(res);
}

// ------------------------------------------------------------------ routes (feature modules register theirs when imported)

// --- auth
on('POST', '/api/auth/signup', async ({ req, res }) => {
  const b = await body(req);
  const email = str(b.email, 254).toLowerCase(), name = str(b.name, 80), invite = str(b.invite, 100);
  if (!ALLOW_SIGNUP && !invite) throw new HttpError(403, 'Sign-up is by invitation only.');
  if (!validEmail(email)) throw new HttpError(400, 'Enter a valid email address.');
  if (!name) throw new HttpError(400, 'Enter your name.');
  const problem = passwordProblem(b.password);
  if (problem) throw new HttpError(400, problem);
  if (await one(`SELECT 1 FROM users WHERE lower(email) = $1`, [email])) throw new HttpError(409, 'An account with this email already exists. Sign in instead.');
  if (invite) await checkInvite(email, invite);
  const hash = await hashPassword(String(b.password));
  const user = (await one<{ id: string }>(`INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id`, [email, name, hash]))!;
  const ws = invite ? await joinByInvite(user.id, email, invite) : await createWorkspace(pool, user.id, str(b.workspace, 80) || `${name}'s workspace`, true);
  await createSession(req, res, user.id, ws);
  return { ok: true };
});
on('POST', '/api/auth/login', async ({ req, res }) => {
  const b = await body(req);
  const email = str(b.email, 254).toLowerCase(), pw = typeof b.password === 'string' ? b.password : '';
  const keys = [`e:${email}`, `ip:${clientIp(req)}`];
  if (loginBlocked(keys)) throw new HttpError(429, 'Too many failed attempts. Wait 15 minutes and try again.');
  const u = await one<{ id: string; password_hash: string }>(`SELECT id, password_hash FROM users WHERE lower(email) = $1`, [email]);
  const ok = u ? await verifyPassword(pw, u.password_hash) : await dummyVerify(pw);
  if (!u || !ok) { recordLoginFailure(keys); throw new HttpError(401, 'Email or password is incorrect.'); }
  clearLoginFailures(keys);
  const ws = await one<{ workspace_id: string }>(`SELECT workspace_id FROM memberships WHERE user_id = $1 ORDER BY created_at LIMIT 1`, [u.id]);
  await createSession(req, res, u.id, ws?.workspace_id ?? null);
  return { ok: true };
});
on('POST', '/api/auth/logout', async ({ req, res }) => {
  const t = parseCookies(req)[COOKIE];
  if (t) await q(`DELETE FROM sessions WHERE id = $1`, [sha256(t)]);
  clearSessionCookie(req, res);
  return { ok: true };
});
on('GET', '/api/auth/me', async ({ ctx }) => { if (!ctx) throw new HttpError(401, 'Not signed in.'); return me(ctx); });
on('POST', '/api/auth/workspace', async ({ req, ctx }) => {
  if (!ctx) throw new HttpError(401, 'Please sign in.');
  const id = str((await body(req)).id, 40);
  if (!(await one(`SELECT 1 FROM memberships WHERE user_id = $1 AND workspace_id::text = $2`, [ctx.userId, id]))) throw new HttpError(403, 'Not a member of that workspace.');
  await q(`UPDATE sessions SET workspace_id = $2 WHERE id = $1`, [ctx.sessionId, id]);
  return { ok: true };
});
on('POST', '/api/auth/password', async ({ req, ctx }) => {
  if (!ctx) throw new HttpError(401, 'Please sign in.');
  const b = await body(req);
  const u = await one<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [ctx.userId]);
  if (!u || !(await verifyPassword(String(b.current ?? ''), u.password_hash))) throw new HttpError(400, 'Current password is incorrect.');
  const problem = passwordProblem(b.next);
  if (problem) throw new HttpError(400, problem);
  await q(`UPDATE users SET password_hash = $2 WHERE id = $1`, [ctx.userId, await hashPassword(String(b.next))]);
  await q(`DELETE FROM sessions WHERE user_id = $1 AND id <> $2`, [ctx.userId, ctx.sessionId]); // sign out other devices
  return { ok: true };
});
on('POST', '/api/workspaces', async ({ req, ctx }) => {
  if (!ctx) throw new HttpError(401, 'Please sign in.');
  const name = str((await body(req)).name, 80);
  if (!name) throw new HttpError(400, 'Enter a workspace name.');
  const ws = await tx((c) => createWorkspace(c, ctx.userId, name, false)); // trial credits only come with a user's first workspace
  await q(`UPDATE sessions SET workspace_id = $2 WHERE id = $1`, [ctx.sessionId, ws]);
  return { id: ws };
});

// --- team
on('GET', '/api/invites/:token', async ({ m }) => {
  const inv = await inviteByToken(decodeURIComponent(m[1]!));
  if (!inv) throw new HttpError(404, 'Invite not found.');
  return { workspace: inv.workspace, email: inv.email, role: inv.role, valid: !inv.accepted_at && inv.expires_at > new Date(),
    has_account: !!(await one(`SELECT 1 FROM users WHERE lower(email) = lower($1)`, [inv.email])) };
});
on('POST', '/api/invites/:token/accept', async ({ m, ctx }) => {
  if (!ctx) throw new HttpError(401, 'Please sign in.');
  const ws = await joinByInvite(ctx.userId, ctx.email, decodeURIComponent(m[1]!));
  await q(`UPDATE sessions SET workspace_id = $2 WHERE id = $1`, [ctx.sessionId, ws]);
  return { ok: true };
});
on('GET', '/api/team', async ({ ctx }) => {
  need(ctx);
  const [members, invites] = await Promise.all([
    q(`SELECT u.id, u.name, u.email, m.role, m.created_at, u.last_login_at FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 ORDER BY m.created_at`, [ctx.workspaceId]),
    atLeast(ctx, 'admin') ? q(`SELECT id, email, role, created_at, expires_at FROM invites WHERE workspace_id = $1 AND accepted_at IS NULL AND expires_at > now() ORDER BY created_at DESC`, [ctx.workspaceId]) : Promise.resolve([]),
  ]);
  return { members, invites, me: ctx.userId, role: ctx.role };
});
on('POST', '/api/team/invites', async ({ req, ctx }) => {
  need(ctx, 'admin');
  const b = await body(req);
  const email = str(b.email, 254).toLowerCase(), role = b.role === 'admin' ? 'admin' : 'member';
  if (!validEmail(email)) throw new HttpError(400, 'Enter a valid email address.');
  if (await one(`SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND lower(u.email) = $2`, [ctx.workspaceId, email])) throw new HttpError(409, 'That person is already in this workspace.');
  const token = newToken();
  await q(`INSERT INTO invites (workspace_id, email, role, token_hash, invited_by, expires_at) VALUES ($1, $2, $3, $4, $5, now() + interval '7 days')`, [ctx.workspaceId, email, role, sha256(token), ctx.userId]);
  // Email delivery arrives with Phase 3 (SES); until then the admin copies the link and sends it.
  return { link: `/invite/${token}`, email, role };
});
on('DELETE', '/api/team/invites/:id', async ({ m, ctx }) => {
  need(ctx, 'admin');
  await q(`DELETE FROM invites WHERE id = $1 AND workspace_id = $2`, [m[1], ctx.workspaceId]);
  return { ok: true };
});
on('PATCH', '/api/team/members/:id', async ({ req, m, ctx }) => {
  need(ctx, 'owner');
  const role = String((await body(req)).role);
  if (!['owner', 'admin', 'member'].includes(role)) throw new HttpError(400, 'Unknown role.');
  if (m[1] === ctx.userId && role !== 'owner') {
    const owners = await one<{ n: number }>(`SELECT COUNT(*)::int n FROM memberships WHERE workspace_id = $1 AND role = 'owner'`, [ctx.workspaceId]);
    if ((owners?.n ?? 0) <= 1) throw new HttpError(400, 'Make someone else owner first: a workspace needs at least one owner.');
  }
  await q(`UPDATE memberships SET role = $3 WHERE workspace_id = $1 AND user_id = $2`, [ctx.workspaceId, m[1], role]);
  return { ok: true };
});
on('DELETE', '/api/team/members/:id', async ({ m, ctx }) => {
  need(ctx);
  const target = await one<{ role: string }>(`SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2`, [ctx.workspaceId, m[1]]);
  if (!target) throw new HttpError(404, 'Not a member.');
  const self = m[1] === ctx.userId;
  if (!self && !atLeast(ctx, 'admin')) throw new HttpError(403, 'Only workspace admins can remove people.');
  if (target.role === 'owner') {
    const owners = await one<{ n: number }>(`SELECT COUNT(*)::int n FROM memberships WHERE workspace_id = $1 AND role = 'owner'`, [ctx.workspaceId]);
    if (!self || (owners?.n ?? 0) <= 1) throw new HttpError(400, self ? 'You are the only owner: make someone else owner before leaving.' : 'Owners can only leave by themselves.');
  }
  await q(`DELETE FROM memberships WHERE workspace_id = $1 AND user_id = $2`, [ctx.workspaceId, m[1]]);
  if (self) await q(`UPDATE sessions SET workspace_id = NULL WHERE user_id = $1 AND workspace_id = $2`, [ctx.userId, ctx.workspaceId]);
  return { ok: true };
});

// --- explore
on('GET', '/api/meta', async ({ ctx }) => { need(ctx); return { ...(await meta() as object), credits: await balance(ctx.workspaceId) }; });
on('GET', '/api/search', async ({ p, ctx }) => { need(ctx); return search(p, ctx.workspaceId); });
on('GET', '/api/facets', async ({ p, ctx }) => { need(ctx); return facets(p, ctx.workspaceId); });
on('GET', '/api/map', async ({ p, ctx }) => { need(ctx); return mapPoints(p, ctx.workspaceId); });
on('GET', '/api/business/:id', async ({ m, ctx }) => {
  need(ctx);
  const b = await business(decodeURIComponent(m[1]!), ctx.workspaceId);
  if (!b) throw new HttpError(404, 'Business not found.');
  return b;
});
on('POST', '/api/business/:id/report', async ({ req, m, ctx }) => {
  need(ctx);
  const b = await body(req);
  const kinds = ['wrong_phone', 'wrong_email', 'closed', 'not_a_business', 'wrong_category', 'wrong_location', 'duplicate', 'other'];
  if (!kinds.includes(String(b.kind))) throw new HttpError(400, 'Unknown report kind.');
  await q(`INSERT INTO data_reports (biz_id, kind, note, workspace_id, user_id) VALUES ($1, $2, $3, $4, $5)`, [decodeURIComponent(m[1]!), String(b.kind), str(b.note, 1000), ctx.workspaceId, ctx.userId]);
  return { ok: true };
});

// --- lists & views
on('GET', '/api/lists', async ({ ctx }) => {
  need(ctx);
  return q(`SELECT l.id, l.name, l.created_at, (SELECT COUNT(*)::int FROM list_items i WHERE i.list_id = l.id) n, (SELECT COUNT(*)::int FROM list_contacts c WHERE c.list_id = l.id) contacts
    FROM lists l WHERE l.workspace_id = $1 ORDER BY l.created_at DESC`, [ctx.workspaceId]);
});
on('POST', '/api/lists', async ({ req, ctx }) => {
  need(ctx);
  const name = str((await body(req)).name, 80);
  if (!name) throw new HttpError(400, 'Enter a list name.');
  return one(`INSERT INTO lists (workspace_id, name, created_by) VALUES ($1, $2, $3) RETURNING id, name, 0 AS n, 0 AS contacts`, [ctx.workspaceId, name, ctx.userId]);
});
on('PATCH', '/api/lists/:id', async ({ req, m, ctx }) => {
  need(ctx);
  const name = str((await body(req)).name, 80);
  if (name) await q(`UPDATE lists SET name = $3 WHERE id = $1 AND workspace_id = $2`, [m[1], ctx.workspaceId, name]);
  return { ok: true };
});
on('DELETE', '/api/lists/:id', async ({ m, ctx }) => { need(ctx); await q(`DELETE FROM lists WHERE id = $1 AND workspace_id = $2`, [m[1], ctx.workspaceId]); return { ok: true }; });
const ownList = async (id: string, ws: string) => { if (!(await one(`SELECT 1 FROM lists WHERE id = $1 AND workspace_id = $2`, [id, ws]))) throw new HttpError(404, 'List not found.'); };
on('POST', '/api/lists/:id/items', async ({ req, m, ctx }) => {
  need(ctx);
  await ownList(m[1]!, ctx.workspaceId);
  const b = await body(req);
  if (typeof b.query === 'string') { // every record matching a filter (capped)
    const f = buildFilter(new URLSearchParams(b.query), ctx.workspaceId);
    const r = await pool.query(`INSERT INTO list_items (list_id, biz_id) SELECT ${f.next()}::uuid, b.id FROM biz b ${f.where} LIMIT 50000 ON CONFLICT DO NOTHING`, [...f.params, m[1]]);
    return { changed: r.rowCount };
  }
  const ids = Array.isArray(b.ids) ? b.ids.slice(0, 50000).map(String) : [];
  const r = await pool.query(`INSERT INTO list_items (list_id, biz_id) SELECT $1, x FROM unnest($2::text[]) x WHERE EXISTS (SELECT 1 FROM biz WHERE id = x) ON CONFLICT DO NOTHING`, [m[1], ids]);
  return { changed: r.rowCount };
});
on('DELETE', '/api/lists/:id/items', async ({ req, m, ctx }) => {
  need(ctx);
  await ownList(m[1]!, ctx.workspaceId);
  const ids = (await body(req)).ids;
  const r = await pool.query(`DELETE FROM list_items WHERE list_id = $1 AND biz_id = ANY($2::text[])`, [m[1], Array.isArray(ids) ? ids.map(String) : []]);
  return { changed: r.rowCount };
});
on('GET', '/api/views', async ({ ctx }) => { need(ctx); return q(`SELECT id, name, query, created_at FROM saved_views WHERE workspace_id = $1 ORDER BY created_at DESC`, [ctx.workspaceId]); });
on('POST', '/api/views', async ({ req, ctx }) => {
  need(ctx);
  const b = await body(req);
  const name = str(b.name, 80);
  if (!name) throw new HttpError(400, 'Enter a name.');
  return one(`INSERT INTO saved_views (workspace_id, name, query, created_by) VALUES ($1, $2, $3, $4) RETURNING id`, [ctx.workspaceId, name, str(b.query, 4000), ctx.userId]);
});
on('DELETE', '/api/views/:id', async ({ m, ctx }) => { need(ctx); await q(`DELETE FROM saved_views WHERE id = $1 AND workspace_id = $2`, [m[1], ctx.workspaceId]); return { ok: true }; });

// --- exports
on('GET', '/api/export/presets', async ({ ctx }) => { need(ctx); return Object.entries(PRESETS).map(([id, v]) => ({ id, ...v, paid: hasContacts(v.cols) })); });
on('POST', '/api/export/quote', async ({ req, ctx }) => {
  need(ctx);
  const { preset, where, params } = exportScope(await body(req), ctx.workspaceId);
  const rows = (await one<{ n: number }>(`SELECT COUNT(*)::int n FROM biz b ${where}`, params))?.n ?? 0;
  return { rows, credits: costOf(rows, preset.cols), balance: await balance(ctx.workspaceId), preset: preset.label, columns: preset.cols };
});
on('POST', '/api/export', async ({ req, ctx }) => { need(ctx); return runExport(await body(req), ctx); });
on('GET', '/api/exports', async ({ ctx }) => {
  need(ctx);
  return q(`SELECT e.id, e.name, e.format, e.preset, e.query, e.rows, e.credits, e.created_at, u.name AS by FROM exports e LEFT JOIN users u ON u.id = e.user_id WHERE e.workspace_id = $1 ORDER BY e.created_at DESC LIMIT 200`, [ctx.workspaceId]);
});
on('GET', '/api/exports/:id/download', async ({ res, m, ctx }) => {
  need(ctx);
  const e = await one<{ name: string; format: string; file: string }>(`SELECT name, format, file FROM exports WHERE id = $1 AND workspace_id = $2`, [m[1], ctx.workspaceId]);
  if (!e || !existsSync(e.file)) throw new HttpError(404, 'Export not found.');
  res.writeHead(200, { 'content-type': e.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json', 'content-disposition': `attachment; filename="${(e.name.replace(/[^\w\- ]+/g, '').trim() || 'export')}.${e.format}"` });
  createReadStream(e.file).pipe(res);
  return undefined;
}, true);

// --- billing
on('GET', '/api/billing', async ({ ctx }) => {
  need(ctx);
  const [payments, ledger] = await Promise.all([
    q(`SELECT tran_id, pack, amount_bdt, credits, status, provider, card_type, created_at, paid_at FROM payments WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 50`, [ctx.workspaceId]),
    q(`SELECT l.delta, l.reason, l.ref, l.created_at, u.name AS by FROM credit_ledger l LEFT JOIN users u ON u.id = l.user_id WHERE l.workspace_id = $1 ORDER BY l.id DESC LIMIT 100`, [ctx.workspaceId]),
  ]);
  return { mode: PAY_MODE, packs: PACKS, balance: await balance(ctx.workspaceId), payments, ledger, can_buy: atLeast(ctx, 'admin') };
});
on('POST', '/api/billing/checkout', async ({ req, ctx }) => {
  need(ctx, 'admin');
  const b = await body(req);
  const pack = PACKS.find((x) => x.id === b.pack);
  if (!pack) throw new HttpError(400, 'Unknown credit pack.');
  const phone = str(b.phone, 20).replace(/[\s-]/g, '');
  if (!/^(\+?880|0)1[3-9]\d{8}$/.test(phone)) throw new HttpError(400, 'Enter a Bangladeshi mobile number for the payment receipt (e.g. 01712345678).');
  return startCheckout({ workspaceId: ctx.workspaceId, userId: ctx.userId, email: ctx.email, name: ctx.name, phone, pack, origin: appUrl(req.headers.host) });
});
on('GET', '/api/billing/test-gateway/:tran', async ({ res, m }) => {
  const pay = await one<{ amount_bdt: string; credits: number; provider: string; status: string }>(`SELECT amount_bdt, credits, provider, status FROM payments WHERE tran_id = $1`, [m[1]]);
  if (PAY_MODE !== 'test' || !pay || pay.provider !== 'test' || pay.status !== 'pending') throw new HttpError(404, 'No pending test payment.');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY' });
  res.end(testGatewayHtml(m[1]!, pay.amount_bdt, pay.credits));
  return undefined;
}, true);
// Gateway callbacks: form posts from SSLCommerz (cross-site, so no session cookie). Never trusted: confirmPayment() validates with the gateway.
for (const kind of ['success', 'fail', 'cancel', 'ipn'] as const) {
  on('POST', `/api/billing/sslcommerz/${kind}`, async ({ req, res }) => {
    const f = new URLSearchParams(await rawBody(req));
    const tranId = f.get('tran_id') ?? '';
    let outcome: string = kind;
    if (kind === 'success' || kind === 'ipn') outcome = await confirmPayment(tranId, f.get('val_id') ?? '');
    else await markPayment(tranId, kind === 'fail' ? 'failed' : 'cancelled');
    if (kind === 'ipn') { json(res, 200, { ok: outcome !== 'invalid' }); return undefined; }
    redirect(res, `/settings/billing?payment=${outcome === 'already' ? 'paid' : outcome}`);
    return undefined;
  }, true);
}

// --- site reports
on('POST', '/api/reports/site', async ({ req, ctx }) => {
  need(ctx);
  const b = await body(req);
  const lat = Number(b.lat), lon = Number(b.lon), r = Number(b.radius_km);
  if (!(lat > 20 && lat < 27 && lon > 88 && lon < 93)) throw new HttpError(400, 'Pick a point inside Bangladesh.');
  if (!(r >= 0.2 && r <= 10)) throw new HttpError(400, 'Radius must be between 0.2 and 10 km.');
  const focus = typeof b.focus_cat === 'string' && b.focus_cat ? b.focus_cat : null;
  if (focus && !(await one(`SELECT 1 FROM biz_categories WHERE id = $1`, [focus]))) throw new HttpError(400, 'Unknown category.');
  const result = await siteReport(lat, lon, r, focus);
  const title = str(b.title, 120) || `${r} km around ${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  return one(`INSERT INTO site_reports (workspace_id, user_id, title, lat, lon, radius_km, focus_cat, result) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, title, lat, lon, radius_km, focus_cat, created_at, result`,
    [ctx.workspaceId, ctx.userId, title, lat, lon, r, focus, JSON.stringify(result)]);
});
on('GET', '/api/reports', async ({ ctx }) => {
  need(ctx);
  return q(`SELECT r.id, r.title, r.lat, r.lon, r.radius_km, r.focus_cat, r.created_at, u.name AS by FROM site_reports r LEFT JOIN users u ON u.id = r.user_id WHERE r.workspace_id = $1 ORDER BY r.created_at DESC LIMIT 100`, [ctx.workspaceId]);
});
on('GET', '/api/reports/:id', async ({ m, ctx }) => {
  need(ctx);
  const r = await one(`SELECT id, title, lat, lon, radius_km, focus_cat, result, created_at FROM site_reports WHERE id = $1 AND workspace_id = $2`, [m[1], ctx.workspaceId]);
  if (!r) throw new HttpError(404, 'Report not found.');
  return r;
});
on('DELETE', '/api/reports/:id', async ({ m, ctx }) => { need(ctx); await q(`DELETE FROM site_reports WHERE id = $1 AND workspace_id = $2`, [m[1], ctx.workspaceId]); return { ok: true }; });
on('GET', '/api/health', async () => ({ ok: true, payments: PAY_MODE, businesses: (await one<{ n: number }>(`SELECT COUNT(*)::int n FROM biz`))?.n ?? 0 }));

const UUID_PARAM = /^[0-9a-f-]{36}$/i;
createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname, method = req.method ?? 'GET';
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'same-origin');
  try {
    if (!path.startsWith('/api/')) return serveWeb(path, res);
    const route = routes.find((r) => r.method === method && r.re.test(path));
    if (!route) throw new HttpError(404, 'Unknown endpoint.');
    const m = path.match(route.re)!;
    // these resources are addressed by uuid; anything else is a 404 rather than a database error
    if (/^\/api\/(lists|views|exports|reports|team\/invites|team\/members|campaigns|calls\/queues|alerts|inbox)\//.test(path) && m[1] && !UUID_PARAM.test(m[1])) throw new HttpError(404, 'Not found.');
    // payment callbacks, one-click unsubscribe and provider webhooks are verified another way; every other write must pass the CSRF check
    if (method !== 'GET' && route.csrf && !path.startsWith('/api/billing/sslcommerz/') && !csrfOk(req)) throw new HttpError(403, 'Request blocked (cross-site or not JSON).');
    const ctx = await getCtx(req);
    const out = await route.h({ req, res, p: url.searchParams, m, ctx });
    if (!route.raw) json(res, 200, out);
  } catch (e) {
    if (res.headersSent) return void res.end();
    if (e instanceof HttpError) return json(res, e.status, { error: e.message });
    console.error(e);
    json(res, 500, { error: 'Something went wrong on the server.' });
  }
}).listen(PORT, '127.0.0.1', async () => {
  try {
    await migrate();
    startWorkers();
    const n = (await one<{ n: number }>(`SELECT COUNT(*)::int n FROM biz`))?.n ?? 0;
    console.log(`BizMap API on http://127.0.0.1:${PORT} · ${n.toLocaleString()} businesses in Postgres${n ? '' : ' (empty: run npm run pg:sync)'} · payments: ${PAY_MODE}`);
  } catch (e) {
    console.error('Database not ready:', e instanceof Error ? e.message : e);
    process.exit(1);
  }
});
