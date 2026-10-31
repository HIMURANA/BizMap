import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SlidersHorizontal, Map as MapIcon, Table2, Columns2, Bookmark, ListPlus, Download, Mail, MessageCircle, PhoneCall, X, Trash2, Bell } from 'lucide-react';
import { navigate } from '../lib/router';
import { api, type Meta } from '../lib/api';
import { useFilters, type MultiKey } from '../lib/filters';
import { useI18n } from '../lib/i18n';
import { FilterPanel } from '../components/FilterPanel';
import { MapView } from '../components/MapView';
import { ResultsTable } from '../components/ResultsTable';
import { DetailDrawer } from '../components/DetailDrawer';
import { AddToListDialog, ExportDialog, type Selection } from '../components/Dialogs';
import { Button, Chip, Modal, SearchInput, cx } from '../components/ui';

type View = 'split' | 'map' | 'table';

function useDebounced<T>(v: T, ms: number) {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

export function Explore({ meta }: { meta: Meta }) {
  const { t, lang } = useI18n();
  const f = useFilters();
  const { multi, single } = f.filters;
  const qc = useQueryClient();
  const [view, setView] = useState<View>(() => (window.innerWidth < 1024 ? 'table' : 'split'));
  const [showFilters, setShowFilters] = useState(() => window.innerWidth >= 1024);
  const [pickMode, setPickMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [dialog, setDialog] = useState<null | 'list' | 'export' | 'view'>(null);
  const [dialogSel, setDialogSel] = useState<Selection | null>(null);
  const [viewName, setViewName] = useState('');
  const [viewsOpen, setViewsOpen] = useState(false);
  const [q, setQ] = useState(single.q ?? '');
  const dq = useDebounced(q, 350);
  useEffect(() => { if ((single.q ?? '') !== dq) f.set({ q: dq || undefined }); }, [dq]);

  // selection is reset whenever the set of matching records changes
  useEffect(() => { setSelected(new Set()); setAllMatching(false); }, [f.matchQuery]);

  const page = Number(single.page ?? 1), pageSize = Number(single.page_size ?? 50);
  const sort = single.sort ?? (single.lat ? 'distance' : 'score');
  const dir = single.dir ?? (sort === 'distance' || sort === 'name' ? 'asc' : 'desc');
  const listQs = useMemo(() => new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(f.matchQuery)), page: String(page), page_size: String(pageSize), sort, dir }).toString(), [f.matchQuery, page, pageSize, sort, dir]);
  const search = useQuery({ queryKey: ['search', listQs], queryFn: () => api.search(listQs), placeholderData: keepPreviousData });
  const facets = useQuery({ queryKey: ['facets', f.matchQuery], queryFn: () => api.facets(f.matchQuery), placeholderData: keepPreviousData });
  const mapData = useQuery({ queryKey: ['map', f.matchQuery], queryFn: () => api.map(f.matchQuery), placeholderData: keepPreviousData, enabled: view !== 'table' });
  const { data: views } = useQuery({ queryKey: ['views'], queryFn: api.views });
  const saveView = useMutation({ mutationFn: () => api.saveView(viewName.trim(), f.fullQuery), onSuccess: () => { setDialog(null); setViewName(''); qc.invalidateQueries({ queryKey: ['views'] }); } });
  const delView = useMutation({ mutationFn: api.deleteView, onSuccess: () => qc.invalidateQueries({ queryKey: ['views'] }) });

  const catOrder = useMemo(() => meta.categories.map((c) => c.id), [meta]);
  const catLabels = useMemo(() => new Map(meta.categories.map((c) => [c.id, c.label])), [meta]);
  const subLabels = useMemo(() => new Map(meta.categories.flatMap((c) => c.subcategories.map((s) => [s.id, s.label] as const))), [meta]);
  const districtNames = useMemo(() => new Map(meta.divisions.flatMap((d) => [[d.name, d.name_bn] as const, ...d.districts.map((x) => [x.name, x.name_bn] as const)])), [meta]);
  const placeName = (n: string) => (lang === 'bn' && districtNames.get(n)) || n.replace(/ (Division|District)$/, '');
  const total = search.data?.total ?? 0;
  const openId = single.open;
  const radius = single.lat && single.lon ? { lat: Number(single.lat), lon: Number(single.lon), km: Number(single.radius_km ?? 2) } : null;

  const selection = (): Selection => allMatching ? { query: f.matchQuery, count: total } : { ids: [...selected], count: selected.size };
  const openDialog = (d: 'list' | 'export', sel?: Selection) => { setDialogSel(sel ?? selection()); setDialog(d); };
  // Outreach works on a list or a filter: hand-picked rows become a new list first, otherwise the current filter is passed on
  const outreach = useMutation({
    mutationFn: async (target: string) => {
      if (!allMatching && selected.size > 0) {
        const l = await api.createList(`Selection ${new Date().toLocaleString()}`);
        await api.addToList(l.id, { ids: [...selected] });
        qc.invalidateQueries({ queryKey: ['lists'] });
        return `${target}&list=${l.id}`;
      }
      return `${target}&query=${encodeURIComponent(f.matchQuery)}`;
    },
    onSuccess: (to) => navigate(to),
  });
  const selCount = allMatching ? total : selected.size;

  // filter chips
  const chipLabel: Record<MultiKey, (v: string) => string> = {
    cat: (v) => catLabels.get(v) ?? v, sub: (v) => subLabels.get(v) ?? v, division: placeName, district: placeName, upazila: (v) => v, area: (v) => v,
    scope: (v) => ({ dhaka_metropolitan: 'Dhaka City', greater_dhaka: 'Greater Dhaka', outside_dhaka: 'Outside Dhaka' }[v] ?? v),
    layer: (v) => meta.layers.find((l) => l.id === v)?.label ?? v, status: (v) => t(v as 'ready'), has: (v) => `Has ${v}`, verified: (v) => `Verified ${v}`,
  };
  const chips = [
    ...(Object.keys(chipLabel) as MultiKey[]).flatMap((k) => multi[k].map((v) => ({ key: `${k}:${v}`, label: chipLabel[k](v), remove: () => f.toggle(k, v) }))),
    ...(radius ? [{ key: 'radius', label: `${radius.km} km radius`, remove: () => f.set({ lat: undefined, lon: undefined, radius_km: undefined }) }] : []),
    ...(single.bbox ? [{ key: 'bbox', label: 'Map area', remove: () => f.set({ bbox: undefined }) }] : []),
    ...(single.score_min ? [{ key: 'score', label: `Score ≥ ${single.score_min}`, remove: () => f.set({ score_min: undefined }) }] : []),
    ...(single.src_conf_min ? [{ key: 'conf', label: `Overture conf ≥ ${single.src_conf_min}`, remove: () => f.set({ src_conf_min: undefined }) }] : []),
    ...(single.fcommerce ? [{ key: 'fc', label: 'F-commerce', remove: () => f.set({ fcommerce: undefined }) }] : []),
    ...(single.chain ? [{ key: 'chain', label: single.chain === 'only' ? 'Chains only' : 'Independent only', remove: () => f.set({ chain: undefined }) }] : []),
    ...(single.first_seen_after ? [{ key: 'seen', label: `Seen since ${single.first_seen_after}`, remove: () => f.set({ first_seen_after: undefined }) }] : []),
    ...(single.list ? [{ key: 'list', label: 'In list', remove: () => f.set({ list: undefined }) }] : []),
    ...(single.not_list ? [{ key: 'nlist', label: 'Excluding list', remove: () => f.set({ not_list: undefined }) }] : []),
    ...(single.q ? [{ key: 'q', label: `“${single.q}”`, remove: () => { setQ(''); f.set({ q: undefined }); } }] : []),
  ];

  const onSort = (key: string) => f.set({ sort: key, dir: sort === key ? (dir === 'asc' ? 'desc' : 'asc') : key === 'name' || key === 'distance' ? 'asc' : 'desc' });

  return (
    <div className="flex h-full min-h-0">
      {showFilters && (
        <>
          <div className="fixed inset-0 z-30 bg-slate-900/30 lg:hidden" onClick={() => setShowFilters(false)} />
          <aside className="scroll-thin fixed inset-y-0 left-0 z-30 w-[85vw] max-w-80 overflow-y-auto border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 lg:static lg:z-auto lg:w-72 lg:shrink-0">
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-100 bg-white/95 px-4 py-3 backdrop-blur dark:border-slate-800 dark:bg-slate-900/95">
              <span className="flex items-center gap-2 font-semibold"><SlidersHorizontal className="size-4" />{t('filters')}</span>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => { setQ(''); f.reset(); }}>{t('reset')}</Button>
                <Button size="sm" variant="ghost" className="lg:hidden" onClick={() => setShowFilters(false)}><X className="size-4" /></Button>
              </div>
            </div>
            <FilterPanel f={f} meta={meta} facets={facets.data} pickMode={pickMode} setPickMode={(v) => { setPickMode(v); if (v && view === 'table') setView('split'); }} />
          </aside>
        </>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="space-y-2 border-b border-slate-200 bg-white px-3 py-2.5 dark:border-slate-800 dark:bg-slate-900 sm:px-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant={showFilters ? 'secondary' : 'primary'} onClick={() => setShowFilters(!showFilters)}>
              <SlidersHorizontal className="size-3.5" />{t('filters')}{chips.length ? ` (${chips.length})` : ''}
            </Button>
            <SearchInput value={q} onChange={setQ} placeholder={t('search_placeholder')} className="min-w-40 flex-1 sm:max-w-sm" />
            <div className="ml-auto flex items-center gap-2">
              <div className="relative">
                <Button size="sm" onClick={() => setViewsOpen(!viewsOpen)}><Bookmark className="size-3.5" /><span className="hidden sm:inline">{t('saved_views')}</span></Button>
                {viewsOpen && (
                  <div className="absolute right-0 top-10 z-30 w-72 rounded-xl border border-slate-200 bg-white p-2 shadow-xl dark:border-slate-700 dark:bg-slate-900" onMouseLeave={() => setViewsOpen(false)}>
                    <Button size="sm" variant="primary" className="mb-2 w-full" onClick={() => { setViewsOpen(false); setDialog('view'); }}>{t('save_view')}</Button>
                    <Button size="sm" className="mb-2 w-full" onClick={() => navigate(`/alerts?query=${encodeURIComponent(f.matchQuery)}`)}><Bell className="size-3.5" />Alert me about new ones</Button>
                    {views?.length === 0 && <p className="px-2 py-1 text-xs text-slate-500">No saved views yet. A view keeps filters, sort and map area.</p>}
                    {views?.map((v) => (
                      <div key={v.id} className="group flex items-center rounded-md hover:bg-slate-50 dark:hover:bg-slate-800">
                        <a href={`/?${v.query}`} className="flex-1 truncate px-2 py-1.5 text-sm">{v.name}</a>
                        <button className="p-1.5 text-slate-300 opacity-0 hover:text-rose-600 group-hover:opacity-100" onClick={() => delView.mutate(v.id)} aria-label="Delete view"><Trash2 className="size-3.5" /></button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex rounded-lg border border-slate-200 p-0.5 dark:border-slate-700">
                {([['map', MapIcon, t('map')], ['split', Columns2, t('split')], ['table', Table2, t('table')]] as const).map(([v, Icon, l]) => (
                  <button key={v} onClick={() => setView(v)} title={l}
                    className={cx('flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium', view === v ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900' : 'text-slate-500 hover:text-slate-900 dark:hover:text-white', v === 'split' && 'hidden lg:flex')}>
                    <Icon className="size-3.5" /><span className="hidden md:inline">{l}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-sm"><b className="tabular-nums">{total.toLocaleString()}</b> <span className="text-slate-500">{t('results')}</span></span>
            {chips.map((c) => <Chip key={c.key} onRemove={c.remove}>{c.label}</Chip>)}
            {chips.length > 1 && <button className="text-xs text-slate-500 hover:underline" onClick={() => { setQ(''); f.reset(); }}>Clear all</button>}
          </div>
        </div>

        <div className="flex min-h-0 flex-1">
          {view !== 'table' && (
            <div className={cx('min-w-0', view === 'map' ? 'flex-1' : 'w-1/2 border-r border-slate-200 dark:border-slate-800')}>
              <MapView data={mapData.data} loading={mapData.isFetching} catOrder={catOrder} onSelect={(id) => f.set({ open: id })}
                pickMode={pickMode} onPick={(lat, lon) => { setPickMode(false); f.set({ lat: lat.toFixed(5), lon: lon.toFixed(5), radius_km: single.radius_km ?? '2', bbox: undefined }); }}
                radius={radius} areaActive={!!single.bbox} onSearchArea={(bbox) => f.set({ bbox })} onClearArea={() => f.set({ bbox: undefined })}
                focus={null} />
            </div>
          )}
          {view !== 'map' && (
            <div className="min-w-0 flex-1 bg-white dark:bg-slate-900">
              <ResultsTable rows={search.data?.rows ?? []} total={total} page={page} pageSize={pageSize} loading={search.isFetching}
                sort={sort} dir={dir} onSort={onSort} onPage={(p) => f.set({ page: String(p) }, true)} onPageSize={(n) => f.set({ page_size: String(n) })}
                selected={selected} allMatching={allMatching}
                onToggle={(id) => { if (allMatching) return; const s = new Set(selected); if (s.has(id)) s.delete(id); else s.add(id); setSelected(s); }}
                onTogglePage={() => { if (allMatching) { setAllMatching(false); setSelected(new Set()); return; } const ids = (search.data?.rows ?? []).map((r) => r.id); const s = new Set(selected); const all = ids.every((i) => s.has(i)); ids.forEach((i) => (all ? s.delete(i) : s.add(i))); setSelected(s); }}
                onSelectAllMatching={() => setAllMatching(true)} onClearSelection={() => { setAllMatching(false); setSelected(new Set()); }}
                onOpen={(id) => f.set({ open: id }, true)} openId={openId} catLabel={(id) => catLabels.get(id) ?? id} catOrder={catOrder} showDistance={!!radius} />
            </div>
          )}
        </div>

        {(selCount > 0 || total > 0) && (
          <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900 sm:px-4">
            <span className="text-sm">{selCount > 0 ? <><b>{selCount.toLocaleString()}</b> {t('selected')}</> : <span className="text-slate-500">Select rows, or act on all {total.toLocaleString()} results</span>}</span>
            <div className="ml-auto flex flex-wrap gap-2">
              <Button size="sm" onClick={() => openDialog('list', selCount ? undefined : { query: f.matchQuery, count: total })}><ListPlus className="size-3.5" />{t('add_to_list')}</Button>
              <Button size="sm" onClick={() => openDialog('export', selCount ? undefined : { query: f.matchQuery, count: total })}><Download className="size-3.5" />{t('export')}</Button>
              <Button size="sm" variant="ghost" disabled={outreach.isPending} onClick={() => outreach.mutate('/campaigns/new?channel=email')} title="Email campaign to these businesses"><Mail className="size-3.5" /><span className="hidden sm:inline">Email</span></Button>
              <Button size="sm" variant="ghost" disabled={outreach.isPending} onClick={() => outreach.mutate('/campaigns/new?channel=whatsapp')} title="WhatsApp campaign (opted-in numbers only)"><MessageCircle className="size-3.5" /><span className="hidden sm:inline">WhatsApp</span></Button>
              <Button size="sm" variant="ghost" disabled={outreach.isPending} onClick={() => outreach.mutate('/calls?new=1')} title="Call queue for these businesses"><PhoneCall className="size-3.5" /><span className="hidden sm:inline">Call queue</span></Button>
            </div>
          </div>
        )}
      </div>

      {openId && <DetailDrawer id={openId} onClose={() => f.set({ open: undefined }, true)} onOpen={(id) => f.set({ open: id }, true)} catOrder={catOrder}
        onAddToList={(ids) => openDialog('list', { ids, count: ids.length })} />}

      <AddToListDialog open={dialog === 'list'} onClose={() => setDialog(null)} sel={dialogSel} />
      <ExportDialog open={dialog === 'export'} onClose={() => setDialog(null)} sel={dialogSel} />
      <Modal open={dialog === 'view'} onClose={() => setDialog(null)} title={t('save_view')}
        footer={<><Button onClick={() => setDialog(null)}>Cancel</Button><Button variant="primary" disabled={!viewName.trim() || saveView.isPending} onClick={() => saveView.mutate()}>Save</Button></>}>
        <input autoFocus value={viewName} onChange={(e) => setViewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && viewName.trim() && saveView.mutate()} placeholder="e.g. Pharmacies near Bogura depot"
          className="h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-900" />
        <p className="mt-2 text-xs text-slate-500">Saves the current filters, sort and map area. Results update as the data changes.</p>
      </Modal>
    </div>
  );
}
