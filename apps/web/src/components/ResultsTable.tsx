import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, Columns3, ChevronLeft, ChevronRight, Phone, Mail, Globe, Share2, Camera, Inbox } from 'lucide-react';
import type { BusinessRow } from '../lib/api';
import { Button, Checkbox, Empty, LayerBadge, RecordStatusBadge, ScoreBar, Spinner, VerifyIcon, catColor, cx } from './ui';

interface Col { id: string; label: string; width: number; sort?: string; render: (r: BusinessRow) => ReactNode; always?: boolean }

const ellipsis = 'block truncate';
const contact = (value: string | null, status: BusinessRow['phone_status'], icon: ReactNode, href?: string) =>
  value ? (
    <span className="flex min-w-0 items-center gap-1.5">
      <VerifyIcon status={status} />
      {href ? <a href={href} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className={cx(ellipsis, 'text-brand-700 hover:underline dark:text-brand-100')}>{value}</a> : <span className={ellipsis}>{value}</span>}
    </span>
  ) : <span className="text-slate-300 dark:text-slate-600">{icon}</span>;

const shortUrl = (u: string) => u.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');

function columns(catLabel: (id: string) => string, catOrder: string[], showDistance: boolean): Col[] {
  return [
    { id: 'name', label: 'Business', width: 260, sort: 'name', always: true, render: (r) => (
      <div className="min-w-0">
        <div className="truncate font-medium text-slate-900 dark:text-slate-100">{r.name}</div>
        <div className="flex items-center gap-1.5 pt-0.5"><LayerBadge layer={r.layer} />{r.fcommerce ? <span className="text-[11px] text-violet-600">F-commerce</span> : null}{r.parent ? <span className="text-[11px] text-slate-400">branch</span> : null}</div>
      </div>) },
    { id: 'category', label: 'Category', width: 170, sort: 'category', render: (r) => (
      <span className="flex min-w-0 items-center gap-2"><span className="size-2 shrink-0 rounded-full" style={{ background: catColor(r.cat, catOrder) }} /><span className={ellipsis}>{catLabel(r.cat)}</span></span>) },
    { id: 'location', label: 'Location', width: 190, sort: 'district', render: (r) => (
      <div className="min-w-0 text-xs leading-tight"><div className="truncate text-slate-700 dark:text-slate-200">{r.area ?? r.upazila ?? '—'}</div><div className="truncate text-slate-400">{r.district?.replace(/ District$/, '') ?? 'No district'}</div></div>) },
    ...(showDistance ? [{ id: 'distance', label: 'Distance', width: 90, sort: 'distance', render: (r: BusinessRow) => <span className="tabular-nums">{r.distance_km !== undefined ? `${r.distance_km < 1 ? Math.round(r.distance_km * 1000) + ' m' : r.distance_km.toFixed(1) + ' km'}` : '—'}</span> }] : []),
    { id: 'phone', label: 'Phone', width: 150, render: (r) => contact(r.phone, r.phone_status, <Phone className="size-3.5" />) },
    { id: 'email', label: 'Email', width: 190, render: (r) => contact(r.email, r.email_status, <Mail className="size-3.5" />) },
    { id: 'website', label: 'Website', width: 170, render: (r) => contact(r.website ? shortUrl(r.website) : null, r.website_status, <Globe className="size-3.5" />, r.website ?? undefined) },
    { id: 'facebook', label: 'Facebook', width: 160, render: (r) => contact(r.facebook ? shortUrl(r.facebook).replace(/^facebook\.com\//, '') : null, r.facebook_status, <Share2 className="size-3.5" />, r.facebook ?? undefined) },
    { id: 'instagram', label: 'Instagram', width: 140, render: (r) => contact(r.instagram ? shortUrl(r.instagram).replace(/^instagram\.com\//, '') : null, r.instagram_status, <Camera className="size-3.5" />, r.instagram ?? undefined) },
    { id: 'score', label: 'Score', width: 100, sort: 'score', render: (r) => <ScoreBar score={r.score} /> },
    { id: 'status', label: 'Status', width: 80, render: (r) => <RecordStatusBadge status={r.status} /> },
    { id: 'first_seen', label: 'First seen', width: 100, sort: 'first_seen', render: (r) => <span className="text-xs tabular-nums text-slate-500">{r.first_seen?.slice(0, 10)}</span> },
  ];
}

const DEFAULT_HIDDEN = ['instagram', 'first_seen'];

export function ResultsTable(props: {
  rows: BusinessRow[]; total: number; page: number; pageSize: number; loading: boolean;
  sort: string; dir: string; onSort: (key: string) => void; onPage: (p: number) => void; onPageSize: (n: number) => void;
  selected: Set<string>; allMatching: boolean; onToggle: (id: string) => void; onTogglePage: () => void; onSelectAllMatching: () => void; onClearSelection: () => void;
  onOpen: (id: string) => void; openId?: string; catLabel: (id: string) => string; catOrder: string[]; showDistance: boolean;
}) {
  const { rows, total, page, pageSize, loading } = props;
  const [hidden, setHidden] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem('table.hidden') ?? 'null') ?? DEFAULT_HIDDEN; } catch { return DEFAULT_HIDDEN; } });
  const [chooser, setChooser] = useState(false);
  useEffect(() => { try { localStorage.setItem('table.hidden', JSON.stringify(hidden)); } catch { /* ignore */ } }, [hidden]);
  const all = columns(props.catLabel, props.catOrder, props.showDistance);
  const cols = all.filter((c) => c.always || !hidden.includes(c.id));
  const width = 44 + cols.reduce((s, c) => s + c.width, 0);

  const scroller = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({ count: rows.length, getScrollElement: () => scroller.current, estimateSize: () => 52, overscan: 10 });
  useEffect(() => { scroller.current?.scrollTo({ top: 0 }); }, [page]);

  const pageIds = rows.map((r) => r.id);
  const pageAll = pageIds.length > 0 && pageIds.every((id) => props.selected.has(id));
  const pageSome = pageIds.some((id) => props.selected.has(id));
  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="flex h-full min-h-0 flex-col">
      {(props.allMatching || (pageAll && total > rows.length)) && (
        <div className="border-b border-brand-100 bg-brand-50 px-4 py-1.5 text-center text-xs text-brand-700 dark:border-brand-500/30 dark:bg-brand-500/10 dark:text-brand-100">
          {props.allMatching
            ? <>All <b>{total.toLocaleString()}</b> matching businesses are selected. <button className="font-semibold underline" onClick={props.onClearSelection}>Clear selection</button></>
            : <>All {rows.length} on this page are selected. <button className="font-semibold underline" onClick={props.onSelectAllMatching}>Select all {total.toLocaleString()} matching</button></>}
        </div>
      )}
      <div ref={scroller} className="scroll-thin relative min-h-0 flex-1 overflow-auto">
        <div style={{ width, minWidth: '100%' }}>
          <div className="sticky top-0 z-10 flex border-b border-slate-200 bg-slate-50/95 text-xs font-medium text-slate-500 backdrop-blur dark:border-slate-800 dark:bg-slate-900/95">
            <div className="flex w-11 shrink-0 items-center justify-center"><Checkbox checked={pageAll || props.allMatching} indeterminate={!pageAll && pageSome} onChange={props.onTogglePage} /></div>
            {cols.map((c) => (
              <div key={c.id} style={{ width: c.width }} className="shrink-0 px-3 py-2.5">
                {c.sort ? (
                  <button className="inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-slate-100" onClick={() => props.onSort(c.sort!)}>
                    {c.label}{props.sort === c.sort && (props.dir === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
                  </button>
                ) : c.label}
              </div>
            ))}
          </div>
          {!loading && rows.length === 0 && <Empty icon={<Inbox className="size-10" />} title="No businesses match these filters.">Try removing a filter or widening the radius.</Empty>}
          <div style={{ height: v.getTotalSize(), position: 'relative' }}>
            {v.getVirtualItems().map((vi) => {
              const r = rows[vi.index]!;
              const sel = props.allMatching || props.selected.has(r.id);
              return (
                <div key={r.id} onClick={() => props.onOpen(r.id)} style={{ transform: `translateY(${vi.start}px)`, height: vi.size }}
                  className={cx('absolute inset-x-0 top-0 flex cursor-pointer items-center border-b border-slate-100 text-sm hover:bg-slate-50 dark:border-slate-800/70 dark:hover:bg-slate-800/40',
                    props.openId === r.id && 'bg-brand-50/70 dark:bg-brand-500/10', sel && 'bg-brand-50/40 dark:bg-brand-500/5')}>
                  <div className="flex w-11 shrink-0 items-center justify-center" onClick={(e) => e.stopPropagation()}><Checkbox checked={sel} onChange={() => props.onToggle(r.id)} /></div>
                  {cols.map((c) => <div key={c.id} style={{ width: c.width }} className="min-w-0 shrink-0 px-3">{c.render(r)}</div>)}
                </div>
              );
            })}
          </div>
        </div>
        {loading && <div className="absolute inset-0 flex items-start justify-center bg-white/40 pt-24 dark:bg-slate-950/40"><Spinner className="size-6" /></div>}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 px-3 py-2 text-xs text-slate-500 dark:border-slate-800">
        <div className="relative">
          <Button size="sm" variant="ghost" onClick={() => setChooser(!chooser)}><Columns3 className="size-3.5" /> Columns</Button>
          {chooser && (
            <div className="absolute bottom-9 left-0 z-20 w-48 rounded-lg border border-slate-200 bg-white p-1.5 shadow-xl dark:border-slate-700 dark:bg-slate-900" onMouseLeave={() => setChooser(false)}>
              {all.filter((c) => !c.always).map((c) => <Checkbox key={c.id} checked={!hidden.includes(c.id)} label={c.label} onChange={() => setHidden(hidden.includes(c.id) ? hidden.filter((h) => h !== c.id) : [...hidden, c.id])} />)}
            </div>
          )}
        </div>
        <span className="ml-auto">Rows</span>
        <select value={pageSize} onChange={(e) => props.onPageSize(Number(e.target.value))} className="h-7 rounded-md border border-slate-200 bg-white px-1 dark:border-slate-700 dark:bg-slate-900">
          {[50, 100, 200].map((n) => <option key={n}>{n}</option>)}
        </select>
        <span className="tabular-nums">{total ? `${((page - 1) * pageSize + 1).toLocaleString()}–${Math.min(page * pageSize, total).toLocaleString()} of ${total.toLocaleString()}` : '0'}</span>
        <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => props.onPage(page - 1)} aria-label="Previous page"><ChevronLeft className="size-4" /></Button>
        <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => props.onPage(page + 1)} aria-label="Next page"><ChevronRight className="size-4" /></Button>
      </div>
    </div>
  );
}
