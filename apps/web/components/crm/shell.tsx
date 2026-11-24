'use client';
/**
 * The CRM frame: sidebar, top bar (search, year and branch pickers, quick add, alerts), toasts. One /shell call per page
 * load tells it who is signed in and what their role may open; the screens inside never guess permissions.
 */
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { act, flash, formObj, get, onFlash, post, setPrefs, useCrm, type Flash } from '@/lib/crm/api';
import { rel } from '@/lib/crm/fmt';
import { Badge, ErrorBox, Loading, Modal } from './ui';

export type Shell = {
  user: { id: string; name: string; email: string | null };
  org: { id: string; name: string; color: string | null };
  role: { key: string; name: string };
  perms: Record<string, string>;
  scope: string;
  years: { id: string; name: string; status: string; is_current: boolean }[];
  yearId: string;
  branches: { id: string; name: string }[];
  branchId: string | null;
  grades: string[];
  boards: string[];
  closureReasons: string[];
  fees: { registration: number; admission: number };
  sources: { id: string; name: string; channel: string }[];
  fields: { key: string; label: string; options: string[]; required: boolean }[];
  notifications: { id: string; title: string; link: string | null; category: string; read: boolean; at: string }[];
  unread: number;
  badges: { tasks: number; inbox: number };
  nav: Record<'leads' | 'inbox' | 'tasks' | 'visits' | 'applications' | 'campaigns' | 'reports' | 'walkin' | 'admin', boolean>;
  can: { create: boolean; edit: boolean; message: boolean };
  adminSections: string[];
  adminCatalogue: { key: string; label: string; description: string }[];
  wallet: number | null;
  demoPayments: boolean;
  authProvider: 'dev' | 'supabase';
};

const ShellCtx = createContext<{ shell: Shell; reload: () => void } | null>(null);
export const useShell = () => useContext(ShellCtx)!;

/** Links stored by the server before the screens moved to /crm are rewritten to the new place. */
export const crmHref = (link: string | null | undefined) => (!link ? '/crm' : link.startsWith('/crm') ? link : '/crm' + (link === '/' ? '' : link));

export function CrmRoot({ children }: { children: ReactNode }) {
  const { data, error, reload } = useCrm<Shell>('/shell');
  const path = usePathname();
  const [navOpen, setNavOpen] = useState(false);
  const [add, setAdd] = useState(false);
  const [pal, setPal] = useState(false);
  useEffect(() => setNavOpen(false), [path]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPal(true);
      } else if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'n' && data?.can.create) {
        e.preventDefault();
        setAdd(true);
      } else if (!typing && e.key === '/') {
        e.preventDefault();
        setPal(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [data?.can.create]);

  if (error && error.status === 403)
    return (
      <div className="crm mx-auto max-w-md p-6 text-center">
        <h1 className="text-lg font-semibold">No CRM access</h1>
        <p className="muted mt-2">Your sign-in is not set up for the admissions CRM, or your school has not switched it on. Ask your admin.</p>
        <button className="btn mt-4" onClick={signOut}>
          Sign out
        </button>
      </div>
    );
  if (error && error.status !== 401) return <div className="crm p-6"><ErrorBox message={error.message} /></div>;
  if (!data) return <div className="crm"><Loading label="Opening the CRM" /></div>;
  const s = data;
  const nav: [string, string, boolean, number][] = [
    ['/crm', 'Home', true, 0], ['/crm/leads', 'Leads', s.nav.leads, 0], ['/crm/inbox', 'Inbox', s.nav.inbox, s.badges.inbox], ['/crm/tasks', 'Tasks', s.nav.tasks, s.badges.tasks],
    ['/crm/visits', 'Visits', s.nav.visits, 0], ['/crm/applications', 'Applications', s.nav.applications, 0], ['/crm/campaigns', 'Campaigns', s.nav.campaigns, 0], ['/crm/reports', 'Reports', s.nav.reports, 0],
  ];
  const brand = s.org.color ?? '#0f766e';
  return (
    <ShellCtx.Provider value={{ shell: s, reload }}>
      <div className="crm flex min-h-screen bg-slate-50" style={{ ['--crm-brand' as string]: brand }}>
        <a href="#crm-main" className="skip">
          Skip to the page
        </a>
        {navOpen && <div className="fixed inset-0 z-30 bg-slate-900/40 md:hidden" aria-hidden onClick={() => setNavOpen(false)} />}
        <aside id="crm-sidebar" aria-label="CRM menu" className={`fixed inset-y-0 left-0 z-40 flex h-screen w-60 shrink-0 flex-col overflow-y-auto bg-teal-900 p-3 transition-transform md:sticky md:top-0 md:w-52 md:translate-x-0 ${navOpen ? 'translate-x-0' : '-translate-x-full'}`}>
          <Link href="/crm" className="mb-4 flex items-center gap-2 px-2 text-base font-semibold text-white">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-white text-teal-900" aria-hidden>
              A
            </span>
            AutoED CRM
          </Link>
          <nav className="space-y-0.5" aria-label="Main">
            {nav.filter((n) => n[2]).map(([href, label, , badge]) => (
              <NavLink key={href} href={href} badge={badge}>
                {label}
              </NavLink>
            ))}
            {s.nav.walkin && <NavLink href="/crm/walkin">Walk-in desk</NavLink>}
          </nav>
          <div className="mt-4 space-y-2 border-t border-white/15 px-1 pt-3 md:hidden">
            <Pickers s={s} />
          </div>
          <div className="mt-auto space-y-0.5 border-t border-white/15 pt-2">
            {s.nav.admin && <NavLink href="/crm/admin">Admin console</NavLink>}
            <div className="px-3 pt-2 text-xs text-teal-50">
              <Link href="/crm/account" className="block truncate font-medium text-white hover:underline">
                {s.user.name}
              </Link>
              <div className="truncate">
                {s.role.name} · {s.org.name}
              </div>
              <button className="mt-1 underline hover:text-white" onClick={signOut}>
                Sign out
              </button>
            </div>
          </div>
        </aside>
        <div className="min-w-0 flex-1">
          <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-slate-200 bg-white px-3 py-2 sm:px-4">
            <button type="button" onClick={() => setNavOpen(true)} className="btn px-2.5 md:hidden" aria-label="Open menu" aria-expanded={navOpen} aria-controls="crm-sidebar">
              ☰
            </button>
            <button type="button" onClick={() => setPal(true)} className="flex min-w-0 flex-1 items-center justify-between rounded-md border border-slate-300 bg-slate-50 px-3 py-1.5 text-left text-slate-600 hover:bg-white md:max-w-md">
              <span className="truncate">Search…</span>
              <kbd className="hidden rounded border border-slate-300 bg-white px-1.5 text-[11px] sm:inline">Ctrl K</kbd>
            </button>
            <div className="ml-auto flex items-center gap-2">
              <div className="hidden items-center gap-2 md:flex">
                <Pickers s={s} />
              </div>
              {s.can.create && (
                <button onClick={() => setAdd(true)} className="btn btn-primary" title="Shortcut: N" aria-label="Quick add enquiry">
                  +<span className="hidden sm:inline"> Quick add</span>
                </button>
              )}
              <Bell s={s} />
            </div>
          </header>
          <main id="crm-main" className="p-3 sm:p-5">
            {children}
          </main>
        </div>
        <QuickAdd open={add} onClose={() => setAdd(false)} />
        <Palette open={pal} onClose={() => setPal(false)} s={s} />
        <Toast />
      </div>
    </ShellCtx.Provider>
  );
}

async function signOut() {
  try {
    await post('/auth/logout');
  } finally {
    window.location.href = '/crm/login';
  }
}

function NavLink({ href, children, badge }: { href: string; children: ReactNode; badge?: number }) {
  const path = usePathname();
  const on = href === '/crm' ? path === '/crm' : path.startsWith(href);
  return (
    <Link href={href} aria-current={on ? 'page' : undefined} className={`flex min-h-[40px] items-center justify-between rounded-md px-3 py-2 text-sm font-medium ${on ? 'bg-white/15 text-white' : 'text-teal-50 hover:bg-white/10'}`}>
      <span>{children}</span>
      {!!badge && <span className="rounded-full bg-amber-400 px-1.5 text-[11px] font-semibold text-slate-900" aria-label={`${badge} waiting`}>{badge}</span>}
    </Link>
  );
}

function Pickers({ s }: { s: Shell }) {
  return (
    <>
      <select aria-label="Academic year" value={s.yearId} onChange={(e) => setPrefs({ year: e.target.value })} className="input w-auto py-1.5 pr-7">
        {s.years.map((y) => (
          <option key={y.id} value={y.id}>
            {y.name}
            {y.status === 'closed' ? ' (closed)' : ''}
          </option>
        ))}
      </select>
      {s.branches.length > 1 && (
        <select aria-label="Branch" value={s.branchId ?? ''} onChange={(e) => setPrefs({ branch: e.target.value || null })} className="input w-auto py-1.5 pr-7">
          <option value="">All branches</option>
          {s.branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      )}
    </>
  );
}

function Bell({ s }: { s: Shell }) {
  const [open, setOpen] = useState(false);
  const { reload } = useShell();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((b) => !b)} className="btn relative" aria-label={`Alerts, ${s.unread} unread`} aria-expanded={open}>
        <span className="hidden sm:inline">Alerts</span>
        <span className="sm:hidden" aria-hidden>
          🔔
        </span>
        {s.unread > 0 && <span className="rounded-full bg-rose-700 px-1.5 text-[11px] font-semibold text-white">{s.unread}</span>}
      </button>
      {open && (
        <div className="card absolute right-0 z-30 mt-1 w-[min(24rem,calc(100vw-1.5rem))] shadow-lg">
          <div className="card-h">
            <span>Notifications</span>
            {s.unread > 0 && (
              <button
                className="link text-xs"
                onClick={async () => {
                  await post('/notifications/read');
                  reload();
                }}
              >
                Mark all read
              </button>
            )}
          </div>
          <ul className="max-h-96 overflow-y-auto">
            {s.notifications.map((n) => (
              <li key={n.id} className={`border-b border-slate-100 px-4 py-2 ${n.read ? '' : 'bg-teal-50'}`}>
                <Link href={crmHref(n.link)} onClick={() => setOpen(false)} className="block">
                  <span className="text-slate-900">{n.title}</span>
                  <span className="muted block text-xs">
                    {n.category.replace('_', ' ')} · {rel(n.at)}
                  </span>
                </Link>
              </li>
            ))}
            {!s.notifications.length && <li className="muted px-4 py-6 text-center">You are all caught up. Assignments, due tasks, parent replies and escalations appear here.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

export function Toast() {
  const [msg, setMsg] = useState<Flash | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = onFlash((f) => {
      setMsg(f);
      if (timer) clearTimeout(timer);
      if (f && f.kind !== 'keep') timer = setTimeout(() => setMsg(null), f.kind === 'error' ? 9000 : 5000);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, []);
  if (!msg) return <div aria-live="polite" className="sr-only" />;
  if (msg.kind === 'keep')
    return (
      <div role="alertdialog" aria-label="Important" className="fixed inset-x-0 bottom-4 z-50 mx-auto w-fit max-w-2xl rounded-md bg-slate-900 px-4 py-3 text-sm text-white shadow-lg">
        <p className="select-all break-all font-medium">{msg.message}</p>
        <button onClick={() => setMsg(null)} className="mt-2 rounded bg-white px-2.5 py-1 text-xs font-semibold text-slate-900">
          I have copied it
        </button>
      </div>
    );
  return (
    <div role={msg.kind === 'error' ? 'alert' : 'status'} className={`fixed bottom-4 left-1/2 z-50 w-[min(34rem,calc(100vw-1.5rem))] -translate-x-1/2 rounded-md px-4 py-2.5 text-sm font-medium text-white shadow-lg ${msg.kind === 'error' ? 'bg-rose-800' : 'bg-slate-900'}`}>
      {msg.kind === 'error' ? '⚠ ' : '✓ '}
      {msg.message}
      <button className="ml-3 underline" onClick={() => setMsg(null)}>
        Dismiss
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- duplicates while typing (DUP-01)
export type Dup = { householdId: string; guardian: string; enquiries: { id: string; student: string; grade: string; stage: string; owner: string; year: string }[] } | null;
export function useDuplicate(mobile: string, email = '') {
  const [dup, setDup] = useState<Dup>(null);
  useEffect(() => {
    const m = mobile.replace(/\D/g, '');
    if (m.length < 10 && !email.includes('@')) {
      setDup(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      get<{ match: Dup }>('/dedupe', { mobile: m, email })
        .then((d) => live && setDup(d.match))
        .catch(() => undefined);
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [mobile, email]);
  return dup;
}

export function DuplicateNotice({ dup }: { dup: Dup }) {
  if (!dup) return null;
  return (
    <div role="status" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
      <p className="font-semibold text-amber-900">This family is already with us: {dup.guardian}</p>
      <ul className="mt-1 space-y-0.5 text-amber-900">
        {dup.enquiries.map((e) => (
          <li key={e.id}>
            {e.student} · {e.grade ?? 'grade not set'} · {e.stage} · owner {e.owner} · {e.year}
          </li>
        ))}
      </ul>
      <p className="mt-1 text-amber-900">Saving will not create a duplicate. Same child: adds a re-enquiry to the existing record. New child: adds a sibling to this household.</p>
      <Link href={`/crm/households/${dup.householdId}`} className="link mt-1 inline-block">
        Open the household
      </Link>
    </div>
  );
}

function QuickAdd({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { shell: s, reload } = useShell();
  const [mobile, setMobile] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dup = useDuplicate(mobile);
  const router = useRouter();
  useEffect(() => {
    if (!open) {
      setError('');
      setMobile('');
    }
  }, [open]);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = formObj(e.currentTarget);
    const custom = Object.fromEntries(Object.entries(f).filter(([k]) => k.startsWith('cf_')).map(([k, v]) => [k.slice(3), v]));
    setBusy(true);
    setError('');
    try {
      const r = await post('/leads', { ...f, custom, consent: f.consent === 'on' });
      const what = r.status === 're_enquiry' ? `Existing family: re-enquiry added. Owner ${r.ownerName} has been alerted.` : r.status === 'sibling_added' ? `Sibling added to the existing household. Owner: ${r.ownerName}.` : `Enquiry saved and assigned to ${r.ownerName}.`;
      flash(what);
      onClose();
      reload();
      if (r.canOpen) router.push(`/crm/households/${r.householdId}?e=${r.enquiryId}`);
    } catch (err) {
      setError(err instanceof Error ? ((err as { data?: { error?: string } }).data?.error ?? err.message) : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open={open} onClose={onClose} title="Quick add enquiry" side>
      <form onSubmit={submit} className="flex h-full flex-col">
        <div className="card-h">
          <span>Quick add enquiry</span>
          <button type="button" onClick={onClose} className="btn btn-sm" aria-label="Close">
            Esc
          </button>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          <label className="block">
            <span className="label">Parent mobile</span>
            <input name="mobile" required inputMode="numeric" autoFocus value={mobile} onChange={(e) => setMobile(e.target.value)} className="input" placeholder="10-digit mobile" autoComplete="off" />
          </label>
          <DuplicateNotice dup={dup} />
          <label className="block">
            <span className="label">Student name</span>
            <input name="studentName" required className="input" />
          </label>
          {!dup && (
            <label className="block">
              <span className="label">Parent / guardian name</span>
              <input name="guardianName" required className="input" />
            </label>
          )}
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="label">Branch</span>
              <select name="branchId" required defaultValue={s.branchId ?? s.branches[0]?.id} className="input">
                {s.branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="label">Grade</span>
              <select name="grade" required className="input" defaultValue="">
                <option value="" disabled>
                  Choose
                </option>
                {s.grades.map((g) => (
                  <option key={g}>{g}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="label">Board</span>
              <select name="board" className="input">
                {s.boards.map((g) => (
                  <option key={g}>{g}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="label">Source</span>
              <select name="sourceId" required className="input" defaultValue="">
                <option value="" disabled>
                  Choose
                </option>
                {s.sources.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.channel}: {x.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {s.fields.length > 0 && (
            <div className="grid grid-cols-2 gap-3">
              {s.fields.map((f) => (
                <label key={f.key} className="block">
                  <span className="label">
                    {f.label}
                    {f.required ? '' : ' (optional)'}
                  </span>
                  <select name={`cf_${f.key}`} required={f.required} defaultValue="" className="input">
                    <option value="">Choose</option>
                    {f.options.map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          )}
          <label className="block">
            <span className="label">How did they hear about us? (optional)</span>
            <input name="heardAbout" className="input" />
          </label>
          <label className="block">
            <span className="label">Note (optional)</span>
            <textarea name="note" rows={2} className="input" />
          </label>
          <label className="flex items-start gap-2 text-xs text-slate-700">
            <input type="checkbox" name="consent" defaultChecked className="mt-0.5" /> The parent agreed to be contacted about admissions by call, WhatsApp, SMS and email.
          </label>
          {error && (
            <p role="alert" className="rounded-md bg-rose-50 px-3 py-2 text-rose-800">
              {error}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-200 p-3">
          <button type="button" onClick={onClose} className="btn">
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : dup ? 'Save to this household' : 'Save enquiry'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- global search (WS-08)
type Hit = { href: string; title: string; sub: string };
function Palette({ open, onClose, s }: { open: boolean; onClose: () => void; s: Shell }) {
  const [term, setTerm] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [sel, setSel] = useState(0);
  const router = useRouter();
  const jumps: Hit[] = [
    ['/crm', 'My day', true], ['/crm/leads', 'Leads', s.nav.leads], ['/crm/leads?view=kanban', 'Leads: Kanban board', s.nav.leads], ['/crm/inbox', 'Team inbox', s.nav.inbox], ['/crm/tasks', 'Tasks', s.nav.tasks],
    ['/crm/visits', 'Visits', s.nav.visits], ['/crm/walkin', 'Walk-in desk', s.nav.walkin], ['/crm/applications', 'Applications', s.nav.applications], ['/crm/campaigns', 'Campaigns', s.nav.campaigns],
    ['/crm/reports', 'Reports', s.nav.reports], ['/crm/admin', 'Admin console', s.nav.admin],
  ].filter((j) => j[2]).map((j) => ({ href: j[0] as string, title: j[1] as string, sub: 'Go to' }));
  useEffect(() => {
    if (open) setTerm('');
  }, [open]);
  useEffect(() => {
    const local = jumps.filter((j) => j.title.toLowerCase().includes(term.toLowerCase()));
    setSel(0);
    if (term.trim().length < 2) {
      setHits(local);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      get<{ hits: Hit[] }>('/search', { q: term })
        .then((d) => live && setHits([...d.hits, ...local]))
        .catch(() => live && setHits(local));
    }, 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term, open]);
  const go = useCallback(
    (h?: Hit) => {
      if (h) {
        onClose();
        router.push(h.href);
      }
    },
    [onClose, router],
  );
  return (
    <Modal open={open} onClose={onClose} title="Search" wide>
      <div className="mt-0">
        <input
          autoFocus
          role="combobox"
          aria-expanded
          aria-controls="crm-hits"
          aria-label="Search parents, students, mobile numbers"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Search parent, student, mobile, email, application or receipt number…"
          className="w-full rounded-t-lg border-b border-slate-200 px-4 py-3 text-base outline-none"
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSel((x) => Math.min(x + 1, hits.length - 1));
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSel((x) => Math.max(x - 1, 0));
            }
            if (e.key === 'Enter') go(hits[sel]);
          }}
        />
        <ul id="crm-hits" role="listbox" className="max-h-80 overflow-y-auto py-1">
          {hits.map((h, i) => (
            <li key={h.href + i} role="option" aria-selected={i === sel}>
              <button onClick={() => go(h)} onMouseEnter={() => setSel(i)} className={`flex w-full items-center justify-between gap-3 px-4 py-2 text-left ${i === sel ? 'bg-teal-50' : ''}`}>
                <span className="font-medium text-slate-900">{h.title}</span>
                <span className="muted truncate text-xs">{h.sub}</span>
              </button>
            </li>
          ))}
          {!hits.length && <li className="muted px-4 py-6 text-center">Nothing matches “{term}”. Try a mobile number or a student name.</li>}
        </ul>
      </div>
    </Modal>
  );
}

export { act, Badge };
