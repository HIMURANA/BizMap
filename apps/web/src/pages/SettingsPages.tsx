import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Users, CreditCard, UserCog, Copy, Check, Trash2, Coins, ShieldCheck, AlertTriangle, Send } from 'lucide-react';
import { SendingTab } from './SendingSettings';
import { api, type Me, type Role } from '../lib/api';
import { Link, useLocation } from '../lib/router';
import { Badge, Button, Spinner, cx } from '../components/ui';

const card = 'rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900';
const input = 'h-9 rounded-lg border border-slate-200 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-900';
const TABS = [{ to: '/settings/team', label: 'Team', icon: Users }, { to: '/settings/billing', label: 'Billing & credits', icon: CreditCard }, { to: '/settings/sending', label: 'Sending', icon: Send }, { to: '/settings/account', label: 'Account', icon: UserCog }];

export function SettingsPage({ me }: { me: Me }) {
  const { path } = useLocation();
  const tab = TABS.find((t) => path.startsWith(t.to)) ?? TABS[0]!;
  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-slate-500">Workspace: <b>{me.workspace?.name}</b> · your role: {me.workspace?.role}</p>
        <div className="mt-5 flex gap-1 border-b border-slate-200 dark:border-slate-800">
          {TABS.map((t) => (
            <Link key={t.to} to={t.to} className={cx('-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium', tab.to === t.to ? 'border-brand-600 text-brand-700 dark:text-brand-100' : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200')}>
              <t.icon className="size-4" /><span className="hidden sm:inline">{t.label}</span><span className="sm:hidden">{t.label.split(' ')[0]}</span>
            </Link>
          ))}
        </div>
        <div className="mt-6">{tab.to === '/settings/team' ? <TeamTab /> : tab.to === '/settings/billing' ? <BillingTab /> : tab.to === '/settings/sending' ? <SendingTab isAdmin={me.workspace?.role === 'owner' || me.workspace?.role === 'admin'} /> : <AccountTab me={me} />}</div>
      </div>
    </div>
  );
}

function Section({ title, desc, children, action }: { title: string; desc?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className={cx(card, 'mb-5')}>
      <div className="mb-4 flex flex-wrap items-start gap-2"><div className="flex-1"><h2 className="font-semibold">{title}</h2>{desc && <p className="text-sm text-slate-500">{desc}</p>}</div>{action}</div>
      {children}
    </section>
  );
}

function TeamTab() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ['team'], queryFn: api.team });
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['team'] });
  const invite = useMutation({ mutationFn: () => api.createInvite(email.trim(), role), onSuccess: (r) => { setLink(`${location.origin}${r.link}`); setEmail(''); refresh(); } });
  const revoke = useMutation({ mutationFn: api.revokeInvite, onSuccess: refresh });
  const setR = useMutation({ mutationFn: ({ id, r }: { id: string; r: Role }) => api.setRole(id, r), onSuccess: refresh });
  const remove = useMutation({ mutationFn: api.removeMember, onSuccess: () => { refresh(); qc.invalidateQueries({ queryKey: ['me'] }); } });
  if (isLoading) return <Spinner />;
  if (error || !data) return <p className="text-rose-600">{(error as Error)?.message}</p>;
  const admin = data.role === 'owner' || data.role === 'admin';
  const err = (invite.error ?? setR.error ?? remove.error ?? revoke.error) as Error | null;

  return (
    <>
      {admin && (
        <Section title="Invite a teammate" desc="They join this workspace and share its lists, exports and credits.">
          <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); invite.mutate(); }}>
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" className={cx(input, 'min-w-56 flex-1')} />
            <select value={role} onChange={(e) => setRole(e.target.value as Role)} className={input}><option value="member">Member</option><option value="admin">Admin</option></select>
            <Button variant="primary" disabled={invite.isPending}>Create invite link</Button>
          </form>
          {link && (
            <div className="mt-3 rounded-xl bg-emerald-50 p-3 text-sm dark:bg-emerald-500/10">
              <p className="mb-2 text-emerald-800 dark:text-emerald-300">Invite created. Send this link to them (valid 7 days, only works for that email):</p>
              <div className="flex gap-2"><input readOnly value={link} className={cx(input, 'flex-1 font-mono text-xs')} onFocus={(e) => e.target.select()} />
                <Button size="sm" onClick={() => { navigator.clipboard?.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? <Check className="size-4" /> : <Copy className="size-4" />}Copy</Button></div>
              <p className="mt-2 text-xs text-slate-500">Invite emails are sent automatically once email delivery is added (Phase 3).</p>
            </div>
          )}
        </Section>
      )}
      {err && <p className="mb-4 text-sm text-rose-600">{err.message}</p>}
      <Section title={`Members (${data.members.length})`} desc="Owner: everything. Admin: team and billing. Member: search, lists, exports and reports.">
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {data.members.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-3 py-3">
              <div className="flex size-9 items-center justify-center rounded-full bg-brand-50 text-sm font-semibold text-brand-700 dark:bg-brand-500/15 dark:text-brand-100">{m.name.slice(0, 1).toUpperCase()}</div>
              <div className="min-w-0 flex-1"><div className="truncate font-medium">{m.name}{m.id === data.me && <span className="ml-1.5 text-xs text-slate-400">(you)</span>}</div><div className="truncate text-sm text-slate-500">{m.email}</div></div>
              {data.role === 'owner' ? (
                <select value={m.role} onChange={(e) => setR.mutate({ id: m.id, r: e.target.value as Role })} className={cx(input, 'h-8')}>
                  <option value="owner">Owner</option><option value="admin">Admin</option><option value="member">Member</option>
                </select>
              ) : <Badge tone={m.role === 'owner' ? 'violet' : m.role === 'admin' ? 'blue' : 'slate'}>{m.role}</Badge>}
              {(admin || m.id === data.me) && (
                <button className="rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10" title={m.id === data.me ? 'Leave workspace' : 'Remove from workspace'}
                  onClick={() => confirm(m.id === data.me ? 'Leave this workspace?' : `Remove ${m.name} from this workspace?`) && remove.mutate(m.id)}><Trash2 className="size-4" /></button>
              )}
            </li>
          ))}
        </ul>
      </Section>
      {admin && data.invites.length > 0 && (
        <Section title="Pending invites">
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {data.invites.map((i) => (
              <li key={i.id} className="flex items-center gap-3 py-2.5 text-sm">
                <span className="flex-1 truncate">{i.email}</span><Badge>{i.role}</Badge>
                <span className="hidden text-xs text-slate-400 sm:inline">expires {i.expires_at.slice(0, 10)}</span>
                <Button size="sm" variant="ghost" onClick={() => revoke.mutate(i.id)}>Revoke</Button>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

const PAYMENT_MSG: Record<string, [string, string]> = {
  paid: ['Payment received: credits added.', 'green'], failed: ['The payment failed. No money was taken; you can try again.', 'rose'],
  cancelled: ['Payment cancelled.', 'amber'], invalid: ['We could not confirm that payment with the gateway. If money was taken, contact support with the transaction ID.', 'rose'],
};

function BillingTab() {
  const qc = useQueryClient();
  const { search } = useLocation();
  const result = new URLSearchParams(search).get('payment');
  const { data, isLoading } = useQuery({ queryKey: ['billing'], queryFn: api.billing });
  const [pack, setPack] = useState<string | null>(null);
  const [phone, setPhone] = useState('');
  const buy = useMutation({ mutationFn: () => api.checkout(pack!, phone), onSuccess: (r) => { location.href = r.redirect; } });
  // a completed payment changes the balance shown in the sidebar
  useEffect(() => { if (result === 'paid') qc.invalidateQueries({ queryKey: ['meta'] }); }, [result, qc]);
  if (isLoading || !data) return <Spinner />;
  const msg = result ? PAYMENT_MSG[result] : null;

  return (
    <>
      {msg && <div className={cx('mb-5 rounded-xl p-3 text-sm', msg[1] === 'green' ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300' : msg[1] === 'amber' ? 'bg-amber-50 text-amber-800 dark:bg-amber-500/10' : 'bg-rose-50 text-rose-800 dark:bg-rose-500/10 dark:text-rose-300')}>{msg[0]}</div>}
      <Section title="Credits" desc="Exports with contact details cost 1 credit per row. Location-only exports and site reports are free."
        action={<div className="flex items-center gap-2 rounded-xl bg-amber-50 px-4 py-2 dark:bg-amber-500/10"><Coins className="size-5 text-amber-500" /><b className="text-xl tabular-nums">{data.balance.toLocaleString()}</b></div>}>
        {data.mode === 'test' && <p className="mb-4 flex gap-2 rounded-lg bg-amber-50 p-2.5 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300"><AlertTriangle className="size-4 shrink-0" />Test mode: payments go to a simulated gateway and no money moves. Add SSLCOMMERZ sandbox keys (SSLC_STORE_ID / SSLC_STORE_PASSWORD) to .env to use the real sandbox.</p>}
        {data.mode === 'disabled' && <p className="mb-4 text-sm text-rose-600">Payments are not configured on this server.</p>}
        <div className="grid gap-3 sm:grid-cols-3">
          {data.packs.map((p) => (
            <button key={p.id} disabled={!data.can_buy || data.mode === 'disabled'} onClick={() => setPack(p.id)}
              className={cx('rounded-xl border p-4 text-left transition disabled:opacity-60', pack === p.id ? 'border-brand-500 ring-1 ring-brand-500' : 'border-slate-200 hover:border-slate-300 dark:border-slate-700')}>
              <div className="text-sm font-medium text-slate-500">{p.label}</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums">{p.credits.toLocaleString()} <span className="text-sm font-normal text-slate-500">credits</span></div>
              <div className="mt-1 text-sm">৳{p.bdt.toLocaleString()} <span className="text-slate-400">· ৳{(p.bdt / p.credits).toFixed(2)}/credit</span></div>
            </button>
          ))}
        </div>
        {!data.can_buy && <p className="mt-3 text-sm text-slate-500">Only workspace admins can buy credits.</p>}
        {pack && data.can_buy && (
          <form className="mt-4 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); buy.mutate(); }}>
            <label className="space-y-1"><span className="block text-xs text-slate-500">Mobile number for the receipt</span>
              <input value={phone} onChange={(e) => setPhone(e.target.value)} required placeholder="01712345678" inputMode="tel" className={input} /></label>
            <Button variant="primary" disabled={buy.isPending}>{buy.isPending ? <Spinner className="size-3.5 border-white/40 border-t-white" /> : <CreditCard className="size-4" />}Pay with card / bKash / Nagad</Button>
            {buy.error && <p className="w-full text-sm text-rose-600">{(buy.error as Error).message}</p>}
          </form>
        )}
        <p className="mt-4 flex gap-2 text-xs text-slate-500"><ShieldCheck className="size-4 shrink-0" />Payments are processed by SSLCOMMERZ. BizMap never sees card or wallet details, and every payment is confirmed with the gateway before credits are added. Prices shown are placeholders until pricing is decided.</p>
      </Section>
      <Section title="Payments">
        {data.payments.length === 0 ? <p className="text-sm text-slate-500">No payments yet.</p> : (
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead className="text-left text-xs text-slate-500"><tr><th className="py-2 font-medium">Date</th><th className="font-medium">Pack</th><th className="font-medium">Amount</th><th className="font-medium">Credits</th><th className="font-medium">Status</th><th className="hidden font-medium sm:table-cell">Transaction</th></tr></thead>
            <tbody>{data.payments.map((p) => (
              <tr key={p.tran_id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="py-2">{new Date(p.created_at).toLocaleDateString()}</td><td>{p.pack}</td><td>৳{Number(p.amount_bdt).toLocaleString()}</td><td className="tabular-nums">{p.credits.toLocaleString()}</td>
                <td><Badge tone={p.status === 'paid' ? 'green' : p.status === 'pending' ? 'amber' : 'rose'}>{p.status}{p.provider === 'test' ? ' (test)' : ''}</Badge></td>
                <td className="hidden font-mono text-xs text-slate-400 sm:table-cell">{p.tran_id}</td>
              </tr>))}</tbody>
          </table></div>
        )}
      </Section>
      <Section title="Credit history">
        <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
          {data.ledger.map((l, i) => (
            <li key={i} className="flex items-center gap-3 py-2">
              <span className={cx('w-20 text-right font-medium tabular-nums', l.delta > 0 ? 'text-emerald-600' : 'text-slate-700 dark:text-slate-300')}>{l.delta > 0 ? '+' : ''}{l.delta.toLocaleString()}</span>
              <span className="flex-1">{l.reason}{l.by ? <span className="text-slate-400"> · {l.by}</span> : null}</span>
              <span className="text-xs text-slate-400">{new Date(l.created_at).toLocaleString()}</span>
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

function AccountTab({ me }: { me: Me }) {
  const qc = useQueryClient();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [wsName, setWsName] = useState('');
  const pw = useMutation({ mutationFn: () => api.changePassword(cur, next), onSuccess: () => { setCur(''); setNext(''); } });
  const ws = useMutation({ mutationFn: () => api.createWorkspace(wsName.trim()), onSuccess: () => { setWsName(''); qc.clear(); location.href = '/'; } });
  return (
    <>
      <Section title="Profile"><p className="text-sm">{me.user.name} · {me.user.email}</p></Section>
      <Section title="Change password" desc="Other devices are signed out after a change.">
        <form className="grid max-w-sm gap-3" onSubmit={(e) => { e.preventDefault(); pw.mutate(); }}>
          <input type="password" autoComplete="current-password" placeholder="Current password" value={cur} onChange={(e) => setCur(e.target.value)} required className={input} />
          <input type="password" autoComplete="new-password" placeholder="New password (10+ characters)" value={next} onChange={(e) => setNext(e.target.value)} required className={input} />
          <Button variant="primary" disabled={pw.isPending}>Update password</Button>
          {pw.isSuccess && <p className="text-sm text-emerald-600">Password updated.</p>}
          {pw.error && <p className="text-sm text-rose-600">{(pw.error as Error).message}</p>}
        </form>
      </Section>
      <Section title="New workspace" desc="A separate workspace has its own lists, exports, team and credits (e.g. for a different client).">
        <form className="flex max-w-md gap-2" onSubmit={(e) => { e.preventDefault(); ws.mutate(); }}>
          <input value={wsName} onChange={(e) => setWsName(e.target.value)} placeholder="Workspace name" required className={cx(input, 'flex-1')} />
          <Button disabled={ws.isPending}>Create</Button>
        </form>
        {ws.error && <p className="mt-2 text-sm text-rose-600">{(ws.error as Error).message}</p>}
      </Section>
    </>
  );
}
