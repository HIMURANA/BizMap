import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FileSpreadsheet, Keyboard, Plus, Check, Download, Upload } from 'lucide-react';
import { api } from '../lib/api';
import {
  FIELDS, bdMobile, contactsApi, downloadTemplate, guessMapping, looksLikeHeader, parseTyped, reachable, readTable, rowsToContacts, usable, validEmail,
  type Channel, type Contact, type ImportResult,
} from '../lib/contacts';
import { Badge, Button, Modal, Spinner, cx } from './ui';

const input = 'h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-900';

/**
 * Collects contacts from an Excel/CSV file or from typed text. `value` is the full set ready to save; the parent decides where it goes
 * (a list, a campaign or a call queue). `channel` narrows what counts as reachable (emails for email campaigns, BD mobiles for WhatsApp, any phone for calls).
 */
export function ContactImport({ value, onChange, channel }: { value: Contact[]; onChange: (c: Contact[]) => void; channel?: Channel }) {
  const [tab, setTab] = useState<'file' | 'type'>('file');
  const [file, setFile] = useState<{ name: string; rows: string[][]; header: boolean } | null>(null);
  const [map, setMap] = useState<Record<keyof Contact, number> | null>(null);
  const [fileErr, setFileErr] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [text, setText] = useState('');
  const [one, setOne] = useState({ name: '', phone: '', email: '' });

  const switchTab = (t: 'file' | 'type') => { setTab(t); onChange(t === 'file' ? (file && map ? rowsToContacts(file.header ? file.rows.slice(1) : file.rows, map) : []) : parseTyped(text)); };
  const pick = async (f: File | undefined) => {
    if (!f) return;
    setFileErr(null); setReading(true);
    try {
      const rows = await readTable(f);
      if (!rows.length) throw new Error('The file is empty.');
      const header = looksLikeHeader(rows[0]!);
      // no header row: guess columns from the values of the first row
      const m = header ? guessMapping(rows[0]!) : guessMapping(rows[0]!.map((c) => (validEmail(c) ? 'email' : bdMobile(c) ? 'phone' : '')));
      if (!header && m.name < 0) { const i = rows[0]!.findIndex((c, j) => c && !Object.values(m).includes(j)); if (i >= 0) m.name = i; }
      setFile({ name: f.name, rows, header }); setMap(m);
      onChange(rowsToContacts(header ? rows.slice(1) : rows, m));
    } catch (e) { setFile(null); setMap(null); onChange([]); setFileErr((e as Error).message); }
    finally { setReading(false); }
  };
  const remap = (key: keyof Contact, col: number) => {
    const m = { ...map!, [key]: col };
    setMap(m);
    onChange(rowsToContacts(file!.header ? file!.rows.slice(1) : file!.rows, m));
  };
  const typed = (t: string) => { setText(t); onChange(parseTyped(t)); };
  const addOne = () => {
    const line = [one.name, one.phone, one.email].map((x) => x.trim().replace(/,/g, ' ')).filter(Boolean).join(', ');
    if (!line) return;
    typed(text.trim() ? `${text.trimEnd()}\n${line}` : line);
    setOne({ name: '', phone: '', email: '' });
  };

  const ok = (c: Contact) => (channel ? reachable(c, channel) : usable(c));
  const good = value.filter(ok).length;
  const columns = file ? (file.header ? file.rows[0]! : file.rows[0]!.map((_, i) => `Column ${i + 1}`)) : [];

  return (
    <div className="space-y-3">
      <div className="flex gap-1 rounded-lg bg-slate-100 p-1 text-sm dark:bg-slate-800">
        {([['file', 'Excel / CSV file', FileSpreadsheet], ['type', 'Type or paste', Keyboard]] as const).map(([k, l, Icon]) => (
          <button key={k} type="button" onClick={() => switchTab(k)} className={cx('flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 font-medium', tab === k ? 'bg-white shadow-sm dark:bg-slate-900' : 'text-slate-500')}>
            <Icon className="size-4" />{l}</button>
        ))}
      </div>

      {tab === 'file' ? (
        <div className="space-y-3">
          <label className="flex cursor-pointer flex-col items-center gap-1 rounded-xl border-2 border-dashed border-slate-200 px-4 py-5 text-center text-sm hover:border-brand-500 dark:border-slate-700"
            onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); pick(e.dataTransfer.files[0]); }}>
            {reading ? <Spinner /> : <Upload className="size-6 text-slate-400" />}
            <span className="font-medium">{file ? file.name : 'Choose or drop an Excel (.xlsx) or CSV file'}</span>
            <span className="text-xs text-slate-500">{file ? `${(file.rows.length - (file.header ? 1 : 0)).toLocaleString()} rows · click to choose another file` : 'First sheet is used. A header row (Name, Phone, Email…) is detected automatically.'}</span>
            <input type="file" accept=".xlsx,.csv,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="hidden" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
          {fileErr && <p className="text-sm text-rose-600">{fileErr}</p>}
          {!file && <button type="button" onClick={downloadTemplate} className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline"><Download className="size-3.5" />Download a template</button>}
          {file && map && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {FIELDS.filter((f) => !channel || f.key !== 'note').map((f) => (
                <label key={f.key} className="space-y-0.5"><span className="text-xs text-slate-500">{f.label}</span>
                  <select value={map[f.key]} onChange={(e) => remap(f.key, Number(e.target.value))} className={cx(input, 'h-8 px-2 text-xs')}>
                    <option value={-1}>— not in file —</option>
                    {columns.map((c, i) => <option key={i} value={i}>{c || `Column ${i + 1}`}</option>)}
                  </select></label>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <form className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]" onSubmit={(e) => { e.preventDefault(); addOne(); }}>
            <input value={one.name} onChange={(e) => setOne({ ...one, name: e.target.value })} placeholder="Name" className={input} />
            {channel !== 'email' && <input value={one.phone} onChange={(e) => setOne({ ...one, phone: e.target.value })} placeholder={channel === 'whatsapp' ? 'WhatsApp number' : 'Phone'} inputMode="tel" className={input} />}
            {channel !== 'whatsapp' && channel !== 'phone' && <input value={one.email} onChange={(e) => setOne({ ...one, email: e.target.value })} placeholder="Email" type="email" className={input} />}
            <Button type="submit" disabled={!(one.phone.trim() || one.email.trim())}><Plus className="size-4" />Add</Button>
          </form>
          <textarea value={text} onChange={(e) => typed(e.target.value)} rows={6} spellCheck={false}
            placeholder={channel === 'email' ? 'One per line, e.g.\nRahim Uddin, rahim@example.com\nkarim@example.com' : channel === 'whatsapp' || channel === 'phone' ? 'One per line, e.g.\nRahim Uddin, 01712345678\n01812345678' : 'One per line: name, phone, email, company\nRahim Uddin, 01712345678, rahim@example.com, Rahim Pharmacy\n01812345678'}
            className="w-full rounded-lg border border-slate-200 bg-white p-3 font-mono text-xs dark:border-slate-700 dark:bg-slate-900" />
        </div>
      )}

      {value.length > 0 && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone="green">{good.toLocaleString()} ready</Badge>
            {value.length - good > 0 && <Badge tone="amber">{(value.length - good).toLocaleString()} will be skipped</Badge>}
            <span className="text-xs text-slate-500">{channel === 'email' ? 'needs a valid email' : channel === 'whatsapp' ? 'needs a Bangladeshi mobile number' : channel === 'phone' ? 'needs a phone number' : 'needs a phone or email'}</span>
          </div>
          <div className="max-h-48 overflow-auto rounded-lg border border-slate-100 dark:border-slate-800">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-slate-50 text-left text-slate-500 dark:bg-slate-800"><tr><th className="px-2 py-1.5 font-medium">Name</th><th className="font-medium">Phone</th><th className="px-2 font-medium">Email</th></tr></thead>
              <tbody>{value.slice(0, 50).map((c, i) => (
                <tr key={i} className={cx('border-t border-slate-100 dark:border-slate-800', !ok(c) && 'text-slate-400 line-through')}>
                  <td className="max-w-40 truncate px-2 py-1">{c.name || c.company || '—'}</td><td className="whitespace-nowrap">{c.phone}</td><td className="max-w-48 truncate px-2">{c.email}</td>
                </tr>
              ))}</tbody>
            </table>
            {value.length > 50 && <p className="border-t border-slate-100 px-2 py-1 text-xs text-slate-400 dark:border-slate-800">…and {(value.length - 50).toLocaleString()} more</p>}
          </div>
        </div>
      )}
    </div>
  );
}

/** Adds contacts to an existing list, or (without `list`) creates a new list from them. */
export function ImportContactsDialog({ open, onClose, list }: { open: boolean; onClose: () => void; list?: { id: string; name: string } }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<(ImportResult & { list: string }) | null>(null);
  useEffect(() => { if (open) { setName(''); setContacts([]); setResult(null); setProgress(0); } }, [open]);
  const ready = useMemo(() => contacts.filter(usable), [contacts]);
  const save = useMutation({
    mutationFn: async () => {
      const target = list ?? (await api.createList(name.trim()));
      const source = contacts.length > 1 ? 'import' : 'manual';
      const r = await contactsApi.add(target.id, ready, source, setProgress);
      return { ...r, list: target.name };
    },
    onSuccess: (r) => { setResult(r); qc.invalidateQueries({ queryKey: ['lists'] }); qc.invalidateQueries({ queryKey: ['list-contacts'] }); },
  });

  return (
    <Modal open={open} onClose={onClose} wide title={list ? `Add contacts to “${list.name}”` : 'New list from contacts'}
      footer={result ? <Button variant="primary" onClick={onClose}>Done</Button> : <>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!ready.length || (!list && !name.trim()) || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? <><Spinner className="size-3.5" />{progress.toLocaleString()} / {ready.length.toLocaleString()}</> : `Add ${ready.length.toLocaleString()} contact${ready.length === 1 ? '' : 's'}`}</Button></>}>
      {result ? (
        <div className="space-y-2 text-sm">
          <p className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400"><Check className="size-4" />{result.added.toLocaleString()} contacts added to “{result.list}”.</p>
          {result.duplicates > 0 && <p className="text-slate-500">{result.duplicates.toLocaleString()} were already in the list (same phone and email) and were skipped.</p>}
          {result.rejected.length > 0 && <p className="text-amber-700 dark:text-amber-300">{result.rejected.length.toLocaleString()} rows rejected (rows {result.rejected.slice(0, 10).map((r) => r.row).join(', ')}{result.rejected.length > 10 ? '…' : ''}): no usable phone or email.</p>}
        </div>
      ) : (
        <div className="space-y-4">
          {!list && <label className="block space-y-1.5"><span className="text-sm font-medium">List name</span>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Trade fair visitors 2026" className={input} /></label>}
          <ContactImport value={contacts} onChange={setContacts} />
          <p className="text-xs text-slate-500">Only add people you are allowed to contact. Everyone gets an unsubscribe option, and your do-not-contact list is always respected.</p>
          {save.error && <p className="text-sm text-rose-600">{(save.error as Error).message}</p>}
        </div>
      )}
    </Modal>
  );
}
