/** Shared request helpers and the route table, so feature modules (campaigns, calls, WhatsApp, alerts) can register routes. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { one } from './db.js';
import { atLeast, type Ctx } from './auth.js';

export class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

export const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
export const html = (res: ServerResponse, status: number, page: string) => {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY', 'cache-control': 'no-store' });
  res.end(page);
};
export const redirect = (res: ServerResponse, to: string) => { res.writeHead(303, { location: to }); res.end(); };

export async function rawBody(req: IncomingMessage): Promise<string> {
  let s = '';
  for await (const c of req) { s += c; if (s.length > 2e6) throw new HttpError(413, 'Request body too large.'); }
  return s;
}
export async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const s = await rawBody(req);
  try { return s ? JSON.parse(s) : {}; } catch { throw new HttpError(400, 'Invalid JSON body.'); }
}
export const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export async function balance(ws: string): Promise<number> {
  return Number((await one<{ b: string }>(`SELECT COALESCE(SUM(delta), 0) b FROM credit_ledger WHERE workspace_id = $1`, [ws]))?.b ?? 0);
}
export function need(ctx: Ctx | null, role: 'member' | 'admin' | 'owner' = 'member'): asserts ctx is Ctx & { workspaceId: string } {
  if (!ctx) throw new HttpError(401, 'Please sign in.');
  if (!ctx.workspaceId) throw new HttpError(403, 'Choose or create a workspace first.');
  if (!atLeast(ctx, role)) throw new HttpError(403, role === 'owner' ? 'Only the workspace owner can do this.' : 'Only workspace admins can do this.');
}

export type Handler = (a: { req: IncomingMessage; res: ServerResponse; p: URLSearchParams; m: RegExpMatchArray; ctx: Ctx | null }) => Promise<unknown>;
/** `raw`: the handler writes the response itself. `csrf: false`: callers are mail clients or providers, checked another way. */
export const routes: { method: string; re: RegExp; h: Handler; raw: boolean; csrf: boolean }[] = [];
export const on = (method: string, path: string, h: Handler, raw = false, opts: { csrf?: boolean } = {}) =>
  routes.push({ method, re: new RegExp(`^${path.replace(/:\w+/g, '([^/]+)')}$`), h, raw, csrf: opts.csrf ?? true });

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
