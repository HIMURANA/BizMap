/**
 * Credit packs paid through SSLCommerz (one gateway for cards, bKash, Nagad, Rocket and internet banking).
 *
 * Flow: checkout -> payments row 'pending' -> SSLCommerz session -> customer pays on the gateway -> gateway POSTs to our
 * success / fail / cancel URLs (and IPN) -> we NEVER trust that POST: we call the SSLCommerz validation API with our own
 * credentials, check tran_id, amount and currency, then credit the workspace exactly once.
 *
 * Without SSLC_STORE_ID (and outside production) a clearly labelled TEST gateway page is used instead, so the whole
 * flow can be exercised locally. Env: SSLC_STORE_ID, SSLC_STORE_PASSWORD, SSLC_LIVE=1 for real money, APP_URL.
 */
import { randomBytes } from 'node:crypto';
import { one, q, tx } from './db.js';

export interface Pack { id: string; label: string; credits: number; bdt: number }
// Placeholder prices: set real ones with BILLING_PACKS='[{"id":"starter","label":"Starter","credits":1000,"bdt":1000},...]'
const DEFAULT_PACKS: Pack[] = [
  { id: 'starter', label: 'Starter', credits: 1000, bdt: 1000 },
  { id: 'growth', label: 'Growth', credits: 5000, bdt: 4000 },
  { id: 'pro', label: 'Pro', credits: 20000, bdt: 12000 },
];
export const PACKS: Pack[] = (() => {
  try { return process.env.BILLING_PACKS ? (JSON.parse(process.env.BILLING_PACKS) as Pack[]) : DEFAULT_PACKS; } catch { return DEFAULT_PACKS; }
})();

const LIVE = process.env.SSLC_LIVE === '1';
const BASE = LIVE ? 'https://securepay.sslcommerz.com' : 'https://sandbox.sslcommerz.com';
export const MODE: 'live' | 'sandbox' | 'test' | 'disabled' =
  process.env.SSLC_STORE_ID ? (LIVE ? 'live' : 'sandbox') : process.env.NODE_ENV === 'production' ? 'disabled' : 'test';

export function appUrl(host: string | undefined): string {
  return (process.env.APP_URL ?? `http://${host ?? 'localhost:8787'}`).replace(/\/$/, '');
}

export async function startCheckout(o: { workspaceId: string; userId: string; email: string; name: string; phone: string; pack: Pack; origin: string }) {
  if (MODE === 'disabled') throw new Error('Payments are not configured on this server.');
  const tranId = `BM${Date.now().toString(36)}${randomBytes(5).toString('hex')}`.toUpperCase();
  await q(`INSERT INTO payments (workspace_id, user_id, tran_id, provider, pack, amount_bdt, credits) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [o.workspaceId, o.userId, tranId, MODE === 'test' ? 'test' : 'sslcommerz', o.pack.id, o.pack.bdt, o.pack.credits]);
  if (MODE === 'test') return { redirect: `/api/billing/test-gateway/${tranId}` };

  const cb = `${o.origin}/api/billing/sslcommerz`;
  const form = new URLSearchParams({
    store_id: process.env.SSLC_STORE_ID!, store_passwd: process.env.SSLC_STORE_PASSWORD ?? '',
    total_amount: o.pack.bdt.toFixed(2), currency: 'BDT', tran_id: tranId,
    success_url: `${cb}/success`, fail_url: `${cb}/fail`, cancel_url: `${cb}/cancel`,
    cus_name: o.name, cus_email: o.email, cus_phone: o.phone, cus_add1: 'N/A', cus_city: 'N/A', cus_country: 'Bangladesh',
    shipping_method: 'NO', product_name: `BizMap ${o.pack.label} credits (${o.pack.credits})`, product_category: 'Data service',
    product_profile: 'non-physical-goods', value_a: o.workspaceId,
  });
  // IPN needs a public URL; only send it when APP_URL is set and not localhost
  if (process.env.APP_URL && !/localhost|127\.0\.0\.1/.test(process.env.APP_URL)) form.set('ipn_url', `${cb}/ipn`);
  const res = await fetch(`${BASE}/gwprocess/v4/api.php`, { method: 'POST', body: form });
  const body = (await res.json().catch(() => ({}))) as { status?: string; GatewayPageURL?: string; failedreason?: string };
  if (body.status !== 'SUCCESS' || !body.GatewayPageURL) {
    await q(`UPDATE payments SET status = 'failed', raw = $2 WHERE tran_id = $1`, [tranId, JSON.stringify(body)]);
    throw new Error(`Payment gateway refused the session: ${body.failedreason ?? res.status}`);
  }
  return { redirect: body.GatewayPageURL };
}

/** Confirms a payment with SSLCommerz (or the local test gateway) and credits the workspace once. */
export async function confirmPayment(tranId: string, valId: string): Promise<'paid' | 'already' | 'invalid'> {
  const pay = await one<{ id: string; workspace_id: string; user_id: string; amount_bdt: string; credits: number; status: string; provider: string; pack: string }>(
    `SELECT * FROM payments WHERE tran_id = $1`, [tranId]);
  if (!pay) return 'invalid';
  if (pay.status === 'paid') return 'already';

  let raw: Record<string, unknown>;
  if (pay.provider === 'test') {
    if (MODE !== 'test' || valId !== `TEST-${tranId}`) return 'invalid';
    raw = { status: 'VALID', test: true };
  } else {
    const url = `${BASE}/validator/api/validationserverAPI.php?${new URLSearchParams({ val_id: valId, store_id: process.env.SSLC_STORE_ID ?? '', store_passwd: process.env.SSLC_STORE_PASSWORD ?? '', v: '1', format: 'json' })}`;
    raw = (await (await fetch(url)).json().catch(() => ({}))) as Record<string, unknown>;
    const ok = (raw.status === 'VALID' || raw.status === 'VALIDATED') && raw.tran_id === tranId
      && Math.abs(Number(raw.amount) - Number(pay.amount_bdt)) < 0.01 && (raw.currency ?? raw.currency_type) === 'BDT';
    if (!ok) { await q(`UPDATE payments SET raw = $2 WHERE tran_id = $1`, [tranId, JSON.stringify(raw)]); return 'invalid'; }
  }
  return tx(async (c) => {
    // the status guard makes this idempotent even if success and IPN arrive together
    const upd = await c.query(`UPDATE payments SET status = 'paid', paid_at = now(), val_id = $2, card_type = $3, raw = $4 WHERE tran_id = $1 AND status = 'pending' RETURNING id`,
      [tranId, valId, (raw.card_type as string | undefined) ?? null, JSON.stringify(raw)]);
    if (!upd.rowCount) return 'already' as const;
    await c.query(`INSERT INTO credit_ledger (workspace_id, delta, reason, ref, user_id) VALUES ($1, $2, $3, $4, $5)`,
      [pay.workspace_id, pay.credits, `purchase: ${pay.pack}`, tranId, pay.user_id]);
    return 'paid' as const;
  });
}

export async function markPayment(tranId: string, status: 'failed' | 'cancelled') {
  await q(`UPDATE payments SET status = $2 WHERE tran_id = $1 AND status = 'pending'`, [tranId, status]);
}

/** The local TEST gateway page (never available in production or when SSLCommerz is configured). */
export function testGatewayHtml(tranId: string, amount: string, credits: number): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  const btn = (path: string, label: string, color: string) =>
    `<form method="post" action="/api/billing/sslcommerz/${path}"><input type="hidden" name="tran_id" value="${esc(tranId)}"><input type="hidden" name="val_id" value="TEST-${esc(tranId)}">
     <button style="width:100%;padding:12px;border:0;border-radius:10px;background:${color};color:#fff;font:600 15px system-ui;cursor:pointer">${label}</button></form>`;
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Test payment</title>
  <body style="margin:0;background:#f1f5f9;font:15px system-ui;display:grid;place-items:center;min-height:100vh">
  <div style="background:#fff;padding:28px;border-radius:16px;max-width:360px;width:90%;box-shadow:0 10px 30px #0001">
  <div style="background:#fef3c7;color:#92400e;padding:8px 12px;border-radius:8px;font-size:13px;margin-bottom:16px">TEST GATEWAY: no real money. Add SSLC_STORE_ID to use SSLCommerz.</div>
  <h1 style="font-size:20px;margin:0 0 4px">Pay ৳${esc(amount)}</h1><p style="color:#64748b;margin:0 0 20px">${credits.toLocaleString()} credits · ${esc(tranId)}</p>
  <div style="display:grid;gap:10px">${btn('success', 'Simulate successful payment', '#16a34a')}${btn('fail', 'Simulate failed payment', '#dc2626')}${btn('cancel', 'Cancel', '#64748b')}</div></div></body>`;
}
