/**
 * What AutoEd holds and for how long, as a client's compliance admin sees it (data-subject-rights-procedure.md 5.5):
 * the registered personal-data tables with what an erasure does to each, the tables kept when an organisation is
 * deleted, and the effective retention and lifecycle periods (platform defaults with the org's shorter overrides).
 */
import { guarded, type ComplianceDb } from './db';

export interface DataMap {
  org_id: string;
  personal_data: { schema: string; table: string; person_type: string; key_column: string; pii_columns: string[]; on_erasure: 'delete' | 'anonymise' | 'retain'; retain_reason: string | null; exported: boolean }[];
  kept_when_org_deleted: { schema: string; table: string; reason: string | null }[];
  retention: { data_type: string; schema: string; table: string; action: string; period_value: number; period_unit: string; enabled: boolean; legal_status: string; org_override: boolean }[];
  lifecycle_days: { product_read_only_days: number; org_exit_deletion_days: number };
}

export async function getDataMap(db: ComplianceDb, actorUserId: string, orgId: string): Promise<DataMap> {
  return guarded(() =>
    db.run('platform_admin_server', { actorUserId }, async (q) => (await q.query<{ r: DataMap }>(`select app.compliance_data_map($1) as r`, [orgId])).rows[0]!.r),
  );
}
