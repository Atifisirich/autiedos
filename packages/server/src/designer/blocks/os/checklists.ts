/**
 * os.checklist -> os.checklist_templates (+ os.checklist_items) of the actor's active branch, as the checklist
 * builder saves them (services/admin.ts saveChecklistTemplate): the template row keyed by `key`, items replaced.
 */
import { insert, maybe, one, q } from '../../../db';
import { clean, hm, num, osRoleId, osRoleKey, type ApplyCtx, type ServerBlock } from '../types';

async function tpl(x: ApplyCtx, key: string) {
  return maybe<{ id: string; key: string; name: string; schedule: { frequency?: string; weekdays?: number[]; month_day?: number | null; time?: string }; owner_role_id: string | null; location_text: string | null; active: boolean }>(
    x.c,
    `select id, key, name, schedule, owner_role_id, location_text, active from os.checklist_templates where org_id = $1 and branch_id = $2 and key = $3 and deleted_at is null order by created_at desc limit 1`,
    [x.actor.orgId, x.actor.branchId, key],
  );
}

export const checklistServer: ServerBlock = {
  key: 'os.checklist',
  async read(x, key) {
    const t = await tpl(x, key);
    if (!t || !t.active) return null;
    const items = await q<{ label: string; label_i18n: Record<string, string>; item_type: string; min_value: number | null; max_value: number | null; required: boolean; on_fail: unknown }>(
      x.c,
      `select label, label_i18n, item_type, min_value, max_value, required, on_fail from os.checklist_items where template_id = $1 and deleted_at is null order by seq`,
      [t.id],
    );
    return clean({
      key: t.key,
      name: t.name,
      owner_role_key: (await osRoleKey(x.c, t.owner_role_id)) ?? '',
      frequency: t.schedule.frequency ?? 'daily',
      weekdays: t.schedule.weekdays ?? [],
      month_day: t.schedule.month_day ?? null,
      time: hm(t.schedule.time) ?? '08:00',
      location_text: t.location_text,
      items: items.map((i) => clean({ label: i.label, label_i18n: i.label_i18n ?? {}, item_type: i.item_type, min_value: num(i.min_value), max_value: num(i.max_value), required: i.required, on_fail: i.on_fail ?? null })),
    });
  },
  async list(x) {
    return q<{ key: string; name: string }>(x.c, `select key, name from os.checklist_templates where org_id = $1 and (branch_id = $2 or branch_id is null) and key is not null and deleted_at is null and active order by name`, [x.actor.orgId, x.actor.branchId]);
  },
  async write(x, key, s) {
    const { orgId, branchId } = x.actor;
    const owner = await osRoleId(x, String(s.owner_role_key));
    const schedule = { frequency: s.frequency, weekdays: s.weekdays ?? [], ...(s.month_day ? { month_day: s.month_day } : {}), time: s.time };
    const existing = await tpl(x, key);
    const row = { name: s.name, schedule, owner_role_id: owner, location_text: s.location_text ?? null, active: true };
    const t = existing
      ? await one<{ id: string }>(x.c, `update os.checklist_templates set name = $2, schedule = $3, owner_role_id = $4, location_text = $5, active = true where id = $1 returning id`, [existing.id, row.name, JSON.stringify(schedule), owner, row.location_text])
      : await insert<{ id: string }>(x.c, 'os.checklist_templates', { org_id: orgId, branch_id: branchId, key, ...row });
    await x.c.query(`update os.checklist_items set deleted_at = now() where template_id = $1 and deleted_at is null`, [t.id]);
    let seq = 1;
    for (const it of s.items as Record<string, unknown>[]) {
      await insert(x.c, 'os.checklist_items', { org_id: orgId, branch_id: branchId, template_id: t.id, seq: seq++, label: it.label, label_i18n: it.label_i18n ?? {}, item_type: it.item_type, min_value: it.min_value ?? null, max_value: it.max_value ?? null, required: it.required ?? true, on_fail: it.on_fail ?? null });
    }
  },
  async remove(x, key) {
    const t = await tpl(x, key);
    if (t) await x.c.query(`update os.checklist_templates set deleted_at = now() where id = $1`, [t.id]);
  },
};
