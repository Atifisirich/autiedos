/**
 * Whole-organisation export (data-subject-rights-procedure.md 5.3, decision 42: CSV/Excel on exit).
 * Every table with an org_id in core, billing, audit and the product schemas the org has (or had) a subscription for
 * is exported, found through the catalogue, so new tables are included without a code change. The archive holds
 * CSV and XLSX per table plus manifest.json (row counts, bytes and sha256 of every file) so the client can verify
 * completeness. The archive is handed to an ExportSink (Supabase Storage in production, a folder locally).
 *
 * v1 builds the archive in memory. For very large orgs, stream per table to the sink instead (see ADR, not done).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { guarded, type ComplianceDb } from './db';
import { createZip, sha256, toCsv, toXlsx, XLSX_ROW_LIMIT, type ZipEntry } from './files';
import { ComplianceError } from './types';

export interface ExportSink {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
}

/** Local folder sink for development and tests. Keys cannot escape the folder. */
export function createFsSink(dir: string): ExportSink {
  const root = resolve(dir);
  const path = (key: string) => {
    const p = resolve(join(root, normalize(key)));
    if (p !== root && !p.startsWith(root + sep)) throw new Error('bad export key');
    return p;
  };
  return {
    async put(key, data) {
      const p = path(key);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, data);
    },
    async get(key) {
      return readFile(path(key));
    },
  };
}

export type ExportFormat = 'csv' | 'xlsx';

export interface OrgExportOptions {
  orgId: string;
  products?: string[];
  purpose?: 'on_demand' | 'exit' | 'non_payment';
  formats?: ExportFormat[];
  /** audit.log and audit.config_history of the org (large). Default true. */
  includeAudit?: boolean;
  now?: () => Date;
}

export interface TableCount {
  schema: string;
  table: string;
  rows: number;
  columns: string[];
  export: boolean;
  product: string | null;
}

export interface ExportManifest {
  version: 1;
  job_id: string;
  org_id: string;
  generated_at: string;
  purpose: string;
  products: string[];
  formats: ExportFormat[];
  tables: { schema: string; table: string; rows: number; columns: string[]; files: { path: string; bytes: number; sha256: string }[]; note?: string }[];
  total_rows: number;
  notes: string[];
}

export interface OrgExportResult {
  jobId: string;
  storageKey: string;
  archiveSha256: string;
  archiveBytes: number;
  manifestSha256: string;
  manifest: ExportManifest;
}

const PAGE = 5000;
const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, '_');

export async function runOrgExport(db: ComplianceDb, sink: ExportSink, actorUserId: string, o: OrgExportOptions): Promise<OrgExportResult> {
  const now = o.now ?? (() => new Date());
  const formats = o.formats ?? ['csv', 'xlsx'];
  const includeAudit = o.includeAudit ?? true;

  const jobId = await guarded(() =>
    db.run('platform_admin_server', { actorUserId }, async (q) => {
      const r = await q.query<{ id: string }>(`select app.compliance_org_export_start($1, $2, $3, $4) as id`, [o.orgId, o.products ?? null, o.purpose ?? 'on_demand', formats]);
      return r.rows[0]!.id;
    }),
  );

  const fail = async (message: string) => {
    await db
      .run('platform_admin_server', { actorUserId }, (q) => q.query(`select app.compliance_org_export_finish($1, false, null, null, null, null, null, $2, null)`, [jobId, message]))
      .catch(() => undefined);
  };

  try {
    // One snapshot: counts, rows and the manifest must agree.
    const snapshot = await guarded(() =>
      db.run('platform_admin_server', { actorUserId, repeatableRead: true, statementTimeoutMs: 600_000 }, async (q) => {
        const counts = (await q.query<{ c: TableCount[] }>(`select app.compliance_table_counts($1, $2) as c`, [o.orgId, includeAudit])).rows[0]!.c;
        const products = (await q.query<{ p: string[] }>(`select product_keys as p from core.org_export_jobs where id = $1`, [jobId])).rows[0]!.p;
        const data = new Map<string, Record<string, unknown>[]>();
        for (const t of counts) {
          if (!t.export) continue;
          const rows: Record<string, unknown>[] = [];
          let after: string | null = null;
          for (;;) {
            const page: { rows: { v: { c: string; r: Record<string, unknown> } }[] } = await q.query(`select v from app.compliance_read_rows($1, $2, $3, $4, $5) v`, [o.orgId, t.schema, t.table, after, PAGE]);
            for (const x of page.rows) rows.push(x.v.r);
            if (page.rows.length < PAGE) break;
            after = page.rows[page.rows.length - 1]!.v.c;
          }
          if (rows.length !== t.rows) throw new ComplianceError('integrity', `${t.schema}.${t.table}: counted ${t.rows} rows, read ${rows.length}`);
          data.set(`${t.schema}.${t.table}`, rows);
        }
        return { counts, products, data };
      }),
    );

    const entries: ZipEntry[] = [];
    const manifestTables: ExportManifest['tables'] = [];
    let total = 0;
    for (const t of snapshot.counts) {
      if (!t.export) continue;
      const rows = snapshot.data.get(`${t.schema}.${t.table}`)!;
      total += rows.length;
      const files: { path: string; bytes: number; sha256: string }[] = [];
      let note: string | undefined;
      const base = `${safe(t.schema)}/${safe(t.table)}`;
      if (formats.includes('csv')) {
        const data = toCsv(t.columns, rows);
        entries.push({ name: `${base}.csv`, data });
        files.push({ path: `${base}.csv`, bytes: data.length, sha256: sha256(data) });
      }
      if (formats.includes('xlsx')) {
        if (rows.length > XLSX_ROW_LIMIT) {
          note = 'xlsx skipped: more rows than a worksheet holds; use the CSV';
        } else {
          const data = await toXlsx(`${t.schema}.${t.table}`, t.columns, rows);
          entries.push({ name: `${base}.xlsx`, data });
          files.push({ path: `${base}.xlsx`, bytes: data.length, sha256: sha256(data) });
        }
      }
      manifestTables.push({ schema: t.schema, table: t.table, rows: rows.length, columns: t.columns, files, ...(note ? { note } : {}) });
    }
    const manifest: ExportManifest = {
      version: 1,
      job_id: jobId,
      org_id: o.orgId,
      generated_at: now().toISOString(),
      purpose: o.purpose ?? 'on_demand',
      products: snapshot.products,
      formats,
      tables: manifestTables,
      total_rows: total,
      notes: [
        'Uploaded files (storage buckets) are not part of this archive; they are delivered separately.',
        'sha256 values are of the file bytes inside this archive. The archive sha256 is recorded by AutoEd and sent with the download link.',
      ],
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
    entries.push({ name: 'manifest.json', data: manifestBytes });
    const zip = createZip(entries, now());
    const storageKey = `${o.orgId}/exports/${jobId}.zip`;
    await sink.put(storageKey, zip);
    const archiveSha = sha256(zip);
    const manifestSha = sha256(manifestBytes);
    await guarded(() =>
      db.run('platform_admin_server', { actorUserId }, (q) =>
        q.query(`select app.compliance_org_export_finish($1, true, $2::jsonb, $3, $4, $5, $6, null, $7)`, [jobId, JSON.stringify(manifest), manifestSha, archiveSha, zip.length, storageKey, total]),
      ),
    );
    return { jobId, storageKey, archiveSha256: archiveSha, archiveBytes: zip.length, manifestSha256: manifestSha, manifest };
  } catch (e) {
    await fail(e instanceof Error ? e.message : String(e));
    throw e;
  }
}
