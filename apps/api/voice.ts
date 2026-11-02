/**
 * Automated voice calls ("auto call" campaigns): the phone rings, and when the person answers a Bangla message is spoken.
 * They can press 1 (interested: shows up as "replied") or 9 (never call me again: goes on the suppression list).
 *
 * - Speech: Azure neural TTS with the Bangladeshi voices bn-BD-NabanitaNeural / bn-BD-PradeepNeural (AZURE_SPEECH_KEY + AZURE_SPEECH_REGION).
 *   Audio is made once per distinct text and cached in data/voice_audio/<sha256>.mp3. Without Azure, Twilio's own Bengali
 *   voice is used (<Say language="bn-IN">, Indian Bengali accent: works, sounds less local).
 * - Custom voice: instead of text-to-speech the message can be the workspace's own recording (voice_clips; recorded or uploaded
 *   in the browser and converted there to 8 kHz mono WAV, i.e. telephone quality). Intro and 1/9 instructions are still spoken around it.
 * - Dialling: Twilio Programmable Voice (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM). Twilio fetches the call script and
 *   reports keypresses/statuses on webhooks, so APP_URL must be a public https address (in development: a tunnel).
 *   Without Twilio the app runs in TEST mode: nothing is dialled, recipients are marked as such.
 * - Built-in rules: every call says who is calling and how to opt out (press 9); the suppression list is checked at launch and
 *   before each call; calls only go out inside the workspace's calling hours (Asia/Dhaka); at most VOICE_MAX_CONCURRENT at a time.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { ROOT, one, q } from './db.js';
import { HttpError, body, esc, need, on, rawBody, str } from './http.js';

/** One piece of a call: speech made from text, or one of the workspace's own recordings. */
export type Part = { text: string } | { clip: string; label: string };
/** What the call script plays: an audio file in data/voice_audio, or text for Twilio's own voice. */
type Segment = { audio: string } | { say: string };

const AUDIO_DIR = resolve(ROOT, 'data/voice_audio');
mkdirSync(AUDIO_DIR, { recursive: true });
const PUBLIC_URL = () => (process.env.APP_URL ?? `http://localhost:${process.env.API_PORT ?? 8787}`).replace(/\/$/, '');
const env = (k: string) => process.env[k]?.trim() || null;

export const VOICES = [
  { id: 'bn-BD-NabanitaNeural', label: 'Nabanita (female, Bangladesh)' },
  { id: 'bn-BD-PradeepNeural', label: 'Pradeep (male, Bangladesh)' },
];
export const VOICE_CREDITS_PER_CALL = Math.max(1, Number(process.env.VOICE_CREDITS_PER_CALL ?? 3) || 3);
const MAX_CONCURRENT = Math.max(1, Number(process.env.VOICE_MAX_CONCURRENT ?? 5) || 5);
const SAY_FALLBACK = { voice: 'Google.bn-IN-Standard-A', language: 'bn-IN' };
// fixed phrases around every message: who is calling, and how to say yes / stop
export const INTRO = (sender: string) => `আসসালামু আলাইকুম। এটি ${sender} থেকে একটি স্বয়ংক্রিয় কল।`;
export const OUTRO = 'আগ্রহী হলে এক চাপুন। আর কখনো কল না পেতে নয় চাপুন।';
const THANKS_YES = 'ধন্যবাদ। আমাদের একজন প্রতিনিধি শীঘ্রই আপনার সাথে যোগাযোগ করবেন।';
const THANKS_STOP = 'ঠিক আছে, আপনাকে আর কল করা হবে না। ধন্যবাদ।';

export const voiceMode = (): 'live' | 'test' => (env('TWILIO_ACCOUNT_SID') && env('TWILIO_AUTH_TOKEN') && env('TWILIO_FROM') ? 'live' : 'test');
export const ttsMode = (): 'azure' | 'twilio_say' => (env('AZURE_SPEECH_KEY') && env('AZURE_SPEECH_REGION') ? 'azure' : 'twilio_say');

/** Any Bangladeshi number (mobile or landline) → E.164 digits without '+', e.g. 8801712345678 / 88029123456. */
export function normalizeBdPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = raw.replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 10 && d.startsWith('1')) d = `880${d}`; // Excel dropped the leading 0
  else if (d.startsWith('0')) d = `88${d}`;
  return /^880(1[3-9]\d{8}|[2-9]\d{6,9})$/.test(d) ? d : null;
}
/** The forms a number may have been stored in on the suppression list (E.164 digits, local 0-prefixed). */
export const phoneForms = (e164: string) => [e164, `0${e164.slice(3)}`];

export function dhakaHour(d = new Date()): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', hour: '2-digit', hour12: false }).format(d)) % 24;
}

// ------------------------------------------------------------------ text to speech
/** Makes (or reuses) an MP3 of the text in a Bangladeshi voice; returns its id, or null when Azure is not configured. */
export async function synthesize(text: string, voice: string): Promise<string | null> {
  if (ttsMode() !== 'azure') return null;
  const v = VOICES.some((x) => x.id === voice) ? voice : VOICES[0]!.id;
  const id = createHash('sha256').update(`${v}|${text}`).digest('hex').slice(0, 32);
  const file = resolve(AUDIO_DIR, `${id}.mp3`);
  if (existsSync(file)) return id;
  const ssml = `<speak version="1.0" xml:lang="bn-BD"><voice name="${v}"><prosody rate="-8%">${esc(text)}</prosody></voice></speak>`;
  const res = await fetch(`https://${env('AZURE_SPEECH_REGION')}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST', body: ssml,
    headers: { 'Ocp-Apim-Subscription-Key': env('AZURE_SPEECH_KEY')!, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'audio-16khz-64kbitrate-mono-mp3', 'User-Agent': 'BizMap' },
  });
  if (!res.ok) throw new Error(`Speech synthesis failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return id;
}

// ------------------------------------------------------------------ Twilio
async function twilio(path: string, form: Record<string, string>) {
  const sid = env('TWILIO_ACCOUNT_SID')!;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/${path}`, {
    method: 'POST', body: new URLSearchParams(form),
    headers: { authorization: `Basic ${Buffer.from(`${sid}:${env('TWILIO_AUTH_TOKEN')}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
  });
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) throw new Error(`Twilio: ${String(data.message ?? res.status)}`);
  return data;
}

/** Twilio signs every webhook: base64(HMAC-SHA1(auth token, full URL + each POST param name+value, sorted by name)). */
function twilioSigned(req: IncomingMessage, path: string, params: URLSearchParams): boolean {
  const given = String(req.headers['x-twilio-signature'] ?? '');
  const token = env('TWILIO_AUTH_TOKEN');
  if (!given || !token) return false;
  const data = PUBLIC_URL() + path + [...params.keys()].sort().map((k) => k + params.get(k)).join('');
  const want = createHmac('sha1', token).update(data).digest('base64');
  return want.length === given.length && timingSafeEqual(Buffer.from(want), Buffer.from(given));
}

const play = (seg: Segment) => ('audio' in seg
  ? `<Play>${PUBLIC_URL()}/api/voice/audio/${seg.audio}</Play>`
  : `<Say voice="${SAY_FALLBACK.voice}" language="${SAY_FALLBACK.language}">${esc(seg.say)}</Say>`);
/** Turns the parts of a call into playable segments (text is synthesized once and cached; intro/outro are shared by all calls). */
export async function toSegments(parts: Part[], voice: string): Promise<Segment[]> {
  const out: Segment[] = [];
  for (const p of parts) {
    if ('clip' in p) out.push({ audio: `${p.clip}.wav` });
    else if (p.text.trim()) { const id = await synthesize(p.text, voice); out.push(id ? { audio: `${id}.mp3` } : { say: p.text }); }
  }
  return out;
}
export const describe = (parts: Part[]) => parts.map((p) => ('clip' in p ? `[${p.label}]` : p.text)).join(' ');
/** The call script: message (with intro/outro) while listening for one keypress, played twice, then hang up. */
function callTwiml(segs: Segment[], gatherUrl: string | null) {
  const gather = (inner: string) => (gatherUrl ? `<Gather numDigits="1" timeout="5" action="${esc(gatherUrl)}" method="POST">${inner}</Gather>` : inner);
  const all = segs.map(play).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="1"/>${gather(all)}${gather(all)}<Hangup/></Response>`;
}
const xml = (res: import('node:http').ServerResponse, body: string) => { res.writeHead(200, { 'content-type': 'text/xml; charset=utf-8', 'cache-control': 'no-store' }); res.end(body); };

// ------------------------------------------------------------------ worker step (called from processCampaigns)
interface VoiceCampaign { id: string; workspace_id: string; body: string; voice_name: string | null }
export async function processVoice(c: VoiceCampaign, hours: { start: number; end: number }, speech: (merge: Record<string, string>) => Part[]): Promise<'done' | 'waiting' | 'working'> {
  const h = dhakaHour();
  if (h < hours.start || h >= hours.end) return 'waiting'; // outside calling hours: try again later
  const live = voiceMode() === 'live';
  // calls placed in the last few minutes without a final status are still ringing or talking
  const inflight = live ? (await one<{ n: number }>(`SELECT COUNT(*)::int n FROM campaign_recipients r JOIN campaigns c ON c.id = r.campaign_id
    WHERE c.channel = 'voice' AND r.status IN ('sent', 'delivered') AND r.reason IS NULL AND r.updated_at > now() - interval '5 minutes'`))?.n ?? 0 : 0;
  const budget = Math.max(0, MAX_CONCURRENT - inflight);
  if (!budget) return 'working';
  const batch = await q<{ id: number; address: string; merge: Record<string, string> }>(
    `SELECT id, address, merge FROM campaign_recipients WHERE campaign_id = $1 AND status = 'queued' ORDER BY id LIMIT $2`, [c.id, budget]);
  if (!batch.length) return 'done';
  for (const r of batch) {
    const blocked = await one(`SELECT 1 FROM suppressions WHERE workspace_id = $1 AND lower(value) = ANY($2::text[])`, [c.workspace_id, phoneForms(r.address)]);
    if (blocked) { await q(`UPDATE campaign_recipients SET status = 'unsubscribed', reason = 'on suppression list', updated_at = now() WHERE id = $1`, [r.id]); continue; }
    try {
      const parts = speech(r.merge);
      const text = describe(parts);
      const audio = JSON.stringify(await toSegments(parts, c.voice_name ?? VOICES[0]!.id));
      if (!live) {
        await q(`UPDATE campaign_recipients SET status = 'skipped', reason = 'test mode: not dialled (add TWILIO_* to .env)', media = $2, merge = merge || $3::jsonb, sent_at = now(), updated_at = now() WHERE id = $1`,
          [r.id, audio, JSON.stringify({ _speech: text })]);
        continue;
      }
      const base = `${PUBLIC_URL()}/api/voice`;
      const call = await twilio('Calls.json', {
        To: `+${r.address}`, From: env('TWILIO_FROM')!, Url: `${base}/twiml/${r.id}`, Method: 'POST', Timeout: '30',
        StatusCallback: `${base}/status/${r.id}`, StatusCallbackMethod: 'POST', StatusCallbackEvent: 'answered completed',
      });
      // reason NULL = call in progress (counts against the concurrency limit until a final status arrives)
      await q(`UPDATE campaign_recipients SET status = 'sent', provider_id = $2, media = $3, merge = merge || $4::jsonb, reason = NULL, sent_at = now(), updated_at = now() WHERE id = $1`,
        [r.id, String(call.sid ?? ''), audio, JSON.stringify({ _speech: text })]);
    } catch (e) {
      await q(`UPDATE campaign_recipients SET status = 'failed', reason = $2, updated_at = now() WHERE id = $1`, [r.id, (e instanceof Error ? e.message : String(e)).slice(0, 300)]);
    }
  }
  return 'working';
}

/** A one-off call to the user's own phone with the campaign's message (not charged, keypresses ignored). */
export async function testCall(to: string, parts: Part[], voice: string) {
  if (voiceMode() !== 'live') throw new HttpError(400, 'Calling is in test mode: add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM to .env.');
  await twilio('Calls.json', { To: `+${to}`, From: env('TWILIO_FROM')!, Twiml: callTwiml(await toSegments(parts, voice), null), Timeout: '30' });
}

/** Checks that a recording belongs to the workspace; returns its display name. */
export async function clipName(ws: string, id: string | null): Promise<string | null> {
  if (!id) return null;
  return (await one<{ name: string }>(`SELECT name FROM voice_clips WHERE workspace_id = $1 AND id = $2`, [ws, id]))?.name ?? null;
}

// ------------------------------------------------------------------ routes
// audio for Twilio (and the in-app preview); ids are content hashes, so they cannot be guessed
on('GET', '/api/voice/audio/:id', async ({ res, m }) => {
  const [, id, ext = 'mp3'] = m[1]!.match(/^([0-9a-f]{32})(?:\.(mp3|wav))?$/) ?? [];
  const file = id ? resolve(AUDIO_DIR, `${id}.${ext}`) : '';
  if (!id || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': ext === 'wav' ? 'audio/wav' : 'audio/mpeg', 'cache-control': 'public, max-age=86400' });
  createReadStream(file).pipe(res);
}, true, { csrf: false });

// ------------------------------------------------------------------ own recordings
const MAX_CLIP_SECONDS = 75; // 75 s of 8 kHz 16-bit WAV ≈ 1.2 MB, about 1.6 MB as base64: inside the 2 MB request limit
on('GET', '/api/voice/clips', async ({ ctx }) => {
  need(ctx);
  return q(`SELECT v.id, v.name, v.seconds, v.created_at, u.name AS created_by FROM voice_clips v LEFT JOIN users u ON u.id = v.created_by WHERE v.workspace_id = $1 ORDER BY v.created_at DESC`, [ctx.workspaceId]);
});
/** Body: { name, wav: base64 }. The browser converts recordings/uploads to 8 kHz 16-bit mono PCM WAV, which is all a phone line carries. */
on('POST', '/api/voice/clips', async ({ req, ctx }) => {
  need(ctx);
  const b = await body(req);
  const name = str(b.name, 80) || 'Recording';
  const buf = Buffer.from(typeof b.wav === 'string' ? b.wav : '', 'base64');
  // RIFF....WAVE, fmt chunk: PCM (1), mono, 8 kHz, 16 bit
  const fmtOk = buf.length > 44 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE' && buf.toString('ascii', 12, 16) === 'fmt '
    && buf.readUInt16LE(20) === 1 && buf.readUInt16LE(22) === 1 && buf.readUInt32LE(24) === 8000 && buf.readUInt16LE(34) === 16;
  if (!fmtOk) throw new HttpError(400, 'Unsupported audio. Record again or choose another file.');
  const seconds = (buf.length - 44) / 16000;
  if (seconds < 1) throw new HttpError(400, 'The recording is too short.');
  if (seconds > MAX_CLIP_SECONDS + 1) throw new HttpError(400, `Keep the recording under ${MAX_CLIP_SECONDS} seconds.`);
  const id = createHash('sha256').update(buf).digest('hex').slice(0, 32);
  writeFileSync(resolve(AUDIO_DIR, `${id}.wav`), buf);
  await q(`INSERT INTO voice_clips (id, workspace_id, name, seconds, created_by) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (workspace_id, id) DO UPDATE SET name = $3`,
    [id, ctx.workspaceId, name, Math.round(seconds * 10) / 10, ctx.userId]);
  return { id, name, seconds: Math.round(seconds * 10) / 10, audio: `/api/voice/audio/${id}.wav` };
});
on('DELETE', '/api/voice/clips/:id', async ({ m, ctx }) => {
  need(ctx);
  // the file stays: launched campaigns may still play it
  await q(`DELETE FROM voice_clips WHERE workspace_id = $1 AND id = $2`, [ctx.workspaceId, m[1]]);
  await q(`UPDATE campaigns SET voice_clip = NULL WHERE workspace_id = $1 AND voice_clip = $2 AND status = 'draft'`, [ctx.workspaceId, m[1]]);
  return { ok: true };
});

on('POST', '/api/voice/preview', async ({ req, ctx }) => {
  need(ctx);
  const b = await body(req);
  const text = str(b.text, 1500);
  if (!text) throw new HttpError(400, 'Write the message first.');
  const id = await synthesize(text, str(b.voice, 60));
  return { audio: id ? `/api/voice/audio/${id}` : null, tts: ttsMode() };
});

async function webhookParams(req: IncomingMessage, path: string) {
  const params = new URLSearchParams(await rawBody(req));
  if (!twilioSigned(req, path, params)) throw new HttpError(403, 'Bad signature.');
  return params;
}
const recipient = (id: string) => one<{ id: number; campaign_id: string; workspace_id: string; address: string; status: string; media: string | null; merge: Record<string, string>; voice_name: string | null }>(
  `SELECT r.id, r.campaign_id, c.workspace_id, r.address, r.status, r.media, r.merge, c.voice_name FROM campaign_recipients r JOIN campaigns c ON c.id = r.campaign_id WHERE r.id = $1 AND c.channel = 'voice'`, [Number(id) || 0]);

on('POST', '/api/voice/twiml/:rid', async ({ req, res, m }) => {
  await webhookParams(req, `/api/voice/twiml/${m[1]}`);
  const r = await recipient(m[1]!);
  if (!r) { xml(res, '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>'); return; }
  const segs: Segment[] = r.media?.startsWith('[') ? JSON.parse(r.media) : r.media ? [{ audio: `${r.media}.mp3` }] : [{ say: r.merge._speech ?? '' }];
  xml(res, callTwiml(segs, `${PUBLIC_URL()}/api/voice/gather/${r.id}`));
}, true, { csrf: false });

on('POST', '/api/voice/gather/:rid', async ({ req, res, m }) => {
  const p = await webhookParams(req, `/api/voice/gather/${m[1]}`);
  const r = await recipient(m[1]!);
  const digit = p.get('Digits') ?? '';
  let reply = '';
  if (r && digit === '1') {
    await q(`UPDATE campaign_recipients SET status = 'replied', reason = 'pressed 1: interested', updated_at = now() WHERE id = $1`, [r.id]);
    reply = THANKS_YES;
  } else if (r && digit === '9') {
    await q(`INSERT INTO suppressions (workspace_id, value, channel, reason) VALUES ($1, $2, 'phone', 'pressed 9 on an automated call') ON CONFLICT (workspace_id, value) DO NOTHING`, [r.workspace_id, r.address]);
    await q(`UPDATE campaign_recipients SET status = 'unsubscribed', reason = 'pressed 9: stop calling', updated_at = now() WHERE id = $1`, [r.id]);
    reply = THANKS_STOP;
  }
  const segs = reply && r ? await toSegments([{ text: reply }], r.voice_name ?? VOICES[0]!.id).catch(() => [{ say: reply }]) : [];
  xml(res, `<?xml version="1.0" encoding="UTF-8"?><Response>${segs.map(play).join('')}<Hangup/></Response>`);
}, true, { csrf: false });

on('POST', '/api/voice/status/:rid', async ({ req, res, m }) => {
  const p = await webhookParams(req, `/api/voice/status/${m[1]}`);
  const st = p.get('CallStatus') ?? '';
  const id = Number(m[1]) || 0;
  // never overwrite a keypress result (replied / unsubscribed)
  if (st === 'in-progress') await q(`UPDATE campaign_recipients SET status = 'delivered', updated_at = now() WHERE id = $1 AND status = 'sent'`, [id]);
  else if (st === 'completed') await q(`UPDATE campaign_recipients SET status = CASE WHEN status = 'sent' THEN 'delivered' ELSE status END,
    reason = COALESCE(reason, $2), updated_at = now() WHERE id = $1 AND status IN ('sent', 'delivered', 'replied', 'unsubscribed')`, [id, `answered, ${Number(p.get('CallDuration') ?? 0)} s`]);
  else if (['busy', 'no-answer', 'failed', 'canceled'].includes(st)) await q(`UPDATE campaign_recipients SET status = 'failed', reason = $2, updated_at = now() WHERE id = $1 AND status IN ('sent', 'delivered')`,
    [id, st === 'no-answer' ? 'no answer' : st]);
  res.writeHead(204); res.end();
}, true, { csrf: false });
