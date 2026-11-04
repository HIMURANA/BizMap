/** API client for Phase 3–5: campaigns, sending settings, suppressions, call queues, WhatsApp inbox and opt-ins, alerts. */
import { req, send } from './api';
import type { Contact } from './contacts';

export type CampaignChannel = 'email' | 'whatsapp' | 'voice';
/** Free mailboxes publish strict anti-spoofing rules (DMARC): mail "from" them sent through Brevo/SES/etc. is rejected or lands in spam. */
const FREE_MAIL = /@(gmail|googlemail|yahoo|ymail|outlook|hotmail|live|msn|icloud|me|aol|proton|protonmail|gmx|yandex|zoho|mail)\.[a-z.]+$/i;
export const isFreeMailbox = (email: string | null | undefined) => !!email && FREE_MAIL.test(email.trim());
export const FREE_MAIL_WARNING = 'Emails "from" a free mailbox (Gmail, Yahoo, Outlook…) sent through an email service are usually blocked or put in spam, even when the app shows them as sent. Use an address on your own domain (e.g. sales@yourcompany.com) and verify that domain in your email provider (e.g. Brevo → Senders, Domains → add domain → SPF/DKIM).';
export interface VoiceMeta { mode: 'live' | 'test'; tts: 'azure' | 'twilio_say'; voices: { id: string; label: string }[]; credits_per_call: number; intro: string; outro: string }
export interface VoiceClip { id: string; name: string; seconds: number; created_at: string; created_by?: string | null }
export type CampaignStatus = 'draft' | 'scheduled' | 'sending' | 'paused' | 'sent' | 'cancelled';
export interface Campaign {
  id: string; channel: CampaignChannel; name: string; status: CampaignStatus; voice_name?: string | null; voice_clip?: string | null; voice_clip_name?: string | null;
  audience_list: string | null; audience_query: string | null; list_name: string | null;
  contacts_n?: number; audience_contacts?: { [K in keyof Contact]: string | null }[];
  subject: string | null; body: string | null; wa_template: string | null; wa_language: string | null; wa_params: string[] | null; wa_header?: WaHeader | null;
  send_at: string | null; created_at: string; launched_at: string | null; finished_at: string | null;
  recipients: number; credits: number; created_by_name: string | null; sent?: number;
  stats?: Record<string, number>; recipients_sample?: { biz_id: string; address: string; name: string; status: string; reason: string | null; sent_at: string | null }[];
}
export interface Preview {
  eligible: number; excluded: { no_address: number; suppressed: number; no_consent: number; duplicate: number };
  credits: number; balance: number; sample: { subject?: string; text: string } | null;
}
export type WaMediaFormat = 'IMAGE' | 'VIDEO' | 'DOCUMENT';
export interface WaHeader { format: WaMediaFormat; url: string }
export interface WaTemplate { name: string; language: string; category: string; body: string; params: number; header_format: WaMediaFormat | null; unsupported: string | null }
/** A template of the WhatsApp account with its Meta review status (APPROVED, PENDING, REJECTED, PAUSED…). */
export interface WaTemplateRow {
  id: string; name: string; language: string; category: string; status: string; rejected_reason: string | null;
  body: string; header_format: string | null; footer: string | null; buttons: { type: string; text: string }[];
}
export type WaButton = { type: 'QUICK_REPLY'; text: string } | { type: 'URL'; text: string; url: string } | { type: 'PHONE_NUMBER'; text: string; phone_number: string };
export interface WaTemplateDraft {
  name: string; language: string; category: 'MARKETING' | 'UTILITY';
  header: { format: 'NONE' } | { format: 'TEXT'; text: string } | { format: 'IMAGE'; url: string };
  body: string; examples: string[]; footer: string; buttons: WaButton[];
}
export interface SendingSettings {
  sender_name: string | null; sender_email: string | null; reply_to: string | null; postal_address: string | null;
  daily_email_cap: number; call_hours_start: number; call_hours_end: number; mail_mode: 'smtp' | 'test' | 'disabled';
  whatsapp: { mode: 'live' | 'test' | 'disabled'; phone_number_id: string | null; waba_id: string | null; verify_token: string | null; webhook_url: string; has_token: boolean; has_app_secret: boolean };
}
export interface Suppression { value: string; channel: string; reason: string | null; created_at: string }
export interface OutboxMail { id: number; kind: string; to_addr: string; subject: string; body_text: string; mode: string; status: string; error: string | null; created_at: string }

export interface CallQueue { id: string; name: string; created_at: string; created_by: string | null; total: number; pending: number; callbacks: number; done: number; interested: number }
export interface CallQueueDetail {
  id: string; name: string; script: string | null; created_at: string;
  outcomes: { k: string; n: number }[];
  recent: { id: number; biz_id: string; name: string; phone: string; status: string; outcome: string | null; notes: string | null; callback_at: string | null; attempts: number; called_at: string; called_by: string | null }[];
  hours: { start: number; end: number; now: number; open: boolean };
}
export interface NextCall {
  item: null | { id: number; biz_id: string; phone: string; name: string; status: string; attempts: number; notes: string | null; callback_at: string | null };
  outside_hours?: boolean; done?: boolean; hours?: { start: number; end: number; now: number };
  biz?: { id: string; name: string; cat_label: string; area: string | null; upazila: string | null; district: string | null; phone: string; phone_status: string | null; email: string | null; website: string | null; facebook: string | null; lat: number | null; lon: number | null;
    own?: boolean; note?: string | null }; // own = the workspace's own contact, not a directory business
  history?: { outcome: string; notes: string | null; called_at: string; queue: string }[];
  script?: string | null;
}

export interface Conversation {
  id: string; address: string; contact_name: string | null; biz_id: string | null; biz_name: string | null; status: 'open' | 'closed';
  unread: number; last_message_at: string; last_inbound_at: string | null; assigned_name: string | null; preview: string | null; opted_in: boolean;
}
export interface Thread {
  id: string; address: string; contact_name: string | null; biz_id: string | null; status: 'open' | 'closed';
  messages: { id: number; direction: 'in' | 'out'; body: string; template: string | null; status: string | null; error: string | null; created_at: string; sent_by: string | null }[];
  consent: { method: string; proof: string; created_at: string } | null;
  biz: { id: string; name: string; cat: string; area: string | null; district: string | null } | null;
  window_open: boolean; window_closes_at: string | null; mode: 'live' | 'test' | 'disabled';
}
export interface Consent { id: number; channel: string; address: string; biz_id: string | null; biz_name: string | null; method: string; proof: string; created_at: string; revoked_at: string | null; revoked_reason: string | null; recorded_by: string | null }

export interface Alert {
  id: string; name: string; query: string; frequency: 'daily' | 'weekly' | 'monthly'; email: boolean; active: boolean;
  last_run_at: string | null; created_at: string; owner: string | null; unseen: number;
  last_run: { run_at: string; new_count: number; seen: boolean } | null;
}
export interface AlertRun { id: number; run_at: string; since: string; new_count: number; sample: { id: string; name: string; district: string | null; area: string | null; cat: string }[]; seen: boolean }

export const out = {
  sending: () => req<SendingSettings>('/settings/sending'),
  saveSending: (b: Partial<SendingSettings>) => send('/settings/sending', 'PUT', b),
  connectWhatsapp: (b: { phone_number_id: string; waba_id: string; access_token?: string; app_secret?: string }) => send('/settings/whatsapp', 'PUT', b),
  disconnectWhatsapp: () => send('/settings/whatsapp', 'DELETE', {}),
  suppressions: (q = '') => req<Suppression[]>(`/suppressions?q=${encodeURIComponent(q)}`),
  addSuppressions: (values: string[], channel: string, reason?: string) => send<{ added: number }>('/suppressions', 'POST', { values, channel, reason }),
  removeSuppression: (value: string) => send('/suppressions', 'DELETE', { value }),
  outbox: () => req<OutboxMail[]>('/outbox'),

  campaigns: () => req<Campaign[]>('/campaigns'),
  campaign: (id: string) => req<Campaign>(`/campaigns/${id}`),
  campaignMeta: () => req<{ merge_fields: string[]; mail_mode: string; wa_mode: string; can_launch: boolean; voice: VoiceMeta }>('/campaigns/meta/fields'),
  voicePreview: (text: string, voice: string) => send<{ audio: string | null; tts: string }>('/voice/preview', 'POST', { text, voice }),
  voiceClips: () => req<VoiceClip[]>('/voice/clips'),
  uploadClip: (name: string, wav: string) => send<VoiceClip & { audio: string }>('/voice/clips', 'POST', { name, wav }),
  deleteClip: (id: string) => send(`/voice/clips/${id}`, 'DELETE', {}),
  testCall: (id: string, phone: string) => send<{ to: string }>(`/campaigns/${id}/test`, 'POST', { phone }),
  createCampaign: (b: Partial<Omit<Campaign, 'audience_contacts'>> & { audience_contacts?: Contact[] }) => send<{ id: string }>('/campaigns', 'POST', b),
  updateCampaign: (id: string, b: Partial<Omit<Campaign, 'audience_contacts'>> & { audience_contacts?: Contact[] }) => send(`/campaigns/${id}`, 'PATCH', b),
  deleteCampaign: (id: string) => send(`/campaigns/${id}`, 'DELETE', {}),
  preview: (id: string) => send<Preview>(`/campaigns/${id}/preview`, 'POST', {}),
  testSend: (id: string) => send<{ to: string; mode: string }>(`/campaigns/${id}/test`, 'POST', {}),
  launch: (id: string, send_at?: string) => send<{ recipients: number }>(`/campaigns/${id}/launch`, 'POST', { send_at }),
  campaignAction: (id: string, action: 'pause' | 'resume' | 'cancel') => send(`/campaigns/${id}/${action}`, 'POST', {}),
  templates: () => req<{ mode: string; templates: WaTemplate[] }>('/whatsapp/templates'),
  allTemplates: () => req<{ mode: string; templates: WaTemplateRow[] }>('/whatsapp/templates/all'),
  createTemplate: (b: WaTemplateDraft) => send<{ id: string | null; status: string }>('/whatsapp/templates', 'POST', b),
  deleteTemplate: (name: string) => send(`/whatsapp/templates/${encodeURIComponent(name)}`, 'DELETE', {}),

  queues: () => req<CallQueue[]>('/calls/queues'),
  queue: (id: string) => req<CallQueueDetail>(`/calls/queues/${id}`),
  createQueue: (b: { name: string; list_id?: string; query?: string; script?: string; contacts?: Contact[] }) => send<{ id: string; items: number; skipped: number }>('/calls/queues', 'POST', b),
  deleteQueue: (id: string) => send(`/calls/queues/${id}`, 'DELETE', {}),
  nextCall: (id: string) => send<NextCall>(`/calls/queues/${id}/next`, 'POST', {}),
  outcome: (itemId: number, b: { outcome: string; notes?: string; callback_at?: string; whatsapp_opt_in?: boolean }) => send<{ status: string }>(`/calls/items/${itemId}/outcome`, 'POST', b),
  skipCall: (itemId: number) => send(`/calls/items/${itemId}/skip`, 'POST', {}),

  inbox: (status: 'open' | 'closed') => req<Conversation[]>(`/inbox?status=${status}`),
  inboxUnread: () => req<{ n: number }>('/inbox/unread'),
  thread: (id: string) => req<Thread>(`/inbox/${id}`),
  reply: (id: string, text: string) => send(`/inbox/${id}/reply`, 'POST', { text }),
  sendTemplate: (id: string, template: string, language: string, params: string[]) => send(`/inbox/${id}/template`, 'POST', { template, language, params }),
  setConversation: (id: string, b: { status?: 'open' | 'closed'; assigned_to?: string | null }) => send(`/inbox/${id}/status`, 'POST', b),
  startConversation: (phone: string, name?: string) => send<{ id: string }>('/inbox/start', 'POST', { phone, name }),
  simulate: (phone: string, text: string, name?: string) => send('/inbox/simulate', 'POST', { phone, text, name }),
  consents: (q = '') => req<Consent[]>(`/consents?q=${encodeURIComponent(q)}`),
  addConsent: (b: { address: string; method: string; proof: string }) => send<{ address: string }>('/consents', 'POST', b),
  revokeConsent: (id: number) => send(`/consents/${id}/revoke`, 'POST', {}),

  alerts: () => req<Alert[]>('/alerts'),
  alertsUnseen: () => req<{ n: number }>('/alerts/unseen'),
  createAlert: (b: { name: string; query: string; frequency: string; email: boolean }) => send<{ id: string }>('/alerts', 'POST', b),
  updateAlert: (id: string, b: Partial<Pick<Alert, 'name' | 'frequency' | 'email' | 'active'>>) => send(`/alerts/${id}`, 'PATCH', b),
  deleteAlert: (id: string) => send(`/alerts/${id}`, 'DELETE', {}),
  runAlert: (id: string) => send<{ new_count: number }>(`/alerts/${id}/run`, 'POST', {}),
  alertRuns: (id: string) => req<AlertRun[]>(`/alerts/${id}/runs`),
};

export const OUTCOME_LABEL: Record<string, string> = {
  interested: 'Interested', callback: 'Call back', not_interested: 'Not interested', no_answer: 'No answer', wrong_number: 'Wrong number',
  closed: 'Business closed', not_a_business: 'Not a business', do_not_call: 'Do not call', pending: 'Not called yet', skipped: 'Skipped',
};
export const STATUS_TONE: Record<string, 'slate' | 'green' | 'amber' | 'rose' | 'blue' | 'violet'> = {
  draft: 'slate', scheduled: 'blue', sending: 'violet', paused: 'amber', sent: 'green', cancelled: 'rose',
  queued: 'slate', delivered: 'green', read: 'green', replied: 'violet', failed: 'rose', skipped: 'amber', unsubscribed: 'amber',
};
