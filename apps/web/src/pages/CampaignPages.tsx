import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail, MessageCircle, Plus, Send, Eye, Rocket, Pause, Play, XCircle, Trash2, AlertTriangle, Inbox as InboxIcon, ArrowLeft, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api';
import { out, STATUS_TONE, type Campaign, type Preview } from '../lib/outreach';
import { Link, navigate, useLocation } from '../lib/router';
import { Badge, Button, Empty, Spinner, cx } from '../components/ui';

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

export function TestModeBanner({ what }: { what: string }) {
  return (
    <div className="mb-4 flex gap-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" /><span><b>Test mode:</b> {what}</span>
    </div>
  );
}

const ChannelIcon = ({ c, className }: { c: string; className?: string }) => (c === 'whatsapp' ? <MessageCircle className={cx('size-4 text-emerald-600', className)} /> : <Mail className={cx('size-4 text-brand-600', className)} />);

// ------------------------------------------------------------------ list
export function CampaignsPage() {
  const { search } = useLocation();
  const tab = new URLSearchParams(search).get('tab') === 'outbox' ? 'outbox' : 'campaigns';
  const { data, isLoading } = useQuery({ queryKey: ['campaigns'], queryFn: out.campaigns, refetchInterval: 10_000 });
  const meta = useQuery({ queryKey: ['campaign-meta'], queryFn: out.campaignMeta });
  return (
    <Page title="Campaigns" subtitle="Email and WhatsApp campaigns to businesses in your lists and saved views."
      actions={<div className="flex gap-2"><Button onClick={() => navigate('/campaigns/new?channel=whatsapp')}><MessageCircle className="size-4" />WhatsApp</Button><Button variant="primary" onClick={() => navigate('/campaigns/new?channel=email')}><Plus className="size-4" />Email campaign</Button></div>}>
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
                    <td className="hidden max-w-48 truncate text-slate-500 sm:table-cell">{c.list_name ? `List: ${c.list_name}` : c.audience_query ? 'Filter' : '—'}</td>
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
            <Badge tone={m.status === 'failed' ? 'rose' : m.mode === 'test' ? 'amber' : 'green'}>{m.mode === 'test' ? 'captured' : m.status}</Badge>
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

// ------------------------------------------------------------------ editor (new + draft)
type Draft = { channel: 'email' | 'whatsapp'; name: string; audience: string; subject: string; body: string; wa_template: string; wa_language: string; wa_params: string[] };
const fromCampaign = (c: Campaign): Draft => ({
  channel: c.channel, name: c.name, audience: c.audience_list ? `list:${c.audience_list}` : c.audience_query ? `query:${c.audience_query}` : '',
  subject: c.subject ?? '', body: c.body ?? '', wa_template: c.wa_template ?? '', wa_language: c.wa_language ?? 'en', wa_params: c.wa_params ?? [],
});

export function CampaignNew() {
  const { search } = useLocation();
  const p = new URLSearchParams(search);
  const channel = p.get('channel') === 'whatsapp' ? 'whatsapp' : 'email';
  const initial: Draft = { channel, name: '', audience: p.get('list') ? `list:${p.get('list')}` : p.get('query') !== null ? `query:${p.get('query')}` : '',
    subject: '', body: channel === 'email' ? 'Dear {{name}},\n\n\n\nBest regards,' : '', wa_template: '', wa_language: 'en', wa_params: [] };
  return <Page title={`New ${channel === 'whatsapp' ? 'WhatsApp' : 'email'} campaign`} back="/campaigns"><Editor initial={initial} /></Page>;
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
  const set = (patch: Partial<Draft>) => { setD({ ...d, ...patch }); setPreview(null); };
  const lists = useQuery({ queryKey: ['lists'], queryFn: api.lists });
  const views = useQuery({ queryKey: ['views'], queryFn: api.views });
  const meta = useQuery({ queryKey: ['campaign-meta'], queryFn: out.campaignMeta });
  const templates = useQuery({ queryKey: ['wa-templates'], queryFn: out.templates, enabled: d.channel === 'whatsapp' });
  const tpl = templates.data?.templates.find((t) => t.name === d.wa_template);
  useEffect(() => { if (tpl && d.wa_params.length !== tpl.params) set({ wa_params: Array.from({ length: tpl.params }, (_, i) => d.wa_params[i] ?? (i === 0 ? '{{name}}' : '{{area}}')), wa_language: tpl.language }); }, [tpl?.name]);

  const payload = () => ({
    channel: d.channel, name: d.name.trim(), audience_list: d.audience.startsWith('list:') ? d.audience.slice(5) : null, audience_query: d.audience.startsWith('query:') ? d.audience.slice(6) : null,
    subject: d.subject, body: d.body, wa_template: d.wa_template || null, wa_language: d.wa_language, wa_params: d.wa_params,
  });
  const save = useMutation({
    mutationFn: async () => { if (savedId) { await out.updateCampaign(savedId, payload()); return savedId; } return (await out.createCampaign(payload())).id; },
    onSuccess: (newId) => { setSavedId(newId); qc.invalidateQueries({ queryKey: ['campaigns'] }); if (!id) navigate(`/campaigns/${newId}`, true); },
  });
  const pv = useMutation({ mutationFn: async () => { const i = await save.mutateAsync(); return out.preview(i); }, onSuccess: setPreview });
  const test = useMutation({ mutationFn: async () => { const i = await save.mutateAsync(); return out.testSend(i); } });
  const launch = useMutation({
    mutationFn: async () => { const i = await save.mutateAsync(); await out.launch(i, sendAt ? new Date(sendAt).toISOString() : undefined); return i; },
    onSuccess: (i) => { qc.invalidateQueries({ queryKey: ['campaigns'] }); qc.invalidateQueries({ queryKey: ['campaign', i] }); qc.invalidateQueries({ queryKey: ['meta'] }); },
  });
  const del = useMutation({ mutationFn: () => out.deleteCampaign(savedId!), onSuccess: () => { qc.invalidateQueries({ queryKey: ['campaigns'] }); navigate('/campaigns'); } });
  const insert = (f: string) => set({ body: `${d.body}{{${f}}}` });
  const err = (save.error ?? pv.error ?? test.error ?? launch.error ?? del.error) as Error | null;
  const queryOption = d.audience.startsWith('query:') && !views.data?.some((v) => `query:${v.query}` === d.audience);

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
      <div className="space-y-5">
        {d.channel === 'whatsapp' && meta.data?.wa_mode === 'test' && <TestModeBanner what="WhatsApp is not connected, so messages are stored as sent and nothing reaches Meta. Connect a number in Settings → Sending." />}
        <section className={cx(card, 'space-y-4 p-5')}>
          <label className="block space-y-1.5"><span className="text-sm font-medium">Campaign name (internal)</span>
            <input value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Pharmacies Bogura, November offer" className={input} /></label>
          <label className="block space-y-1.5"><span className="text-sm font-medium">Audience</span>
            <select value={d.audience} onChange={(e) => set({ audience: e.target.value })} className={input}>
              <option value="">Choose a list or saved view…</option>
              {queryOption && <option value={d.audience}>Current Explore filter</option>}
              <optgroup label="Lists">{lists.data?.map((l) => <option key={l.id} value={`list:${l.id}`}>{l.name} ({l.n.toLocaleString()})</option>)}</optgroup>
              <optgroup label="Saved views">{views.data?.map((v) => <option key={v.id} value={`query:${v.query}`}>{v.name}</option>)}</optgroup>
            </select>
            <span className="block text-xs text-slate-500">{d.channel === 'email' ? 'Only businesses with a public email address are included.' : 'Only numbers with a recorded WhatsApp opt-in are included.'} Your do-not-contact list is always excluded.</span>
          </label>
        </section>

        {d.channel === 'email' ? (
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
          <Button className="w-full" onClick={() => pv.mutate()} disabled={!d.name.trim() || !d.audience || pv.isPending}>{pv.isPending ? <Spinner className="size-3.5" /> : <Eye className="size-4" />}Check audience &amp; preview</Button>
          {d.channel === 'email' && <Button className="w-full" variant="ghost" onClick={() => test.mutate()} disabled={!d.name.trim() || test.isPending}><Send className="size-4" />Send me a test</Button>}
          {test.data && <p className="text-xs text-emerald-600">Test sent to {test.data.to}{test.data.mode === 'test' ? ' (captured in Outbox)' : ''}.</p>}
          {err && <p className="text-sm text-rose-600">{err.message}</p>}
          {savedId && <button className="text-xs text-slate-400 hover:text-rose-600" onClick={() => confirm('Delete this draft?') && del.mutate()}><Trash2 className="mr-1 inline size-3" />Delete draft</button>}
        </section>
        {preview && (
          <section className={cx(card, 'space-y-3 p-5 text-sm')}>
            <div className="text-2xl font-semibold tabular-nums">{preview.eligible.toLocaleString()} <span className="text-sm font-normal text-slate-500">recipients</span></div>
            <ul className="space-y-0.5 text-xs text-slate-500">
              {preview.excluded.no_address > 0 && <li>{preview.excluded.no_address.toLocaleString()} without {d.channel === 'email' ? 'email' : 'a mobile number'}</li>}
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
                  onClick={() => confirm(`Send to ${preview.eligible.toLocaleString()} recipients and use ${preview.credits.toLocaleString()} credits?`) && launch.mutate()}>
                  <Rocket className="size-4" />{sendAt ? 'Schedule' : 'Launch now'}</Button>
              </>
            ) : <p className="text-xs text-slate-500">Only workspace admins can launch campaigns.</p>}
          </section>
        )}
      </aside>
    </div>
  );
}

// ------------------------------------------------------------------ running / finished campaign
function CampaignView({ c }: { c: Campaign }) {
  const qc = useQueryClient();
  const act = useMutation({ mutationFn: (a: 'pause' | 'resume' | 'cancel') => out.campaignAction(c.id, a), onSuccess: () => { qc.invalidateQueries({ queryKey: ['campaign', c.id] }); qc.invalidateQueries({ queryKey: ['meta'] }); } });
  const stats = c.stats ?? {};
  const order = ['queued', 'sent', 'delivered', 'read', 'replied', 'failed', 'unsubscribed', 'skipped'];
  const done = c.recipients - (stats.queued ?? 0);
  const pct = c.recipients ? Math.round((done / c.recipients) * 100) : 0;
  const capped = c.channel === 'email' && c.status === 'sending' && (stats.queued ?? 0) > 0;
  const total = useMemo(() => Math.max(1, c.recipients), [c.recipients]);
  return (
    <Page back="/campaigns" title={<span className="flex items-center gap-2"><ChannelIcon c={c.channel} className="size-5" />{c.name}</span>}
      subtitle={<>{c.list_name ? `List: ${c.list_name}` : 'Filter audience'} · launched {fmt(c.launched_at)}{c.created_by_name ? ` by ${c.created_by_name}` : ''}</>}
      actions={<div className="flex items-center gap-2"><Badge tone={STATUS_TONE[c.status]} className="text-sm">{c.status}</Badge>
        {(c.status === 'sending' || c.status === 'scheduled') && <Button size="sm" onClick={() => act.mutate('pause')}><Pause className="size-4" />Pause</Button>}
        {c.status === 'paused' && <Button size="sm" onClick={() => act.mutate('resume')}><Play className="size-4" />Resume</Button>}
        {['sending', 'scheduled', 'paused'].includes(c.status) && <Button size="sm" variant="ghost" onClick={() => confirm('Cancel? Messages not yet sent are dropped and their credits refunded.') && act.mutate('cancel')}><XCircle className="size-4" />Cancel</Button>}</div>}>
      {act.error && <p className="mb-3 text-sm text-rose-600">{(act.error as Error).message}</p>}
      <section className={cx(card, 'p-5')}>
        <div className="flex items-end justify-between"><div className="text-3xl font-semibold tabular-nums">{pct}%</div><div className="text-sm text-slate-500">{done.toLocaleString()} of {c.recipients.toLocaleString()} processed · {c.credits.toLocaleString()} credits</div></div>
        <div className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
          {order.filter((k) => k !== 'queued').map((k) => <div key={k} title={k} style={{ width: `${((stats[k] ?? 0) / total) * 100}%` }} className={cx(k === 'failed' ? 'bg-rose-500' : ['unsubscribed', 'skipped'].includes(k) ? 'bg-amber-400' : k === 'replied' ? 'bg-violet-500' : 'bg-emerald-500')} />)}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {order.filter((k) => stats[k]).map((k) => <div key={k} className="rounded-xl bg-slate-50 p-3 dark:bg-slate-800/60"><div className="text-xs capitalize text-slate-500">{k}</div><div className="text-lg font-semibold tabular-nums">{(stats[k] ?? 0).toLocaleString()}</div></div>)}
        </div>
        {c.status === 'scheduled' && <p className="mt-3 text-sm text-slate-500">Starts {fmt(c.send_at)}.</p>}
        {capped && <p className="mt-3 text-xs text-slate-500">Emails go out in small batches and stop at the daily cap (Settings → Sending) to protect your sender reputation; the rest continue the next day.</p>}
      </section>
      <section className={cx(card, 'mt-5 overflow-hidden')}>
        <div className="px-5 py-3 text-sm font-semibold">Recent recipients</div>
        <div className="overflow-x-auto"><table className="w-full text-sm">
          <tbody>{c.recipients_sample?.map((r) => (
            <tr key={r.address} className="border-t border-slate-100 dark:border-slate-800">
              <td className="px-5 py-2"><Link to={`/business/${encodeURIComponent(r.biz_id)}`} className="hover:underline">{r.name}</Link></td>
              <td className="text-slate-500">{r.address}</td>
              <td><Badge tone={STATUS_TONE[r.status] ?? 'slate'}>{r.status}</Badge></td>
              <td className="hidden max-w-56 truncate px-5 text-xs text-slate-400 md:table-cell">{r.reason ?? (r.sent_at ? fmt(r.sent_at) : '')}</td>
            </tr>
          ))}</tbody>
        </table></div>
      </section>
    </Page>
  );
}
