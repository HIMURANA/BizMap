/**
 * WhatsApp message templates managed from BizMap: list every template with its Meta review status, submit a new one for
 * review, delete one. Meta still reviews each template (minutes to 24 hours); only APPROVED templates can be sent.
 * The access token needs the whatsapp_business_management permission.
 *
 * Limits kept on purpose so every template created here can be sent by the campaign flow: no variables in the header or in
 * button links, at most 3 buttons, marketing or utility category.
 */
import { HttpError, body, need, on, str } from './http.js';
import { graph, waConfig } from './whatsapp.js';

const LANGUAGES = ['en', 'en_US', 'en_GB', 'bn'] as const;
const CATEGORIES = ['MARKETING', 'UTILITY'] as const;
const IMAGE_TYPES = ['image/jpeg', 'image/png'] as const;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const GRAPH_VERSION = process.env.WA_GRAPH_VERSION ?? 'v23.0';

type Language = typeof LANGUAGES[number];
type Category = typeof CATEGORIES[number];
type ButtonInput =
  | { type: 'QUICK_REPLY'; text: string }
  | { type: 'URL'; text: string; url: string }
  | { type: 'PHONE_NUMBER'; text: string; phone_number: string };

interface TemplateInput {
  name: string; language: Language; category: Category;
  header: { format: 'NONE' } | { format: 'TEXT'; text: string } | { format: 'IMAGE'; url: string };
  body: string; examples: string[]; footer: string; buttons: ButtonInput[];
}

const oneOf = <T extends string>(list: readonly T[], v: unknown, msg: string): T => {
  if (typeof v !== 'string' || !list.includes(v as T)) throw new HttpError(400, msg);
  return v as T;
};

/** Validates the request body into a typed template. Throws a 400 that says what to fix. */
export function readTemplate(b: Record<string, unknown>): TemplateInput {
  const name = str(b.name, 512);
  if (!/^[a-z0-9_]{1,512}$/.test(name)) throw new HttpError(400, 'The template name may only use lowercase letters, numbers and underscores (e.g. summer_offer).');
  const language = oneOf(LANGUAGES, b.language, 'Choose a language.');
  const category = oneOf(CATEGORIES, b.category, 'Choose Marketing or Utility.');

  const text = typeof b.body === 'string' ? b.body.trim() : '';
  if (!text) throw new HttpError(400, 'Write the message body.');
  if (text.length > 1024) throw new HttpError(400, 'The body can be at most 1024 characters.');
  const vars = (text.match(/\{\{\d+\}\}/g) ?? []).map((v) => Number(v.slice(2, -2)));
  const distinct = [...new Set(vars)].sort((a, c) => a - c);
  const count = distinct.length;
  if (distinct.some((n, i) => n !== i + 1)) throw new HttpError(400, 'Variables must be numbered in order: {{1}}, {{2}}, {{3}}…');
  const examples = Array.isArray(b.examples) ? b.examples.map((e) => str(e, 200)) : [];
  if (count && (examples.length < count || examples.slice(0, count).some((e) => !e))) throw new HttpError(400, `Meta needs an example value for each variable (${count}).`);

  const h = (b.header ?? { format: 'NONE' }) as { format?: unknown; text?: unknown; url?: unknown };
  let header: TemplateInput['header'];
  if (h.format === 'TEXT') {
    const ht = str(h.text, 100);
    if (!ht) throw new HttpError(400, 'Write the header text or remove the header.');
    if (ht.length > 60) throw new HttpError(400, 'The header text can be at most 60 characters.');
    if (/\{\{/.test(ht)) throw new HttpError(400, 'The header cannot contain variables.');
    header = { format: 'TEXT', text: ht };
  } else if (h.format === 'IMAGE') {
    const url = str(h.url, 2000);
    if (!/^https:\/\/[^\s]+$/i.test(url)) throw new HttpError(400, 'The header image must be a public https:// link to a JPG or PNG.');
    header = { format: 'IMAGE', url };
  } else header = { format: 'NONE' };

  const footer = str(b.footer, 100);
  if (footer.length > 60) throw new HttpError(400, 'The footer can be at most 60 characters.');
  if (/\{\{/.test(footer)) throw new HttpError(400, 'The footer cannot contain variables.');

  const rawButtons = Array.isArray(b.buttons) ? b.buttons : [];
  if (rawButtons.length > 3) throw new HttpError(400, 'Use at most 3 buttons.');
  const buttons = rawButtons.map((r): ButtonInput => {
    const x = r as { type?: unknown; text?: unknown; url?: unknown; phone_number?: unknown };
    const type = oneOf(['QUICK_REPLY', 'URL', 'PHONE_NUMBER'] as const, x.type, 'Unknown button type.');
    const label = str(x.text, 50);
    if (!label) throw new HttpError(400, 'Every button needs a label.');
    if (label.length > 25) throw new HttpError(400, `The button label "${label}" is longer than 25 characters.`);
    if (type === 'QUICK_REPLY') return { type, text: label };
    if (type === 'URL') {
      const url = str(x.url, 2000);
      if (!/^https:\/\/[^\s{}]+$/i.test(url)) throw new HttpError(400, `The button "${label}" needs a full https:// link without variables.`);
      return { type, text: label, url };
    }
    const phone = str(x.phone_number, 30).replace(/[\s()-]/g, '');
    if (!/^\+\d{8,15}$/.test(phone)) throw new HttpError(400, `The button "${label}" needs a phone number with country code, e.g. +8801712345678.`);
    return { type, text: label, phone_number: phone };
  });
  if (new Set(buttons.map((x) => x.text.toLowerCase())).size !== buttons.length) throw new HttpError(400, 'Button labels must be different.');
  const quickAt = buttons.flatMap((x, i) => (x.type === 'QUICK_REPLY' ? [i] : []));
  if (quickAt.length && quickAt[quickAt.length - 1]! - quickAt[0]! + 1 !== quickAt.length) throw new HttpError(400, 'Put quick-reply buttons together, before or after the link and call buttons.');
  return { name, language, category, header, body: text, examples: examples.slice(0, count), footer, buttons };
}

/** Meta's `components` array for a validated template; `headerHandle` is the uploaded image sample (image headers only). */
export function buildComponents(t: TemplateInput, headerHandle: string | null): Record<string, unknown>[] {
  const components: Record<string, unknown>[] = [];
  if (t.header.format === 'TEXT') components.push({ type: 'HEADER', format: 'TEXT', text: t.header.text });
  if (t.header.format === 'IMAGE' && headerHandle) components.push({ type: 'HEADER', format: 'IMAGE', example: { header_handle: [headerHandle] } });
  components.push({ type: 'BODY', text: t.body, ...(t.examples.length ? { example: { body_text: [t.examples] } } : {}) });
  if (t.footer) components.push({ type: 'FOOTER', text: t.footer });
  if (t.buttons.length) components.push({ type: 'BUTTONS', buttons: t.buttons });
  return components;
}

/**
 * Uploads the sample image with Meta's Resumable Upload API and returns the handle Meta wants as an image-header example.
 * The app id is read from the token itself (debug_token), so no extra setting is needed.
 */
async function uploadHeaderSample(token: string, url: string): Promise<string> {
  const img = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20_000) }).catch(() => null);
  if (!img?.ok) throw new HttpError(400, 'BizMap could not download the header image. Check that the link is public.');
  const type = (img.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!(IMAGE_TYPES as readonly string[]).includes(type)) throw new HttpError(400, 'The header image must be a JPG or PNG file.');
  const bytes = Buffer.from(await img.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) throw new HttpError(400, 'The header image is larger than 5 MB.');

  const dbg = (await graph(token, `debug_token?input_token=${encodeURIComponent(token)}`)) as { data?: { app_id?: string } };
  const appId = dbg.data?.app_id;
  if (!appId) throw new HttpError(400, 'Could not find the Meta app for this token, so the header image cannot be uploaded.');
  const session = (await graph(token, `${appId}/uploads?file_length=${bytes.length}&file_type=${encodeURIComponent(type)}&file_name=header`, { method: 'POST' })) as { id?: string };
  if (!session.id) throw new HttpError(502, 'Meta did not start the image upload.');
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${session.id}`, {
    method: 'POST', headers: { authorization: `OAuth ${token}`, file_offset: '0', 'content-type': type }, body: bytes,
  });
  const done = (await res.json().catch(() => ({}))) as { h?: string; error?: { message?: string } };
  if (!res.ok || !done.h) throw new HttpError(502, `Meta rejected the header image: ${done.error?.message ?? res.status}`);
  return done.h;
}

async function liveConnection(ws: string) {
  const cfg = await waConfig(ws);
  if (cfg.mode !== 'live' || !cfg.wabaId) throw new HttpError(400, 'Connect your WhatsApp Business account in Settings → Sending first.');
  return { wabaId: cfg.wabaId, token: (await cfg.token())! };
}

/** Meta errors that need a plain-language hint (the raw message stays in the text). */
function explain(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  const err = e as Error & { waCode?: number };
  const hint = err.waCode === 100 || /permission|\(#200\)|\(#10\)/i.test(err.message)
    ? ' The access token may be missing the whatsapp_business_management permission: create a System User token with it in Meta Business Settings.' : '';
  return new HttpError(400, `${err.message}${hint}`);
}

export interface WaTemplateRow {
  id: string; name: string; language: string; category: string; status: string; rejected_reason: string | null;
  body: string; header_format: string | null; footer: string | null; buttons: { type: string; text: string }[];
}
interface MetaTemplate { id: string; name: string; language: string; category: string; status: string; rejected_reason?: string; components?: { type: string; text?: string; format?: string; buttons?: { type: string; text: string }[] }[] }

on('GET', '/api/whatsapp/templates/all', async ({ ctx }) => {
  need(ctx);
  const cfg = await waConfig(ctx.workspaceId);
  if (cfg.mode !== 'live' || !cfg.wabaId) return { mode: cfg.mode, templates: [] as WaTemplateRow[] };
  const data = await graph((await cfg.token())!, `${cfg.wabaId}/message_templates?limit=200&fields=id,name,language,category,status,rejected_reason,components`);
  const templates = ((data.data as MetaTemplate[] | undefined) ?? []).map((t): WaTemplateRow => {
    const comp = (type: string) => t.components?.find((c) => c.type === type);
    return {
      id: t.id, name: t.name, language: t.language, category: t.category, status: t.status,
      rejected_reason: t.rejected_reason && t.rejected_reason !== 'NONE' ? t.rejected_reason : null,
      body: comp('BODY')?.text ?? '', header_format: comp('HEADER')?.format ?? null, footer: comp('FOOTER')?.text ?? null,
      buttons: (comp('BUTTONS')?.buttons ?? []).map((x) => ({ type: x.type, text: x.text })),
    };
  });
  return { mode: cfg.mode, templates };
});

on('POST', '/api/whatsapp/templates', async ({ req, ctx }) => {
  need(ctx, 'admin');
  const t = readTemplate(await body(req));
  const { wabaId, token } = await liveConnection(ctx.workspaceId);
  try {
    const handle = t.header.format === 'IMAGE' ? await uploadHeaderSample(token, t.header.url) : null;
    const res = (await graph(token, `${wabaId}/message_templates`, {
      method: 'POST', body: JSON.stringify({ name: t.name, language: t.language, category: t.category, components: buildComponents(t, handle) }),
    })) as { id?: string; status?: string };
    return { ok: true, id: res.id ?? null, status: res.status ?? 'PENDING' };
  } catch (e) { throw explain(e); }
});

on('DELETE', '/api/whatsapp/templates/:name', async ({ m, ctx }) => {
  need(ctx, 'admin');
  const name = decodeURIComponent(m[1]!);
  if (!/^[a-z0-9_]{1,512}$/.test(name)) throw new HttpError(400, 'Invalid template name.');
  const { wabaId, token } = await liveConnection(ctx.workspaceId);
  try { await graph(token, `${wabaId}/message_templates?name=${encodeURIComponent(name)}`, { method: 'DELETE' }); }
  catch (e) { throw explain(e); }
  return { ok: true };
});
