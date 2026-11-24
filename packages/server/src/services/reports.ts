/**
 * Reports (PRD 8.1 – 8.3). Every dashboard number is computed by counting the rows of the same
 * query that its drill-down list returns, so number and list always match.
 */
import { z } from 'zod';
import { REPORT_DATASETS, addDays, monthKey, toLocal } from '@autoed/shared';
import { ForbiddenError, NotFoundError, ValidationError, insert, maybe, one, q, type Tx } from '../db';
import { need, rank, run, localToday, staffWithRole, branchInfo, now, type Ctx } from '../core';
import { notify } from '../notify';
import { generate } from './ai';
import { coverageFor, planCompliance } from './planning';
import { tableXlsx } from '../exports';

// ---------------------------------------------------------------- drill-down metrics
type Metric = (c: Tx, ctx: Ctx, day: string, branchId: string) => Promise<Record<string, unknown>[]>;

const METRICS: Record<string, { perm: [Parameters<typeof rank>[1], Parameters<typeof rank>[2], number]; fn: Metric }> = {
  staff_present: { perm: ['staff_attendance', 'view', 3], fn: (c, _x, d, b) => q(c, `select s.full_name, sa.check_in_at, sa.status from core.staff_attendance sa join core.staff s on s.id = sa.staff_id where sa.branch_id = $1 and sa.date = $2 and sa.status in ('present','late','half_day') order by s.full_name`, [b, d]) },
  staff_late: { perm: ['staff_attendance', 'view', 3], fn: (c, _x, d, b) => q(c, `select s.full_name, sa.check_in_at, sa.late_minutes from core.staff_attendance sa join core.staff s on s.id = sa.staff_id where sa.branch_id = $1 and sa.date = $2 and sa.status = 'late' order by sa.late_minutes desc`, [b, d]) },
  staff_on_leave: { perm: ['leave', 'view', 3], fn: (c, _x, d, b) => q(c, `select s.full_name, lt.name as leave_type, lr.start_date, lr.end_date from core.leave_requests lr join core.staff s on s.id = lr.staff_id join core.leave_types lt on lt.id = lr.leave_type_id where lr.branch_id = $1 and lr.status = 'approved' and $2::date between lr.start_date and lr.end_date order by s.full_name`, [b, d]) },
  staff_absent: { perm: ['staff_attendance', 'view', 3], fn: (c, _x, d, b) => q(c, `select s.full_name from core.staff s where s.branch_id = $1 and s.status = 'active' and s.deleted_at is null and not exists (select 1 from core.staff_attendance sa where sa.staff_id = s.id and sa.date = $2 and sa.status <> 'absent') and not exists (select 1 from core.leave_requests lr where lr.staff_id = s.id and lr.status = 'approved' and $2::date between lr.start_date and lr.end_date) order by s.full_name`, [b, d]) },
  substitutions_today: { perm: ['substitution', 'view', 3], fn: (c, _x, d, b) => q(c, `select su.period_seq, cl.name || ' ' || se.name as section, a.full_name as absent, s.full_name as substitute, su.status from os.substitutions su join core.sections se on se.id = su.section_id join core.programmes cl on cl.id = se.programme_id join core.staff a on a.id = su.absent_staff_id left join core.staff s on s.id = su.substitute_staff_id where su.branch_id = $1 and su.date = $2 and su.status <> 'cancelled' order by su.period_seq`, [b, d]) },
  substitutions_uncovered: { perm: ['substitution', 'view', 3], fn: (c, _x, d, b) => q(c, `select su.period_seq, cl.name || ' ' || se.name as section, a.full_name as absent from os.substitutions su join core.sections se on se.id = su.section_id join core.programmes cl on cl.id = se.programme_id join core.staff a on a.id = su.absent_staff_id where su.branch_id = $1 and su.date = $2 and su.status in ('uncovered','suggested') order by su.period_seq`, [b, d]) },
  sections_unmarked: { perm: ['student_attendance', 'view', 3], fn: (c, _x, d, b) => q(c, `select cl.name || ' ' || se.name as section, ct.full_name as class_teacher from core.sections se join core.programmes cl on cl.id = se.programme_id left join core.staff ct on ct.id = se.class_teacher_id where se.branch_id = $1 and se.deleted_at is null and not exists (select 1 from core.student_attendance_sessions s where s.section_id = se.id and s.date = $2) order by cl.seq, se.name`, [b, d]) },
  students_absent: { perm: ['student_attendance', 'view', 3], fn: (c, _x, d, b) => q(c, `select st.roll_no, st.full_name, cl.name || ' ' || se.name as section from core.student_attendance_marks m join core.student_attendance_sessions s on s.id = m.session_id join core.students st on st.id = m.student_id join core.sections se on se.id = st.section_id join core.programmes cl on cl.id = se.programme_id where s.branch_id = $1 and s.date = $2 and s.session_key in ('day','am','p1') and m.status = 'absent' order by section, st.roll_no`, [b, d]) },
  tasks_overdue: { perm: ['tasks', 'view', 2], fn: (c, _x, _d, b) => q(c, `select t.id, t.title, o.full_name as owner, t.due_at from os.tasks t left join core.staff o on o.id = t.owner_id where t.branch_id = $1 and t.status in ('todo','in_progress','blocked','reopened') and t.due_at < now() and t.deleted_at is null and not t.is_group_parent order by t.due_at`, [b]) },
  my_tasks_overdue: { perm: ['tasks', 'view', 1], fn: (c, x) => q(c, `select t.id, t.title, t.due_at from os.tasks t where t.owner_id = $1 and t.status in ('todo','in_progress','blocked','reopened') and t.due_at < now() and t.deleted_at is null order by t.due_at`, [x.staffId]) },
  approvals_pending_me: { perm: ['approvals', 'view', 1], fn: (c, x) => q(c, `select r.id, r.title, s.full_name as applicant, r.created_at from core.approval_requests r join core.staff s on s.id = r.applicant_id where $1 = any(r.pending_approver_ids) and r.status = 'pending' order by r.created_at`, [x.staffId]) },
  approvals_pending: { perm: ['approvals', 'view', 5], fn: (c, _x, _d, b) => q(c, `select r.id, r.title, s.full_name as applicant, r.created_at from core.approval_requests r join core.staff s on s.id = r.applicant_id where r.branch_id = $1 and r.status = 'pending' order by r.created_at`, [b]) },
  tickets_critical: { perm: ['helpdesk', 'view', 5], fn: (c, _x, _d, b) => q(c, `select t.id, t.title, t.priority, o.full_name as owner, t.due_at from core.tickets t left join core.staff o on o.id = t.owner_id where t.branch_id = $1 and t.priority in ('high','urgent') and t.status not in ('resolved','closed') order by t.due_at`, [b]) },
  tickets_open: { perm: ['helpdesk', 'view', 5], fn: (c, _x, _d, b) => q(c, `select t.id, t.title, t.status, o.full_name as owner from core.tickets t left join core.staff o on o.id = t.owner_id where t.branch_id = $1 and t.status not in ('resolved','closed') order by t.created_at`, [b]) },
  tickets_by_owner: { perm: ['helpdesk', 'view', 5], fn: (c, _x, _d, b) => q(c, `select coalesce(o.full_name, '—') as owner, count(*)::int as open from core.tickets t left join core.staff o on o.id = t.owner_id where t.branch_id = $1 and t.status not in ('resolved','closed') group by 1 order by open desc`, [b]) },
  compliance_expiring: { perm: ['compliance', 'view', 5], fn: (c, _x, d, b) => q(c, `select name, category, expires_on, status from os.compliance_items where branch_id = $1 and deleted_at is null and (expires_on is null or expires_on <= $2::date + 60) order by expires_on nulls first`, [b, d]) },
  plans_awaiting_review: { perm: ['lesson_planner', 'approve', 2], fn: (c, _x, _d, b) => q(c, `select lp.id, s.full_name as teacher, sb.name as subject, lp.plan_date, lp.status from os.lesson_plans lp join core.staff s on s.id = lp.staff_id join core.subjects sb on sb.id = lp.subject_id where lp.branch_id = $1 and lp.status in ('submitted','in_review') order by lp.submitted_at`, [b]) },
  my_plans_pending: { perm: ['lesson_planner', 'view', 1], fn: (c, x) => q(c, `select lp.id, sb.name as subject, lp.plan_date, lp.status, lp.due_at from os.lesson_plans lp join core.subjects sb on sb.id = lp.subject_id where lp.staff_id = $1 and lp.status in ('draft','returned') and lp.deleted_at is null order by lp.plan_date`, [x.staffId]) },
  class_logs_missing: { perm: ['class_log', 'view', 2], fn: async (c, _x, d, b) => q(c, `select s.full_name as teacher, e.period_seq, cl.name || ' ' || se.name as section from core.timetable_entries e join core.timetable_versions v on v.id = e.version_id and v.status = 'published' join core.staff s on s.id = e.staff_id join core.sections se on se.id = e.section_id join core.programmes cl on cl.id = se.programme_id where v.branch_id = $1 and e.day = extract(isodow from $2::date) and not exists (select 1 from os.class_logs l where l.section_id = e.section_id and l.date = $2 and l.period_seq = e.period_seq) and v.id = (select id from core.timetable_versions where branch_id = $1 and status = 'published' and (effective_from is null or effective_from <= $2) order by effective_from desc nulls last limit 1) order by s.full_name, e.period_seq`, [b, d]) },
  my_logs_missing: { perm: ['class_log', 'view', 1], fn: async (c, x, d, b) => q(c, `select e.period_seq, cl.name || ' ' || se.name as section from core.timetable_entries e join core.sections se on se.id = e.section_id join core.programmes cl on cl.id = se.programme_id where e.staff_id = $3 and e.version_id = (select id from core.timetable_versions where branch_id = $1 and status = 'published' and (effective_from is null or effective_from <= $2) order by effective_from desc nulls last limit 1) and e.day = extract(isodow from $2::date) and not exists (select 1 from os.class_logs l where l.section_id = e.section_id and l.date = $2 and l.period_seq = e.period_seq) order by e.period_seq`, [b, d, x.staffId]) },
  observations_due: { perm: ['observation', 'create', 2], fn: (c, x, d) => q(c, `select o.id, t.full_name as teacher, o.scheduled_at from os.observations o join core.staff t on t.id = o.teacher_id where o.observer_id = $1 and o.status = 'scheduled' and o.scheduled_at::date <= $2::date + 7 order by o.scheduled_at`, [x.staffId, d]) },
  papers_in_review: { perm: ['question_papers', 'view', 1], fn: (c) => q(c, `select qp.id, sb.name as subject, cl.name as class, qp.status from os.question_papers qp left join core.subjects sb on sb.id = qp.subject_id left join core.programmes cl on cl.id = qp.programme_id where qp.status in ('hod_review','coordinator_review') order by qp.created_at`) },
  coverage_at_risk: { perm: ['syllabus_coverage', 'view', 2], fn: async (c, x, d, b) => (await coverageFor(c, b, d, rank(x, 'syllabus_coverage', 'view') <= 1 ? { staffId: x.staffId } : {})).filter((r) => r.status === 'at_risk' || r.status === 'critical').map((r) => ({ section: r.section, subject: r.subject, teacher: r.staff_name, behind: -(r.periods_ahead ?? 0), status: r.status })) },
  regularisations_pending: { perm: ['staff_attendance', 'view', 5], fn: (c, _x, _d, b) => q(c, `select r.id, r.title, s.full_name from core.approval_requests r join core.approval_types t on t.id = r.approval_type_id join core.staff s on s.id = r.applicant_id where r.branch_id = $1 and t.key = 'regularisation' and r.status = 'pending'`, [b]) },
  checklists_missed: { perm: ['checklists', 'view', 2], fn: (c, _x, d, b) => q(c, `select t.name, r.run_date, s.full_name as owner from os.checklist_runs r join os.checklist_templates t on t.id = r.template_id left join core.staff s on s.id = r.owner_id where r.branch_id = $1 and r.status = 'missed' and r.run_date >= $2::date - 7 order by r.run_date desc`, [b, d]) },
  department_tasks_open: { perm: ['tasks', 'view', 3], fn: (c, x, _d, b) => q(c, `select t.id, t.title, o.full_name as owner, t.status, t.due_at from os.tasks t left join core.staff o on o.id = t.owner_id where t.branch_id = $1 and t.department_id = $2 and t.status in ('todo','in_progress','blocked','reopened') order by t.due_at nulls last`, [b, x.staff.department_id]) },
};

function allowed(ctx: Ctx, key: string): boolean {
  const m = METRICS[key];
  if (!m) return false;
  const [mod, act, min] = m.perm;
  return rank(ctx, mod, act) >= min;
}

export async function drill(ctx: Ctx, key: string, branchId?: string) {
  if (!METRICS[key]) throw new NotFoundError('metric');
  if (!allowed(ctx, key)) throw new ForbiddenError();
  return run(ctx, async (c) => {
    const b = branchId && ctx.branchIds.includes(branchId) ? branchId : ctx.branchId;
    return { key, rows: await METRICS[key]!.fn(c, ctx, localToday(ctx), b) };
  });
}

async function metricSet(c: Tx, ctx: Ctx, keys: string[], branchId: string) {
  const day = localToday(ctx);
  const out: { key: string; value: number }[] = [];
  for (const k of keys) if (allowed(ctx, k)) out.push({ key: k, value: (await METRICS[k]!.fn(c, ctx, day, branchId)).length });
  return out;
}

/** Dashboards by role (PRD 8.1). The role is inferred from the user's widest permissions. */
export async function dashboard(ctx: Ctx) {
  return run(ctx, async (c) => {
    const day = localToday(ctx);
    const group = rank(ctx, 'reports', 'view') >= 6;
    const principal = rank(ctx, 'staff_attendance', 'view') >= 5 && rank(ctx, 'approvals', 'approve') >= 5;
    const coordinator = rank(ctx, 'lesson_planner', 'approve') >= 4;
    const hod = rank(ctx, 'lesson_planner', 'approve') === 3;
    const admin = rank(ctx, 'staff_attendance', 'configure') >= 5 && !principal;
    const sections: { key: string; metrics: { key: string; value: number }[]; extra?: unknown }[] = [];
    if (group) {
      const comparison = [];
      for (const b of ctx.branchIds) {
        const info = await one<{ name: string }>(c, `select name from core.branches where id = $1`, [b]);
        const staffTotal = (await one<{ n: number }>(c, `select count(*)::int as n from core.staff where branch_id = $1 and status = 'active' and deleted_at is null`, [b])).n;
        const present = (await METRICS.staff_present!.fn(c, ctx, day, b)).length;
        const ontime = await one<{ done: number; on_time: number }>(c, `select count(*) filter (where status in ('done','verified') and due_at is not null)::int as done, count(*) filter (where status in ('done','verified') and due_at is not null and completed_at <= due_at)::int as on_time from os.tasks where branch_id = $1 and completed_at > now() - interval '30 days'`, [b]);
        const cov = (await coverageFor(c, b, day)).filter((r) => r.pct_covered != null);
        const plans = (await planCompliance(c, b, addDays(day, -30), day)) as { on_time: number; late: number; missing: number }[];
        const planTotal = plans.reduce((s, p) => s + p.on_time + p.late + p.missing, 0);
        const comp = await q<{ status: string }>(c, `select status from os.compliance_items where branch_id = $1 and deleted_at is null`, [b]);
        comparison.push({
          branch_id: b,
          branch: info.name,
          staff_attendance_pct: staffTotal ? Math.round((present / staffTotal) * 100) : null,
          task_on_time_pct: ontime.done ? Math.round((ontime.on_time / ontime.done) * 100) : null,
          coverage_on_track_pct: cov.length ? Math.round((cov.filter((r) => r.status === 'on_track').length / cov.length) * 100) : null,
          plan_compliance_pct: planTotal ? Math.round((plans.reduce((s, p) => s + p.on_time, 0) / planTotal) * 100) : null,
          open_tickets: (await METRICS.tickets_open!.fn(c, ctx, day, b)).length,
          compliance_readiness_pct: comp.length ? Math.round((comp.filter((x) => x.status === 'valid' || x.status === 'expiring').length / comp.length) * 100) : 100,
        });
      }
      const exceptions = [];
      for (const b of ctx.branchIds) {
        for (const m of await metricSet(c, ctx, ['substitutions_uncovered', 'tickets_critical', 'compliance_expiring', 'coverage_at_risk'], b)) if (m.value) exceptions.push({ branch_id: b, ...m });
      }
      sections.push({ key: 'group', metrics: [], extra: { comparison, exceptions } });
    }
    if (principal) sections.push({ key: 'principal', metrics: await metricSet(c, ctx, ['staff_present', 'staff_late', 'staff_on_leave', 'staff_absent', 'substitutions_today', 'substitutions_uncovered', 'sections_unmarked', 'students_absent', 'tasks_overdue', 'approvals_pending', 'tickets_critical', 'compliance_expiring'], ctx.branchId) });
    if (coordinator) sections.push({ key: 'coordinator', metrics: await metricSet(c, ctx, ['plans_awaiting_review', 'coverage_at_risk', 'class_logs_missing', 'observations_due', 'substitutions_uncovered'], ctx.branchId) });
    if (hod) sections.push({ key: 'hod', metrics: await metricSet(c, ctx, ['coverage_at_risk', 'papers_in_review', 'department_tasks_open', 'plans_awaiting_review'], ctx.branchId) });
    if (admin) sections.push({ key: 'admin', metrics: await metricSet(c, ctx, ['staff_late', 'staff_absent', 'regularisations_pending', 'tickets_open', 'checklists_missed'], ctx.branchId), extra: { tickets_by_owner: await METRICS.tickets_by_owner!.fn(c, ctx, day, ctx.branchId) } });
    // Teacher (everyone gets the personal panel)
    const mine = await one<{ done: number; on_time: number }>(c, `select count(*) filter (where status in ('done','verified') and due_at is not null)::int as done, count(*) filter (where status in ('done','verified') and due_at is not null and completed_at <= due_at)::int as on_time from os.tasks where owner_id = $1 and completed_at > now() - interval '30 days'`, [ctx.staffId]);
    const myCov = ctx.staff.is_teaching ? (await coverageFor(c, ctx.branchId, day, { staffId: ctx.staffId })).filter((r) => r.pct_covered != null) : [];
    sections.push({
      key: 'me',
      metrics: await metricSet(c, ctx, ['my_tasks_overdue', 'approvals_pending_me', 'my_plans_pending', 'my_logs_missing'], ctx.branchId),
      extra: { on_time_pct: mine.done ? Math.round((mine.on_time / mine.done) * 100) : null, coverage: myCov.map((r) => ({ section: r.section, subject: r.subject, pct: r.pct_covered, status: r.status })) },
    });
    return { date: day, sections };
  });
}

// ---------------------------------------------------------------- report catalogue (8.2)
export interface ReportFilters {
  from: string;
  to: string;
  branch_id?: string | null;
  wing_id?: string | null;
  department_id?: string | null;
  staff_id?: string | null;
}

type ReportFn = (c: Tx, ctx: Ctx, f: ReportFilters, branchId: string) => Promise<{ columns: { key: string; header: string }[]; rows: Record<string, unknown>[]; chart?: { type: 'bar' | 'line' | 'pie'; x: string; y: string } }>;

const staffFilter = `($4::uuid is null or s.wing_id = $4) and ($5::uuid is null or s.department_id = $5) and ($6::uuid is null or s.id = $6)`;
const P = (f: ReportFilters, b: string) => [b, f.from, f.to, f.wing_id ?? null, f.department_id ?? null, f.staff_id ?? null];
const cols = (...xs: [string, string][]) => xs.map(([key, header]) => ({ key, header }));

export const CATALOGUE: Record<string, { perm: [Parameters<typeof rank>[1], number]; fn: ReportFn }> = {
  task_performance: {
    perm: ['tasks', 2],
    fn: async (c, _x, f, b) => ({
      columns: cols(['name', 'Person'], ['department', 'Department'], ['assigned', 'Assigned'], ['completed', 'Completed'], ['completion_pct', 'Completion %'], ['on_time_pct', 'On-time %'], ['overdue', 'Overdue now'], ['unplanned_pct', 'Unplanned %'], ['not_done', 'Not done']),
      rows: await q(c, `select s.full_name as name, d.name as department, count(t.id)::int as assigned,
          count(t.id) filter (where (t.verification_required and t.status = 'verified') or (not t.verification_required and t.status in ('done','verified')))::int as completed,
          round(100.0 * count(t.id) filter (where (t.verification_required and t.status = 'verified') or (not t.verification_required and t.status in ('done','verified'))) / nullif(count(t.id), 0), 1) as completion_pct,
          round(100.0 * count(t.id) filter (where t.status in ('done','verified') and t.completed_at <= t.due_at) / nullif(count(t.id) filter (where t.status in ('done','verified') and t.due_at is not null), 0), 1) as on_time_pct,
          count(t.id) filter (where t.status in ('todo','in_progress','blocked','reopened') and t.due_at < now())::int as overdue,
          round(100.0 * count(t.id) filter (where t.unplanned) / nullif(count(t.id), 0), 1) as unplanned_pct,
          count(t.id) filter (where t.status = 'not_done')::int as not_done
        from core.staff s left join core.departments d on d.id = s.department_id
        left join os.tasks t on t.owner_id = s.id and not t.is_group_parent and t.created_at::date between $2 and $3 and t.deleted_at is null
        where s.branch_id = $1 and s.deleted_at is null and ${staffFilter} group by s.full_name, d.name order by overdue desc, s.full_name`, P(f, b)),
      chart: { type: 'bar', x: 'name', y: 'on_time_pct' },
    }),
  },
  task_not_done_reasons: {
    perm: ['tasks', 2],
    fn: async (c, _x, f, b) => ({ columns: cols(['reason', 'Reason'], ['count', 'Count']), rows: await q(c, `select coalesce(not_done_reason, 'none') as reason, count(*)::int as count from os.tasks t join core.staff s on s.id = t.owner_id where t.branch_id = $1 and t.status = 'not_done' and t.updated_at::date between $2 and $3 and ${staffFilter} group by 1 order by count desc`, P(f, b)), chart: { type: 'pie', x: 'reason', y: 'count' } }),
  },
  workload: {
    perm: ['staff', 3],
    fn: async (c, _x, f, b) => ({
      columns: cols(['name', 'Staff'], ['teaching_periods', 'Teaching periods / week'], ['substitutions', 'Substitutions'], ['duties', 'Duties'], ['tasks', 'Tasks'], ['meetings', 'Meetings']),
      rows: await q(c, `select s.full_name as name,
          (select count(*)::int from core.timetable_entries e join core.timetable_versions v on v.id = e.version_id and v.status = 'published' where e.staff_id = s.id) as teaching_periods,
          (select count(*)::int from os.substitutions su where su.substitute_staff_id = s.id and su.status = 'assigned' and su.date between $2 and $3) as substitutions,
          (select count(*)::int from os.duty_assignments da where da.staff_id = s.id and da.date between $2 and $3) as duties,
          (select count(*)::int from os.tasks t where t.owner_id = s.id and t.created_at::date between $2 and $3) as tasks,
          (select count(*)::int from os.meetings m where s.id = any(m.attendee_ids) and m.starts_at::date between $2 and $3) as meetings
        from core.staff s where s.branch_id = $1 and s.status = 'active' and s.deleted_at is null and ${staffFilter} order by teaching_periods desc`, P(f, b)),
    }),
  },
  plan_compliance: { perm: ['lesson_planner', 2], fn: async (c, _x, f, b) => ({ columns: cols(['full_name', 'Teacher'], ['wing', 'Wing'], ['on_time', 'On time'], ['late', 'Late'], ['missing', 'Missing'], ['returned', 'Returned'], ['review_hours', 'Review hours (avg)']), rows: await planCompliance(c, b, f.from, f.to), chart: { type: 'bar', x: 'full_name', y: 'missing' } }) },
  syllabus_coverage: { perm: ['syllabus_coverage', 2], fn: async (c, x, _f, b) => ({ columns: cols(['section', 'Section'], ['subject', 'Subject'], ['staff_name', 'Teacher'], ['pct_covered', '% covered'], ['periods_ahead', 'Periods ahead (−behind)'], ['status', 'Status'], ['projected_completion', 'Projected completion'], ['next_exam', 'Next exam'], ['days_late_for_exam', 'Days late for exam']), rows: await coverageFor(c, b, localToday(x)), chart: { type: 'bar', x: 'section', y: 'pct_covered' } }) },
  class_log: {
    perm: ['class_log', 2],
    fn: async (c, _x, f, b) => ({
      columns: cols(['section', 'Section'], ['logs', 'Periods logged'], ['as_planned_pct', 'Taught as planned %'], ['homework_minutes', 'Homework minutes'], ['notebook_cycles', 'Notebook cycles']),
      rows: await q(c, `select cl.name || ' ' || se.name as section, count(l.id)::int as logs, round(100.0 * count(l.id) filter (where l.taught_as_planned) / nullif(count(l.id), 0), 1) as as_planned_pct,
          (select coalesce(sum(h.est_minutes), 0)::int from public.homework h where h.section_id = se.id and h.assigned_on between $2 and $3) as homework_minutes,
          (select count(*)::int from os.notebook_checks n where n.section_id = se.id and n.kind = 'cycle' and n.checked_on between $2 and $3) as notebook_cycles
        from core.sections se join core.programmes cl on cl.id = se.programme_id left join os.class_logs l on l.section_id = se.id and l.date between $2 and $3 where se.branch_id = $1 group by se.id, cl.name, se.name, cl.seq order by cl.seq, se.name`, [b, f.from, f.to]),
    }),
  },
  substitution: { perm: ['substitution', 3], fn: async (c, _x, f, b) => ({ columns: cols(['full_name', 'Teacher'], ['substitutions', 'Substitutions taken']), rows: await q(c, `select s.full_name, count(su.id)::int as substitutions from core.staff s left join os.substitutions su on su.substitute_staff_id = s.id and su.status = 'assigned' and su.date between $2 and $3 where s.branch_id = $1 and s.is_teaching and s.deleted_at is null and ${staffFilter} group by s.full_name order by substitutions desc`, P(f, b)), chart: { type: 'bar', x: 'full_name', y: 'substitutions' } }) },
  staff_attendance: {
    perm: ['staff_attendance', 3],
    fn: async (c, _x, f, b) => ({
      columns: cols(['full_name', 'Staff'], ['present', 'Present'], ['late', 'Late'], ['half_day', 'Half days'], ['absent', 'Absent'], ['avg_late_minutes', 'Avg late (min)']),
      rows: await q(c, `select s.full_name, count(sa.id) filter (where sa.status = 'present')::int as present, count(sa.id) filter (where sa.status = 'late')::int as late, count(sa.id) filter (where sa.status = 'half_day')::int as half_day, count(sa.id) filter (where sa.status = 'absent')::int as absent, round(avg(sa.late_minutes) filter (where sa.late_minutes > 0)::numeric, 0) as avg_late_minutes from core.staff s left join core.staff_attendance sa on sa.staff_id = s.id and sa.date between $2 and $3 where s.branch_id = $1 and s.deleted_at is null and ${staffFilter} group by s.full_name order by late desc`, P(f, b)),
      chart: { type: 'bar', x: 'full_name', y: 'late' },
    }),
  },
  absence_by_weekday: { perm: ['staff_attendance', 3], fn: async (c, _x, f, b) => ({ columns: cols(['weekday', 'Weekday'], ['absences', 'Absences'], ['late', 'Late arrivals']), rows: await q(c, `select to_char(date, 'Dy') as weekday, extract(isodow from date)::int as d, count(*) filter (where status = 'absent')::int as absences, count(*) filter (where status = 'late')::int as late from core.staff_attendance where branch_id = $1 and date between $2 and $3 group by 1, 2 order by 2`, [b, f.from, f.to]), chart: { type: 'bar', x: 'weekday', y: 'absences' } }) },
  leave_use: { perm: ['leave', 3], fn: async (c, _x, f, b) => ({ columns: cols(['leave_type', 'Leave type'], ['days', 'Days'], ['requests', 'Requests']), rows: await q(c, `select lt.name as leave_type, coalesce(sum(lr.days), 0) as days, count(*)::int as requests from core.leave_requests lr join core.leave_types lt on lt.id = lr.leave_type_id join core.staff s on s.id = lr.staff_id where lr.branch_id = $1 and lr.status = 'approved' and lr.start_date between $2 and $3 and ${staffFilter} group by 1 order by days desc`, P(f, b)), chart: { type: 'pie', x: 'leave_type', y: 'days' } }) },
  student_attendance: { perm: ['student_attendance', 3], fn: async (c, _x, f, b) => ({ columns: cols(['section', 'Section'], ['sessions', 'Days marked'], ['attendance_pct', 'Attendance %']), rows: await q(c, `select cl.name || ' ' || se.name as section, count(distinct s.id)::int as sessions, round(100.0 * count(m.id) filter (where m.status in ('present','late','on_duty')) / nullif(count(m.id), 0), 1) as attendance_pct from core.sections se join core.programmes cl on cl.id = se.programme_id left join core.student_attendance_sessions s on s.section_id = se.id and s.date between $2 and $3 left join core.student_attendance_marks m on m.session_id = s.id where se.branch_id = $1 group by se.id, cl.name, se.name, cl.seq order by cl.seq, se.name`, [b, f.from, f.to]), chart: { type: 'line', x: 'section', y: 'attendance_pct' } }) },
  observation: { perm: ['observation', 3], fn: async (c, _x, f, b) => ({ columns: cols(['teacher', 'Teacher'], ['observations', 'Observations'], ['avg_score', 'Average %'], ['latest', 'Latest']), rows: await q(c, `select t.full_name as teacher, count(o.id)::int as observations, round(avg(o.overall)::numeric, 1) as avg_score, max(o.scheduled_at)::date as latest from os.observations o join core.staff t on t.id = o.teacher_id where o.branch_id = $1 and o.scheduled_at::date between $2 and $3 and o.overall is not null group by t.full_name order by avg_score desc`, [b, f.from, f.to]) }) },
  helpdesk: { perm: ['helpdesk', 5], fn: async (c, _x, f, b) => ({ columns: cols(['category', 'Category'], ['tickets', 'Tickets'], ['avg_hours', 'Avg hours to resolve'], ['breaches', 'SLA breaches'], ['cost', 'Cost (₹)']), rows: await q(c, `select tc.name as category, count(*)::int as tickets, round(avg(extract(epoch from (t.resolved_at - t.created_at)) / 3600) filter (where t.resolved_at is not null)::numeric, 1) as avg_hours, count(*) filter (where t.due_at < coalesce(t.resolved_at, now()))::int as breaches, coalesce(sum(t.cost), 0) as cost from core.tickets t join core.ticket_categories tc on tc.id = t.category_id where t.branch_id = $1 and t.created_at::date between $2 and $3 group by 1 order by tickets desc`, [b, f.from, f.to]), chart: { type: 'bar', x: 'category', y: 'tickets' } }) },
  checklists: { perm: ['checklists', 2], fn: async (c, _x, f, b) => ({ columns: cols(['name', 'Checklist'], ['runs', 'Runs'], ['completed', 'Completed'], ['missed', 'Missed'], ['failed_items', 'Failed items']), rows: await q(c, `select t.name, count(r.id)::int as runs, count(r.id) filter (where r.status = 'completed')::int as completed, count(r.id) filter (where r.status = 'missed')::int as missed, (select count(*)::int from os.checklist_responses x join os.checklist_runs rr on rr.id = x.run_id where rr.template_id = t.id and not x.passed and rr.run_date between $2 and $3) as failed_items from os.checklist_templates t left join os.checklist_runs r on r.template_id = t.id and r.run_date between $2 and $3 where t.branch_id = $1 and t.deleted_at is null group by t.id, t.name order by missed desc`, [b, f.from, f.to]) }) },
  approvals: { perm: ['approvals', 5], fn: async (c, _x, f, b) => ({ columns: cols(['type', 'Type'], ['requests', 'Requests'], ['pending', 'Pending'], ['avg_hours', 'Avg turnaround (h)'], ['oldest_pending_hours', 'Oldest pending (h)']), rows: await q(c, `select t.name as type, count(*)::int as requests, count(*) filter (where r.status = 'pending')::int as pending, round(avg(extract(epoch from (r.decided_at - r.created_at)) / 3600) filter (where r.decided_at is not null)::numeric, 1) as avg_hours, round(max(extract(epoch from (now() - r.created_at)) / 3600) filter (where r.status = 'pending')::numeric, 0) as oldest_pending_hours from core.approval_requests r join core.approval_types t on t.id = r.approval_type_id where r.branch_id = $1 and r.created_at::date between $2 and $3 group by 1 order by requests desc`, [b, f.from, f.to]) }) },
  compliance: { perm: ['compliance', 5], fn: async (c, x, _f, b) => ({ columns: cols(['name', 'Item'], ['category', 'Category'], ['expires_on', 'Expires'], ['status', 'Status'], ['owner', 'Owner']), rows: await q(c, `select ci.name, ci.category, ci.expires_on, ci.status, s.full_name as owner from os.compliance_items ci left join core.staff s on s.id = ci.owner_id where ci.branch_id = $1 and ci.deleted_at is null order by ci.expires_on nulls first`, [b]).then((rows) => (void x, rows)) }) },
  ai_usage: { perm: ['ai', 3], fn: async (c, _x, f, b) => ({ columns: cols(['action', 'Module / action'], ['teacher', 'Teacher'], ['credits', 'Credits'], ['uses', 'Uses']), rows: await q(c, `select l.action, coalesce(s.full_name, 'System') as teacher, -sum(l.credits) as credits, count(*)::int as uses from public.ai_credit_ledger l left join core.staff s on s.id = l.staff_id where l.branch_id = $1 and l.kind = 'usage' and l.created_at::date between $2 and $3 group by 1, 2 order by credits desc`, [b, f.from, f.to]) }) },
};

export async function runReport(ctx: Ctx, key: string, f: ReportFilters) {
  const def = CATALOGUE[key];
  if (!def) throw new NotFoundError('report');
  const [mod, min] = def.perm;
  if (rank(ctx, mod, 'view') < min && !(key === 'daily_digest')) throw new ForbiddenError();
  return run(ctx, async (c) => {
    const b = f.branch_id && ctx.branchIds.includes(f.branch_id) ? f.branch_id : ctx.branchId;
    return { key, filters: f, ...(await def.fn(c, ctx, f, b)) };
  });
}

export async function exportReport(ctx: Ctx, key: string, f: ReportFilters): Promise<{ filename: string; buffer: Buffer }> {
  const r = await runReport(ctx, key, f);
  const org = await run(ctx, (c) => one<{ name: string; branding: Record<string, string> }>(c, `select name, branding from core.organizations where id = $1`, [ctx.orgId]));
  return { filename: `${key}-${f.from}-${f.to}.xlsx`, buffer: await tableXlsx(`${key} ${f.from} – ${f.to}`, org, r.columns, r.rows) };
}

export function catalogueFor(ctx: Ctx) {
  return Object.entries(CATALOGUE)
    .filter(([, d]) => rank(ctx, d.perm[0], 'view') >= d.perm[1])
    .map(([key]) => key);
}

// ---------------------------------------------------------------- daily digest
export async function digestFor(c: Tx, ctx: Ctx, branchId: string) {
  const day = localToday(ctx);
  const keys = ['staff_present', 'staff_late', 'staff_on_leave', 'staff_absent', 'substitutions_today', 'substitutions_uncovered', 'sections_unmarked', 'tasks_overdue', 'checklists_missed', 'tickets_open', 'approvals_pending', 'plans_awaiting_review'];
  const metrics: Record<string, number> = {};
  for (const k of keys) metrics[k] = (await METRICS[k]!.fn(c, ctx, day, branchId)).length;
  return { date: day, branch_id: branchId, metrics };
}

export async function digest(ctx: Ctx) {
  need(ctx, 'reports', 'view', 5);
  return run(ctx, async (c) => digestFor(c, ctx, ctx.branchId));
}

/** Sent automatically at the branch's digest time to the principal and management. */
export async function sendDigest(c: Tx, branchId: string): Promise<number> {
  const b = await branchInfo(c, branchId);
  const recipients = [...(await staffWithRole(c, b.org_id, 'principal', branchId)), ...(await staffWithRole(c, b.org_id, 'vice_principal', branchId)), ...(await q<{ id: string }>(c, `select s.id from core.staff s join os.staff_roles sr on sr.staff_id = s.id join os.roles r on r.id = sr.role_id where s.org_id = $1 and s.branch_id is null and r.key in ('chairman','director')`, [b.org_id])).map((r) => r.id)];
  const anyone = recipients[0];
  if (!anyone) return 0;
  const sysCtx = { staffId: anyone, now: now(), staff: { department_id: null } } as unknown as Ctx;
  const d = await digestFor(c, sysCtx, branchId);
  const m = d.metrics;
  await notify(c, {
    orgId: b.org_id,
    branchId,
    staffIds: recipients,
    event: 'digest.daily',
    titleKey: 'notif.digest.title',
    bodyKey: 'notif.digest.body',
    vars: { branch: b.name, present: m.staff_present ?? 0, late: m.staff_late ?? 0, leave: m.staff_on_leave ?? 0, subs: m.substitutions_today ?? 0, uncovered: m.substitutions_uncovered ?? 0, unmarked: m.sections_unmarked ?? 0, overdue: m.tasks_overdue ?? 0, missed: m.checklists_missed ?? 0, tickets: m.tickets_open ?? 0, approvals: m.approvals_pending ?? 0, plans: m.plans_awaiting_review ?? 0 },
    link: `/os/reports/digest?branch=${branchId}`,
    dedupeKey: `digest:${branchId}:${d.date}`,
    data: d,
  });
  return recipients.length;
}

// ---------------------------------------------------------------- report builder (8.3)
const DATASETS: Record<(typeof REPORT_DATASETS)[number], { from: string; columns: Record<string, string>; branchCol: string; dateCol: string }> = {
  tasks: { from: `os.tasks t left join core.staff s on s.id = t.owner_id left join core.departments d on d.id = t.department_id left join os.task_categories tc on tc.id = t.category_id`, branchCol: 't.branch_id', dateCol: 't.created_at', columns: { title: 't.title', status: 't.status', priority: 't.priority', owner: 's.full_name', department: 'd.name', category: 'tc.name', source: 't.source', due_at: 't.due_at', overdue: `(t.due_at < now() and t.status in ('todo','in_progress','blocked','reopened'))`, unplanned: 't.unplanned' } },
  staff_attendance: { from: `core.staff_attendance a join core.staff s on s.id = a.staff_id left join core.departments d on d.id = s.department_id`, branchCol: 'a.branch_id', dateCol: 'a.date', columns: { staff: 's.full_name', department: 'd.name', date: 'a.date', status: 'a.status', late_minutes: 'a.late_minutes', source: 'a.source' } },
  student_attendance: { from: `core.student_attendance_marks m join core.student_attendance_sessions x on x.id = m.session_id join core.sections se on se.id = x.section_id join core.programmes cl on cl.id = se.programme_id`, branchCol: 'x.branch_id', dateCol: 'x.date', columns: { section: `cl.name || ' ' || se.name`, class: 'cl.name', date: 'x.date', status: 'm.status' } },
  lesson_plans: { from: `os.lesson_plans lp join core.staff s on s.id = lp.staff_id join core.subjects sb on sb.id = lp.subject_id`, branchCol: 'lp.branch_id', dateCol: 'lp.created_at', columns: { teacher: 's.full_name', subject: 'sb.name', status: 'lp.status', level: 'lp.level', plan_date: 'lp.plan_date', late: '(lp.submitted_at > lp.due_at)' } },
  tickets: { from: `core.tickets t join core.ticket_categories tc on tc.id = t.category_id left join core.staff o on o.id = t.owner_id left join core.rooms r on r.id = t.room_id`, branchCol: 't.branch_id', dateCol: 't.created_at', columns: { title: 't.title', category: 'tc.name', status: 't.status', priority: 't.priority', owner: 'o.full_name', room: 'r.name', cost: 't.cost' } },
  leave: { from: `core.leave_requests lr join core.staff s on s.id = lr.staff_id join core.leave_types lt on lt.id = lr.leave_type_id left join core.departments d on d.id = s.department_id`, branchCol: 'lr.branch_id', dateCol: 'lr.start_date', columns: { staff: 's.full_name', department: 'd.name', leave_type: 'lt.name', status: 'lr.status', days: 'lr.days', start_date: 'lr.start_date' } },
  substitutions: { from: `os.substitutions su join core.staff a on a.id = su.absent_staff_id left join core.staff s on s.id = su.substitute_staff_id`, branchCol: 'su.branch_id', dateCol: 'su.date', columns: { date: 'su.date', absent: 'a.full_name', substitute: 's.full_name', status: 'su.status', resolution: 'su.resolution' } },
  checklists: { from: `os.checklist_runs r join os.checklist_templates t on t.id = r.template_id left join core.staff s on s.id = r.owner_id`, branchCol: 'r.branch_id', dateCol: 'r.run_date', columns: { checklist: 't.name', owner: 's.full_name', status: 'r.status', run_date: 'r.run_date' } },
  approvals: { from: `core.approval_requests r join core.approval_types t on t.id = r.approval_type_id join core.staff s on s.id = r.applicant_id`, branchCol: 'r.branch_id', dateCol: 'r.created_at', columns: { type: 't.name', applicant: 's.full_name', status: 'r.status', title: 'r.title' } },
};

export const BUILDER_DATASETS = Object.fromEntries(Object.entries(DATASETS).map(([k, v]) => [k, Object.keys(v.columns)]));

/** Runs a builder config as the user (RLS applies). Columns and filters are whitelisted. */
export async function runBuilder(ctx: Ctx, config: { dataset: string; columns: string[]; filters: { column: string; op: string; value: unknown }[]; group_by?: string | null; chart?: string }, range: { from: string; to: string }) {
  need(ctx, 'reports', 'view');
  const ds = DATASETS[config.dataset as keyof typeof DATASETS];
  if (!ds) throw new ValidationError('unknown_dataset');
  for (const col of [...config.columns, ...config.filters.map((f) => f.column), ...(config.group_by ? [config.group_by] : [])]) if (col !== 'count' && !ds.columns[col]) throw new ValidationError('unknown_column', { column: col });
  return run(ctx, async (c) => {
    const params: unknown[] = [ctx.branchId, range.from, range.to];
    const where = [`${ds.branchCol} = $1`, `${ds.dateCol}::date between $2 and $3`];
    for (const f of config.filters) {
      const expr = ds.columns[f.column]!;
      if (f.op === 'in') {
        params.push(Array.isArray(f.value) ? f.value.map(String) : [String(f.value)]);
        where.push(`(${expr})::text = any($${params.length})`);
      } else {
        if (!['=', '!=', '>', '<'].includes(f.op)) throw new ValidationError('bad_operator');
        params.push(String(f.value));
        where.push(`(${expr})::text ${f.op} $${params.length}`);
      }
    }
    let sql: string;
    if (config.group_by) sql = `select ${ds.columns[config.group_by]} as "${config.group_by}", count(*)::int as count from ${ds.from} where ${where.join(' and ')} group by 1 order by count desc limit 500`;
    else sql = `select ${config.columns.filter((x) => x !== 'count').map((col) => `${ds.columns[col]} as "${col}"`).join(', ')} from ${ds.from} where ${where.join(' and ')} limit 2000`;
    const rows = await q(c, sql, params);
    const columns = config.group_by ? [config.group_by, 'count'] : config.columns.filter((x) => x !== 'count');
    return { columns: columns.map((k) => ({ key: k, header: k })), rows, chart: config.chart ?? 'table' };
  });
}

export async function savedReports(ctx: Ctx) {
  return run(ctx, async (c) => {
    const roles = (await q<{ role_id: string }>(c, `select role_id from os.staff_roles where staff_id = $1`, [ctx.staffId])).map((r) => r.role_id);
    return q(c, `select sr.*, s.full_name as owner_name from os.saved_reports sr left join core.staff s on s.id = sr.owner_id where sr.org_id = $1 and sr.deleted_at is null and (sr.owner_id = $2 or sr.shared_role_ids && $3::uuid[]) order by sr.created_at desc`, [ctx.orgId, ctx.staffId, roles]);
  });
}

export async function saveReport(ctx: Ctx, input: { name: string; dataset: string; config: Record<string, unknown>; shared_role_ids: string[] }) {
  need(ctx, 'reports', 'create');
  return run(ctx, async (c, sys) => sys(() => insert(c, 'os.saved_reports', { org_id: ctx.orgId, branch_id: ctx.branchId, owner_id: ctx.staffId, name: input.name, dataset: input.dataset, config: { ...input.config, dataset: input.dataset }, shared_role_ids: input.shared_role_ids })));
}

export async function scheduleReport(ctx: Ctx, input: { report_key: string; frequency: string; send_time: string; weekday?: number | null; recipient_ids: string[]; channel: string }) {
  need(ctx, 'reports', 'configure');
  return run(ctx, async (c) => insert(c, 'os.report_schedules', { org_id: ctx.orgId, branch_id: ctx.branchId, ...input, saved_report_id: input.report_key.startsWith('saved:') ? input.report_key.slice(6) : null }));
}

/** Sends due scheduled reports (in-app link, email, or WhatsApp link). */
export async function reportScheduleSweep(c: Tx, at: Date = now()): Promise<number> {
  const rows = await q<{ id: string; org_id: string; branch_id: string; report_key: string; frequency: string; send_time: string; weekday: number | null; recipient_ids: string[]; channel: string; last_run_at: string | null }>(c, `select id, org_id, branch_id, report_key, frequency, send_time::text, weekday, recipient_ids, channel, last_run_at from os.report_schedules where active and deleted_at is null`);
  let n = 0;
  for (const r of rows) {
    const local = toLocal(at, 'Asia/Kolkata');
    const [h, m] = r.send_time.split(':').map(Number);
    if (local.minutes < h! * 60 + m!) continue;
    if (r.last_run_at && toLocal(new Date(r.last_run_at), 'Asia/Kolkata').date === local.date) continue;
    if (r.frequency === 'weekly' && (new Date(`${local.date}T00:00:00Z`).getUTCDay() || 7) !== (r.weekday ?? 1)) continue;
    if (r.frequency === 'monthly' && local.date.slice(8) !== '01') continue;
    const link = r.report_key === 'daily_digest' ? `/os/reports/digest?branch=${r.branch_id}` : `/os/reports/${encodeURIComponent(r.report_key)}`;
    if (r.report_key === 'daily_digest') await sendDigest(c, r.branch_id);
    else if (r.channel === 'email') {
      const { sendEmail } = await import('../adapters/channels');
      const emails = await q<{ email: string | null }>(c, `select email from core.staff where id = any($1)`, [r.recipient_ids]);
      for (const e of emails) if (e.email) await sendEmail(e.email, `AutoEd OS report: ${r.report_key}`, `<p>Your scheduled report is ready: <a href="${process.env.APP_URL ?? ''}${link}">${r.report_key}</a></p>`);
    } else await notify(c, { orgId: r.org_id, branchId: r.branch_id, staffIds: r.recipient_ids, event: r.channel === 'whatsapp_link' ? 'digest.daily' : 'meeting.scheduled', titleKey: 'notif.report.ready', vars: { name: r.report_key }, link, priority: 'low' });
    await c.query(`update os.report_schedules set last_run_at = now() where id = $1`, [r.id]);
    n++;
  }
  return n;
}

// ---------------------------------------------------------------- weekly insight & ask-a-question
/** Facts computed in SQL; the AI only writes them up in plain language. No personal data is sent. */
export async function weeklyInsight(c: Tx, branchId: string): Promise<{ improved: string[]; worsened: string[]; decisions: { text: string; link: string }[] } | null> {
  const b = await branchInfo(c, branchId);
  const today = toLocal(now(), b.timezone).date;
  const facts: { text: string; link: string }[] = [];
  const cov = (await coverageFor(c, branchId, today)).filter((r) => r.status === 'critical' || r.status === 'at_risk').sort((a, x) => (a.periods_ahead ?? 0) - (x.periods_ahead ?? 0));
  for (const r of cov.slice(0, 3)) facts.push({ text: `${r.section} ${r.subject} is ${Math.abs(r.periods_ahead ?? 0)} periods behind${r.days_late_for_exam ? ` and will miss the next exam date by ${r.days_late_for_exam} working days` : ''}.`, link: '/os/coverage' });
  const od = await one<{ now_n: number; prev_n: number }>(c, `select count(*) filter (where due_at between now() - interval '7 days' and now() and status in ('todo','in_progress','blocked','reopened'))::int as now_n, count(*) filter (where due_at between now() - interval '14 days' and now() - interval '7 days' and status = 'not_done')::int as prev_n from os.tasks where branch_id = $1`, [branchId]);
  facts.push({ text: `${od.now_n} tasks went overdue this week (${od.prev_n} were not done last week).`, link: '/os/tasks?status=overdue' });
  const late = await one<{ this_w: number; last_w: number }>(c, `select count(*) filter (where date > current_date - 7 and status = 'late')::int as this_w, count(*) filter (where date between current_date - 14 and current_date - 8 and status = 'late')::int as last_w from core.staff_attendance where branch_id = $1`, [branchId]);
  facts.push({ text: `Late arrivals: ${late.this_w} this week vs ${late.last_w} last week.`, link: '/os/reports/staff_attendance' });
  const tickets = await one<{ n: number }>(c, `select count(*)::int as n from core.tickets where branch_id = $1 and status not in ('resolved','closed') and due_at < now()`, [branchId]);
  if (tickets.n) facts.push({ text: `${tickets.n} maintenance tickets are past their time limit.`, link: '/os/helpdesk' });
  const comp = await one<{ n: number }>(c, `select count(*)::int as n from os.compliance_items where branch_id = $1 and status in ('overdue','missing')`, [branchId]);
  if (comp.n) facts.push({ text: `${comp.n} compliance items are overdue or missing documents.`, link: '/os/compliance' });
  const principal = (await staffWithRole(c, b.org_id, 'principal', branchId))[0];
  const gen = await generate(c, {
    orgId: b.org_id,
    branchId,
    staffId: null,
    action: 'weekly_insight',
    tier: 'strong',
    system: 'You write a short weekly summary for a school principal in plain language: what improved, what worsened, and the five items needing a decision. Use only the facts given.',
    prompt: facts.map((f, i) => `${i + 1}. ${f.text} [link ${f.link}]`).join('\n'),
    jsonSchema: { type: 'object', additionalProperties: false, required: ['improved', 'worsened', 'decisions'], properties: { improved: { type: 'array', items: { type: 'string' } }, worsened: { type: 'array', items: { type: 'string' } }, decisions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['text', 'link'], properties: { text: { type: 'string' }, link: { type: 'string' } } } } } },
    zod: z.object({ improved: z.array(z.string()), worsened: z.array(z.string()), decisions: z.array(z.object({ text: z.string(), link: z.string() })).max(5) }),
    mockContext: { facts },
    logInput: { facts: facts.length, week: today },
  }).catch(() => null);
  if (!gen) return null;
  if (principal) await notify(c, { orgId: b.org_id, branchId, staffIds: [principal], event: 'digest.daily', titleKey: 'notif.insight.ready', link: '/os/reports/insight', dedupeKey: `insight:${branchId}:${today}`, data: gen.output as Record<string, unknown> });
  return gen.output;
}

export async function latestInsight(ctx: Ctx) {
  need(ctx, 'reports', 'view', 5);
  return run(ctx, async (c, sys) => sys(() => maybe(c, `select output, created_at from core.ai_generations where branch_id = $1 and action = 'weekly_insight' and status = 'ok' order by created_at desc limit 1`, [ctx.branchId])));
}

/** Permission-checked query functions the AI may call. They run as the asker (RLS + scope). */
const ASK_FUNCTIONS: Record<string, { label: string; run: (c: Tx, ctx: Ctx) => Promise<Record<string, unknown>[]> }> = {
  overdue_tasks_by_person: { label: 'Overdue tasks by person', run: (c, ctx) => q(c, `select s.full_name as person, count(*)::int as overdue from os.tasks t join core.staff s on s.id = t.owner_id where t.branch_id = $1 and t.status in ('todo','in_progress','blocked','reopened') and t.due_at < now() and t.due_at > date_trunc('month', now()) group by 1 order by overdue desc limit 20`, [ctx.branchId]) },
  leave_by_type: { label: 'Leave taken by type this month', run: (c, ctx) => q(c, `select lt.name as leave_type, coalesce(sum(lr.days), 0) as days from core.leave_requests lr join core.leave_types lt on lt.id = lr.leave_type_id where lr.branch_id = $1 and lr.status = 'approved' and lr.start_date >= date_trunc('month', now()) group by 1 order by days desc`, [ctx.branchId]) },
  late_staff: { label: 'Late arrivals this month', run: (c, ctx) => q(c, `select s.full_name as person, count(*)::int as late_days from core.staff_attendance a join core.staff s on s.id = a.staff_id where a.branch_id = $1 and a.status = 'late' and a.date >= date_trunc('month', now()) group by 1 order by late_days desc limit 20`, [ctx.branchId]) },
  plan_compliance_by_teacher: { label: 'Lesson plan compliance this month', run: async (c, ctx) => (await q<{ staff_id: string; full_name: string; on_time: number; late: number; missing: number }>(c, `select lp.staff_id, s.full_name, count(*) filter (where lp.submitted_at <= lp.due_at or lp.due_at is null)::int as on_time, count(*) filter (where lp.submitted_at > lp.due_at)::int as late, count(*) filter (where lp.submitted_at is null and lp.due_at < now())::int as missing from os.lesson_plans lp join core.staff s on s.id = lp.staff_id where lp.branch_id = $1 and lp.plan_date >= date_trunc('month', now()) group by 1, 2 order by missing desc`, [ctx.branchId])).map(({ staff_id: _s, ...r }) => r) },
  open_tickets_by_category: { label: 'Open tickets by category', run: (c, ctx) => q(c, `select tc.name as category, count(*)::int as open from core.tickets t join core.ticket_categories tc on tc.id = t.category_id where t.branch_id = $1 and t.status not in ('resolved','closed') group by 1 order by open desc`, [ctx.branchId]) },
  coverage_by_class: {
    label: 'Syllabus coverage by class',
    run: async (c, ctx) => {
      const r = rank(ctx, 'syllabus_coverage', 'view');
      const rows = await coverageFor(c, ctx.branchId, localToday(ctx), r <= 1 ? { staffId: ctx.staffId } : {});
      const staff = new Map((await q<{ id: string; department_id: string | null; wing_id: string | null }>(c, `select id, department_id, wing_id from core.staff where branch_id = $1`, [ctx.branchId])).map((s) => [s.id, s]));
      return rows
        .filter((x) => r >= 5 || (r === 4 && staff.get(x.staff_id)?.wing_id === ctx.staff.wing_id) || (r === 3 && staff.get(x.staff_id)?.department_id === ctx.staff.department_id) || (r === 2 && x.staff_id === ctx.staffId) || x.staff_id === ctx.staffId)
        .map((x) => ({ section: x.section, subject: x.subject, pct_covered: x.pct_covered, status: x.status }));
    },
  },
};

export async function ask(ctx: Ctx, question: string) {
  need(ctx, 'reports', 'view');
  return run(ctx, async (c, sys) => {
    const gen = await sys(() =>
      generate(c, {
        orgId: ctx.orgId,
        branchId: ctx.branchId,
        staffId: ctx.staffId,
        action: 'ask_question',
        tier: 'fast',
        system: `You map a school manager's question to exactly one query function. Functions: ${Object.entries(ASK_FUNCTIONS).map(([k, v]) => `${k} (${v.label})`).join('; ')}. If none fits, return "none". Never write SQL.`,
        prompt: question,
        jsonSchema: { type: 'object', additionalProperties: false, required: ['function', 'params'], properties: { function: { type: 'string', enum: [...Object.keys(ASK_FUNCTIONS), 'none'] }, params: { type: 'object', additionalProperties: false, properties: {} } } },
        zod: z.object({ function: z.string(), params: z.record(z.string(), z.unknown()) }),
        mockContext: { question },
        logInput: { question: question.slice(0, 300) },
      }),
    );
    const fname = (gen.output as { function: string }).function;
    const fn = ASK_FUNCTIONS[fname];
    if (!fn) return { answered: false, function: null, rows: [] };
    // Runs as the asker: RLS and scope limit the rows to what they may see.
    return { answered: true, function: fname, label: fn.label, rows: await fn.run(c, ctx) };
  });
}

export { monthKey };
