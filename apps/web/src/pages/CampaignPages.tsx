import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail, MessageCircle, Plus, Send, Eye, Rocket, Pause, Play, XCircle, Trash2, AlertTriangle, Inbox as InboxIcon, ArrowLeft, ShieldCheck, UserPlus, PhoneCall, Volume2, Mic, Upload } from 'lucide-react';
import { MAX_SECONDS, startRecording, toPhoneWav } from '../lib/voice';
import { api } from '../lib/api';
import { FREE_MAIL_WARNING, isFreeMailbox, out, STATUS_TONE, type Campaign, type CampaignChannel, type Preview } from '../lib/outreach';
import { empty, reachable, type Channel, type Contact } from '../lib/contacts';
import { Link, navigate, useLocation } from '../lib/router';
import { ContactImport } from '../components/ContactImport';
import { Badge, Button, Empty, Modal, Spinner, cx } from '../components/ui';
import { confirmAction } from '../components/feedback';

const card = 'rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900';
const input = 'h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-900';
const fmt = (d: string | null) => (d ? new Date(d).toLocaleString() : '—');

export function Page({ title, subtitle, actions, children, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; back?: string }) {
  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
        {back && <Link to={back} className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"><ArrowLeft className="size-4" />Back</Link>}
        <div className="mb-5 flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1"><h1 className="text-xl font-semibold">{title}</h1>{subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}</div>
          {actions}
        </div>
        {children}
      </div>
    </div>
  );
}

export function WarnBanner({ children }: { children: ReactNode }) {
  return <div className="mb-4 flex gap-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200"><AlertTriangle className="mt-0.5 size-4 shrink-0" /><span>{children}</span></div>;
}

export function TestModeBanner({ what }: { what: string }) {
  return (
    <div className="mb-4 flex gap-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" /><span><b>Test mode:</b> {what}</span>
    </div>
  );
}

const ChannelIcon = ({ c, className }: { c: string; className?: string }) => (c === 'whatsapp' ? <MessageCircle className={cx('size-4 text-emerald-600', className)} />
  : c === 'voice' ? <PhoneCall className={cx('size-4 text-violet-600', className)} /> : <Mail className={cx('size-4 text-brand-600', className)} />);
/** Contact-import channel: voice calls take any Bangladeshi phone number. */
const importChannel = (c: CampaignChannel): Channel => (c === 'voice' ? 'phone' : c);
const VOICE_SAMPLE = 'আমরা {{area}} এলাকার ব্যবসার জন্য একটি বিশেষ অফার নিয়ে এসেছি। এই মাসে অর্ডার করলে পাচ্ছেন দশ শতাংশ ছাড়।';

// ------------------------------------------------------------------ list
export function CampaignsPage() {
  const { search } = useLocation();
  const tab = new URLSearchParams(search).get('tab') === 'outbox' ? 'outbox' : 'campaigns';
  const { data, isLoading } = useQuery({ queryKey: ['campaigns'], queryFn: out.campaigns, refetchInterval: 10_000 });
  const meta = useQuery({ queryKey: ['campaign-meta'], queryFn: out.campaignMeta });
  return (
    <Page title="Campaigns" subtitle="Email, WhatsApp and automated voice-call campaigns to your lists, saved views and contacts."
      actions={<div className="flex flex-wrap gap-2"><Button onClick={() => navigate('/campaigns/new?channel=voice')}><PhoneCall className="size-4" />Auto call</Button><Button onClick={() => navigate('/campaigns/new?channel=whatsapp')}><MessageCircle className="size-4" />WhatsApp</Button><Button variant="primary" onClick={() => navigate('/campaigns/new?channel=email')}><Plus className="size-4" />Email campaign</Button></div>}>
      {meta.data?.mail_mode === 'test' && <TestModeBanner what="emails are captured in the Outbox instead of being sent. Add SMTP_URL to .env to send for real." />}
      <div className="mb-4 flex gap-1 border-b border-slate-200 dark:border-slate-800">
        {[['campaigns', 'Campaigns'], ['outbox', 'Outbox']].map(([k, l]) => (
          <Link key={k} to={k === 'campaigns' ? '/campaigns' : '/campaigns?tab=outbox'} className={cx('-mb-px border-b-2 px-3 py-2 text-sm font-medium', tab === k ? 'border-brand-600 text-brand-700 dark:text-brand-100' : 'border-transparent text-slate-500')}>{l}</Link>
        ))}
      </div>
      {tab === 'outbox' ? <Outbox /> : (
        <>
          {isLoading && <Spinner />}
          {data?.length === 0 && <div className={card}><Empty icon={<Send className="size-10" />} title="No campaigns yet">Build a list in Explore, then start an email or WhatsApp campaign for it.</Empty></div>}
          {!!data?.length && (
            <div className={cx(card, 'overflow-hidden')}>
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs text-slate-500 dark:bg-slate-800/50"><tr><th className="px-4 py-2.5 font-medium">Campaign</th><th className="font-medium">Status</th><th className="hidden font-medium sm:table-cell">Audience</th><th className="text-right font-medium">Sent</th><th className="hidden px-4 text-right font-medium md:table-cell">Created</th></tr></thead>
                <tbody>{data.map((c) => (
                  <tr key={c.id} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/40" onClick={() => navigate(`/campaigns/${c.id}`)}>
                    <td className="px-4 py-3"><div className="flex items-center gap-2 font-medium"><ChannelIcon c={c.channel} />{c.name}</div></td>
                    <td><Badge tone={STATUS_TONE[c.status]}>{c.status}</Badge></td>
                    <td className="hidden max-w-48 truncate text-slate-500 sm:table-cell">{audienceLabel(c)}</td>
                    <td className="text-right tabular-nums">{c.status === 'draft' ? '—' : `${(c.sent ?? 0).toLocaleString()} / ${c.recipients.toLocaleString()}`}</td>
                    <td className="hidden px-4 text-right text-slate-500 md:table-cell">{new Date(c.created_at).toLocaleDateString()}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Page>
  );
}

function Outbox() {
  const { data, isLoading } = useQuery({ queryKey: ['outbox'], queryFn: out.outbox, refetchInterval: 10_000 });
  const [open, setOpen] = useState<number | null>(null);
  if (isLoading) return <Spinner />;
  if (!data?.length) return <div className={card}><Empty icon={<InboxIcon className="size-10" />} title="Outbox is empty">Test sends, campaign emails and alert digests appear here.</Empty></div>;
  return (
    <div className={cx(card, 'divide-y divide-slate-100 dark:divide-slate-800')}>
      {data.map((m) => (
        <div key={m.id} className="px-4 py-3 text-sm">
          <button className="flex w-full items-center gap-3 text-left" onClick={() => setOpen(open === m.id ? null : m.id)}>
            <Badge tone={m.status === 'failed' ? 'rose' : m.mode === 'test' ? 'amber' : 'green'} title={m.status === 'sent' ? "Your email provider accepted it. Whether it reached the inbox is shown in the provider's logs (e.g. Brevo → Transactional → Logs)." : undefined}>{m.mode === 'test' ? 'captured' : m.status === 'sent' ? 'accepted' : m.status}</Badge>
            <span className="w-16 shrink-0 text-xs text-slate-400">{m.kind}</span>
            <span className="min-w-0 flex-1 truncate"><b>{m.subject}</b> <span className="text-slate-500">→ {m.to_addr}</span></span>
            <span className="hidden text-xs text-slate-400 sm:inline">{new Date(m.created_at).toLocaleString()}</span>
          </button>
          {open === m.id && <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-slate-50 p-3 font-sans text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-200">{m.body_text}{m.error ? `\n\nError: ${m.error}` : ''}</pre>}
        </div>
      ))}
    </div>
  );
}

const audienceLabel = (c: Campaign) => {
  const base = c.list_name ? `List: ${c.list_name}` : c.audience_query !== null ? 'Filter' : '';
  const extra = c.contacts_n ? `${c.contacts_n.toLocaleString()} added by hand` : '';
  return [base, extra].filter(Boolean).join(' + ') || '—';
};

// ------------------------------------------------------------------ editor (new + draft)
type Draft = { channel: CampaignChannel; voice_name: string; voice_clip: string; name: string; audience: string; subject: string; body: string; wa_template: string; wa_language: string; wa_params: string[]; contacts: Contact[] };
const fromCampaign = (c: Campaign): Draft => ({
  channel: c.channel, voice_name: c.voice_name ?? '', voice_clip: c.voice_clip ?? '', name: c.name, audience: c.audience_list ? `list:${c.audience_list}` : c.audience_query !== null ? `query:${c.audience_query}` : '',
  subject: c.subject ?? '', body: c.body ?? '', wa_template: c.wa_template ?? '', wa_language: c.wa_language ?? 'en', wa_params: c.wa_params ?? [],
  contacts: (c.audience_contacts ?? []).map((x) => ({ ...empty(), ...Object.fromEntries(Object.entries(x).map(([k, v]) => [k, v ?? ''])) })),
});

export function CampaignNew() {
  const { search } = useLocation();
  const p = new URLSearchParams(search);
  const channel: CampaignChannel = p.get('channel') === 'whatsapp' ? 'whatsapp' : p.get('channel') === 'voice' ? 'voice' : 'email';
  const initial: Draft = { channel, voice_name: '', voice_clip: '', name: '', audience: p.get('list') ? `list:${p.get('list')}` : p.get('query') !== null ? `query:${p.get('query')}` : '',
    subject: '', body: channel === 'email' ? 'Dear {{name}},\n\n\n\nBest regards,' : channel === 'voice' ? VOICE_SAMPLE : '', wa_template: '', wa_language: 'en', wa_params: [], contacts: [] };
  return <Page title={`New ${channel === 'whatsapp' ? 'WhatsApp' : channel === 'voice' ? 'auto-call' : 'email'} campaign`} back="/campaigns"><Editor initial={initial} /></Page>;
}

export function CampaignDetail({ id }: { id: string }) {
  const { data: c, isLoading, error } = useQuery({ queryKey: ['campaign', id], queryFn: () => out.campaign(id), refetchInterval: (q) => (q.state.data && ['sending', 'scheduled'].includes(q.state.data.status) ? 5000 : false) });
  if (isLoading) return <div className="p-8"><Spinner /></div>;
  if (error || !c) return <p className="p-8 text-rose-600">{(error as Error)?.message}</p>;
  if (c.status === 'draft') return <Page title={c.name} subtitle="Draft" back="/campaigns"><Editor initial={fromCampaign(c)} id={c.id} /></Page>;
  return <CampaignView c={c} />;
}

function Editor({ initial, id }: { initial: Draft; id?: string }) {
  const qc = useQueryClient();
  const [d, setD] = useState<Draft>(initial);
  const [savedId, setSavedId] = useState<string | undefined>(id);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [sendAt, setSendAt] = useState('');
  const [adding, setAdding] = useState(false);
  const set = (patch: Partial<Draft>) => { setD((prev) => ({ ...prev, ...patch })); setPreview(null); };
  const lists = useQuery({ queryKey: ['lists'], queryFn: api.lists });
  const views = useQuery({ queryKey: ['views'], queryFn: api.views });
  const meta = useQuery({ queryKey: ['campaign-meta'], queryFn: out.campaignMeta });
  const sending = useQuery({ queryKey: ['sending'], queryFn: out.sending, enabled: d.channel === 'email' });
  const templates = useQuery({ queryKey: ['wa-templates'], queryFn: out.templates, enabled: d.channel === 'whatsapp' });
  const tpl = templates.data?.templates.find((t) => t.name === d.wa_template);
  useEffect(() => { if (tpl && d.wa_params.length !== tpl.params) set({ wa_params: Array.from({ length: tpl.params }, (_, i) => d.wa_params[i] ?? (i === 0 ? '{{name}}' : '{{area}}')), wa_language: tpl.language }); }, [tpl?.name]);

  const payload = () => ({
    channel: d.channel, name: d.name.trim(), audience_list: d.audience.startsWith('list:') ? d.audience.slice(5) : null, audience_query: d.audience.startsWith('query:') ? d.audience.slice(6) : null,
    subject: d.subject, body: d.body, wa_template: d.wa_template || null, wa_language: d.wa_language, wa_params: d.wa_params, audience_contacts: d.contacts,
    voice_name: d.voice_name || null, voice_clip: d.voice_clip || null,
  });
  const hasAudience = !!d.audience || d.contacts.length > 0;
  const save = useMutation({
    mutationFn: async () => { if (savedId) { await out.updateCampaign(savedId, payload()); return savedId; } return (await out.createCampaign(payload())).id; },
    onSuccess: (newId) => { setSavedId(newId); qc.invalidateQueries({ queryKey: ['campaigns'] }); if (!id) navigate(`/campaigns/${newId}`, true); },
  });
  const pv = useMutation({ mutationFn: async () => { const i = await save.mutateAsync(); return out.preview(i); }, onSuccess: setPreview });
  const test = useMutation({ mutationFn: async () => { const i = await save.mutateAsync(); return out.testSend(i); } });
  const [testPhone, setTestPhone] = useState('');
  const testCall = useMutation({ mutationFn: async () => { const i = await save.mutateAsync(); return out.testCall(i, testPhone); } });
  const launch = useMutation({
    mutationFn: async () => { const i = await save.mutateAsync(); await out.launch(i, sendAt ? new Date(sendAt).toISOString() : undefined); return i; },
    onSuccess: (i) => { qc.invalidateQueries({ queryKey: ['campaigns'] }); qc.invalidateQueries({ queryKey: ['campaign', i] }); qc.invalidateQueries({ queryKey: ['meta'] }); },
  });
  const del = useMutation({ mutationFn: () => out.deleteCampaign(savedId!), onSuccess: () => { qc.invalidateQueries({ queryKey: ['campaigns'] }); navigate('/campaigns'); } });
  const insert = (f: string) => set({ body: `${d.body}{{${f}}}` });
  const err = (save.error ?? pv.error ?? test.error ?? testCall.error ?? launch.error ?? del.error) as Error | null;
  const queryOption = d.audience.startsWith('query:') && !views.data?.some((v) => `query:${v.query}` === d.audience);

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
      <div className="space-y-5">
        {d.channel === 'whatsapp' && meta.data?.wa_mode === 'test' && <TestModeBanner what="WhatsApp is not connected, so messages are stored as sent and nothing reaches Meta. Connect a number in Settings → Sending." />}
        {d.channel === 'email' && isFreeMailbox(sending.data?.sender_email) && <WarnBanner>Your sender address is {sending.data?.sender_email}. {FREE_MAIL_WARNING} Change it in Settings → Sending.</WarnBanner>}
        {d.channel === 'voice' && meta.data?.voice.mode === 'test' && <TestModeBanner what="no calling provider is set up, so nobody is dialled. Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM to .env (and a public APP_URL) to place real calls." />}
        <section className={cx(card, 'space-y-4 p-5')}>
          <label className="block space-y-1.5"><span className="text-sm font-medium">Campaign name (internal)</span>
            <input value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Pharmacies Bogura, November offer" className={input} /></label>
          <label className="block space-y-1.5"><span className="text-sm font-medium">Audience</span>
            <select value={d.audience} onChange={(e) => set({ audience: e.target.value })} className={input}>
              <option value="">{d.contacts.length ? 'No list: only the recipients added below' : 'Choose a list or saved view…'}</option>
              {queryOption && <option value={d.audience}>Current Explore filter</option>}
              <optgroup label="Lists">{lists.data?.map((l) => <option key={l.id} value={`list:${l.id}`}>{l.name} ({l.n.toLocaleString()} businesses{l.contacts ? `, ${l.contacts.toLocaleString()} contacts` : ''})</option>)}</optgroup>
              <optgroup label="Saved views">{views.data?.map((v) => <option key={v.id} value={`query:${v.query}`}>{v.name}</option>)}</optgroup>
            </select>
            <span className="block text-xs text-slate-500">{d.channel === 'email' ? 'Only recipients with a valid email address are included.' : d.channel === 'voice' ? 'Every recipient with a Bangladeshi phone number (mobile or landline) is called once, inside your calling hours.' : 'Every recipient with a Bangladeshi mobile number is included; anyone who replies STOP is not messaged again.'} Your do-not-contact list is always excluded.</span>
          </label>
          <div className="space-y-2 border-t border-slate-100 pt-4 dark:border-slate-800">
            <div className="flex flex-wrap items-center gap-2">
              <div className="mr-auto"><div className="text-sm font-medium">{d.channel === 'whatsapp' ? 'WhatsApp numbers' : d.channel === 'voice' ? 'Phone numbers' : 'Email addresses'} added by hand</div>
                <div className="text-xs text-slate-500">Type them in or import an Excel/CSV file. Used together with the list above, or on their own.</div></div>
              {d.contacts.length > 0 && <Button size="sm" variant="ghost" onClick={() => set({ contacts: [] })}><Trash2 className="size-3.5" />Clear</Button>}
              <Button size="sm" onClick={() => setAdding(true)}><UserPlus className="size-3.5" />{d.contacts.length ? 'Add more' : 'Add recipients'}</Button>
            </div>
            {d.contacts.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {d.contacts.slice(0, 12).map((c, i) => (
                  <Badge key={i} tone={reachable(c, importChannel(d.channel)) ? 'slate' : 'amber'} title={reachable(c, importChannel(d.channel)) ? undefined : 'Not usable for this channel'}>
                    {c.name ? `${c.name} · ` : ''}{d.channel === 'email' ? c.email || c.phone : c.phone}
                    <button onClick={() => set({ contacts: d.contacts.filter((_, j) => j !== i) })} className="ml-0.5 text-slate-400 hover:text-rose-600" aria-label="Remove">×</button>
                  </Badge>
                ))}
                {d.contacts.length > 12 && <Badge tone="blue">+{(d.contacts.length - 12).toLocaleString()} more</Badge>}
              </div>
            )}
          </div>
        </section>
        <AddRecipientsDialog open={adding} onClose={() => setAdding(false)} channel={d.channel} onAdd={(cs) => set({ contacts: [...d.contacts, ...cs] })} />

        {d.channel === 'voice' ? <VoiceSection d={d} set={set} /> : d.channel === 'email' ? (
          <section className={cx(card, 'space-y-4 p-5')}>
            <label className="block space-y-1.5"><span className="text-sm font-medium">Subject</span>
              <input value={d.subject} onChange={(e) => set({ subject: e.target.value })} placeholder="e.g. A faster way to restock, {{name}}" className={input} /></label>
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-1.5"><span className="mr-auto text-sm font-medium">Message</span>
                {(meta.data?.merge_fields ?? ['name', 'category', 'area', 'district']).map((f) => <button key={f} onClick={() => insert(f)} className="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-xs hover:bg-brand-50 dark:bg-slate-800">{`{{${f}}}`}</button>)}</div>
              <textarea value={d.body} onChange={(e) => set({ body: e.target.value })} rows={12} className="w-full rounded-lg border border-slate-200 bg-white p-3 text-sm dark:border-slate-700 dark:bg-slate-900" />
              <p className="flex gap-1.5 text-xs text-slate-500"><ShieldCheck className="size-3.5 shrink-0" />Your sender name, postal address, why they receive it and an unsubscribe link are added to every email automatically.</p>
            </div>
          </section>
        ) : (
          <section className={cx(card, 'space-y-4 p-5')}>
            <label className="block space-y-1.5"><span className="text-sm font-medium">Approved template</span>
              <select value={d.wa_template} onChange={(e) => set({ wa_template: e.target.value })} className={input}>
                <option value="">Choose a template…</option>
                {templates.data?.templates.map((t) => <option key={`${t.name}-${t.language}`} value={t.name}>{t.name} ({t.language}, {t.category.toLowerCase()})</option>)}
              </select>
              <span className="block text-xs text-slate-500">WhatsApp only allows templates Meta has approved for business-started messages. Create them in WhatsApp Manager.</span>
            </label>
            {tpl && (
              <>
                <div className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-950 dark:bg-emerald-500/10 dark:text-emerald-100">{tpl.body}</div>
                {d.wa_params.map((v, i) => (
                  <label key={i} className="block space-y-1"><span className="text-xs text-slate-500">{`{{${i + 1}}}`}: text or a field like {'{{name}}'}</span>
                    <input value={v} onChange={(e) => set({ wa_params: d.wa_params.map((x, j) => (j === i ? e.target.value : x)) })} className={input} /></label>
                ))}
              </>
            )}
          </section>
        )}
      </div>

      <aside className="space-y-4">
        <section className={cx(card, 'space-y-3 p-5')}>
          <Button className="w-full" onClick={() => save.mutate()} disabled={!d.name.trim() || save.isPending}>Save draft</Button>
          <Button className="w-full" onClick={() => pv.mutate()} disabled={!d.name.trim() || !hasAudience || pv.isPending}>{pv.isPending ? <Spinner className="size-3.5" /> : <Eye className="size-4" />}Check audience &amp; preview</Button>
          {d.channel === 'email' && <Button className="w-full" variant="ghost" onClick={() => test.mutate()} disabled={!d.name.trim() || test.isPending}><Send className="size-4" />Send me a test</Button>}
          {test.data && <p className="text-xs text-emerald-600">{test.data.mode === 'test' ? `Test captured in Outbox (to ${test.data.to}).` : `Test accepted by your email provider for ${test.data.to}. Not in the inbox within a few minutes? Check spam, then your provider's logs.`}</p>}
          {d.channel === 'voice' && (
            <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); testCall.mutate(); }}>
              <input value={testPhone} onChange={(e) => setTestPhone(e.target.value)} placeholder="Your number, e.g. 017…" inputMode="tel" className={cx(input, 'h-8 text-xs')} />
              <Button size="sm" type="submit" disabled={!d.name.trim() || !testPhone.trim() || testCall.isPending} title={meta.data?.voice.mode === 'test' ? 'Needs Twilio settings in .env' : undefined}><PhoneCall className="size-3.5" />Call me</Button>
            </form>
          )}
          {testCall.data && <p className="text-xs text-emerald-600">Calling {testCall.data.to}… answer to hear the message.</p>}
          {err && <p className="text-sm text-rose-600">{err.message}</p>}
          {savedId && <button className="text-xs text-slate-400 hover:text-rose-600" onClick={() => confirmAction('This draft is deleted. Nothing was sent.', () => del.mutateAsync(), { title: 'Delete this draft?', confirmLabel: 'Delete', success: 'Draft deleted' })}><Trash2 className="mr-1 inline size-3" />Delete draft</button>}
        </section>
        {preview && (
          <section className={cx(card, 'space-y-3 p-5 text-sm')}>
            <div className="text-2xl font-semibold tabular-nums">{preview.eligible.toLocaleString()} <span className="text-sm font-normal text-slate-500">recipients</span></div>
            <ul className="space-y-0.5 text-xs text-slate-500">
              {preview.excluded.no_address > 0 && <li>{preview.excluded.no_address.toLocaleString()} without {d.channel === 'email' ? 'email' : d.channel === 'voice' ? 'a Bangladeshi phone number' : 'a mobile number'}</li>}
              {preview.excluded.no_consent > 0 && <li>{preview.excluded.no_consent.toLocaleString()} opted out</li>}
              {preview.excluded.suppressed > 0 && <li>{preview.excluded.suppressed.toLocaleString()} on your do-not-contact list</li>}
              {preview.excluded.duplicate > 0 && <li>{preview.excluded.duplicate.toLocaleString()} duplicate addresses</li>}
            </ul>
            <div className={cx('rounded-lg p-2 text-xs', preview.credits > preview.balance ? 'bg-rose-50 text-rose-700' : 'bg-slate-50 dark:bg-slate-800')}>Cost: <b>{preview.credits.toLocaleString()}</b> credits · balance {preview.balance.toLocaleString()}</div>
            {preview.sample && <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-slate-100 p-2 font-sans text-xs dark:border-slate-800">{preview.sample.subject ? `Subject: ${preview.sample.subject}\n\n` : ''}{preview.sample.text}</pre>}
            {meta.data?.can_launch ? (
              <>
                <label className="block space-y-1"><span className="text-xs text-slate-500">Schedule (optional, your local time)</span><input type="datetime-local" value={sendAt} onChange={(e) => setSendAt(e.target.value)} className={input} /></label>
                <Button variant="primary" className="w-full" disabled={!preview.eligible || preview.credits > preview.balance || launch.isPending}
                  onClick={() => confirmAction(`${preview.eligible.toLocaleString()} recipients · ${preview.credits.toLocaleString()} credits will be used.`, () => launch.mutateAsync(),
                    { title: sendAt ? 'Schedule this campaign?' : 'Launch this campaign now?', confirmLabel: sendAt ? 'Schedule' : 'Launch', danger: false, success: sendAt ? 'Campaign scheduled' : 'Campaign launched' })}>
                  <Rocket className="size-4" />{sendAt ? 'Schedule' : 'Launch now'}</Button>
              </>
            ) : <p className="text-xs text-slate-500">Only workspace admins can launch campaigns.</p>}
          </section>
        )}
      </aside>
    </div>
  );
}

/** The spoken message of an auto-call campaign, with a voice choice and a "listen" preview. */
function VoiceSection({ d, set }: { d: Draft; set: (p: Partial<Draft>) => void }) {
  const meta = useQuery({ queryKey: ['campaign-meta'], queryFn: out.campaignMeta });
  const v = meta.data?.voice;
  const voice = d.voice_name || v?.voices[0]?.id || '';
  const sample = { name: 'রহিম ফার্মেসি', category: '', area: 'মিরপুর', district: 'ঢাকা' } as Record<string, string>;
  const full = v ? [v.intro, d.body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => sample[k] ?? ''), v.outro].join(' ') : d.body;
  const [note, setNote] = useState<string | null>(null);
  const [own, setOwn] = useState(!!d.voice_clip);
  const listen = useMutation({
    mutationFn: () => out.voicePreview(full, voice),
    onSuccess: (r) => {
      if (r.audio) { setNote(null); void new Audio(r.audio).play(); return; }
      // no Azure key: let the browser read it (quality depends on the computer's installed Bangla voice)
      const u = new SpeechSynthesisUtterance(full);
      u.lang = 'bn-BD';
      const bn = speechSynthesis.getVoices().find((x) => x.lang.toLowerCase().startsWith('bn'));
      if (bn) u.voice = bn;
      speechSynthesis.cancel(); speechSynthesis.speak(u);
      setNote(bn ? 'Browser voice preview. Real calls use Twilio\'s Bengali voice; add AZURE_SPEECH_KEY for the Bangladeshi neural voices.' : 'No Bangla voice in this browser, and no AZURE_SPEECH_KEY on the server, so the preview may be silent or wrong. Calls still use Twilio\'s Bengali voice.');
    },
  });
  return (
    <section className={cx(card, 'space-y-4 p-5')}>
      <div className="flex gap-1 rounded-lg bg-slate-100 p-1 text-sm dark:bg-slate-800">
        {([[false, 'Computer voice (from text)'], [true, 'My own voice (recording)']] as const).map(([k, l]) => (
          <button key={l} type="button" onClick={() => { setOwn(k); if (!k) set({ voice_clip: '' }); }}
            className={cx('flex-1 rounded-md py-1.5 font-medium', own === k ? 'bg-white shadow-sm dark:bg-slate-900' : 'text-slate-500')}>{l}</button>
        ))}
      </div>
      <label className="block space-y-1.5"><span className="text-sm font-medium">{own ? 'Computer voice for the intro and the 1/9 instructions' : 'Voice'}</span>
        <select value={voice} onChange={(e) => set({ voice_name: e.target.value })} className={input}>
          {v?.voices.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
        </select>
        {v?.tts === 'twilio_say' && <span className="block text-xs text-amber-700 dark:text-amber-300">AZURE_SPEECH_KEY is not set: calls use Twilio's Bengali (India) voice instead of these Bangladeshi voices.</span>}
      </label>
      {own ? (
        <div className="space-y-1.5">
          <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:bg-slate-800/60">Spoken first: {v?.intro}</div>
          <ClipPicker value={d.voice_clip} onChange={(id) => set({ voice_clip: id })} />
          <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:bg-slate-800/60">Spoken last: {v?.outro}</div>
          <p className="flex gap-1.5 text-xs text-slate-500"><ShieldCheck className="size-3.5 shrink-0" />Your recording is the same for everyone ({'{{name}}'} cannot be used). Who is calling and “press 1 / press 9” are still spoken around it, and the whole message plays twice.</p>
          <span className="block text-xs text-slate-500">{v?.credits_per_call ?? 3} credits per call</span>
        </div>
      ) : <>
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-1.5"><span className="mr-auto text-sm font-medium">Message (বাংলা)</span>
          {['name', 'area', 'district'].map((f) => <button key={f} onClick={() => set({ body: `${d.body}{{${f}}}` })} className="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-xs hover:bg-brand-50 dark:bg-slate-800">{`{{${f}}}`}</button>)}</div>
        <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:bg-slate-800/60">Spoken first: {v?.intro}</div>
        <textarea value={d.body} onChange={(e) => set({ body: e.target.value })} rows={6} maxLength={1200} lang="bn" className="w-full rounded-lg border border-slate-200 bg-white p-3 text-base dark:border-slate-700 dark:bg-slate-900" />
        <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:bg-slate-800/60">Spoken last: {v?.outro}</div>
        <p className="flex gap-1.5 text-xs text-slate-500"><ShieldCheck className="size-3.5 shrink-0" />Every call says who is calling (your sender name in Settings → Sending) and offers “press 9” to stop calls. Pressing 1 marks the person as interested. The message plays twice.</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => listen.mutate()} disabled={!d.body.trim() || listen.isPending}>{listen.isPending ? <Spinner className="size-3.5" /> : <Volume2 className="size-4" />}Listen</Button>
        <span className="text-xs text-slate-500">≈ {Math.max(5, Math.round(full.length / 12))} s · {v?.credits_per_call ?? 3} credits per call</span>
      </div>
      {note && <p className="text-xs text-amber-700 dark:text-amber-300">{note}</p>}
      {listen.error && <p className="text-sm text-rose-600">{(listen.error as Error).message}</p>}
      </>}
    </section>
  );
}

/** Choose, record or upload the workspace's own voice recording (converted in the browser to phone-quality WAV). */
function ClipPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const qc = useQueryClient();
  const clips = useQuery({ queryKey: ['voice-clips'], queryFn: out.voiceClips });
  const [rec, setRec] = useState<{ stop: () => Promise<Blob>; started: number } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!rec) return;
    const t = setInterval(() => {
      const s = (Date.now() - rec.started) / 1000;
      setElapsed(s);
      if (s >= MAX_SECONDS) void finish();
    }, 250);
    return () => clearInterval(t);
  }, [rec]);
  const upload = useMutation({
    mutationFn: async ({ blob, fallbackName }: { blob: Blob; fallbackName: string }) => {
      const wav = await toPhoneWav(blob);
      return out.uploadClip(name.trim() || fallbackName, wav.base64);
    },
    onSuccess: (c) => { setName(''); setErr(null); qc.invalidateQueries({ queryKey: ['voice-clips'] }); onChange(c.id); },
    onError: (e) => setErr((e as Error).message),
  });
  const del = useMutation({ mutationFn: out.deleteClip, onSuccess: (_, id) => { if (id === value) onChange(''); qc.invalidateQueries({ queryKey: ['voice-clips'] }); } });
  const start = async () => {
    setErr(null);
    try { setRec({ ...(await startRecording()), started: Date.now() }); setElapsed(0); }
    catch { setErr('Could not use the microphone. Allow microphone access in the browser, or upload an audio file instead.'); }
  };
  async function finish() {
    if (!rec) return;
    const r = rec; setRec(null);
    upload.mutate({ blob: await r.stop(), fallbackName: `Recording ${new Date().toLocaleString()}` });
  }
  return (
    <div className="space-y-3 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
      {!!clips.data?.length && (
        <div className="space-y-1.5">
          {clips.data.map((c) => (
            <div key={c.id} className={cx('flex items-center gap-2 rounded-lg border px-2 py-1.5 text-sm', value === c.id ? 'border-brand-500 bg-brand-50/60 dark:bg-brand-500/10' : 'border-slate-200 dark:border-slate-700')}>
              <input type="radio" name="voice-clip" checked={value === c.id} onChange={() => onChange(c.id)} className="accent-brand-600" aria-label={`Use ${c.name}`} />
              <span className="min-w-0 flex-1 truncate font-medium">{c.name}</span>
              <span className="text-xs tabular-nums text-slate-400">{Math.round(c.seconds)} s</span>
              <button onClick={() => void new Audio(`/api/voice/audio/${c.id}.wav`).play()} className="rounded p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Play"><Play className="size-4" /></button>
              <button onClick={() => confirmAction('Campaigns already launched keep playing it.', () => del.mutateAsync(c.id), { title: `Delete “${c.name}”?`, confirmLabel: 'Delete', success: 'Recording deleted' })} className="rounded p-1 text-slate-300 hover:text-rose-600" aria-label="Delete"><Trash2 className="size-4" /></button>
            </div>
          ))}
        </div>
      )}
      <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name for a new recording, e.g. November offer" className={input} />
        {rec ? (
          <Button variant="danger" onClick={() => void finish()}><span className="size-2 animate-pulse rounded-full bg-white" />Stop {Math.floor(elapsed)} s / {MAX_SECONDS}</Button>
        ) : (
          <Button onClick={() => void start()} disabled={upload.isPending}><Mic className="size-4" />Record</Button>
        )}
        <label className={cx('inline-flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 text-sm font-medium shadow-sm hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900', (rec || upload.isPending) && 'pointer-events-none opacity-50')}>
          <Upload className="size-4" />Upload audio
          <input type="file" accept="audio/*,.mp3,.wav,.m4a,.ogg" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) upload.mutate({ blob: f, fallbackName: f.name.replace(/\.[^.]+$/, '') }); }} />
        </label>
      </div>
      {upload.isPending && <p className="flex items-center gap-1.5 text-xs text-slate-500"><Spinner className="size-3.5" />Converting to phone quality and saving…</p>}
      {err && <p className="text-sm text-rose-600">{err}</p>}
      {!value && !!clips.data?.length && <p className="text-xs text-amber-700 dark:text-amber-300">Choose one of the recordings above.</p>}
      <p className="text-xs text-slate-500">Speak close to the microphone in a quiet room. Up to {MAX_SECONDS} seconds; MP3, WAV, M4A or OGG files also work. Phones play it at telephone quality.</p>
    </div>
  );
}

/** Recipients typed or imported straight into a campaign. */
function AddRecipientsDialog({ open, onClose, channel, onAdd }: { open: boolean; onClose: () => void; channel: CampaignChannel; onAdd: (c: Contact[]) => void }) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  useEffect(() => { if (open) setContacts([]); }, [open]);
  const ready = contacts.filter((c) => reachable(c, importChannel(channel)));
  return (
    <Modal open={open} onClose={onClose} wide title={channel === 'whatsapp' ? 'Add WhatsApp numbers' : channel === 'voice' ? 'Add phone numbers to call' : 'Add email addresses'}
      footer={<><Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!ready.length} onClick={() => { onAdd(ready); onClose(); }}>Add {ready.length.toLocaleString()}</Button></>}>
      <div className="space-y-4">
        <ContactImport value={contacts} onChange={setContacts} channel={importChannel(channel)} />
        <p className="text-xs text-slate-500">To keep these people for later campaigns, import them into a list on the Lists page instead.</p>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ running / finished campaign
const VOICE_STATUS: Record<string, string> = {
  queued: 'waiting', sent: 'ringing', delivered: 'answered', replied: 'pressed 1 (interested)', unsubscribed: 'pressed 9 / do not call', failed: 'not reached', skipped: 'not dialled',
};
function CampaignView({ c }: { c: Campaign }) {
  const qc = useQueryClient();
  const act = useMutation({ mutationFn: (a: 'pause' | 'resume' | 'cancel') => out.campaignAction(c.id, a), onSuccess: () => { qc.invalidateQueries({ queryKey: ['campaign', c.id] }); qc.invalidateQueries({ queryKey: ['meta'] }); } });
  const stats = c.stats ?? {};
  const order = ['queued', 'sent', 'delivered', 'read', 'replied', 'failed', 'unsubscribed', 'skipped'];
  const done = c.recipients - (stats.queued ?? 0);
  const pct = c.recipients ? Math.round((done / c.recipients) * 100) : 0;
  const capped = c.channel === 'email' && c.status === 'sending' && (stats.queued ?? 0) > 0;
  const total = useMemo(() => Math.max(1, c.recipients), [c.recipients]);
  const label = (k: string) => (c.channel === 'voice' ? VOICE_STATUS[k] ?? k : k);
  return (
    <Page back="/campaigns" title={<span className="flex items-center gap-2"><ChannelIcon c={c.channel} className="size-5" />{c.name}</span>}
      subtitle={<>{audienceLabel(c)} · launched {fmt(c.launched_at)}{c.created_by_name ? ` by ${c.created_by_name}` : ''}</>}
      actions={<div className="flex items-center gap-2"><Badge tone={STATUS_TONE[c.status]} className="text-sm">{c.status}</Badge>
        {(c.status === 'sending' || c.status === 'scheduled') && <Button size="sm" onClick={() => act.mutate('pause')}><Pause className="size-4" />Pause</Button>}
        {c.status === 'paused' && <Button size="sm" onClick={() => act.mutate('resume')}><Play className="size-4" />Resume</Button>}
        {['sending', 'scheduled', 'paused'].includes(c.status) && <Button size="sm" variant="ghost" onClick={() => confirmAction('Messages not yet sent are dropped and their credits refunded.', () => act.mutateAsync('cancel'), { title: 'Cancel this campaign?', confirmLabel: 'Cancel campaign', success: 'Campaign cancelled' })}><XCircle className="size-4" />Cancel</Button>}</div>}>
      {act.error && <p className="mb-3 text-sm text-rose-600">{(act.error as Error).message}</p>}
      <section className={cx(card, 'p-5')}>
        <div className="flex items-end justify-between"><div className="text-3xl font-semibold tabular-nums">{pct}%</div><div className="text-sm text-slate-500">{done.toLocaleString()} of {c.recipients.toLocaleString()} processed · {c.credits.toLocaleString()} credits</div></div>
        <div className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
          {order.filter((k) => k !== 'queued').map((k) => <div key={k} title={k} style={{ width: `${((stats[k] ?? 0) / total) * 100}%` }} className={cx(k === 'failed' ? 'bg-rose-500' : ['unsubscribed', 'skipped'].includes(k) ? 'bg-amber-400' : k === 'replied' ? 'bg-violet-500' : 'bg-emerald-500')} />)}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {order.filter((k) => stats[k]).map((k) => <div key={k} className="rounded-xl bg-slate-50 p-3 dark:bg-slate-800/60"><div className="text-xs capitalize text-slate-500">{label(k)}</div><div className="text-lg font-semibold tabular-nums">{(stats[k] ?? 0).toLocaleString()}</div></div>)}
        </div>
        {c.status === 'scheduled' && <p className="mt-3 text-sm text-slate-500">Starts {fmt(c.send_at)}.</p>}
        {capped && <p className="mt-3 text-xs text-slate-500">Emails go out in small batches and stop at the daily cap (Settings → Sending) to protect your sender reputation; the rest continue the next day.</p>}
      </section>
      <section className={cx(card, 'mt-5 overflow-hidden')}>
        <div className="px-5 py-3 text-sm font-semibold">Recent recipients</div>
        <div className="overflow-x-auto"><table className="w-full text-sm">
          <tbody>{c.recipients_sample?.map((r) => (
            <tr key={r.address} className="border-t border-slate-100 dark:border-slate-800">
              <td className="px-5 py-2">{r.biz_id === 'manual' || r.biz_id.startsWith('contact:') ? r.name : <Link to={`/business/${encodeURIComponent(r.biz_id)}`} className="hover:underline">{r.name}</Link>}</td>
              <td className="text-slate-500">{r.address}</td>
              <td><Badge tone={STATUS_TONE[r.status] ?? 'slate'}>{label(r.status)}</Badge></td>
              <td className="hidden max-w-56 truncate px-5 text-xs text-slate-400 md:table-cell">{r.reason ?? (r.sent_at ? fmt(r.sent_at) : '')}</td>
            </tr>
          ))}</tbody>
        </table></div>
      </section>
    </Page>
  );
}
