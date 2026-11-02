import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, BellOff, Plus, Play, Trash2, ChevronDown, ChevronRight, Mail } from 'lucide-react';
import { api } from '../lib/api';
import { out, type Alert } from '../lib/outreach';
import { Link, useLocation } from '../lib/router';
import { Badge, Button, Empty, Modal, Spinner, cx } from '../components/ui';
import { Page } from './CampaignPages';
import { confirmAction } from '../components/feedback';

const card = 'rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900';
const input = 'h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-900';

export function AlertsPage() {
  const qc = useQueryClient();
  const { search } = useLocation();
  const presetQuery = new URLSearchParams(search).get('query');
  const [open, setOpen] = useState(presetQuery !== null);
  const [name, setName] = useState('');
  const [query, setQuery] = useState(presetQuery ?? '');
  const [frequency, setFrequency] = useState('weekly');
  const [email, setEmail] = useState(true);
  const { data, isLoading } = useQuery({ queryKey: ['alerts'], queryFn: out.alerts });
  const views = useQuery({ queryKey: ['views'], queryFn: api.views, enabled: open });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['alerts'] }); qc.invalidateQueries({ queryKey: ['alerts-unseen'] }); };
  const create = useMutation({ mutationFn: () => out.createAlert({ name: name.trim(), query, frequency, email }), onSuccess: () => { setOpen(false); setName(''); refresh(); } });
  return (
    <Page title="Alerts" subtitle="Get told when new businesses appear that match a saved filter: new competitors, new shops in your territory, new leads."
      actions={<Button variant="primary" onClick={() => setOpen(true)}><Plus className="size-4" />New alert</Button>}>
      {isLoading && <Spinner />}
      {data?.length === 0 && <div className={card}><Empty icon={<Bell className="size-10" />} title="No alerts yet">Save a view in Explore (for example “Pharmacies in Mirpur”), then create an alert for it.</Empty></div>}
      <div className="space-y-3">{data?.map((a) => <AlertCard key={a.id} a={a} onChange={refresh} />)}</div>
      <p className="mt-6 text-xs text-slate-500">New businesses appear when the map data is refreshed (OpenStreetMap / Overture updates are imported periodically). A business counts as new the first time BizMap sees it.</p>
      <Modal open={open} onClose={() => setOpen(false)} title="New alert"
        footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>Create alert</Button></>}>
        <div className="space-y-3 text-sm">
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Alert name, e.g. New pharmacies near our depot" className={input} />
          <select value={query} onChange={(e) => setQuery(e.target.value)} className={input}>
            {presetQuery !== null && <option value={presetQuery}>Current Explore filter</option>}
            {presetQuery === null && <option value="">All businesses (no filter)</option>}
            {views.data?.map((v) => <option key={v.id} value={v.query}>Saved view: {v.name}</option>)}
          </select>
          <select value={frequency} onChange={(e) => setFrequency(e.target.value)} className={input}><option value="daily">Check daily</option><option value="weekly">Check weekly</option><option value="monthly">Check monthly</option></select>
          <label className="flex items-center gap-2"><input type="checkbox" checked={email} onChange={(e) => setEmail(e.target.checked)} className="size-4 accent-brand-600" />Also email me when something new is found</label>
          {create.error && <p className="text-rose-600">{(create.error as Error).message}</p>}
        </div>
      </Modal>
    </Page>
  );
}

function AlertCard({ a, onChange }: { a: Alert; onChange: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const runs = useQuery({ queryKey: ['alert-runs', a.id], queryFn: () => out.alertRuns(a.id), enabled: expanded });
  const run = useMutation({ mutationFn: () => out.runAlert(a.id), onSuccess: () => { onChange(); setExpanded(true); runs.refetch(); } });
  const toggle = useMutation({ mutationFn: () => out.updateAlert(a.id, { active: !a.active }), onSuccess: onChange });
  const del = useMutation({ mutationFn: () => out.deleteAlert(a.id), onSuccess: onChange });
  const explore = `/?${a.query}`;
  return (
    <div className={cx(card, 'p-4', !a.active && 'opacity-60')}>
      <div className="flex flex-wrap items-start gap-2">
        <button onClick={() => setExpanded(!expanded)} className="mt-0.5 text-slate-400" aria-label="Show history">{expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}</button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 font-semibold">{a.name}{a.unseen > 0 && <Badge tone="violet">{a.unseen} new</Badge>}</div>
          <div className="text-xs text-slate-500">{a.frequency} · {a.email && <><Mail className="inline size-3" /> email · </>}last checked {a.last_run_at ? new Date(a.last_run_at).toLocaleString() : 'never'}{a.last_run ? ` (${a.last_run.new_count} new)` : ''}</div>
          <Link to={explore} className="text-xs text-brand-600 hover:underline">Open filter in Explore</Link>
        </div>
        <Button size="sm" onClick={() => run.mutate()} disabled={run.isPending}>{run.isPending ? <Spinner className="size-3" /> : <Play className="size-3.5" />}Check now</Button>
        <Button size="sm" variant="ghost" onClick={() => toggle.mutate()} title={a.active ? 'Pause' : 'Resume'}>{a.active ? <BellOff className="size-4" /> : <Bell className="size-4" />}</Button>
        <Button size="sm" variant="ghost" onClick={() => confirmAction('You will stop getting new-business updates for this filter.', () => del.mutateAsync(), { title: 'Delete this alert?', confirmLabel: 'Delete', success: 'Alert deleted' })} title="Delete"><Trash2 className="size-4" /></Button>
      </div>
      {run.data && <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{run.data.new_count === 0 ? 'Nothing new since the last check.' : `${run.data.new_count} new business${run.data.new_count === 1 ? '' : 'es'} found.`}</p>}
      {expanded && (
        <div className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-800">
          {runs.isLoading && <Spinner />}
          {runs.data?.length === 0 && <p className="text-xs text-slate-500">No checks yet.</p>}
          <ul className="space-y-3">{runs.data?.map((r) => (
            <li key={r.id} className="text-sm">
              <div className="text-xs text-slate-500">{new Date(r.run_at).toLocaleString()} · <b className="text-slate-800 dark:text-slate-200">{r.new_count}</b> new</div>
              {r.sample.length > 0 && <ul className="mt-1 space-y-0.5">{r.sample.map((s) => <li key={s.id}><Link to={`/business/${encodeURIComponent(s.id)}`} className="hover:underline">{s.name}</Link> <span className="text-xs text-slate-400">{s.area ?? s.district?.replace(/ District$/, '')}</span></li>)}</ul>}
              {r.new_count > r.sample.length && <Link to={`${explore}&first_seen_after=${r.since.slice(0, 10)}`} className="text-xs text-brand-600 hover:underline">See all {r.new_count}</Link>}
            </li>
          ))}</ul>
        </div>
      )}
    </div>
  );
}
