/**
 * Campaigns (email, WhatsApp and automated voice calls, see voice.ts), sending settings, suppression list and unsubscribe.
 *
 * Rules built in (not optional):
 *  - email goes to business addresses found in public sources or to the workspace's own contacts (typed in or imported,
 *    see contacts.ts), always with the sender's identity, postal address, why they are receiving it and a one-click
 *    unsubscribe (List-Unsubscribe + List-Unsubscribe-Post, RFC 8058);
 *  - the workspace suppression list is checked when the audience is built AND again right before each send;
 *  - WhatsApp campaigns reach every Bangladeshi mobile in the audience (no recorded opt-in needed; anyone who replies STOP is
 *    suppressed), and only with Meta-approved templates;
 *  - a daily cap per workspace (default 200 emails) keeps new senders out of spam folders;
 *  - 1 credit per recipient (VOICE_CREDITS_PER_CALL for voice calls), charged at launch; nothing is sent from drafts.
 */
import { q, one, tx } from './db.js';
import { buildFilter } from './filters.js';
import { atLeast } from './auth.js';
import { HttpError, body, html, need, on, rawBody, str, esc, balance } from './http.js';
import { sendMail, MAIL_MODE } from './mailer.js';
import { sign, verify } from './secrets.js';
import { WA_TEST_TEMPLATES, listWaTemplates, normalizeWaPhone, readWaHeader, sendWaTemplate, waConfig, type WaHeader } from './whatsapp.js';
import { cleanContacts, isBizId, type Contact } from './contacts.js';
import { INTRO, OUTRO, VOICES, VOICE_CREDITS_PER_CALL, clipName, describe, normalizeBdPhone, phoneForms, processVoice, testCall, ttsMode, voiceMode, type Part } from './voice.js';

export type Channel = 'email' | 'whatsapp' | 'voice';
const creditsPer = (ch: Channel) => (ch === 'voice' ? VOICE_CREDITS_PER_CALL : 1);
/** What is played on an automated call: who is calling, the message (text or the workspace's own recording), how to answer / opt out. */
const speech = (sender: string, body: string, merge: Record<string, string>, clip: { id: string; name: string } | null): Part[] =>
  [{ text: INTRO(sender) }, clip ? { clip: clip.id, label: `recording: ${clip.name}` } : { text: render(body, merge).trim() }, { text: OUTRO }];

const PUBLIC_URL = () => (process.env.APP_URL ?? `http://localhost:${process.env.API_PORT ?? 8787}`).replace(/\/$/, '');
const BATCH_PER_TICK = 20;

export interface Settings {
  sender_name: string | null; sender_email: string | null; reply_to: string | null; postal_address: string | null;
  daily_email_cap: number; call_hours_start: number; call_hours_end: number;
}
export async function settings(ws: string): Promise<Settings> {
  return (await one<Settings>(`SELECT sender_name, sender_email, reply_to, postal_address, daily_email_cap, call_hours_start, call_hours_end FROM workspace_settings WHERE workspace_id = $1`, [ws]))
    ?? { sender_name: null, sender_email: null, reply_to: null, postal_address: null, daily_email_cap: 200, call_hours_start: 9, call_hours_end: 20 };
}

// ------------------------------------------------------------------ merge fields
export const MERGE_FIELDS = ['name', 'category', 'area', 'district'] as const;
export function render(tpl: string, m: Record<string, string>): string {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => m[k] ?? '');
}

// ------------------------------------------------------------------ audience
interface Candidate { biz_id: string; name: string; address: string; merge: Record<string, string> }
const MAX_CAMPAIGN_CONTACTS = 10000;
interface Audience { eligible: Candidate[]; excluded: { no_address: number; suppressed: number; no_consent: number; duplicate: number } }

async function audience(ws: string, channel: Channel, listId: string | null, query: string | null, extra: Contact[] = []): Promise<Audience> {
  let where: string | null = null, params: unknown[] = [];
  if (listId) { where = `WHERE b.id IN (SELECT i.biz_id FROM list_items i JOIN lists l ON l.id = i.list_id WHERE l.id = $1 AND l.workspace_id = $2)`; params = [listId, ws]; }
  else if (query !== null) { const f = buildFilter(new URLSearchParams(query), ws); where = f.where; params = f.params; }
  type Row = { id: string; name: string; email: string | null; email_status: string | null; phone: string | null; area: string | null; district: string | null; label: string; own?: boolean };
  // no list and no filter: only the typed/imported recipients (an empty filter would mean "every business")
  const rows: Row[] = where === null ? [] : await q<Row>(
    `SELECT b.id, b.name, b.email, b.email_status, b.phone, b.area, b.district, c.label FROM biz b JOIN biz_categories c ON c.id = b.cat ${where} LIMIT 50000`, params);
  const own = (c: Contact, id: string): Row => ({ id, name: c.name ?? c.company ?? '', email: c.email, email_status: null, phone: c.phone, area: c.area, district: c.district, label: c.company ?? '', own: true });
  if (listId) for (const c of await q<Contact & { id: string }>(`SELECT id::text, name, company, phone, email, area, district, note FROM list_contacts WHERE list_id = $1 LIMIT 50000`, [listId])) rows.push(own(c, `contact:${c.id}`));
  for (const c of extra) rows.push(own(c, 'manual'));
  const suppressed = new Set((await q<{ value: string }>(`SELECT lower(value) AS value FROM suppressions WHERE workspace_id = $1`, [ws])).map((r) => r.value));
  // No opt-in required; only numbers that opted out (STOP / revoked) are excluded.
  const optedOut = channel === 'whatsapp'
    ? new Set((await q<{ address: string }>(`SELECT address FROM consents k WHERE workspace_id = $1 AND channel = 'whatsapp' AND revoked_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM consents n WHERE n.workspace_id = k.workspace_id AND n.channel = 'whatsapp' AND n.address = k.address AND n.revoked_at IS NULL)`, [ws])).map((r) => r.address))
    : null;
  const out: Audience = { eligible: [], excluded: { no_address: 0, suppressed: 0, no_consent: 0, duplicate: 0 } };
  const seen = new Set<string>();
  for (const r of rows) {
    const addr = channel === 'email' ? (r.email && r.email_status !== 'invalid' ? r.email.trim().toLowerCase() : null) : channel === 'voice' ? normalizeBdPhone(r.phone) : normalizeWaPhone(r.phone);
    if (!addr) { out.excluded.no_address++; continue; }
    if (seen.has(addr)) { out.excluded.duplicate++; continue; }
    seen.add(addr);
    const forms = channel === 'email' ? [addr] : phoneForms(addr);
    if (forms.some((f) => suppressed.has(f)) || (r.phone && (suppressed.has(r.phone.toLowerCase()) || suppressed.has(r.phone.replace(/D/g, ''))))) { out.excluded.suppressed++; continue; }
    if (optedOut && optedOut.has(addr)) { out.excluded.no_consent++; continue; }
    out.eligible.push({ biz_id: r.id, name: r.name || addr, address: addr,
      merge: { name: r.name, category: r.label, area: r.area ?? r.district?.replace(/ District$/, '') ?? '', district: r.district?.replace(/ District$/, '') ?? '', ...(r.own ? { _own: '1' } : {}) } });
  }
  return out;
}

// ------------------------------------------------------------------ email composition
async function composeEmail(ws: string, c: { id: string; subject: string; body: string }, to: string, merge: Record<string, string>) {
  const s = await settings(ws);
  const token = await sign({ w: ws, a: to, c: c.id });
  const unsub = `${PUBLIC_URL()}/api/u/${token}`;
  // own contacts were added by the sender, directory businesses were found in public listings: say which
  const why = merge._own ? `your address is in ${s.sender_name ?? 'the sender'}'s contact list` : `${merge.name || 'your business'} is publicly listed with this email address`;
  const footer = `\n\n--\n${s.sender_name ?? ''}\n${s.postal_address ?? ''}\nYou are receiving this because ${why}.\nUnsubscribe: ${unsub}`;
  const text = render(c.body, merge) + footer;
  const htmlBody = `<div style="font:15px/1.5 system-ui,sans-serif;color:#1e293b;max-width:600px">${esc(render(c.body, merge)).replace(/\n/g, '<br>')}
    <hr style="border:0;border-top:1px solid #e2e8f0;margin:24px 0 12px"><p style="font-size:12px;color:#64748b">${esc(s.sender_name)}<br>${esc(s.postal_address)}<br>
    You are receiving this because ${esc(why)}.<br><a href="${esc(unsub)}">Unsubscribe</a></p></div>`;
  return {
    subject: render(c.subject, merge), text, html: htmlBody,
    from: `${s.sender_name} <${s.sender_email}>`, replyTo: s.reply_to ?? s.sender_email ?? undefined,
    headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  };
}

function senderProblem(s: Settings): string | null {
  if (!s.sender_name || !s.sender_email) return 'Set a sender name and email in Settings → Sending first.';
  if (!s.postal_address) return 'Add your business postal address in Settings → Sending (it is printed in every email).';
  return null;
}

// ------------------------------------------------------------------ worker step (called by workers.ts)
export async function processCampaigns(): Promise<void> {
  await q(`UPDATE campaigns SET status = 'sending' WHERE status = 'scheduled' AND send_at <= now()`);
  const active = await q<{ id: string; workspace_id: string; channel: Channel; subject: string; body: string; wa_template: string; wa_language: string; wa_params: string[] | null; wa_header: WaHeader | null; voice_name: string | null; voice_clip: string | null }>(
    `SELECT id, workspace_id, channel, subject, body, wa_template, wa_language, wa_params, wa_header, voice_name, voice_clip FROM campaigns WHERE status = 'sending' ORDER BY launched_at`);
  for (const c of active) {
    const s = await settings(c.workspace_id);
    if (c.channel === 'voice') {
      const clip = c.voice_clip ? { id: c.voice_clip, name: (await clipName(c.workspace_id, c.voice_clip)) ?? 'own recording' } : null;
      const r = await processVoice(c, { start: s.call_hours_start, end: s.call_hours_end }, (merge) => speech(s.sender_name ?? '', c.body, merge, clip));
      if (r === 'done') await q(`UPDATE campaigns SET status = 'sent', finished_at = now() WHERE id = $1 AND status = 'sending'`, [c.id]);
      continue;
    }
    let budget = BATCH_PER_TICK;
    if (c.channel === 'email') {
      const sentToday = (await one<{ n: number }>(`SELECT COUNT(*)::int n FROM email_log WHERE workspace_id = $1 AND kind = 'campaign' AND created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Dhaka') AT TIME ZONE 'Asia/Dhaka'`, [c.workspace_id]))?.n ?? 0;
      budget = Math.min(budget, Math.max(0, s.daily_email_cap - sentToday));
      if (budget === 0) continue; // daily cap reached: continue tomorrow
    }
    const batch = await q<{ id: number; biz_id: string; address: string; merge: Record<string, string> }>(
      `SELECT id, biz_id, address, merge FROM campaign_recipients WHERE campaign_id = $1 AND status = 'queued' ORDER BY id LIMIT $2`, [c.id, budget]);
    if (!batch.length) {
      await q(`UPDATE campaigns SET status = 'sent', finished_at = now() WHERE id = $1 AND status = 'sending'`, [c.id]);
      continue;
    }
    for (const r of batch) {
      // re-check right before sending: someone may have unsubscribed (email link, WhatsApp STOP) since launch
      const blocked = await one(`SELECT 1 FROM suppressions WHERE workspace_id = $1 AND lower(value) = ANY($2::text[])`,
        [c.workspace_id, c.channel === 'email' ? [r.address.toLowerCase()] : phoneForms(r.address)]);
      if (blocked) { await q(`UPDATE campaign_recipients SET status = 'unsubscribed', reason = 'on suppression list', updated_at = now() WHERE id = $1`, [r.id]); continue; }
      try {
        let providerId: string | null = null;
        if (c.channel === 'email') {
          const m = await composeEmail(c.workspace_id, c, r.address, r.merge);
          providerId = (await sendMail({ workspaceId: c.workspace_id, kind: 'campaign', to: r.address, ...m })).id;
        } else {
          const optedOut = await one(`SELECT 1 FROM consents k WHERE workspace_id = $1 AND channel = 'whatsapp' AND address = $2 AND revoked_at IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM consents n WHERE n.workspace_id = k.workspace_id AND n.channel = 'whatsapp' AND n.address = k.address AND n.revoked_at IS NULL)`, [c.workspace_id, r.address]);
          if (optedOut) { await q(`UPDATE campaign_recipients SET status = 'skipped', reason = 'opted out', updated_at = now() WHERE id = $1`, [r.id]); continue; }
          const params = (c.wa_params ?? []).map((p) => render(p, r.merge));
          providerId = await sendWaTemplate(c.workspace_id, r.address, c.wa_template, c.wa_language, params, { campaignId: c.id, bizId: isBizId(r.biz_id) ? r.biz_id : null, name: r.merge.name || null, header: c.wa_header });
        }
        await q(`UPDATE campaign_recipients SET status = 'sent', provider_id = $2, sent_at = now(), updated_at = now() WHERE id = $1`, [r.id, providerId]);
      } catch (e) {
        await q(`UPDATE campaign_recipients SET status = 'failed', reason = $2, updated_at = now() WHERE id = $1`, [r.id, (e instanceof Error ? e.message : String(e)).slice(0, 300)]);
      }
    }
  }
}

// ------------------------------------------------------------------ routes: settings & suppressions
on('GET', '/api/settings/sending', async ({ ctx }) => {
  need(ctx);
  const wa = await waConfig(ctx.workspaceId);
  return { ...(await settings(ctx.workspaceId)), mail_mode: MAIL_MODE, whatsapp: { mode: wa.mode, phone_number_id: wa.phoneNumberId, waba_id: wa.wabaId, verify_token: wa.verifyToken,
    webhook_url: `${PUBLIC_URL()}/api/whatsapp/webhook`, has_token: wa.hasToken } };
});
on('PUT', '/api/settings/sending', async ({ req, ctx }) => {
  need(ctx, 'admin');
  const b = await body(req);
  const email = str(b.sender_email, 254).toLowerCase(), reply = str(b.reply_to, 254).toLowerCase();
  const emailOk = (e: string) => !e || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
  if (!emailOk(email) || !emailOk(reply)) throw new HttpError(400, 'Enter valid email addresses.');
  const cap = Math.min(5000, Math.max(10, Number(b.daily_email_cap ?? 200) || 200));
  const hs = Math.min(23, Math.max(0, Number(b.call_hours_start ?? 9))), he = Math.min(24, Math.max(1, Number(b.call_hours_end ?? 20)));
  if (hs >= he) throw new HttpError(400, 'Calling hours must start before they end.');
  await q(`INSERT INTO workspace_settings (workspace_id, sender_name, sender_email, reply_to, postal_address, daily_email_cap, call_hours_start, call_hours_end, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
    ON CONFLICT (workspace_id) DO UPDATE SET sender_name = $2, sender_email = $3, reply_to = $4, postal_address = $5, daily_email_cap = $6, call_hours_start = $7, call_hours_end = $8, updated_at = now()`,
    [ctx.workspaceId, str(b.sender_name, 80) || null, email || null, reply || null, str(b.postal_address, 300) || null, cap, hs, he]);
  return { ok: true };
});
on('GET', '/api/suppressions', async ({ p, ctx }) => {
  need(ctx);
  const s = `%${(p.get('q') ?? '').toLowerCase()}%`;
  return q(`SELECT value, channel, reason, created_at FROM suppressions WHERE workspace_id = $1 AND lower(value) LIKE $2 ORDER BY created_at DESC LIMIT 500`, [ctx.workspaceId, s]);
});
on('POST', '/api/suppressions', async ({ req, ctx }) => {
  need(ctx);
  const b = await body(req);
  const values = (Array.isArray(b.values) ? b.values : [b.value]).map((v) => str(v, 254).toLowerCase()).filter(Boolean).slice(0, 5000);
  const channel = ['email', 'phone', 'whatsapp'].includes(String(b.channel)) ? String(b.channel) : 'email';
  for (const v of values) await q(`INSERT INTO suppressions (workspace_id, value, channel, reason) VALUES ($1, $2, $3, $4) ON CONFLICT (workspace_id, value) DO NOTHING`, [ctx.workspaceId, v, channel, str(b.reason, 200) || 'added manually']);
  return { added: values.length };
});
on('DELETE', '/api/suppressions', async ({ req, ctx }) => {
  need(ctx, 'admin'); // removing someone from do-not-contact should be a deliberate admin decision
  await q(`DELETE FROM suppressions WHERE workspace_id = $1 AND value = $2`, [ctx.workspaceId, str((await body(req)).value, 254).toLowerCase()]);
  return { ok: true };
});
on('GET', '/api/outbox', async ({ ctx }) => {
  need(ctx);
  return q(`SELECT id, kind, to_addr, subject, body_text, mode, status, error, created_at FROM email_log WHERE workspace_id = $1 ORDER BY id DESC LIMIT 100`, [ctx.workspaceId]);
});

// ------------------------------------------------------------------ routes: campaigns
const CAMPAIGN_COLS = `c.id, c.channel, c.name, c.status, c.audience_list, c.audience_query, jsonb_array_length(c.audience_contacts)::int AS contacts_n, c.subject, c.body, c.wa_template, c.wa_language, c.wa_params, c.wa_header, c.voice_name, c.voice_clip,
  (SELECT vc.name FROM voice_clips vc WHERE vc.workspace_id = c.workspace_id AND vc.id = c.voice_clip) AS voice_clip_name,
  c.send_at, c.created_at, c.launched_at, c.finished_at, c.recipients, c.credits, l.name AS list_name, u.name AS created_by_name`;
async function getCampaign(id: string, ws: string) {
  const c = await one<Record<string, unknown> & { status: string; channel: Channel; audience_list: string | null; audience_query: string | null; audience_contacts: Contact[]; subject: string; body: string; wa_template: string | null; voice_name: string | null; voice_clip: string | null; voice_clip_name: string | null }>(
    `SELECT ${CAMPAIGN_COLS}, c.audience_contacts FROM campaigns c LEFT JOIN lists l ON l.id = c.audience_list LEFT JOIN users u ON u.id = c.created_by WHERE c.id = $1 AND c.workspace_id = $2`, [id, ws]);
  if (!c) throw new HttpError(404, 'Campaign not found.');
  return c;
}
async function stats(id: string) {
  const rows = await q<{ status: string; n: number }>(`SELECT status, COUNT(*)::int n FROM campaign_recipients WHERE campaign_id = $1 GROUP BY 1`, [id]);
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}
function readDraft(b: Record<string, unknown>) {
  const channel: Channel = b.channel === 'whatsapp' || b.channel === 'voice' ? b.channel : 'email';
  return {
    channel, name: str(b.name, 120), audience_list: str(b.audience_list, 40) || null, audience_query: typeof b.audience_query === 'string' ? b.audience_query.slice(0, 4000) : null,
    subject: str(b.subject, 200), body: typeof b.body === 'string' ? b.body.slice(0, 20000) : '',
    wa_template: str(b.wa_template, 120) || null, wa_language: str(b.wa_language, 20) || 'en',
    wa_params: Array.isArray(b.wa_params) ? b.wa_params.slice(0, 10).map((x) => str(x, 500)) : [],
    wa_header: readWaHeader(b.wa_header),
    audience_contacts: cleanContacts(b.audience_contacts, MAX_CAMPAIGN_CONTACTS).contacts,
    voice_name: VOICES.some((v) => v.id === b.voice_name) ? String(b.voice_name) : VOICES[0]!.id,
    voice_clip: typeof b.voice_clip === 'string' && /^[0-9a-f]{32}$/.test(b.voice_clip) ? b.voice_clip : null,
  };
}

on('GET', '/api/campaigns', async ({ ctx }) => {
  need(ctx);
  return q(`SELECT ${CAMPAIGN_COLS}, (SELECT COUNT(*) FILTER (WHERE r.status IN ('sent','delivered','read','replied'))::int FROM campaign_recipients r WHERE r.campaign_id = c.id) AS sent
    FROM campaigns c LEFT JOIN lists l ON l.id = c.audience_list LEFT JOIN users u ON u.id = c.created_by WHERE c.workspace_id = $1 ORDER BY c.created_at DESC LIMIT 200`, [ctx.workspaceId]);
});
on('POST', '/api/campaigns', async ({ req, ctx }) => {
  need(ctx);
  const d = readDraft(await body(req));
  if (!d.name) throw new HttpError(400, 'Give the campaign a name.');
  return one(`INSERT INTO campaigns (workspace_id, channel, name, audience_list, audience_query, subject, body, wa_template, wa_language, wa_params, created_by, audience_contacts, voice_name, voice_clip, wa_header)
    VALUES ($1, $2, $3, (SELECT id FROM lists WHERE id::text = $4 AND workspace_id = $1), $5, $6, $7, $8, $9, $10, $11, $12, $13,
      (SELECT id FROM voice_clips WHERE workspace_id = $1 AND id = $14), $15) RETURNING id`,
    [ctx.workspaceId, d.channel, d.name, d.audience_list ?? '', d.audience_query, d.subject, d.body, d.wa_template, d.wa_language, JSON.stringify(d.wa_params), ctx.userId, JSON.stringify(d.audience_contacts), d.voice_name, d.voice_clip, d.wa_header ? JSON.stringify(d.wa_header) : null]);
});
on('GET', '/api/campaigns/:id', async ({ m, ctx }) => {
  need(ctx);
  const c = await getCampaign(m[1]!, ctx.workspaceId);
  const recipients = await q(`SELECT biz_id, address, name, status, reason, sent_at FROM campaign_recipients WHERE campaign_id = $1 ORDER BY updated_at DESC LIMIT 200`, [c.id]);
  return { ...c, stats: await stats(String(c.id)), recipients_sample: recipients };
});
on('PATCH', '/api/campaigns/:id', async ({ req, m, ctx }) => {
  need(ctx);
  const c = await getCampaign(m[1]!, ctx.workspaceId);
  if (c.status !== 'draft') throw new HttpError(409, 'Only drafts can be edited.');
  const d = readDraft({ ...c, ...(await body(req)), channel: c.channel });
  await q(`UPDATE campaigns SET name = $3, audience_list = (SELECT id FROM lists WHERE id::text = $4 AND workspace_id = $2), audience_query = $5, subject = $6, body = $7, wa_template = $8, wa_language = $9, wa_params = $10, audience_contacts = $11, voice_name = $12,
    voice_clip = (SELECT id FROM voice_clips WHERE workspace_id = $2 AND id = $13), wa_header = $14 WHERE id = $1 AND workspace_id = $2`, [c.id, ctx.workspaceId, d.name || String(c.name), d.audience_list ?? '', d.audience_list ? null : d.audience_query, d.subject, d.body, d.wa_template, d.wa_language, JSON.stringify(d.wa_params), JSON.stringify(d.audience_contacts), d.voice_name, d.voice_clip, d.wa_header ? JSON.stringify(d.wa_header) : null]);
  return { ok: true };
});
on('DELETE', '/api/campaigns/:id', async ({ m, ctx }) => {
  need(ctx);
  const c = await getCampaign(m[1]!, ctx.workspaceId);
  if (c.status !== 'draft') throw new HttpError(409, 'Only drafts can be deleted; cancel a running campaign instead.');
  await q(`DELETE FROM campaigns WHERE id = $1`, [c.id]);
  return { ok: true };
});

async function preview(c: Awaited<ReturnType<typeof getCampaign>>, ws: string) {
  const a = await audience(ws, c.channel, c.audience_list, c.audience_list ? null : c.audience_query, c.audience_contacts ?? []);
  const sample = a.eligible[0];
  let rendered: { subject?: string; text: string } | null = null;
  if (sample && c.channel === 'email') { const e = await composeEmail(ws, { id: String(c.id), subject: c.subject, body: c.body }, sample.address, sample.merge); rendered = { subject: e.subject, text: e.text }; }
  if (sample && c.channel === 'whatsapp') rendered = { text: `Template "${c.wa_template}" with: ${((c.wa_params as string[] | null) ?? []).map((p) => render(p, sample.merge)).join(' | ')}${c.wa_header ? ` + ${String((c.wa_header as WaHeader).format).toLowerCase()} header` : ''}` };
  if (sample && c.channel === 'voice') rendered = { text: describe(speech((await settings(ws)).sender_name ?? '', c.body, sample.merge, (c.voice_clip ? { id: c.voice_clip, name: c.voice_clip_name ?? 'own recording' } : null))) };
  return { eligible: a.eligible.length, excluded: a.excluded, credits: a.eligible.length * creditsPer(c.channel), balance: await balance(ws), sample: rendered, audience: a };
}
on('POST', '/api/campaigns/:id/preview', async ({ m, ctx }) => {
  need(ctx);
  const { audience: _a, ...out } = await preview(await getCampaign(m[1]!, ctx.workspaceId), ctx.workspaceId);
  void _a;
  return out;
});
on('POST', '/api/campaigns/:id/test', async ({ req, m, ctx }) => {
  need(ctx);
  const c = await getCampaign(m[1]!, ctx.workspaceId);
  if (c.channel === 'voice') {
    const s = await settings(ctx.workspaceId);
    if (!s.sender_name) throw new HttpError(400, 'Set a sender name in Settings → Sending first (it is spoken at the start of every call).');
    const to = normalizeBdPhone(str((await body(req)).phone, 30));
    if (!to) throw new HttpError(400, 'Enter a Bangladeshi phone number to call, e.g. 01712345678.');
    await testCall(to, speech(s.sender_name, c.body, { name: 'Sample Business', category: '', area: 'Mirpur', district: 'Dhaka' }, (c.voice_clip ? { id: c.voice_clip, name: c.voice_clip_name ?? 'own recording' } : null)), c.voice_name ?? VOICES[0]!.id);
    return { ok: true, to, mode: 'live' };
  }
  if (c.channel !== 'email') throw new HttpError(400, 'Test sends are for email campaigns (WhatsApp: message yourself from the Inbox).');
  const problem = senderProblem(await settings(ctx.workspaceId));
  if (problem) throw new HttpError(400, problem);
  const merge = { name: 'Sample Business Ltd', category: 'Pharmacies', area: 'Mirpur', district: 'Dhaka' };
  const e = await composeEmail(ctx.workspaceId, { id: String(c.id), subject: `[TEST] ${c.subject}`, body: c.body }, ctx.email, merge);
  const r = await sendMail({ workspaceId: ctx.workspaceId, kind: 'test', to: ctx.email, ...e });
  return { ok: true, to: ctx.email, mode: r.mode };
});
on('POST', '/api/campaigns/:id/launch', async ({ req, m, ctx }) => {
  need(ctx, 'admin');
  const c = await getCampaign(m[1]!, ctx.workspaceId);
  if (c.status !== 'draft') throw new HttpError(409, 'This campaign was already launched.');
  const b = await body(req);
  if (c.channel === 'email') {
    const problem = senderProblem(await settings(ctx.workspaceId));
    if (problem) throw new HttpError(400, problem);
    if (!str(c.subject) || !str(c.body)) throw new HttpError(400, 'Write a subject and a message first.');
  } else if (c.channel === 'voice') {
    if (!(await settings(ctx.workspaceId)).sender_name) throw new HttpError(400, 'Set a sender name in Settings → Sending first (it is spoken at the start of every call).');
    if (!c.voice_clip && !str(c.body)) throw new HttpError(400, 'Write the message to speak, or choose one of your recordings.');
  } else {
    if (!c.wa_template) throw new HttpError(400, 'Choose an approved WhatsApp template first.');
    if ((await waConfig(ctx.workspaceId)).mode === 'disabled') throw new HttpError(400, 'Connect WhatsApp in Settings → Sending first.');
    // Meta rejects (#132012) a template send whose header or variables differ from the approved template, so check before spending credits
    const info = (await listWaTemplates(ctx.workspaceId)).templates.find((t) => t.name === c.wa_template && t.language === c.wa_language) ?? null;
    if (info?.unsupported) throw new HttpError(400, `Template "${info.name}" cannot be sent from here: ${info.unsupported}.`);
    const header = c.wa_header as WaHeader | null;
    if (info?.header_format && !header) throw new HttpError(400, `Template "${info.name}" has an ${info.header_format.toLowerCase()} header. Add a public https link to the ${info.header_format.toLowerCase()} first.`);
    if (info?.header_format && header && header.format !== info.header_format) throw new HttpError(400, `Template "${info.name}" needs an ${info.header_format.toLowerCase()} header, not ${header.format.toLowerCase()}.`);
    if (info && !info.header_format && header) throw new HttpError(400, `Template "${info.name}" has no media header. Remove the header link.`);
    if (info && ((c.wa_params as string[] | null) ?? []).length !== info.params) throw new HttpError(400, `Template "${info.name}" takes ${info.params} variable(s). Re-select the template to refill them.`);
  }
  const pv = await preview(c, ctx.workspaceId);
  if (!pv.eligible) throw new HttpError(400, c.channel === 'whatsapp' ? 'No recipient has a Bangladeshi mobile number for WhatsApp (or all opted out).' : c.channel === 'voice' ? 'No recipient has a usable Bangladeshi phone number.' : 'No recipient has a usable email address.');
  const sendAt = typeof b.send_at === 'string' && !Number.isNaN(Date.parse(b.send_at)) ? new Date(b.send_at) : null;
  await tx(async (t) => {
    await t.query(`SELECT id FROM workspaces WHERE id = $1 FOR UPDATE`, [ctx.workspaceId]);
    const bal = Number((await t.query(`SELECT COALESCE(SUM(delta), 0) b FROM credit_ledger WHERE workspace_id = $1`, [ctx.workspaceId])).rows[0].b);
    if (pv.credits > bal) throw new HttpError(402, `Not enough credits: ${pv.eligible.toLocaleString()} recipients need ${pv.credits.toLocaleString()} credits, the workspace has ${bal.toLocaleString()}.`);
    const e = pv.audience.eligible;
    await t.query(`INSERT INTO campaign_recipients (campaign_id, biz_id, address, name, merge) SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[], $5::jsonb[]) ON CONFLICT DO NOTHING`,
      [c.id, e.map((x) => x.biz_id), e.map((x) => x.address), e.map((x) => x.name), e.map((x) => JSON.stringify(x.merge))]);
    await t.query(`INSERT INTO credit_ledger (workspace_id, delta, reason, ref, user_id) VALUES ($1, $2, $3, $4, $5)`, [ctx.workspaceId, -pv.credits, `${c.channel} campaign`, c.id, ctx.userId]);
    await t.query(`UPDATE campaigns SET status = $2, send_at = $3, launched_at = now(), recipients = $4, credits = $5 WHERE id = $1`,
      [c.id, sendAt && sendAt > new Date() ? 'scheduled' : 'sending', sendAt ?? new Date(), pv.eligible, pv.credits]);
  });
  return { ok: true, recipients: pv.eligible };
});
for (const [action, from, to] of [['pause', ['sending', 'scheduled'], 'paused'], ['resume', ['paused'], 'sending'], ['cancel', ['sending', 'scheduled', 'paused'], 'cancelled']] as const) {
  on('POST', `/api/campaigns/:id/${action}`, async ({ m, ctx }) => {
    need(ctx, 'admin');
    const c = await getCampaign(m[1]!, ctx.workspaceId);
    if (!(from as readonly string[]).includes(c.status)) throw new HttpError(409, `Cannot ${action} a ${c.status} campaign.`);
    await q(`UPDATE campaigns SET status = $2${to === 'cancelled' ? ', finished_at = now()' : ''} WHERE id = $1`, [c.id, to]);
    if (to === 'cancelled') {
      // credits for recipients that were never contacted go back to the workspace
      const n = (await one<{ n: number }>(`WITH s AS (UPDATE campaign_recipients SET status = 'skipped', reason = 'campaign cancelled', updated_at = now() WHERE campaign_id = $1 AND status = 'queued' RETURNING 1) SELECT COUNT(*)::int n FROM s`, [c.id]))?.n ?? 0;
      if (n) await q(`INSERT INTO credit_ledger (workspace_id, delta, reason, ref, user_id) VALUES ($1, $2, 'campaign cancelled: refund', $3, $4)`, [ctx.workspaceId, n * creditsPer(c.channel), c.id, ctx.userId]);
    }
    return { ok: true };
  });
}
on('GET', '/api/campaigns/meta/fields', async ({ ctx }) => {
  need(ctx);
  const wa = await waConfig(ctx.workspaceId);
  return { merge_fields: MERGE_FIELDS, mail_mode: MAIL_MODE, wa_mode: wa.mode, can_launch: atLeast(ctx, 'admin'), wa_test_templates: wa.mode === 'test' ? WA_TEST_TEMPLATES : [],
    voice: { mode: voiceMode(), tts: ttsMode(), voices: VOICES, credits_per_call: VOICE_CREDITS_PER_CALL, intro: INTRO((await settings(ctx.workspaceId)).sender_name ?? '…'), outro: OUTRO } };
});

// ------------------------------------------------------------------ unsubscribe (public: opened from emails)
interface UnsubToken { w: string; a: string; c?: string }
const page = (title: string, msg: string, form = '') => `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<body style="margin:0;background:#f8fafc;font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;color:#1e293b">
<div style="background:#fff;padding:32px;border-radius:16px;max-width:420px;width:90%;box-shadow:0 10px 30px #0001"><h1 style="font-size:20px;margin:0 0 8px">${esc(title)}</h1><p style="color:#475569">${msg}</p>${form}</div></body>`;
async function unsubscribe(t: UnsubToken) {
  await q(`INSERT INTO suppressions (workspace_id, value, channel, reason) VALUES ($1, $2, 'email', 'unsubscribed via link') ON CONFLICT (workspace_id, value) DO NOTHING`, [t.w, t.a.toLowerCase()]);
  await q(`UPDATE campaign_recipients SET status = 'unsubscribed', reason = 'unsubscribed', updated_at = now() WHERE address = $1 AND status = 'queued'
    AND campaign_id IN (SELECT id FROM campaigns WHERE workspace_id = $2)`, [t.a.toLowerCase(), t.w]);
}
on('GET', '/api/u/:token', async ({ res, m }) => {
  const t = await verify<UnsubToken>(decodeURIComponent(m[1]!));
  if (!t) { html(res, 400, page('Link not valid', 'This unsubscribe link is broken. Reply to the email and ask to be removed: the sender must honour it.')); return; }
  const sender = (await settings(t.w)).sender_name ?? 'this sender';
  html(res, 200, page('Unsubscribe', `Stop receiving emails from <b>${esc(sender)}</b> at <b>${esc(t.a)}</b>?`,
    `<form method="post"><button style="width:100%;padding:12px;border:0;border-radius:10px;background:#2754e6;color:#fff;font:600 15px system-ui;cursor:pointer">Unsubscribe</button></form>`));
}, true);
// one-click (RFC 8058) from mail clients and the confirm button above: both are plain form posts without our cookie
on('POST', '/api/u/:token', async ({ req, res, m }) => {
  await rawBody(req);
  const t = await verify<UnsubToken>(decodeURIComponent(m[1]!));
  if (!t) { html(res, 400, page('Link not valid', 'This unsubscribe link is broken.')); return; }
  await unsubscribe(t);
  html(res, 200, page('You are unsubscribed', `${esc(t.a)} will not receive further emails from ${esc((await settings(t.w)).sender_name ?? 'this sender')}.`));
}, true, { csrf: false });
