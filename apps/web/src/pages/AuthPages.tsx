import { useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MapPinned, Eye, EyeOff, Users } from 'lucide-react';
import { api } from '../lib/api';
import { Link, navigate } from '../lib/router';
import { Button, Spinner } from '../components/ui';

const input = 'h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 dark:border-slate-700 dark:bg-slate-900';

function Shell({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-gradient-to-b from-brand-50 to-slate-50 px-4 py-10 dark:from-slate-900 dark:to-slate-950">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2">
          <div className="flex size-9 items-center justify-center rounded-xl bg-brand-600 text-white"><MapPinned className="size-5" /></div>
          <span className="text-lg font-semibold">BizMap</span>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <h1 className="text-lg font-semibold">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
          <div className="mt-5">{children}</div>
        </div>
        {footer && <div className="mt-4 text-center text-sm text-slate-500">{footer}</div>}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block space-y-1.5"><span className="text-sm font-medium">{label}</span>{children}</label>;
}

function Password({ value, onChange, autoComplete }: { value: string; onChange: (v: string) => void; autoComplete: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input type={show ? 'text' : 'password'} value={value} onChange={(e) => onChange(e.target.value)} autoComplete={autoComplete} required className={`${input} pr-10`} />
      <button type="button" onClick={() => setShow(!show)} className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400" aria-label={show ? 'Hide password' : 'Show password'}>
        {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}

/** After auth changes, drop every cached query so nothing from another account or workspace can show. */
function useAfterAuth() {
  const qc = useQueryClient();
  return (to = '/') => { qc.clear(); navigate(to, true); };
}

export function LoginPage({ next }: { next?: string }) {
  const done = useAfterAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const m = useMutation({ mutationFn: () => api.login(email, password), onSuccess: () => done(next ?? '/') });
  const submit = (e: FormEvent) => { e.preventDefault(); m.mutate(); };
  return (
    <Shell title="Sign in" subtitle="Business data for Bangladesh" footer={<>No account yet? <Link to="/signup" className="font-medium text-brand-600 hover:underline">Create one</Link></>}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Email"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required className={input} /></Field>
        <Field label="Password"><Password value={password} onChange={setPassword} autoComplete="current-password" /></Field>
        {m.error && <p className="text-sm text-rose-600">{(m.error as Error).message}</p>}
        <Button variant="primary" className="h-10 w-full" disabled={m.isPending}>{m.isPending && <Spinner className="size-3.5 border-white/40 border-t-white" />}Sign in</Button>
        <p className="text-xs text-slate-500">Forgot your password? Ask a workspace owner for now. Email reset arrives with email sending in Phase 3.</p>
      </form>
    </Shell>
  );
}

export function SignupPage({ invite }: { invite?: string }) {
  const done = useAfterAuth();
  const info = useQuery({ queryKey: ['invite', invite], queryFn: () => api.invite(invite!), enabled: !!invite, retry: false });
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [workspace, setWorkspace] = useState('');
  const m = useMutation({ mutationFn: () => api.signup({ name, email: invite ? info.data!.email : email, password, workspace: invite ? undefined : workspace, invite }), onSuccess: () => done('/') });
  const submit = (e: FormEvent) => { e.preventDefault(); m.mutate(); };
  if (invite && info.isLoading) return <Shell title="Loading invite…"><Spinner /></Shell>;
  if (invite && (info.error || !info.data?.valid)) return <Shell title="Invite not valid" subtitle="This invite link is invalid, already used or expired. Ask for a new one."><Link to="/login"><Button>Go to sign in</Button></Link></Shell>;
  return (
    <Shell title={invite ? `Join ${info.data!.workspace}` : 'Create your account'}
      subtitle={invite ? `You were invited as ${info.data!.role} (${info.data!.email}).` : 'Free trial credits included. No card needed.'}
      footer={<>Already have an account? <Link to={invite ? `/login?next=/invite/${invite}` : '/login'} className="font-medium text-brand-600 hover:underline">Sign in</Link></>}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Your name"><input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required className={input} /></Field>
        {!invite && <Field label="Work email"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required className={input} /></Field>}
        <Field label="Password (10+ characters)"><Password value={password} onChange={setPassword} autoComplete="new-password" /></Field>
        {!invite && <Field label="Company or team name (optional)"><input value={workspace} onChange={(e) => setWorkspace(e.target.value)} placeholder="e.g. Acme Distribution" className={input} /></Field>}
        {m.error && <p className="text-sm text-rose-600">{(m.error as Error).message}</p>}
        <Button variant="primary" className="h-10 w-full" disabled={m.isPending}>{m.isPending && <Spinner className="size-3.5 border-white/40 border-t-white" />}{invite ? 'Join workspace' : 'Create account'}</Button>
      </form>
    </Shell>
  );
}

/** Invite link opened while already signed in. */
export function AcceptInvitePage({ token, email }: { token: string; email: string }) {
  const done = useAfterAuth();
  const info = useQuery({ queryKey: ['invite', token], queryFn: () => api.invite(token), retry: false });
  const m = useMutation({ mutationFn: () => api.acceptInvite(token), onSuccess: () => done('/') });
  if (info.isLoading) return <Shell title="Loading invite…"><Spinner /></Shell>;
  if (info.error || !info.data?.valid) return <Shell title="Invite not valid" subtitle="This invite link is invalid, already used or expired."><Link to="/"><Button>Back to the app</Button></Link></Shell>;
  const wrong = info.data.email.toLowerCase() !== email.toLowerCase();
  return (
    <Shell title={`Join ${info.data.workspace}`} subtitle={`Invited as ${info.data.role}.`}>
      <div className="space-y-4 text-sm">
        <div className="flex items-center gap-3 rounded-xl bg-slate-50 p-3 dark:bg-slate-800"><Users className="size-5 text-brand-600" /><span>For <b>{info.data.email}</b></span></div>
        {wrong && <p className="text-rose-600">You are signed in as {email}. Sign out and sign in as {info.data.email} to accept.</p>}
        {m.error && <p className="text-rose-600">{(m.error as Error).message}</p>}
        <Button variant="primary" className="h-10 w-full" disabled={wrong || m.isPending} onClick={() => m.mutate()}>Accept invite</Button>
      </div>
    </Shell>
  );
}
