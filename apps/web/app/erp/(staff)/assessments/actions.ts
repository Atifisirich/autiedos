'use server';
import { revalidatePath } from 'next/cache';
import { getCtx } from '@/lib/erp/ctx';
import { core, erp } from '@/lib/erp/db';
import { go, str, errMsg } from '@/lib/erp/fmt';
import { NO_ID } from '@/lib/erp/q';

export async function createAssessment(fd: FormData) {
  const ctx = await getCtx();
  const sections = fd.getAll('section_id').map(String).filter(Boolean);
  const subject = str(fd, 'subject_id');
  if (!sections.length) go('/erp/assessments', 'Choose at least one section.', 'err');
  const [{ data: ta }, { data: scheme }, { data: secs }] = await Promise.all([
    core(ctx.sb).from('teacher_allocations').select('section_id, staff_id').in('section_id', sections).eq('subject_id', subject ?? NO_ID).is('deleted_at', null),
    erp(ctx.sb).from('assessment_schemes').select('id').eq('active', true).is('deleted_at', null).limit(1).maybeSingle(),
    core(ctx.sb).from('sections').select('id, programme:programmes(branch_id)').in('id', sections),
  ]);
  const staffOf = (sid: string) => ((ta ?? []) as { section_id: string; staff_id: string }[]).find((t) => t.section_id === sid)?.staff_id ?? (['class_teacher', 'subject_teacher'].includes(ctx.role) ? ctx.staff?.id ?? null : null);
  const n = (k: string, def: number) => { const v = str(fd, k); return v === null ? def : Number(v); };
  const rows = ((secs ?? []) as unknown as { id: string; programme: { branch_id: string | null } | null }[]).map((s) => ({ name: str(fd, 'name'), term: str(fd, 'term') ?? 'Term 1', component: str(fd, 'component'), section_id: s.id, branch_id: s.programme?.branch_id ?? ctx.branchId ?? ctx.orgUser.home_branch_id, academic_year_id: ctx.year?.id, subject_id: subject, max_marks: n('max_marks', 100), weightage: n('weightage', 100), date: str(fd, 'date'), entry_deadline: str(fd, 'entry_deadline'), scheme_id: (scheme as { id: string } | null)?.id ?? null, staff_id: staffOf(s.id) }));
  const { error } = await erp(ctx.sb).from('assessments').insert(rows);
  go('/erp/assessments', error ? error.message : `${rows.length} assessment${rows.length > 1 ? 's' : ''} created. Teachers see them under "Marks due".`, error ? 'err' : 'ok');
}

export type MarkRow = { student_id: string; value: string; remark?: string };
/** Save a grid of marks. A cell holds a number or one of the codes AB (absent), EX (exempt), ML (medical leave). */
export async function saveMarks(assessmentId: string, rows: MarkRow[]): Promise<{ ok: boolean; message: string }> {
  try {
    const ctx = await getCtx();
    const { data: a } = await erp(ctx.sb).from('assessments').select('max_marks, status').eq('id', assessmentId).single();
    if (!a) return { ok: false, message: 'Assessment not found.' };
    if (['locked', 'published'].includes(a.status)) return { ok: false, message: 'Marks are locked after publication. Request an unlock with a reason.' };
    const out = [];
    for (const r of rows) {
      const v = r.value.trim().toUpperCase();
      if (v === '') { out.push({ assessment_id: assessmentId, student_id: r.student_id, marks: null, code: null, remark: r.remark ?? null }); continue; }
      if (['AB', 'EX', 'ML'].includes(v)) { out.push({ assessment_id: assessmentId, student_id: r.student_id, marks: null, code: v, remark: r.remark ?? null }); continue; }
      const n = Number(v);
      if (isNaN(n) || n < 0 || n > Number(a.max_marks)) return { ok: false, message: `"${r.value}" is not valid. Enter 0 to ${a.max_marks}, or AB, EX or ML.` };
      out.push({ assessment_id: assessmentId, student_id: r.student_id, marks: n, code: null, remark: r.remark ?? null });
    }
    const { error } = await erp(ctx.sb).from('assessment_results').upsert(out, { onConflict: 'org_id,assessment_id,student_id' });
    if (error) return { ok: false, message: error.message };
    revalidatePath(`/erp/assessments/${assessmentId}`);
    return { ok: true, message: `Saved ${out.filter((o) => o.marks !== null || o.code).length} entries.` };
  } catch (e) { return { ok: false, message: errMsg(e) }; }
}

export async function setAssessmentStatus(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd, 'id')!, status = str(fd, 'status');
  if (status === 'unlock') {
    const { data: a } = await erp(ctx.sb).from('assessments').select('name').eq('id', id).single();
    const { error } = await erp(ctx.sb).rpc('submit_approval', { p_type: 'marks_unlock', p_object: id, p_title: `Unlock marks: ${a?.name}`, p_summary: str(fd, 'reason'), p_impact: 'Marks become editable again; the change is shown in the audit trail and report cards need re-publishing.', p_payload: {} });
    go(`/erp/assessments/${id}`, error ? error.message : 'Unlock request sent for approval.', error ? 'err' : 'ok');
  }
  const { error } = await erp(ctx.sb).from('assessments').update({ status }).eq('id', id);
  go(`/erp/assessments/${id}`, error ? error.message : status === 'submitted' ? 'Marked as complete. The coordinator can now review.' : 'Updated.', error ? 'err' : 'ok');
}
