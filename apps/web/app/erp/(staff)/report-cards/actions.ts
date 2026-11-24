'use server';
import { randomBytes } from 'node:crypto';
import { getCtx } from '@/lib/erp/ctx';
import { core, erp } from '@/lib/erp/db';
import { go, str } from '@/lib/erp/fmt';
import { buildSnapshots, remarkFor } from '@/lib/erp/reportcards';
import { erpAi } from '@/lib/erp/ai';
import { NO_ID } from '@/lib/erp/q';

const back = (s: string, t: string) => `/erp/report-cards?section=${s}&term=${encodeURIComponent(t)}`;

/** Generate (or refresh) draft cards for a whole section from the live marks. Published cards are never overwritten. */
export async function generateCards(fd: FormData) {
  const ctx = await getCtx();
  const section = str(fd, 'section')!, term = str(fd, 'term')!;
  const { snapshots, branchId, schemeId } = await buildSnapshots(ctx, section, term);
  const { data: existing } = await erp(ctx.sb).from('report_cards').select('student_id, status, class_teacher_remark').eq('section_id', section).eq('term', term).eq('academic_year_id', ctx.year?.id ?? NO_ID).is('deleted_at', null);
  const prev = new Map(((existing ?? []) as { student_id: string; status: string; class_teacher_remark: string | null }[]).map((e) => [e.student_id, e]));
  const rows = [...snapshots].filter(([id]) => prev.get(id)?.status !== 'published').map(([id, snapshot]) => ({ student_id: id, section_id: section, branch_id: branchId, academic_year_id: ctx.year?.id, term, scheme_id: schemeId, snapshot, status: prev.get(id)?.status ?? 'draft', class_teacher_remark: prev.get(id)?.class_teacher_remark ?? null }));
  if (!rows.length) go(back(section, term), 'There are no active students or every card is already published.', 'err');
  const { error } = await erp(ctx.sb).from('report_cards').upsert(rows, { onConflict: 'org_id,student_id,academic_year_id,term' });
  go(back(section, term), error ? error.message : `${rows.length} report cards generated from the latest marks.`, error ? 'err' : 'ok');
}

/** Draft remarks for cards that have none. Uses the AI hook when one is wired (no names in the prompt), otherwise a rule-based draft. Always reviewed by the teacher (GB-06). */
export async function draftRemarks(fd: FormData) {
  const ctx = await getCtx();
  const section = str(fd, 'section')!, term = str(fd, 'term')!;
  const { data } = await erp(ctx.sb).from('report_cards').select('id, snapshot, class_teacher_remark').eq('section_id', section).eq('term', term).eq('academic_year_id', ctx.year?.id ?? NO_ID).neq('status', 'published').is('deleted_at', null);
  let n = 0;
  for (const c of (data ?? []) as { id: string; snapshot: Parameters<typeof remarkFor>[0]; class_teacher_remark: string | null }[]) {
    if (c.class_teacher_remark) continue;
    const snap = c.snapshot;
    const facts = `Term: ${term}. Overall ${snap.overall ?? 'n/a'}%. Attendance ${snap.attendance.percent ?? 'n/a'}%. Subjects: ${snap.subjects.map((s) => `${s.name} ${s.percent ?? 'n/a'}%`).join(', ')}.`;
    const ai = await erpAi.text('You write short, warm, specific report-card remarks for a school class teacher in India. Two sentences, plain English, no marks or percentages quoted, no names. Refer to the student as "the student".', facts, { maxTokens: 300 });
    const text = ai ? ai.replace(/the student/gi, snap.student.name.split(' ')[0] ?? 'the student') : remarkFor(snap);
    await erp(ctx.sb).from('report_cards').update({ class_teacher_remark: text }).eq('id', c.id);
    n++;
  }
  go(back(section, term), n ? `${n} remarks drafted. Please read and edit each one before review.` : 'Every card already has a remark.');
}

export async function saveRemark(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd, 'id')!;
  const patch: Record<string, unknown> = {};
  if (fd.has('class_teacher_remark')) patch.class_teacher_remark = str(fd, 'class_teacher_remark');
  if (fd.has('principal_remark')) patch.principal_remark = str(fd, 'principal_remark');
  const { error } = await erp(ctx.sb).from('report_cards').update(patch).eq('id', id).neq('status', 'published');
  go(str(fd, 'back') ?? `/erp/report-cards/${id}`, error ? error.message : 'Remark saved.', error ? 'err' : 'ok');
}

/** Review (coordinator) -> sign-off (principal) -> publish. Publishing locks the marks (GB-08). */
export async function advanceCards(fd: FormData) {
  const ctx = await getCtx();
  const section = str(fd, 'section')!, term = str(fd, 'term')!, to = str(fd, 'to')!;
  const allow: Record<string, string[]> = { reviewed: ['coordinator', 'principal', 'group_admin'], signed: ['principal', 'group_admin'], published: ['principal', 'group_admin'] };
  if (!allow[to]?.includes(ctx.role)) go(back(section, term), to === 'reviewed' ? 'Only a coordinator or principal can mark cards as reviewed.' : 'Only the principal can sign off and publish.', 'err');
  const from = ({ reviewed: 'draft', signed: 'reviewed', published: 'signed' } as Record<string, string>)[to]!;
  const { data } = await erp(ctx.sb).from('report_cards').select('id, student_id').eq('section_id', section).eq('term', term).eq('academic_year_id', ctx.year?.id ?? NO_ID).eq('status', from).is('deleted_at', null);
  const cards = (data ?? []) as { id: string; student_id: string }[];
  if (!cards.length) go(back(section, term), `No cards are at the "${from}" stage.`, 'err');
  if (to === 'published') {
    for (const c of cards) await erp(ctx.sb).from('report_cards').update({ status: 'published', published_at: new Date().toISOString(), verify_code: randomBytes(9).toString('hex') }).eq('id', c.id);
    await erp(ctx.sb).from('assessments').update({ status: 'published' }).eq('section_id', section).eq('term', term).eq('academic_year_id', ctx.year?.id ?? NO_ID);
    const { data: studs } = await core(ctx.sb).from('students').select('id, first_name, household_id').in('id', cards.map((c) => c.student_id));
    const S = (studs ?? []) as { id: string; first_name: string; household_id: string | null }[];
    const hh = [...new Set(S.map((s) => s.household_id).filter((x): x is string => !!x))];
    const { data: gs } = hh.length ? await core(ctx.sb).from('guardians').select('household_id, user_id').in('household_id', hh).not('user_id', 'is', null) : { data: [] };
    const notes = S.flatMap((s) => ((gs ?? []) as { household_id: string; user_id: string }[]).filter((g) => g.household_id === s.household_id).map((g) => ({ user_id: g.user_id, product_key: 'erp', event_key: 'report_card', title: `${term} report card for ${s.first_name} is ready`, link: '/erp/parent/academics' })));
    if (notes.length) await core(ctx.sb).from('notifications').insert(notes);
    go(back(section, term), `${cards.length} report cards published to parents. Marks for this term are now locked.`);
  }
  const { error } = await erp(ctx.sb).from('report_cards').update({ status: to }).in('id', cards.map((c) => c.id));
  go(back(section, term), error ? error.message : `${cards.length} cards marked ${to}.`, error ? 'err' : 'ok');
}
