import Link from 'next/link';
import { requireCap } from '@/lib/erp/ctx';
import { core, erp } from '@/lib/erp/db';
import { Page, Card, Badge, Meter } from '@/components/erp/ui';

export const metadata = { title: 'Set-up checklist' };
export default async function Setup() {
  const ctx = await requireCap('admin');
  const cnt = async (schema: 'core' | 'erp', t: string) => ((await (schema === 'core' ? core(ctx.sb) : erp(ctx.sb)).from(t).select('id', { count: 'exact', head: true }).is('deleted_at', null)).count ?? 0);
  const [sections, staff, students, plans, demands, tt, assign, users, routes, schemes] = await Promise.all([cnt('core', 'sections'), cnt('core', 'staff'), cnt('core', 'students'), cnt('erp', 'fee_plans'), cnt('erp', 'fee_demands'), cnt('core', 'timetable_entries'), cnt('core', 'teacher_allocations'),
    core(ctx.sb).from('org_users').select('id', { count: 'exact', head: true }).then((r) => r.count ?? 0), cnt('erp', 'routes'), cnt('erp', 'assessment_schemes')]);
  const steps: [string, string, boolean, string][] = [
    ['Review grades and sections', `${sections} sections`, sections > 0, '/erp/x/sections'], ['Add staff', `${staff} staff records`, staff > 0, '/erp/hr'], ['Give your team access', `${users} users have access`, users > 1, '/erp/admin/users'],
    ['Admit or import students', `${students} students`, students > 0, '/erp/admin/import'], ['Set teaching assignments', `${assign} class-subject assignments`, assign > 0, '/erp/x/teacher_allocations'], ['Build the timetable', `${tt} periods placed`, tt > 0, '/erp/timetable'],
    ['Create fee plans', `${plans} plans`, plans > 0, '/erp/fees/structure'], ['Raise fee demands', `${demands} instalments`, demands > 0, '/erp/fees/structure'], ['Check the assessment scheme', `${schemes} schemes installed`, schemes > 0, '/erp/x/assessment_schemes'], ['Set up transport (optional)', `${routes} routes`, routes > 0, '/erp/transport'],
  ];
  const done = steps.filter((s) => s[2]).length;
  return (
    <Page title="Set-up checklist" sub="A typical branch goes live in about six weeks. This list tracks what the system can see.">
      <Card><div className="p-4"><div className="mb-2 flex justify-between text-sm"><span>{done} of {steps.length} steps done</span></div><Meter value={done} max={steps.length} /></div>
        <ul className="divide-y divide-line border-t border-line">{steps.map(([t, d, ok, h]) => <li key={t} className="flex items-center justify-between gap-3 px-4 py-3 text-sm"><div><div className="font-medium">{t}</div><div className="text-xs text-muted">{d}</div></div><span className="flex items-center gap-2">{ok ? <Badge tone="green">done</Badge> : <Badge tone="amber">to do</Badge>}<Link className="btn-ghost btn-sm" href={h}>Open</Link></span></li>)}</ul></Card>
    </Page>
  );
}
