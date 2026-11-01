import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageCircle, Send, Lock, CheckCheck, Plus, ShieldCheck, Beaker, X } from 'lucide-react';
import { out, type WaTemplate } from '../lib/outreach';
import { Link, navigate, useLocation } from '../lib/router';
import { Badge, Button, Empty, Modal, Spinner, cx } from '../components/ui';
import { Page, TestModeBanner } from './CampaignPages';

const card = 'rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900';
const input = 'h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-900';
const showPhone = (p: string) => (p.startsWith('880') ? `+${p.slice(0, 3)} ${p.slice(3, 7)}-${p.slice(7)}` : p);
const METHOD_LABEL: Record<string, string> = { inbound_keyword: 'Customer wrote START/YES', web_form: 'Web form', call_verbal: 'Agreed on a call', written: 'Written / signed', other: 'Other' };

export function InboxPage() {
  const { path, search } = useLocation();
  const tab = path === '/inbox/optins' ? 'optins' : 'inbox';
  const status = new URLSearchParams(search).get('status') === 'closed' ? 'closed' : 'open';
  const selected = new URLSearchParams(search).get('c');
  const settings = useQuery({ queryKey: ['sending'], queryFn: out.sending });
  return (
    <Page title="Inbox" subtitle="WhatsApp conversations with businesses, and the opt-ins that allow you to message them.">
      {settings.data?.whatsapp.mode === 'test' && <TestModeBanner what="WhatsApp is not connected. Messages are stored but not delivered; use “Simulate incoming” to try replies, START and STOP." />}
      <div className="mb-4 flex gap-1 border-b border-slate-200 dark:border-slate-800">
        <Link to="/inbox" className={cx('-mb-px border-b-2 px-3 py-2 text-sm font-medium', tab === 'inbox' ? 'border-brand-600 text-brand-700 dark:text-brand-100' : 'border-transparent text-slate-500')}>Conversations</Link>
        <Link to="/inbox/optins" className={cx('-mb-px border-b-2 px-3 py-2 text-sm font-medium', tab === 'optins' ? 'border-brand-600 text-brand-700 dark:text-brand-100' : 'border-transparent text-slate-500')}>Opt-ins</Link>
      </div>
      {tab === 'optins' ? <OptIns /> : <Conversations status={status} selected={selected} testMode={settings.data?.whatsapp.mode === 'test'} />}
    </Page>
  );
}

function Conversations({ status, selected, testMode }: { status: 'open' | 'closed'; selected: string | null; testMode: boolean }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['inbox', status], queryFn: () => out.inbox(status), refetchInterval: 8000 });
  const [sim, setSim] = useState(false);
  const [simPhone, setSimPhone] = useState('01712000002');
  const [simText, setSimText] = useState('Hello, what is the price?');
  const [startOpen, setStartOpen] = useState(false);
  const [startPhone, setStartPhone] = useState('');
  const simulate = useMutation({ mutationFn: () => out.simulate(simPhone, simText), onSuccess: () => { setSim(false); qc.invalidateQueries({ queryKey: ['inbox'] }); qc.invalidateQueries({ queryKey: ['inbox-unread'] }); } });
  const start = useMutation({ mutationFn: () => out.startConversation(startPhone), onSuccess: (r) => { setStartOpen(false); qc.invalidateQueries({ queryKey: ['inbox'] }); navigate(`/inbox?c=${r.id}`); } });
  const go = (id: string) => navigate(`/inbox?${status === 'closed' ? 'status=closed&' : ''}c=${id}`, true);
  return (
    <div className="grid gap-4 md:grid-cols-[300px_1fr]">
      <div className={cx(card, 'flex max-h-[70vh] flex-col overflow-hidden', selected && 'hidden md:flex')}>
        <div className="flex items-center gap-1 border-b border-slate-100 p-2 dark:border-slate-800">
          <Link to="/inbox" className={cx('rounded-md px-2 py-1 text-xs font-medium', status === 'open' ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900' : 'text-slate-500')}>Open</Link>
          <Link to="/inbox?status=closed" className={cx('rounded-md px-2 py-1 text-xs font-medium', status === 'closed' ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900' : 'text-slate-500')}>Closed</Link>
          <div className="ml-auto flex gap-1">
            {testMode && <Button size="sm" variant="ghost" onClick={() => setSim(true)} title="Simulate an incoming message (test mode)"><Beaker className="size-3.5" /></Button>}
            <Button size="sm" variant="ghost" onClick={() => setStartOpen(true)} title="New conversation"><Plus className="size-4" /></Button>
          </div>
        </div>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          {isLoading && <div className="p-4"><Spinner /></div>}
          {data?.length === 0 && <p className="p-4 text-sm text-slate-500">No {status} conversations.</p>}
          {data?.map((c) => (
            <button key={c.id} onClick={() => go(c.id)} className={cx('flex w-full gap-2 border-b border-slate-50 px-3 py-2.5 text-left hover:bg-slate-50 dark:border-slate-800/60 dark:hover:bg-slate-800/50', selected === c.id && 'bg-brand-50/60 dark:bg-brand-500/10')}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5"><span className="truncate text-sm font-medium">{c.biz_name ?? c.contact_name ?? showPhone(c.address)}</span>{c.opted_in && <span title="Opted in"><ShieldCheck className="size-3.5 shrink-0 text-emerald-600" /></span>}</div>
                <div className="truncate text-xs text-slate-500">{c.preview}</div>
              </div>
              <div className="flex flex-col items-end gap-1"><span className="text-[10px] text-slate-400">{new Date(c.last_message_at).toLocaleDateString()}</span>{c.unread > 0 && <span className="rounded-full bg-emerald-600 px-1.5 text-[10px] font-semibold text-white">{c.unread}</span>}</div>
            </button>
          ))}
        </div>
      </div>
      <div className={cx(!selected && 'hidden md:block')}>
        {selected ? <ThreadView id={selected} onBack={() => navigate(status === 'closed' ? '/inbox?status=closed' : '/inbox', true)} /> : <div className={cx(card, 'h-full')}><Empty icon={<MessageCircle className="size-10" />} title="Choose a conversation" /></div>}
      </div>
      <Modal open={sim} onClose={() => setSim(false)} title="Simulate an incoming WhatsApp message" footer={<><Button onClick={() => setSim(false)}>Cancel</Button><Button variant="primary" onClick={() => simulate.mutate()}>Receive</Button></>}>
        <div className="space-y-3 text-sm">
          <p className="text-slate-500">Test mode only. Try “START” (opt in), “STOP” (opt out) or a normal question.</p>
          <input value={simPhone} onChange={(e) => setSimPhone(e.target.value)} className={input} placeholder="01712345678" />
          <input value={simText} onChange={(e) => setSimText(e.target.value)} className={input} />
          {simulate.error && <p className="text-rose-600">{(simulate.error as Error).message}</p>}
        </div>
      </Modal>
      <Modal open={startOpen} onClose={() => setStartOpen(false)} title="New conversation" footer={<><Button onClick={() => setStartOpen(false)}>Cancel</Button><Button variant="primary" disabled={!startPhone} onClick={() => start.mutate()}>Open</Button></>}>
        <div className="space-y-2 text-sm">
          <input value={startPhone} onChange={(e) => setStartPhone(e.target.value)} placeholder="Mobile number, e.g. 01712345678" className={input} />
          <p className="text-xs text-slate-500">You can only start with an approved template, and only if this number has a recorded opt-in.</p>
          {start.error && <p className="text-rose-600">{(start.error as Error).message}</p>}
        </div>
      </Modal>
    </div>
  );
}

function ThreadView({ id, onBack }: { id: string; onBack: () => void }) {
  const qc = useQueryClient();
  const { data: t, isLoading } = useQuery({ queryKey: ['thread', id], queryFn: () => out.thread(id), refetchInterval: 6000 });
  const [text, setText] = useState('');
  const [tplOpen, setTplOpen] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); qc.invalidateQueries({ queryKey: ['inbox-unread'] }); }, [t?.messages.length, qc]);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['thread', id] }); qc.invalidateQueries({ queryKey: ['inbox'] }); };
  const reply = useMutation({ mutationFn: () => out.reply(id, text.trim()), onSuccess: () => { setText(''); refresh(); } });
  const setStatus = useMutation({ mutationFn: (s: 'open' | 'closed') => out.setConversation(id, { status: s }), onSuccess: refresh });
  if (isLoading || !t) return <div className={cx(card, 'p-6')}><Spinner /></div>;
  return (
    <div className={cx(card, 'flex max-h-[70vh] min-h-96 flex-col overflow-hidden')}>
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
        <button className="md:hidden" onClick={onBack} aria-label="Back"><X className="size-4" /></button>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{t.biz?.name ?? t.contact_name ?? showPhone(t.address)}</div>
          <div className="text-xs text-slate-500">{showPhone(t.address)}{t.biz && <> · <Link to={`/business/${encodeURIComponent(t.biz.id)}`} className="hover:underline">business record</Link></>}</div>
        </div>
        {t.consent ? <Badge tone="green" title={t.consent.proof}><ShieldCheck className="size-3" />opted in</Badge> : <Badge tone="amber">no opt-in</Badge>}
        <Button size="sm" variant="ghost" onClick={() => setStatus.mutate(t.status === 'open' ? 'closed' : 'open')}>{t.status === 'open' ? 'Close' : 'Reopen'}</Button>
      </div>
      <div className="scroll-thin min-h-0 flex-1 space-y-2 overflow-y-auto bg-slate-50/60 p-4 dark:bg-slate-950/40">
        {t.messages.map((m) => (
          <div key={m.id} className={cx('flex', m.direction === 'out' ? 'justify-end' : 'justify-start')}>
            <div className={cx('max-w-[80%] rounded-2xl px-3 py-2 text-sm shadow-sm', m.direction === 'out' ? 'rounded-br-sm bg-emerald-100 text-emerald-950 dark:bg-emerald-900/50 dark:text-emerald-50' : 'rounded-bl-sm bg-white dark:bg-slate-800')}>
              {m.template && <div className="mb-0.5 text-[10px] font-medium uppercase text-emerald-700 dark:text-emerald-300">template · {m.template}</div>}
              <div className="whitespace-pre-wrap">{m.body}</div>
              <div className="mt-0.5 flex items-center justify-end gap-1 text-[10px] text-slate-500">{new Date(m.created_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}{m.sent_by ? ` · ${m.sent_by}` : ''}{m.direction === 'out' && <><CheckCheck className="size-3" />{m.status}</>}</div>
              {m.error && <div className="text-[10px] text-rose-600">{m.error}</div>}
            </div>
          </div>
        ))}
        <div ref={end} />
      </div>
      <div className="border-t border-slate-100 p-3 dark:border-slate-800">
        {t.window_open ? (
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (text.trim()) reply.mutate(); }}>
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type a reply…" className={input} />
            <Button variant="primary" disabled={!text.trim() || reply.isPending}><Send className="size-4" /></Button>
          </form>
        ) : (
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <Lock className="size-3.5" /><span className="flex-1">The 24-hour reply window is closed (or they have not written yet). WhatsApp only allows an approved template{t.consent ? '' : ', and only after an opt-in'}.</span>
            <Button size="sm" onClick={() => setTplOpen(true)}>Send template</Button>
          </div>
        )}
        {t.window_open && t.window_closes_at && <p className="mt-1 text-[10px] text-slate-400">Free replies allowed until {new Date(t.window_closes_at).toLocaleString()}.</p>}
        {reply.error && <p className="mt-1 text-xs text-rose-600">{(reply.error as Error).message}</p>}
      </div>
      <TemplateDialog open={tplOpen} onClose={() => setTplOpen(false)} conversationId={id} name={t.biz?.name ?? t.contact_name ?? ''} area={t.biz?.area ?? t.biz?.district ?? ''} onSent={refresh} />
    </div>
  );
}

function TemplateDialog({ open, onClose, conversationId, name, area, onSent }: { open: boolean; onClose: () => void; conversationId: string; name: string; area: string; onSent: () => void }) {
  const { data } = useQuery({ queryKey: ['wa-templates'], queryFn: out.templates, enabled: open });
  const [tpl, setTpl] = useState<WaTemplate | null>(null);
  const [params, setParams] = useState<string[]>([]);
  const send = useMutation({ mutationFn: () => out.sendTemplate(conversationId, tpl!.name, tpl!.language, params), onSuccess: () => { onClose(); onSent(); } });
  const pick = (n: string) => { const t = data?.templates.find((x) => x.name === n) ?? null; setTpl(t); setParams(t ? Array.from({ length: t.params }, (_, i) => (i === 0 ? name : i === 1 ? area : '')) : []); };
  return (
    <Modal open={open} onClose={onClose} title="Send an approved template" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!tpl || send.isPending} onClick={() => send.mutate()}>Send</Button></>}>
      <div className="space-y-3 text-sm">
        <select value={tpl?.name ?? ''} onChange={(e) => pick(e.target.value)} className={input}><option value="">Choose…</option>{data?.templates.map((t) => <option key={t.name} value={t.name}>{t.name} ({t.language})</option>)}</select>
        {tpl && <div className="rounded-xl bg-emerald-50 p-3 dark:bg-emerald-500/10">{tpl.body.replace(/\{\{(\d+)\}\}/g, (_, i: string) => params[Number(i) - 1] || `{{${i}}}`)}</div>}
        {params.map((v, i) => <input key={i} value={v} onChange={(e) => setParams(params.map((x, j) => (j === i ? e.target.value : x)))} placeholder={`{{${i + 1}}}`} className={input} />)}
        {send.error && <p className="text-rose-600">{(send.error as Error).message}</p>}
      </div>
    </Modal>
  );
}

function OptIns() {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const { data, isLoading } = useQuery({ queryKey: ['consents', q], queryFn: () => out.consents(q) });
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState('');
  const [method, setMethod] = useState('written');
  const [proof, setProof] = useState('');
  const add = useMutation({ mutationFn: () => out.addConsent({ address: phone, method, proof }), onSuccess: () => { setOpen(false); setPhone(''); setProof(''); qc.invalidateQueries({ queryKey: ['consents'] }); } });
  const revoke = useMutation({ mutationFn: out.revokeConsent, onSuccess: () => qc.invalidateQueries({ queryKey: ['consents'] }) });
  return (
    <>
      <div className="mb-4 flex flex-wrap gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search number…" className={cx(input, 'max-w-xs')} />
        <Button variant="primary" className="ml-auto" onClick={() => setOpen(true)}><Plus className="size-4" />Record opt-in</Button>
      </div>
      <p className="mb-3 text-xs text-slate-500">WhatsApp requires that a business has agreed to receive your messages before you send them marketing templates. Keep proof of how they agreed: Meta can ask for it.</p>
      {isLoading && <Spinner />}
      {data?.length === 0 && <div className={card}><Empty icon={<ShieldCheck className="size-10" />} title="No opt-ins yet">Opt-ins are created when a business writes START or YES, when a caller ticks the WhatsApp box after a call, or when you record one here.</Empty></div>}
      {!!data?.length && (
        <div className={cx(card, 'overflow-x-auto')}>
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-slate-500"><tr><th className="px-4 py-2.5 font-medium">Number</th><th className="font-medium">Business</th><th className="font-medium">How</th><th className="hidden font-medium md:table-cell">Proof</th><th className="font-medium">Status</th><th /></tr></thead>
            <tbody>{data.map((c) => (
              <tr key={c.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="px-4 py-2 tabular-nums">{showPhone(c.address)}</td>
                <td className="max-w-40 truncate">{c.biz_name ?? '—'}</td>
                <td className="text-xs">{METHOD_LABEL[c.method] ?? c.method}<div className="text-slate-400">{new Date(c.created_at).toLocaleDateString()}{c.recorded_by ? ` · ${c.recorded_by}` : ''}</div></td>
                <td className="hidden max-w-64 truncate text-xs text-slate-500 md:table-cell" title={c.proof}>{c.proof}</td>
                <td>{c.revoked_at ? <Badge tone="rose" title={c.revoked_reason ?? ''}>revoked</Badge> : <Badge tone="green">active</Badge>}</td>
                <td className="px-3 text-right">{!c.revoked_at && <Button size="sm" variant="ghost" onClick={() => confirm('Revoke this opt-in? The number will be added to your do-not-contact list.') && revoke.mutate(c.id)}>Revoke</Button>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title="Record a WhatsApp opt-in" footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" disabled={add.isPending} onClick={() => add.mutate()}>Save</Button></>}>
        <div className="space-y-3 text-sm">
          <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Mobile number, e.g. 01712345678" className={input} />
          <select value={method} onChange={(e) => setMethod(e.target.value)} className={input}>
            <option value="written">Written / signed form</option><option value="web_form">Web form</option><option value="call_verbal">Agreed on a call</option><option value="other">Other</option>
          </select>
          <textarea value={proof} onChange={(e) => setProof(e.target.value)} rows={3} placeholder="Proof: who agreed, when and how (e.g. 'Owner Mr. Karim signed our form at the Dhaka trade fair on 1 Nov 2026')" className="w-full rounded-lg border border-slate-200 bg-white p-2 dark:border-slate-700 dark:bg-slate-900" />
          {add.error && <p className="text-rose-600">{(add.error as Error).message}</p>}
        </div>
      </Modal>
    </>
  );
}
