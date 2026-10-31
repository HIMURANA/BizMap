import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Compass, ListChecks, FileDown, Mail, Inbox, BarChart3, Bell, Settings, Coins, Languages, MapPinned, LogOut, ChevronsUpDown, Check, PhoneCall, type LucideIcon } from 'lucide-react';
import { ApiError, api, type Me } from './lib/api';
import { Link, navigate, useLocation } from './lib/router';
import { useI18n, type Key } from './lib/i18n';
import { Explore } from './pages/Explore';
import { BusinessPage, ExportsPage, ListsPage, PlannedPage } from './pages/Pages';
import { AcceptInvitePage, LoginPage, SignupPage } from './pages/AuthPages';
import { SettingsPage } from './pages/SettingsPages';
import { ReportView, ReportsPage } from './pages/ReportsPages';
import { CampaignDetail, CampaignNew, CampaignsPage } from './pages/CampaignPages';
import { CallWork, CallsPage } from './pages/CallPages';
import { InboxPage } from './pages/InboxPages';
import { AlertsPage } from './pages/AlertsPage';
import { out } from './lib/outreach';
import { Button, Spinner, cx } from './components/ui';

// `mobile`: shown in the phone bottom bar (space for five); the rest are desktop sidebar only
const NAV: { to: string; key: Key; icon: LucideIcon; mobile?: boolean; badge?: 'inbox' | 'alerts' }[] = [
  { to: '/', key: 'explore', icon: Compass, mobile: true },
  { to: '/lists', key: 'lists', icon: ListChecks, mobile: true },
  { to: '/reports', key: 'reports', icon: BarChart3 },
  { to: '/exports', key: 'exports', icon: FileDown },
  { to: '/campaigns', key: 'campaigns', icon: Mail },
  { to: '/calls', key: 'calls', icon: PhoneCall, mobile: true },
  { to: '/inbox', key: 'inbox', icon: Inbox, mobile: true, badge: 'inbox' },
  { to: '/alerts', key: 'alerts', icon: Bell, badge: 'alerts' },
  { to: '/settings/team', key: 'settings', icon: Settings, mobile: true },
];

export function App() {
  const { path, search } = useLocation();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, retry: false });
  const signedOut = me.error instanceof ApiError && me.error.status === 401;
  const invite = path.match(/^\/invite\/([^/]+)$/)?.[1];

  useEffect(() => { if (me.data && (path === '/login' || path === '/signup')) navigate(new URLSearchParams(search).get('next') ?? '/', true); }, [me.data, path, search]);

  if (me.isLoading) return <div className="flex h-full items-center justify-center"><Spinner className="size-6" /></div>;
  if (signedOut) {
    if (invite) return <SignupPage invite={decodeURIComponent(invite)} />;
    if (path === '/signup') return <SignupPage />;
    return <LoginPage next={path === '/login' ? (new URLSearchParams(search).get('next') ?? undefined) : `${path}${search}`} />;
  }
  if (me.error || !me.data) return <div className="p-8 text-rose-600">Cannot reach the server: {(me.error as Error)?.message}. Is <code>npm run app:api</code> running?</div>;
  if (invite) return <AcceptInvitePage token={decodeURIComponent(invite)} email={me.data.user.email} />;
  if (!me.data.workspace) return <NoWorkspace me={me.data} />;
  return <Shell me={me.data} />;
}

function NoWorkspace({ me }: { me: Me }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const create = useMutation({ mutationFn: () => api.createWorkspace(name.trim()), onSuccess: () => qc.clear() });
  const sw = useMutation({ mutationFn: api.switchWorkspace, onSuccess: () => qc.clear() });
  return (
    <div className="flex h-full items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
        <h1 className="text-lg font-semibold">Choose a workspace</h1>
        <div className="mt-4 space-y-2">
          {me.workspaces.map((w) => <Button key={w.id} className="w-full justify-start" onClick={() => sw.mutate(w.id)}>{w.name}</Button>)}
        </div>
        <form className="mt-4 flex gap-2" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="New workspace name" className="h-9 flex-1 rounded-lg border border-slate-200 px-3 text-sm dark:border-slate-700 dark:bg-slate-900" />
          <Button variant="primary">Create</Button>
        </form>
      </div>
    </div>
  );
}

function WorkspaceMenu({ me }: { me: Me }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const sw = useMutation({ mutationFn: api.switchWorkspace, onSuccess: () => { qc.clear(); navigate('/', true); } });
  const out = useMutation({ mutationFn: api.logout, onSuccess: () => { qc.clear(); navigate('/login', true); } });
  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-slate-100 dark:hover:bg-slate-800">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-600 text-white"><MapPinned className="size-4" /></div>
        <div className="min-w-0 flex-1 leading-tight"><div className="truncate text-sm font-semibold">{me.workspace?.name}</div><div className="truncate text-[11px] text-slate-400">{me.user.name} · {me.workspace?.role}</div></div>
        <ChevronsUpDown className="size-4 text-slate-400" />
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-12 z-40 rounded-xl border border-slate-200 bg-white p-1.5 shadow-xl dark:border-slate-700 dark:bg-slate-900" onMouseLeave={() => setOpen(false)}>
          <div className="px-2 py-1 text-[11px] font-medium uppercase text-slate-400">Workspaces</div>
          {me.workspaces.map((w) => (
            <button key={w.id} onClick={() => w.id !== me.workspace?.id && sw.mutate(w.id)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800">
              <span className="flex-1 truncate">{w.name}</span>{w.id === me.workspace?.id && <Check className="size-4 text-brand-600" />}
            </button>
          ))}
          <Link to="/settings/account" onClick={() => setOpen(false)} className="block rounded-md px-2 py-1.5 text-sm text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800">+ New workspace</Link>
          <div className="my-1 border-t border-slate-100 dark:border-slate-800" />
          <div className="truncate px-2 py-1 text-xs text-slate-400">{me.user.email}</div>
          <button onClick={() => out.mutate()} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-500/10"><LogOut className="size-4" />Sign out</button>
        </div>
      )}
    </div>
  );
}

function Shell({ me }: { me: Me }) {
  const { path } = useLocation();
  const { t, lang, setLang } = useI18n();
  const { data: meta, error } = useQuery({ queryKey: ['meta'], queryFn: api.meta });
  const unread = useQuery({ queryKey: ['inbox-unread'], queryFn: out.inboxUnread, refetchInterval: 15_000 });
  const unseen = useQuery({ queryKey: ['alerts-unseen'], queryFn: out.alertsUnseen, refetchInterval: 60_000 });
  const badges = { inbox: unread.data?.n ?? 0, alerts: unseen.data?.n ?? 0 };
  const active = (to: string) => (to === '/' ? path === '/' || path.startsWith('/business') : path.startsWith(to.replace(/\/team$/, '')));

  let page;
  if (error) page = <div className="p-8 text-rose-600">{(error as Error).message}</div>;
  else if (!meta) page = <div className="flex h-full items-center justify-center"><Spinner className="size-6" /></div>;
  else if (path.startsWith('/business/')) page = <BusinessPage id={decodeURIComponent(path.slice('/business/'.length))} meta={meta} />;
  else if (path === '/lists') page = <ListsPage />;
  else if (path === '/exports') page = <ExportsPage />;
  else if (path === '/reports') page = <ReportsPage meta={meta} />;
  else if (path.startsWith('/reports/')) page = <ReportView id={path.slice('/reports/'.length)} meta={meta} />;
  else if (path.startsWith('/settings')) page = <SettingsPage me={me} />;
  else if (path === '/campaigns') page = <CampaignsPage />;
  else if (path === '/campaigns/new') page = <CampaignNew />;
  else if (path.startsWith('/campaigns/')) page = <CampaignDetail id={path.slice('/campaigns/'.length)} />;
  else if (path === '/calls') page = <CallsPage />;
  else if (path.startsWith('/calls/')) page = <CallWork id={path.slice('/calls/'.length)} />;
  else if (path === '/inbox' || path === '/inbox/optins') page = <InboxPage />;
  else if (path === '/alerts') page = <AlertsPage />;
  else if (path !== '/') page = <PlannedPage which={path.slice(1)} />;
  else page = <Explore meta={meta} />;

  return (
    <div className="flex h-full flex-col md:flex-row">
      <nav className="order-last flex shrink-0 justify-around border-t border-slate-200 bg-white print:hidden dark:border-slate-800 dark:bg-slate-900 md:order-first md:w-56 md:flex-col md:justify-start md:border-r md:border-t-0">
        <div className="hidden p-2 md:block"><WorkspaceMenu me={me} /></div>
        <div className="flex flex-1 justify-around md:flex-col md:justify-start md:gap-0.5 md:px-2">
          {NAV.map((n) => (
            <Link key={n.to} to={n.to} className={cx('flex flex-col items-center gap-0.5 px-2 py-2 text-[10px] font-medium md:flex-row md:gap-2.5 md:rounded-lg md:px-3 md:text-sm',
              active(n.to) ? 'text-brand-700 md:bg-brand-50 dark:text-brand-100 md:dark:bg-brand-500/15' : 'text-slate-500 hover:text-slate-900 md:hover:bg-slate-100 dark:hover:text-white md:dark:hover:bg-slate-800',
              !n.mobile && 'hidden md:flex')}>
              <span className="relative"><n.icon className="size-5 md:size-4" />
                {n.badge && badges[n.badge] > 0 && <span className="absolute -right-2 -top-1.5 min-w-4 rounded-full bg-emerald-600 px-1 text-center text-[9px] font-semibold leading-4 text-white md:hidden">{badges[n.badge] > 99 ? '99+' : badges[n.badge]}</span>}</span>
              <span className="flex-1">{t(n.key)}</span>
              {n.badge && badges[n.badge] > 0 && <span className="hidden rounded-full bg-emerald-600 px-1.5 text-[10px] font-semibold text-white md:inline">{badges[n.badge] > 99 ? '99+' : badges[n.badge]}</span>}
            </Link>
          ))}
          <button onClick={() => setLang(lang === 'en' ? 'bn' : 'en')} className="flex flex-col items-center gap-0.5 px-2 py-2 text-[10px] font-medium text-slate-500 md:hidden">
            <Languages className="size-5" />{lang === 'en' ? 'বাংলা' : 'EN'}
          </button>
        </div>
        <div className="hidden space-y-2 border-t border-slate-100 p-3 dark:border-slate-800 md:block">
          <Link to="/settings/billing" className="flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm hover:bg-amber-100 dark:bg-amber-500/10">
            <Coins className="size-4 text-amber-500" /><b className="tabular-nums">{meta?.credits.toLocaleString() ?? '…'}</b><span className="text-slate-500">{t('credits')}</span>
          </Link>
          <button onClick={() => setLang(lang === 'en' ? 'bn' : 'en')} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800">
            <Languages className="size-4" />{lang === 'en' ? 'বাংলা' : 'English'}
          </button>
          {meta && <p className="px-1 text-[10px] leading-snug text-slate-400">{meta.attribution}</p>}
        </div>
      </nav>
      <main className="min-h-0 min-w-0 flex-1">{page}</main>
    </div>
  );
}
