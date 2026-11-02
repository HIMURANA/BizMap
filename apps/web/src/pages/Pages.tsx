import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ListChecks, Download, Trash2, Pencil, Search, ArrowLeft, FileDown, Mail, BarChart3, Bell, Settings, Inbox, Upload, Users, UserPlus, MessageCircle, PhoneCall } from 'lucide-react';
import { api, type Meta } from '../lib/api';
import { contactsApi, downloadCsv } from '../lib/contacts';
import { Link, navigate } from '../lib/router';
import { DetailBody } from '../components/DetailDrawer';
import { AddToListDialog, ExportDialog, type Selection } from '../components/Dialogs';
import { ImportContactsDialog } from '../components/ContactImport';
import { Badge, Button, Empty, Modal, SearchInput, Spinner, cx } from '../components/ui';
import { confirmAction } from '../components/feedback';

function Page({ title, subtitle, actions, children }: { title: string; subtitle?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
        <div className="mb-6 flex flex-wrap items-end gap-3">
          <div className="min-w-48 flex-1"><h1 className="text-xl font-semibold">{title}</h1>{subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}</div>
          {actions}
        </div>
        {children}
      </div>
    </div>
  );
}
const card = 'rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900';

export function ListsPage() {
  const qc = useQueryClient();
  const { data: lists, isLoading } = useQuery({ queryKey: ['lists'], queryFn: api.lists });
  const [edit, setEdit] = useState<{ id?: string; name: string } | null>(null);
  const [exportSel, setExportSel] = useState<Selection | null>(null);
  const [importTo, setImportTo] = useState<{ id: string; name: string } | 'new' | null>(null);
  const save = useMutation({
    mutationFn: () => (edit?.id ? api.renameList(edit.id, edit.name) : api.createList(edit!.name)),
    onSuccess: () => { setEdit(null); qc.invalidateQueries({ queryKey: ['lists'] }); },
  });
  const del = useMutation({ mutationFn: api.deleteList, onSuccess: () => qc.invalidateQueries({ queryKey: ['lists'] }) });
  return (
    <Page title="Lists" subtitle="Hand-picked groups of businesses and your own contacts: territories, prospects, call sheets."
      actions={<div className="flex gap-2"><Button onClick={() => setImportTo('new')}><Upload className="size-4" />Import from Excel</Button><Button variant="primary" onClick={() => setEdit({ name: '' })}>New list</Button></div>}>
      {isLoading && <Spinner />}
      {lists?.length === 0 && (
        <div className={card}><Empty icon={<ListChecks className="size-10" />} title="No lists yet">Select businesses in Explore and choose “Add to list”, import your own contacts from an Excel or CSV file, or create an empty list here.</Empty></div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {lists?.map((l) => (
          <div key={l.id} className={`${card} p-4`}>
            <div className="flex items-start gap-2">
              <div className="flex-1"><div className="font-semibold">{l.name}</div><div className="text-sm text-slate-500">{l.n.toLocaleString()} businesses · {l.contacts.toLocaleString()} contacts · created {l.created_at.slice(0, 10)}</div></div>
              <button className="rounded p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800" onClick={() => setEdit({ id: l.id, name: l.name })} aria-label="Rename"><Pencil className="size-4" /></button>
              <button className="rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10" onClick={() => confirmAction('The list and its own contacts are deleted. The businesses stay in the database.', () => del.mutateAsync(l.id), { title: `Delete “${l.name}”?`, confirmLabel: 'Delete', success: 'List deleted' })} aria-label="Delete"><Trash2 className="size-4" /></button>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button size="sm" disabled={!l.n} onClick={() => navigate(`/?list=${l.id}`)}><Search className="size-3.5" /> Open in Explore</Button>
              <Button size="sm" onClick={() => navigate(`/lists/${l.id}`)}><Users className="size-3.5" /> Contacts</Button>
              <Button size="sm" onClick={() => setImportTo({ id: l.id, name: l.name })}><UserPlus className="size-3.5" /> Add contacts</Button>
              <Button size="sm" disabled={!l.n} onClick={() => setExportSel({ query: `list=${l.id}&status=ready,lead,review`, count: l.n })}><Download className="size-3.5" /> Export</Button>
            </div>
          </div>
        ))}
      </div>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Rename list' : 'New list'}
        footer={<><Button onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" disabled={!edit?.name.trim() || save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
        <input autoFocus value={edit?.name ?? ''} onChange={(e) => setEdit({ ...edit!, name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && edit?.name.trim() && save.mutate()}
          className="h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-900" placeholder="List name" />
      </Modal>
      <ExportDialog open={!!exportSel} onClose={() => setExportSel(null)} sel={exportSel} />
      <ImportContactsDialog open={!!importTo} onClose={() => setImportTo(null)} list={importTo === 'new' ? undefined : importTo ?? undefined} />
    </Page>
  );
}

/** One list's own contacts (typed in or imported); its directory businesses are shown in Explore. */
export function ListContactsPage({ id }: { id: string }) {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const list = useQuery({ queryKey: ['lists'], queryFn: api.lists, select: (ls) => ls.find((l) => l.id === id) });
  const { data, isLoading, error } = useQuery({ queryKey: ['list-contacts', id, search], queryFn: () => contactsApi.list(id, search) });
  const del = useMutation({ mutationFn: () => contactsApi.remove(id, [...sel]), onSuccess: () => { setSel(new Set()); qc.invalidateQueries({ queryKey: ['list-contacts', id] }); qc.invalidateQueries({ queryKey: ['lists'] }); } });
  const rows = data?.rows ?? [];
  const all = rows.length > 0 && rows.every((r) => sel.has(r.id));
  const toggle = (k: string) => { const n = new Set(sel); if (n.has(k)) n.delete(k); else n.add(k); setSel(n); };
  const name = list.data?.name ?? 'List';
  return (
    <Page title={name} subtitle={list.data ? `${list.data.contacts.toLocaleString()} own contacts · ${list.data.n.toLocaleString()} businesses from the directory` : undefined}
      actions={<div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => navigate('/lists')}><ArrowLeft className="size-4" /> Lists</Button>
        <Button size="sm" onClick={() => navigate(`/calls?new=1&list=${id}`)}><PhoneCall className="size-4" /> Call</Button>
        <Button size="sm" onClick={() => navigate(`/campaigns/new?channel=voice&list=${id}`)}><PhoneCall className="size-4" /> Auto call</Button>
        <Button size="sm" onClick={() => navigate(`/campaigns/new?channel=whatsapp&list=${id}`)}><MessageCircle className="size-4" /> WhatsApp</Button>
        <Button size="sm" onClick={() => navigate(`/campaigns/new?channel=email&list=${id}`)}><Mail className="size-4" /> Email</Button>
        <Button size="sm" variant="primary" onClick={() => setAdding(true)}><UserPlus className="size-4" /> Add contacts</Button></div>}>
      {error && <p className="text-rose-600">{(error as Error).message}</p>}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchInput value={search} onChange={setSearch} placeholder="Search name, phone, email…" className="min-w-48 flex-1" />
        {sel.size > 0 && <Button size="sm" variant="danger" disabled={del.isPending} onClick={() => confirmAction('They are removed from this list only.', () => del.mutateAsync(), { title: `Remove ${sel.size} contact${sel.size === 1 ? '' : 's'}?`, confirmLabel: 'Remove', success: `${sel.size} contact${sel.size === 1 ? '' : 's'} removed` })}><Trash2 className="size-3.5" /> Remove {sel.size}</Button>}
        <Button size="sm" disabled={!rows.length} onClick={() => downloadCsv(`${name.replace(/[^\w-]+/g, '_')}_contacts.csv`, ['Name', 'Company', 'Phone', 'Email', 'Area', 'District', 'Note'],
          rows.map((r) => [r.name, r.company, r.phone, r.email, r.area, r.district, r.note].map((v) => v ?? '')))}><Download className="size-3.5" /> CSV</Button>
      </div>
      {isLoading && <Spinner />}
      {data && !rows.length && (
        <div className={card}><Empty icon={<Users className="size-10" />} title={search ? 'No matching contacts' : 'No own contacts yet'}>
          {search ? 'Try another search.' : 'Add people by typing them in or importing an Excel/CSV file. Directory businesses in this list are shown in Explore.'}</Empty></div>
      )}
      {!!rows.length && (
        <div className={cx(card, 'overflow-x-auto')}>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500 dark:bg-slate-800/50"><tr>
              <th className="w-10 px-4 py-2.5"><input type="checkbox" checked={all} onChange={() => setSel(all ? new Set() : new Set(rows.map((r) => r.id)))} className="size-4 accent-brand-600" aria-label="Select all" /></th>
              <th className="font-medium">Name</th><th className="font-medium">Phone</th><th className="hidden font-medium sm:table-cell">Email</th><th className="hidden px-4 font-medium md:table-cell">Area</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="px-4 py-2.5"><input type="checkbox" checked={sel.has(r.id)} onChange={() => toggle(r.id)} className="size-4 accent-brand-600" aria-label="Select" /></td>
                <td className="max-w-56"><div className="truncate font-medium">{r.name || r.company || '—'}</div>{r.name && r.company && <div className="truncate text-xs text-slate-400">{r.company}</div>}</td>
                <td className="whitespace-nowrap tabular-nums">{r.phone ?? ''}</td>
                <td className="hidden max-w-56 truncate sm:table-cell">{r.email ?? ''}</td>
                <td className="hidden px-4 text-slate-500 md:table-cell">{[r.area, r.district].filter(Boolean).join(', ')}</td>
              </tr>
            ))}</tbody>
          </table>
          {data!.total > rows.length && <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-400 dark:border-slate-800">Showing {rows.length.toLocaleString()} of {data!.total.toLocaleString()}: search to narrow down.</p>}
        </div>
      )}
      <ImportContactsDialog open={adding} onClose={() => setAdding(false)} list={{ id, name }} />
    </Page>
  );
}

export function ExportsPage() {
  const { data, isLoading } = useQuery({ queryKey: ['exports'], queryFn: api.exports });
  const { data: credits } = useQuery({ queryKey: ['meta'], queryFn: api.meta, select: (m) => m.credits });
  return (
    <Page title="Exports" subtitle="Every file you exported, ready to download again." actions={<Badge tone="amber">{credits?.toLocaleString() ?? '…'} credits left</Badge>}>
      {isLoading && <Spinner />}
      {data?.length === 0 && <div className={card}><Empty icon={<FileDown className="size-10" />} title="No exports yet">Use Export in Explore or on a list. Location-only exports are free.</Empty></div>}
      {!!data?.length && (
        <div className={`${card} overflow-hidden`}>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500 dark:bg-slate-800/50">
              <tr><th className="px-4 py-2.5 font-medium">Name</th><th className="hidden px-4 font-medium sm:table-cell">Format</th><th className="px-4 font-medium">Rows</th><th className="hidden px-4 font-medium sm:table-cell">Credits</th><th className="hidden px-4 font-medium md:table-cell">Date</th><th /></tr>
            </thead>
            <tbody>
              {data.map((e) => (
                <tr key={e.id} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="px-4 py-3 font-medium">{e.name}<div className="text-xs font-normal text-slate-400">{e.preset.replace('_', ' ')}</div></td>
                  <td className="hidden px-4 uppercase text-slate-500 sm:table-cell">{e.format}</td>
                  <td className="px-4 tabular-nums">{e.rows.toLocaleString()}</td>
                  <td className="hidden px-4 tabular-nums sm:table-cell">{e.credits.toLocaleString()}</td>
                  <td className="hidden px-4 text-slate-500 md:table-cell">{new Date(e.created_at).toLocaleString()}</td>
                  <td className="px-4 text-right"><a href={`/api/exports/${e.id}/download`} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-brand-600 hover:bg-brand-50 dark:hover:bg-brand-500/10"><Download className="size-4" /><span className="hidden sm:inline">Download</span></a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
}

export function BusinessPage({ id, meta }: { id: string; meta: Meta }) {
  const { data: b, isLoading, error } = useQuery({ queryKey: ['business', id], queryFn: () => api.business(id) });
  const [listSel, setListSel] = useState<Selection | null>(null);
  const catOrder = meta.categories.map((c) => c.id);
  return (
    <Page title={b?.name ?? (isLoading ? 'Loading…' : 'Business')} actions={<Button size="sm" onClick={() => history.length > 1 ? history.back() : navigate('/')}><ArrowLeft className="size-4" /> Back</Button>}>
      {error && <p className="text-rose-600">{(error as Error).message}</p>}
      {b && (
        <div className={`${card} overflow-hidden`}>
          {b.lat !== null && b.lon !== null && (
            <a href={`https://www.openstreetmap.org/?mlat=${b.lat}&mlon=${b.lon}#map=18/${b.lat}/${b.lon}`} target="_blank" rel="noreferrer"
              className="block border-b border-slate-100 bg-slate-50 px-5 py-3 text-sm text-brand-600 hover:underline dark:border-slate-800 dark:bg-slate-800/40">
              {b.lat.toFixed(5)}, {b.lon.toFixed(5)}: open on map ↗</a>
          )}
          <div className="pt-4"><DetailBody b={b} catOrder={catOrder} onOpen={(x) => navigate(`/business/${encodeURIComponent(x)}`)} onAddToList={(ids) => setListSel({ ids, count: ids.length })} /></div>
        </div>
      )}
      <AddToListDialog open={!!listSel} onClose={() => setListSel(null)} sel={listSel} />
    </Page>
  );
}

const PLANNED: Record<string, { title: string; phase: string; icon: ReactNode; points: string[] }> = {
  campaigns: { title: 'Campaigns', phase: 'Phase 3–4', icon: <Mail className="size-10" />, points: [
    'Email campaigns: audience from a list or saved view → verified sender domain (SPF/DKIM/DMARC) → template with {{name}}, {{area}} (English/বাংলা) → schedule with daily limits.',
    'Every email carries an unsubscribe link; bounces and unsubscribes go to the suppression list automatically.',
    'Call queues: click-to-call, call script, outcome buttons (interested, call back, wrong number, closed, do-not-call) that correct the data.',
    'WhatsApp: Meta-approved templates, sent only to businesses with a recorded opt-in.'] },
  inbox: { title: 'Inbox', phase: 'Phase 3–4', icon: <Inbox className="size-10" />, points: ['Email replies and WhatsApp conversations in one place, assigned to team members, with notes and tags.', 'Free-form WhatsApp replies are allowed within 24 hours of the customer\'s last message.'] },
  reports: { title: 'Reports', phase: 'Phase 2', icon: <BarChart3 className="size-10" />, points: ['Site-selection radius report: competitors, anchors (schools, hospitals, markets) and businesses per 10,000 people around any point.', 'District coverage and density comparisons. Coverage compares districts with each other, not with reality.'] },
  alerts: { title: 'Alerts', phase: 'Phase 5', icon: <Bell className="size-10" />, points: ['Monthly “new businesses in my area” alerts from OpenStreetMap / Overture snapshot differences, for any saved view.'] },
  settings: { title: 'Settings', phase: 'Phase 2–4', icon: <Settings className="size-10" />, points: ['Team members and roles, billing and credits (SSLCommerz / bKash), sender domains, WhatsApp number, suppression and do-not-call lists, opt-in records.'] },
};

export function PlannedPage({ which }: { which: string }) {
  const p = PLANNED[which] ?? PLANNED.campaigns!;
  return (
    <Page title={p.title}>
      <div className={`${card} p-6`}>
        <div className="flex flex-col items-center gap-3 pb-4 text-center">
          <div className="text-slate-300 dark:text-slate-600">{p.icon}</div>
          <Badge tone="blue">Planned · {p.phase}</Badge>
          <p className="max-w-md text-sm text-slate-500">This module is not built yet. Here is what it will do:</p>
        </div>
        <ul className="mx-auto max-w-2xl space-y-2.5 text-sm text-slate-600 dark:text-slate-300">
          {p.points.map((x, i) => <li key={i} className="flex gap-2"><span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-brand-500" />{x}</li>)}
        </ul>
        <div className="mt-6 flex justify-center gap-2">
          <Link to="/"><Button variant="primary"><Search className="size-4" /> Explore businesses</Button></Link>
          <Link to="/lists"><Button><ListChecks className="size-4" /> Build a list</Button></Link>
        </div>
      </div>
    </Page>
  );
}

