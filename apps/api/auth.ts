/**
 * Built-in email + password auth.
 *  - passwords: scrypt (N=16384, r=8, p=1), 16-byte random salt, constant-time comparison;
 *  - sessions: 32 random bytes in an httpOnly SameSite=Lax cookie; only the SHA-256 of the token is stored;
 *  - brute force: failed logins limited per email and per IP (in memory, so per server process);
 *  - CSRF: state-changing requests must be JSON and same-origin (cookies alone are not enough).
 */
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { one, q } from './db.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const COOKIE = 'bm_session';
const SESSION_DAYS = 30;
export const MIN_PASSWORD = 10;

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, N, r, p, salt, key] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const got = await scrypt(pw, Buffer.from(salt, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** A precomputed hash so unknown emails take as long as wrong passwords (no account enumeration by timing). */
let dummyHash: Promise<string> | null = null;
export const dummyVerify = async (pw: string) => verifyPassword(pw, await (dummyHash ??= hashPassword('not-a-real-password')));

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');

export function validEmail(e: unknown): e is string {
  return typeof e === 'string' && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
}
export function passwordProblem(pw: unknown): string | null {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters.`;
  if (pw.length > 200) return 'Password is too long.';
  if (/^(.)\1+$/.test(pw) || /^(0123456789|1234567890|password)/i.test(pw)) return 'Please choose a less guessable password.';
  return null;
}

// ------------------------------------------------------------------ cookies
export function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const secure = (req: IncomingMessage) => process.env.NODE_ENV === 'production' || req.headers['x-forwarded-proto'] === 'https';
export function setSessionCookie(req: IncomingMessage, res: ServerResponse, token: string) {
  res.setHeader('set-cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure(req) ? '; Secure' : ''}`);
}
export function clearSessionCookie(req: IncomingMessage, res: ServerResponse) {
  res.setHeader('set-cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure(req) ? '; Secure' : ''}`);
}

export async function createSession(req: IncomingMessage, res: ServerResponse, userId: string, workspaceId: string | null) {
  const token = newToken();
  await q(`INSERT INTO sessions (id, user_id, workspace_id, expires_at, user_agent, ip) VALUES ($1, $2, $3, now() + interval '${SESSION_DAYS} days', $4, $5)`,
    [sha256(token), userId, workspaceId, String(req.headers['user-agent'] ?? '').slice(0, 300), clientIp(req)]);
  await q(`UPDATE users SET last_login_at = now() WHERE id = $1`, [userId]);
  setSessionCookie(req, res, token);
}

export interface Ctx {
  sessionId: string; userId: string; email: string; name: string;
  workspaceId: string | null; role: 'owner' | 'admin' | 'member' | null;
  /** DigitalLeon staff: may use the /api/admin routes. Set only from PLATFORM_ADMIN_EMAILS. */
  platformAdmin: boolean;
  /** The current workspace was suspended by a platform admin. */
  workspaceSuspended: boolean;
}

/** Resolves the session cookie to a user and current workspace (null when signed out or expired). */
export async function getCtx(req: IncomingMessage): Promise<Ctx | null> {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const row = await one<{ id: string; user_id: string; email: string; name: string; workspace_id: string | null; role: Ctx['role']; platform_admin: boolean; suspended: boolean }>(
    `SELECT s.id, s.user_id, u.email, u.name, m.workspace_id, m.role, u.is_platform_admin AS platform_admin, (w.suspended_at IS NOT NULL) AS suspended
     FROM sessions s JOIN users u ON u.id = s.user_id
     LEFT JOIN memberships m ON m.user_id = s.user_id AND m.workspace_id = s.workspace_id
     LEFT JOIN workspaces w ON w.id = m.workspace_id
     WHERE s.id = $1 AND s.expires_at > now() AND u.disabled_at IS NULL`, [sha256(token)]);
  if (!row) return null;
  return { sessionId: row.id, userId: row.user_id, email: row.email, name: row.name, workspaceId: row.workspace_id, role: row.role, platformAdmin: row.platform_admin, workspaceSuspended: !!row.suspended };
}

export const ROLE_RANK = { member: 1, admin: 2, owner: 3 } as const;
export const atLeast = (ctx: Ctx, role: keyof typeof ROLE_RANK) => !!ctx.role && ROLE_RANK[ctx.role] >= ROLE_RANK[role];

// ------------------------------------------------------------------ abuse protection
export function clientIp(req: IncomingMessage): string {
  // only trust X-Forwarded-For when explicitly running behind a proxy
  const fwd = process.env.TRUST_PROXY === '1' ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() : '';
  return fwd || req.socket.remoteAddress || 'unknown';
}

const failures = new Map<string, { n: number; until: number }>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 8;
export function loginBlocked(keys: string[]): boolean {
  const now = Date.now();
  return keys.some((k) => { const f = failures.get(k); return !!f && f.until > now && f.n >= MAX_FAILS; });
}
export function recordLoginFailure(keys: string[]) {
  const now = Date.now();
  for (const k of keys) {
    const f = failures.get(k);
    failures.set(k, f && f.until > now ? { n: f.n + 1, until: f.until } : { n: 1, until: now + WINDOW_MS });
  }
  if (failures.size > 50000) for (const [k, f] of failures) if (f.until < now) failures.delete(k);
}
export const clearLoginFailures = (keys: string[]) => keys.forEach((k) => failures.delete(k));

/**
 * CSRF guard for cookie-authenticated writes: require a JSON body (a cross-site HTML form cannot send one without a
 * CORS preflight, which we never grant) and, when the browser sends Origin, that it matches our host.
 */
export function csrfOk(req: IncomingMessage): boolean {
  const ct = String(req.headers['content-type'] ?? '');
  if (!ct.startsWith('application/json')) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const o = new URL(origin);
    const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '');
    return o.host === host || (process.env.APP_URL ? o.origin === new URL(process.env.APP_URL).origin : false);
  } catch {
    return false;
  }
}
