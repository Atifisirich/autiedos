/**
 * Custom records (20261127200001_core_custom_records): objects and records for one org, written as the table owner.
 * Called for org A and org B by fixture.ts after the learner links exist.
 *
 * Per org:
 *   visitor_log  (product 'core')  Hostel visitor log: a learner field, a person field, a workflow open -> closed with
 *                                   approval; teachers (A: os 'teacher' role) may view own rows and create; portal off.
 *   pickup_log   (product 'erp')   Pick-up register: portal ON through the learner field `child`; a row for the
 *                                   portal learner and a row for another family's learner.
 *   events       one row per record created by the history trigger (plus an 'exported' object event).
 */
import type pg from 'pg';

type Q = (sql: string, params?: unknown[]) => Promise<pg.QueryResult>;

export interface RecordsOrgInput {
  org: string;
  branch: string;
  admin: string;          // auth user id of the org admin
  learner: string;        // the portal guardian's learner
  other: string;          // a learner of another family
  staff: string;          // a core.staff id
}

export const VISITOR_FIELDS = [
  { key: 'visitor_name', label: 'Visitor name', type: 'text', required: true },
  { key: 'student', label: 'Student', type: 'learner', required: true },
  { key: 'warden', label: 'Warden on duty', type: 'person' },
  { key: 'visit_date', label: 'Date', type: 'date', default: 'today' },
  { key: 'purpose', label: 'Purpose', type: 'choice', options: ['Parent visit', 'Delivery', 'Other'] },
  { key: 'pass_no', label: 'Pass number', type: 'text', unique: true },
  { key: 'phone', label: 'Phone', type: 'phone' },
];

export const VISITOR_STATES = {
  list: [{ key: 'open', label: 'Open' }, { key: 'approved', label: 'Approved' }, { key: 'closed', label: 'Closed', final: true }],
  initial: 'open',
  transitions: [
    { from: 'open', to: 'approved', label: 'Approve', approval: true, approver_roles: ['os:admin'] },
    { from: 'approved', to: 'closed', label: 'Close' },
  ],
};

export async function seedRecords(q: Q, o: RecordsOrgInput) {
  const visitor = (await q(
    `insert into core.custom_objects (org_id, product_key, key, label_singular, label_plural, icon, fields, title_field, list_columns, permissions, states, schedule)
     values ($1, 'core', 'visitor_log', 'Hostel visitor', 'Hostel visitor log', 'door', $2, 'visitor_name', '{visitor_name,student,visit_date}', $3, $4, $5) returning id`,
    [o.org, JSON.stringify(VISITOR_FIELDS),
      JSON.stringify([{ who: 'role', product: 'os', role: 'teacher', view: 'own', create: true, edit: 'own', delete: 'none' }]),
      JSON.stringify(VISITOR_STATES), JSON.stringify({ reminder: { date_field: 'visit_date', days_before: 0 } })],
  )).rows[0].id as string;
  const pickup = (await q(
    `insert into core.custom_objects (org_id, product_key, key, label_singular, label_plural, fields, title_field, permissions, portal)
     values ($1, 'erp', 'pickup_log', 'Pick-up', 'Pick-up register', $2, 'picked_by', '[]', $3) returning id`,
    [o.org, JSON.stringify([
      { key: 'picked_by', label: 'Picked up by', type: 'text', required: true },
      { key: 'child', label: 'Child', type: 'learner', required: true },
      { key: 'at', label: 'Time', type: 'datetime', default: 'now' },
    ]), JSON.stringify({ enabled: true, learner_field: 'child' })],
  )).rows[0].id as string;

  const rec = async (object: string, data: Record<string, unknown>, owner: string | null, branch: string | null = o.branch) =>
    (await q(`insert into core.custom_records (org_id, branch_id, object_id, data, owner_id) values ($1, $2, $3, $4, $5) returning id`,
      [o.org, branch, object, JSON.stringify(data), owner])).rows[0].id as string;

  const visit = await rec(visitor, { visitor_name: 'Ramesh (uncle)', student: o.learner, warden: o.staff, purpose: 'Parent visit', pass_no: 'P-1', phone: '+91 98480 11111' }, o.admin);
  const visitOther = await rec(visitor, { visitor_name: 'Courier', student: o.other, purpose: 'Delivery', pass_no: 'P-2' }, o.admin, null);
  const pickOwn = await rec(pickup, { picked_by: 'Grandfather', child: o.learner }, o.admin);
  const pickOther = await rec(pickup, { picked_by: 'Driver', child: o.other }, o.admin);
  await q(`insert into core.custom_record_events (org_id, object_id, kind, note) values ($1, $2, 'exported', 'fixture export')`, [o.org, visitor]);
  return { visitor, pickup, visit, visitOther, pickOwn, pickOther };
}
