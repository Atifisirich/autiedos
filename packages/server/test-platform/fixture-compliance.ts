/**
 * Compliance tables (20261115200001): one row per org in every org-scoped table of the compliance tooling, so the
 * isolation harness (every table has rows for org A and org B) covers them. Called for org A and org B by fixture.ts.
 * The platform default rows (org_id null: registry, table policy, retention policies) are seeded by the migration.
 */
import type pg from 'pg';

type Q = (sql: string, params?: unknown[]) => Promise<pg.QueryResult>;

export async function seedCompliance(q: Q, orgId: string) {
  await q(`insert into core.pii_registry (org_id, schema_name, table_name, person_type, key_column, pii_columns, erasure_mode)
           values ($1, 'core', 'notification_prefs', 'staff', 'user_id', array['user_id'], 'delete')`, [orgId]);
  await q(`insert into core.table_policy (org_id, schema_name, table_name, org_deletion, org_export) values ($1, 'core', 'terminology', 'delete', true)`, [orgId]);
  await q(`insert into core.retention_policies (org_id, scope, data_type, period_value, period_unit) values ($1, 'lifecycle', 'product_read_only_days', 14, 'days')`, [orgId]);
  await q(`insert into core.legal_holds (org_id, scope, reason) values ($1, 'org', 'fixture: hold for the isolation harness')`, [orgId]);
  await q(`insert into core.compliance_requests (org_id, kind, status) values ($1, 'person_export', 'executed')`, [orgId]);
  await q(`insert into core.org_export_jobs (org_id) values ($1)`, [orgId]);
  await q(`insert into core.consent_events (org_id, channel, contact, purpose, status, source) values ($1, 'whatsapp', '+910000000001', 'service', 'opted_in', 'fixture')`, [orgId]);
  await q(`insert into audit.purge_log (org_id, source, action, status) values ($1, 'retention', 'skip', 'skipped_disabled')`, [orgId]);
}
