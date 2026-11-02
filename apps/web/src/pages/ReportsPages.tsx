import { useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BarChart3, Printer, Trash2, MapPin, Users, Store, ArrowLeft, Info, AlertTriangle } from 'lucide-react';
import { api, type Meta, type SiteReportResult } from '../lib/api';
import { Link, navigate } from '../lib/router';
import { MapView } from '../components/MapView';
import { Badge, Button, Empty, Spinner, catColor, cx } from '../components/ui';
import { confirmAction } from '../components/feedback';

const card = 'rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900';
const fmtDist = (m: number) => (m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`);

export function ReportsPage({ meta }: { meta: Meta }) {
  const qc = useQueryClient();
  const { data: reports, isLoading } = useQuery({ queryKey: ['reports'], queryFn: api.reports });
  const [point, setPoint] = useState<{ lat: number; lon: number } | null>(null);
  const [radius, setRadius] = useState(1);
  const [focus, setFocus] = useState('');
  const [title, setTitle] = useState('');
  const catOrder = useMemo(() => meta.categories.map((c) => c.id), [meta]);
  const create = useMutation({
    mutationFn: () => api.siteReport({ lat: point!.lat, lon: point!.lon, radius_km: radius, focus_cat: focus || undefined, title: title.trim() || undefined }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ['reports'] }); navigate(`/reports/${r.id}`); },
  });
  const del = useMutation({ mutationFn: api.deleteReport, onSuccess: () => qc.invalidateQueries({ queryKey: ['reports'] }) });

  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
        <h1 className="text-xl font-semibold">Site reports</h1>
        <p className="mt-1 text-sm text-slate-500">Pick a location to see competitors, nearby anchors and an estimate of how many people live within the radius.</p>

        <div className={cx(card, 'mt-5 overflow-hidden')}>
          <div className="h-72 sm:h-80">
            <MapView loading={false} catOrder={catOrder} onSelect={() => {}} pickMode onPick={(lat, lon) => setPoint({ lat, lon })}
              radius={point ? { ...point, km: radius } : null} onSearchArea={() => {}} areaActive={false} onClearArea={() => {}} focus={null} />
          </div>
          <form className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
            <div className="text-sm"><div className="text-xs text-slate-500">Location</div>
              {point ? <div className="flex items-center gap-1 pt-1.5 tabular-nums"><MapPin className="size-3.5 text-brand-600" />{point.lat.toFixed(5)}, {point.lon.toFixed(5)}</div> : <div className="pt-1.5 text-slate-400">Click the map</div>}</div>
            <label className="text-sm"><span className="text-xs text-slate-500">Radius: <b className="text-slate-800 dark:text-slate-100">{radius} km</b></span>
              <input type="range" min={0.2} max={10} step={0.1} value={radius} onChange={(e) => setRadius(Number(e.target.value))} className="mt-2 w-full accent-brand-600" /></label>
            <label className="text-sm"><span className="text-xs text-slate-500">Your business type (competitors)</span>
              <select value={focus} onChange={(e) => setFocus(e.target.value)} className="mt-1 h-9 w-full rounded-lg border border-slate-200 bg-white px-2 dark:border-slate-700 dark:bg-slate-900">
                <option value="">None</option>{meta.categories.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select></label>
            <label className="text-sm"><span className="text-xs text-slate-500">Title (optional)</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. New pharmacy, Mirpur 10" className="mt-1 h-9 w-full rounded-lg border border-slate-200 bg-white px-2 dark:border-slate-700 dark:bg-slate-900" /></label>
            <div className="flex items-center gap-3 sm:col-span-2 lg:col-span-4">
              <Button variant="primary" disabled={!point || create.isPending}>{create.isPending ? <Spinner className="size-3.5 border-white/40 border-t-white" /> : <BarChart3 className="size-4" />}Generate report</Button>
              <span className="text-xs text-slate-500">Free during beta.</span>
              {create.error && <span className="text-sm text-rose-600">{(create.error as Error).message}</span>}
            </div>
          </form>
        </div>

        <h2 className="mb-3 mt-8 font-semibold">Saved reports</h2>
        {isLoading && <Spinner />}
        {reports?.length === 0 && <div className={card}><Empty icon={<BarChart3 className="size-10" />} title="No reports yet">Generate your first report above.</Empty></div>}
        <div className="grid gap-3 sm:grid-cols-2">
          {reports?.map((r) => (
            <div key={r.id} className={cx(card, 'flex items-start gap-3 p-4')}>
              <Link to={`/reports/${r.id}`} className="min-w-0 flex-1">
                <div className="truncate font-medium hover:underline">{r.title}</div>
                <div className="mt-0.5 text-sm text-slate-500">{r.radius_km} km{r.focus_cat ? ` · ${meta.categories.find((c) => c.id === r.focus_cat)?.label ?? r.focus_cat}` : ''} · {new Date(r.created_at).toLocaleDateString()}{r.by ? ` · ${r.by}` : ''}</div>
              </Link>
              <button className="rounded p-1.5 text-slate-300 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10" onClick={() => confirmAction('The saved report is deleted.', () => del.mutateAsync(r.id), { title: 'Delete this report?', confirmLabel: 'Delete', success: 'Report deleted' })} aria-label="Delete report"><Trash2 className="size-4" /></button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Tile({ icon, label, value, sub }: { icon: ReactNode; label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className={cx(card, 'p-4')}>
      <div className="flex items-center gap-1.5 text-xs font-medium text-slate-500">{icon}{label}</div>
      <div className="mt-1.5 text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

export function ReportView({ id, meta }: { id: string; meta: Meta }) {
  const { data, isLoading, error } = useQuery({ queryKey: ['report', id], queryFn: () => api.getReport(id) });
  const catOrder = useMemo(() => meta.categories.map((c) => c.id), [meta]);
  if (isLoading) return <div className="flex h-full items-center justify-center"><Spinner className="size-6" /></div>;
  if (error || !data?.result) return <p className="p-8 text-rose-600">{(error as Error)?.message ?? 'Report not found.'}</p>;
  const r: SiteReportResult = data.result;
  const all = r.totals.reduce((s, t) => s + t.ready + t.lead, 0);
  const max = Math.max(1, ...r.totals.map((t) => t.ready + t.lead));
  // older reports have no quality field: derive it from the covered share
  const quality = r.population.quality ?? (r.population.covered_share >= 0.9 ? 'upazila' : 'district_average');
  const grid = quality === 'grid';
  const rough = !grid && quality !== 'upazila';

  return (
    <div className="scroll-thin h-full overflow-y-auto print:overflow-visible">
      <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
        <div className="mb-5 flex flex-wrap items-start gap-2 print:hidden">
          <Button size="sm" onClick={() => navigate('/reports')}><ArrowLeft className="size-4" />All reports</Button>
          <Button size="sm" className="ml-auto" onClick={() => window.print()}><Printer className="size-4" />Print / save PDF</Button>
        </div>
        <h1 className="text-2xl font-semibold">{data.title}</h1>
        <p className="mt-1 text-sm text-slate-500">
          {r.radius_km} km radius around {r.point.lat.toFixed(5)}, {r.point.lon.toFixed(5)} · generated {new Date(r.generated_at).toLocaleString()} ·{' '}
          <a className="text-brand-600 hover:underline" href={`https://www.openstreetmap.org/?mlat=${r.point.lat}&mlon=${r.point.lon}#map=16/${r.point.lat}/${r.point.lon}`} target="_blank" rel="noreferrer">open on map</a>
        </p>

        <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Tile icon={<Users className="size-3.5" />} label="People (estimate)" value={r.population.estimate ? `${rough ? '~' : ''}${r.population.estimate.toLocaleString()}` : '—'} sub={grid ? 'WorldPop 2025, 100 m grid' : rough ? <span className="font-medium text-amber-600">rough: district average</span> : '2022, upazila-based'} />
          <Tile icon={<Store className="size-3.5" />} label="Businesses mapped" value={all.toLocaleString()} sub={r.per_10k_all !== null ? `${r.per_10k_all} per 10,000 people` : undefined} />
          {r.focus ? (
            <>
              <Tile icon={<span className="size-2.5 rounded-full" style={{ background: catColor(r.focus.cat, catOrder) }} />} label={`${r.focus.label}`} value={(r.focus.ready + r.focus.lead).toLocaleString()} sub={`${r.focus.ready} confirmed · ${r.focus.lead} leads`} />
              <Tile icon={<BarChart3 className="size-3.5" />} label="Competitor density" value={r.focus.per_10k ?? '—'} sub="per 10,000 people" />
            </>
          ) : <div className="col-span-2 flex items-center rounded-2xl border border-dashed border-slate-200 p-4 text-sm text-slate-500 dark:border-slate-700">Choose a business type when generating to see competitor numbers.</div>}
        </div>

        {rough && (
          <div className="mt-4 flex gap-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>No upazila population boundary covers most of this circle (common in city areas), so the people count uses the district average. In dense neighbourhoods the real number can be several times higher: treat people counts and per-10,000 densities as rough. Business counts are not affected.</span>
          </div>
        )}

        <section className={cx(card, 'mt-5 p-5')}>
          <h2 className="mb-3 font-semibold">Nearby anchors</h2>
          <div className="grid gap-2 sm:grid-cols-2">
            {r.anchors.map((a) => (
              <div key={a.cat} className="flex items-center gap-3 rounded-xl bg-slate-50 p-3 text-sm dark:bg-slate-800/50">
                <span className="size-2.5 shrink-0 rounded-full" style={{ background: catColor(a.cat, catOrder) }} />
                <div className="min-w-0 flex-1"><div className="font-medium">{a.label}</div>
                  <div className="truncate text-xs text-slate-500">{a.nearest ? <>nearest: {a.nearest.name} · {fmtDist(a.nearest.distance_m)}</> : 'none mapped in radius'}</div></div>
                <b className="tabular-nums">{a.count}</b>
              </div>
            ))}
          </div>
        </section>

        {r.focus && r.focus.nearest.length > 0 && (
          <section className={cx(card, 'mt-5 p-5')}>
            <h2 className="mb-3 font-semibold">Closest competitors: {r.focus.label}</h2>
            <ol className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
              {r.focus.nearest.map((n, i) => (
                <li key={n.id} className="flex items-center gap-3 py-2">
                  <span className="w-5 text-right text-xs text-slate-400">{i + 1}</span>
                  <Link to={`/business/${encodeURIComponent(n.id)}`} className="flex-1 truncate hover:underline">{n.name}</Link>
                  {n.status === 'lead' && <Badge tone="amber">lead</Badge>}
                  <span className="w-16 text-right tabular-nums text-slate-500">{fmtDist(n.distance_m)}</span>
                </li>
              ))}
            </ol>
          </section>
        )}

        <section className={cx(card, 'mt-5 p-5')}>
          <h2 className="mb-3 font-semibold">All businesses in the radius</h2>
          <div className="space-y-1.5">
            {r.totals.map((t) => (
              <div key={t.cat} className="grid grid-cols-[minmax(120px,40%)_1fr_56px] items-center gap-2 text-sm">
                <span className="truncate">{t.label}</span>
                <div className="flex h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                  <div style={{ width: `${(t.ready / max) * 100}%`, background: catColor(t.cat, catOrder) }} />
                  <div style={{ width: `${(t.lead / max) * 100}%`, background: catColor(t.cat, catOrder), opacity: 0.35 }} />
                </div>
                <span className="text-right tabular-nums">{(t.ready + t.lead).toLocaleString()}</span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-slate-500">Solid = confirmed listings, faded = unconfirmed leads.</p>
        </section>

        <section className={cx(card, 'mt-5 p-5')}>
          <h2 className="mb-2 flex items-center gap-1.5 font-semibold"><Info className="size-4 text-slate-400" />How the population was estimated</h2>
          <p className="text-sm text-slate-600 dark:text-slate-300">{r.population.method}</p>
          {grid ? (
            <p className="mt-2 text-sm text-slate-500">For comparison, spreading 2022 census totals evenly over the admin areas below gives {r.population.admin_estimate != null ? `~${r.population.admin_estimate.toLocaleString()}` : 'no figure'}. In cities that method is far too low because it ignores where people actually live.</p>
          ) : (
            <p className="mt-2 text-sm text-slate-500">{Math.round(r.population.covered_share * 100)}% of the circle has upazila-level population; the rest uses district averages.</p>
          )}
          {r.population.source && <p className="mt-1 text-xs text-slate-400">Source: {r.population.source}</p>}
          {r.population.areas.length > 0 && (
            <table className="mt-3 w-full text-sm">
              <thead className="text-left text-xs text-slate-500"><tr><th className="py-1 font-medium">Area</th><th className="font-medium">Level</th><th className="text-right font-medium">Population</th><th className="text-right font-medium">Share inside</th></tr></thead>
              <tbody>{r.population.areas.map((a) => (
                <tr key={a.level + a.name} className="border-t border-slate-100 dark:border-slate-800"><td className="py-1">{a.name}</td><td className="text-slate-500">{a.level}</td><td className="text-right tabular-nums">{a.population.toLocaleString()}</td><td className="text-right tabular-nums">{(a.share * 100).toFixed(1)}%</td></tr>
              ))}</tbody>
            </table>
          )}
        </section>

        <ul className="mt-5 space-y-1 text-xs text-slate-500">{r.caveats.map((c) => <li key={c}>• {c}</li>)}</ul>
        <p className="mt-4 text-[11px] text-slate-400">{meta.attribution} · Population: {grid ? 'WorldPop (www.worldpop.org), CC BY 4.0; admin totals: ' : ''}UNFPA / US Census Bureau 2022 via HDX (CC BY-IGO)</p>
      </div>
    </div>
  );
}
