/**
 * Outgoing email. With SMTP_URL (any provider: Amazon SES SMTP, Brevo, Mailgun, Postmark...) mail is really sent;
 * without it (and outside production) every message is CAPTURED in email_log instead, so flows can be tested locally.
 * Every message is logged either way. Env: SMTP_URL=smtps://user:pass@host:465, MAIL_FROM="BizMap <no-reply@yourdomain>".
 */
import nodemailer from 'nodemailer';
import { q } from './db.js';

// Either one SMTP_URL, or the simpler separate settings SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS (no URL-encoding needed).
const separate = process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS
  ? { host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT ?? 587), secure: Number(process.env.SMTP_PORT ?? 587) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } }
  : null;
export const MAIL_MODE: 'smtp' | 'test' | 'disabled' = separate || process.env.SMTP_URL ? 'smtp' : process.env.NODE_ENV === 'production' ? 'disabled' : 'test';
const transport = separate ? nodemailer.createTransport(separate) : process.env.SMTP_URL ? nodemailer.createTransport(process.env.SMTP_URL) : null;
export const DEFAULT_FROM = process.env.MAIL_FROM ?? 'BizMap <no-reply@bizmap.local>';

export interface Mail {
  workspaceId: string | null; kind: string; to: string; subject: string; text: string; html?: string;
  from?: string; replyTo?: string; headers?: Record<string, string>;
}

/** Sends (or captures) one email. Returns the provider message id, or throws with the provider's reason. */
export async function sendMail(m: Mail): Promise<{ id: string | null; mode: typeof MAIL_MODE }> {
  if (MAIL_MODE === 'disabled') throw new Error('Email sending is not configured on this server (SMTP_URL).');
  if (MAIL_MODE === 'test') {
    await q(`INSERT INTO email_log (workspace_id, kind, to_addr, subject, body_text, mode, status) VALUES ($1, $2, $3, $4, $5, 'test', 'captured')`,
      [m.workspaceId, m.kind, m.to, m.subject, m.text]);
    return { id: null, mode: MAIL_MODE };
  }
  try {
    const info = await transport!.sendMail({ from: m.from ?? DEFAULT_FROM, to: m.to, replyTo: m.replyTo, subject: m.subject, text: m.text, html: m.html, headers: m.headers });
    // "sent" here only means the SMTP server accepted the message; a recipient it refused is a failure
    if (info.rejected?.length) throw new Error(`Recipient refused by the mail server: ${String(info.response ?? '').slice(0, 200)}`);
    await q(`INSERT INTO email_log (workspace_id, kind, to_addr, subject, body_text, mode, status, provider_id) VALUES ($1, $2, $3, $4, $5, 'smtp', 'sent', $6)`,
      [m.workspaceId, m.kind, m.to, m.subject, m.text, info.messageId ?? null]);
    return { id: info.messageId ?? null, mode: MAIL_MODE };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await q(`INSERT INTO email_log (workspace_id, kind, to_addr, subject, body_text, mode, status, error) VALUES ($1, $2, $3, $4, $5, 'smtp', 'failed', $6)`,
      [m.workspaceId, m.kind, m.to, m.subject, m.text, msg.slice(0, 500)]);
    throw new Error(msg);
  }
}
