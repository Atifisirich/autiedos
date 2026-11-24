import Link from 'next/link';
import { requireCap, ROLE_LABEL } from '@/lib/erp/ctx';
import { core } from '@/lib/erp/db';
import { Page, Card, Stat, Meter } from '@/components/erp/ui';
import { today, pct } from '@/lib/erp/fmt';
import { addDays } from '@/lib/erp/calendar';
import { NO_ID } from '@/lib/erp/q';

export const metadata = { title: 'Adoption monitor' };
/** Adoption monitor (ADO-01): who is actually using the system. Usage is read from attendance submissions and logins recorded by the platform. */
export default async function Adoption() {
  const ctx = await requireCap('admin');
  const d = today(), w = addDays(d, -7);
  const c = core(ctx.sb);
  const [users, access, secs, subs, logins] = await Promise.all([
    c.from('org_users').select('user_id, display_name, status, kind').eq('kind', 'staff'),
    c.from('user_product_access').select('user_id, role_key').eq('product_key', 'erp').is('revoked_at', null),
    c.from('sections').select('id', { count: 'exact', head: true }).eq('academic_year_id', ctx.year?.id ?? NO_ID).is('deleted_at', null),
    c.from('student_attendance_sessions').select('section_id, date').gte('date', w).eq('session_key', 'day').eq('status', 'submitted').is('deleted_at', null),
    c.from('login_events').select('user_id, created_at').gte('created_at', w + 'T00:00:00+05:30').limit(20000),
  ]);
  const U = (users.data ?? []) as { user_id: string; display_name: string; status: string }[];
  const role = new Map(((access.data ?? []) as { user_id: string; role_key: string }[]).map((a) => [a.user_id, a.role_key]));
  const seen = new Set(((logins.data ?? []) as { user_id: string }[]).map((l) => l.user_id));
  const active = U.filter((u) => u.status === 'active');
  const used = active.filter((u) => seen.has(u.user_id));
  const sectionsTotal = secs.count ?? 0;
  const markedDays = new Set(((subs.data ?? []) as { section_id: string; date: string }[]).map((s) => `${s.section_id}:${s.date}`)).size;
  const byRole = new Map<string, { n: number; used: number }>();
  for (const u of active) { const r = role.get(u.user_id) ?? 'none'; const t = byRole.get(r) ?? { n: 0, used: 0 }; t.n++; if (seen.has(u.user_id)) t.used++; byRole.set(r, t); }
  return (
    <Page title="Adoption monitor" sub="Last seven days." actions={<Link className="btn-ghost" href="/erp/admin/health">Data health</Link>}>
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-3"><Stat label="Staff who signed in" value={`${used.length} of ${active.length}`} hint={`${pct(used.length, active.length)}%`} /><Stat label="Roll calls submitted" value={markedDays} hint={`${sectionsTotal} sections, up to 5 school days`} /><Stat label="Not signed in this week" value={active.length - used.length} tone={active.length - used.length ? 'warn' : undefined} /></div>
      <Card title="By role"><ul className="divide-y divide-line text-sm">{[...byRole].sort((a, b) => b[1].n - a[1].n).map(([r, t]) => <li key={r} className="flex items-center gap-3 px-4 py-2"><span className="w-40">{ROLE_LABEL[r] ?? r}</span><div className="flex-1"><Meter value={t.used} max={t.n} /></div><span className="w-16 text-right tabular-nums text-muted">{t.used}/{t.n}</span></li>)}</ul></Card>
      {active.length - used.length > 0 && <Card title="Not signed in this week" className="mt-4"><ul className="divide-y divide-line text-sm">{active.filter((u) => !seen.has(u.user_id)).slice(0, 40).map((u) => <li key={u.user_id} className="flex justify-between px-4 py-2"><span>{u.display_name}</span><span className="text-muted">{ROLE_LABEL[role.get(u.user_id) ?? ''] ?? ''}</span></li>)}</ul></Card>}
    </Page>
  );
}
