/**
 * Own contacts: people and businesses a workspace types in or imports from Excel/CSV (parsed in the browser, sent as JSON rows).
 * They sit in a list next to directory businesses and can be used as campaign recipients.
 *
 * Rules built in:
 *  - every contact needs a usable phone or email; phones are stored as 8801XXXXXXXXX when they are Bangladeshi mobiles;
 *  - duplicates (same phone + email in the same list) are skipped, not overwritten;
 *  - an optional WhatsApp opt-in record (API only: method + proof) can be sent with an import; campaigns do not require one.
 */
import { q, one, pool } from './db.js';
import { validEmail } from './auth.js';
import { HttpError, body, need, on, str } from './http.js';
import { normalizeWaPhone } from './whatsapp.js';

export interface Contact { name: string | null; company: string | null; phone: string | null; email: string | null; area: string | null; district: string | null; note: string | null }
export const MAX_CONTACTS_PER_REQUEST = 5000;
/**
 * Own contacts are not directory businesses. Where a biz_id column holds them (campaign recipients, call items) it carries
 * 'contact:<list_contacts.id>' (from a list) or 'manual' / 'manual:<phone>' (typed straight into a campaign or call queue).
 */
export const isBizId = (id: string) => !/^(contact|manual)(:|$)/.test(id);

/** Cleans raw rows; returns usable contacts and the reason each other row was dropped (row = position in the input, 1-based). */
export function cleanContacts(raw: unknown, max = MAX_CONTACTS_PER_REQUEST): { contacts: Contact[]; rejected: { row: number; reason: string }[] } {
  const rows = Array.isArray(raw) ? raw.slice(0, max) : [];
  const contacts: Contact[] = [], rejected: { row: number; reason: string }[] = [];
  rows.forEach((r, i) => {
    const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    const rawPhone = str(String(o.phone ?? ''), 40), rawEmail = str(String(o.email ?? ''), 254).toLowerCase();
    const phone = normalizeWaPhone(rawPhone) ?? (rawPhone.replace(/[^\d+]/g, '').length >= 6 ? rawPhone.replace(/[^\d+]/g, '') : null);
    const email = validEmail(rawEmail) ? rawEmail : null;
    if (!phone && !email) { rejected.push({ row: i + 1, reason: rawPhone || rawEmail ? 'phone/email not valid' : 'no phone or email' }); return; }
    const t = (k: string, n = 120) => str(String(o[k] ?? ''), n) || null;
    contacts.push({ name: t('name'), company: t('company'), phone, email, area: t('area', 80), district: t('district', 80), note: t('note', 500) });
  });
  return { contacts, rejected };
}

const WA_METHODS = ['web_form', 'call_verbal', 'written', 'other'];
/** Validates an optional opt-in statement sent with imported contacts (before anything is saved). */
export function readConsent(consent: unknown): { method: string; proof: string } | null {
  const c = (consent && typeof consent === 'object' ? consent : null) as Record<string, unknown> | null;
  if (!c) return null;
  const method = WA_METHODS.includes(String(c.method)) ? String(c.method) : null;
  const proof = str(c.proof, 1000);
  if (!method) throw new HttpError(400, 'Say how the WhatsApp opt-in was given.');
  if (proof.length < 10) throw new HttpError(400, 'Describe the opt-in proof (who agreed, when, how). WhatsApp may ask you to show it.');
  return { method, proof };
}
/** Records WhatsApp opt-ins for imported numbers (skips numbers that already have an active one). Returns how many were added. */
export async function recordWaConsents(ws: string, userId: string, phones: string[], consent: { method: string; proof: string } | null): Promise<number> {
  if (!consent) return 0;
  const { method, proof } = consent;
  const mobiles = [...new Set(phones.map((p) => normalizeWaPhone(p)).filter((p): p is string => !!p))];
  if (!mobiles.length) return 0;
  const r = await pool.query(`INSERT INTO consents (workspace_id, channel, address, method, proof, recorded_by)
    SELECT $1, 'whatsapp', x, $3, $4, $5 FROM unnest($2::text[]) x
    WHERE NOT EXISTS (SELECT 1 FROM consents c WHERE c.workspace_id = $1 AND c.channel = 'whatsapp' AND c.address = x AND c.revoked_at IS NULL)`,
    [ws, mobiles, method, proof, userId]);
  await q(`DELETE FROM suppressions WHERE workspace_id = $1 AND channel = 'whatsapp' AND value = ANY($2::text[])`, [ws, mobiles]);
  return r.rowCount ?? 0;
}

const ownList = async (id: string, ws: string) => { if (!(await one(`SELECT 1 FROM lists WHERE id = $1 AND workspace_id = $2`, [id, ws]))) throw new HttpError(404, 'List not found.'); };

on('GET', '/api/lists/:id/contacts', async ({ p, m, ctx }) => {
  need(ctx);
  await ownList(m[1]!, ctx.workspaceId);
  const s = `%${(p.get('q') ?? '').toLowerCase()}%`;
  const where = `WHERE list_id = $1 AND (lower(coalesce(name, '') || ' ' || coalesce(company, '') || ' ' || coalesce(phone, '') || ' ' || coalesce(email, '')) LIKE $2)`;
  const [rows, total] = await Promise.all([
    q(`SELECT id::text, name, company, phone, email, area, district, note, source, added_at FROM list_contacts ${where} ORDER BY id DESC LIMIT 2000`, [m[1], s]),
    one<{ n: number }>(`SELECT COUNT(*)::int n FROM list_contacts ${where}`, [m[1], s]),
  ]);
  return { total: total?.n ?? 0, rows };
});
on('POST', '/api/lists/:id/contacts', async ({ req, m, ctx }) => {
  need(ctx);
  await ownList(m[1]!, ctx.workspaceId);
  const b = await body(req);
  const consent = readConsent(b.consent);
  const { contacts, rejected } = cleanContacts(b.contacts);
  const source = b.source === 'import' ? 'import' : 'manual';
  const cols = (k: keyof Contact) => contacts.map((c) => c[k]);
  const r = await pool.query(`INSERT INTO list_contacts (list_id, name, company, phone, email, area, district, note, source, added_by)
    SELECT $1, * , $9, $10 FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[])
    ON CONFLICT (list_id, coalesce(phone, ''), coalesce(email, '')) DO NOTHING`,
    [m[1], cols('name'), cols('company'), cols('phone'), cols('email'), cols('area'), cols('district'), cols('note'), source, ctx.userId]);
  const consents = await recordWaConsents(ctx.workspaceId, ctx.userId, contacts.map((c) => c.phone ?? ''), consent);
  const added = r.rowCount ?? 0;
  return { added, duplicates: contacts.length - added, rejected, consents };
});
on('DELETE', '/api/lists/:id/contacts', async ({ req, m, ctx }) => {
  need(ctx);
  await ownList(m[1]!, ctx.workspaceId);
  const ids = (await body(req)).ids;
  const r = await pool.query(`DELETE FROM list_contacts WHERE list_id = $1 AND id::text = ANY($2::text[])`, [m[1], Array.isArray(ids) ? ids.map(String) : []]);
  return { changed: r.rowCount };
});
