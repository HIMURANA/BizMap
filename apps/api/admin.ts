/**
 * Platform-admin API (/api/admin/*): DigitalLeon staff manage every workspace, user and credit balance.
 *
 *  - Only users whose email is in PLATFORM_ADMIN_EMAILS (applied at every API start) pass `needPlatform`; everyone else gets a
 *    404, so the routes do not reveal that they exist.
 *  - No response contains a token, app secret, password hash or session id.
 *  - Every change is written to platform_audit (who, what, which workspace). Audit rows outlive a deleted workspace.
 *  - There is deliberately no "sign in as this user": support works from the read-only detail pages.
 */
import { HttpError, UUID, body, on, str } from './http.js';
import type { Ctx } from './auth.js';
import { one, q, tx } from './db.js';

const MAX_CREDIT_CHANGE = 1_000_000;

/** Makes the env var the single source of truth: listed emails become platform admins, everyone else stops being one. */
export async function syncPlatformAdmins(): Promise<number> {
  const emails = (process.env.PLATFORM_ADMIN_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  await q(`UPDATE users SET is_platform_admin = (lower(email) = ANY($1::text[])) WHERE is_platform_admin <> (lower(email) = ANY($1::text[]))`, [emails]);
  return emails.length;
}

function needPlatform(ctx: Ctx | null): asserts ctx is Ctx {
  if (!ctx) throw new HttpError(401, 'Please sign in.');
  if (!ctx.platformAdmin) throw new HttpError(404, 'Not found.');
}
const uuid = (v: string | undefined): string => {
  if (!v || !UUID.test(v)) throw new HttpError(404, 'Not found.');
  return v;
};
/** Escapes % and _ so a search term is matched literally by ILIKE. */
const like = (s: string) => `%${s.replace(/[\\%_]/g, '\\$&')}%`;

async function audit(ctx: Ctx, action: string, a: { workspaceId?: string | null; target?: string | null; detail?: Record<string, unknown> } = {}) {
  await q(`INSERT INTO platform_audit (admin_id, admin_email, action, workspace_id, target, detail) VALUES ($1, $2, $3, $4, $5, $6)`,
    [ctx.userId, ctx.email, action, a.workspaceId ?? null, a.target ?? null, a.detail ? JSON.stringify(a.detail) : null]);
}

const balanceOf = async (ws: string) => Number((await one<{ b: string }>(`SELECT COALESCE(SUM(delta), 0) b FROM credit_ledger WHERE workspace_id = $1`, [ws]))?.b ?? 0);
const getWorkspace = async (id: string) => {
  const w = await one<{ id: string; name: string; created_at: Date; suspended_at: Date | null }>(`SELECT id, name, created_at, suspended_at FROM workspaces WHERE id = $1`, [id]);
  if (!w) throw new HttpError(404, 'Workspace not found.');
  return w;
};
const getUser = async (id: string) => {
  const u = await one<{ id: string; name: string; email: string; created_at: Date; last_login_at: Date | null; disabled_at: Date | null; is_platform_admin: boolean }>(
    `SELECT id, name, email, created_at, last_login_at, disabled_at, is_platform_admin FROM users WHERE id = $1`, [id]);
  if (!u) throw new HttpError(404, 'User not found.');
  return u;
};

// ------------------------------------------------------------------ overview
on('GET', '/api/admin/overview', async ({ ctx }) => {
  needPlatform(ctx);
  const [totals, payments, activity] = await Promise.all([
    one(`SELECT
        (SELECT count(*) FROM workspaces)::int AS workspaces,
        (SELECT count(*) FROM workspaces WHERE suspended_at IS NOT NULL)::int AS suspended,
        (SELECT count(*) FROM users)::int AS users,
        (SELECT count(*) FROM users WHERE disabled_at IS NOT NULL)::int AS disabled,
        (SELECT count(*) FROM users WHERE created_at > now() - interval '7 days')::int AS new_users_7d,
        (SELECT count(*) FROM campaigns)::int AS campaigns,
        (SELECT count(*) FROM campaigns WHERE status = 'sending')::int AS sending,
        (SELECT COALESCE(SUM(delta) FILTER (WHERE delta > 0), 0) FROM credit_ledger)::int AS credits_issued,
        (SELECT COALESCE(-SUM(delta) FILTER (WHERE delta < 0), 0) FROM credit_ledger)::int AS credits_used,
        (SELECT COALESCE(SUM(amount_bdt), 0) FROM payments WHERE status = 'paid')::float AS revenue_bdt,
        (SELECT count(*) FROM workspace_settings WHERE wa_phone_number_id IS NOT NULL AND wa_token_enc IS NOT NULL)::int AS whatsapp_connected`),
    q(`SELECT p.tran_id, p.pack, p.amount_bdt::float AS amount_bdt, p.credits, p.status, p.created_at, w.name AS workspace FROM payments p JOIN workspaces w ON w.id = p.workspace_id ORDER BY p.created_at DESC LIMIT 5`),
    q(`SELECT admin_email, action, target, created_at FROM platform_audit ORDER BY id DESC LIMIT 5`),
  ]);
  return { totals, payments, activity };
});

// ------------------------------------------------------------------ workspaces
on('GET', '/api/admin/workspaces', async ({ p, ctx }) => {
  needPlatform(ctx);
  const term = str(p.get('q'), 100);
  return q(`SELECT w.id, w.name, w.created_at, w.suspended_at,
      (SELECT count(*) FROM memberships m WHERE m.workspace_id = w.id)::int AS members,
      (SELECT COALESCE(SUM(delta), 0) FROM credit_ledger l WHERE l.workspace_id = w.id)::int AS balance,
      (SELECT count(*) FROM campaigns c WHERE c.workspace_id = w.id)::int AS campaigns,
      (SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = w.id AND m.role = 'owner' ORDER BY m.created_at LIMIT 1) AS owner_email,
      COALESCE(s.wa_phone_number_id IS NOT NULL AND s.wa_token_enc IS NOT NULL, false) AS whatsapp
    FROM workspaces w LEFT JOIN workspace_settings s ON s.workspace_id = w.id
    WHERE $1 = '' OR w.name ILIKE $2 OR EXISTS (SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = w.id AND (u.email ILIKE $2 OR u.name ILIKE $2))
    ORDER BY w.created_at DESC LIMIT 200`, [term, like(term)]);
});

on('GET', '/api/admin/workspaces/:id', async ({ m, ctx }) => {
  needPlatform(ctx);
  const w = await getWorkspace(uuid(m[1]));
  const [members, ledger, campaigns, payments, settings, data] = await Promise.all([
    q(`SELECT u.id, u.name, u.email, ms.role, u.last_login_at, u.disabled_at FROM memberships ms JOIN users u ON u.id = ms.user_id WHERE ms.workspace_id = $1 ORDER BY ms.created_at`, [w.id]),
    q(`SELECT l.id, l.delta, l.reason, l.ref, l.created_at, u.name AS by FROM credit_ledger l LEFT JOIN users u ON u.id = l.user_id WHERE l.workspace_id = $1 ORDER BY l.id DESC LIMIT 100`, [w.id]),
    q(`SELECT id, name, channel, status, recipients, credits, created_at FROM campaigns WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 20`, [w.id]),
    q(`SELECT tran_id, pack, amount_bdt::float AS amount_bdt, credits, status, provider, created_at, paid_at FROM payments WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 20`, [w.id]),
    one<{ wa_phone_number_id: string | null; wa_waba_id: string | null; has_token: boolean; sender_email: string | null; daily_email_cap: number }>(
      `SELECT wa_phone_number_id, wa_waba_id, (wa_token_enc IS NOT NULL) AS has_token, sender_email, daily_email_cap FROM workspace_settings WHERE workspace_id = $1`, [w.id]),
    dataCounts(w.id),
  ]);
  return { ...w, balance: await balanceOf(w.id), members, ledger, campaigns, payments, settings: settings ?? null, data };
});

// ------------------------------------------------------------------ data cleanup (campaigns, inbox, outbox, call logs)
const PURGE_WHAT = ['campaigns', 'inbox', 'outbox', 'calls'] as const;
type PurgeWhat = typeof PURGE_WHAT[number];

/** How much of each kind of activity data a workspace holds (shown before an admin deletes it). */
const dataCounts = (ws: string) => one(`SELECT
    (SELECT count(*) FROM campaigns WHERE workspace_id = $1)::int AS campaigns,
    (SELECT count(*) FROM campaigns WHERE workspace_id = $1 AND status IN ('sending', 'scheduled'))::int AS running_campaigns,
    (SELECT count(*) FROM campaign_recipients r JOIN campaigns c ON c.id = r.campaign_id WHERE c.workspace_id = $1)::int AS recipients,
    (SELECT count(*) FROM conversations WHERE workspace_id = $1)::int AS conversations,
    (SELECT count(*) FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.workspace_id = $1)::int AS messages,
    (SELECT count(*) FROM email_log WHERE workspace_id = $1)::int AS outbox,
    (SELECT count(*) FROM call_queues WHERE workspace_id = $1)::int AS call_queues,
    (SELECT count(*) FROM call_items i JOIN call_queues c ON c.id = i.queue_id WHERE c.workspace_id = $1)::int AS call_items`, [ws]);

/**
 * Permanently deletes one kind of activity data of a workspace. Credits already spent are not refunded.
 *  campaigns: campaigns and their recipients (running or scheduled ones are kept: cancel them first);
 *  inbox: WhatsApp conversations and messages;  outbox: the sent-email log;  calls: call queues and their call items.
 * Contacts, lists, opt-ins and the do-not-contact list are never touched here.
 */
on('POST', '/api/admin/workspaces/:id/purge', async ({ req, m, ctx }) => {
  needPlatform(ctx);
  const w = await getWorkspace(uuid(m[1]));
  const b = await body(req);
  const what = PURGE_WHAT.find((x) => x === b.what) as PurgeWhat | undefined;
  if (!what) throw new HttpError(400, 'Choose what to delete: campaigns, inbox, outbox or calls.');
  if (str(b.confirm, 20).toLowerCase() !== 'delete') throw new HttpError(400, 'Type "delete" to confirm.');
  const before = (await dataCounts(w.id))!;
  const deleted = await tx(async (c) => {
    if (what === 'campaigns') {
      const r = await c.query(`DELETE FROM campaigns WHERE workspace_id = $1 AND status NOT IN ('sending', 'scheduled')`, [w.id]);
      return { campaigns: r.rowCount ?? 0, kept_running: before.running_campaigns };
    }
    if (what === 'inbox') return { conversations: (await c.query(`DELETE FROM conversations WHERE workspace_id = $1`, [w.id])).rowCount ?? 0, messages: before.messages };
    if (what === 'outbox') return { emails: (await c.query(`DELETE FROM email_log WHERE workspace_id = $1`, [w.id])).rowCount ?? 0 };
    return { call_queues: (await c.query(`DELETE FROM call_queues WHERE workspace_id = $1`, [w.id])).rowCount ?? 0, call_items: before.call_items };
  });
  await audit(ctx, `data.purge_${what}`, { workspaceId: w.id, target: w.name, detail: deleted });
  return { ok: true, deleted };
});

on('PATCH', '/api/admin/workspaces/:id', async ({ req, m, ctx }) => {
  needPlatform(ctx);
  const w = await getWorkspace(uuid(m[1]));
  const name = str((await body(req)).name, 80);
  if (!name) throw new HttpError(400, 'Enter a workspace name.');
  await q(`UPDATE workspaces SET name = $2 WHERE id = $1`, [w.id, name]);
  await audit(ctx, 'workspace.rename', { workspaceId: w.id, target: w.name, detail: { to: name } });
  return { ok: true };
});

for (const [action, suspend] of [['suspend', true], ['unsuspend', false]] as const) {
  on('POST', `/api/admin/workspaces/:id/${action}`, async ({ req, m, ctx }) => {
    needPlatform(ctx);
    const w = await getWorkspace(uuid(m[1]));
    const reason = str((await body(req)).reason, 300);
    if (suspend && reason.length < 3) throw new HttpError(400, 'Write the reason for the suspension (it is kept in the audit log).');
    await q(`UPDATE workspaces SET suspended_at = ${suspend ? 'COALESCE(suspended_at, now())' : 'NULL'} WHERE id = $1`, [w.id]);
    if (suspend) await q(`UPDATE campaigns SET status = 'paused' WHERE workspace_id = $1 AND status IN ('sending', 'scheduled')`, [w.id]);
    await audit(ctx, `workspace.${action}`, { workspaceId: w.id, target: w.name, detail: reason ? { reason } : undefined });
    return { ok: true };
  });
}

on('POST', '/api/admin/workspaces/:id/credits', async ({ req, m, ctx }) => {
  needPlatform(ctx);
  const w = await getWorkspace(uuid(m[1]));
  const b = await body(req);
  const delta = b.delta;
  if (typeof delta !== 'number' || !Number.isInteger(delta) || delta === 0 || Math.abs(delta) > MAX_CREDIT_CHANGE) throw new HttpError(400, `Enter a whole number of credits, not 0 and at most ${MAX_CREDIT_CHANGE.toLocaleString()}.`);
  const reason = str(b.reason, 200);
  if (reason.length < 3) throw new HttpError(400, 'Write the reason for this change.');
  const balance = await tx(async (c) => {
    await c.query(`SELECT 1 FROM workspaces WHERE id = $1 FOR UPDATE`, [w.id]); // serialises concurrent adjustments
    const cur = Number((await c.query(`SELECT COALESCE(SUM(delta), 0) b FROM credit_ledger WHERE workspace_id = $1`, [w.id])).rows[0].b);
    if (cur + delta < 0) throw new HttpError(400, `The balance is ${cur.toLocaleString()}: it cannot go below 0.`);
    await c.query(`INSERT INTO credit_ledger (workspace_id, delta, reason, user_id) VALUES ($1, $2, $3, $4)`, [w.id, delta, `admin: ${reason}`, ctx.userId]);
    return cur + delta;
  });
  await audit(ctx, delta > 0 ? 'credits.grant' : 'credits.deduct', { workspaceId: w.id, target: w.name, detail: { delta, reason, balance } });
  return { ok: true, balance };
});

on('POST', '/api/admin/workspaces/:id/disconnect-whatsapp', async ({ m, ctx }) => {
  needPlatform(ctx);
  const w = await getWorkspace(uuid(m[1]));
  await q(`UPDATE workspace_settings SET wa_phone_number_id = NULL, wa_waba_id = NULL, wa_token_enc = NULL, wa_app_secret_enc = NULL WHERE workspace_id = $1`, [w.id]);
  await audit(ctx, 'workspace.disconnect_whatsapp', { workspaceId: w.id, target: w.name });
  return { ok: true };
});

on('PATCH', '/api/admin/workspaces/:id/members/:uid', async ({ req, m, ctx }) => {
  needPlatform(ctx);
  const w = await getWorkspace(uuid(m[1]));
  const user = await getUser(uuid(m[2]));
  const role = (await body(req)).role;
  if (role !== 'owner' && role !== 'admin' && role !== 'member') throw new HttpError(400, 'Choose owner, admin or member.');
  const current = await one<{ role: string }>(`SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2`, [w.id, user.id]);
  if (!current) throw new HttpError(404, 'That user is not a member of this workspace.');
  if (current.role === 'owner' && role !== 'owner') {
    const owners = Number((await one<{ n: string }>(`SELECT count(*) n FROM memberships WHERE workspace_id = $1 AND role = 'owner'`, [w.id]))?.n ?? 0);
    if (owners < 2) throw new HttpError(400, 'A workspace needs at least one owner. Make someone else the owner first.');
  }
  await q(`UPDATE memberships SET role = $3 WHERE workspace_id = $1 AND user_id = $2`, [w.id, user.id, role]);
  await audit(ctx, 'member.role', { workspaceId: w.id, target: user.email, detail: { from: current.role, to: role } });
  return { ok: true };
});

on('DELETE', '/api/admin/workspaces/:id', async ({ req, m, ctx }) => {
  needPlatform(ctx);
  const w = await getWorkspace(uuid(m[1]));
  if (!w.suspended_at) throw new HttpError(409, 'Suspend the workspace first. Only a suspended workspace can be deleted.');
  if (str((await body(req)).confirm, 80) !== w.name) throw new HttpError(400, 'Type the exact workspace name to confirm.');
  await audit(ctx, 'workspace.delete', { workspaceId: w.id, target: w.name, detail: { balance: await balanceOf(w.id) } });
  await q(`DELETE FROM workspaces WHERE id = $1`, [w.id]); // every workspace table references it ON DELETE CASCADE
  return { ok: true };
});

// ------------------------------------------------------------------ users
on('GET', '/api/admin/users', async ({ p, ctx }) => {
  needPlatform(ctx);
  const term = str(p.get('q'), 100);
  return q(`SELECT u.id, u.name, u.email, u.created_at, u.last_login_at, u.disabled_at, u.is_platform_admin,
      (SELECT count(*) FROM memberships m WHERE m.user_id = u.id)::int AS workspaces
    FROM users u WHERE $1 = '' OR u.email ILIKE $2 OR u.name ILIKE $2 ORDER BY u.created_at DESC LIMIT 200`, [term, like(term)]);
});

on('GET', '/api/admin/users/:id', async ({ m, ctx }) => {
  needPlatform(ctx);
  const u = await getUser(uuid(m[1]));
  const [workspaces, sessions] = await Promise.all([
    q(`SELECT w.id, w.name, ms.role, w.suspended_at FROM memberships ms JOIN workspaces w ON w.id = ms.workspace_id WHERE ms.user_id = $1 ORDER BY w.created_at`, [u.id]),
    one<{ n: number }>(`SELECT count(*)::int n FROM sessions WHERE user_id = $1 AND expires_at > now()`, [u.id]),
  ]);
  return { ...u, workspaces, sessions: sessions?.n ?? 0 };
});

on('POST', '/api/admin/users/:id/disable', async ({ m, ctx }) => {
  needPlatform(ctx);
  const u = await getUser(uuid(m[1]));
  if (u.id === ctx.userId) throw new HttpError(400, 'You cannot disable your own account.');
  if (u.is_platform_admin) throw new HttpError(400, 'Platform admins cannot be disabled here. Remove the email from PLATFORM_ADMIN_EMAILS first.');
  await q(`UPDATE users SET disabled_at = COALESCE(disabled_at, now()) WHERE id = $1`, [u.id]);
  await q(`DELETE FROM sessions WHERE user_id = $1`, [u.id]);
  await audit(ctx, 'user.disable', { target: u.email });
  return { ok: true };
});
on('POST', '/api/admin/users/:id/enable', async ({ m, ctx }) => {
  needPlatform(ctx);
  const u = await getUser(uuid(m[1]));
  await q(`UPDATE users SET disabled_at = NULL WHERE id = $1`, [u.id]);
  await audit(ctx, 'user.enable', { target: u.email });
  return { ok: true };
});
on('POST', '/api/admin/users/:id/signout', async ({ m, ctx }) => {
  needPlatform(ctx);
  const u = await getUser(uuid(m[1]));
  const n = (await q(`DELETE FROM sessions WHERE user_id = $1 RETURNING 1`, [u.id])).length;
  await audit(ctx, 'user.signout', { target: u.email, detail: { sessions: n } });
  return { ok: true, sessions: n };
});

// ------------------------------------------------------------------ credits, payments, audit
on('GET', '/api/admin/credits', async ({ p, ctx }) => {
  needPlatform(ctx);
  const ws = p.get('workspace');
  return q(`SELECT l.id, l.delta, l.reason, l.created_at, w.id AS workspace_id, w.name AS workspace, u.name AS by
    FROM credit_ledger l JOIN workspaces w ON w.id = l.workspace_id LEFT JOIN users u ON u.id = l.user_id
    WHERE $1::uuid IS NULL OR l.workspace_id = $1::uuid ORDER BY l.id DESC LIMIT 200`, [ws ? uuid(ws) : null]);
});
on('GET', '/api/admin/payments', async ({ p, ctx }) => {
  needPlatform(ctx);
  const ws = p.get('workspace');
  return q(`SELECT p.tran_id, p.pack, p.amount_bdt::float AS amount_bdt, p.credits, p.status, p.provider, p.created_at, p.paid_at, w.id AS workspace_id, w.name AS workspace
    FROM payments p JOIN workspaces w ON w.id = p.workspace_id WHERE $1::uuid IS NULL OR p.workspace_id = $1::uuid ORDER BY p.created_at DESC LIMIT 200`, [ws ? uuid(ws) : null]);
});
on('GET', '/api/admin/audit', async ({ ctx }) => {
  needPlatform(ctx);
  return q(`SELECT a.id, a.admin_email, a.action, a.workspace_id, a.target, a.detail, a.created_at FROM platform_audit a ORDER BY a.id DESC LIMIT 200`);
});
