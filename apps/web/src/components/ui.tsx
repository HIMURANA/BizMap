import { clsx } from 'clsx';
import { X, CheckCircle2, Circle, AlertCircle, Search as SearchIcon } from 'lucide-react';
import { useEffect, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { Status } from '../lib/api';

export const cx = clsx;

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
export function Button({ variant = 'secondary', size = 'md', className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' }) {
  return (
    <button
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60 disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-8 px-2.5 text-xs' : 'h-9 px-3.5 text-sm',
        variant === 'primary' && 'bg-brand-600 text-white shadow-sm hover:bg-brand-700',
        variant === 'secondary' && 'border border-slate-200 bg-white text-slate-700 shadow-sm hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800',
        variant === 'ghost' && 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
        variant === 'danger' && 'bg-rose-600 text-white hover:bg-rose-700',
        className,
      )}
      {...rest}
    />
  );
}

export function Badge({ tone = 'slate', children, className, title }: { tone?: 'slate' | 'green' | 'amber' | 'rose' | 'blue' | 'violet'; children: ReactNode; className?: string; title?: string }) {
  const tones = {
    slate: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
    green: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300',
    amber: 'bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300',
    rose: 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300',
    blue: 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-100',
    violet: 'bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300',
  };
  return <span title={title} className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-medium', tones[tone], className)}>{children}</span>;
}

/** Verification status of one contact value. Unverified is the honest default for map-sourced data. */
export function VerifyIcon({ status, className }: { status: Status; className?: string }) {
  if (status === 'verified') return <span title="Verified (found on the business's own website)"><CheckCircle2 className={cx('size-3.5 text-emerald-600 dark:text-emerald-400', className)} /></span>;
  if (status === 'search_match') return <span title="Search match only: not verified"><AlertCircle className={cx('size-3.5 text-amber-500', className)} /></span>;
  return <span title="Unverified: from a map/open data source, never checked"><Circle className={cx('size-3.5 text-slate-400', className)} /></span>;
}

export function RecordStatusBadge({ status }: { status: string }) {
  if (status === 'lead') return <Badge tone="amber" title="Overture confidence below 0.8: unconfirmed listing">Lead</Badge>;
  if (status === 'needs_review') return <Badge tone="rose">Review</Badge>;
  if (status === 'verified') return <Badge tone="green">Verified</Badge>;
  return <Badge tone="green">Ready</Badge>;
}

export const LAYER_LABEL: Record<string, string> = { osm: 'OSM', overture: 'Overture', ad_library: 'Ad Library', web: 'Web' };
export function LayerBadge({ layer }: { layer: string }) {
  return <Badge tone={layer === 'osm' ? 'blue' : layer === 'overture' ? 'violet' : 'slate'}>{LAYER_LABEL[layer] ?? layer}</Badge>;
}

export function ScoreBar({ score }: { score: number }) {
  return (
    <div className="flex items-center gap-1.5" title={`Confidence ${score}/100 (internal evidence score, not a legitimacy claim)`}>
      <div className="h-1.5 w-12 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
        <div className={cx('h-full rounded-full', score >= 65 ? 'bg-emerald-500' : score >= 40 ? 'bg-brand-500' : 'bg-slate-400')} style={{ width: `${Math.min(100, score)}%` }} />
      </div>
      <span className="tabular-nums text-xs text-slate-500">{score}</span>
    </div>
  );
}

export function Checkbox({ checked, onChange, label, count, indeterminate }: { checked: boolean; onChange: () => void; label?: ReactNode; count?: number; indeterminate?: boolean }) {
  return (
    <label className="group flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-slate-100 dark:hover:bg-slate-800">
      <input type="checkbox" checked={checked} ref={(el) => { if (el) el.indeterminate = !!indeterminate; }} onChange={onChange}
        className="size-4 rounded border-slate-300 text-brand-600 accent-brand-600 dark:border-slate-600" />
      {label !== undefined && <span className="min-w-0 flex-1 truncate">{label}</span>}
      {count !== undefined && <span className="tabular-nums text-xs text-slate-400">{count.toLocaleString()}</span>}
    </label>
  );
}

export function Chip({ children, onRemove }: { children: ReactNode; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-brand-100 bg-brand-50 py-0.5 pl-2.5 pr-1 text-xs font-medium text-brand-700 dark:border-brand-500/30 dark:bg-brand-500/15 dark:text-brand-100">
      {children}
      <button onClick={onRemove} className="rounded-full p-0.5 hover:bg-brand-100 dark:hover:bg-brand-500/30" aria-label="Remove filter"><X className="size-3" /></button>
    </span>
  );
}

export function SearchInput({ value, onChange, placeholder, className }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  return (
    <div className={cx('relative', className)}>
      <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        className="h-9 w-full rounded-lg border border-slate-200 bg-white pl-8 pr-3 text-sm outline-none placeholder:text-slate-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 dark:border-slate-700 dark:bg-slate-900" />
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-0 backdrop-blur-[2px] sm:items-center sm:p-4" onMouseDown={onClose}>
      <div onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true"
        className={cx('flex max-h-[90vh] w-full flex-col rounded-t-2xl bg-white shadow-2xl dark:bg-slate-900 sm:rounded-2xl', wide ? 'sm:max-w-2xl' : 'sm:max-w-md')}>
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5 dark:border-slate-800">
          <h2 className="text-base font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded-md p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Close"><X className="size-5" /></button>
        </div>
        <div className="scroll-thin overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3 dark:border-slate-800">{footer}</div>}
      </div>
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <span className={cx('inline-block size-4 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600', className)} />;
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      {icon && <div className="text-slate-300 dark:text-slate-600">{icon}</div>}
      <p className="font-medium text-slate-700 dark:text-slate-200">{title}</p>
      {children && <div className="max-w-sm text-sm text-slate-500">{children}</div>}
    </div>
  );
}

/** Category colours, shared by map dots and table swatches (stable order, readable in light and dark). */
const PALETTE = ['#3b6cf6', '#e5484d', '#12a594', '#f5a524', '#8e4ec6', '#0090ff', '#d6409f', '#46a758', '#f76b15', '#6e56cf',
  '#00a2c7', '#ad7f58', '#e54666', '#29a383', '#978365', '#5b5bd6', '#cf5c00', '#3e63dd', '#30a46c', '#e93d82', '#0d74ce', '#a18072',
  '#7c66dc', '#ffb224', '#1c8f8f', '#dc3e42'];
const colorCache = new Map<string, string>();
export function catColor(cat: string, order?: string[]): string {
  if (!colorCache.has(cat)) {
    const i = order ? order.indexOf(cat) : -1;
    colorCache.set(cat, PALETTE[(i >= 0 ? i : colorCache.size) % PALETTE.length]!);
  }
  return colorCache.get(cat)!;
}
export const CAT_PALETTE = PALETTE;
