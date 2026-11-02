import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PhoneCall, Plus, Trash2, Phone, SkipForward, Clock, MapPin, MessageCircle, CheckCircle2, UserPlus, Mail } from 'lucide-react';
import { api } from '../lib/api';
import { out, OUTCOME_LABEL, type NextCall } from '../lib/outreach';
import { reachable, type Contact } from '../lib/contacts';
import { Link, navigate, useLocation } from '../lib/router';
import { ContactImport } from '../components/ContactImport';
import { Badge, Button, Empty, Modal, Spinner, cx } from '../components/ui';
import { Page } from './CampaignPages';
import { confirmAction } from '../components/feedback';

const card = 'rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900';
const input = 'h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-900';
const OUTCOME_BUTTONS = [
  ['interested', 'bg-emerald-600 text-white hover:bg-emerald-700'], ['callback', 'bg-brand-600 text-white hover:bg-brand-700'],
  ['not_interested', ''], ['no_answer', ''], ['wrong_number', 'text-rose-700'], ['closed', 'text-rose-700'], ['not_a_business', 'text-rose-700'], ['do_not_call', 'text-rose-700'],
] as const;

export function CallsPage() {
  const qc = useQueryClient();
  const { search } = useLocation();
  const p = new URLSearchParams(search);
  const [open, setOpen] = useState(p.has('new'));
  const [name, setName] = useState('');
  const [audience, setAudience] = useState(p.get('list') ? `list:${p.get('list')}` : p.get('query') !== null ? `query:${p.get('query')}` : '');
  const [script, setScript] = useState('Assalamu alaikum, this is ___ from ___. We help {{category}} businesses like yours with ___. Is the owner or manager available?');
  const [byHand, setByHand] = useState(false);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const { data, isLoading } = useQuery({ queryKey: ['queues'], queryFn: out.queues });
  const lists = useQuery({ queryKey: ['lists'], queryFn: api.lists, enabled: open });
  const views = useQuery({ queryKey: ['views'], queryFn: api.views, enabled: open });
  const typed = contacts.filter((c) => reachable(c, 'phone'));
  const create = useMutation({
    mutationFn: () => out.createQueue({ name: name.trim(), script, list_id: audience.startsWith('list:') ? audience.slice(5) : undefined, query: audience.startsWith('query:') ? audience.slice(6) : undefined,
      contacts: byHand ? typed : undefined }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ['queues'] }); navigate(`/calls/${r.id}`); },
  });
  const del = useMutation({ mutationFn: out.deleteQueue, onSuccess: () => qc.invalidateQueries({ queryKey: ['queues'] }) });
  const queryOption = audience.startsWith('query:') && !views.data?.some((v) => `query:${v.query}` === audience);
  return (
    <Page title="Call queues" subtitle="Work through businesses and your own contacts one call at a time. Outcomes improve the data for everyone."
      actions={<Button variant="primary" onClick={() => setOpen(true)}><Plus className="size-4" />New call queue</Button>}>
      {isLoading && <Spinner />}
      {data?.length === 0 && <div className={card}><Empty icon={<PhoneCall className="size-10" />} title="No call queues yet">Create one from a list, a saved view, or numbers you type in or import from Excel. Only numbers not on your do-not-contact list are added.</Empty></div>}
      <div className="grid gap-3 sm:grid-cols-2">
        {data?.map((qu) => (
          <div key={qu.id} className={cx(card, 'p-4')}>
            <div className="flex items-start gap-2">
              <Link to={`/calls/${qu.id}`} className="min-w-0 flex-1"><div className="truncate font-semibold hover:underline">{qu.name}</div><div className="text-sm text-slate-500">{qu.total.toLocaleString()} numbers · {new Date(qu.created_at).toLocaleDateString()}</div></Link>
              <button className="rounded p-1.5 text-slate-300 hover:bg-rose-50 hover:text-rose-600" onClick={() => confirmAction('The queue and its call log are deleted.', () => del.mutateAsync(qu.id), { title: 'Delete this call queue?', confirmLabel: 'Delete', success: 'Call queue deleted' })} aria-label="Delete queue"><Trash2 className="size-4" /></button>
            </div>
            <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"><div className="bg-emerald-500" style={{ width: `${(qu.done / Math.max(1, qu.total)) * 100}%` }} /><div className="bg-brand-500" style={{ width: `${(qu.callbacks / Math.max(1, qu.total)) * 100}%` }} /></div>
            <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-500"><span>{qu.pending} to call</span><span>{qu.callbacks} call-backs</span><span>{qu.done} done</span><span className="text-emerald-600">{qu.interested} interested</span></div>
            <Button size="sm" variant="primary" className="mt-3" onClick={() => navigate(`/calls/${qu.id}`)}><Phone className="size-3.5" />Start calling</Button>
          </div>
        ))}
      </div>
      <Modal open={open} onClose={() => setOpen(false)} title="New call queue" wide
        footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" disabled={!name.trim() || (!audience && !(byHand && typed.length)) || create.isPending} onClick={() => create.mutate()}>Create queue</Button></>}>
        <div className="space-y-4">
          <label className="block space-y-1.5"><span className="text-sm font-medium">Name</span><input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Bogura pharmacies, week 45" className={input} /></label>
          <label className="block space-y-1.5"><span className="text-sm font-medium">Who to call</span>
            <select value={audience} onChange={(e) => setAudience(e.target.value)} className={input}>
              <option value="">{byHand ? 'No list: only the numbers added below' : 'Choose a list or saved view…'}</option>
              {queryOption && <option value={audience}>Current Explore filter</option>}
              <optgroup label="Lists">{lists.data?.map((l) => <option key={l.id} value={`list:${l.id}`}>{l.name} ({l.n} businesses{l.contacts ? `, ${l.contacts} contacts` : ''})</option>)}</optgroup>
              <optgroup label="Saved views">{views.data?.map((v) => <option key={v.id} value={`query:${v.query}`}>{v.name}</option>)}</optgroup>
            </select>
            <span className="block text-xs text-slate-500">A list's own contacts (typed in or imported) are included when they have a phone number.</span></label>
          {byHand ? (
            <div className="space-y-2 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
              <div className="flex items-center justify-between"><span className="text-sm font-medium">Numbers added by hand</span>
                <button className="text-xs text-slate-500 hover:text-rose-600" onClick={() => { setByHand(false); setContacts([]); }}>Remove</button></div>
              <ContactImport value={contacts} onChange={setContacts} channel="phone" />
            </div>
          ) : (
            <Button size="sm" onClick={() => setByHand(true)}><UserPlus className="size-3.5" />Add numbers by hand or from Excel</Button>
          )}
          <label className="block space-y-1.5"><span className="text-sm font-medium">Call script (shown to the caller)</span>
            <textarea value={script} onChange={(e) => setScript(e.target.value)} rows={5} className="w-full rounded-lg border border-slate-200 bg-white p-3 text-sm dark:border-slate-700 dark:bg-slate-900" /></label>
          <p className="text-xs text-slate-500">Up to 5,000 numbers, ordered by district and area so calls follow a route. Each number appears once.</p>
          {create.error && <p className="text-sm text-rose-600">{(create.error as Error).message}</p>}
        </div>
      </Modal>
    </Page>
  );
}

export function CallWork({ id }: { id: string }) {
  const qc = useQueryClient();
  const queue = useQuery({ queryKey: ['queue', id], queryFn: () => out.queue(id) });
  const [current, setCurrent] = useState<NextCall | null>(null);
  const [notes, setNotes] = useState('');
  const [callbackAt, setCallbackAt] = useState('');
  const [waOptIn, setWaOptIn] = useState(false);
  const next = useMutation({ mutationFn: () => out.nextCall(id), onSuccess: (r) => { setCurrent(r); setNotes(''); setCallbackAt(''); setWaOptIn(false); } });
  const log = useMutation({
    mutationFn: (outcome: string) => out.outcome(current!.item!.id, { outcome, notes: notes || undefined, callback_at: outcome === 'callback' && callbackAt ? new Date(callbackAt).toISOString() : undefined, whatsapp_opt_in: waOptIn || undefined }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['queue', id] }); qc.invalidateQueries({ queryKey: ['queues'] }); next.mutate(); },
  });
  const skip = useMutation({ mutationFn: () => out.skipCall(current!.item!.id), onSuccess: () => next.mutate() });
  const q = queue.data;
  if (queue.isLoading) return <div className="p-8"><Spinner /></div>;
  if (!q) return <p className="p-8 text-rose-600">{(queue.error as Error)?.message}</p>;
  const b = current?.biz;

  return (
    <Page back="/calls" title={q.name} subtitle={<>Calling hours {q.hours.start}:00–{q.hours.end}:00 (Dhaka) · now {q.hours.now}:00 {q.hours.open ? <Badge tone="green">open</Badge> : <Badge tone="amber">closed</Badge>}</>}>
      <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
        <section className={cx(card, 'p-5')}>
          {!current && (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <PhoneCall className="size-10 text-slate-300" />
              <p className="text-sm text-slate-500">Press start to get the next business. Call-backs that are due come first.</p>
              <Button variant="primary" onClick={() => next.mutate()} disabled={next.isPending}>{next.isPending ? <Spinner className="size-3.5 border-white/40 border-t-white" /> : <Phone className="size-4" />}Start calling</Button>
            </div>
          )}
          {current?.outside_hours && <div className="flex flex-col items-center gap-2 py-10 text-center"><Clock className="size-10 text-amber-400" /><p className="font-medium">Outside calling hours</p><p className="text-sm text-slate-500">Calls are allowed {current.hours?.start}:00–{current.hours?.end}:00 Dhaka time. Admins can change this in Settings → Sending.</p></div>}
          {current?.done && <div className="flex flex-col items-center gap-2 py-10 text-center"><CheckCircle2 className="size-10 text-emerald-500" /><p className="font-medium">Nothing left to call right now</p><p className="text-sm text-slate-500">Scheduled call-backs will appear here when they are due.</p></div>}
          {current?.item && b && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  {b.own ? <div className="text-lg font-semibold">{b.name}</div> : <Link to={`/business/${encodeURIComponent(b.id)}`} className="text-lg font-semibold hover:underline">{b.name}</Link>}
                  <div className="flex items-center gap-1.5 text-sm text-slate-500">{b.cat_label}{b.own && <Badge tone="violet">own contact</Badge>}</div>
                  {b.own && b.email && <div className="mt-1 flex items-center gap-1 text-sm text-slate-500"><Mail className="size-3.5" />{b.email}</div>}
                  <div className="mt-1 flex items-center gap-1 text-sm text-slate-500"><MapPin className="size-3.5" />{[b.area, b.upazila, b.district?.replace(/ District$/, '')].filter(Boolean).join(', ') || '—'}</div>
                </div>
                {current.item.status === 'callback' && <Badge tone="blue">call-back</Badge>}
                {current.item.attempts > 0 && <Badge>attempt {current.item.attempts + 1}</Badge>}
              </div>
              <a href={`tel:${current.item.phone}`} className="flex items-center justify-center gap-2 rounded-xl bg-emerald-600 py-3 text-lg font-semibold text-white hover:bg-emerald-700">
                <Phone className="size-5" />{current.item.phone}</a>
              <p className="text-center text-xs text-slate-500">Tap to call from your phone.{b.own ? ' Number from your own contacts.' : ` Number status: ${b.phone_status ?? 'unverified'}.`}</p>
              {b.own && b.note && <div className="text-xs text-slate-500">Contact note: {b.note}</div>}
              {current.script && <div className="rounded-xl bg-slate-50 p-3 text-sm dark:bg-slate-800/60"><div className="mb-1 text-xs font-medium uppercase text-slate-400">Script</div><p className="whitespace-pre-wrap">{current.script.replace(/\{\{\s*category\s*\}\}\s?/g, b.own ? '' : `${b.cat_label.toLowerCase()} `).replace(/\{\{\s*name\s*\}\}/g, b.name)}</p></div>}
              {!!current.history?.length && <div className="text-xs text-slate-500">Earlier calls: {current.history.map((h) => `${OUTCOME_LABEL[h.outcome] ?? h.outcome} (${new Date(h.called_at).toLocaleDateString()})`).join(' · ')}</div>}
              {current.item.notes && <div className="text-xs text-slate-500">Notes: {current.item.notes}</div>}
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Notes (who you spoke to, what they need…)" className="w-full rounded-lg border border-slate-200 bg-white p-2 text-sm dark:border-slate-700 dark:bg-slate-900" />
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={waOptIn} onChange={(e) => setWaOptIn(e.target.checked)} className="size-4 accent-emerald-600" />
                <MessageCircle className="size-4 text-emerald-600" />They agreed to receive WhatsApp messages (recorded as opt-in with your name and time)</label>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {OUTCOME_BUTTONS.filter(([k]) => !b.own || k !== 'not_a_business').map(([k, cls]) => (
                  <button key={k} disabled={log.isPending || (k === 'callback' && !callbackAt)} onClick={() => (k === 'do_not_call' ? confirmAction('It will not be called, messaged or emailed again from this workspace.', () => log.mutateAsync(k), { title: 'Add to do-not-contact list?', confirmLabel: 'Do not call', success: 'Added to do-not-contact list' }) : log.mutate(k))}
                    className={cx('rounded-lg border border-slate-200 px-2 py-2 text-sm font-medium disabled:opacity-40 dark:border-slate-700', cls || 'hover:bg-slate-50 dark:hover:bg-slate-800', cls.includes('text-white') && 'border-transparent')}>
                    {OUTCOME_LABEL[k]}</button>
                ))}
              </div>
              <label className="flex flex-wrap items-center gap-2 text-sm"><span className="text-slate-500">Call back at</span><input type="datetime-local" value={callbackAt} onChange={(e) => setCallbackAt(e.target.value)} className={cx(input, 'w-auto')} /><span className="text-xs text-slate-400">then press “Call back”</span></label>
              <div className="flex justify-between"><Button size="sm" variant="ghost" onClick={() => skip.mutate()}><SkipForward className="size-4" />Skip</Button>{(log.error || skip.error) && <span className="text-sm text-rose-600">{((log.error ?? skip.error) as Error).message}</span>}</div>
            </div>
          )}
        </section>
        <aside className="space-y-4">
          <section className={cx(card, 'p-4')}>
            <h2 className="mb-2 text-sm font-semibold">Progress</h2>
            <ul className="space-y-1 text-sm">{q.outcomes.map((o) => <li key={o.k} className="flex justify-between"><span className="text-slate-600 dark:text-slate-300">{OUTCOME_LABEL[o.k] ?? o.k}</span><b className="tabular-nums">{o.n}</b></li>)}</ul>
          </section>
          <section className={cx(card, 'p-4')}>
            <h2 className="mb-2 text-sm font-semibold">Recent calls</h2>
            {q.recent.length === 0 && <p className="text-xs text-slate-500">None yet.</p>}
            <ul className="space-y-2 text-sm">{q.recent.slice(0, 12).map((r) => (
              <li key={r.id}><div className="truncate font-medium">{r.name}</div><div className="text-xs text-slate-500">{OUTCOME_LABEL[r.outcome ?? ''] ?? r.outcome} · {new Date(r.called_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{r.called_by ? ` · ${r.called_by}` : ''}</div></li>
            ))}</ul>
          </section>
        </aside>
      </div>
    </Page>
  );
}
