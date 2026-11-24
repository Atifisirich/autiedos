import type { Ctx } from './ctx';
import { core, erp } from './db';
import { subjectResult, overall, ranks, draftRemark, type Band, type SchemeConfig, type Score } from '@autoed/shared/erp';
import { fullNameOf, NO_ID } from './q';
import { lookup } from './lookup';
import { pct } from './fmt';

export type Snapshot = {
  student: { name: string; admission_no: string | null; roll_no: string | null; dob: string | null };
  section: string; term: string; year: string; scheme: string;
  subjects: { name: string; percent: number | null; grade: string | null; pass: boolean | null; absent: boolean; parts: { name: string; marks: string; max: number }[] }[];
  overall: number | null; overall_grade: string | null; rank: number | null; class_size: number;
  attendance: { present: number; total: number; percent: number | null };
  skills: { area: string; indicator: string; level: string | null }[];
  bands: Band[];
};

/** Compute every student's report card for a section and term from the live marks. */
export async function buildSnapshots(ctx: Ctx, sectionId: string, term: string) {
  const yr = ctx.year?.id ?? NO_ID;
  const [{ data: sec }, { data: studs }, { data: assess }, { data: scheme }] = await Promise.all([
    core(ctx.sb).from('sections').select('id, name, programme:programmes(branch_id)').eq('id', sectionId).single(),
    core(ctx.sb).from('students').select('id, first_name, last_name, admission_no, roll_no, dob').eq('section_id', sectionId).eq('status', 'active').is('deleted_at', null).order('roll_no').order('first_name'),
    erp(ctx.sb).from('assessments').select('id, name, component, max_marks, weightage, subject_id').eq('section_id', sectionId).eq('term', term).eq('academic_year_id', yr).is('deleted_at', null),
    erp(ctx.sb).from('assessment_schemes').select('id, name, config, scale:grading_scales(bands)').eq('active', true).is('deleted_at', null).limit(1).maybeSingle(),
  ]);
  const A = (assess ?? []) as { id: string; name: string; component: string | null; max_marks: number; weightage: number; subject_id: string }[];
  const S = (studs ?? []) as { id: string; first_name: string; last_name: string | null; admission_no: string | null; roll_no: string | null; dob: string | null }[];
  const ids = S.map((s) => s.id);
  const subjName = await lookup(ctx, 'subjects', A.map((a) => a.subject_id));
  const [{ data: res }, { data: att }, { data: skills }] = await Promise.all([
    A.length ? erp(ctx.sb).from('assessment_results').select('assessment_id, student_id, marks, code').in('assessment_id', A.map((a) => a.id)).is('deleted_at', null).limit(50000) : Promise.resolve({ data: [] }),
    ids.length ? core(ctx.sb).from('student_attendance_marks').select('student_id, status').in('student_id', ids).eq('session_key', 'day').gte('date', ctx.year?.starts_on ?? '2000-01-01').is('deleted_at', null).limit(100000) : Promise.resolve({ data: [] }),
    ids.length ? erp(ctx.sb).from('rubric_results').select('student_id, area, indicator, level').in('student_id', ids).eq('term', term).is('deleted_at', null) : Promise.resolve({ data: [] }),
  ]);
  const R = (res ?? []) as { assessment_id: string; student_id: string; marks: number | null; code: string | null }[];
  const cfg = ((scheme as { config?: unknown } | null)?.config ?? {}) as SchemeConfig;
  const bands = ((scheme as unknown as { scale: { bands: Band[] } | null } | null)?.scale?.bands ?? [{ min: 0, grade: '-' }]) as Band[];
  const subjects = [...new Set(A.map((a) => subjName.name(a.subject_id) || 'Subject'))].sort();
  const totals: { id: string; total: number | null }[] = [];
  const out = new Map<string, Snapshot>();
  const schemeName = (scheme as { name?: string } | null)?.name ?? '';
  for (const s of S) {
    const subj = subjects.map((name) => {
      const list = A.filter((a) => (subjName.name(a.subject_id) || 'Subject') === name);
      const scores: Score[] = []; const parts: Snapshot['subjects'][number]['parts'] = [];
      for (const a of list) {
        const r = R.find((x) => x.assessment_id === a.id && x.student_id === s.id);
        scores.push({ component: a.component, marks: r?.marks ?? null, max: Number(a.max_marks), code: r?.code, weightage: Number(a.weightage) });
        parts.push({ name: a.name, marks: r?.code ?? (r?.marks === null || r?.marks === undefined ? '-' : String(r.marks)), max: Number(a.max_marks) });
      }
      return { name, ...subjectResult(scores, cfg, bands), parts };
    });
    const mine = ((att ?? []) as { student_id: string; status: string }[]).filter((a) => a.student_id === s.id && a.status !== 'on_leave');
    const present = mine.filter((a) => a.status !== 'absent').length;
    const ov = overall(subj);
    totals.push({ id: s.id, total: ov });
    out.set(s.id, {
      student: { name: fullNameOf(s), admission_no: s.admission_no, roll_no: s.roll_no, dob: s.dob }, section: (sec as { name?: string } | null)?.name ?? '', term, year: ctx.year?.name ?? '', scheme: schemeName,
      subjects: subj, overall: ov, overall_grade: ov === null ? null : [...bands].sort((a, b) => b.min - a.min).find((b) => ov >= b.min)?.grade ?? null, rank: null, class_size: S.length,
      attendance: { present, total: mine.length, percent: mine.length ? pct(present, mine.length) : null },
      skills: ((skills ?? []) as { student_id: string; area: string; indicator: string; level: string | null }[]).filter((k) => k.student_id === s.id).map((k) => ({ area: k.area, indicator: k.indicator, level: k.level })), bands,
    });
  }
  const rk = ranks(totals);
  for (const [id, snap] of out) snap.rank = rk.get(id) ?? null;
  const branch = (sec as unknown as { programme: { branch_id: string | null } | null } | null)?.programme?.branch_id ?? null;
  return { snapshots: out, branchId: branch, schemeId: (scheme as { id?: string } | null)?.id ?? null, assessmentIds: A.map((a) => a.id) };
}

export function remarkFor(snap: Snapshot) {
  const graded = snap.subjects.filter((s) => s.percent !== null).sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0));
  return draftRemark(snap.student.name, snap.overall, snap.attendance.percent, graded[0]?.name, graded[graded.length - 1]?.name);
}
