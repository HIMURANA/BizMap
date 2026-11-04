import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, RefreshCw, MessageCircle } from 'lucide-react';
import { api } from '../lib/api';
import { out, type WaButton, type WaTemplateDraft, type WaTemplateRow } from '../lib/outreach';
import { Badge, Button, Empty, Modal, Spinner, cx } from '../components/ui';
import { confirmAction, toast } from '../components/feedback';

const card = 'rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900';
const input = 'h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-900';
const area = 'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900';
const label = 'mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300';

const STATUS_TONE: Record<string, 'green' | 'amber' | 'rose' | 'slate'> = { APPROVED: 'green', PENDING: 'amber', IN_APPEAL: 'amber', REJECTED: 'rose', PAUSED: 'rose', DISABLED: 'rose' };
const LANGUAGES: { code: string; label: string }[] = [{ code: 'en_US', label: 'English (US)' }, { code: 'en', label: 'English' }, { code: 'en_GB', label: 'English (UK)' }, { code: 'bn', label: 'Bangla' }];
const BUTTON_TYPES: { type: WaButton['type']; label: string }[] = [{ type: 'QUICK_REPLY', label: 'Quick reply' }, { type: 'URL', label: 'Open a link' }, { type: 'PHONE_NUMBER', label: 'Call a phone' }];

type HeaderKind = 'NONE' | 'TEXT' | 'IMAGE';
interface Form { name: string; language: string; category: 'MARKETING' | 'UTILITY'; headerKind: HeaderKind; headerText: string; headerUrl: string; body: string; examples: string[]; footer: string; buttons: WaButton[] }
const blank: Form = { name: '', language: 'en_US', category: 'MARKETING', headerKind: 'NONE', headerText: '', headerUrl: '', body: '', examples: [], footer: '', buttons: [] };

/** Distinct {{n}} numbers used in the body. */
const variableCount = (body: string) => new Set(body.match(/\{\{\d+\}\}/g) ?? []).size;

function toDraft(f: Form): WaTemplateDraft {
  const header: WaTemplateDraft['header'] = f.headerKind === 'TEXT' ? { format: 'TEXT', text: f.headerText } : f.headerKind === 'IMAGE' ? { format: 'IMAGE', url: f.headerUrl } : { format: 'NONE' };
  return { name: f.name, language: f.language, category: f.category, header, body: f.body, examples: f.examples.slice(0, variableCount(f.body)), footer: f.footer, buttons: f.buttons };
}

/** Templates tab of the Campaigns page: every template with its Meta review status, plus a form to submit a new one. */
export function TemplatesTab() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const isAdmin = me.data?.workspace?.role === 'owner' || me.data?.workspace?.role === 'admin';
  const { data, isLoading, isFetching, error, refetch } = useQuery({ queryKey: ['wa-templates-all'], queryFn: out.allTemplates });
  const [open, setOpen] = useState(false);
  const remove = useMutation({ mutationFn: out.deleteTemplate, onSuccess: () => { void qc.invalidateQueries({ queryKey: ['wa-templates-all'] }); void qc.invalidateQueries({ queryKey: ['wa-templates'] }); } });

  const rows = data?.templates ?? [];
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-sm text-slate-500">Meta reviews every template before it can be sent (usually minutes, up to 24 hours). Approved templates appear in the campaign template list.</p>
        <Button onClick={() => void refetch()} disabled={isFetching}><RefreshCw className={cx('size-4', isFetching && 'animate-spin')} />Refresh</Button>
        {isAdmin && <Button variant="primary" onClick={() => setOpen(true)} disabled={data?.mode !== 'live'}><Plus className="size-4" />New template</Button>}
      </div>
      {!isAdmin && <p className="mb-3 text-sm text-slate-500">Only workspace admins can create or delete templates.</p>}
      {isLoading && <Spinner />}
      {error && <div className="mb-3 rounded-xl bg-rose-50 p-3 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-200">{(error as Error).message}</div>}
      {data && data.mode !== 'live' && <div className={card}><Empty icon={<MessageCircle className="size-10" />} title="WhatsApp is not connected">Connect your WhatsApp Business account in Settings → Sending to create templates.</Empty></div>}
      {data?.mode === 'live' && rows.length === 0 && <div className={card}><Empty icon={<MessageCircle className="size-10" />} title="No templates yet">Create a template and submit it to Meta for approval.</Empty></div>}
      {rows.length > 0 && (
        <div className="space-y-3">
          {rows.map((t) => <TemplateCard key={t.id} t={t} canDelete={isAdmin} onDelete={() => confirmAction('Messages that use it stop working. This cannot be undone.', () => remove.mutateAsync(t.name), { title: `Delete ${t.name}?`, confirmLabel: 'Delete', danger: true, success: 'Template deleted' })} />)}
        </div>
      )}
      <NewTemplate open={open} onClose={() => setOpen(false)} onDone={() => { setOpen(false); void qc.invalidateQueries({ queryKey: ['wa-templates-all'] }); }} />
    </>
  );
}

function TemplateCard({ t, canDelete, onDelete }: { t: WaTemplateRow; canDelete: boolean; onDelete: () => void }) {
  return (
    <div className={cx(card, 'p-4')}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{t.name}</span>
        <Badge tone={STATUS_TONE[t.status] ?? 'slate'}>{t.status.toLowerCase().replace('_', ' ')}</Badge>
        <span className="text-xs text-slate-500">{t.language} · {t.category.toLowerCase()}{t.header_format ? ` · ${t.header_format.toLowerCase()} header` : ''}</span>
        {canDelete && <button className="ml-auto text-slate-300 hover:text-rose-600" title="Delete template" onClick={onDelete}><Trash2 className="size-4" /></button>}
      </div>
      <p className="mt-2 whitespace-pre-wrap text-sm text-slate-600 dark:text-slate-300">{t.body}</p>
      {t.footer && <p className="mt-1 text-xs text-slate-400">{t.footer}</p>}
      {t.buttons.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{t.buttons.map((b) => <Badge key={`${b.type}${b.text}`} tone="blue">{b.text}</Badge>)}</div>}
      {t.rejected_reason && <p className="mt-2 text-xs text-rose-600">Meta rejected it: {t.rejected_reason.toLowerCase().replace(/_/g, ' ')}. Edit the text and submit it again under a new name.</p>}
    </div>
  );
}

function NewTemplate({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState<Form>(blank);
  const [error, setError] = useState('');
  const set = (p: Partial<Form>) => setF((x) => ({ ...x, ...p }));
  const vars = useMemo(() => variableCount(f.body), [f.body]);
  const submit = useMutation({
    mutationFn: () => out.createTemplate(toDraft(f)),
    onSuccess: () => { toast('Template submitted to Meta for review'); setF(blank); setError(''); onDone(); },
    onError: (e: Error) => setError(e.message),
  });
  const setButton = (i: number, b: WaButton) => set({ buttons: f.buttons.map((x, k) => (k === i ? b : x)) });
  const addButton = (type: WaButton['type']) => set({ buttons: [...f.buttons, type === 'QUICK_REPLY' ? { type, text: '' } : type === 'URL' ? { type, text: '', url: '' } : { type, text: '', phone_number: '' }] });
  const changeType = (i: number, type: WaButton['type']) => setButton(i, type === 'QUICK_REPLY' ? { type, text: f.buttons[i]!.text } : type === 'URL' ? { type, text: f.buttons[i]!.text, url: '' } : { type, text: f.buttons[i]!.text, phone_number: '' });

  return (
    <Modal open={open} onClose={onClose} wide title="New WhatsApp template"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => { setError(''); submit.mutate(); }} disabled={submit.isPending || !f.name || !f.body}>{submit.isPending ? 'Submitting…' : 'Submit to Meta'}</Button></>}>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="sm:col-span-3"><label className={label}>Name</label><input className={input} placeholder="summer_offer" value={f.name} onChange={(e) => set({ name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} /><p className="mt-1 text-xs text-slate-400">Lowercase letters, numbers and underscores. It cannot be changed later.</p></div>
          <div><label className={label}>Language</label><select className={input} value={f.language} onChange={(e) => set({ language: e.target.value })}>{LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}</select></div>
          <div><label className={label}>Category</label><select className={input} value={f.category} onChange={(e) => set({ category: e.target.value as Form['category'] })}><option value="MARKETING">Marketing (offers, promotions)</option><option value="UTILITY">Utility (updates, reminders)</option></select></div>
        </div>

        <div>
          <label className={label}>Header (optional)</label>
          <select className={input} value={f.headerKind} onChange={(e) => set({ headerKind: e.target.value as HeaderKind })}><option value="NONE">No header</option><option value="TEXT">Text</option><option value="IMAGE">Image</option></select>
          {f.headerKind === 'TEXT' && <input className={cx(input, 'mt-2')} maxLength={60} placeholder="Header text (no variables)" value={f.headerText} onChange={(e) => set({ headerText: e.target.value })} />}
          {f.headerKind === 'IMAGE' && <><input className={cx(input, 'mt-2')} placeholder="https://… link to a JPG or PNG sample (up to 5 MB)" value={f.headerUrl} onChange={(e) => set({ headerUrl: e.target.value })} /><p className="mt-1 text-xs text-slate-400">This is the sample Meta reviews. When you send a campaign you choose the real image link.</p></>}
        </div>

        <div>
          <div className="mb-1 flex items-center"><label className={cx(label, 'mb-0 flex-1')}>Message body</label><button type="button" className="text-xs text-brand-600 hover:underline" onClick={() => set({ body: `${f.body}{{${vars + 1}}}` })}>+ Add variable {`{{${vars + 1}}}`}</button></div>
          <textarea className={area} rows={5} maxLength={1024} placeholder="Hello {{1}}, we have an offer for {{2}}…" value={f.body} onChange={(e) => set({ body: e.target.value })} />
          <p className="mt-1 text-xs text-slate-400">{f.body.length}/1024. Variables are numbered {'{{1}}, {{2}}…'} and filled in per campaign.</p>
        </div>

        {vars > 0 && (
          <div>
            <label className={label}>Example values (Meta needs one per variable)</label>
            <div className="grid gap-2 sm:grid-cols-2">{Array.from({ length: vars }, (_, i) => (
              <input key={i} className={input} placeholder={`Example for {{${i + 1}}}`} value={f.examples[i] ?? ''} onChange={(e) => set({ examples: Array.from({ length: vars }, (_, k) => (k === i ? e.target.value : f.examples[k] ?? '')) })} />
            ))}</div>
          </div>
        )}

        <div><label className={label}>Footer (optional)</label><input className={input} maxLength={60} placeholder="Reply STOP to opt out" value={f.footer} onChange={(e) => set({ footer: e.target.value })} /></div>

        <div>
          <label className={label}>Buttons (optional, up to 3)</label>
          <div className="space-y-2">
            {f.buttons.map((b, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 p-2 dark:border-slate-700">
                <select className={cx(input, 'w-36')} value={b.type} onChange={(e) => changeType(i, e.target.value as WaButton['type'])}>{BUTTON_TYPES.map((x) => <option key={x.type} value={x.type}>{x.label}</option>)}</select>
                <input className={cx(input, 'w-40')} maxLength={25} placeholder="Button label" value={b.text} onChange={(e) => setButton(i, { ...b, text: e.target.value })} />
                {b.type === 'URL' && <input className={cx(input, 'min-w-48 flex-1')} placeholder="https://…" value={b.url} onChange={(e) => setButton(i, { ...b, url: e.target.value })} />}
                {b.type === 'PHONE_NUMBER' && <input className={cx(input, 'min-w-48 flex-1')} placeholder="+8801712345678" value={b.phone_number} onChange={(e) => setButton(i, { ...b, phone_number: e.target.value })} />}
                <button type="button" className="ml-auto text-slate-300 hover:text-rose-600" title="Remove button" onClick={() => set({ buttons: f.buttons.filter((_, k) => k !== i) })}><Trash2 className="size-4" /></button>
              </div>
            ))}
            {f.buttons.length < 3 && <div className="flex flex-wrap gap-2">{BUTTON_TYPES.map((x) => <Button key={x.type} size="sm" onClick={() => addButton(x.type)}><Plus className="size-3.5" />{x.label}</Button>)}</div>}
          </div>
          <p className="mt-1 text-xs text-slate-400">Link buttons cannot contain variables. Keep quick-reply buttons together.</p>
        </div>

        {error && <div className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-200">{error}</div>}
      </div>
    </Modal>
  );
}
