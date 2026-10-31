import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X, Phone, Mail, MessageCircle, ListPlus, MapPin, ExternalLink, Flag, Lock, Maximize2, Building2, History } from 'lucide-react';
import { api, type BusinessDetail } from '../lib/api';
import { Link } from '../lib/router';
import { Badge, Button, LayerBadge, RecordStatusBadge, ScoreBar, Spinner, VerifyIcon, catColor, cx } from './ui';

const SOURCE_LABEL: Record<string, string> = {
  osm: 'OpenStreetMap', overture: 'Overture Maps', meta_ad_library_manual: 'Meta Ad Library (collected by hand)',
  firecrawl_search: 'Web search', firecrawl_scrape: 'Business website',
};
const sourceOf = (s: string | null) => !s ? 'unknown source' : s.startsWith('overture:') ? 'Overture (mostly Facebook-derived)' : s.includes('openstreetmap.org') ? 'OpenStreetMap' : s === 'meta_ad_library_manual' ? 'Meta Ad Library' : s.replace(/^https?:\/\/(www\.)?/, '').split('/')[0]!;
const STATUS_TEXT = { verified: 'verified', search_match: 'search match', unverified: 'unverified', invalid: 'invalid' } as const;
const REPORT_KINDS = [['wrong_phone', 'Wrong phone number'], ['wrong_email', 'Wrong email'], ['closed', 'Business closed'], ['not_a_business', 'Not a business'],
  ['wrong_category', 'Wrong category'], ['wrong_location', 'Wrong location'], ['duplicate', 'Duplicate'], ['other', 'Other']] as const;

function Block({ title, icon, children }: { title: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-t border-slate-100 px-5 py-4 dark:border-slate-800">
      <h3 className="mb-2.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">{icon}{title}</h3>
      {children}
    </section>
  );
}

export function DetailBody({ b, catOrder, onOpen, onAddToList, compact }: { b: BusinessDetail; catOrder: string[]; onOpen: (id: string) => void; onAddToList: (ids: string[]) => void; compact?: boolean }) {
  const qc = useQueryClient();
  const [reportKind, setReportKind] = useState<string>('');
  const [note, setNote] = useState('');
  const report = useMutation({ mutationFn: () => api.report(b.id, reportKind, note), onSuccess: () => { setReportKind(''); setNote(''); qc.invalidateQueries({ queryKey: ['business', b.id] }); } });
  const phone = b.contacts.find((c) => c.type === 'phone' && c.status !== 'invalid');
  const email = b.contacts.find((c) => c.type === 'email' && c.status !== 'invalid');
  const loc = [b.area, b.upazila, b.district?.replace(/ District$/, ''), b.division?.replace(/ Division$/, '')].filter(Boolean);

  return (
    <div>
      <div className="px-5 pb-4 pt-1">
        <div className="flex flex-wrap items-center gap-1.5 pb-2">
          <RecordStatusBadge status={b.status} /><LayerBadge layer={b.layer} />
          {b.fcommerce ? <Badge tone="violet">F-commerce</Badge> : null}
          {b.src_conf !== null && <Badge title="Confidence reported by Overture">source conf. {b.src_conf.toFixed(2)}</Badge>}
        </div>
        <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
          <span className="size-2.5 rounded-full" style={{ background: catColor(b.cat, catOrder) }} />
          {b.cat_label}{b.sub_label && b.sub_label !== b.cat_label ? <span className="text-slate-400">› {b.sub_label}</span> : null}
        </div>
        {loc.length > 0 && <div className="mt-1 flex items-center gap-1.5 text-sm text-slate-500"><MapPin className="size-3.5" />{loc.join(', ')}</div>}
        {b.description && <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{b.description}</p>}
        <div className="mt-3"><ScoreBar score={b.score} /></div>

        <div className="mt-4 grid grid-cols-4 gap-2">
          <a href={phone ? `tel:${phone.value}` : undefined} className={cx('flex flex-col items-center gap-1 rounded-xl border border-slate-200 py-2.5 text-xs font-medium dark:border-slate-700', phone ? 'hover:bg-slate-50 dark:hover:bg-slate-800' : 'pointer-events-none opacity-40')}>
            <Phone className="size-4 text-emerald-600" />Call</a>
          <a href={email ? `mailto:${email.value}` : undefined} className={cx('flex flex-col items-center gap-1 rounded-xl border border-slate-200 py-2.5 text-xs font-medium dark:border-slate-700', email ? 'hover:bg-slate-50 dark:hover:bg-slate-800' : 'pointer-events-none opacity-40')}>
            <Mail className="size-4 text-brand-600" />Email</a>
          <div title="WhatsApp marketing needs a recorded opt-in from this business (WhatsApp Business policy). Opt-in capture arrives in Phase 4."
            className="flex cursor-not-allowed flex-col items-center gap-1 rounded-xl border border-dashed border-slate-200 py-2.5 text-xs font-medium text-slate-400 dark:border-slate-700">
            <span className="relative"><MessageCircle className="size-4" /><Lock className="absolute -bottom-1 -right-1.5 size-2.5" /></span>WhatsApp</div>
          <button onClick={() => onAddToList([b.id])} className="flex flex-col items-center gap-1 rounded-xl border border-slate-200 py-2.5 text-xs font-medium hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">
            <ListPlus className="size-4 text-violet-600" />List</button>
        </div>
        {b.lists.length > 0 && <div className="mt-2 flex flex-wrap gap-1 text-xs text-slate-500">In: {b.lists.map((l) => <Link key={l.id} to={`/?list=${l.id}`}><Badge tone="blue">{l.name}</Badge></Link>)}</div>}
      </div>

      <Block title="Contacts">
        {b.contacts.length + b.socials.length === 0 && <p className="text-sm text-slate-500">No public contact details found. That doesn't mean none exist.</p>}
        <ul className="space-y-2.5">
          {[...b.contacts.map((c) => ({ k: c.type, v: c.value, s: c.status, src: c.source, href: c.type === 'website' ? c.value : c.type === 'email' ? `mailto:${c.value}` : `tel:${c.value}` })),
            ...b.socials.map((s) => ({ k: s.platform, v: s.url.replace(/^https?:\/\/(www\.)?/, ''), s: s.status, src: s.source, href: s.url }))].map((c, i) => (
            <li key={i} className="flex items-start gap-2.5 text-sm">
              <VerifyIcon status={c.s} className="mt-0.5" />
              <div className="min-w-0 flex-1">
                <a href={c.href} target={c.k === 'phone' || c.k === 'email' ? undefined : '_blank'} rel="noreferrer" className={cx('block truncate hover:underline', c.s === 'invalid' && 'line-through opacity-60')}>{c.v}</a>
                <div className="text-xs text-slate-400">{c.k} · {STATUS_TEXT[(c.s ?? 'unverified') as keyof typeof STATUS_TEXT]} · from {sourceOf(c.src)}</div>
              </div>
            </li>
          ))}
        </ul>
      </Block>

      {b.nearby.length > 0 && (
        <Block title="Nearby (within 500 m)" icon={<MapPin className="size-3.5" />}>
          <ul className="space-y-1">
            {b.nearby.map((n) => (
              <li key={n.id}><button onClick={() => onOpen(n.id)} className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800">
                <span className="size-2 shrink-0 rounded-full" style={{ background: catColor(n.cat, catOrder) }} /><span className="flex-1 truncate">{n.name}</span>
                <span className="text-xs tabular-nums text-slate-400">{Math.round(n.distance_km * 1000)} m</span></button></li>
            ))}
          </ul>
        </Block>
      )}

      {b.branches.length > 0 && (
        <Block title={`Same name elsewhere (${b.branches.length}${b.branches.length === 20 ? '+' : ''})`} icon={<Building2 className="size-3.5" />}>
          <ul className="space-y-1">{b.branches.map((x) => <li key={x.id}><button onClick={() => onOpen(x.id)} className="w-full truncate rounded-md px-1.5 py-1 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800">{x.name} <span className="text-slate-400">· {x.area ?? x.district?.replace(/ District$/, '') ?? '—'}</span></button></li>)}</ul>
        </Block>
      )}

      <Block title="Data sources" icon={<History className="size-3.5" />}>
        <ol className="space-y-2 border-l border-slate-200 pl-3 dark:border-slate-700">
          {b.sources.map((s, i) => (
            <li key={i} className="text-sm">
              <div className="font-medium">{SOURCE_LABEL[s.type] ?? s.type}</div>
              <div className="text-xs text-slate-400">{s.fetched_at?.slice(0, 10)}{s.url && s.url.startsWith('http') && <> · <a className="hover:underline" href={s.url} target="_blank" rel="noreferrer">open <ExternalLink className="inline size-3" /></a></>}</div>
            </li>
          ))}
        </ol>
        {b.osm_url && <a href={b.osm_url} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs text-brand-600 hover:underline">View / correct on OpenStreetMap <ExternalLink className="size-3" /></a>}
      </Block>

      <Block title="Report a problem" icon={<Flag className="size-3.5" />}>
        {b.reports.length > 0 && <p className="mb-2 text-xs text-slate-500">{b.reports.length} report(s) already filed: {b.reports.map((r) => r.kind.replace('_', ' ')).join(', ')}</p>}
        <div className="flex flex-wrap gap-1.5">
          {REPORT_KINDS.map(([k, l]) => (
            <button key={k} onClick={() => setReportKind(reportKind === k ? '' : k)}
              className={cx('rounded-full border px-2.5 py-1 text-xs', reportKind === k ? 'border-rose-300 bg-rose-50 text-rose-700 dark:bg-rose-500/10' : 'border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800')}>{l}</button>
          ))}
        </div>
        {reportKind && (
          <div className="mt-2 space-y-2">
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Optional details (e.g. the correct number)"
              className="w-full rounded-lg border border-slate-200 bg-white p-2 text-sm dark:border-slate-700 dark:bg-slate-900" />
            <Button size="sm" variant="danger" onClick={() => report.mutate()} disabled={report.isPending}>{report.isPending ? <Spinner className="size-3" /> : <Flag className="size-3.5" />} Send report</Button>
          </div>
        )}
        {report.isSuccess && <p className="mt-2 text-xs text-emerald-600">Thanks: the report is queued for the data team.</p>}
      </Block>
      {!compact && <p className="border-t border-slate-100 px-5 py-3 text-[11px] text-slate-400 dark:border-slate-800">{b.attribution}</p>}
    </div>
  );
}

export function DetailDrawer({ id, onClose, onOpen, catOrder, onAddToList }: { id: string; onClose: () => void; onOpen: (id: string) => void; catOrder: string[]; onAddToList: (ids: string[]) => void }) {
  const { data: b, isLoading, error } = useQuery({ queryKey: ['business', id], queryFn: () => api.business(id) });
  return (
    <aside className="fixed inset-0 z-40 flex flex-col bg-white shadow-2xl dark:bg-slate-900 sm:inset-y-0 sm:left-auto sm:right-0 sm:w-[440px] sm:border-l sm:border-slate-200 dark:sm:border-slate-800">
      <header className="flex items-start gap-2 px-5 pb-2 pt-4">
        <h2 className="min-w-0 flex-1 text-lg font-semibold leading-snug">{b?.name ?? (isLoading ? 'Loading…' : 'Business')}</h2>
        <Link to={`/business/${encodeURIComponent(id)}`} className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800" title="Open full page"><Maximize2 className="size-4" /></Link>
        <button onClick={onClose} className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Close"><X className="size-5" /></button>
      </header>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {isLoading && <div className="flex justify-center py-16"><Spinner className="size-6" /></div>}
        {error && <p className="px-5 text-sm text-rose-600">{(error as Error).message}</p>}
        {b && <DetailBody b={b} catOrder={catOrder} onOpen={onOpen} onAddToList={onAddToList} />}
      </div>
    </aside>
  );
}
