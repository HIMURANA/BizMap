import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Check, Trash2, AlertTriangle } from 'lucide-react';
import { FREE_MAIL_WARNING, isFreeMailbox, out, type SendingSettings } from '../lib/outreach';
import { Badge, Button, Spinner, cx } from '../components/ui';
import { confirmAction } from '../components/feedback';

const card = 'rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900';
const input = 'h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-900';

function Section({ title, desc, children, badge }: { title: string; desc?: ReactNode; children: ReactNode; badge?: ReactNode }) {
  return <section className={cx(card, 'mb-5')}><div className="mb-4"><h2 className="flex items-center gap-2 font-semibold">{title}{badge}</h2>{desc && <p className="text-sm text-slate-500">{desc}</p>}</div>{children}</section>;
}
const Field = ({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) => (
  <label className="block space-y-1"><span className="text-sm font-medium">{label}</span>{children}{hint && <span className="block text-xs text-slate-500">{hint}</span>}</label>
);

export function SendingTab({ isAdmin }: { isAdmin: boolean }) {
  const { data, isLoading } = useQuery({ queryKey: ['sending'], queryFn: out.sending });
  if (isLoading || !data) return <Spinner />;
  return (
    <>
      {!isAdmin && <p className="mb-4 text-sm text-slate-500">Only workspace admins can change these settings.</p>}
      <EmailSection s={data} disabled={!isAdmin} />
      <WhatsAppSection s={data} disabled={!isAdmin} />
      <SuppressionSection isAdmin={isAdmin} />
    </>
  );
}

function EmailSection({ s, disabled }: { s: SendingSettings; disabled: boolean }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ sender_name: '', sender_email: '', reply_to: '', postal_address: '', daily_email_cap: 200, call_hours_start: 9, call_hours_end: 20 });
  useEffect(() => setF({ sender_name: s.sender_name ?? '', sender_email: s.sender_email ?? '', reply_to: s.reply_to ?? '', postal_address: s.postal_address ?? '',
    daily_email_cap: s.daily_email_cap, call_hours_start: s.call_hours_start, call_hours_end: s.call_hours_end }), [s]);
  const save = useMutation({ mutationFn: () => out.saveSending(f), onSuccess: () => qc.invalidateQueries({ queryKey: ['sending'] }) });
  return (
    <Section title="Email sender" badge={<Badge tone={s.mail_mode === 'smtp' ? 'green' : 'amber'}>{s.mail_mode === 'smtp' ? 'sending live' : s.mail_mode === 'test' ? 'test mode: captured in Outbox' : 'not configured'}</Badge>}
      desc="Shown in every campaign email. The postal address is required: recipients must be able to see who is writing to them.">
      <fieldset disabled={disabled} className="grid gap-4 sm:grid-cols-2">
        <Field label="Sender name"><input value={f.sender_name} onChange={(e) => setF({ ...f, sender_name: e.target.value })} placeholder="Acme Distribution" className={input} /></Field>
        <Field label="Sender email" hint="Must be on a domain your email provider has verified (SPF / DKIM)."><input type="email" value={f.sender_email} onChange={(e) => setF({ ...f, sender_email: e.target.value })} placeholder="sales@acme.com.bd" className={input} />
          {isFreeMailbox(f.sender_email) && <span className="mt-1.5 flex gap-1.5 rounded-lg bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-500/10 dark:text-amber-200"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" />{FREE_MAIL_WARNING}</span>}</Field>
        <Field label="Reply-to (optional)"><input type="email" value={f.reply_to} onChange={(e) => setF({ ...f, reply_to: e.target.value })} className={input} /></Field>
        <Field label="Daily email limit" hint="Start low (100–200) and raise it slowly: new senders who send too much land in spam."><input type="number" min={10} max={5000} value={f.daily_email_cap} onChange={(e) => setF({ ...f, daily_email_cap: Number(e.target.value) })} className={input} /></Field>
        <div className="sm:col-span-2"><Field label="Business postal address"><input value={f.postal_address} onChange={(e) => setF({ ...f, postal_address: e.target.value })} placeholder="House 12, Road 5, Dhanmondi, Dhaka 1205" className={input} /></Field></div>
        <Field label="Calling hours start (Dhaka time)"><input type="number" min={0} max={23} value={f.call_hours_start} onChange={(e) => setF({ ...f, call_hours_start: Number(e.target.value) })} className={input} /></Field>
        <Field label="Calling hours end"><input type="number" min={1} max={24} value={f.call_hours_end} onChange={(e) => setF({ ...f, call_hours_end: Number(e.target.value) })} className={input} /></Field>
      </fieldset>
      {!disabled && <div className="mt-4 flex items-center gap-3"><Button variant="primary" onClick={() => save.mutate()} disabled={save.isPending}>Save</Button>{save.isSuccess && <span className="text-sm text-emerald-600">Saved.</span>}{save.error && <span className="text-sm text-rose-600">{(save.error as Error).message}</span>}</div>}
    </Section>
  );
}

function WhatsAppSection({ s, disabled }: { s: SendingSettings; disabled: boolean }) {
  const qc = useQueryClient();
  const wa = s.whatsapp;
  const [f, setF] = useState({ phone_number_id: wa.phone_number_id ?? '', waba_id: wa.waba_id ?? '', access_token: '', app_secret: '' });
  const [copied, setCopied] = useState('');
  const save = useMutation({ mutationFn: () => out.connectWhatsapp(f), onSuccess: () => { setF({ ...f, access_token: '', app_secret: '' }); qc.invalidateQueries({ queryKey: ['sending'] }); } });
  const disconnect = useMutation({ mutationFn: out.disconnectWhatsapp, onSuccess: () => qc.invalidateQueries({ queryKey: ['sending'] }) });
  const copy = (k: string, v: string) => { navigator.clipboard?.writeText(v); setCopied(k); setTimeout(() => setCopied(''), 1500); };
  return (
    <Section title="WhatsApp Business" badge={<Badge tone={wa.mode === 'live' ? 'green' : 'amber'}>{wa.mode === 'live' ? 'connected' : wa.mode === 'test' ? 'test mode' : 'not connected'}</Badge>}
      desc={<>Connect your own number from the WhatsApp Business Platform (Meta developer dashboard → WhatsApp → API setup). Tokens are stored encrypted and never shown again.</>}>
      <fieldset disabled={disabled} className="grid gap-4 sm:grid-cols-2">
        <Field label="Phone number ID"><input value={f.phone_number_id} onChange={(e) => setF({ ...f, phone_number_id: e.target.value })} className={input} /></Field>
        <Field label="WhatsApp Business Account ID"><input value={f.waba_id} onChange={(e) => setF({ ...f, waba_id: e.target.value })} className={input} /></Field>
        <Field label="Permanent access token" hint={wa.has_token ? 'A token is saved. Leave empty to keep it.' : 'From a System User in Meta Business Settings.'}><input type="password" value={f.access_token} onChange={(e) => setF({ ...f, access_token: e.target.value })} autoComplete="off" className={input} /></Field>
        <Field label="App secret" hint="Used to check that webhook calls really come from Meta."><input type="password" value={f.app_secret} onChange={(e) => setF({ ...f, app_secret: e.target.value })} autoComplete="off" className={input} /></Field>
      </fieldset>
      {wa.verify_token && (
        <div className="mt-4 space-y-2 rounded-xl bg-slate-50 p-3 text-sm dark:bg-slate-800/60">
          <p className="text-xs text-slate-500">In the Meta dashboard → WhatsApp → Configuration → Webhook, enter these and subscribe to <b>messages</b>:</p>
          {([['url', 'Callback URL', wa.webhook_url], ['token', 'Verify token', wa.verify_token]] as const).map(([k, l, v]) => (
            <div key={k} className="flex items-center gap-2"><span className="w-24 shrink-0 text-xs text-slate-500">{l}</span><code className="min-w-0 flex-1 truncate text-xs">{v}</code>
              <Button size="sm" variant="ghost" onClick={() => copy(k, v)}>{copied === k ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}</Button></div>
          ))}
          {/localhost|127\.0\.0\.1/.test(wa.webhook_url) && <p className="text-xs text-amber-700">Meta cannot reach localhost: set APP_URL to your public address when hosting.</p>}
        </div>
      )}
      {!disabled && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button variant="primary" onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending && <Spinner className="size-3.5 border-white/40 border-t-white" />}Save &amp; check with Meta</Button>
          {wa.mode === 'live' && <Button variant="ghost" onClick={() => confirmAction('Campaigns and replies stop until you reconnect.', () => disconnect.mutateAsync(), { title: 'Disconnect WhatsApp?', confirmLabel: 'Disconnect', success: 'WhatsApp disconnected' })}>Disconnect</Button>}
          {save.isSuccess && <span className="text-sm text-emerald-600">Saved.</span>}
          {save.error && <span className="text-sm text-rose-600">{(save.error as Error).message}</span>}
        </div>
      )}
    </Section>
  );
}

function SuppressionSection({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [add, setAdd] = useState('');
  const [channel, setChannel] = useState('email');
  const { data } = useQuery({ queryKey: ['suppressions', q], queryFn: () => out.suppressions(q) });
  const save = useMutation({ mutationFn: () => out.addSuppressions(add.split(/[\s,;]+/).filter(Boolean), channel, 'added manually'), onSuccess: () => { setAdd(''); qc.invalidateQueries({ queryKey: ['suppressions'] }); } });
  const remove = useMutation({ mutationFn: out.removeSuppression, onSuccess: () => qc.invalidateQueries({ queryKey: ['suppressions'] }) });
  return (
    <Section title="Do-not-contact list" desc="Never emailed, messaged, called or exported again. Unsubscribes, STOP replies and “do not call” outcomes are added automatically.">
      <div className="mb-3 flex flex-wrap gap-2">
        <input value={add} onChange={(e) => setAdd(e.target.value)} placeholder="Emails or phone numbers (comma separated)" className={cx(input, 'min-w-56 flex-1')} />
        <select value={channel} onChange={(e) => setChannel(e.target.value)} className={cx(input, 'w-auto')}><option value="email">Email</option><option value="phone">Phone</option><option value="whatsapp">WhatsApp</option></select>
        <Button onClick={() => save.mutate()} disabled={!add.trim()}>Add</Button>
      </div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className={cx(input, 'mb-2 max-w-xs')} />
      <ul className="max-h-72 divide-y divide-slate-100 overflow-y-auto text-sm dark:divide-slate-800">
        {data?.length === 0 && <li className="py-2 text-slate-500">Empty.</li>}
        {data?.map((s) => (
          <li key={s.value} className="flex items-center gap-3 py-2">
            <span className="min-w-0 flex-1 truncate">{s.value}</span><Badge>{s.channel}</Badge>
            <span className="hidden text-xs text-slate-400 sm:inline">{s.reason} · {new Date(s.created_at).toLocaleDateString()}</span>
            {isAdmin && <button className="text-slate-300 hover:text-rose-600" title="Remove (they could be contacted again)" onClick={() => confirmAction('They could be contacted again.', () => remove.mutateAsync(s.value), { title: `Remove ${s.value}?`, confirmLabel: 'Remove', success: 'Removed from do-not-contact list' })}><Trash2 className="size-4" /></button>}
          </li>
        ))}
      </ul>
    </Section>
  );
}
