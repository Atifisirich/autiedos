'use server';
import { revalidatePath } from 'next/cache';
import { getCtx } from '@/lib/erp/ctx';
import { core } from '@/lib/erp/db';
import { today, go, str, errMsg } from '@/lib/erp/fmt';
import { addDays } from '@/lib/erp/calendar';

export type Mark = { student_id: string; status: 'P' | 'A' | 'L' };
const DB = { P: 'present', A: 'absent', L: 'late' } as const;

/** Roll call submit (ATT-02, ATT-04). Safe to retry: the same marks give the same result and parents are told once. */
export async function submitRoll(sectionId: string, date: string, session: string, marks: Mark[]): Promise<{ ok: boolean; message: string }> {
  try {
    const ctx = await getCtx();
    if (!ctx.can('attendance', 'write')) return { ok: false, message: 'You do not have permission to mark attendance.' };
    const sb = core(ctx.sb);
    const d = today();
    if (date > d) return { ok: false, message: 'Attendance cannot be marked for a future date.' };
    // late edits need the manager level (delete right on student attendance); teachers have the "scoped" level (create and edit only)
    if (date < d && !ctx.canAction('student_attendance', 'delete')) return { ok: false, message: 'The edit window has closed. Ask your coordinator to make this change.' };
    const { data: sec } = await sb.from('sections').select('id, name').eq('id', sectionId).single();
    if (!sec) return { ok: false, message: 'Section not found.' };
    const ids = marks.map((m) => m.student_id);
    const { data: before } = await sb.from('student_attendance_marks').select('student_id, status').eq('date', date).eq('session_key', session).in('student_id', ids).is('deleted_at', null);
    const prev = new Map(((before ?? []) as { student_id: string; status: string }[]).map((b) => [b.student_id, b.status]));
    // the session row (one per section, date and session) carries who marked and when
    const { data: sess, error: se } = await sb.from('student_attendance_sessions').upsert({ section_id: sectionId, date, session_key: session, status: 'submitted', submitted_at: new Date().toISOString(), marked_by_name: ctx.name, marked_by_staff_id: ctx.staff?.id ?? null }, { onConflict: 'org_id,section_id,date,session_key' }).select('id').single();
    if (se) return { ok: false, message: se.message };
    // approved student leave is never overwritten by an absence
    const rows = marks.filter((m) => !(prev.get(m.student_id) === 'on_leave' && m.status === 'A')).map((m) => ({ session_id: sess!.id, student_id: m.student_id, date, session_key: session, status: DB[m.status], source: 'teacher' }));
    const { error } = await sb.from('student_attendance_marks').upsert(rows, { onConflict: 'org_id,student_id,date,session_key' });
    if (error) return { ok: false, message: error.message };
    const count = (s: string) => marks.filter((m) => m.status === s).length;
    // Tell parents of newly absent students once.
    const newlyAbsent = marks.filter((m) => m.status === 'A' && prev.get(m.student_id) !== 'absent' && prev.get(m.student_id) !== 'on_leave').map((m) => m.student_id);
    if (newlyAbsent.length && session === 'day') {
      const { data: studs } = await sb.from('students').select('id, first_name, household_id').in('id', newlyAbsent);
      const sl = (studs ?? []) as { id: string; first_name: string; household_id: string | null }[];
      const { data: gs } = await sb.from('guardians').select('household_id, user_id').in('household_id', sl.map((s) => s.household_id).filter((x): x is string => !!x)).not('user_id', 'is', null);
      const notes: object[] = [];
      for (const s of sl) for (const g of ((gs ?? []) as { household_id: string; user_id: string }[]).filter((x) => x.household_id === s.household_id)) {
        notes.push({ user_id: g.user_id, product_key: 'erp', event_key: 'absent', title: `${s.first_name} was marked absent`, body: `On ${date}. Reply with the reason or apply for leave in the app.`, link: '/erp/parent/requests', dedupe_key: `absent:${s.id}:${date}:${g.user_id}` });
      }
      if (notes.length) await sb.from('notifications').upsert(notes, { onConflict: 'org_id,dedupe_key', ignoreDuplicates: true });
      // Chronic absence: three consecutive days (ATT-08)
      const { data: recent } = await sb.from('student_attendance_marks').select('student_id, date, status').in('student_id', newlyAbsent).eq('session_key', 'day').gte('date', addDays(date, -7)).is('deleted_at', null).order('date', { ascending: false });
      const rec = (recent ?? []) as { student_id: string; status: string }[];
      const chronic = newlyAbsent.filter((id) => rec.filter((r) => r.student_id === id).slice(0, 3).filter((r) => r.status === 'absent').length === 3);
      if (chronic.length) {
        const names = sl.filter((s) => chronic.includes(s.id)).map((s) => s.first_name).join(', ');
        await sb.from('notifications').insert({ user_id: ctx.user.id, product_key: 'erp', event_key: 'attendance.chronic', title: 'Three days absent in a row', body: `${names} (${sec.name}). Please contact the family.`, link: `/erp/attendance/roll/${sectionId}` });
      }
    }
    revalidatePath('/erp/attendance');
    return { ok: true, message: `Saved: ${count('P')} present, ${count('A')} absent, ${count('L')} late.${newlyAbsent.length ? ' Parents of absentees have been informed.' : ''}` };
  } catch (e) { return { ok: false, message: errMsg(e) }; }
}

export async function markStaff(fd: FormData) {
  const ctx = await getCtx();
  const date = str(fd, 'date') ?? today();
  const rows = [...fd.entries()].filter(([k, v]) => k.startsWith('s_') && v).map(([k, v]) => ({ staff_id: k.slice(2), date, status: String(v), source: 'manual', branch_id: ctx.branchId ?? ctx.orgUser.home_branch_id }));
  if (!rows.length) go(`/erp/attendance/staff?date=${date}`, 'Nothing to save.', 'err');
  const { error } = await core(ctx.sb).from('staff_attendance').upsert(rows, { onConflict: 'org_id,staff_id,date' });
  go(`/erp/attendance/staff?date=${date}`, error ? error.message : 'Staff attendance saved.', error ? 'err' : 'ok');
}
