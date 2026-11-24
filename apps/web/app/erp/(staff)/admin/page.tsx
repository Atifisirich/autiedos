import Link from 'next/link';
import { requireCap } from '@/lib/erp/ctx';
import { Page, Card } from '@/components/erp/ui';
import { ENTITIES } from '@/lib/erp/entities.gen';

export const metadata = { title: 'Admin console' };
const AREAS: [string, [string, string, string][]][] = [
  ['Get started', [['/erp/admin/setup', 'Set-up checklist', 'What is done and what is next'], ['/erp/admin/import', 'Import and export centre', 'CSV templates with validation and undo']]],
  ['Organisation and structure', [['/erp/admin/settings', 'Organisation and settings', 'Legal details, modules, terminology, fee and message rules'], ['/erp/x/branches', 'Branches', 'Campuses, boards, timings, GST'], ['/erp/x/academic_years', 'Academic years', ''], ['/erp/x/terms', 'Terms', ''], ['/erp/x/programmes', 'Grades / programmes', ''], ['/erp/x/sections', 'Sections', 'Class teacher, room, capacity'], ['/erp/x/subjects', 'Subjects', ''], ['/erp/x/calendar_events', 'Calendar and holidays', ''], ['/erp/admin/rollover', 'Year rollover wizard', 'Promote, carry dues, preview, commit']]],
  ['People and access', [['/erp/admin/users', 'Users and access', 'Who can sign in and with which role'], ['/erp/admin/roles', 'Roles and permissions', 'Edit every cell of the matrix'], ['/erp/x/delegations', 'Delegations', 'Approvals during leave']]],
  ['Data model', [['/erp/x/custom_fields', 'Custom fields', 'Extra fields on students, staff and more'], ['/erp/x/masters', 'Dropdown masters', 'Houses, categories, concern types'], ['/erp/x/doc_templates', 'Document templates', ''], ['/erp/x/message_templates', 'Message templates', '']]],
  ['Academics and money', [['/erp/x/assessment_schemes', 'Assessment schemes', 'Board packs, weightages'], ['/erp/x/grading_scales', 'Grading scales', ''], ['/erp/x/fee_heads', 'Fee heads', ''], ['/erp/fees/structure', 'Fee plans', ''], ['/erp/x/concession_types', 'Concessions and scholarships', ''], ['/erp/x/leave_types', 'Leave policies', ''], ['/erp/x/accounts', 'Chart of accounts', '']]],
  ['Workflows', [['/erp/x/approval_rules', 'Approval rules', 'Who approves what, in what order'], ['/erp/admin/automations', 'Automations and recipes', 'Install, pause, run log'], ['/erp/x/checklists', 'Adoption checklists', ''], ['/erp/admin/adoption', 'Adoption monitor', 'Usage and compliance']]],
  ['Integrations and devices', [['/erp/x/integrations', 'Integrations', 'Gateways, WhatsApp, SMS, accounting, SSO'], ['/erp/x/devices', 'Devices', 'Biometric, RFID, GPS, gate tablets'], ['/erp/x/api_keys', 'API keys', ''], ['/erp/x/webhooks', 'Webhooks', '']]],
  ['Security, privacy and data', [['/erp/admin/audit', 'Audit log', 'Search every change and sensitive view'], ['/erp/admin/health', 'Data-health report', 'Missing and impossible values'], ['/erp/x/consents', 'Consent register', ''], ['/erp/x/data_requests', 'Data-subject requests', ''], ['/erp/x/retention_rules', 'Retention rules', ''], ['/erp/x/breach_log', 'Breach-response log', ''], ['/erp/x/export_log', 'Export log', '']]],
];
/** Links to generic entity screens that this install does not have are left out, so nothing on this page leads to a 404. */
const have = (href: string) => { const m = /^\/erp\/x\/([^/]+)$/.exec(href); return !m || !!ENTITIES[m[1]!]; };
export default async function Admin() {
  await requireCap('admin');
  return (
    <Page title="Admin console" sub="Shape the system to the school's way of working. No vendor call needed.">
      <div className="space-y-4">{AREAS.map(([title, links]) => <Card key={title} title={title}><div className="grid gap-px bg-line sm:grid-cols-2 lg:grid-cols-3">{links.filter(([h]) => have(h)).map(([h, l, d]) => <Link key={h} href={h} className="bg-white px-4 py-3 hover:bg-paper"><div className="text-sm font-medium">{l}</div>{d && <div className="text-xs text-muted">{d}</div>}</Link>)}</div></Card>)}</div>
    </Page>
  );
}
