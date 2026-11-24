import Link from 'next/link';
import { requireCap } from '@/lib/erp/ctx';
import { core } from '@/lib/erp/db';
import { sectionsFor, fullNameOf } from '@/lib/erp/q';
import { Page, Card, Empty, Badge } from '@/components/erp/ui';

export const metadata = { title: 'Students' };
const PAGE = 50;
export default async function Students({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await requireCap('students');
  const page = Math.max(1, Number(sp.page ?? 1));
  const status = sp.status ?? 'active';
  let q = core(ctx.sb).from('students').select('id, admission_no, first_name, last_name, gender, status, roll_no, house, section:sections(name)', { count: 'exact' }).is('deleted_at', null).order('first_name').range((page - 1) * PAGE, page * PAGE - 1);
  if (status !== 'all') q = q.eq('status', status);
  if (ctx.branchId) q = q.eq('branch_id', ctx.branchId);
  if (sp.section) q = q.eq('section_id', sp.section);
  const term = (sp.q ?? '').replace(/[%,()]/g, ' ').trim();
  if (term) q = q.or(`first_name.ilike.%${term}%,last_name.ilike.%${term}%,admission_no.ilike.%${term}%`);
  const [{ data, count }, sections] = await Promise.all([q, sectionsFor(ctx)]);
  const rows = (data ?? []) as unknown as { id: string; admission_no: string; first_name: string; last_name: string; gender: string; status: string; roll_no: string; house: string; section: { name: string } | null }[];
  const qs = (extra: Record<string, string>) => new URLSearchParams({ ...(Object.fromEntries(Object.entries(sp).filter(([, v]) => v)) as Record<string, string>), ...extra }).toString();
  const canWrite = ctx.can('students', 'write');
  return (
    <Page title="Students" sub={`${count ?? 0} ${status === 'all' ? '' : status} students`} actions={<>
      <Link className="btn-ghost" href="/erp/x/students/export">Export</Link>
      {canWrite && <><Link className="btn-ghost" href="/erp/students/bulk">Bulk actions</Link><Link className="btn" href="/erp/students/new">Admit student</Link></>}
    </>}>
      <form className="no-print mb-3 flex flex-wrap gap-2">
        <input name="q" defaultValue={sp.q ?? ''} placeholder="Name or admission number" className="input !w-60" aria-label="Search students" />
        <select name="section" defaultValue={sp.section ?? ''} className="input !w-auto" aria-label="Section"><option value="">All sections</option>{sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        <select name="status" defaultValue={status} className="input !w-auto" aria-label="Status">{['active', 'admitted', 'suspended', 'withdrawn', 'transferred', 'alumni', 'archived', 'all'].map((s) => <option key={s}>{s}</option>)}</select>
        <button className="btn-ghost">Filter</button>
      </form>
      <Card>
        {rows.length === 0 ? <Empty title="No students match" hint="Admit a student, import a list from Admin console, or change the filters." action={canWrite ? <Link className="btn" href="/erp/students/new">Admit student</Link> : undefined} /> : (
          <div className="overflow-x-auto"><table className="tbl">
            <thead><tr><th>Name</th><th>Admission no.</th><th>Section</th><th>Roll</th><th>Gender</th><th>House</th><th>Status</th></tr></thead>
            <tbody>{rows.map((s) => (
              <tr key={s.id} className="hover:bg-paper"><td><Link className="link font-medium" href={`/erp/students/${s.id}`}>{fullNameOf(s)}</Link></td><td>{s.admission_no}</td><td>{s.section?.name}</td><td>{s.roll_no}</td><td>{s.gender}</td><td>{s.house}</td><td><Badge>{s.status}</Badge></td></tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      <div className="no-print mt-3 flex justify-end gap-2">
        {page > 1 && <Link className="btn-ghost btn-sm" href={`?${qs({ page: String(page - 1) })}`}>Previous</Link>}
        {(count ?? 0) > page * PAGE && <Link className="btn-ghost btn-sm" href={`?${qs({ page: String(page + 1) })}`}>Next</Link>}
      </div>
    </Page>
  );
}
