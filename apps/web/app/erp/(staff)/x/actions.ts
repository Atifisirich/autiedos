'use server';
import { getCtx } from '@/lib/erp/ctx';
import { entity, rowFromForm, tableOf, idCol, type Row } from '@/lib/erp/crud';
import { go, errMsg, str } from '@/lib/erp/fmt';

export async function saveRecord(fd: FormData) {
  const ctx = await getCtx();
  const key = str(fd, '_entity') ?? '';
  const ent = entity(key);
  if (!ent || ent.readonly || !ctx.can(ent.cap, 'write')) go('/erp', 'Unknown record type.', 'err');
  const id = str(fd, '_id');
  const back = str(fd, '_back') ?? `/erp/x/${key}`;
  let row: Row;
  try { row = rowFromForm(ent!, fd); } catch (e) { return go(id ? `/erp/x/${key}/${id}` : `/erp/x/${key}/new`, errMsg(e), 'err'); }
  if (!id) {
    if (ent!.branch && !('branch_id' in row)) row.branch_id = ctx.branchId ?? ctx.orgUser.home_branch_id ?? (ctx.branches.length === 1 ? ctx.branches[0]!.id : null);
    if (ent!.year && !('academic_year_id' in row)) row.academic_year_id = ctx.year?.id ?? null;
  }
  const t = tableOf(ctx, ent!);
  const { error } = id ? await t.update(row).eq(idCol(ent!), id) : await t.insert(row);
  if (error) go(id ? `/erp/x/${key}/${id}` : `/erp/x/${key}/new`, error.code === '42501' ? 'You do not have permission to save this.' : error.message, 'err');
  go(back, 'Saved.');
}

export async function deleteRecord(fd: FormData) {
  const ctx = await getCtx();
  const key = str(fd, '_entity') ?? '';
  const ent = entity(key);
  const id = str(fd, '_id');
  if (!ent || ent.readonly || !id || !ctx.can(ent.cap, 'write')) go('/erp', 'Unknown record.', 'err');
  const { error, count } = await tableOf(ctx, ent!).delete({ count: 'exact' }).eq(idCol(ent!), id!);
  if (error) go(`/erp/x/${key}/${id}`, error.message, 'err');
  if (!count) go(`/erp/x/${key}/${id}`, 'You do not have permission to delete this.', 'err');
  go(`/erp/x/${key}`, 'Deleted.');
}
