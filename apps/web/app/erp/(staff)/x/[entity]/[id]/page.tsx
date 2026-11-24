import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getCtx } from '@/lib/erp/ctx';
import { entity, refOptions, labelOf, tableOf, idCol, type Row } from '@/lib/erp/crud';
import { auditDb } from '@/lib/erp/db';
import { Page, Card } from '@/components/erp/ui';
import { RecordFields } from '@/components/erp/record-form';
import { ConfirmSubmit } from '@/components/erp/client';
import { saveRecord, deleteRecord } from '../../actions';
import { ftime } from '@/lib/erp/fmt';

export default async function Record({ params, searchParams }: { params: Promise<{ entity: string; id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const [{ entity: key, id }, sp] = await Promise.all([params, searchParams]);
  const ent = entity(key);
  if (!ent) notFound();
  const ctx = await getCtx();
  if (!ctx.can(ent.cap)) notFound();
  const isNew = id === 'new';
  const canWrite = ctx.can(ent.cap, 'write') && !ent.readonly;
  if (isNew && !canWrite) notFound();
  const [{ data: row }, options, { data: history }] = await Promise.all([
    isNew ? Promise.resolve({ data: null }) : tableOf(ctx, ent).select('*').eq(idCol(ent), id).maybeSingle(),
    refOptions(ctx, ent),
    isNew || !ctx.canAction('audit', 'view') ? Promise.resolve({ data: [] }) : auditDb(ctx.sb).from('log').select('id, action, created_at').eq('schema_name', ent.schema).eq('table_name', ent.table).eq('row_id', id).order('created_at', { ascending: false }).limit(8),
  ]);
  if (!isNew && !row) notFound();
  // Prefill from the query string so other screens can deep-link into "new" with context.
  const seed = isNew ? Object.fromEntries(ent.fields.filter((f) => sp[f.k]).map((f) => [f.k, sp[f.k]])) : (row as Row);
  const hist = (history ?? []) as { id: number; action: string; created_at: string }[];
  return (
    <Page title={isNew ? `New: ${ent.title}` : labelOf(ent, row as Row) || ent.title} sub={<Link className="link" href={`/erp/x/${key}`}>Back to {ent.title.toLowerCase()}</Link>}>
      <Card>
        <form action={saveRecord} className="space-y-5 p-4">
          <input type="hidden" name="_entity" value={key} />
          {!isNew && <input type="hidden" name="_id" value={id} />}
          {sp.back && <input type="hidden" name="_back" value={sp.back} />}
          <fieldset disabled={!canWrite} className="space-y-5">
            <RecordFields ent={ent as never} row={seed} options={options} custom={[]} />
          </fieldset>
          {canWrite && <div className="flex gap-2"><button className="btn">Save</button><Link className="btn-ghost" href={sp.back ?? `/erp/x/${key}`}>Cancel</Link></div>}
        </form>
      </Card>
      {!isNew && canWrite && (
        <form action={deleteRecord} className="mt-4">
          <input type="hidden" name="_entity" value={key} /><input type="hidden" name="_id" value={id} />
          <ConfirmSubmit message="Delete this record? This cannot be undone." className="text-sm text-red-600 underline">Delete this record</ConfirmSubmit>
        </form>
      )}
      {hist.length > 0 && (
        <Card title="Change history" className="mt-4">
          <ul className="divide-y divide-line text-sm">{hist.map((h) => <li key={h.id} className="flex justify-between px-4 py-2"><span>{h.action}</span><span className="text-muted">{ftime(h.created_at)}</span></li>)}</ul>
        </Card>
      )}
    </Page>
  );
}
