import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Coins, Search } from 'lucide-react';
import { admin, type AdminDataCounts, type AdminWorkspace, type PurgeWhat } from '../lib/admin';
import { type Role } from '../lib/api';
import { Link, navigate, useLocation } from '../lib/router';
import { Badge, Button, Modal, Spinner, cx } from '../components/ui';
import { confirmAction, toast } from '../components/feedback';
import { Page } from './CampaignPages';

const card = 'rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900';
const input = 'h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-900';
const th = 'px-4 py-2.5 text-left text-xs font-medium text-slate-500';
const td = 'px-4 py-2.5';
const fmt = (d: string | null) => (d ? new Date(d).toLocaleString() : '—');
const n = (v: number) => v.toLocaleString();

const TABS = [['overview', 'Overview'], ['workspaces', 'Workspaces'], ['users', 'Users'], ['credits', 'Credits'], ['payments', 'Payments'], ['audit', 'Audit log']] as const;
type Tab = typeof TABS[number][0];

function useDebounced(value: string, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}
const Table = ({ head, children, empty }: { head: string[]; children: ReactNode; empty?: boolean }) => (
  <div className={cx(card, 'overflow-x-auto')}>
    <table className="w-full text-sm">
      <thead className="bg-slate-50 dark:bg-slate-800/50"><tr>{head.map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
      <tbody>{children}</tbody>
    </table>
    {empty && <p className="p-6 text-center text-sm text-slate-500">Nothing here.</p>}
  </div>
);
const SearchBox = ({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) => (
  <div className="relative mb-3 max-w-sm"><Search className="absolute left-3 top-2.5 size-4 text-slate-400" /><input className={cx(input, 'pl-9')} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} /></div>
);
const Err = ({ e }: { e: unknown }) => (e ? <div className="mb-3 rounded-xl bg-rose-50 p-3 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-200">{(e as Error).message}</div> : null);

/** Platform-admin area (/admin): every workspace, user and credit balance. The server refuses anyone who is not a platform admin. */
export function AdminPage() {
  const { path, search } = useLocation();
  const ws = path.match(/^\/admin\/workspaces\/([^/]+)$/)?.[1];
  const user = path.match(/^\/admin\/users\/([^/]+)$/)?.[1];
  const tabParam = new URLSearchParams(search).get('tab');
  const tab: Tab = TABS.some(([k]) => k === tabParam) ? (tabParam as Tab) : 'overview';
  if (ws) return <WorkspaceDetail id={ws} />;
  if (user) return <UserDetail id={user} />;
  return (
    <Page title="Platform admin" subtitle="All workspaces, users and credits. Every change is recorded in the audit log.">
      <div className="mb-4 flex flex-wrap gap-1 border-b border-slate-200 dark:border-slate-800">
        {TABS.map(([k, l]) => <Link key={k} to={k === 'overview' ? '/admin' : `/admin?tab=${k}`} className={cx('-mb-px border-b-2 px-3 py-2 text-sm font-medium', tab === k ? 'border-brand-600 text-brand-700 dark:text-brand-100' : 'border-transparent text-slate-500')}>{l}</Link>)}
      </div>
      {tab === 'overview' && <Overview />}
      {tab === 'workspaces' && <Workspaces />}
      {tab === 'users' && <Users />}
      {tab === 'credits' && <Credits />}
      {tab === 'payments' && <Payments />}
      {tab === 'audit' && <Audit />}
    </Page>
  );
}

function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return <div className={cx(card, 'p-4')}><div className="text-xs text-slate-500">{label}</div><div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>{sub && <div className="mt-0.5 text-xs text-slate-400">{sub}</div>}</div>;
}

function Overview() {
  const { data, error, isLoading } = useQuery({ queryKey: ['admin-overview'], queryFn: admin.overview });
  if (isLoading) return <Spinner />;
  if (error || !data) return <Err e={error} />;
  const t = data.totals;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Workspaces" value={n(t.workspaces)} sub={t.suspended ? `${t.suspended} suspended` : undefined} />
        <Stat label="Users" value={n(t.users)} sub={`${t.new_users_7d} new in 7 days${t.disabled ? `, ${t.disabled} disabled` : ''}`} />
        <Stat label="Campaigns" value={n(t.campaigns)} sub={t.sending ? `${t.sending} sending now` : undefined} />
        <Stat label="WhatsApp connected" value={n(t.whatsapp_connected)} />
        <Stat label="Credits issued" value={n(t.credits_issued)} />
        <Stat label="Credits used" value={n(t.credits_used)} />
        <Stat label="Revenue (paid)" value={`৳${n(Math.round(t.revenue_bdt))}`} />
      </div>
      <div className="grid gap-5 md:grid-cols-2">
        <div><h2 className="mb-2 text-sm font-medium">Recent payments</h2>
          <Table head={['Workspace', 'Pack', 'Amount', 'Status']} empty={!data.payments.length}>{data.payments.map((p) => <tr key={p.tran_id} className="border-t border-slate-100 dark:border-slate-800"><td className={td}>{p.workspace}</td><td className={td}>{p.pack}</td><td className={td}>৳{n(p.amount_bdt)}</td><td className={td}><Badge tone={p.status === 'paid' ? 'green' : p.status === 'pending' ? 'amber' : 'rose'}>{p.status}</Badge></td></tr>)}</Table></div>
        <div><h2 className="mb-2 text-sm font-medium">Recent admin actions</h2>
          <Table head={['Who', 'Action', 'Target']} empty={!data.activity.length}>{data.activity.map((a, i) => <tr key={i} className="border-t border-slate-100 dark:border-slate-800"><td className={td}>{a.admin_email}</td><td className={td}>{a.action}</td><td className={td}>{a.target ?? '—'}</td></tr>)}</Table></div>
      </div>
    </div>
  );
}

function Workspaces() {
  const [term, setTerm] = useState('');
  const q = useDebounced(term);
  const { data, error, isLoading } = useQuery({ queryKey: ['admin-workspaces', q], queryFn: () => admin.workspaces(q) });
  return (
    <>
      <SearchBox value={term} onChange={setTerm} placeholder="Search workspace name or member email…" />
      <Err e={error} />
      {isLoading ? <Spinner /> : (
        <Table head={['Workspace', 'Owner', 'Members', 'Credits', 'Campaigns', 'WhatsApp', 'Created']} empty={!data?.length}>
          {data?.map((w) => (
            <tr key={w.id} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/40" onClick={() => navigate(`/admin/workspaces/${w.id}`)}>
              <td className={cx(td, 'font-medium')}>{w.name} {w.suspended_at && <Badge tone="rose">suspended</Badge>}</td>
              <td className={cx(td, 'text-slate-500')}>{w.owner_email ?? '—'}</td>
              <td className={cx(td, 'tabular-nums')}>{w.members}</td>
              <td className={cx(td, 'tabular-nums')}>{n(w.balance)}</td>
              <td className={cx(td, 'tabular-nums')}>{w.campaigns}</td>
              <td className={td}>{w.whatsapp ? <Badge tone="green">connected</Badge> : <span className="text-slate-400">—</span>}</td>
              <td className={cx(td, 'text-slate-500')}>{new Date(w.created_at).toLocaleDateString()}</td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}

function Users() {
  const [term, setTerm] = useState('');
  const q = useDebounced(term);
  const { data, error, isLoading } = useQuery({ queryKey: ['admin-users', q], queryFn: () => admin.users(q) });
  return (
    <>
      <SearchBox value={term} onChange={setTerm} placeholder="Search name or email…" />
      <Err e={error} />
      {isLoading ? <Spinner /> : (
        <Table head={['User', 'Email', 'Workspaces', 'Last sign-in', 'Joined']} empty={!data?.length}>
          {data?.map((u) => (
            <tr key={u.id} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/40" onClick={() => navigate(`/admin/users/${u.id}`)}>
              <td className={cx(td, 'font-medium')}>{u.name} {u.is_platform_admin && <Badge tone="violet">platform admin</Badge>} {u.disabled_at && <Badge tone="rose">disabled</Badge>}</td>
              <td className={cx(td, 'text-slate-500')}>{u.email}</td>
              <td className={cx(td, 'tabular-nums')}>{u.workspaces}</td>
              <td className={cx(td, 'text-slate-500')}>{fmt(u.last_login_at)}</td>
              <td className={cx(td, 'text-slate-500')}>{new Date(u.created_at).toLocaleDateString()}</td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}

const Delta = ({ v }: { v: number }) => <span className={cx('tabular-nums font-medium', v > 0 ? 'text-emerald-600' : 'text-rose-600')}>{v > 0 ? '+' : ''}{n(v)}</span>;

function Credits() {
  const { data, error, isLoading } = useQuery({ queryKey: ['admin-credits'], queryFn: admin.credits });
  return (
    <>
      <Err e={error} />
      {isLoading ? <Spinner /> : (
        <Table head={['When', 'Workspace', 'Change', 'Reason', 'By']} empty={!data?.length}>
          {data?.map((l) => (
            <tr key={l.id} className="border-t border-slate-100 dark:border-slate-800">
              <td className={cx(td, 'whitespace-nowrap text-slate-500')}>{fmt(l.created_at)}</td>
              <td className={td}><Link to={`/admin/workspaces/${l.workspace_id}`} className="text-brand-600 hover:underline">{l.workspace}</Link></td>
              <td className={td}><Delta v={l.delta} /></td><td className={td}>{l.reason}</td><td className={cx(td, 'text-slate-500')}>{l.by ?? '—'}</td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}

function Payments() {
  const { data, error, isLoading } = useQuery({ queryKey: ['admin-payments'], queryFn: admin.payments });
  return (
    <>
      <Err e={error} />
      {isLoading ? <Spinner /> : (
        <Table head={['When', 'Workspace', 'Pack', 'Amount', 'Credits', 'Provider', 'Status']} empty={!data?.length}>
          {data?.map((p) => (
            <tr key={p.tran_id} className="border-t border-slate-100 dark:border-slate-800">
              <td className={cx(td, 'whitespace-nowrap text-slate-500')}>{fmt(p.created_at)}</td>
              <td className={td}><Link to={`/admin/workspaces/${p.workspace_id}`} className="text-brand-600 hover:underline">{p.workspace}</Link></td>
              <td className={td}>{p.pack}</td><td className={td}>৳{n(p.amount_bdt)}</td><td className={cx(td, 'tabular-nums')}>{n(p.credits)}</td><td className={td}>{p.provider}</td>
              <td className={td}><Badge tone={p.status === 'paid' ? 'green' : p.status === 'pending' ? 'amber' : 'rose'}>{p.status}</Badge></td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}

function Audit() {
  const { data, error, isLoading } = useQuery({ queryKey: ['admin-audit'], queryFn: admin.audit });
  return (
    <>
      <Err e={error} />
      {isLoading ? <Spinner /> : (
        <Table head={['When', 'Admin', 'Action', 'Target', 'Details']} empty={!data?.length}>
          {data?.map((a) => (
            <tr key={a.id} className="border-t border-slate-100 align-top dark:border-slate-800">
              <td className={cx(td, 'whitespace-nowrap text-slate-500')}>{fmt(a.created_at)}</td><td className={td}>{a.admin_email}</td><td className={td}>{a.action}</td>
              <td className={td}>{a.workspace_id ? <Link to={`/admin/workspaces/${a.workspace_id}`} className="text-brand-600 hover:underline">{a.target ?? 'workspace'}</Link> : (a.target ?? '—')}</td>
              <td className={cx(td, 'font-mono text-xs text-slate-500')}>{a.detail ? JSON.stringify(a.detail) : ''}</td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}

// ------------------------------------------------------------------ workspace detail
function WorkspaceDetail({ id }: { id: string }) {
  const qc = useQueryClient();
  const { data: w, error, isLoading } = useQuery({ queryKey: ['admin-workspace', id], queryFn: () => admin.workspace(id) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['admin-workspace', id] }); void qc.invalidateQueries({ queryKey: ['admin-workspaces'] }); void qc.invalidateQueries({ queryKey: ['admin-overview'] });
    void qc.invalidateQueries({ queryKey: ['me'] }); // the sidebar balance and suspended banner come from the signed-in user's own workspace
  };
  const [modal, setModal] = useState<'credits' | 'suspend' | 'rename' | 'delete' | null>(null);
  const [purge, setPurge] = useState<PurgeWhat | null>(null);
  const unsuspend = useMutation({ mutationFn: () => admin.unsuspend(id), onSuccess: refresh });
  const disconnect = useMutation({ mutationFn: () => admin.disconnectWhatsApp(id), onSuccess: refresh });
  const setRole = useMutation({ mutationFn: (a: { userId: string; role: Role }) => admin.setRole(id, a.userId, a.role), onSuccess: () => { toast('Role changed'); refresh(); }, onError: (e: Error) => toast(e.message, 'error') });

  if (isLoading) return <Page title="Workspace" back="/admin?tab=workspaces"><Spinner /></Page>;
  if (error || !w) return <Page title="Workspace" back="/admin?tab=workspaces"><Err e={error ?? new Error('Not found.')} /></Page>;
  return (
    <Page back="/admin?tab=workspaces" title={<>{w.name} {w.suspended_at && <Badge tone="rose">suspended</Badge>}</>} subtitle={`Created ${fmt(w.created_at)}`}
      actions={<div className="flex flex-wrap gap-2">
        <Button onClick={() => setModal('credits')}><Coins className="size-4" />Credits</Button>
        <Button onClick={() => setModal('rename')}>Rename</Button>
        {w.suspended_at
          ? <><Button onClick={() => confirmAction('Its campaigns stay paused until the owner resumes them.', () => unsuspend.mutateAsync(), { title: 'Unsuspend this workspace?', confirmLabel: 'Unsuspend', success: 'Workspace unsuspended' })}>Unsuspend</Button><Button variant="danger" onClick={() => setModal('delete')}>Delete…</Button></>
          : <Button variant="danger" onClick={() => setModal('suspend')}>Suspend</Button>}
      </div>}>
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Credit balance" value={n(w.balance)} />
        <Stat label="Members" value={w.members.length} />
        <Stat label="Campaigns" value={w.campaigns.length} sub="latest 20 shown" />
        <Stat label="WhatsApp" value={w.settings?.has_token && w.settings.wa_phone_number_id ? 'Connected' : 'Not connected'} sub={w.settings?.wa_phone_number_id ? `number ID ${w.settings.wa_phone_number_id}` : undefined} />
      </div>
      {w.settings?.has_token && w.settings.wa_phone_number_id && (
        <div className="mb-5"><Button size="sm" onClick={() => confirmAction('The workspace cannot send or receive WhatsApp messages until it connects again. Its campaigns and contacts stay.', () => disconnect.mutateAsync(), { title: 'Disconnect WhatsApp?', confirmLabel: 'Disconnect', danger: true, success: 'WhatsApp disconnected' })}>Disconnect WhatsApp</Button></div>
      )}

      <Section title="Members">
        <Table head={['Name', 'Email', 'Role', 'Last sign-in']} empty={!w.members.length}>
          {w.members.map((m) => (
            <tr key={m.id} className="border-t border-slate-100 dark:border-slate-800">
              <td className={td}><Link to={`/admin/users/${m.id}`} className="font-medium text-brand-600 hover:underline">{m.name}</Link> {m.disabled_at && <Badge tone="rose">disabled</Badge>}</td>
              <td className={cx(td, 'text-slate-500')}>{m.email}</td>
              <td className={td}><select className="h-8 rounded-lg border border-slate-200 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-900" value={m.role} onChange={(e) => setRole.mutate({ userId: m.id, role: e.target.value as Role })}><option value="owner">owner</option><option value="admin">admin</option><option value="member">member</option></select></td>
              <td className={cx(td, 'text-slate-500')}>{fmt(m.last_login_at)}</td>
            </tr>
          ))}
        </Table>
      </Section>
      <Section title="Credit ledger">
        <Table head={['When', 'Change', 'Reason', 'By']} empty={!w.ledger.length}>
          {w.ledger.map((l) => <tr key={l.id} className="border-t border-slate-100 dark:border-slate-800"><td className={cx(td, 'whitespace-nowrap text-slate-500')}>{fmt(l.created_at)}</td><td className={td}><Delta v={l.delta} /></td><td className={td}>{l.reason}</td><td className={cx(td, 'text-slate-500')}>{l.by ?? '—'}</td></tr>)}
        </Table>
      </Section>
      <Section title="Campaigns">
        <Table head={['Name', 'Channel', 'Status', 'Recipients', 'Created']} empty={!w.campaigns.length}>
          {w.campaigns.map((c) => <tr key={c.id} className="border-t border-slate-100 dark:border-slate-800"><td className={cx(td, 'font-medium')}>{c.name}</td><td className={td}>{c.channel}</td><td className={td}>{c.status}</td><td className={cx(td, 'tabular-nums')}>{n(c.recipients)}</td><td className={cx(td, 'text-slate-500')}>{fmt(c.created_at)}</td></tr>)}
        </Table>
      </Section>
      <Section title="Payments">
        <Table head={['When', 'Pack', 'Amount', 'Credits', 'Status']} empty={!w.payments.length}>
          {w.payments.map((p) => <tr key={p.tran_id} className="border-t border-slate-100 dark:border-slate-800"><td className={cx(td, 'whitespace-nowrap text-slate-500')}>{fmt(p.created_at)}</td><td className={td}>{p.pack}</td><td className={td}>৳{n(p.amount_bdt)}</td><td className={cx(td, 'tabular-nums')}>{n(p.credits)}</td><td className={td}>{p.status}</td></tr>)}
        </Table>
      </Section>

      <Section title="Data cleanup">
        <div className={cx(card, 'divide-y divide-slate-100 dark:divide-slate-800')}>
          {PURGES.map((p) => (
            <div key={p.what} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1"><div className="text-sm font-medium">{p.label}</div><div className="text-xs text-slate-500">{p.summary(w.data)}</div></div>
              <Button size="sm" variant="danger" disabled={!p.count(w.data)} onClick={() => setPurge(p.what)}>Delete…</Button>
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs text-slate-500">Permanent. Credits already spent are not refunded. Contacts, lists, opt-ins and the do-not-contact list are never deleted here.</p>
      </Section>

      {PURGES.map((p) => (
        <TextModal key={p.what} open={purge === p.what} title={`Delete ${p.label.toLowerCase()} of ${w.name}`} label='Type "delete" to confirm' hint={`${p.summary(w.data)}. ${p.warning}`} action="Delete forever" danger
          onClose={() => setPurge(null)} run={(v) => admin.purge(id, p.what, v)}
          onDone={() => { setPurge(null); refresh(); toast(`${p.label} deleted`); }} />
      ))}

      <CreditsModal open={modal === 'credits'} w={w} onClose={() => setModal(null)} onDone={() => { setModal(null); refresh(); }} />
      <TextModal open={modal === 'rename'} title="Rename workspace" label="Workspace name" initial={w.name} action="Save" onClose={() => setModal(null)}
        run={(v) => admin.rename(id, v)} onDone={() => { setModal(null); refresh(); toast('Renamed'); }} />
      <TextModal open={modal === 'suspend'} title="Suspend workspace" label="Reason (kept in the audit log)" hint="Its running campaigns are paused and it cannot launch or resume campaigns. Members can still sign in and see their data." action="Suspend" danger
        onClose={() => setModal(null)} run={(v) => admin.suspend(id, v)} onDone={() => { setModal(null); refresh(); toast('Workspace suspended'); }} />
      <TextModal open={modal === 'delete'} title={`Delete ${w.name}`} label={`Type "${w.name}" to confirm`} hint="This permanently deletes the workspace with all its lists, campaigns, messages and credits. Users who belong only to it keep their account but lose access." action="Delete forever" danger
        onClose={() => setModal(null)} run={(v) => admin.deleteWorkspace(id, v)} onDone={() => { toast('Workspace deleted'); void qc.invalidateQueries({ queryKey: ['admin-workspaces'] }); navigate('/admin?tab=workspaces'); }} />
    </Page>
  );
}

const pl = (count: number, word: string) => `${n(count)} ${word}${count === 1 ? '' : 's'}`;
const PURGES: { what: PurgeWhat; label: string; count: (d: AdminDataCounts) => number; summary: (d: AdminDataCounts) => string; warning: string }[] = [
  { what: 'campaigns', label: 'Campaigns', count: (d) => d.campaigns - d.running_campaigns,
    summary: (d) => `${pl(d.campaigns, 'campaign')} with ${pl(d.recipients, 'recipient')}${d.running_campaigns ? ` (${d.running_campaigns} running or scheduled ${d.running_campaigns === 1 ? 'is' : 'are'} kept: cancel ${d.running_campaigns === 1 ? 'it' : 'them'} first)` : ''}`,
    warning: 'Campaign reports and per-recipient delivery results are lost.' },
  { what: 'inbox', label: 'Inbox', count: (d) => d.conversations, summary: (d) => `${pl(d.conversations, 'conversation')}, ${pl(d.messages, 'message')}`,
    warning: 'Customers can still write again; a new conversation starts then.' },
  { what: 'outbox', label: 'Outbox (email log)', count: (d) => d.outbox, summary: (d) => `${pl(d.outbox, 'sent or captured email')}`, warning: 'The email log cannot be restored.' },
  { what: 'calls', label: 'Call logs', count: (d) => d.call_queues, summary: (d) => `${pl(d.call_queues, 'call queue')}, ${pl(d.call_items, 'call')} with their outcomes and notes`, warning: 'Call outcomes and notes are lost.' },
];

const Section = ({ title, children }: { title: string; children: ReactNode }) => <div className="mb-6"><h2 className="mb-2 text-sm font-medium">{title}</h2>{children}</div>;

/** A one-field dialog (rename, suspend reason, delete confirmation). The server validates; its message is shown in the dialog. */
function TextModal({ open, title, label, hint, initial = '', action, danger, onClose, run, onDone }: {
  open: boolean; title: string; label: string; hint?: string; initial?: string; action: string; danger?: boolean; onClose: () => void; run: (v: string) => Promise<unknown>; onDone: () => void;
}) {
  const [v, setV] = useState(initial);
  const [error, setError] = useState('');
  useEffect(() => { if (open) { setV(initial); setError(''); } }, [open, initial]);
  const go = useMutation({ mutationFn: () => run(v), onSuccess: onDone, onError: (e: Error) => setError(e.message) });
  return (
    <Modal open={open} onClose={onClose} title={title} footer={<><Button onClick={onClose}>Cancel</Button><Button variant={danger ? 'danger' : 'primary'} disabled={go.isPending || !v.trim()} onClick={() => { setError(''); go.mutate(); }}>{action}</Button></>}>
      <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">{label}</label>
      <input className={input} value={v} onChange={(e) => setV(e.target.value)} autoFocus />
      {hint && <p className="mt-2 text-xs text-slate-500">{hint}</p>}
      {error && <p className="mt-2 text-sm text-rose-600">{error}</p>}
    </Modal>
  );
}

function CreditsModal({ open, w, onClose, onDone }: { open: boolean; w: AdminWorkspace; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { if (open) { setAmount(''); setReason(''); setError(''); } }, [open]);
  const delta = Number(amount);
  const valid = Number.isInteger(delta) && delta !== 0 && reason.trim().length >= 3;
  const go = useMutation({ mutationFn: () => admin.adjustCredits(w.id, delta, reason), onSuccess: (r) => { toast(`New balance: ${r.balance.toLocaleString()}`); onDone(); }, onError: (e: Error) => setError(e.message) });
  return (
    <Modal open={open} onClose={onClose} title={`Credits for ${w.name}`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!valid || go.isPending} onClick={() => { setError(''); go.mutate(); }}>Apply</Button></>}>
      <p className="mb-3 text-sm text-slate-500">Current balance: <b className="text-slate-800 dark:text-slate-100">{n(w.balance)}</b>. Use a positive number to add credits and a negative number to remove them.</p>
      <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">Change</label>
      <input className={input} inputMode="numeric" placeholder="e.g. 500 or -100" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
      <label className="mb-1 mt-3 block text-xs font-medium text-slate-600 dark:text-slate-300">Reason (shown in the ledger)</label>
      <input className={input} placeholder="e.g. Bank transfer received, goodwill credit" value={reason} onChange={(e) => setReason(e.target.value)} />
      {valid && <p className="mt-2 text-xs text-slate-500">New balance: {n(w.balance + delta)}</p>}
      {error && <p className="mt-2 text-sm text-rose-600">{error}</p>}
    </Modal>
  );
}

// ------------------------------------------------------------------ user detail
function UserDetail({ id }: { id: string }) {
  const qc = useQueryClient();
  const { data: u, error, isLoading } = useQuery({ queryKey: ['admin-user', id], queryFn: () => admin.user(id) });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['admin-user', id] }); void qc.invalidateQueries({ queryKey: ['admin-users'] }); };
  const disable = useMutation({ mutationFn: () => admin.disableUser(id), onSuccess: refresh });
  const enable = useMutation({ mutationFn: () => admin.enableUser(id), onSuccess: refresh });
  const signOut = useMutation({ mutationFn: () => admin.signOutUser(id), onSuccess: refresh });

  if (isLoading) return <Page title="User" back="/admin?tab=users"><Spinner /></Page>;
  if (error || !u) return <Page title="User" back="/admin?tab=users"><Err e={error ?? new Error('Not found.')} /></Page>;
  return (
    <Page back="/admin?tab=users" title={<>{u.name} {u.is_platform_admin && <Badge tone="violet">platform admin</Badge>} {u.disabled_at && <Badge tone="rose">disabled</Badge>}</>} subtitle={u.email}
      actions={<div className="flex flex-wrap gap-2">
        <Button onClick={() => confirmAction('They are signed out on every device and must sign in again.', () => signOut.mutateAsync(), { title: 'Sign out everywhere?', confirmLabel: 'Sign out', success: 'Signed out everywhere' })}>Sign out everywhere</Button>
        {u.disabled_at
          ? <Button onClick={() => confirmAction('They can sign in again.', () => enable.mutateAsync(), { title: 'Enable this account?', confirmLabel: 'Enable', success: 'Account enabled' })}>Enable account</Button>
          : <Button variant="danger" onClick={() => confirmAction('They are signed out now and cannot sign in until you enable the account again.', () => disable.mutateAsync(), { title: `Disable ${u.email}?`, confirmLabel: 'Disable', danger: true, success: 'Account disabled' })}>Disable account</Button>}
      </div>}>
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Joined" value={new Date(u.created_at).toLocaleDateString()} />
        <Stat label="Last sign-in" value={<span className="text-base">{fmt(u.last_login_at)}</span>} />
        <Stat label="Active sessions" value={u.sessions} />
      </div>
      <Section title="Workspaces">
        <Table head={['Workspace', 'Role']} empty={!u.workspaces.length}>
          {u.workspaces.map((w) => <tr key={w.id} className="border-t border-slate-100 dark:border-slate-800"><td className={td}><Link to={`/admin/workspaces/${w.id}`} className="font-medium text-brand-600 hover:underline">{w.name}</Link> {w.suspended_at && <Badge tone="rose">suspended</Badge>}</td><td className={td}>{w.role}</td></tr>)}
        </Table>
      </Section>
    </Page>
  );
}
