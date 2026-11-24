/**
 * Public pages' data: the hosted enquiry form, the parent's application page (form, documents, fees) and the payment
 * link. No session: each is authorised by an unguessable key and runs as the org's automation user. The POST handlers
 * (form submit, application save, demo payment) are in index.ts next to the other key-authorised routes.
 */
import { asSystem, NotFoundError, resolvePublic } from '../db';
import { APPLICATION_SECTIONS } from '../admissions';
import { getEnquiry, logActivity } from '../core';
import { publicUrl } from '../util';
import { on, str } from './router';

const color = (s: { brand_color?: string } | null | undefined) => s?.brand_color ?? '#0f6e6e';

on('GET', '/forms/:slug', async ({ p, req }) => {
  const form = await resolvePublic('form', p.slug!);
  if (!form) throw new NotFoundError('form_not_found');
  return asSystem(form.orgId, async (db) => {
    const f = (await db.one('select * from crm.forms where id = $1', [form.refId]))!;
    const org = (await db.one('select o.name, s.settings from core.organizations o join crm.settings s on s.org_id = o.id where o.id = $1', [form.orgId]))!;
    const branches = f.branch_id ? [] : await db.q('select id, name from core.branches where org_id = $1 and active order by name', [form.orgId]);
    const utm = Object.fromEntries(Object.entries(req.query).filter(([k, v]) => v && (k.startsWith('utm_') || ['gclid', 'fbclid'].includes(k))));
    return {
      school: org.name, color: color(org.settings), fields: f.fields, grades: org.settings.grades ?? [], branches, utm,
      notice: org.settings.privacy_notice ?? 'We use these details only to respond to your admission enquiry. You can ask us to correct or delete them at any time.',
    };
  });
});

on('GET', '/pay/:token', async ({ p }) => {
  const pay = await resolvePublic('payment', p.token!);
  if (!pay) throw new NotFoundError('link_not_valid');
  return asSystem(pay.orgId, async (db) => {
    const x = (await db.one(
      `select p.purpose, p.amount, p.status, p.receipt_no, p.paid_at, st.full_name as student, o.name as school, s.settings
         from crm.payments p join crm.enquiries e on e.org_id = p.org_id and e.id = p.enquiry_id join crm.prospects st on st.org_id = e.org_id and st.id = e.prospect_id
         join core.organizations o on o.id = p.org_id join crm.settings s on s.org_id = p.org_id where p.id = $1`,
      [pay.refId],
    ))!;
    return { purpose: x.purpose, amount: x.amount, status: x.status, receipt_no: x.receipt_no, paid_at: x.paid_at, student: x.student, school: x.school, color: color(x.settings), demo: process.env.DEMO_PAYMENTS === '1' };
  });
});

/** The parent's whole application page in one call: prefilled answers, documents, fees. */
on('GET', '/apply/:token/page', async ({ p }) => {
  const e = await resolvePublic('enquiry', p.token!);
  if (!e) throw new NotFoundError('link_not_valid');
  return asSystem(e.orgId, async (db) => {
    const enq = (await getEnquiry(db, e.refId))!;
    const org = (await db.one('select o.name, s.settings from core.organizations o join crm.settings s on s.org_id = o.id where o.id = $1', [e.orgId]))!;
    const [app, hh, pr, docs, pays] = await Promise.all([
      db.one('select answers, progress, status from crm.applications where enquiry_id = $1', [e.refId]),
      db.one('select address, pincode from crm.households where id = $1', [enq.household_id]),
      db.one('select current_school from crm.prospects where id = $1', [enq.prospect_id]),
      db.q('select id, type, status, reject_reason from crm.enquiry_documents where enquiry_id = $1 order by type', [e.refId]),
      db.q("select id, purpose, amount, status, receipt_no, token from crm.payments where enquiry_id = $1 and mode = 'link' order by created_at", [e.refId]),
    ]);
    return {
      school: org.name, color: color(org.settings), branch: enq.branch_name, student: enq.student_name, grade: enq.grade, application_no: enq.application_no, stage: enq.stage_name, sections: APPLICATION_SECTIONS,
      application: app, submitted: app?.status === 'submitted',
      answers: app?.answers ?? { address: hh?.address ?? '', pincode: hh?.pincode ?? '', previous_school: pr?.current_school ?? '', transport: enq.custom?.transport_required ?? '' },
      documents: docs, payments: pays.map((x) => ({ ...x, url: publicUrl('pay', x.token) })),
    };
  });
});

/** A parent sends a document. Only the file name is kept for now (no upload path yet: crm.enquiry_documents.file_id is unused). */
on('POST', '/apply/:token/document', async ({ p, b }) => {
  const e = await resolvePublic('enquiry', p.token!);
  if (!e) throw new NotFoundError('link_not_valid');
  const name = str(b.fileName).slice(0, 200);
  if (!name) return { status: 422, json: { ok: false, error: 'Choose a file first.' } };
  return asSystem(e.orgId, async (db) => {
    const enq = (await getEnquiry(db, e.refId))!;
    const r = await db.q("update crm.enquiry_documents set status = 'uploaded', file_name = $3, reject_reason = null, updated_at = now() where org_id = $1 and id = $2 and enquiry_id = $4 and status in ('pending','rejected') returning id", [e.orgId, str(b.docId), name, e.refId]);
    if (!r.length) return { status: 422, json: { ok: false, error: 'That document cannot be changed now.' } };
    await logActivity(db, { householdId: enq.household_id, enquiryId: e.refId, type: 'document', content: `Parent sent a document (${name}).` });
    return { ok: true };
  });
});
