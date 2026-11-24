'use server';
import { getCtx } from '@/lib/erp/ctx';
import { core, erp } from '@/lib/erp/db';
import { go, str } from '@/lib/erp/fmt';
import { generate, type Entry, type Need } from '@autoed/shared/erp';
import { activeVersion, entries, periods as loadPeriods, workingDays } from '@/lib/erp/timetable';
import { NO_ID } from '@/lib/erp/q';
import { lookup } from '@/lib/erp/lookup';

export async function createVersion() {
  const ctx = await getCtx();
  const { error } = await core(ctx.sb).from('timetable_versions').insert({ name: ctx.year ? `Timetable ${ctx.year.name}` : 'Timetable', status: 'published', academic_year_id: ctx.year?.id ?? null, branch_id: ctx.branchId ?? ctx.orgUser.home_branch_id ?? null });
  go('/erp/timetable', error ? error.message : 'Timetable created.', error ? 'err' : 'ok');
}

export async function setCell(fd: FormData) {
  const ctx = await getCtx();
  const version = str(fd, 'version')!, section = str(fd, 'section')!, day = Number(fd.get('day')), period = Number(fd.get('period'));
  const subject = str(fd, 'subject_id'), staff = str(fd, 'staff_id'), room = str(fd, 'room_id');
  const back = `/erp/timetable?section=${section}`;
  const t = core(ctx.sb).from('timetable_entries');
  if (staff) { // clash detection before saving (TT-02)
    const { data: clash } = await core(ctx.sb).from('timetable_entries').select('section_id').eq('version_id', version).eq('staff_id', staff).eq('day', day).eq('period_seq', period).neq('section_id', section).is('deleted_at', null).limit(1);
    if (clash?.length) {
      const sec = await lookup(ctx, 'sections', [(clash[0] as { section_id: string }).section_id]);
      go(back, `Clash: this teacher already has ${sec.name((clash[0] as { section_id: string }).section_id)} in that period. Nothing was changed.`, 'err');
    }
  }
  await t.delete().eq('version_id', version).eq('section_id', section).eq('day', day).eq('period_seq', period);
  if (subject || staff) {
    const { error } = await core(ctx.sb).from('timetable_entries').insert({ version_id: version, section_id: section, day, period_seq: period, subject_id: subject, staff_id: staff, room_id: room });
    if (error) go(back, error.message, 'err');
  }
  go(back, 'Timetable updated. Teachers and families see the change in their apps.');
}

/** Fill empty cells from teaching assignments (TT-03). Existing cells are kept. */
export async function autoGenerate(fd: FormData) {
  const ctx = await getCtx();
  const section = str(fd, 'section');
  const ver = await activeVersion(ctx);
  if (!ver) go('/erp/timetable', 'Create the timetable first.', 'err');
  let nq = core(ctx.sb).from('teacher_allocations').select('section_id, subject_id, staff_id, periods_per_week').eq('academic_year_id', ctx.year?.id ?? NO_ID).is('deleted_at', null);
  if (section) nq = nq.eq('section_id', section);
  const [{ data: needs }, existing, bells] = await Promise.all([nq, entries(ctx, ver!.id), loadPeriods(ctx)]);
  if (!needs?.length) go(`/erp/timetable${section ? `?section=${section}` : ''}`, 'Add teaching assignments first: who teaches which subject to which section, and how many periods a week.', 'err');
  const days = workingDays(ctx);
  const seqs = bells.filter((b) => b.kind === 'period').map((b) => b.seq);
  const ex: Entry[] = existing.filter((e) => e.section_id).map((e) => ({ section_id: e.section_id!, day: e.day, period_no: e.period_seq, subject_id: e.subject_id, staff_id: e.staff_id }));
  const { created, unplaced } = generate((needs as unknown as Need[]).map((n) => ({ ...n, periods_per_week: Number(n.periods_per_week ?? 0) })), days, seqs.length ? seqs : [1, 2, 3, 4, 5, 6, 7, 8], ex);
  for (let i = 0; i < created.length; i += 500) {
    const { error } = await core(ctx.sb).from('timetable_entries').insert(created.slice(i, i + 500).map((e) => ({ version_id: ver!.id, section_id: e.section_id, day: e.day, period_seq: e.period_no, subject_id: e.subject_id, staff_id: e.staff_id })));
    if (error) go(`/erp/timetable${section ? `?section=${section}` : ''}`, error.message, 'err');
  }
  go(`/erp/timetable${section ? `?section=${section}` : ''}`, `${created.length} periods placed.${unplaced.length ? ` ${unplaced.reduce((t, u) => t + u.missing, 0)} could not be placed; fine-tune by hand.` : ''}`);
}

export async function confirmSub(fd: FormData) {
  const ctx = await getCtx();
  const date = str(fd, 'date')!, sub = str(fd, 'substitute')!;
  const { error } = await erp(ctx.sb).from('substitutions').upsert({ date, period_seq: Number(fd.get('period')), section_id: str(fd, 'section'), subject_id: str(fd, 'subject'), absent_staff_id: str(fd, 'absent'), substitute_staff_id: sub, status: 'assigned', branch_id: ctx.branchId ?? ctx.orgUser.home_branch_id }, { onConflict: 'org_id,date,period_seq,section_id' });
  if (!error) {
    const { data: p } = await core(ctx.sb).from('staff').select('user_id').eq('id', sub).maybeSingle();
    const uid = (p as { user_id: string | null } | null)?.user_id;
    if (uid) await core(ctx.sb).from('notifications').insert({ user_id: uid, staff_id: sub, product_key: 'erp', event_key: 'cover', title: `Cover: period ${fd.get('period')} on ${date}`, body: `${str(fd, 'section_name')} · it now shows in your timetable.`, link: '/erp' });
  }
  go(`/erp/timetable/substitutions?date=${date}`, error ? error.message : 'Substitute confirmed and notified. The day’s timetable is updated.', error ? 'err' : 'ok');
}
