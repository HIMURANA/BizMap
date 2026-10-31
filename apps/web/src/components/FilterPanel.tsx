import { useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, MapPin, Crosshair, X } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api, type Facets, type Meta } from '../lib/api';
import { useI18n, type Key } from '../lib/i18n';
import type { useFilters } from '../lib/filters';
import { Button, Checkbox, SearchInput, catColor, cx } from './ui';

type F = ReturnType<typeof useFilters>;

function Section({ title, count, children, defaultOpen = false }: { title: string; count?: number; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-slate-100 dark:border-slate-800">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-semibold hover:bg-slate-50 dark:hover:bg-slate-800/50">
        {open ? <ChevronDown className="size-4 text-slate-400" /> : <ChevronRight className="size-4 text-slate-400" />}
        <span className="flex-1">{title}</span>
        {!!count && <span className="rounded-full bg-brand-600 px-1.5 text-[11px] font-semibold text-white">{count}</span>}
      </button>
      {open && <div className="space-y-3 px-3 pb-4">{children}</div>}
    </div>
  );
}

const Label = ({ children }: { children: ReactNode }) => <div className="px-1.5 pb-1 text-xs font-medium uppercase tracking-wide text-slate-400">{children}</div>;
const select = 'h-9 w-full rounded-lg border border-slate-200 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-900';

export function FilterPanel({ f, meta, facets, pickMode, setPickMode }: { f: F; meta: Meta; facets?: Facets; pickMode: boolean; setPickMode: (v: boolean) => void }) {
  const { t, lang } = useI18n();
  const { multi, single } = f.filters;
  const [catSearch, setCatSearch] = useState('');
  const [areaSearch, setAreaSearch] = useState('');
  const [openDiv, setOpenDiv] = useState<string | null>(null);
  const { data: lists } = useQuery({ queryKey: ['lists'], queryFn: api.lists });
  const catOrder = useMemo(() => meta.categories.map((c) => c.id), [meta]);
  const nm = (x: { name: string; name_bn: string | null }) => (lang === 'bn' && x.name_bn ? x.name_bn : x.name.replace(/ (Division|District)$/, ''));

  const chosenDistricts = meta.divisions.flatMap((d) => d.districts).filter((d) => multi.district.includes(d.name));
  const upazilas = chosenDistricts.length === 1 ? chosenDistricts[0]!.upazilas : [];
  const cats = meta.categories.filter((c) => !catSearch || c.label.toLowerCase().includes(catSearch.toLowerCase()));
  const areas = meta.areas.filter((a) => !areaSearch || a.name.toLowerCase().includes(areaSearch.toLowerCase()));
  const contactCount = (k: keyof Facets['contact']) => facets?.contact?.[k];
  const radius = Number(single.radius_km ?? 2);

  return (
    <div className="text-sm">
      <Section title={t('location')} defaultOpen count={multi.division.length + multi.district.length + multi.upazila.length + multi.area.length + multi.scope.length + (single.lat ? 1 : 0) + (single.bbox ? 1 : 0)}>
        <div>
          <Label>{t('radius')}</Label>
          {single.lat ? (
            <div className="space-y-2 rounded-lg border border-brand-100 bg-brand-50/50 p-2.5 dark:border-brand-500/30 dark:bg-brand-500/10">
              <div className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
                <MapPin className="size-3.5 text-brand-600" />
                <span className="flex-1 tabular-nums">{Number(single.lat).toFixed(4)}, {Number(single.lon).toFixed(4)}</span>
                <button className="rounded p-0.5 hover:bg-white dark:hover:bg-slate-800" onClick={() => f.set({ lat: undefined, lon: undefined, radius_km: undefined })} aria-label="Clear radius"><X className="size-3.5" /></button>
              </div>
              <input type="range" min={0.2} max={20} step={0.1} value={radius} className="w-full accent-brand-600"
                onChange={(e) => f.set({ radius_km: e.target.value })} />
              <div className="flex justify-between text-xs text-slate-500"><span>0.2 km</span><b className="text-slate-800 dark:text-slate-100">{radius} km</b><span>20 km</span></div>
            </div>
          ) : (
            <Button size="sm" variant={pickMode ? 'primary' : 'secondary'} className="w-full" onClick={() => setPickMode(!pickMode)}>
              <Crosshair className="size-3.5" /> {pickMode ? 'Click a point on the map…' : 'Pick a centre on the map'}
            </Button>
          )}
        </div>

        <div>
          <Label>{t('division')} › {t('district')}</Label>
          <div className="scroll-thin max-h-72 overflow-y-auto">
            {meta.divisions.map((dv) => {
              const ds = dv.districts.map((d) => d.name);
              const nSel = ds.filter((d) => multi.district.includes(d)).length;
              return (
                <div key={dv.name}>
                  <div className="flex items-center">
                    <button className="p-1 text-slate-400" onClick={() => setOpenDiv(openDiv === dv.name ? null : dv.name)} aria-label="Expand">
                      {openDiv === dv.name ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                    </button>
                    <div className="flex-1"><Checkbox checked={multi.division.includes(dv.name)} indeterminate={!multi.division.includes(dv.name) && nSel > 0}
                      onChange={() => f.toggle('division', dv.name)} label={nm(dv)} count={dv.n} /></div>
                  </div>
                  {openDiv === dv.name && (
                    <div className="ml-6 border-l border-slate-100 pl-1 dark:border-slate-800">
                      {dv.districts.map((d) => <Checkbox key={d.name} checked={multi.district.includes(d.name)} onChange={() => f.toggle('district', d.name)} label={nm(d)} count={d.n} />)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {upazilas.length > 0 && (
          <div>
            <Label>{t('upazila')}</Label>
            <div className="scroll-thin max-h-48 overflow-y-auto">
              {upazilas.map((u) => <Checkbox key={u.name} checked={multi.upazila.includes(u.name)} onChange={() => f.toggle('upazila', u.name)} label={u.name} count={u.n} />)}
            </div>
          </div>
        )}

        <div>
          <Label>{t('area')}</Label>
          <SearchInput value={areaSearch} onChange={setAreaSearch} placeholder="Gulshan, Mirpur…" className="mb-1" />
          <div className="scroll-thin max-h-40 overflow-y-auto">
            {areas.map((a) => <Checkbox key={a.name} checked={multi.area.includes(a.name)} onChange={() => f.toggle('area', a.name)} label={a.name} count={a.n} />)}
          </div>
        </div>

        <div>
          <Label>Dhaka scope</Label>
          {[['dhaka_metropolitan', 'Dhaka City (metropolitan)'], ['greater_dhaka', 'Greater Dhaka'], ['outside_dhaka', 'Outside Dhaka']].map(([k, l]) =>
            <Checkbox key={k} checked={multi.scope.includes(k!)} onChange={() => f.toggle('scope', k!)} label={l} />)}
        </div>
      </Section>

      <Section title={t('category')} defaultOpen count={multi.cat.length + multi.sub.length}>
        <SearchInput value={catSearch} onChange={setCatSearch} placeholder="Pharmacy, school…" />
        <div className="scroll-thin max-h-80 overflow-y-auto">
          {cats.map((c) => (
            <div key={c.id}>
              <Checkbox checked={multi.cat.includes(c.id)} onChange={() => f.toggle('cat', c.id)} count={c.n}
                label={<span className="flex items-center gap-2"><span className="size-2.5 shrink-0 rounded-full" style={{ background: catColor(c.id, catOrder) }} />{c.label}</span>} />
              {multi.cat.includes(c.id) && c.subcategories.length > 1 && (
                <div className="ml-7 border-l border-slate-100 pl-1 dark:border-slate-800">
                  {c.subcategories.map((s) => <Checkbox key={s.id} checked={multi.sub.includes(s.id)} onChange={() => f.toggle('sub', s.id)} label={s.label} count={s.n} />)}
                </div>
              )}
            </div>
          ))}
        </div>
      </Section>

      <Section title={t('contact')} count={multi.has.length + multi.verified.length}>
        <div>
          <Label>{t('has')}</Label>
          {(['phone', 'email', 'website', 'facebook', 'instagram'] as const).map((k) =>
            <Checkbox key={k} checked={multi.has.includes(k)} onChange={() => f.toggle('has', k)} label={t(k as Key)} count={contactCount(k)} />)}
        </div>
        <div>
          <Label>{t('verified_only')}</Label>
          {(['phone', 'email', 'website', 'facebook'] as const).map((k) =>
            <Checkbox key={k} checked={multi.verified.includes(k)} onChange={() => f.toggle('verified', k)} label={`${t(k as Key)} ✓`} />)}
          <p className="px-1.5 pt-1 text-xs text-slate-500">Most map-sourced contacts are unverified. Verified = found on the business's own website.</p>
        </div>
      </Section>

      <Section title={t('quality')} count={multi.status.length + (single.score_min ? 1 : 0)}>
        <div>
          <Label>{t('record_status')}</Label>
          {([['ready', 'ready'], ['lead', 'lead'], ['review', 'review']] as const).map(([k, l]) =>
            <Checkbox key={k} checked={multi.status.includes(k)} onChange={() => f.toggle('status', k)} label={t(l)} count={facets?.status.find((s) => s.k === k)?.n} />)}
          {!multi.status.length && <p className="px-1.5 text-xs text-slate-500">Default: ready + leads (records held for review are hidden).</p>}
        </div>
        <div>
          <Label>{t('score')}: ≥ {single.score_min ?? 0}</Label>
          <input type="range" min={0} max={100} step={5} value={Number(single.score_min ?? 0)} className="w-full accent-brand-600"
            onChange={(e) => f.set({ score_min: e.target.value === '0' ? undefined : e.target.value })} />
        </div>
      </Section>

      <Section title={t('source')} count={multi.layer.length + (single.src_conf_min ? 1 : 0)}>
        {meta.layers.map((l) => <Checkbox key={l.id} checked={multi.layer.includes(l.id)} onChange={() => f.toggle('layer', l.id)} label={l.label} count={facets?.layer.find((x) => x.k === l.id)?.n} />)}
        <div>
          <Label>Overture confidence ≥ {single.src_conf_min ?? '0.5'}</Label>
          <input type="range" min={0.5} max={1} step={0.05} value={Number(single.src_conf_min ?? 0.5)} className="w-full accent-brand-600"
            onChange={(e) => f.set({ src_conf_min: e.target.value === '0.5' ? undefined : e.target.value })} />
        </div>
      </Section>

      <Section title={t('advanced')} count={(single.fcommerce ? 1 : 0) + (single.chain ? 1 : 0) + (single.first_seen_after ? 1 : 0) + (single.list ? 1 : 0) + (single.not_list ? 1 : 0)}>
        <Checkbox checked={single.fcommerce === '1'} onChange={() => f.set({ fcommerce: single.fcommerce === '1' ? undefined : '1' })} label={t('fcommerce')} />
        <div>
          <Label>Chains</Label>
          <select className={select} value={single.chain ?? ''} onChange={(e) => f.set({ chain: e.target.value || undefined })}>
            <option value="">All businesses</option><option value="only">Chains / branches only</option><option value="independent">Independent only</option>
          </select>
        </div>
        <div>
          <Label>First seen on or after</Label>
          <input type="date" className={select} value={single.first_seen_after ?? ''} onChange={(e) => f.set({ first_seen_after: e.target.value || undefined })} />
        </div>
        <div>
          <Label>In my list</Label>
          <select className={select} value={single.list ?? ''} onChange={(e) => f.set({ list: e.target.value || undefined })}>
            <option value="">Any</option>{lists?.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.n})</option>)}
          </select>
        </div>
        <div>
          <Label>Not in list (exclude)</Label>
          <select className={select} value={single.not_list ?? ''} onChange={(e) => f.set({ not_list: e.target.value || undefined })}>
            <option value="">None</option>{lists?.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.n})</option>)}
          </select>
        </div>
      </Section>
      <div className={cx('px-4 py-3 text-xs text-slate-400')}>{t('not_exhaustive')}</div>
    </div>
  );
}
