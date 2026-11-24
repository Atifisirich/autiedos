/**
 * The CRM HTTP API, framework-free like packages/server/src/api: one `handle(req)` that the web app, the mobile app
 * and the scheduler call (mounted by the host under /api/crm). Three kinds of route:
 *
 *   public     no session; authorised by an unguessable key (Meta webhook key, form slug, parent link token, API key)
 *              or by CRON_SECRET. They resolve the key to an org with crm.resolve_public and run as the org's
 *              automation user (db.ts), only while the org has the CRM.
 *   staff      Authorization: Bearer <platform session>; the person's CRM role decides what they may do and, for
 *              reads, the row policies decide which records they see.
 *   v1 (keys)  Authorization: Bearer <API key> from core.api_keys (product crm), 120 requests / minute / key through
 *              the platform's app.rate_limit_hit.
 *
 * The screens (apps/web) are ported later against this surface; the contract here is the old server actions' logic.
 */
import { asSystem, asUser, type Db, ForbiddenError, NotFoundError, OrgInactiveError, resolvePublic, UnauthorizedError, ValidationError, type Row } from '../db';
import { requireCtx, verifySession } from '../auth';
import { addTask, captureEnquiry, changeStage, completeTask, emit, findHousehold, getEnquiry, logActivity, receiveMessage, sendMessage, assignOwner } from '../core';
import { APPLICATION_SECTIONS, confirmAdmission, saveApplication, settlePayment, startApplication } from '../admissions';
import { handleMetaWebhook, verifySignature } from '../meta';
import { getSecret } from '../secrets';
import { runDueJobs } from '../jobs';
import { findEnquiry, leadIds, listLeads, countLeads, pipeline, type SP } from '../leads';
import { type Perms, canCreateLeads, canEditApplications, canEditLeads, canMessage, canTakePayment, has } from '../perm';
import { hashKey } from '../util';

export interface ApiRequest {
  method: string;
  path: string; // e.g. /leads/123/stage (without the mount prefix)
  query: Record<string, string>;
  headers: Record<string, string | undefined>;
  body: unknown;
  rawBody?: string;
  ip?: string;
}
export interface ApiResponse {
  status: number;
  json?: unknown;
  text?: { body: string; contentType: string };
}

type Handler = (a: { req: ApiRequest; p: Record<string, string>; b: any }) => Promise<ApiResponse | unknown>;
interface Route { method: string; pattern: RegExp; keys: string[]; handler: Handler }
const routes: Route[] = [];
function on(method: string, path: string, handler: Handler) {
  const keys: string[] = [];
  const pattern = new RegExp(`^${path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)'))}$`);
  routes.push({ method, pattern, keys, handler });
}
const bearer = (req: ApiRequest) => (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
const ok = (json: unknown, status = 200): ApiResponse => ({ status, json });
const str = (v: unknown) => String(v ?? '').trim();

// ---------------------------------------------------------------- public
on('GET', '/health', async () => ({ ok: true }));

/** Scheduler entry: queue the per-org sweep, claim due CRM jobs, run them. Needs CRON_SECRET. */
const cron: Handler = async ({ req }) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || bearer(req) !== secret) return { status: 401, json: { error: 'not_allowed' } };
  return runDueJobs();
};
on('GET', '/cron/crm', cron);
on('POST', '/cron/crm', cron);

// Meta (WhatsApp + lead ads) for the school's own app. One URL per org: /webhooks/meta/<webhook_key>.
on('GET', '/webhooks/meta/:key', async ({ req, p }) => {
  const t = /^[a-f0-9]{32}$/.test(p.key!) ? await resolvePublic('webhook', p.key!) : null;
  const expected = t ? await asSystem(t.orgId, (db) => getSecret(db, 'meta_verify_token')) : null;
  if (t && expected && req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === expected) return { status: 200, text: { body: req.query['hub.challenge'] ?? '', contentType: 'text/plain' } };
  return { status: 403, text: { body: 'Verification failed', contentType: 'text/plain' } };
});
on('POST', '/webhooks/meta/:key', async ({ req, p }) => {
  const t = /^[a-f0-9]{32}$/.test(p.key!) ? await resolvePublic('webhook', p.key!) : null;
  if (!t) return { status: 404, text: { body: 'Unknown endpoint', contentType: 'text/plain' } };
  const raw = req.rawBody ?? JSON.stringify(req.body ?? {});
  const appSecret = await asSystem(t.orgId, (db) => getSecret(db, 'meta_app_secret'));
  if (!verifySignature(raw, req.headers['x-hub-signature-256'] ?? null, appSecret)) return { status: 401, text: { body: 'Bad signature', contentType: 'text/plain' } };
  let payload: Row;
  try { payload = JSON.parse(raw); } catch { return { status: 400, text: { body: 'Bad JSON', contentType: 'text/plain' } }; }
  try {
    const log = await asSystem(t.orgId, (db) => handleMetaWebhook(db, payload));
    return ok({ ok: true, handled: log.length });
  } catch (e) {
    console.error('meta webhook failed', e);
    // A 500 makes Meta retry later, which is what we want for a transient database problem.
    return { status: 500, text: { body: 'Temporary error', contentType: 'text/plain' } };
  }
});

// Hosted enquiry form (slug is the key). Spam guard: bots fill the hidden field, no person submits within two seconds.
on('POST', '/forms/:slug/submit', async ({ p, b }) => {
  if (str(b.website) || Date.now() - Number(str(b.loaded)) < 2000) return { message: 'Thank you.' };
  const form = await resolvePublic('form', p.slug!);
  if (!form) return { status: 422, json: { ok: false, error: 'This form is no longer accepting enquiries. Please contact the school.' } };
  if (!b.consent) return { status: 422, json: { ok: false, error: 'Please tick the box to let the school contact you.' } };
  return asSystem(form.orgId, async (db) => {
    const f = (await db.one('select * from crm.forms where id = $1', [form.refId]))!;
    const branch = await db.one('select id from core.branches where org_id = $1 and (id::text = $2 or $2 = $3) and active order by name limit 1', [form.orgId, f.branch_id ?? str(b.branch), '']);
    if (!branch) return { status: 422, json: { ok: false, error: 'Please choose a campus.' } };
    const res = await captureEnquiry(db, {
      studentName: str(b.student_name), guardianName: str(b.guardian_name), mobile: str(b.mobile), email: str(b.email) || undefined, grade: str(b.grade) || undefined, dob: str(b.dob) || undefined,
      locality: str(b.locality) || undefined, heardAbout: str(b.heard_about) || undefined, branchId: branch.id, sourceId: f.source_id ?? undefined, channel: 'Website', source: f.name,
      campaign: b.utm?.utm_campaign, utm: b.utm ?? {}, consent: { source: `Web form: ${f.name}`, wording: 'form-v1' },
    });
    if (!res.ok) return { status: 422, json: res };
    await db.q('update crm.forms set submissions = submissions + 1 where id = $1', [f.id]);
    return { ok: true, message: f.thank_you };
  });
});

// Parent application link (enquiry public_token is the key).
on('GET', '/apply/:token', async ({ p }) => {
  const e = await resolvePublic('enquiry', p.token!);
  if (!e) throw new NotFoundError('link_not_valid');
  return asSystem(e.orgId, async (db) => {
    const enq = (await getEnquiry(db, e.refId))!;
    const app = await db.one('select answers, progress, status from crm.applications where enquiry_id = $1', [e.refId]);
    return { student: enq.student_name, grade: enq.grade, sections: APPLICATION_SECTIONS, application: app };
  });
});
on('POST', '/apply/:token', async ({ p, b }) => {
  const e = await resolvePublic('enquiry', p.token!);
  if (!e) return { status: 404, json: { ok: false, error: 'This link is not valid any more. Please ask the school for a new one.' } };
  return asSystem(e.orgId, async (db) => {
    await startApplication(db, e.refId, null);
    const answers = Object.fromEntries(APPLICATION_SECTIONS.flatMap((s) => s.fields).filter((f) => b[f.key] !== undefined).map((f) => [f.key, str(b[f.key])]));
    return saveApplication(db, e.refId, answers, { submit: b.submit === true || b.submit === '1', declaration: !!b.declaration }, null);
  });
});
// Demo checkout: only with DEMO_PAYMENTS=1, because it lets the payer declare the result. A real gateway calls settlePayment from its verified webhook.
on('POST', '/pay/:token', async ({ p, b }) => {
  if (process.env.DEMO_PAYMENTS !== '1') return { status: 403, json: { error: 'demo_payments_disabled' } };
  const pay = await resolvePublic('payment', p.token!);
  if (!pay) throw new NotFoundError('link_not_valid');
  return asSystem(pay.orgId, (db) => settlePayment(db, pay.refId, b.result === 'success', null, 'DEMO-' + Date.now()));
});

// ---------------------------------------------------------------- v1 (API keys)
async function viaKey(req: ApiRequest) {
  const raw = bearer(req);
  if (!raw) throw new UnauthorizedError('Send your API key as: Authorization: Bearer <key>');
  const key = await resolvePublic('api_key', hashKey(raw));
  if (!key) throw new UnauthorizedError('This API key is not valid or was revoked.');
  const allowed = await asSystem(key.orgId, async (db) => {
    const hit = (await db.one('select app.rate_limit_hit($1, 120, 60, $2) as ok', [`crm-api:${key.refId}`, key.orgId]))!.ok as boolean;
    if (hit) await db.q('update core.api_keys set last_used_at = now() where id = $1', [key.refId]);
    return hit;
  });
  if (!allowed) throw Object.assign(new Error('Rate limit reached: 120 requests per minute per key.'), { status: 429 });
  return key;
}
const idem = new Map<string, unknown>();

on('POST', '/v1/enquiries', async ({ req, b }) => {
  const key = await viaKey(req);
  const ik = req.headers['idempotency-key'];
  if (ik && idem.has(key.refId + ik)) return idem.get(key.refId + ik);
  return asSystem(key.orgId, async (db) => {
    const branch = await db.one('select id from core.branches where org_id = $1 and active and (id::text = $2 or lower(name) = lower($2) or $2 = $3) order by name limit 1', [key.orgId, str(b.branch_id ?? b.branch), '']);
    if (!branch) return { status: 422, json: { error: 'Unknown branch. Send branch (name) or branch_id.' } };
    const res = await captureEnquiry(db, {
      studentName: str(b.student_name), guardianName: str(b.guardian_name), mobile: str(b.mobile), email: b.email, altMobile: b.alt_mobile, grade: b.grade, board: b.board, dob: b.dob, locality: b.locality,
      branchId: branch.id, sourceId: key.sourceId ?? undefined, channel: b.channel ?? 'API', source: b.source ?? key.name ?? 'API', campaign: b.campaign ?? b.utm?.campaign, utm: b.utm ?? {}, heardAbout: b.heard_about, custom: b.custom,
      consent: { source: b.consent_source ?? `API key: ${key.name}` }, note: b.note,
    });
    if (!res.ok) return { status: 422, json: { error: res.error } };
    const out = { status: res.status, enquiry_id: res.enquiryId, household_id: res.householdId, owner: res.ownerName };
    if (ik) idem.set(key.refId + ik, ok(out, res.status === 'created' ? 201 : 200));
    return ok(out, res.status === 'created' ? 201 : 200);
  });
});

/** List enquiries, newest first, with cursor pagination. Sensitive custom fields show only their placeholder. */
on('GET', '/v1/enquiries', async ({ req }) => {
  const key = await viaKey(req);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  return asSystem(key.orgId, async (db) => {
    const rows = await db.q(
      `select e.id, e.household_id, st.full_name as student_name, e.grade, e.board, s.name as stage, p.name as phase, u.full_name as owner, b.name as branch, y.name as academic_year, e.score, e.temperature, e.custom, e.tags, e.application_no, e.created_at, e.updated_at
         from crm.enquiries e join crm.prospects st on st.org_id = e.org_id and st.id = e.prospect_id join crm.stages s on s.org_id = e.org_id and s.id = e.stage_id join crm.phases p on p.org_id = s.org_id and p.id = s.phase_id
         left join core.staff u on u.org_id = e.org_id and u.user_id = e.owner_id join core.branches b on b.org_id = e.org_id and b.id = e.branch_id join core.academic_years y on y.org_id = e.org_id and y.id = e.academic_year_id
        where e.org_id = $1 and ($2::timestamptz is null or e.created_at < $2) order by e.created_at desc limit $3`,
      [key.orgId, req.query.cursor ?? null, limit + 1],
    );
    const page = rows.slice(0, limit);
    return { data: page, next_cursor: rows.length > limit ? new Date(page[page.length - 1]!.created_at).toISOString() : null };
  });
});

/** Missed inbound call from a telephony provider (CAP-06). */
on('POST', '/v1/calls/missed', async ({ req, b }) => {
  const key = await viaKey(req);
  if (!b?.mobile) return { status: 422, json: { error: 'Send mobile.' } };
  return asSystem(key.orgId, async (db) => {
    const hit = await findHousehold(db, { mobile: b.mobile });
    let enquiryId: string, householdId: string;
    if (hit) {
      householdId = hit.household_id;
      enquiryId = (await db.one('select e.id from crm.enquiries e join crm.stages s on s.org_id = e.org_id and s.id = e.stage_id where e.org_id = $1 and e.household_id = $2 order by s.is_closed, e.created_at desc limit 1', [key.orgId, householdId]))!.id;
    } else {
      const branch = (await db.one("select b.id from core.branches b where b.org_id = $1 and b.active and ($2 = '' or b.phone = $2) order by b.name limit 1", [key.orgId, str(b.called_number)])) ?? (await db.one('select id from core.branches where org_id = $1 and active order by name limit 1', [key.orgId]));
      const res = await captureEnquiry(db, { studentName: 'Name not given yet', guardianName: 'Caller', mobile: b.mobile, branchId: branch!.id, channel: 'Phone', source: 'Inbound call', consent: { source: 'Parent called the school' } });
      if (!res.ok) return { status: 422, json: { error: res.error } };
      enquiryId = res.enquiryId;
      householdId = res.householdId;
    }
    await logActivity(db, { householdId, enquiryId, type: 'call', outcome: 'missed_inbound', content: 'Missed call from the parent.' });
    await addTask(db, { enquiryId, title: 'Urgent: return missed call', dueAt: new Date(Date.now() + 10 * 60000), priority: 'high' });
    await emit(db, 'missed_call', enquiryId);
    return { household_id: householdId, enquiry_id: enquiryId, new_household: !hit };
  });
});

/** Inbound parent message from a messaging provider. An unknown number starts a new enquiry (CAP-05). */
on('POST', '/v1/messages/inbound', async ({ req, b }) => {
  const key = await viaKey(req);
  if (!b?.mobile || !b?.body) return { status: 422, json: { error: 'Send mobile and body.' } };
  return asSystem(key.orgId, async (db) => {
    let hh = (await findHousehold(db, { mobile: b.mobile }))?.household_id as string | undefined;
    let created = false;
    if (!hh) {
      const branch = await db.one('select id from core.branches where org_id = $1 and active order by name limit 1', [key.orgId]);
      const res = await captureEnquiry(db, { studentName: b.student_name ?? 'Name not given yet', guardianName: b.name ?? 'Parent', mobile: b.mobile, branchId: branch!.id, channel: 'WhatsApp', source: 'School WhatsApp number', consent: { source: 'Parent messaged the school first' } });
      if (!res.ok) return { status: 422, json: { error: res.error } };
      hh = res.householdId;
      created = true;
    }
    await receiveMessage(db, hh, b.channel === 'sms' ? 'sms' : 'whatsapp', String(b.body));
    return { household_id: hh, new_household: created };
  });
});

// ---------------------------------------------------------------- staff
on('GET', '/me', async ({ req }) => {
  const ctx = await requireCtx((await verifySession(bearer(req))).userId);
  return { user: ctx.user, org: { id: ctx.orgId, name: ctx.org.name }, role: { key: ctx.roleKey, name: ctx.roleName, permissions: ctx.perms }, branches: ctx.branches, years: ctx.years };
});

on('GET', '/leads', async ({ req }) => {
  const s = await verifySession(bearer(req));
  const ctx = await requireCtx(s.userId, { yearId: req.query.yearId, branchId: req.query.branchId });
  return asUser(s.userId, ctx.orgId, async (db) => {
    const sp: SP = req.query;
    return { data: await listLeads(db, ctx, sp, Math.min(200, Number(req.query.limit) || 100), Number(req.query.offset) || 0), total: await countLeads(db, ctx, sp), pipeline: await pipeline(db), ids: req.query.ids_only ? await leadIds(db, ctx, sp) : undefined };
  });
});

on('POST', '/leads', async ({ req, b }) => {
  const s = await verifySession(bearer(req));
  const ctx = await requireCtx(s.userId);
  if (!canCreateLeads(ctx.perms)) throw new ForbiddenError('Your role does not allow this action.');
  // Capture sees the whole org (duplicate and sibling detection, sticky owner) so it runs as the automation user;
  // the person's own permission was checked above and they are recorded as the actor.
  return asSystem(ctx.orgId, (db) => captureEnquiry(db, { ...b, preferOwnerId: ctx.user.id }, { id: ctx.user.id, name: ctx.user.name }));
});

/** Runs a mutation on an enquiry the caller can see and edit (row policies decide), as the automation user. */
async function onEnquiry<T>(req: ApiRequest, enquiryId: string, need: (p: Perms) => boolean, fn: (db: Db, actor: { id: string; name: string }) => Promise<T>): Promise<T> {
  const s = await verifySession(bearer(req));
  const ctx = await requireCtx(s.userId);
  if (!need(ctx.perms)) throw new ForbiddenError('Your role does not allow this action.');
  await asUser(s.userId, ctx.orgId, (db) => findEnquiry(db, enquiryId)); // throws unless the row is visible to this person
  return asSystem(ctx.orgId, (db) => fn(db, { id: ctx.user.id, name: ctx.user.name }));
}

on('POST', '/leads/:id/stage', ({ req, p, b }) => onEnquiry(req, p.id!, canEditLeads, (db, actor) => changeStage(db, p.id!, b.stageId, actor, { closure_reason: b.closure_reason, expected_decision: b.expected_decision, note: b.note })));
on('POST', '/leads/:id/message', ({ req, p, b }) =>
  onEnquiry(req, p.id!, canMessage, async (db, actor) => {
    const e = await getEnquiry(db, p.id!);
    return sendMessage(db, { householdId: e!.household_id, enquiryId: p.id!, channel: b.channel, body: b.body, actorId: actor.id });
  }));
on('POST', '/leads/:id/application', ({ req, p, b }) =>
  onEnquiry(req, p.id!, canEditApplications, async (db, actor) => {
    await startApplication(db, p.id!, actor);
    return saveApplication(db, p.id!, b.answers ?? {}, { submit: !!b.submit, declaration: !!b.declaration, overrideAge: !!b.overrideAge }, actor);
  }));
on('POST', '/leads/:id/admission', ({ req, p, b }) => onEnquiry(req, p.id!, (perms) => canEditApplications(perms) && has(perms, 'applications'), (db, actor) => confirmAdmission(db, p.id!, actor, !!b?.allowOverCapacity)));
on('POST', '/payments/:id/settle', async ({ req, p, b }) => {
  const s = await verifySession(bearer(req));
  const ctx = await requireCtx(s.userId);
  if (!canTakePayment(ctx.perms)) throw new ForbiddenError('Your role does not allow this action.');
  const pay = await asUser(s.userId, ctx.orgId, (db) => db.one('select id from crm.payments where id = $1', [p.id]));
  if (!pay) throw new NotFoundError();
  return asSystem(ctx.orgId, (db) => settlePayment(db, p.id!, b.success !== false, { id: ctx.user.id, name: ctx.user.name }, b.reference));
});
on('POST', '/tasks/:id/complete', async ({ req, p, b }) => {
  const s = await verifySession(bearer(req));
  const ctx = await requireCtx(s.userId);
  const t = await asUser(s.userId, ctx.orgId, (db) => db.one('select id from crm.follow_ups where id = $1', [p.id]));
  if (!t) throw new NotFoundError();
  return asSystem(ctx.orgId, (db) => completeTask(db, p.id!, { id: ctx.user.id, name: ctx.user.name }, str(b.outcome)));
});
on('POST', '/assignment/simulate', async ({ req, b }) => {
  const s = await verifySession(bearer(req));
  const ctx = await requireCtx(s.userId);
  if (!has(ctx.perms, 'admin')) throw new ForbiddenError('Your role does not allow this action.');
  return asSystem(ctx.orgId, (db) => assignOwner(db, { branchId: b.branchId, board: b.board, grade: b.grade, channel: b.channel }, true));
});

// ---------------------------------------------------------------- dispatcher
export async function handle(req: ApiRequest): Promise<ApiResponse> {
  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.pattern.exec(req.path);
      if (!m) continue;
      const p: Record<string, string> = {};
      r.keys.forEach((k, i) => (p[k] = decodeURIComponent(m[i + 1]!)));
      const out = (await r.handler({ req, p, b: (req.body ?? {}) as any })) as ApiResponse | unknown;
      if (out && typeof out === 'object' && 'status' in out && ('json' in out || 'text' in out)) return out as ApiResponse;
      return { status: 200, json: out };
    }
    return { status: 404, json: { error: 'not_found' } };
  } catch (e) {
    const err = e as { status?: number; message?: string };
    if (e instanceof OrgInactiveError) return { status: 403, json: { error: 'crm_not_active' } };
    const status = e instanceof ValidationError || e instanceof ForbiddenError || e instanceof NotFoundError || e instanceof UnauthorizedError ? err.status! : (err.status ?? 500);
    if (status >= 500) console.error('crm api error', e);
    return { status, json: { error: status >= 500 ? 'server_error' : (err.message ?? 'error') } };
  }
}
