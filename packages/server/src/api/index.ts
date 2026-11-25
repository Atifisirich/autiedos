/**
 * The single API used by the web app and the mobile app (rule 10). Every route validates its
 * input with a shared zod schema, loads the user's context (module flags + permissions), and
 * calls a service. Writes are audited by the database trigger.
 */
import { ZodError, z, type ZodTypeAny } from 'zod';
import * as S from '@autoed/shared';
import { UnauthorizedError, loadCtx, needProduct, rank, type Ctx } from '../core';
import { verifySession, endSession, rateLimit } from '../auth';
import * as login from '../login';
import { asUser, maybe } from '../db';
import * as tasks from '../services/tasks';
import * as approvals from '../services/approvals';
import * as att from '../services/attendance';
import * as tt from '../services/timetable';
import * as plan from '../services/planning';
import * as exams from '../services/exams';
import * as admin from '../services/admin';
import * as reports from '../services/reports';
import * as bot from '../services/bot';
import * as setup from '../services/setup';
import * as platform from '../services/platform';
import * as ai from '../services/ai';
import * as designer from '../designer';
import { tick } from '../scheduler';
import { readLocalFile, verifyLocalSignature, writeLocalFile } from '../adapters/channels';
import { plansDocx, tableXlsx } from '../exports';

export interface ApiRequest {
  method: string;
  path: string; // e.g. /tasks/123/action (without /api/os)
  query: Record<string, string>;
  headers: Record<string, string | undefined>;
  body: unknown;
  rawBody?: Buffer;
  ip?: string;
}

export interface ApiResponse {
  status: number;
  json?: unknown;
  binary?: { buffer: Buffer; contentType: string; filename?: string };
  text?: { body: string; contentType: string };
  setSession?: { token: string; expires_at: string } | null;
}

/** Untyped boundary of the legacy routes: request bodies (validated by each route's zod schema) and service rows read field by field. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;
type Body = Loose;
type Handler = (a: { ctx: Ctx; p: Record<string, string>; b: Body; q: Record<string, string>; req: ApiRequest }) => Promise<unknown>;
type PublicHandler = (a: { p: Record<string, string>; b: Body; q: Record<string, string>; req: ApiRequest }) => Promise<ApiResponse | unknown>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  schema?: ZodTypeAny;
  handler?: Handler;
  public?: PublicHandler;
  superAdmin?: (a: { userId: string; p: Record<string, string>; b: Body; q: Record<string, string> }) => Promise<unknown>;
  aiLimited?: boolean;
  /** AI school designer: runs as the designer actor (school management, or an AutoEd RM in a support session). */
  designer?: (a: { actor: designer.DesignerActor; p: Record<string, string>; b: Body; q: Record<string, string> }) => Promise<unknown>;
  /** Signed-in user, no OS context (works for platform admins without a school). */
  user?: (a: { userId: string; p: Record<string, string>; b: Body; q: Record<string, string>; req: ApiRequest }) => Promise<unknown>;
}

const routes: Route[] = [];
/** Routes that answer without the OS product (patterns as compiled). */
const PRODUCT_FREE = new Set<string>();
function compile(path: string) {
  const keys: string[] = [];
  const pattern = new RegExp(`^${path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)'))}$`);
  return { pattern, keys };
}
const r = (method: string, path: string, handler: Handler, schema?: ZodTypeAny, opts: { aiLimited?: boolean } = {}) => routes.push({ method, ...compile(path), handler, schema, ...opts });
const pub = (method: string, path: string, h: PublicHandler, schema?: ZodTypeAny) => routes.push({ method, ...compile(path), public: h, schema });
const sa = (method: string, path: string, h: NonNullable<Route['superAdmin']>, schema?: ZodTypeAny) => routes.push({ method, ...compile(path), superAdmin: h, schema });
const dz = (method: string, path: string, h: NonNullable<Route['designer']>, schema?: ZodTypeAny, opts: { aiLimited?: boolean } = {}) => routes.push({ method, ...compile(path), designer: h, schema, ...opts });
const usr = (method: string, path: string, h: NonNullable<Route['user']>, schema?: ZodTypeAny) => routes.push({ method, ...compile(path), user: h, schema });
const file = (buffer: Buffer, filename: string, contentType: string): ApiResponse => ({ status: 200, binary: { buffer, filename, contentType } });
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const range = (q: Record<string, string>, days = 30) => ({ from: q.from ?? S.addDays(new Date().toISOString().slice(0, 10), -days), to: q.to ?? new Date().toISOString().slice(0, 10) });

// ---------------------------------------------------------------- auth (public)
pub('GET', '/health', async () => ({ ok: true }));
// Unified staff login (docs/adr/shell-and-login.md): every route below is product-neutral (CRM, OS and ERP share
// the session), rate limited in the database and logged in core.login_events.
const loginReq = (req: ApiRequest): login.LoginRequest => ({ ip: req.ip, userAgent: req.headers['user-agent'] ?? null, platform: (['android', 'ios'].includes(req.headers['x-platform'] ?? '') ? req.headers['x-platform'] : 'web') as 'web' });
const signedIn = (s: S.SignInResult): ApiResponse => ({ status: 200, json: s, setSession: s });
pub('POST', '/auth/dev-login', async ({ b, req }) => signedIn(await login.devEmailLogin(b, loginReq(req))), S.devLoginSchema);
pub('POST', '/auth/session', async ({ b, req }) => signedIn(await login.exchange(b, loginReq(req))), S.sessionExchangeSchema);
pub('POST', '/auth/password', async ({ b, req }) => signedIn(await login.passwordLogin(b, loginReq(req))), S.passwordLoginSchema);
pub('POST', '/auth/otp/start', async ({ b, req }) => login.otpStart(b, loginReq(req)), S.otpStartSchema);
pub('POST', '/auth/otp/verify', async ({ b, req }) => signedIn(await login.otpVerify(b, loginReq(req))), S.otpVerifySchema);
pub('POST', '/auth/password/change', async ({ b, req }) => signedIn(await login.changePassword(await verifySession(bearer(req)), b, loginReq(req))), S.passwordChangeSchema);
pub('GET', '/session', async ({ req }) => login.platformSession(await verifySession(bearer(req))));
pub('POST', '/auth/logout', async ({ req }) => {
  const token = bearer(req);
  if (token) {
    const s = await verifySession(token).catch(() => null);
    if (s) {
      await endSession(s.sid, s.userId);
      await login.logoutNote(s.userId, loginReq(req));
    }
  }
  return { status: 200, json: { ok: true }, setSession: null };
});
pub('GET', '/calendar/:token.ics', async ({ p }) => ({ status: 200, text: { body: await admin.icsFeed(p.token!), contentType: 'text/calendar; charset=utf-8' } }));
pub('POST', '/cron/tick', async ({ req }) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return { status: 401, json: { error: 'unauthorized' } };
  return tick();
});
pub('GET', '/cron/tick', async ({ req }) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return { status: 401, json: { error: 'unauthorized' } };
  return tick();
});
// Local storage (dev): signed PUT/GET. On Supabase, files go straight to Storage via signed URLs.
pub('PUT', '/files/(.+)', async ({ p, q, req }) => {
  const path = p['0']!;
  if (!verifyLocalSignature(path, Number(q.exp), q.sig ?? '', 'put')) return { status: 403, json: { error: 'bad_signature' } };
  await writeLocalFile(path, req.rawBody ?? Buffer.alloc(0));
  return { ok: true, path };
});
pub('GET', '/files/(.+)', async ({ p, q }) => {
  const path = p['0']!;
  if (!verifyLocalSignature(path, Number(q.exp), q.sig ?? '', 'get')) return { status: 403, json: { error: 'bad_signature' } };
  const buf = await readLocalFile(path);
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const types: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf', webp: 'image/webp', m4a: 'audio/mp4', mp3: 'audio/mpeg', txt: 'text/plain', docx: DOCX, xlsx: XLSX };
  return file(buf, path.split('/').pop()!, types[ext] ?? 'application/octet-stream');
});

// ---------------------------------------------------------------- me, inbox, devices, files
r('GET', '/me', ({ ctx }) => platform.me(ctx));
PRODUCT_FREE.add(`GET ${compile('/me').pattern.source}`);
r('PATCH', '/me', ({ ctx, b }) => platform.updateProfile(ctx, b), S.profileSchema);
r('GET', '/my-day', ({ ctx, q }) => tasks.myDay(ctx, q.date));
r('GET', '/inbox', ({ ctx, q }) => platform.inbox(ctx, { unread: q.unread === '1' }));
r('POST', '/inbox/read', ({ ctx, b }) => platform.markRead(ctx, b.ids === 'all' ? 'all' : b.ids), z.object({ ids: z.union([z.literal('all'), z.array(S.uuid)]) }));
r('GET', '/notification-prefs', ({ ctx }) => platform.notificationPrefs(ctx));
r('POST', '/notification-prefs', ({ ctx, b }) => platform.setNotificationPref(ctx, b), S.notificationPrefSchema);
r('POST', '/devices', ({ ctx, b }) => platform.registerDevice(ctx, b), S.deviceTokenSchema);
r('GET', '/devices', ({ ctx }) => platform.devices(ctx));
r('POST', '/devices/:id/revoke', ({ ctx, p }) => platform.revokeDevice(ctx, p.id!));
r('POST', '/uploads', ({ ctx, b }) => platform.uploadUrl(ctx, b), S.uploadUrlSchema);
r('POST', '/downloads', ({ ctx, b }) => platform.downloadUrl(ctx, b.path), z.object({ path: z.string() }));
r('GET', '/calendar-link', async ({ ctx }) => ({ token: admin.calendarToken(ctx.orgId, ctx.staffId) }));
r('GET', '/support-access', ({ ctx }) => platform.viewAsLog(ctx));

// ---------------------------------------------------------------- offline sync (mobile outbox)
r(
  'POST',
  '/sync',
  async ({ ctx, b, req }) => {
    const results = [];
    for (const item of b.items as z.infer<typeof S.outboxItemSchema>[]) {
      const sub = await dispatch({ method: item.method, path: item.path.replace(/^\/api\/os/, ''), query: {}, headers: req.headers, body: item.body, ip: req.ip }, ctx);
      results.push({ client_id: item.client_id, status: sub.status, result: sub.json });
    }
    return { results };
  },
  S.syncSchema,
);

// ---------------------------------------------------------------- tasks
r('GET', '/tasks', ({ ctx, q }) => tasks.listTasks(ctx, { view: (q.view as 'mine') ?? 'mine', status: q.status, from: q.from, to: q.to, owner_id: q.owner_id, q: q.q, limit: Number(q.limit ?? 200), offset: Number(q.offset ?? 0) }));
r('POST', '/tasks', ({ ctx, b }) => tasks.createTask(ctx, b), S.taskCreateSchema);
r('POST', '/tasks/quick', ({ ctx, b }) => tasks.quickAdd(ctx, b), S.quickAddSchema);
r('GET', '/tasks/team', ({ ctx }) => tasks.teamView(ctx));
r('GET', '/tasks/day-close', ({ ctx }) => tasks.dayCloseList(ctx));
r('POST', '/tasks/day-close', ({ ctx, b }) => tasks.dayClose(ctx, b.items), S.dayCloseSchema);
r('POST', '/tasks/bulk', ({ ctx, b }) => tasks.bulkTasks(ctx, b), S.taskBulkSchema);
r('POST', '/tasks/reassign-leaver', ({ ctx, b }) => tasks.reassignLeaver(ctx, b), S.reassignLeaverSchema);
r('GET', '/tasks/:id', ({ ctx, p }) => tasks.getTask(ctx, p.id!));
r('POST', '/tasks/:id/action', ({ ctx, p, b }) => tasks.taskAction(ctx, p.id!, b), S.taskActionSchema);
r('POST', '/tasks/:id/comments', ({ ctx, p, b }) => tasks.addComment(ctx, p.id!, b), S.taskCommentSchema);
r('POST', '/tasks/:id/attachments', ({ ctx, p, b }) => tasks.attachToTask(ctx, p.id!, b), z.object({ storage_path: z.string(), mime: z.string().optional(), size_bytes: z.number().optional(), kind: z.enum(['attachment', 'voice']).optional() }));
r('POST', '/tasks/:id/schedule', ({ ctx, p, b }) => tasks.scheduleTask(ctx, p.id!, b.start_at), z.object({ start_at: z.string().datetime({ offset: true }).nullable() }));
r('POST', '/task-comments/:id/subtask', ({ ctx, p }) => tasks.commentToSubtask(ctx, p.id!));

// ---------------------------------------------------------------- checklists
r('GET', '/checklists/templates', ({ ctx }) => admin.checklistTemplates(ctx));
r('POST', '/checklists/templates', ({ ctx, b }) => admin.saveChecklistTemplate(ctx, null, b), S.checklistTemplateSchema);
r('PUT', '/checklists/templates/:id', ({ ctx, p, b }) => admin.saveChecklistTemplate(ctx, p.id!, b), S.checklistTemplateSchema);
r('GET', '/checklists/runs', ({ ctx, q }) => admin.myChecklistRuns(ctx, q.date));
r('GET', '/checklists/runs/:id', ({ ctx, p }) => admin.getRun(ctx, p.id!));
r('POST', '/checklists/runs/:id', ({ ctx, p, b }) => admin.submitRun(ctx, p.id!, b), S.checklistSubmitSchema);
r('GET', '/checklists/reports', ({ ctx, q }) => admin.checklistReports(ctx, range(q).from, range(q).to));

// ---------------------------------------------------------------- timetable & substitution
r('GET', '/timetable/allocations', ({ ctx }) => tt.listAllocations(ctx));
r('POST', '/timetable/allocations', ({ ctx, b }) => tt.saveAllocation(ctx, b), S.allocationSchema.extend({ id: S.uuid.optional() }));
r('GET', '/timetable/versions', ({ ctx }) => tt.versions(ctx));
r('POST', '/timetable/generate', ({ ctx, b }) => tt.startGeneration(ctx, b), S.timetableGenerateSchema);
r('GET', '/timetable/grid', ({ ctx, q }) => tt.grid(ctx, { version_id: q.version_id, by: (q.by as 'section') ?? 'section', id: q.id ?? '' }));
r('POST', '/timetable/versions/:id/edit', ({ ctx, p, b }) => tt.editTimetable(ctx, p.id!, b), S.timetableEditSchema);
r('GET', '/timetable/versions/:id/check', ({ ctx, p, q }) => tt.checkMove(ctx, p.id!, q.entry_id!, Number(q.day), Number(q.period_seq)));
r('POST', '/timetable/versions/:id/revision', ({ ctx, p, b }) => tt.createRevision(ctx, p.id!, b.name), z.object({ name: z.string().min(1) }));
r('POST', '/timetable/versions/:id/publish', ({ ctx, p, b }) => tt.publish(ctx, p.id!, b.effective_from), S.timetablePublishSchema);
r('GET', '/timetable/free-teachers', ({ ctx, q }) => tt.freeTeachers(ctx, q.date!, Number(q.period_seq)));
r('GET', '/timetable/workload', ({ ctx, q }) => tt.workload(ctx, q.version_id));
r('GET', '/timetable/export', async ({ ctx, q }) => {
  const g = (await tt.grid(ctx, { version_id: q.version_id, by: (q.by as 'section') ?? 'section', id: q.id! })) as { entries: Record<string, unknown>[] };
  const org = await platform.me(ctx);
  return file(await tableXlsx('Timetable', { name: (org.org as { name: string }).name, branding: (org.org as { branding: Record<string, string> }).branding }, [{ key: 'day', header: 'Day' }, { key: 'period_seq', header: 'Period' }, { key: 'section_name', header: 'Section' }, { key: 'subject_name', header: 'Subject' }, { key: 'staff_name', header: 'Teacher' }, { key: 'room_name', header: 'Room' }], g.entries), 'timetable.xlsx', XLSX);
});
r('GET', '/substitution', ({ ctx, q }) => tt.board(ctx, q.date ?? new Date().toISOString().slice(0, 10)));
r('GET', '/substitution/mine', ({ ctx }) => tt.mySubstitutions(ctx));
r('POST', '/substitution/assign', ({ ctx, b }) => tt.assignSubstitute(ctx, b), S.substitutionAssignSchema);
r('POST', '/substitution/mark-absent', ({ ctx, b }) => tt.markAbsent(ctx, b), S.markAbsentSchema);
r('GET', '/substitution/reports', ({ ctx, q }) => tt.substitutionReports(ctx, range(q).from, range(q).to));

// ---------------------------------------------------------------- attendance & leave
r('POST', '/attendance/check', ({ ctx, b }) => att.checkIn(ctx, b), S.checkInSchema);
r('GET', '/attendance/mine', ({ ctx, q }) => att.myAttendance(ctx, q.month ?? new Date().toISOString().slice(0, 7)));
r('POST', '/attendance/import', ({ ctx, b }) => att.importBiometric(ctx, b), S.biometricImportSchema);
r('POST', '/attendance/regularise', ({ ctx, b }) => att.requestRegularisation(ctx, b), S.regularisationSchema);
r('GET', '/attendance/exceptions', ({ ctx, q }) => att.attendanceExceptions(ctx, q.date));
r('GET', '/attendance/register', ({ ctx, q }) => att.staffRegister(ctx, q.month ?? new Date().toISOString().slice(0, 7), q.branch_id));
r('GET', '/attendance/register.xlsx', async ({ ctx, q }) => {
  const reg = await att.staffRegister(ctx, q.month ?? new Date().toISOString().slice(0, 7));
  const rows = reg.rows.map((x) => ({ ...x, leave: Object.entries(x.leave).map(([k, v]) => `${k}: ${v}`).join(', ') }));
  return file(await tableXlsx(`Staff register ${reg.month}`, { name: 'AutoEd OS' }, [{ key: 'employee_code', header: 'Code' }, { key: 'name', header: 'Name' }, { key: 'present', header: 'Present' }, { key: 'late', header: 'Late' }, { key: 'half_days', header: 'Half days' }, { key: 'absent', header: 'Absent' }, { key: 'leave', header: 'Leave by type' }, { key: 'loss_of_pay_days', header: 'Loss of pay days' }], rows), `staff-register-${reg.month}.xlsx`, XLSX);
});
r('GET', '/student-attendance/sections', ({ ctx }) => att.mySections(ctx));
r('GET', '/student-attendance/roster', ({ ctx, q }) => att.rosterForMarking(ctx, q.section_id!, q.date!, q.session_key ?? 'day'));
r('POST', '/student-attendance', ({ ctx, b }) => att.submitStudentAttendance(ctx, b), S.studentAttendanceSchema);
r('GET', '/student-attendance/summary', ({ ctx, q }) => att.studentDaySummary(ctx, q.date ?? new Date().toISOString().slice(0, 10)));
r('GET', '/student-attendance/alerts', ({ ctx, q }) => att.studentAlerts(ctx, range(q).from, range(q).to));
r('GET', '/student-attendance/register', ({ ctx, q }) => att.studentRegister(ctx, q.section_id!, q.month ?? new Date().toISOString().slice(0, 7)));
r('GET', '/leave/balances', ({ ctx, q }) => att.myBalances(ctx, q.staff_id));
r('GET', '/leave/mine', ({ ctx }) => att.myLeave(ctx));
r('POST', '/leave/preview', ({ ctx, b }) => att.previewLeave(ctx, b), S.leaveApplySchema);
r('POST', '/leave', ({ ctx, b }) => att.applyLeave(ctx, b), S.leaveApplySchema);
r('GET', '/leave/calendar', ({ ctx, q }) => att.leaveCalendar(ctx, range(q, 0).from, q.to ?? S.addDays(new Date().toISOString().slice(0, 10), 30), q.department_id));

// ---------------------------------------------------------------- approvals
r('GET', '/approvals', ({ ctx, q }) => approvals.listApprovals(ctx, (q.view as 'mine') ?? 'pending_me'));
r('POST', '/approvals', ({ ctx, b }) => approvals.createRequest(ctx, b), S.approvalRequestSchema);
r('GET', '/approvals/types', ({ ctx }) => approvals.approvalTypes(ctx));
r('POST', '/approvals/types', ({ ctx, b }) => approvals.saveApprovalType(ctx, b), S.approvalTypeSchema);
r('GET', '/approvals/:id', ({ ctx, p }) => approvals.getApproval(ctx, p.id!));
r('POST', '/approvals/:id/action', ({ ctx, p, b }) => approvals.approvalAction(ctx, p.id!, b), S.approvalActionSchema.extend({ data: z.record(z.string(), z.any()).optional() }));

// ---------------------------------------------------------------- lesson planning & coverage
r('GET', '/curriculum/boards', ({ ctx }) => plan.boards(ctx));
r('GET', '/curriculum/boards/:id', ({ ctx, p }) => plan.boardTree(ctx, p.id!));
r('GET', '/curriculum/subjects/:id', ({ ctx, p }) => plan.subjectTree(ctx, p.id!));
r('POST', '/curriculum/clone', ({ ctx, b }) => plan.cloneMap(ctx, b.board_id), S.curriculumCloneSchema);
r('POST', '/curriculum/edit', ({ ctx, b }) => plan.editMap(ctx, b), z.object({ op: z.enum(['rename', 'reorder', 'add_topic', 'remove_topic', 'add_outcome', 'add_chapter']), id: S.uuid.optional(), name: z.string().optional(), seq: z.number().int().optional(), parent_id: S.uuid.optional(), unit_id: S.uuid.optional(), text: z.string().optional(), est_periods: z.number().int().optional() }));
r('GET', '/documents', ({ ctx }) => plan.documents(ctx));
r('POST', '/documents', ({ ctx, b }) => plan.addDocument(ctx, b), S.documentUploadSchema);
r('GET', '/documents/search', ({ ctx, q }) => plan.search(ctx, q.q ?? ''));
r('POST', '/lesson-plans/templates', ({ ctx, b }) => plan.saveTemplate(ctx, b), z.object({ id: S.uuid.optional(), name: z.string(), wing_id: S.uuid.nullable().optional(), sections: z.array(z.object({ key: z.enum(S.PLAN_SECTION_KEYS), name: z.string(), mandatory: z.boolean(), seq: z.number() })), header: z.record(z.string(), z.any()).optional(), default_teaching_model: z.string(), is_default: z.boolean().optional() }));
r('GET', '/lesson-plans', ({ ctx, q }) => plan.listPlans(ctx, { view: (q.view as 'mine') ?? 'mine', q: q.q, subject_id: q.subject_id, programme_id: q.programme_id, from: q.from, to: q.to }));
r('POST', '/lesson-plans/generate', ({ ctx, b }) => plan.generateDailyPlan(ctx, b), S.dailyPlanRequestSchema, { aiLimited: true });
r('GET', '/lesson-plans/quote', ({ ctx, q }) => ai.quote(ctx, (q.action as S.AiAction) ?? 'daily_plan', Number(q.units ?? 1)));
r('GET', '/lesson-plans/weekly', ({ ctx, q }) => plan.weeklyPlan(ctx, q.week_start!));
r('GET', '/lesson-plans/weekly.docx', async ({ ctx, q }) => {
  const w = await plan.weeklyPlan(ctx, q.week_start!);
  const ids = [...new Set(w.periods.map((x) => x.plan_id).filter((x): x is string => !!x))];
  const plans = [];
  for (const id of ids) {
    const pl = (await plan.getPlan(ctx, id)) as Loose;
    plans.push({ title: `${pl.subject_name} · ${pl.section_name} · ${pl.plan_date}`, meta: `${pl.topic_name ?? ''} · ${pl.teacher_name}`, content: pl.content, sections: pl.template.sections });
  }
  const me = await platform.me(ctx);
  return file(await plansDocx(me.org as Loose, plans), `weekly-plan-${q.week_start}.docx`, DOCX);
});
r('POST', '/lesson-plans/unit', ({ ctx, b }) => plan.generateUnitPlan(ctx, b), z.object({ chapter_id: S.uuid, subject_id: S.uuid, section_id: S.uuid }), { aiLimited: true });
r('GET', '/lesson-plans/:id', ({ ctx, p }) => plan.getPlan(ctx, p.id!));
r('GET', '/lesson-plans/:id/docx', async ({ ctx, p }) => {
  const pl = (await plan.getPlan(ctx, p.id!)) as Loose;
  return file(await plansDocx(pl.org, [{ title: `${pl.subject_name} · ${pl.section_name ?? ''} · ${pl.plan_date ?? ''}`, meta: `${pl.topic_name ?? ''} · ${pl.teacher_name} · ${pl.period_count} × ${pl.period_minutes} min`, content: pl.content, sections: pl.template.sections }]), `lesson-plan-${pl.plan_date ?? pl.id}.docx`, DOCX);
});
r('PATCH', '/lesson-plans/:id', ({ ctx, p, b }) => plan.updatePlan(ctx, p.id!, b), S.planUpdateSchema);
r('POST', '/lesson-plans/:id/section', ({ ctx, p, b }) => plan.sectionAction(ctx, p.id!, b), S.planSectionActionSchema, { aiLimited: true });
r('POST', '/lesson-plans/:id/companion', ({ ctx, p, b }) => plan.companion(ctx, p.id!, b.kind), S.companionSchema, { aiLimited: true });
r('POST', '/lesson-plans/:id/workflow', ({ ctx, p, b }) => plan.planWorkflow(ctx, p.id!, b), S.planWorkflowSchema);
r('POST', '/lesson-plans/:id/reuse', ({ ctx, p, b }) => plan.reusePlan(ctx, p.id!, b), z.object({ section_ids: z.array(S.uuid).min(1), plan_date: S.isoDate }));
r('POST', '/annual-plans', ({ ctx, b }) => plan.generateAnnualPlan(ctx, b), S.annualPlanSchema, { aiLimited: true });
r('GET', '/annual-plans', ({ ctx, q }) => plan.annualPlan(ctx, q.programme_id!, q.subject_id!));
r('PATCH', '/annual-plans/items/:id', ({ ctx, p, b }) => plan.editAnnualItem(ctx, p.id!, b), z.object({ planned_start: S.isoDate, planned_end: S.isoDate, planned_periods: z.number().int().min(1), seq: z.number().int().optional() }));
r('POST', '/annual-plans/:id/publish', ({ ctx, p }) => plan.publishAnnualPlan(ctx, p.id!));
r('GET', '/coverage', ({ ctx, q }) => plan.coverageView(ctx, q));
r('POST', '/coverage/recovery', ({ ctx, b }) => plan.recoveryPlan(ctx, b), z.object({ section_id: S.uuid, subject_id: S.uuid }), { aiLimited: true });
r('POST', '/class-log', ({ ctx, b }) => plan.logClass(ctx, b), S.classLogSchema);
r('GET', '/class-log', ({ ctx, q }) => plan.sectionLog(ctx, q.section_id!, range(q, 14).from, range(q, 14).to));
r('GET', '/class-log/homework-load', ({ ctx, q }) => plan.homeworkLoadView(ctx, q.from ?? new Date().toISOString().slice(0, 10), q.to ?? S.addDays(new Date().toISOString().slice(0, 10), 7)));
r('GET', '/class-log/notebooks', ({ ctx, q }) => plan.notebookChecks(ctx, q.section_id));
r('POST', '/class-log/notebooks', ({ ctx, b }) => plan.addNotebookCheck(ctx, b), S.notebookCheckSchema);

// ---------------------------------------------------------------- exams, papers, observation
r('GET', '/exams', ({ ctx }) => exams.listExams(ctx));
r('POST', '/exams', ({ ctx, b }) => exams.createExam(ctx, b), S.examSchema);
r('GET', '/exams/papers', ({ ctx }) => exams.listPapers(ctx));
r('GET', '/exams/blueprints', ({ ctx }) => exams.listBlueprints(ctx));
r('POST', '/exams/blueprints', ({ ctx, b }) => exams.saveBlueprint(ctx, b), S.blueprintSchema.extend({ id: S.uuid.optional() }));
r('GET', '/exams/bank', ({ ctx, q }) => exams.bankQuestions(ctx, q));
r('POST', '/exams/bank', ({ ctx, b }) => exams.addBankQuestion(ctx, b), z.object({ subject_id: S.uuid, programme_id: S.uuid, topic_id: S.uuid, question_type: z.string(), difficulty: z.enum(['easy', 'medium', 'hard']), marks: z.number().positive(), bloom: z.string().optional(), competency: z.boolean().optional(), content: z.object({ text: z.string().min(3), options: z.array(z.string()).optional(), answer: z.string(), marking: z.array(z.any()).optional() }), tags: z.array(z.string()).optional() }));
r('POST', '/exams/papers/generate', ({ ctx, b }) => exams.generatePaper(ctx, b), S.paperGenerateSchema, { aiLimited: true });
r('GET', '/exams/papers/:id', ({ ctx, p }) => exams.getPaper(ctx, p.id!));
r('POST', '/exams/papers/:id/review', ({ ctx, p, b }) => exams.paperReview(ctx, p.id!, b), S.paperReviewSchema);
r('GET', '/exams/papers/:id/docx', async ({ ctx, p, q }) => {
  const x = await exams.exportPaper(ctx, p.id!, q.scheme === '1');
  return file(x.buffer, x.filename, DOCX);
});
r('POST', '/exams/schedules', ({ ctx, b }) => exams.addSchedule(ctx, b), S.examScheduleSchema);
r('GET', '/exams/:id', ({ ctx, p }) => exams.examDetail(ctx, p.id!));
r('POST', '/exams/:id/invigilation', ({ ctx, p }) => exams.allocateInvigilation(ctx, p.id!));
r('POST', '/exams/invigilation/:id/swap', ({ ctx, p, b }) => exams.requestInvigilationSwap(ctx, p.id!, b.swap_with_id), z.object({ swap_with_id: S.uuid }));
r('POST', '/exams/:id/seating', ({ ctx, p, b }) => exams.generateSeating(ctx, p.id!, b.date, b.room_ids), z.object({ date: S.isoDate, room_ids: z.array(S.uuid).min(1) }));
r('GET', '/observation/rubrics', ({ ctx }) => exams.rubrics(ctx));
r('GET', '/observations', ({ ctx }) => exams.listObservations(ctx));
r('POST', '/observations', ({ ctx, b }) => exams.scheduleObservation(ctx, b), S.observationSchema);
r('GET', '/observations/:id', ({ ctx, p }) => exams.getObservation(ctx, p.id!));
r('POST', '/observations/:id/fill', ({ ctx, p, b }) => exams.fillObservation(ctx, p.id!, b), S.observationFillSchema);
r('POST', '/observations/:id/acknowledge', ({ ctx, p, b }) => exams.acknowledgeObservation(ctx, p.id!, b.reflection), S.observationAckSchema);
r('POST', '/appraisal/cycles/:id/compute', ({ ctx, p }) => exams.computeScorecards(ctx, p.id!));
r('GET', '/appraisal/cycles/:id/scorecards', ({ ctx, p }) => exams.scorecards(ctx, p.id!));
r('POST', '/appraisal/cycles/:id/rating', ({ ctx, p, b }) => exams.setRating(ctx, p.id!, b.staff_id, b), z.object({ staff_id: S.uuid, manager_rating: z.number().min(1).max(5).optional(), self_appraisal: z.number().min(1).max(5).optional() }));
r('GET', '/trainings', ({ ctx, q }) => exams.trainings(ctx, q.staff_id));
r('POST', '/trainings', ({ ctx, b }) => exams.addTraining(ctx, b), S.trainingSchema);

// ---------------------------------------------------------------- admin modules
r('GET', '/tickets', ({ ctx, q }) => admin.listTickets(ctx, (q.view as 'mine') ?? 'mine', q.status));
r('POST', '/tickets', ({ ctx, b }) => admin.raiseTicket(ctx, b), S.ticketSchema);
r('GET', '/tickets/reports', ({ ctx, q }) => admin.helpdeskReports(ctx, range(q).from, range(q).to));
r('GET', '/tickets/room/:token', ({ ctx, p }) => admin.roomByQr(ctx, p.token!));
r('GET', '/tickets/:id', ({ ctx, p }) => admin.getTicket(ctx, p.id!));
r('POST', '/tickets/:id/action', ({ ctx, p, b }) => admin.ticketAction(ctx, p.id!, b), S.ticketActionSchema);
r('GET', '/circulars', ({ ctx, q }) => admin.listCirculars(ctx, q));
r('POST', '/circulars', ({ ctx, b }) => admin.createCircular(ctx, b), S.circularSchema);
r('GET', '/circulars/:id', ({ ctx, p }) => admin.getCircular(ctx, p.id!));
r('POST', '/circulars/:id/respond', ({ ctx, p, b }) => admin.respondCircular(ctx, p.id!, b), S.circularResponseSchema);
r('GET', '/calendar', ({ ctx, q }) => admin.calendarEvents(ctx, range(q, 0).from, q.to ?? S.addDays(new Date().toISOString().slice(0, 10), 60), q.layers?.split(',')));
r('POST', '/calendar', ({ ctx, b }) => admin.saveCalendarEvent(ctx, null, b), S.calendarEventSchema);
r('PUT', '/calendar/:id', ({ ctx, p, b }) => admin.saveCalendarEvent(ctx, p.id!, b), S.calendarEventSchema);
r('GET', '/meetings', ({ ctx }) => admin.listMeetings(ctx));
r('POST', '/meetings', ({ ctx, b }) => admin.createMeeting(ctx, b), S.meetingSchema);
r('GET', '/meetings/:id', ({ ctx, p }) => admin.getMeeting(ctx, p.id!));
r('POST', '/meetings/:id/minutes', ({ ctx, p, b }) => admin.saveMinutes(ctx, p.id!, b), S.meetingMinutesSchema);
r('GET', '/events', ({ ctx }) => admin.listEvents(ctx));
r('POST', '/events', ({ ctx, b }) => admin.createEvent(ctx, b), S.eventSchema);
r('GET', '/events/:id', ({ ctx, p }) => admin.eventDetail(ctx, p.id!));
r('POST', '/events/:id/review', ({ ctx, p, b }) => admin.reviewEvent(ctx, p.id!, b), S.eventReviewSchema);
r('GET', '/duty', ({ ctx, q }) => admin.roster(ctx, range(q, 0).from, q.to ?? S.addDays(new Date().toISOString().slice(0, 10), 7)));
r('POST', '/duty/generate', ({ ctx, b }) => admin.generateDuties(ctx, b.from, b.to), S.dutyGenerateSchema);
r('POST', '/duty/swap', ({ ctx, b }) => admin.requestDutySwap(ctx, b.assignment_id, b.swap_with_id), S.dutySwapSchema);
r('POST', '/duty/:id/override', ({ ctx, p, b }) => admin.overrideDuty(ctx, p.id!, b.staff_id), z.object({ staff_id: S.uuid }));
r('POST', '/duty/:id/mark', ({ ctx, p, b }) => admin.markDuty(ctx, p.id!, b.status), z.object({ status: z.enum(['done', 'missed']) }));
r('GET', '/incidents', ({ ctx }) => admin.listIncidents(ctx));
r('POST', '/incidents', ({ ctx, b }) => admin.logIncident(ctx, b), S.incidentSchema);
r('GET', '/incidents/reports', ({ ctx, q }) => admin.incidentReports(ctx, range(q, 90).from, range(q, 90).to));
r('GET', '/incidents/:id', ({ ctx, p }) => admin.getIncident(ctx, p.id!));
r('POST', '/incidents/:id/close', ({ ctx, p }) => admin.closeIncident(ctx, p.id!));
r('GET', '/compliance', ({ ctx, q }) => admin.complianceList(ctx, q.branch_id));
r('POST', '/compliance', ({ ctx, b }) => admin.saveComplianceItem(ctx, null, b), S.complianceItemSchema);
r('PUT', '/compliance/:id', ({ ctx, p, b }) => admin.saveComplianceItem(ctx, p.id!, b), S.complianceItemSchema);

// ---------------------------------------------------------------- reports, AI, help bot
r('GET', '/dashboard', ({ ctx }) => reports.dashboard(ctx));
r('GET', '/dashboard/drill/:key', ({ ctx, p, q }) => reports.drill(ctx, p.key!, q.branch_id));
r('GET', '/reports', async ({ ctx }) => ({ catalogue: reports.catalogueFor(ctx), datasets: reports.BUILDER_DATASETS }));
r('GET', '/reports/digest', ({ ctx }) => reports.digest(ctx));
r('GET', '/reports/insight', ({ ctx }) => reports.latestInsight(ctx));
r('POST', '/reports/ask', ({ ctx, b }) => reports.ask(ctx, b.question), S.askSchema, { aiLimited: true });
r('POST', '/reports/builder', ({ ctx, b }) => reports.runBuilder(ctx, b.config, b.range), z.object({ config: S.savedReportSchema.shape.config.extend({ dataset: z.enum(S.REPORT_DATASETS) }), range: z.object({ from: S.isoDate, to: S.isoDate }) }));
r('GET', '/reports/saved', ({ ctx }) => reports.savedReports(ctx));
r('POST', '/reports/saved', ({ ctx, b }) => reports.saveReport(ctx, b), S.savedReportSchema);
r('POST', '/reports/schedules', ({ ctx, b }) => reports.scheduleReport(ctx, b), S.reportScheduleSchema);
r('GET', '/reports/:key', ({ ctx, p, q }) => reports.runReport(ctx, p.key!, { ...range(q), branch_id: q.branch_id, wing_id: q.wing_id, department_id: q.department_id, staff_id: q.staff_id }));
r('GET', '/reports/:key/xlsx', async ({ ctx, p, q }) => {
  const x = await reports.exportReport(ctx, p.key!, { ...range(q), branch_id: q.branch_id, wing_id: q.wing_id, department_id: q.department_id, staff_id: q.staff_id });
  return file(x.buffer, x.filename, XLSX);
});
r('GET', '/ai/credits', ({ ctx, q }) => ai.creditsSummary(ctx, q.period));
r('POST', '/ai/topup-request', ({ ctx, b }) => ai.requestTopup(ctx, b), S.topupRequestSchema);
r('POST', '/bot/ask', ({ ctx, b }) => bot.askBot(ctx, b), S.botAskSchema, { aiLimited: true });
r('POST', '/bot/feedback', ({ ctx, b }) => bot.botFeedback(ctx, b), S.botFeedbackSchema);
r('POST', '/bot/support', ({ ctx, b }) => bot.escalateToSupport(ctx, b.conversation_id), z.object({ conversation_id: S.uuid }));
r('POST', '/bot/sop', ({ ctx, b }) => bot.addSop(ctx, b), z.object({ title: z.string().min(2), body: z.string().min(10), language: z.enum(['en', 'hi', 'te']) }));

// ---------------------------------------------------------------- setup & configuration
r('GET', '/setup', ({ ctx }) => setup.wizardState(ctx));
r('POST', '/setup/step', ({ ctx, b }) => setup.setStep(ctx, b.step), z.object({ step: z.number().int().min(0).max(8) }));
r('POST', '/setup/profile', ({ ctx, b }) => setup.saveProfile(ctx, b), S.orgProfileSchema);
r('POST', '/setup/year', ({ ctx, b }) => setup.saveYear(ctx, b), S.academicYearSchema);
r('POST', '/setup/structure-preset', ({ ctx, b }) => setup.applyStructurePreset(ctx, b.preset_key, b.sections_per_class), z.object({ preset_key: z.enum(['cbse', 'cambridge', 'dual']), sections_per_class: z.number().int().min(1).max(10) }));
r('GET', '/setup/templates/:kind', async ({ p }) => file(await setup.templateXlsx(p.kind!), `${p.kind}-template.xlsx`, XLSX));
r('POST', '/setup/parse', async ({ b }) => ({ rows: await setup.parseSheet(b.base64, b.file_name) }), z.object({ base64: z.string().max(8_000_000), file_name: z.string() }));
r('POST', '/setup/import', ({ ctx, b }) => setup.importRows(ctx, b.kind, b.rows, b.dry_run), S.importSchema);
r('GET', '/staff', ({ ctx, q }) => setup.listStaff(ctx, { q: q.q, branch_id: q.branch_id, all: q.all === '1' }));
r('POST', '/staff', ({ ctx, b }) => setup.inviteStaff(ctx, b), z.object({ full_name: z.string().min(2), email: z.string().email().optional(), phone: z.string().optional(), employee_code: z.string().min(1), position_id: S.uuid, department_id: S.uuid.nullable().optional(), wing_id: S.uuid.nullable().optional(), reports_to: S.uuid.nullable().optional() }));
r('PATCH', '/staff/:id', ({ ctx, p, b }) => setup.updateStaff(ctx, p.id!, b), z.record(z.string(), z.any()));
r('POST', '/staff/:id/deactivate', ({ ctx, p }) => setup.deactivateStaff(ctx, p.id!));
r('POST', '/staff/:id/roles', ({ ctx, p, b }) => setup.setStaffRoles(ctx, p.id!, b.role_ids), z.object({ role_ids: z.array(S.uuid) }));
r('GET', '/org-chart', ({ ctx }) => setup.orgChart(ctx));
r('POST', '/org-chart/move', ({ ctx, b }) => setup.moveInOrgChart(ctx, b.staff_id, b.reports_to), S.orgChartMoveSchema);
r('GET', '/roles', ({ ctx }) => setup.rolesMatrix(ctx));
r('POST', '/roles', ({ ctx, b }) => setup.createRole(ctx, b), S.roleSchema.extend({ copy_from_role_id: S.uuid.optional() }));
r('POST', '/roles/permission', ({ ctx, b }) => setup.setPermission(ctx, b), S.rolePermissionSchema);
r('GET', '/assignment-rules', ({ ctx }) => setup.assignmentRules(ctx));
r('POST', '/assignment-rules', ({ ctx, b }) => setup.setAssignmentRule(ctx, b), z.object({ from_role_id: S.uuid, to_role_id: S.uuid, rule: z.enum(['assign', 'request', 'none']).nullable() }));
r('GET', '/delegations', ({ ctx }) => setup.delegations(ctx));
r('POST', '/delegations', ({ ctx, b }) => setup.addDelegation(ctx, b), S.delegationSchema);
r('GET', '/modules', ({ ctx }) => setup.moduleFlags(ctx));
r('POST', '/modules', ({ ctx, b }) => setup.setModuleFlag(ctx, b), S.moduleFlagSchema);
r('POST', '/branding', ({ ctx, b }) => setup.updateBranding(ctx, b), z.object({ logo_url: z.string().nullable().optional(), branding: z.record(z.string(), z.string()), settings: z.record(z.string(), z.any()).optional() }));
r('POST', '/branch-settings', ({ ctx, b }) => setup.updateBranchSettings(ctx, b), z.object({ name: z.string().optional(), latitude: z.number().nullable().optional(), longitude: z.number().nullable().optional(), geofence_radius_m: z.number().int().min(20).max(5000).optional(), working_days: z.array(z.number().int().min(1).max(7)).optional(), settings: z.record(z.string(), z.any()).optional() }));
r('POST', '/branches', ({ ctx, b }) => setup.addBranch(ctx, b), z.object({ name: z.string().min(2), code: z.string().min(1), preset_key: z.enum(['cbse', 'cambridge', 'dual']) }));
r('POST', '/year-rollover', ({ ctx, b }) => setup.yearRollover(ctx, b), z.object({ name: z.string(), starts_on: S.isoDate, ends_on: S.isoDate }));
r('GET', '/config-entities', async ({ ctx }) => Object.fromEntries(Object.entries(setup.CONFIG_ENTITIES).filter(([, v]) => rank(ctx, v.module, 'configure') > 0 || rank(ctx, 'setup', 'configure') > 0).map(([k, v]) => [k, { columns: v.columns, module: v.module, resettable: !!v.area }])));
r('GET', '/config/:entity', ({ ctx, p }) => setup.listConfig(ctx, p.entity!));
r('POST', '/config/:entity', ({ ctx, p, b }) => setup.saveConfig(ctx, p.entity!, b.id, b.data), S.configRowSchema);
r('DELETE', '/config/:entity/:id', ({ ctx, p }) => setup.deleteConfig(ctx, p.entity!, p.id!));
r('POST', '/config/:entity/reset', ({ ctx, p }) => setup.resetConfig(ctx, p.entity!));
r('GET', '/config/:entity/history', ({ ctx, p, q }) => setup.configHistory(ctx, p.entity!, q.id));
r('GET', '/lookups', ({ ctx }) => lookups(ctx));

// ---------------------------------------------------------------- AI school designer (DECISIONS 56-59, docs/designer.md)
// School management (setup.configure, branch scope or wider) or an AutoEd relationship manager inside a support session
// (x-view-as). Read-write support sessions are opened here with a reason and a time limit; only these routes accept
// writes under view-as (every other route stays read-only for support).
const viewAsHeaders = (req: ApiRequest) => ({ viewAs: req.headers['x-view-as'] ?? null, branchId: req.headers['x-branch-id'] ?? null, lang: req.headers['x-lang'] ?? null });
usr('GET', '/designer/whoami', ({ userId, req }) => designer.whoami(userId, viewAsHeaders(req)));
sa('GET', '/designer/clients', ({ userId }) => designer.clientsForRm(userId));
sa('POST', '/designer/support-session', ({ userId, b }) => designer.openSupportSession(userId, b), z.object({ org_id: S.uuid, reason: z.string().trim().min(10).max(500), minutes: z.number().int().min(5).max(240).default(60) }));
sa('POST', '/designer/support-session/end', ({ userId }) => designer.endSupportSession(userId));
dz('GET', '/designer/catalogue', async ({ actor }) => designer.catalogue(actor));
dz('GET', '/designer/templates', async ({ actor }) => designer.templates(actor));
dz('GET', '/designer/explain', ({ actor }) => designer.explain(actor));
dz('GET', '/designer/changesets', ({ actor }) => designer.history(actor));
dz('GET', '/designer/changesets/:id', ({ actor, p }) => designer.get(actor, S.uuid.parse(p.id)));
dz('POST', '/designer/plan', ({ actor, b }) => designer.plan(actor, b), z.object({ prompt: z.string().trim().min(3).max(2000) }), { aiLimited: true });
dz('POST', '/designer/templates/:key/plan', ({ actor, p, b }) => designer.planTemplate(actor, p.key!, b.params ?? {}), z.object({ params: z.record(z.string(), z.any()).default({}) }));
dz('POST', '/designer/changesets/:id/dry-run', ({ actor, p }) => designer.dryRun(actor, S.uuid.parse(p.id)));
dz('POST', '/designer/changesets/:id/publish', ({ actor, p }) => designer.publish(actor, S.uuid.parse(p.id)));
dz('POST', '/designer/changesets/:id/discard', ({ actor, p }) => designer.discard(actor, S.uuid.parse(p.id)));
dz('POST', '/designer/changesets/:id/revert', ({ actor, p }) => designer.revert(actor, S.uuid.parse(p.id)));

// ---------------------------------------------------------------- super admin (Digivate)
sa('GET', '/admin/overview', ({ userId }) => platform.adminOverview(userId));
sa('POST', '/admin/orgs', ({ userId, b }) => platform.createOrganization(userId, b), z.object({ name: z.string().min(2), slug: z.string().regex(/^[a-z0-9-]+$/), preset_key: z.enum(['cbse', 'cambridge', 'dual']), branch_name: z.string().min(2), branch_code: z.string().min(1), admin_name: z.string().min(2), admin_email: z.string().email(), admin_phone: z.string().optional(), plan_key: z.string() }));
sa('POST', '/admin/modules', ({ userId, b }) => platform.adminSetModule(userId, b), S.moduleFlagSchema);
sa('POST', '/admin/topup', ({ userId, b }) => platform.adminTopup(userId, b), S.adminTopupSchema);
sa('POST', '/admin/costs', ({ userId, b }) => platform.adminSetCost(userId, b), z.object({ action: z.string(), credits: z.number().min(0), daily_fair_use: z.number().int().nullable().optional() }));
sa('POST', '/admin/plans', ({ userId, b }) => platform.adminSetPlan(userId, b), z.object({ key: z.string(), name: z.string(), monthly_credits: z.number().min(0), carry_forward: z.boolean(), whatsapp_included: z.number().int().min(0) }));
sa('POST', '/admin/curriculum', ({ userId }) => platform.adminCurriculumUpdate(userId));
sa('POST', '/admin/view-as', ({ userId, b }) => platform.startViewAs(userId, b), S.viewAsSchema);
sa('POST', '/admin/support/:id/close', ({ userId, p }) => platform.closeSupportTicket(userId, p.id!));

/** Dropdown data for forms: staff, sections, subjects, rooms, roles, categories, etc. */
async function lookups(ctx: Ctx) {
  const { run } = await import('../core');
  const { q } = await import('../db');
  return run(ctx, async (c) => ({
    staff: await q(c, `select id, full_name, department_id, wing_id, branch_id, is_teaching from core.staff where org_id = $1 and status in ('active','invited') and deleted_at is null order by full_name`, [ctx.orgId]),
    sections: await q(c, `select se.id, cl.name || ' ' || se.name as name, se.programme_id, cl.wing_id from core.sections se join core.programmes cl on cl.id = se.programme_id where cl.branch_id = $1 and se.deleted_at is null order by cl.seq, se.name`, [ctx.branchId]),
    classes: await q(c, `select id, name, wing_id, level as grade_level from core.programmes where branch_id = $1 and deleted_at is null order by seq`, [ctx.branchId]),
    subjects: await q(c, `select id, name, code, content_language, department_id from core.subjects where org_id = $1 and (branch_id is null or branch_id = $2) and deleted_at is null order by name`, [ctx.orgId, ctx.branchId]),
    wings: await q(c, `select id, name, board from core.wings where branch_id = $1 and deleted_at is null order by seq`, [ctx.branchId]),
    departments: await q(c, `select id, name from core.departments where org_id = $1 and deleted_at is null order by name`, [ctx.orgId]),
    rooms: await q(c, `select id, name, kind as room_type, capacity, qr_token from core.rooms where branch_id = $1 and deleted_at is null order by name`, [ctx.branchId]),
    roles: await q(c, `select id, key, name from os.roles where org_id = $1 and deleted_at is null order by name`, [ctx.orgId]),
    positions: await q(c, `select id, key, name from core.positions where org_id = $1 and deleted_at is null order by rank`, [ctx.orgId]),
    task_categories: await q(c, `select id, key, name, name_i18n, color, default_proof, default_verification from os.task_categories where org_id = $1 and deleted_at is null order by name`, [ctx.orgId]),
    leave_types: await q(c, `select id, key, name, name_i18n, unit, half_day_allowed from core.leave_types where org_id = $1 and active and deleted_at is null order by name`, [ctx.orgId]),
    ticket_categories: await q(c, `select id, key, name, name_i18n from core.ticket_categories where org_id = $1 and deleted_at is null order by name`, [ctx.orgId]),
    exam_types: await q(c, `select id, key, name, '{}'::jsonb as name_i18n from core.exam_types where org_id = $1 and deleted_at is null order by seq`, [ctx.orgId]),
    event_templates: await q(c, `select id, key, name, name_i18n from os.event_templates where org_id = $1 and deleted_at is null`, [ctx.orgId]),
    approval_types: await q(c, `select id, key, name, name_i18n, form_schema, is_system from core.approval_types where org_id = $1 and active and deleted_at is null`, [ctx.orgId]),
    appraisal_cycles: await q(c, `select id, name, released from os.appraisal_cycles where org_id = $1 and deleted_at is null order by starts_on desc`, [ctx.orgId]),
  }));
}

// ---------------------------------------------------------------- dispatch
function bearer(req: ApiRequest): string | null {
  const a = req.headers.authorization;
  if (a?.startsWith('Bearer ')) return a.slice(7);
  return req.headers['x-session'] ?? null;
}

function errorResponse(e: unknown): ApiResponse {
  if (e instanceof ZodError) return { status: 422, json: { error: 'validation_failed', details: e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } };
  const err = e as { status?: number; message?: string; details?: unknown; code?: string };
  if (err.status) return { status: err.status, json: { error: err.message, details: err.details } };
  if (err.code === '42501') {
    if (process.env.DEBUG_API) console.error('[api] 42501', err.message, (e as Error).stack?.split('\n').find((l) => l.includes('/services/')));
    return { status: 403, json: { error: 'forbidden' } };
  }
  if (err.code && process.env.DEBUG_API) console.error('[api] sql', err.code, err.message, (e as Error).stack?.split('\n').find((l) => l.includes('/services/')));
  if (err.code === '23505') return { status: 409, json: { error: 'duplicate' } };
  if (err.code === '23503') return { status: 422, json: { error: 'invalid_reference' } };
  if (err.code === '23514' || err.code === '22P02') return { status: 422, json: { error: 'invalid_value' } };
  console.error('[api] unhandled', e);
  return { status: 500, json: { error: 'internal_error' } };
}

/** Handles one request. `existingCtx` is used by /sync to replay outbox items as the same user. */
export async function dispatch(req: ApiRequest, existingCtx?: Ctx): Promise<ApiResponse> {
  const method = req.method.toUpperCase();
  const path = req.path.replace(/\/+$/, '') || '/';
  let matched: { route: Route; params: Record<string, string> } | null = null;
  for (const route of routes) {
    if (route.method !== method) continue;
    const m = path.match(route.pattern);
    if (!m) continue;
    const params: Record<string, string> = {};
    if (route.keys.length) route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
    else if (m[1]) params['0'] = m[1];
    matched = { route, params };
    break;
  }
  if (!matched) return { status: 404, json: { error: 'not_found' } };
  const { route, params } = matched;
  try {
    const body = route.schema ? route.schema.parse(req.body ?? {}) : req.body;
    if (route.public) {
      const res = await route.public({ p: params, b: body, q: req.query, req });
      if (res && typeof res === 'object' && 'status' in res && typeof (res as ApiResponse).status === 'number' && ('json' in res || 'binary' in res || 'text' in res || 'setSession' in res)) return res as ApiResponse;
      return { status: 200, json: res };
    }
    const session = existingCtx ? { userId: existingCtx.userId } : await verifySession(bearer(req));
    // An admin asked for a new password (or a temporary one was set): nothing but the password routes answer.
    if (!existingCtx && (session as { mustChangePassword?: boolean }).mustChangePassword) return { status: 403, json: { error: 'password_change_required' } };
    if (route.superAdmin) return { status: 200, json: await route.superAdmin({ userId: session.userId, p: params, b: body, q: req.query }) };
    if (route.user) return { status: 200, json: await route.user({ userId: session.userId, p: params, b: body, q: req.query, req }) };
    if (route.designer) {
      if (route.aiLimited && !rateLimit(`ai:${session.userId}`, Number(process.env.AI_RATE_PER_MINUTE ?? 20))) return { status: 429, json: { error: 'rate_limited' } };
      const actor = existingCtx
        ? await designer.designerActor(existingCtx.userId, { branchId: existingCtx.branchId, lang: existingCtx.lang })
        : await designer.designerActor(session.userId, { ...viewAsHeaders(req), device: req.headers['x-device'] ?? req.headers['user-agent']?.slice(0, 120) ?? null });
      return { status: 200, json: (await route.designer({ actor, p: params, b: body, q: req.query })) ?? { ok: true } };
    }
    let userId = session.userId;
    // Super admin "view as": an open support session (core.support_sessions, app.start_support_session), read-only,
    // audited and visible to the school; the screens show the school's director view.
    const viewAs = req.headers['x-view-as'];
    if (viewAs && !existingCtx) {
      await platform.requireSuperAdmin(userId);
      const s = await asUser({ userId }, (c) => maybe<{ org_id: string; open: boolean }>(c, `select org_id, (ended_at is null and expires_at > now()) as open from core.support_sessions where id = $1 and platform_user_id = $2`, [viewAs, userId]));
      if (!s?.open) throw new UnauthorizedError('view_as_expired');
      if (method !== 'GET') return { status: 403, json: { error: 'view_as_is_read_only' } };
      const as = await asUser({ userId }, (c) => maybe<{ user_id: string }>(c, `select s.user_id from core.staff s join os.staff_roles sr on sr.staff_id = s.id join os.roles r on r.id = sr.role_id where s.org_id = $1 and s.user_id is not null and r.key in ('director','chairman','principal') order by case r.key when 'director' then 1 when 'chairman' then 2 else 3 end limit 1`, [s.org_id]));
      if (!as) throw new UnauthorizedError();
      userId = as.user_id;
    }
    if (route.aiLimited && !rateLimit(`ai:${userId}`, Number(process.env.AI_RATE_PER_MINUTE ?? 20))) return { status: 429, json: { error: 'rate_limited' } };
    const ctx = existingCtx ?? (await loadCtx(userId, { branchId: req.headers['x-branch-id'] ?? null, device: req.headers['x-device'] ?? req.headers['user-agent']?.slice(0, 120) ?? null, lang: req.headers['x-lang'] ?? null }));
    // Layer 2 product check (plan 4.3): every OS route needs the OS product for the org AND the user; /me answers
    // anyway so the app can show "not part of your plan" instead of failing.
    if (!PRODUCT_FREE.has(`${method} ${route.pattern.source}`)) needProduct(ctx, 'os');
    const out = await route.handler!({ ctx, p: params, b: body, q: req.query, req });
    if (out && typeof out === 'object' && 'binary' in (out as object) && 'status' in (out as object)) return out as ApiResponse;
    return { status: 200, json: out ?? { ok: true } };
  } catch (e) {
    return errorResponse(e);
  }
}

export const routeCount = () => routes.length;
