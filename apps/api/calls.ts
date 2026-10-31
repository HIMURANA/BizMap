/**
 * Call queues for sales teams: build a queue from a list or a filter, work it one business at a time, log outcomes.
 * Outcomes feed back into the data: wrong number / closed / not a business become data reports, "do not call" goes on
 * the suppression list, no-answer retries up to 3 times. Calls are only offered inside the workspace's calling hours
 * (Asia/Dhaka). A verbal WhatsApp opt-in given on the call can be recorded with its proof.
 */
import { one, q, tx } from './db.js';
import { buildFilter } from './filters.js';
import { HttpError, body, need, on, str } from './http.js';
import { settings } from './campaigns.js';
import { normalizeWaPhone } from './whatsapp.js';

export const OUTCOMES = ['interested', 'callback', 'not_interested', 'no_answer', 'wrong_number', 'closed', 'not_a_business', 'do_not_call'] as const;
const LOCK_MINUTES = 15;
const MAX_ATTEMPTS = 3;

function dhakaHour(d = new Date()): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', hour: '2-digit', hour12: false }).format(d)) % 24;
}

async function getQueue(id: string, ws: string) {
  const qu = await one<{ id: string; name: string; script: string | null; created_at: string }>(`SELECT id, name, script, created_at FROM call_queues WHERE id = $1 AND workspace_id = $2`, [id, ws]);
  if (!qu) throw new HttpError(404, 'Call queue not found.');
  return qu;
}

on('GET', '/api/calls/queues', async ({ ctx }) => {
  need(ctx);
  return q(`SELECT cq.id, cq.name, cq.created_at, u.name AS created_by,
      COUNT(i.id)::int AS total,
      COUNT(*) FILTER (WHERE i.status = 'pending')::int AS pending,
      COUNT(*) FILTER (WHERE i.status = 'callback')::int AS callbacks,
      COUNT(*) FILTER (WHERE i.status = 'done')::int AS done,
      COUNT(*) FILTER (WHERE i.outcome = 'interested')::int AS interested
    FROM call_queues cq LEFT JOIN call_items i ON i.queue_id = cq.id LEFT JOIN users u ON u.id = cq.created_by
    WHERE cq.workspace_id = $1 GROUP BY cq.id, u.name ORDER BY cq.created_at DESC`, [ctx.workspaceId]);
});

on('POST', '/api/calls/queues', async ({ req, ctx }) => {
  need(ctx);
  const b = await body(req);
  const name = str(b.name, 120);
  if (!name) throw new HttpError(400, 'Give the queue a name.');
  let where: string, params: unknown[];
  const listId = str(b.list_id, 40);
  if (listId) { where = `WHERE b.id IN (SELECT i.biz_id FROM list_items i JOIN lists l ON l.id = i.list_id WHERE l.id::text = $1 AND l.workspace_id = $2)`; params = [listId, ctx.workspaceId]; }
  else { const f = buildFilter(new URLSearchParams(typeof b.query === 'string' ? b.query : ''), ctx.workspaceId); where = f.where; params = f.params; }
  const rows = await q<{ id: string; name: string; phone: string; district: string | null }>(
    `SELECT b.id, b.name, b.phone, b.district FROM biz b ${where ? `${where} AND` : 'WHERE'} b.phone IS NOT NULL AND b.phone_status IS DISTINCT FROM 'invalid' ORDER BY b.district, b.area, b.name LIMIT 5000`, params);
  const suppressed = new Set((await q<{ value: string }>(`SELECT value FROM suppressions WHERE workspace_id = $1`, [ctx.workspaceId])).map((r) => r.value.replace(/\D/g, '')));
  const seen = new Set<string>();
  const items = rows.filter((r) => {
    const digits = normalizeWaPhone(r.phone) ?? r.phone.replace(/\D/g, '');
    if (seen.has(digits) || suppressed.has(digits) || suppressed.has(r.phone.replace(/\D/g, ''))) return false;
    seen.add(digits);
    return true;
  });
  if (!items.length) throw new HttpError(400, 'None of these businesses has a usable phone number that is not on your do-not-contact list.');
  const id = await tx(async (c) => {
    const qid = (await c.query(`INSERT INTO call_queues (workspace_id, name, script, created_by) VALUES ($1, $2, $3, $4) RETURNING id`, [ctx.workspaceId, name, str(b.script, 5000) || null, ctx.userId])).rows[0].id as string;
    await c.query(`INSERT INTO call_items (queue_id, biz_id, phone, name) SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[]) ON CONFLICT DO NOTHING`,
      [qid, items.map((r) => r.id), items.map((r) => r.phone), items.map((r) => r.name)]);
    return qid;
  });
  return { id, items: items.length, skipped: rows.length - items.length };
});

on('GET', '/api/calls/queues/:id', async ({ m, ctx }) => {
  need(ctx);
  const qu = await getQueue(m[1]!, ctx.workspaceId);
  const [outcomes, recent, s] = await Promise.all([
    q(`SELECT COALESCE(outcome, status) AS k, COUNT(*)::int n FROM call_items WHERE queue_id = $1 GROUP BY 1 ORDER BY n DESC`, [qu.id]),
    q(`SELECT i.id, i.biz_id, i.name, i.phone, i.status, i.outcome, i.notes, i.callback_at, i.attempts, i.called_at, u.name AS called_by
       FROM call_items i LEFT JOIN users u ON u.id = i.called_by WHERE i.queue_id = $1 AND i.called_at IS NOT NULL ORDER BY i.called_at DESC LIMIT 100`, [qu.id]),
    settings(ctx.workspaceId),
  ]);
  const hour = dhakaHour();
  return { ...qu, outcomes, recent, hours: { start: s.call_hours_start, end: s.call_hours_end, now: hour, open: hour >= s.call_hours_start && hour < s.call_hours_end } };
});

on('DELETE', '/api/calls/queues/:id', async ({ m, ctx }) => {
  need(ctx);
  const qu = await getQueue(m[1]!, ctx.workspaceId);
  await q(`DELETE FROM call_queues WHERE id = $1`, [qu.id]);
  return { ok: true };
});

/** Claims the next business to call (callbacks that are due first), so two callers never get the same one. */
on('POST', '/api/calls/queues/:id/next', async ({ m, ctx }) => {
  need(ctx);
  const qu = await getQueue(m[1]!, ctx.workspaceId);
  const s = await settings(ctx.workspaceId);
  const hour = dhakaHour();
  if (hour < s.call_hours_start || hour >= s.call_hours_end) {
    return { item: null, outside_hours: true, hours: { start: s.call_hours_start, end: s.call_hours_end, now: hour } };
  }
  await q(`UPDATE call_items SET locked_by = NULL, locked_at = NULL WHERE queue_id = $1 AND locked_by = $2`, [qu.id, ctx.userId]); // release my previous claim
  const item = await one<{ id: number; biz_id: string; phone: string; name: string; status: string; attempts: number; notes: string | null; callback_at: string | null }>(
    `UPDATE call_items SET locked_by = $2, locked_at = now() WHERE id = (
       SELECT id FROM call_items
       WHERE queue_id = $1 AND (status = 'pending' OR (status = 'callback' AND callback_at <= now()))
         AND (locked_by IS NULL OR locked_at < now() - interval '${LOCK_MINUTES} minutes')
       ORDER BY (status = 'callback') DESC, callback_at NULLS LAST, id
       LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING id, biz_id, phone, name, status, attempts, notes, callback_at`, [qu.id, ctx.userId]);
  if (!item) return { item: null, outside_hours: false, done: true };
  const [biz, history] = await Promise.all([
    one(`SELECT b.id, b.name, b.cat, c.label AS cat_label, b.area, b.upazila, b.district, b.phone, b.phone_status, b.email, b.website, b.facebook, b.lat, b.lon
         FROM biz b JOIN biz_categories c ON c.id = b.cat WHERE b.id = $1`, [item.biz_id]),
    q(`SELECT i.outcome, i.notes, i.called_at, cq.name AS queue FROM call_items i JOIN call_queues cq ON cq.id = i.queue_id
       WHERE cq.workspace_id = $1 AND i.biz_id = $2 AND i.called_at IS NOT NULL AND i.id <> $3 ORDER BY i.called_at DESC LIMIT 5`, [ctx.workspaceId, item.biz_id, item.id]),
  ]);
  return { item, biz, history, script: qu.script, hours: { start: s.call_hours_start, end: s.call_hours_end, now: hour } };
});

on('POST', '/api/calls/items/:id/outcome', async ({ req, m, ctx }) => {
  need(ctx);
  const b = await body(req);
  const outcome = String(b.outcome);
  if (!(OUTCOMES as readonly string[]).includes(outcome)) throw new HttpError(400, 'Choose an outcome.');
  const item = await one<{ id: number; biz_id: string; phone: string; attempts: number }>(
    `SELECT i.id, i.biz_id, i.phone, i.attempts FROM call_items i JOIN call_queues cq ON cq.id = i.queue_id WHERE i.id = $1 AND cq.workspace_id = $2`, [Number(m[1]) || 0, ctx.workspaceId]);
  if (!item) throw new HttpError(404, 'Call not found.');
  const notes = str(b.notes, 2000) || null;
  let status = 'done', callbackAt: Date | null = null;
  if (outcome === 'callback') {
    callbackAt = typeof b.callback_at === 'string' ? new Date(b.callback_at) : null;
    if (!callbackAt || Number.isNaN(callbackAt.getTime()) || callbackAt < new Date()) throw new HttpError(400, 'Pick a future date and time for the call-back.');
    status = 'callback';
  }
  if (outcome === 'no_answer' && item.attempts + 1 < MAX_ATTEMPTS) { status = 'callback'; callbackAt = new Date(Date.now() + 2 * 3600 * 1000); }

  await tx(async (c) => {
    await c.query(`UPDATE call_items SET status = $2, outcome = $3, notes = COALESCE($4, notes), callback_at = $5, attempts = attempts + 1,
      called_by = $6, called_at = now(), locked_by = NULL, locked_at = NULL WHERE id = $1`, [item.id, status, outcome, notes, callbackAt, ctx.userId]);
    // feed what the caller learned back into the data
    const report = ({ wrong_number: 'wrong_phone', closed: 'closed', not_a_business: 'not_a_business' } as Record<string, string>)[outcome];
    if (report) await c.query(`INSERT INTO data_reports (biz_id, kind, note, workspace_id, user_id) VALUES ($1, $2, $3, $4, $5)`, [item.biz_id, report, `From a call${notes ? `: ${notes}` : ''}`, ctx.workspaceId, ctx.userId]);
    if (outcome === 'do_not_call') {
      await c.query(`INSERT INTO suppressions (workspace_id, value, channel, reason) VALUES ($1, $2, 'phone', 'asked not to be called') ON CONFLICT (workspace_id, value) DO NOTHING`, [ctx.workspaceId, item.phone.replace(/\D/g, '')]);
      await c.query(`UPDATE call_items SET status = 'skipped', outcome = 'do_not_call' WHERE status IN ('pending', 'callback') AND regexp_replace(phone, '\\D', '', 'g') = $2
        AND queue_id IN (SELECT id FROM call_queues WHERE workspace_id = $1)`, [ctx.workspaceId, item.phone.replace(/\D/g, '')]);
    }
    // a verbal WhatsApp opt-in, recorded with its proof
    if (b.whatsapp_opt_in === true) {
      const wa = normalizeWaPhone(item.phone);
      if (!wa) throw new HttpError(400, 'This is not a Bangladeshi mobile number, so it cannot be used for WhatsApp.');
      const exists = (await c.query(`SELECT 1 FROM consents WHERE workspace_id = $1 AND channel = 'whatsapp' AND address = $2 AND revoked_at IS NULL`, [ctx.workspaceId, wa])).rowCount;
      if (!exists) await c.query(`INSERT INTO consents (workspace_id, channel, address, biz_id, method, proof, recorded_by) VALUES ($1, 'whatsapp', $2, $3, 'call_verbal', $4, $5)`,
        [ctx.workspaceId, wa, item.biz_id, `Agreed on a call on ${new Date().toISOString()} (logged by ${ctx.name})${notes ? `: ${notes}` : ''}`, ctx.userId]);
    }
  });
  return { ok: true, status };
});

on('POST', '/api/calls/items/:id/skip', async ({ m, ctx }) => {
  need(ctx);
  await q(`UPDATE call_items SET status = 'skipped', locked_by = NULL, locked_at = NULL WHERE id = $1 AND queue_id IN (SELECT id FROM call_queues WHERE workspace_id = $2)`, [Number(m[1]) || 0, ctx.workspaceId]);
  return { ok: true };
});
