import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireCap } from '@/lib/erp/ctx';
import { core, erp } from '@/lib/erp/db';
import { Page, Card, Field } from '@/components/erp/ui';
import { fullNameOf } from '@/lib/erp/q';
import { go, str } from '@/lib/erp/fmt';

export const metadata = { title: 'Bank and statutory IDs' };
async function save(fd: FormData) {
  'use server';
  const ctx = await requireCap('payroll', 'write');
  const id = str(fd, 'staff')!;
  const data = Object.fromEntries(['bank_name', 'bank_account', 'ifsc', 'pan', 'uan', 'esi_no', 'aadhaar_last4', 'tax_regime', 'address', 'emergency_contact'].map((k) => [k, str(fd, k)]));
  const { error } = await erp(ctx.sb).rpc('save_staff_payroll', { p_staff: id, p_data: data });
  go(`/erp/hr/staff/${id}/bank`, error ? error.message : 'Saved.', error ? 'err' : 'ok');
}

/** Restricted bank and statutory details: read and saved only through logged functions (DM-05). */
export default async function Bank({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireCap('payroll');
  const { data: s } = await core(ctx.sb).from('staff').select('id, first_name, last_name').eq('id', id).is('deleted_at', null).maybeSingle();
  if (!s) notFound();
  const r = await erp(ctx.sb).rpc('read_staff_payroll', { p_staff: id });
  const p = (r.data ?? {}) as Record<string, string | null>;
  const can = ctx.can('payroll', 'write');
  return (
    <Page title={`Bank and statutory IDs · ${fullNameOf(s)}`} sub={<><Link className="link" href={`/erp/hr/staff/${id}`}>Back to the profile</Link> · every view of this page is logged</>}>
      <Card><form action={save} className="p-4"><input type="hidden" name="staff" value={id} />
        <fieldset disabled={!can} className="grid gap-4 sm:grid-cols-3">{[['bank_name', 'Bank'], ['bank_account', 'Account number'], ['ifsc', 'IFSC'], ['pan', 'PAN'], ['uan', 'UAN (PF)'], ['esi_no', 'ESI number'], ['aadhaar_last4', 'Aadhaar (last 4)'], ['emergency_contact', 'Emergency contact'], ['address', 'Address']].map(([k, l]) => <Field key={k!} label={l!}><input name={k} className="input" defaultValue={p[k!] ?? ''} /></Field>)}
          <Field label="Tax regime"><select name="tax_regime" className="input" defaultValue={p.tax_regime ?? 'new'}><option value="new">New</option><option value="old">Old</option></select></Field></fieldset>
        {can && <button className="btn mt-4">Save</button>}</form></Card>
    </Page>
  );
}
