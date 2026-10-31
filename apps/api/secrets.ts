/**
 * Server secrets kept in the database (generated once): HMAC key for unsubscribe links and an AES-256-GCM key for
 * provider tokens customers store (WhatsApp access token, app secret). Env APP_SECRET overrides the generated master key.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { one, q } from './db.js';

const cache = new Map<string, Buffer>();
async function secret(name: string): Promise<Buffer> {
  if (name === 'master' && process.env.APP_SECRET) return createHash('sha256').update(process.env.APP_SECRET).digest();
  const hit = cache.get(name);
  if (hit) return hit;
  await q(`INSERT INTO app_secrets (name, value) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`, [name, randomBytes(32).toString('base64')]);
  const v = Buffer.from((await one<{ value: string }>(`SELECT value FROM app_secrets WHERE name = $1`, [name]))!.value, 'base64');
  cache.set(name, v);
  return v;
}

/** Signed, URL-safe token: payload.signature (payload is base64url JSON). */
export async function sign(payload: object): Promise<string> {
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const s = createHmac('sha256', await secret('master')).update(p).digest('base64url').slice(0, 32);
  return `${p}.${s}`;
}
export async function verify<T>(token: string): Promise<T | null> {
  const [p, s] = token.split('.');
  if (!p || !s) return null;
  const expected = createHmac('sha256', await secret('master')).update(p).digest('base64url').slice(0, 32);
  if (s.length !== expected.length || !timingSafeEqual(Buffer.from(s), Buffer.from(expected))) return null;
  try { return JSON.parse(Buffer.from(p, 'base64url').toString()) as T; } catch { return null; }
}

export async function encrypt(plain: string): Promise<string> {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', await secret('enc'), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1.${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${data.toString('base64')}`;
}
export async function decrypt(enc: string | null | undefined): Promise<string | null> {
  if (!enc) return null;
  const [v, iv, tag, data] = enc.split('.');
  if (v !== 'v1' || !iv || !tag || !data) return null;
  const d = createDecipheriv('aes-256-gcm', await secret('enc'), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}
