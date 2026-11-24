import type { Ctx } from './ctx';
import { core, erp } from './db';
import { today } from './fmt';
import { addDays, workingDay } from './calendar';
import { NO_ID } from './q';

type Result = { recipe: string; detail: string };
/**
 * Time-based recipes. They run when a leader presses "Run now"; each one is idempotent for the day (the notification dedupe key carries
 * the date), so pressing twice never sends two reminders. Event-driven recipes run inside their own screens and are not repeated here.
 */
export async function runRecipes(ctx: Ctx, only?: string): Promise<Result[]> {
  const sb = ctx.sb, d = today(), out: Result[] = [];
  const { data: autos } = await erp(sb).from('automations').select('id, name, recipe_key, enabled, test_mode').eq('enabled', true).is('deleted_at', null);
  const A = (autos ?? []) as { id: string; name: string; recipe_key: string; test_mode: boolean }[];
  const on = (key: string) => A.some((a) => a.recipe_key === key) && (!only || only === key);
  const test = (key: string) => A.find((a) => a.recipe_key === key)?.test_mode === true;
  const notify = async (users: (string | null | undefined)[], title: string, body: string, link: string, key: string) => {
    const uniq = [...new Set(users.filter((u): u is string => !!u))];
    if (!uniq.length || test(key)) return uniq.length;
    const rows = uniq.map((u) => ({ org_id: ctx.orgId, user_id: u, product_key: 'erp', event_key: `automation.${key}`, title, body, link, dedupe_key: `${key}:${d}:${title}`.slice(0, 200) }));
    const { data } = await core(sb).from('notifications').upsert(rows, { onConflict: 'org_id,user_id,dedupe_key', ignoreDuplicates: true }).select('id');
    return (data ?? []).length;
  };
  const usersOf = async (roles: string[]) => ((await core(sb).from('user_product_access').select('user_id').eq('product_key', 'erp').in('role_key', roles).is('revoked_at', null)).data ?? []).map((p: { user_id: string }) => p.user_id);
  const staffUsers = async (ids: (string | null)[]) => { const f = ids.filter((x): x is string => !!x); return f.length ? new Map(((await core(sb).from('staff').select('id, user_id').in('id', f)).data ?? []).map((s: { id: string; user_id: string | null }) => [s.id, s.user_id])) : new Map<string, string | null>(); };
  const wd = await workingDay(ctx, d);

  if (on('attendance_not_marked') && wd.working) {
    const [{ data: secs }, { data: subs }] = await Promise.all([core(sb).from('sections').select('id, name, class_teacher_id').eq('academic_year_id', ctx.year?.id ?? NO_ID).is('deleted_at', null), core(sb).from('student_attendance_sessions').select('section_id').eq('date', d).eq('session_key', 'day').eq('status', 'submitted').is('deleted_at', null)]);
    const marked = new Set(((subs ?? []) as { section_id: string }[]).map((s) => s.section_id));
    const missing = ((secs ?? []) as { id: string; name: string; class_teacher_id: string | null }[]).filter((s) => !marked.has(s.id));
    const su = await staffUsers(missing.map((m) => m.class_teacher_id));
    let n = 0; for (const m of missing) n += await notify([m.class_teacher_id ? su.get(m.class_teacher_id) : null], `Attendance not marked: ${m.name}`, 'Please mark attendance now.', `/erp/attendance/roll/${m.id}`, 'attendance_not_marked');
    if (missing.length) await notify(await usersOf(['coordinator']), `${missing.length} sections have not marked attendance`, missing.slice(0, 8).map((m) => m.name).join(', '), '/erp/attendance', 'attendance_not_marked');
    out.push({ recipe: 'Attendance not marked', detail: `${missing.length} sections unmarked, ${n} teachers nudged` });
  }
  if (on('marks_deadline')) {
    const { data: a } = await erp(sb).from('assessments').select('id, name, staff_id, entry_deadline').eq('status', 'open').lte('entry_deadline', addDays(d, 2)).not('staff_id', 'is', null).is('deleted_at', null);
    const L = (a ?? []) as { id: string; name: string; staff_id: string; entry_deadline: string }[];
    const su = await staffUsers(L.map((x) => x.staff_id));
    let n = 0; for (const x of L) n += await notify([su.get(x.staff_id)], `Marks due: ${x.name}`, `Entry deadline ${x.entry_deadline}.`, `/erp/assessments/${x.id}`, 'marks_deadline');
    out.push({ recipe: 'Marks deadline', detail: `${L.length} assessments due, ${n} reminders` });
  }
  if (on('homework_posting_check') && wd.working) {
    const [{ data: posts }, { data: secs }] = await Promise.all([core(sb).from('class_posts').select('section_id').gte('created_at', d + 'T00:00:00+05:30').is('deleted_at', null), core(sb).from('sections').select('id, name').eq('academic_year_id', ctx.year?.id ?? NO_ID).is('deleted_at', null)]);
    const posted = new Set(((posts ?? []) as { section_id: string }[]).map((p) => p.section_id));
    const quiet = ((secs ?? []) as { id: string; name: string }[]).filter((s) => !posted.has(s.id));
    if (quiet.length) await notify(await usersOf(['coordinator']), `${quiet.length} sections have no post today`, quiet.slice(0, 8).map((s) => s.name).join(', '), '/erp/homework?tab=compliance', 'homework_posting_check');
    out.push({ recipe: 'Homework posting check', detail: `${quiet.length} sections without a post today` });
  }
  if (on('year_rollover_reminders') && d.slice(5, 7) === '03') { await notify(await usersOf(['group_admin', 'system_admin', 'principal']), 'Time to plan the year rollover', 'Checklist: promotion, fee plans, routes and timetable.', '/erp/admin/rollover', 'year_rollover_reminders'); out.push({ recipe: 'Year rollover reminders', detail: 'Checklist sent to leadership' }); }
  // Service-level breaches
  if (!only) {
    const { data: late } = await core(sb).from('tickets').select('id, title').in('status', ['open', 'in_progress']).lt('due_at', new Date().toISOString()).is('deleted_at', null).limit(200);
    const T = (late ?? []) as { id: string; title: string }[];
    if (T.length) { await notify(await usersOf(['principal']), `${T.length} requests are past their SLA`, T.slice(0, 5).map((t) => t.title).join('; '), '/erp/helpdesk', 'sla'); out.push({ recipe: 'SLA breach alert', detail: `${T.length} requests escalated to the principal` }); }
  }
  for (const r of out) {
    const a = A.find((x) => x.name === r.recipe);
    await erp(sb).from('automation_runs').insert({ automation_id: a?.id ?? null, status: a?.test_mode ? 'test' : 'ok', detail: r.detail });
    if (a) await erp(sb).from('automations').update({ last_run_at: new Date().toISOString() }).eq('id', a.id);
  }
  return out;
}
