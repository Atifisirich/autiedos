// Application, documents, payments and admission confirmation (PRD 7.9 - 7.11).
// Ported from autoedcrm lib/admissions.ts. Used by staff actions and by the parent-facing public pages (which run
// as the org's automation user), so it takes a Db bound to an org, not a session.
// Admission: confirmAdmission moves the enquiry to its "Admission confirmed" stage; changeStage then calls
// core.admit_student in the same transaction (decision 38), so a confirmed enquiry always has its core student.
import { type Db, type Row } from './db';
import { addTask, changeStage, emit, getEnquiry, logActivity, needsNextAction, stageByName, tenantSettings, type Actor } from './core';

export const APPLICATION_SECTIONS: { title: string; fields: { key: string; label: string; required?: boolean; type?: string; options?: string[] }[] }[] = [
  { title: 'Student', fields: [
    { key: 'previous_school', label: 'Current / previous school' }, { key: 'previous_grade', label: 'Current grade' },
    { key: 'mother_tongue', label: 'Mother tongue', required: true }, { key: 'medical', label: 'Medical conditions or allergies (write None if none)', required: true },
  ] },
  { title: 'Parents', fields: [
    { key: 'father_name', label: "Father's name", required: true }, { key: 'father_occupation', label: "Father's occupation" },
    { key: 'mother_name', label: "Mother's name", required: true }, { key: 'mother_occupation', label: "Mother's occupation" },
  ] },
  { title: 'Address and transport', fields: [
    { key: 'address', label: 'Home address', required: true }, { key: 'pincode', label: 'PIN code', required: true },
    { key: 'transport', label: 'School transport needed?', type: 'select', options: ['Yes', 'No', 'Not sure'], required: true },
  ] },
];
const REQUIRED = APPLICATION_SECTIONS.flatMap((s) => s.fields.filter((f) => f.required).map((f) => f.key));

/** Atomically takes the next application / receipt number from core.number_series (OQ-16). */
export async function nextNumber(db: Db, key: 'crm_application' | 'crm_receipt', yearId?: string): Promise<string> {
  return (await db.one('select crm.next_number($1, $2) as n', [key, yearId ?? null]))!.n as string;
}

async function advance(db: Db, enquiryId: string, from: string[], to: string, actor: Actor) {
  const e = await getEnquiry(db, enquiryId);
  const st = await stageByName(db, to);
  if (e && st && from.includes(e.stage_name)) await changeStage(db, enquiryId, st.id, actor);
}

export const progressOf = (answers: Row) => Math.round((REQUIRED.filter((k) => String(answers[k] ?? '').trim()).length / REQUIRED.length) * 100);

export async function startApplication(db: Db, enquiryId: string, actor: Actor): Promise<Row> {
  const org = db.requireOrg();
  const existing = await db.one('select * from crm.applications where org_id = $1 and enquiry_id = $2', [org, enquiryId]);
  if (existing) return existing;
  const e = await getEnquiry(db, enquiryId);
  if (!e) throw new Error('Enquiry not found');
  const s = await tenantSettings(db);
  const hh = await db.one('select address, pincode from crm.households where id = $1', [e.household_id]);
  const st = await db.one('select current_school, current_grade from crm.prospects where id = $1', [e.prospect_id]);
  // APP-02: prefill from what the school already knows.
  const answers = { address: hh?.address ?? '', pincode: hh?.pincode ?? '', previous_school: st?.current_school ?? '', previous_grade: st?.current_grade ?? '', transport: e.custom?.transport_required ?? '' };
  const app = await db.insert('crm.applications', { enquiry_id: enquiryId, answers, progress: progressOf(answers) });
  if (!e.application_no) await db.q('update crm.enquiries set application_no = $2 where id = $1', [enquiryId, await nextNumber(db, 'crm_application', e.academic_year_id)]);
  for (const type of (s.doc_types ?? []) as string[]) await db.insert('crm.enquiry_documents', { enquiry_id: enquiryId, type });
  await logActivity(db, { householdId: e.household_id, enquiryId, type: 'form', outcome: 'started', actorId: actor?.id, content: actor ? `Application started by ${actor.name} (assisted).` : 'Application form started by the parent.' });
  const stage = await stageByName(db, 'Form started');
  if (stage && ['prospect', 'enquiry', 'visit'].includes(e.phase_key)) await changeStage(db, enquiryId, stage.id, actor);
  await emit(db, 'form_started', enquiryId);
  return app;
}

/** Age on the programme's cut-off date against its minimum age (APP-06). Null means eligible or not checkable. */
export async function ageIssue(db: Db, e: Row): Promise<string | null> {
  const st = await db.one('select dob::text as dob from crm.prospects where id = $1', [e.prospect_id]);
  const pr = await db.one(
    `select i.min_age_years, i.age_cutoff::text as cutoff from crm.intakes i join core.programmes p on p.org_id = i.org_id and p.id = i.programme_id
      where i.org_id = $1 and i.academic_year_id = $2 and p.name = $3 and (p.branch_id is null or p.branch_id = $4) order by p.branch_id nulls last limit 1`,
    [db.requireOrg(), e.academic_year_id, e.grade, e.branch_id],
  );
  if (!st?.dob || !pr?.cutoff || pr.min_age_years == null) return null;
  const years = (new Date(pr.cutoff).getTime() - new Date(st.dob).getTime()) / (365.25 * 86400e3);
  return years < Number(pr.min_age_years) ? `The child will be ${years.toFixed(1)} years old on the cut-off date; ${e.grade} needs ${pr.min_age_years} years.` : null;
}

export async function saveApplication(db: Db, enquiryId: string, answers: Row, opts: { submit: boolean; declaration: boolean; overrideAge?: boolean }, actor: Actor): Promise<{ ok: boolean; error?: string }> {
  const org = db.requireOrg();
  const app = await db.one('select * from crm.applications where org_id = $1 and enquiry_id = $2', [org, enquiryId]);
  if (!app) return { ok: false, error: 'Start the application first.' };
  if (app.status === 'submitted') return { ok: false, error: 'This application is already submitted.' };
  const merged = { ...app.answers, ...answers };
  const progress = progressOf(merged);
  const e = (await getEnquiry(db, enquiryId))!;
  if (opts.submit) {
    if (progress < 100) return { ok: false, error: 'Some required answers are missing. They are marked on the form.' };
    if (!opts.declaration) return { ok: false, error: 'Please tick the declaration to submit.' };
    const issue = await ageIssue(db, e);
    if (issue && !opts.overrideAge) return { ok: false, error: issue + (actor ? ' Someone with override permission can still submit.' : ' Please speak to the admissions office.') };
  }
  await db.update('crm.applications', app.id, { answers: merged, progress, ...(opts.submit ? { status: 'submitted', declaration: true, submitted_at: new Date() } : {}) });
  if (merged.address) await db.q('update crm.households set address = $2, pincode = $3 where id = $1', [e.household_id, merged.address, merged.pincode ?? null]);
  if (opts.submit) {
    await logActivity(db, { householdId: e.household_id, enquiryId, type: 'form', outcome: 'submitted', actorId: actor?.id, content: 'Application form submitted with declaration.' });
    const stage = await stageByName(db, 'Form submitted');
    if (stage && e.stage_name === 'Form started') await changeStage(db, enquiryId, stage.id, actor);
    const s = await tenantSettings(db);
    if (!(await db.one("select 1 from crm.payments where org_id = $1 and enquiry_id = $2 and purpose = 'Registration fee'", [org, enquiryId]))) {
      await db.insert('crm.payments', { enquiry_id: enquiryId, purpose: 'Registration fee', amount: s.fees?.registration ?? 1500 });
    }
    if (await needsNextAction(db, enquiryId)) await addTask(db, { enquiryId, title: 'Review the submitted application', dueAt: new Date(Date.now() + 4 * 3600e3) });
    await emit(db, 'form_submitted', enquiryId);
  }
  return { ok: true };
}

/** Marks a payment paid or failed, issues the receipt and moves the stage (FEE-03, FEE-04). */
export async function settlePayment(db: Db, paymentId: string, success: boolean, actor: Actor, reference?: string): Promise<Row | null> {
  const org = db.requireOrg();
  const p = await db.one('select * from crm.payments where org_id = $1 and id = $2', [org, paymentId]);
  if (!p || p.status === 'paid') return p;
  const e = (await getEnquiry(db, p.enquiry_id))!;
  const amount = '₹' + new Intl.NumberFormat('en-IN').format(Number(p.amount));
  if (!success) {
    await db.update('crm.payments', paymentId, { status: 'failed' });
    await logActivity(db, { householdId: e.household_id, enquiryId: e.id, type: 'payment', outcome: 'failed', content: `${p.purpose} payment of ${amount} did not go through. No money was taken. The parent can retry from the same link.` });
    await emit(db, 'payment_failed', e.id);
    return db.one('select * from crm.payments where id = $1', [paymentId]);
  }
  const receipt = await nextNumber(db, 'crm_receipt');
  await db.update('crm.payments', paymentId, { status: 'paid', receipt_no: receipt, paid_at: new Date(), verified_by: actor?.id ?? null, reference: reference ?? p.reference });
  await logActivity(db, { householdId: e.household_id, enquiryId: e.id, type: 'payment', outcome: 'paid', actorId: actor?.id, content: `${p.purpose} of ${amount} received. Receipt ${receipt}.` });
  if (p.purpose === 'Registration fee') await advance(db, e.id, ['Form submitted', 'Form started'], 'Fee paid', actor);
  return db.one('select * from crm.payments where id = $1', [paymentId]);
}

export async function checklist(db: Db, enquiryId: string): Promise<{ label: string; done: boolean }[]> {
  const org = db.requireOrg();
  const fee = await db.one("select 1 from crm.payments where org_id = $1 and enquiry_id = $2 and purpose = 'Admission fee' and status = 'paid'", [org, enquiryId]);
  const docs = await db.one("select count(*)::int total, count(*) filter (where status = 'verified')::int ok from crm.enquiry_documents where org_id = $1 and enquiry_id = $2", [org, enquiryId]);
  const app = await db.one('select declaration, status from crm.applications where org_id = $1 and enquiry_id = $2', [org, enquiryId]);
  return [
    { label: 'Application submitted with signed declaration', done: app?.status === 'submitted' && app.declaration },
    { label: `Documents verified (${docs!.ok} of ${docs!.total})`, done: docs!.total > 0 && docs!.ok === docs!.total },
    { label: 'Admission fee paid', done: !!fee },
  ];
}

export async function seatUse(db: Db, branchId: string, yearId: string, grade: string | null): Promise<{ capacity: number; confirmed: number } | null> {
  const org = db.requireOrg();
  const pr = await db.one(
    `select i.capacity from crm.intakes i join core.programmes p on p.org_id = i.org_id and p.id = i.programme_id
      where i.org_id = $1 and i.academic_year_id = $2 and p.name = $3 and (p.branch_id is null or p.branch_id = $4) order by p.branch_id nulls last limit 1`,
    [org, yearId, grade, branchId],
  );
  if (!pr) return null;
  const c = await db.one(
    'select count(*)::int n from crm.enquiries e join crm.stages s on s.org_id = e.org_id and s.id = e.stage_id where e.org_id = $1 and e.branch_id = $2 and e.academic_year_id = $3 and e.grade = $4 and s.is_won',
    [org, branchId, yearId, grade],
  );
  return { capacity: pr.capacity, confirmed: c!.n };
}

/** ENR-01: one action, allowed only when the checklist is complete and a seat is free. */
export async function confirmAdmission(db: Db, enquiryId: string, actor: Actor, allowOverCapacity = false): Promise<{ ok: boolean; error?: string; admission?: Row }> {
  const e = await getEnquiry(db, enquiryId);
  if (!e) return { ok: false, error: 'Record not found.' };
  const missing = (await checklist(db, enquiryId)).filter((c) => !c.done);
  if (missing.length) return { ok: false, error: 'Not ready to confirm. Still pending: ' + missing.map((m) => m.label).join('; ') + '.' };
  const seats = await seatUse(db, e.branch_id, e.academic_year_id, e.grade);
  if (seats && seats.confirmed >= seats.capacity && !allowOverCapacity) return { ok: false, error: `${e.grade} is full (${seats.confirmed} of ${seats.capacity} seats). A group admin can confirm above capacity.` };
  const st = await stageByName(db, 'Admission confirmed');
  if (!st) return { ok: false, error: 'The pipeline has no "Admission confirmed" stage.' };
  return changeStage(db, enquiryId, st.id, actor);
}
