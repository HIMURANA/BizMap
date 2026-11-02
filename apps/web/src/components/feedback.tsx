/**
 * In-app feedback instead of the browser's alert()/confirm(): toast messages and a confirm dialog.
 * Both are plain functions (callable from any click handler); <FeedbackHost /> renders them once at the app root.
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { Button, Spinner, cx } from './ui';

type Tone = 'success' | 'error' | 'info';
interface Toast { id: number; tone: Tone; text: string }
interface Ask { message: string; title: string; confirmLabel: string; danger: boolean; onYes: () => unknown; success?: string; resolve: (ok: boolean) => void }

let nextId = 1;
let toasts: Toast[] = [];
let ask: Ask | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Shows a short message in the corner; errors stay a little longer. */
export function toast(text: string, tone: Tone = 'success') {
  const t = { id: nextId++, tone, text };
  toasts = [...toasts, t].slice(-4);
  emit();
  setTimeout(() => dismiss(t.id), tone === 'error' ? 7000 : 3500);
}
const dismiss = (id: number) => { toasts = toasts.filter((t) => t.id !== id); emit(); };

/**
 * Asks before doing something. `onYes` may return a promise (e.g. mutation.mutateAsync): the dialog waits for it, then shows
 * `success` as a toast, or the error as a red toast. Resolves true when the user confirmed.
 */
export function confirmAction(message: string, onYes: () => unknown, opts: { title?: string; confirmLabel?: string; danger?: boolean; success?: string } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    ask?.resolve(false);
    ask = { message, onYes, resolve, title: opts.title ?? 'Are you sure?', confirmLabel: opts.confirmLabel ?? 'Confirm', danger: opts.danger ?? true, success: opts.success };
    emit();
  });
}

const TONE = {
  success: { icon: CheckCircle2, cls: 'text-emerald-600' },
  error: { icon: XCircle, cls: 'text-rose-600' },
  info: { icon: Info, cls: 'text-brand-600' },
} as const;

export function FeedbackHost() {
  const [, render] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => { const l = () => render((n) => n + 1); listeners.add(l); return () => { listeners.delete(l); }; }, []);
  const current = ask;
  const close = (ok: boolean) => { current?.resolve(ok); ask = null; setBusy(false); emit(); };
  useEffect(() => {
    if (!current) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) close(false); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [current, busy]);
  const yes = async () => {
    if (!current) return;
    setBusy(true);
    try {
      await current.onYes();
      if (current.success) toast(current.success);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
    close(true);
  };

  return (
    <>
      {current && (
        <div className="fixed inset-0 z-[60] flex items-end justify-center bg-slate-900/40 backdrop-blur-[2px] sm:items-center sm:p-4" onMouseDown={() => !busy && close(false)}>
          <div role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" onMouseDown={(e) => e.stopPropagation()}
            className="w-full rounded-t-2xl bg-white p-5 shadow-2xl dark:bg-slate-900 sm:max-w-sm sm:rounded-2xl">
            <div className="flex gap-3">
              <div className={cx('flex size-9 shrink-0 items-center justify-center rounded-full', current.danger ? 'bg-rose-50 text-rose-600 dark:bg-rose-500/10' : 'bg-brand-50 text-brand-600 dark:bg-brand-500/10')}>
                <AlertTriangle className="size-5" /></div>
              <div className="min-w-0">
                <h2 id="confirm-title" className="font-semibold">{current.title}</h2>
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{current.message}</p>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button onClick={() => close(false)} disabled={busy}>Cancel</Button>
              <Button autoFocus variant={current.danger ? 'danger' : 'primary'} onClick={() => void yes()} disabled={busy}>
                {busy && <Spinner className="size-3.5 border-white/40 border-t-white" />}{current.confirmLabel}</Button>
            </div>
          </div>
        </div>
      )}
      <div className="pointer-events-none fixed inset-x-0 bottom-20 z-[70] flex flex-col items-center gap-2 px-4 md:bottom-6 md:items-end md:pr-6" aria-live="polite">
        {toasts.map((t) => {
          const { icon: Icon, cls } = TONE[t.tone];
          return (
            <div key={t.id} role={t.tone === 'error' ? 'alert' : 'status'}
              className="pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-xl border border-slate-200 bg-white px-3.5 py-3 text-sm shadow-lg dark:border-slate-700 dark:bg-slate-900">
              <Icon className={cx('mt-0.5 size-4 shrink-0', cls)} />
              <span className="min-w-0 flex-1">{t.text}</span>
              <button onClick={() => dismiss(t.id)} className="rounded p-0.5 text-slate-400 hover:text-slate-600" aria-label="Dismiss"><X className="size-4" /></button>
            </div>
          );
        })}
      </div>
    </>
  );
}
