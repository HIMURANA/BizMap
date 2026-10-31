import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Plus, Check, Coins, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api';
import { Button, Modal, Spinner, cx } from './ui';

/** A selection is either explicit ids or "everything matching this filter query". */
export interface Selection { ids?: string[]; query?: string; count: number }

export function AddToListDialog({ open, onClose, sel }: { open: boolean; onClose: () => void; sel: Selection | null }) {
  const qc = useQueryClient();
  const { data: lists } = useQuery({ queryKey: ['lists'], queryFn: api.lists, enabled: open });
  const [name, setName] = useState('');
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => { if (open) { setDone(null); setName(''); } }, [open]);
  const add = useMutation({
    mutationFn: async (listId: string) => { await api.addToList(listId, sel?.ids ? { ids: sel.ids } : { query: sel?.query ?? '' }); return listId; },
    onSuccess: (id) => { setDone(lists?.find((l) => l.id === id)?.name ?? name); qc.invalidateQueries({ queryKey: ['lists'] }); qc.invalidateQueries({ queryKey: ['business'] }); },
  });
  const create = useMutation({ mutationFn: () => api.createList(name.trim()), onSuccess: (l) => add.mutate(l.id) });

  return (
    <Modal open={open} onClose={onClose} title={`Add ${sel?.count.toLocaleString() ?? ''} business${sel?.count === 1 ? '' : 'es'} to a list`}
      footer={<Button onClick={onClose}>{done ? 'Done' : 'Cancel'}</Button>}>
      {done ? (
        <p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400"><Check className="size-4" /> Added to “{done}”.</p>
      ) : (
        <div className="space-y-3">
          {sel && sel.count > 50000 && <p className="rounded-lg bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">Only the first 50,000 will be added. Narrow the filters for a smaller list.</p>}
          <div className="space-y-1">
            {lists?.length === 0 && <p className="text-sm text-slate-500">No lists yet: create the first one below.</p>}
            {lists?.map((l) => (
              <button key={l.id} disabled={add.isPending} onClick={() => add.mutate(l.id)}
                className="flex w-full items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-left text-sm hover:border-brand-500 hover:bg-brand-50/50 dark:border-slate-700 dark:hover:bg-slate-800">
                <span className="font-medium">{l.name}</span><span className="text-xs text-slate-400">{l.n.toLocaleString()} businesses</span>
              </button>
            ))}
          </div>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate(); }}>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New list name, e.g. Mirpur pharmacies"
              className="h-9 flex-1 rounded-lg border border-slate-200 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-900" />
            <Button variant="primary" disabled={!name.trim() || create.isPending || add.isPending}><Plus className="size-4" /> Create</Button>
          </form>
          {(add.isPending || create.isPending) && <p className="flex items-center gap-2 text-xs text-slate-500"><Spinner className="size-3" /> Adding…</p>}
          {(add.error || create.error) && <p className="text-xs text-rose-600">{((add.error ?? create.error) as Error).message}</p>}
        </div>
      )}
    </Modal>
  );
}

const FORMATS = [['csv', 'CSV', 'Opens in Excel / Google Sheets'], ['json', 'JSON', 'For developers'], ['geojson', 'GeoJSON', 'For QGIS / map tools']] as const;

export function ExportDialog({ open, onClose, sel }: { open: boolean; onClose: () => void; sel: Selection | null }) {
  const qc = useQueryClient();
  const { data: presets } = useQuery({ queryKey: ['presets'], queryFn: api.presets, enabled: open });
  const [preset, setPreset] = useState('sales_call');
  const [format, setFormat] = useState('csv');
  const [name, setName] = useState('');
  const body = { ids: sel?.ids, query: sel?.query, preset };
  const quote = useQuery({ queryKey: ['quote', body], queryFn: () => api.quote(body), enabled: open && !!sel });
  const run = useMutation({ mutationFn: () => api.runExport({ ...body, format, name }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['meta'] }); qc.invalidateQueries({ queryKey: ['exports'] }); } });
  useEffect(() => { if (open) run.reset(); }, [open]);

  const q = quote.data;
  const short = q ? q.credits > q.balance : false;
  return (
    <Modal open={open} onClose={onClose} wide title="Export businesses"
      footer={run.data ? <Button onClick={onClose}>Close</Button> : (
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!q || short || run.isPending || q.rows === 0} onClick={() => run.mutate()}>
            {run.isPending ? <Spinner className="size-3.5 border-white/40 border-t-white" /> : <Download className="size-4" />}
            {q ? (q.credits ? `Export & use ${q.credits.toLocaleString()} credits` : 'Export (free)') : 'Export'}
          </Button>
        </>
      )}>
      {run.data ? (
        <div className="space-y-3 text-sm">
          <p className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400"><Check className="size-4" /> Export ready: {run.data.rows.toLocaleString()} rows{run.data.credits ? `, ${run.data.credits.toLocaleString()} credits used` : ''}.</p>
          <a href={run.data.download} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand-600 px-3.5 font-medium text-white hover:bg-brand-700"><Download className="size-4" /> Download file</a>
          <p className="text-xs text-slate-500">It also stays in Exports for re-download. Remaining balance: {run.data.balance.toLocaleString()} credits.</p>
        </div>
      ) : (
        <div className="space-y-5">
          <div>
            <div className="mb-2 text-sm font-medium">What to include</div>
            <div className="grid gap-2 sm:grid-cols-2">
              {presets?.map((p) => (
                <button key={p.id} onClick={() => setPreset(p.id)}
                  className={cx('rounded-xl border p-3 text-left transition', preset === p.id ? 'border-brand-500 bg-brand-50/60 ring-1 ring-brand-500 dark:bg-brand-500/10' : 'border-slate-200 hover:border-slate-300 dark:border-slate-700')}>
                  <div className="flex items-center justify-between text-sm font-medium">{p.label}<span className={cx('text-[11px]', p.paid ? 'text-amber-600' : 'text-emerald-600')}>{p.paid ? '1 credit / row' : 'free'}</span></div>
                  <div className="mt-1 line-clamp-2 text-xs text-slate-500">{p.cols.join(', ')}</div>
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-2 text-sm font-medium">Format</div>
            <div className="flex flex-wrap gap-2">
              {FORMATS.map(([id, l, d]) => (
                <button key={id} onClick={() => setFormat(id)} className={cx('rounded-lg border px-3 py-2 text-left', format === id ? 'border-brand-500 ring-1 ring-brand-500' : 'border-slate-200 dark:border-slate-700')}>
                  <div className="text-sm font-medium">{l}</div><div className="text-[11px] text-slate-500">{d}</div>
                </button>
              ))}
            </div>
          </div>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="File name (optional)"
            className="h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-900" />
          <div className={cx('flex items-center gap-3 rounded-xl p-3 text-sm', short ? 'bg-rose-50 text-rose-800 dark:bg-rose-500/10 dark:text-rose-300' : 'bg-slate-50 dark:bg-slate-800/60')}>
            <Coins className="size-5 shrink-0 text-amber-500" />
            {quote.isLoading || !q ? <Spinner /> : (
              <div>
                <b>{q.rows.toLocaleString()}</b> rows · cost <b>{q.credits.toLocaleString()}</b> credits · balance {q.balance.toLocaleString()}
                {short && <div className="text-xs">Not enough credits. Choose “Locations only” (free) or narrow the selection.</div>}
              </div>
            )}
          </div>
          <p className="flex gap-2 text-xs text-slate-500"><ShieldCheck className="size-4 shrink-0" />Attribution (OpenStreetMap ODbL, Overture) is added to every file. Contacts on the suppression list are removed. Contacts are unverified unless marked verified.</p>
          {run.error && <p className="text-sm text-rose-600">{(run.error as Error).message}</p>}
        </div>
      )}
    </Modal>
  );
}
