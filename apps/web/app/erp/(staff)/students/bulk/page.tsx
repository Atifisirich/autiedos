import { requireCap } from '@/lib/erp/ctx';
import { core } from '@/lib/erp/db';
import { sectionsFor, masters, fullNameOf } from '@/lib/erp/q';
import { Page, Card, Empty } from '@/components/erp/ui';
import { bulkTransfer } from '../actions';

export const metadata = { title: 'Bulk actions' };
export default async function Bulk({ searchParams }: { searchParams: Promise<{ from?: string }> }) {
  const { from } = await searchParams;
  const ctx = await requireCap('students', 'write');
  const [sections, houses, { data: students }] = await Promise.all([
    sectionsFor(ctx),
    masters(ctx, 'house'),
    from ? core(ctx.sb).from('students').select('id, first_name, last_name, gender, roll_no, house, is_new').eq('section_id', from).eq('status', 'active').is('deleted_at', null).order('first_name') : Promise.resolve({ data: [] }),
  ]);
  const st = (students ?? []) as { id: string; first_name: string; last_name: string | null; gender: string | null; roll_no: string | null; house: string | null; is_new: boolean }[];
  const boys = st.filter((s) => s.gender === 'male').length, girls = st.filter((s) => s.gender === 'female').length;
  return (
    <Page title="Bulk actions" sub="Move students between sections or branches and assign houses. The balance view shows the section before you commit.">
      <form className="mb-3 flex gap-2"><select name="from" defaultValue={from ?? ''} className="input !w-auto" aria-label="From section"><option value="">Choose a section</option>{sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select><button className="btn-ghost">Load</button></form>
      {!from ? <Card><Empty title="Choose a section to begin" /></Card> : (
        <form action={bulkTransfer}>
          <Card title={`${st.length} students · ${boys} boys · ${girls} girls · ${st.filter((s) => s.is_new).length} new`}>
            <table className="tbl"><thead><tr><th className="w-10">Pick</th><th>Name</th><th>Gender</th><th>Roll</th><th>House</th></tr></thead>
              <tbody>{st.map((s) => <tr key={s.id}><td><input type="checkbox" name="ids" value={s.id} className="h-4 w-4" aria-label={`Select ${fullNameOf(s)}`} /></td><td>{fullNameOf(s)}</td><td>{s.gender}</td><td>{s.roll_no}</td><td>{s.house}</td></tr>)}</tbody></table>
          </Card>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label><span className="label">Move to section</span><select name="to_section" className="input" required><option value="">Choose</option>{sections.filter((s) => s.id !== from).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
            <label><span className="label">Assign house (optional)</span><select name="house" className="input"><option value="">Keep</option>{houses.map((h) => <option key={h.name}>{h.name}</option>)}</select></label>
            <button className="btn">Move selected</button>
          </div>
        </form>
      )}
    </Page>
  );
}
