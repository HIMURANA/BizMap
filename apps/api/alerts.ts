/**
 * "New businesses" alerts on saved filters. A business counts as new for an alert when it was first discovered after the
 * alert's watermark; every run moves the watermark forward, so nothing is reported twice. Runs are checked hourly by the
 * worker (daily / weekly / monthly) and on demand; results show in the app and, if enabled, as an email digest.
 */
import { one, q } from './db.js';
import { buildFilter } from './filters.js';
import { HttpError, body, need, on, str } from './http.js';
import { sendMail } from './mailer.js';

const EVERY: Record<string, string> = { daily: '1 day', weekly: '7 days', monthly: '1 month' };
const APP_URL = () => (process.env.APP_URL ?? 'http://localhost:5173').replace(/\/$/, '');

async function latestFirstSeen(): Promise<string> {
  return (await one<{ m: string | null }>(`SELECT MAX(first_seen) m FROM biz`))?.m ?? new Date().toISOString();
}

export async function runAlert(alertId: string): Promise<{ new_count: number }> {
  const a = await one<{ id: string; workspace_id: string; user_id: string | null; name: string; query: string; watermark: string; email: boolean }>(`SELECT * FROM alerts WHERE id = $1`, [alertId]);
  if (!a) throw new HttpError(404, 'Alert not found.');
  const p = new URLSearchParams(a.query);
  p.delete('first_seen_after'); p.delete('page'); p.delete('sort'); p.delete('open');
  const f = buildFilter(p, a.workspace_id);
  const since = a.watermark;
  const extra = `${f.where ? `${f.where} AND` : 'WHERE'} b.first_seen > ${f.next()}`;
  const [count, sample, newest] = await Promise.all([
    one<{ n: number }>(`SELECT COUNT(*)::int n FROM biz b ${extra}`, [...f.params, since]),
    q<{ id: string; name: string; district: string | null; area: string | null; cat: string }>(`SELECT b.id, b.name, b.district, b.area, b.cat FROM biz b ${extra} ORDER BY b.first_seen DESC LIMIT 20`, [...f.params, since]),
    latestFirstSeen(),
  ]);
  const n = count?.n ?? 0;
  await q(`INSERT INTO alert_runs (alert_id, since, new_count, sample) VALUES ($1, $2, $3, $4)`, [a.id, since, n, JSON.stringify(sample)]);
  await q(`UPDATE alerts SET last_run_at = now(), watermark = GREATEST(watermark, $2) WHERE id = $1`, [a.id, newest]);
  if (n > 0 && a.email && a.user_id) {
    const u = await one<{ email: string; name: string }>(`SELECT email, name FROM users WHERE id = $1`, [a.user_id]);
    if (u) {
      const lines = sample.map((s) => `• ${s.name}${s.area || s.district ? ` (${s.area ?? s.district?.replace(/ District$/, '')})` : ''}`).join('\n');
      await sendMail({ workspaceId: a.workspace_id, kind: 'alert', to: u.email, subject: `${n} new business${n === 1 ? '' : 'es'}: ${a.name}`,
        text: `Hi ${u.name},\n\n${n} new business${n === 1 ? '' : 'es'} matched your alert "${a.name}":\n\n${lines}${n > sample.length ? `\n…and ${n - sample.length} more` : ''}\n\nSee them all: ${APP_URL()}/?${p.toString()}&first_seen_after=${since.slice(0, 10)}\n\nYou can change or stop this alert in BizMap → Alerts.` })
        .catch((e) => console.error('[alerts] email failed', (e as Error).message));
    }
  }
  return { new_count: n };
}

/** Called hourly by the worker: runs every active alert whose period has passed. */
export async function runDueAlerts(): Promise<void> {
  const due = await q<{ id: string }>(`SELECT id FROM alerts WHERE active AND (last_run_at IS NULL OR last_run_at + (CASE frequency WHEN 'daily' THEN interval '1 day' WHEN 'weekly' THEN interval '7 days' ELSE interval '1 month' END) <= now())`);
  for (const a of due) await runAlert(a.id).catch((e) => console.error('[alerts]', a.id, (e as Error).message));
}

async function own(id: string, ws: string) {
  if (!(await one(`SELECT 1 FROM alerts WHERE id = $1 AND workspace_id = $2`, [id, ws]))) throw new HttpError(404, 'Alert not found.');
}

on('GET', '/api/alerts', async ({ ctx }) => {
  need(ctx);
  return q(`SELECT a.id, a.name, a.query, a.frequency, a.email, a.active, a.last_run_at, a.created_at, a.watermark, u.name AS owner,
      (SELECT json_build_object('run_at', r.run_at, 'new_count', r.new_count, 'seen', r.seen) FROM alert_runs r WHERE r.alert_id = a.id ORDER BY r.run_at DESC LIMIT 1) AS last_run,
      (SELECT COALESCE(SUM(r.new_count), 0)::int FROM alert_runs r WHERE r.alert_id = a.id AND NOT r.seen) AS unseen
    FROM alerts a LEFT JOIN users u ON u.id = a.user_id WHERE a.workspace_id = $1 ORDER BY a.created_at DESC`, [ctx.workspaceId]);
});
on('GET', '/api/alerts/unseen', async ({ ctx }) => {
  need(ctx);
  return one(`SELECT COALESCE(SUM(r.new_count), 0)::int AS n FROM alert_runs r JOIN alerts a ON a.id = r.alert_id WHERE a.workspace_id = $1 AND NOT r.seen`, [ctx.workspaceId]);
});
on('POST', '/api/alerts', async ({ req, ctx }) => {
  need(ctx);
  const b = await body(req);
  const name = str(b.name, 120);
  if (!name) throw new HttpError(400, 'Give the alert a name.');
  const frequency = EVERY[String(b.frequency)] ? String(b.frequency) : 'weekly';
  const alert = await one<{ id: string }>(`INSERT INTO alerts (workspace_id, user_id, name, query, frequency, email, watermark) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [ctx.workspaceId, ctx.userId, name, typeof b.query === 'string' ? b.query.slice(0, 4000) : '', frequency, b.email !== false, await latestFirstSeen()]);
  return alert;
});
on('PATCH', '/api/alerts/:id', async ({ req, m, ctx }) => {
  need(ctx);
  await own(m[1]!, ctx.workspaceId);
  const b = await body(req);
  await q(`UPDATE alerts SET name = COALESCE(NULLIF($2, ''), name), frequency = COALESCE($3, frequency), email = COALESCE($4, email), active = COALESCE($5, active) WHERE id = $1`,
    [m[1], str(b.name, 120), EVERY[String(b.frequency)] ? String(b.frequency) : null, typeof b.email === 'boolean' ? b.email : null, typeof b.active === 'boolean' ? b.active : null]);
  return { ok: true };
});
on('DELETE', '/api/alerts/:id', async ({ m, ctx }) => { need(ctx); await own(m[1]!, ctx.workspaceId); await q(`DELETE FROM alerts WHERE id = $1`, [m[1]]); return { ok: true }; });
on('POST', '/api/alerts/:id/run', async ({ m, ctx }) => { need(ctx); await own(m[1]!, ctx.workspaceId); return runAlert(m[1]!); });
on('GET', '/api/alerts/:id/runs', async ({ m, ctx }) => {
  need(ctx);
  await own(m[1]!, ctx.workspaceId);
  const runs = await q(`SELECT id, run_at, since, new_count, sample, seen FROM alert_runs WHERE alert_id = $1 ORDER BY run_at DESC LIMIT 50`, [m[1]]);
  await q(`UPDATE alert_runs SET seen = true WHERE alert_id = $1 AND NOT seen`, [m[1]]);
  return runs;
});
