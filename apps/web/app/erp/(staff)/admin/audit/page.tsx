import { requireCap } from '@/lib/erp/ctx';
import { auditDb } from '@/lib/erp/db';
import { lookup } from '@/lib/erp/lookup';
import { Page, Card, Empty, Badge } from '@/components/erp/ui';
import { ftime } from '@/lib/erp/fmt';

export const metadata = { title: 'Audit log' };
type Ev = { id: number; actor_user_id: string | null; action: string; schema_name: string | null; table_name: string | null; row_id: string | null; before: Record<string, unknown> | null; after: Record<string, unknown> | null; detail: Record<string, unknown> | null; created_at: string };
const diff = (b: Record<string, unknown> | null, a: Record<string, unknown> | null) => !b || !a ? [] : Object.keys(a).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]) && !['created_at', 'updated_at'].includes(k)).map((k) => `${k}: ${JSON.stringify(b[k]) ?? '∅'} → ${JSON.stringify(a[k])}`);
export default async function Audit({ searchParams }: { searchParams: Promise<{ table?: string; action?: string; page?: string }> }) {
  const sp = await searchParams;
  const ctx = await requireCap('audit');
  const page = Math.max(1, Number(sp.page ?? 1));
  let q = auditDb(ctx.sb).from('log').select('id, actor_user_id, action, schema_name, table_name, row_id, before, after, detail, created_at').order('created_at', { ascending: false }).range((page - 1) * 60, page * 60 - 1);
  if (sp.table) q = q.eq('table_name', sp.table);
  if (sp.action) q = q.eq('action', sp.action);
  const { data } = await q;
  const E = (data ?? []) as Ev[];
  const { data: ou } = E.length ? await ctx.sb.schema('core').from('org_users').select('user_id, display_name').in('user_id', [...new Set(E.map((e) => e.actor_user_id).filter(Boolean))] as string[]) : { data: [] };
  const who = new Map(((ou ?? []) as { user_id: string; display_name: string }[]).map((u) => [u.user_id, u.display_name]));
  void lookup;
  return (
    <Page title="Audit log" sub="Append-only record of who created, changed, deleted or viewed what. It cannot be edited by anyone, including administrators.">
      <form className="no-print mb-3 flex flex-wrap gap-2"><input name="table" defaultValue={sp.table ?? ''} placeholder="Table, e.g. receipts" className="input !w-52" aria-label="Table" /><input name="action" defaultValue={sp.action ?? ''} placeholder="Action, e.g. update" className="input !w-44" aria-label="Action" /><button className="btn-ghost">Search</button></form>
      <Card>{E.length === 0 ? <Empty title="No events match" /> : <table className="tbl"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Record</th><th>What changed</th></tr></thead><tbody>{E.map((e) => { const d = diff(e.before, e.after); return <tr key={e.id}><td className="whitespace-nowrap">{ftime(e.created_at)}</td><td>{(e.actor_user_id && who.get(e.actor_user_id)) ?? 'system'}</td><td><Badge tone={/delete/i.test(e.action) ? 'red' : /view|export/i.test(e.action) ? 'grey' : /insert|create/i.test(e.action) ? 'green' : 'blue'}>{e.action}</Badge></td><td>{(e.table_name ?? '').replace(/_/g, ' ')}</td><td className="max-w-xl break-words text-xs text-muted">{e.detail && Object.keys(e.detail).length ? JSON.stringify(e.detail).slice(0, 160) : d.length ? d.slice(0, 4).join(' · ') : ''}</td></tr>; })}</tbody></table>}</Card>
      <div className="no-print mt-3 flex justify-end gap-2 text-sm">{page > 1 && <a className="btn-ghost btn-sm" href={`?${new URLSearchParams({ ...(sp as Record<string, string>), page: String(page - 1) })}`}>Newer</a>}{E.length === 60 && <a className="btn-ghost btn-sm" href={`?${new URLSearchParams({ ...(sp as Record<string, string>), page: String(page + 1) })}`}>Older</a>}</div>
    </Page>
  );
}
