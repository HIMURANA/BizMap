/**
 * WhatsApp Business Platform (Cloud API): per-workspace connection, approved templates, opt-in records, inbox and webhook.
 *
 * Policy rules enforced here:
 *  - marketing templates only to numbers with a recorded, unrevoked opt-in (consents table);
 *  - free-form replies only inside the 24-hour customer-service window (after the customer's last message);
 *  - "STOP" / "UNSUBSCRIBE" / "বন্ধ" revokes the opt-in and suppresses the number; "START" records a new opt-in;
 *  - webhook posts are accepted only with a valid X-Hub-Signature-256 made with the workspace's app secret.
 * Without a connection (and outside production) the workspace runs in TEST mode: nothing reaches Meta, messages are
 * stored as if sent, and incoming messages can be simulated from the Inbox.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { one, q } from './db.js';
import { HttpError, body, html, need, on, rawBody, str } from './http.js';
import { decrypt, encrypt } from './secrets.js';

const GRAPH = `https://graph.facebook.com/${process.env.WA_GRAPH_VERSION ?? 'v23.0'}`;
const WINDOW_MS = 24 * 3600 * 1000;
const STOP_WORDS = /^\s*(stop|unsubscribe|stop all|বন্ধ|বন্ধ করুন)\s*[.!]?\s*$/i;
const START_WORDS = /^\s*(start|subscribe|yes|হ্যাঁ)\s*[.!]?\s*$/i;

export const WA_TEST_TEMPLATES = [
  { name: 'intro_offer', language: 'en', category: 'MARKETING', body: 'Hello {{1}}, we help businesses in {{2}} grow. Reply YES to hear more or STOP to opt out.', params: 2 },
  { name: 'intro_offer_bn', language: 'bn', category: 'MARKETING', body: 'আসসালামু আলাইকুম {{1}}, {{2}} এলাকার ব্যবসার জন্য আমাদের নতুন অফার আছে। জানতে YES লিখুন, বন্ধ করতে STOP লিখুন।', params: 2 },
  { name: 'follow_up', language: 'en', category: 'UTILITY', body: 'Hi {{1}}, following up on our conversation. When is a good time to talk?', params: 1 },
];

/** Bangladesh mobile numbers to WhatsApp's international digits format (8801XXXXXXXXX); null if not a BD mobile. */
export function normalizeWaPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let d = phone.replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('01')) d = `88${d}`;
  return /^8801[3-9]\d{8}$/.test(d) ? d : null;
}

export async function waConfig(ws: string) {
  const s = await one<{ wa_phone_number_id: string | null; wa_waba_id: string | null; wa_token_enc: string | null; wa_app_secret_enc: string | null; wa_verify_token: string | null }>(
    `SELECT wa_phone_number_id, wa_waba_id, wa_token_enc, wa_app_secret_enc, wa_verify_token FROM workspace_settings WHERE workspace_id = $1`, [ws]);
  const live = !!(s?.wa_phone_number_id && s.wa_token_enc);
  return {
    mode: (live ? 'live' : process.env.NODE_ENV === 'production' ? 'disabled' : 'test') as 'live' | 'test' | 'disabled',
    phoneNumberId: s?.wa_phone_number_id ?? null, wabaId: s?.wa_waba_id ?? null, verifyToken: s?.wa_verify_token ?? null, hasToken: !!s?.wa_token_enc,
    token: async () => decrypt(s?.wa_token_enc), appSecret: async () => decrypt(s?.wa_app_secret_enc),
  };
}

async function graph(token: string, path: string, init?: RequestInit) {
  const res = await fetch(`${GRAPH}/${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: { message?: string } };
  if (!res.ok) throw new Error(`WhatsApp API: ${data.error?.message ?? res.status}`);
  return data;
}

async function conversation(ws: string, address: string, extra: { bizId?: string | null; name?: string | null } = {}) {
  const c = await one<{ id: string }>(`INSERT INTO conversations (workspace_id, address, biz_id, contact_name) VALUES ($1, $2, $3, $4)
    ON CONFLICT (workspace_id, channel, address) DO UPDATE SET biz_id = COALESCE(conversations.biz_id, EXCLUDED.biz_id), contact_name = COALESCE(EXCLUDED.contact_name, conversations.contact_name)
    RETURNING id`, [ws, address, extra.bizId ?? null, extra.name ?? null]);
  return c!.id;
}
async function addMessage(convId: string, m: { direction: 'in' | 'out'; body: string; template?: string | null; status?: string; providerId?: string | null; userId?: string | null; campaignId?: string | null; error?: string | null }) {
  await q(`INSERT INTO messages (conversation_id, direction, body, template, status, provider_id, sent_by, campaign_id, error) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [convId, m.direction, m.body, m.template ?? null, m.status ?? null, m.providerId ?? null, m.userId ?? null, m.campaignId ?? null, m.error ?? null]);
  await q(`UPDATE conversations SET last_message_at = now()${m.direction === 'in' ? ', last_inbound_at = now(), unread = unread + 1, status = \'open\'' : ''} WHERE id = $1`, [convId]);
}

/** Sends one approved template message. Returns the provider message id (null in test mode). */
export async function sendWaTemplate(ws: string, to: string, template: string, language: string, params: string[],
  ctx: { campaignId?: string | null; bizId?: string | null; name?: string | null; userId?: string | null } = {}): Promise<string | null> {
  const cfg = await waConfig(ws);
  if (cfg.mode === 'disabled') throw new Error('WhatsApp is not connected for this workspace.');
  const convId = await conversation(ws, to, { bizId: ctx.bizId, name: ctx.name });
  let preview = `[template ${template}] ${params.join(' | ')}`;
  if (cfg.mode === 'test') {
    const t = WA_TEST_TEMPLATES.find((x) => x.name === template);
    if (t) preview = t.body.replace(/\{\{(\d+)\}\}/g, (_, i: string) => params[Number(i) - 1] ?? '');
    await addMessage(convId, { direction: 'out', body: preview, template, status: 'sent (test)', userId: ctx.userId, campaignId: ctx.campaignId });
    return null;
  }
  const data = await graph((await cfg.token())!, `${cfg.phoneNumberId}/messages`, { method: 'POST', body: JSON.stringify({
    messaging_product: 'whatsapp', to, type: 'template',
    template: { name: template, language: { code: language }, components: params.length ? [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }] : [] },
  }) });
  const id = ((data.messages as { id: string }[] | undefined)?.[0]?.id) ?? null;
  await addMessage(convId, { direction: 'out', body: preview, template, status: 'sent', providerId: id, userId: ctx.userId, campaignId: ctx.campaignId });
  return id;
}

async function sendWaText(ws: string, convId: string, to: string, text: string, userId: string) {
  const cfg = await waConfig(ws);
  if (cfg.mode === 'disabled') throw new HttpError(400, 'WhatsApp is not connected for this workspace.');
  if (cfg.mode === 'test') { await addMessage(convId, { direction: 'out', body: text, status: 'sent (test)', userId }); return; }
  const data = await graph((await cfg.token())!, `${cfg.phoneNumberId}/messages`, { method: 'POST', body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }) });
  await addMessage(convId, { direction: 'out', body: text, status: 'sent', providerId: ((data.messages as { id: string }[] | undefined)?.[0]?.id) ?? null, userId });
}

/** Inbound message from a customer (webhook or test simulation): store it and apply STOP / START keywords. */
async function receive(ws: string, from: string, text: string, name: string | null, providerId: string | null) {
  const bizId = (await one<{ id: string }>(`SELECT id FROM biz WHERE regexp_replace(phone, '\\D', '', 'g') = $1 LIMIT 1`, [from]))?.id ?? null;
  const convId = await conversation(ws, from, { bizId, name });
  await addMessage(convId, { direction: 'in', body: text, status: 'received', providerId });
  await q(`UPDATE campaign_recipients SET status = 'replied', updated_at = now() WHERE address = $1 AND status IN ('sent', 'delivered', 'read')
    AND campaign_id IN (SELECT id FROM campaigns WHERE workspace_id = $2 AND channel = 'whatsapp')`, [from, ws]);
  if (STOP_WORDS.test(text)) {
    await q(`UPDATE consents SET revoked_at = now(), revoked_reason = 'STOP keyword' WHERE workspace_id = $1 AND channel = 'whatsapp' AND address = $2 AND revoked_at IS NULL`, [ws, from]);
    await q(`INSERT INTO suppressions (workspace_id, value, channel, reason) VALUES ($1, $2, 'whatsapp', 'STOP keyword') ON CONFLICT (workspace_id, value) DO NOTHING`, [ws, from]);
  } else if (START_WORDS.test(text)) {
    if (!(await one(`SELECT 1 FROM consents WHERE workspace_id = $1 AND channel = 'whatsapp' AND address = $2 AND revoked_at IS NULL`, [ws, from]))) {
      await q(`INSERT INTO consents (workspace_id, channel, address, biz_id, method, proof) VALUES ($1, 'whatsapp', $2, $3, 'inbound_keyword', $4)`,
        [ws, from, bizId, `Customer wrote "${text.trim().slice(0, 40)}" on ${new Date().toISOString()}${providerId ? ` (message ${providerId})` : ''}`]);
    }
    await q(`DELETE FROM suppressions WHERE workspace_id = $1 AND value = $2 AND channel = 'whatsapp'`, [ws, from]);
  }
}

// ------------------------------------------------------------------ routes: connection & templates
on('PUT', '/api/settings/whatsapp', async ({ req, ctx }) => {
  need(ctx, 'admin');
  const b = await body(req);
  const phoneId = str(b.phone_number_id, 40), waba = str(b.waba_id, 40), token = str(b.access_token, 1000), appSecret = str(b.app_secret, 200);
  if (!/^\d{5,30}$/.test(phoneId) || !/^\d{5,30}$/.test(waba)) throw new HttpError(400, 'Phone number ID and WhatsApp Business Account ID are numbers from the Meta developer dashboard.');
  if (token) {
    try { await graph(token, `${phoneId}?fields=display_phone_number,verified_name`); }
    catch (e) { throw new HttpError(400, `Meta rejected these details: ${(e as Error).message}`); }
  }
  const taken = await one(`SELECT 1 FROM workspace_settings WHERE wa_phone_number_id = $1 AND workspace_id <> $2`, [phoneId, ctx.workspaceId]);
  if (taken) throw new HttpError(409, 'That WhatsApp number is already connected to another workspace.');
  await q(`INSERT INTO workspace_settings (workspace_id, wa_phone_number_id, wa_waba_id, wa_token_enc, wa_app_secret_enc, wa_verify_token) VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (workspace_id) DO UPDATE SET wa_phone_number_id = $2, wa_waba_id = $3,
      wa_token_enc = COALESCE($4, workspace_settings.wa_token_enc), wa_app_secret_enc = COALESCE($5, workspace_settings.wa_app_secret_enc),
      wa_verify_token = COALESCE(workspace_settings.wa_verify_token, $6), updated_at = now()`,
    [ctx.workspaceId, phoneId, waba, token ? await encrypt(token) : null, appSecret ? await encrypt(appSecret) : null, randomBytes(18).toString('base64url')]);
  return { ok: true };
});
on('DELETE', '/api/settings/whatsapp', async ({ ctx }) => {
  need(ctx, 'admin');
  await q(`UPDATE workspace_settings SET wa_phone_number_id = NULL, wa_waba_id = NULL, wa_token_enc = NULL, wa_app_secret_enc = NULL WHERE workspace_id = $1`, [ctx.workspaceId]);
  return { ok: true };
});
on('GET', '/api/whatsapp/templates', async ({ ctx }) => {
  need(ctx);
  const cfg = await waConfig(ctx.workspaceId);
  if (cfg.mode === 'test') return { mode: 'test', templates: WA_TEST_TEMPLATES };
  if (cfg.mode === 'disabled' || !cfg.wabaId) return { mode: cfg.mode, templates: [] };
  const data = await graph((await cfg.token())!, `${cfg.wabaId}/message_templates?status=APPROVED&limit=200&fields=name,language,category,components`);
  const templates = ((data.data as { name: string; language: string; category: string; components: { type: string; text?: string }[] }[]) ?? []).map((t) => {
    const text = t.components.find((c) => c.type === 'BODY')?.text ?? '';
    return { name: t.name, language: t.language, category: t.category, body: text, params: (text.match(/\{\{\d+\}\}/g) ?? []).length };
  });
  return { mode: 'live', templates };
});

// ------------------------------------------------------------------ routes: consents
on('GET', '/api/consents', async ({ p, ctx }) => {
  need(ctx);
  return q(`SELECT c.id, c.channel, c.address, c.biz_id, b.name AS biz_name, c.method, c.proof, c.created_at, c.revoked_at, c.revoked_reason, u.name AS recorded_by
    FROM consents c LEFT JOIN biz b ON b.id = c.biz_id LEFT JOIN users u ON u.id = c.recorded_by
    WHERE c.workspace_id = $1 AND ($2 = '' OR c.address LIKE '%' || $2 || '%') ORDER BY c.created_at DESC LIMIT 500`, [ctx.workspaceId, (p.get('q') ?? '').replace(/\D/g, '')]);
});
on('POST', '/api/consents', async ({ req, ctx }) => {
  need(ctx);
  const b = await body(req);
  const address = normalizeWaPhone(str(b.address, 30));
  if (!address) throw new HttpError(400, 'Enter a Bangladeshi mobile number (e.g. 01712345678).');
  const method = ['web_form', 'call_verbal', 'written', 'other'].includes(String(b.method)) ? String(b.method) : null;
  if (!method) throw new HttpError(400, 'Say how the opt-in was given.');
  const proof = str(b.proof, 1000);
  if (proof.length < 10) throw new HttpError(400, 'Describe the proof (who agreed, when, how). WhatsApp may ask you to show it.');
  if (await one(`SELECT 1 FROM consents WHERE workspace_id = $1 AND channel = 'whatsapp' AND address = $2 AND revoked_at IS NULL`, [ctx.workspaceId, address])) throw new HttpError(409, 'This number already has an active opt-in.');
  const bizId = str(b.biz_id, 100) || (await one<{ id: string }>(`SELECT id FROM biz WHERE regexp_replace(phone, '\\D', '', 'g') = $1 LIMIT 1`, [address]))?.id || null;
  await q(`INSERT INTO consents (workspace_id, channel, address, biz_id, method, proof, recorded_by) VALUES ($1, 'whatsapp', $2, $3, $4, $5, $6)`, [ctx.workspaceId, address, bizId, method, proof, ctx.userId]);
  await q(`DELETE FROM suppressions WHERE workspace_id = $1 AND value = $2 AND channel = 'whatsapp'`, [ctx.workspaceId, address]);
  return { ok: true, address };
});
on('POST', '/api/consents/:id/revoke', async ({ m, ctx }) => {
  need(ctx);
  const c = await one<{ address: string }>(`UPDATE consents SET revoked_at = now(), revoked_reason = 'revoked by user' WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL RETURNING address`, [Number(m[1]) || 0, ctx.workspaceId]);
  if (c) await q(`INSERT INTO suppressions (workspace_id, value, channel, reason) VALUES ($1, $2, 'whatsapp', 'opt-in revoked') ON CONFLICT (workspace_id, value) DO NOTHING`, [ctx.workspaceId, c.address]);
  return { ok: true };
});

// ------------------------------------------------------------------ routes: inbox
on('GET', '/api/inbox', async ({ p, ctx }) => {
  need(ctx);
  const status = p.get('status') === 'closed' ? 'closed' : 'open';
  return q(`SELECT c.id, c.address, c.contact_name, c.biz_id, b.name AS biz_name, c.status, c.unread, c.last_message_at, c.last_inbound_at, u.name AS assigned_name,
      (SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY id DESC LIMIT 1) AS preview,
      EXISTS (SELECT 1 FROM consents k WHERE k.workspace_id = c.workspace_id AND k.channel = 'whatsapp' AND k.address = c.address AND k.revoked_at IS NULL) AS opted_in
    FROM conversations c LEFT JOIN biz b ON b.id = c.biz_id LEFT JOIN users u ON u.id = c.assigned_to
    WHERE c.workspace_id = $1 AND c.status = $2 ORDER BY c.last_message_at DESC LIMIT 300`, [ctx.workspaceId, status]);
});
on('GET', '/api/inbox/unread', async ({ ctx }) => {
  need(ctx);
  return one(`SELECT COALESCE(SUM(unread), 0)::int AS n FROM conversations WHERE workspace_id = $1 AND status = 'open'`, [ctx.workspaceId]);
});
async function getConv(id: string, ws: string) {
  const c = await one<{ id: string; address: string; contact_name: string | null; biz_id: string | null; status: string; last_inbound_at: Date | null; assigned_to: string | null }>(
    `SELECT * FROM conversations WHERE id = $1 AND workspace_id = $2`, [id, ws]);
  if (!c) throw new HttpError(404, 'Conversation not found.');
  return c;
}
on('GET', '/api/inbox/:id', async ({ m, ctx }) => {
  need(ctx);
  const c = await getConv(m[1]!, ctx.workspaceId);
  await q(`UPDATE conversations SET unread = 0 WHERE id = $1`, [c.id]);
  const [messages, consent, biz, mode] = await Promise.all([
    q(`SELECT m.id, m.direction, m.body, m.template, m.status, m.error, m.created_at, u.name AS sent_by FROM messages m LEFT JOIN users u ON u.id = m.sent_by WHERE m.conversation_id = $1 ORDER BY m.id`, [c.id]),
    one(`SELECT method, proof, created_at FROM consents WHERE workspace_id = $1 AND channel = 'whatsapp' AND address = $2 AND revoked_at IS NULL ORDER BY id DESC LIMIT 1`, [ctx.workspaceId, c.address]),
    c.biz_id ? one(`SELECT id, name, cat, area, district FROM biz WHERE id = $1`, [c.biz_id]) : Promise.resolve(null),
    waConfig(ctx.workspaceId),
  ]);
  const windowOpen = !!c.last_inbound_at && Date.now() - new Date(c.last_inbound_at).getTime() < WINDOW_MS;
  return { ...c, messages, consent, biz, window_open: windowOpen, window_closes_at: c.last_inbound_at ? new Date(new Date(c.last_inbound_at).getTime() + WINDOW_MS) : null, mode: mode.mode };
});
on('POST', '/api/inbox/:id/reply', async ({ req, m, ctx }) => {
  need(ctx);
  const c = await getConv(m[1]!, ctx.workspaceId);
  const text = str((await body(req)).text, 4000);
  if (!text) throw new HttpError(400, 'Write a message.');
  if (!c.last_inbound_at || Date.now() - new Date(c.last_inbound_at).getTime() >= WINDOW_MS)
    throw new HttpError(409, 'The 24-hour reply window is closed. WhatsApp only allows an approved template now (and only with an opt-in).');
  await sendWaText(ctx.workspaceId, c.id, c.address, text, ctx.userId);
  return { ok: true };
});
on('POST', '/api/inbox/:id/template', async ({ req, m, ctx }) => {
  need(ctx);
  const c = await getConv(m[1]!, ctx.workspaceId);
  const b = await body(req);
  if (!(await one(`SELECT 1 FROM consents WHERE workspace_id = $1 AND channel = 'whatsapp' AND address = $2 AND revoked_at IS NULL`, [ctx.workspaceId, c.address])))
    throw new HttpError(409, 'No recorded opt-in for this number. Record one first (Contacts & opt-ins) or wait for them to message you.');
  if (await one(`SELECT 1 FROM suppressions WHERE workspace_id = $1 AND value = $2`, [ctx.workspaceId, c.address])) throw new HttpError(409, 'This number is on your do-not-contact list.');
  try {
    await sendWaTemplate(ctx.workspaceId, c.address, str(b.template, 120), str(b.language, 20) || 'en', Array.isArray(b.params) ? b.params.map((x) => str(x, 500)) : [], { userId: ctx.userId });
  } catch (e) { throw new HttpError(502, (e as Error).message); }
  return { ok: true };
});
on('POST', '/api/inbox/:id/status', async ({ req, m, ctx }) => {
  need(ctx);
  const c = await getConv(m[1]!, ctx.workspaceId);
  const b = await body(req);
  if (b.status === 'open' || b.status === 'closed') await q(`UPDATE conversations SET status = $2 WHERE id = $1`, [c.id, b.status]);
  if ('assigned_to' in b) {
    const uid = str(b.assigned_to, 40) || null;
    if (uid && !(await one(`SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id::text = $2`, [ctx.workspaceId, uid]))) throw new HttpError(400, 'Not a workspace member.');
    await q(`UPDATE conversations SET assigned_to = $2 WHERE id = $1`, [c.id, uid]);
  }
  return { ok: true };
});
on('POST', '/api/inbox/start', async ({ req, ctx }) => {
  need(ctx);
  const b = await body(req);
  const address = normalizeWaPhone(str(b.phone, 30));
  if (!address) throw new HttpError(400, 'Enter a Bangladeshi mobile number.');
  return { id: await conversation(ctx.workspaceId, address, { bizId: str(b.biz_id, 100) || null, name: str(b.name, 100) || null }) };
});
// TEST mode only: pretend a customer wrote to us, to try the inbox, STOP/START and the 24-hour window without Meta
on('POST', '/api/inbox/simulate', async ({ req, ctx }) => {
  need(ctx);
  if ((await waConfig(ctx.workspaceId)).mode !== 'test') throw new HttpError(400, 'Simulation is only available in test mode.');
  const b = await body(req);
  const from = normalizeWaPhone(str(b.phone, 30));
  if (!from) throw new HttpError(400, 'Enter a Bangladeshi mobile number.');
  await receive(ctx.workspaceId, from, str(b.text, 2000) || 'Hello', str(b.name, 80) || null, null);
  return { ok: true };
});

// ------------------------------------------------------------------ webhook (Meta → us)
on('GET', '/api/whatsapp/webhook', async ({ res, p }) => {
  const token = p.get('hub.verify_token') ?? '';
  const ok = p.get('hub.mode') === 'subscribe' && token.length > 10 && !!(await one(`SELECT 1 FROM workspace_settings WHERE wa_verify_token = $1`, [token]));
  if (!ok) { html(res, 403, 'forbidden'); return; }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(p.get('hub.challenge') ?? '');
}, true);
on('POST', '/api/whatsapp/webhook', async ({ req, res }) => {
  const raw = await rawBody(req);
  let payload: { entry?: { changes?: { value?: Record<string, unknown> }[] }[] };
  try { payload = JSON.parse(raw); } catch { res.writeHead(400).end(); return; }
  const sig = String(req.headers['x-hub-signature-256'] ?? '');
  for (const entry of payload.entry ?? []) for (const ch of entry.changes ?? []) {
    const v = ch.value ?? {};
    const phoneId = (v.metadata as { phone_number_id?: string } | undefined)?.phone_number_id;
    if (!phoneId) continue;
    const ws = (await one<{ workspace_id: string }>(`SELECT workspace_id FROM workspace_settings WHERE wa_phone_number_id = $1`, [phoneId]))?.workspace_id;
    if (!ws) continue;
    const secret = await (await waConfig(ws)).appSecret();
    const expected = secret ? `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}` : '';
    if (!secret || sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) { res.writeHead(401).end(); return; }
    const names = new Map(((v.contacts as { wa_id: string; profile?: { name?: string } }[]) ?? []).map((c) => [c.wa_id, c.profile?.name ?? null]));
    for (const msg of (v.messages as { from: string; id: string; type: string; text?: { body?: string }; button?: { text?: string } }[]) ?? []) {
      const text = msg.text?.body ?? msg.button?.text ?? `[${msg.type} message]`;
      if (await one(`SELECT 1 FROM messages WHERE provider_id = $1`, [msg.id])) continue; // Meta retries deliveries
      await receive(ws, msg.from, text, names.get(msg.from) ?? null, msg.id);
    }
    for (const st of (v.statuses as { id: string; status: string; errors?: { title?: string }[] }[]) ?? []) {
      const err = st.errors?.[0]?.title ?? null;
      await q(`UPDATE messages SET status = $2, error = COALESCE($3, error) WHERE provider_id = $1`, [st.id, st.status, err]);
      const mapped = ({ sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed' } as Record<string, string>)[st.status];
      if (mapped) await q(`UPDATE campaign_recipients SET status = $2, reason = COALESCE($3, reason), updated_at = now() WHERE provider_id = $1 AND status <> 'replied'`, [st.id, mapped, err]);
    }
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ok');
}, true, { csrf: false });
