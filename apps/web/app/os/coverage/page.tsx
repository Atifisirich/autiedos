'use client';
/** Syllabus coverage: planned against taught per section and subject, with projected finish and the next exam. */
import { useApp } from '@/lib/app';
import { useApi } from '@/lib/api';
import { Badge, Card, DateText, ErrorBox, PageHeader, Table } from '@/components/ui';

interface CoverageRow {
  section_id: string;
  section: string;
  subject_id: string;
  subject: string;
  staff_name: string;
  has_plan: boolean;
  pct_covered: number | null;
  periods_ahead: number | null;
  status: 'on_track' | 'at_risk' | 'critical' | null;
  projected_completion: string | null;
  days_late_for_exam: number | null;
}

const TONE = { on_track: 'green', at_risk: 'amber', critical: 'red' } as const;

export default function Coverage() {
  const { t } = useApp();
  const rows = useApi<CoverageRow[]>('/coverage');
  return (
    <div>
      <PageHeader title={t('nav.coverage')} />
      <ErrorBox error={rows.error} />
      <Card>
        <Table
          rows={rows.data}
          columns={[
            { key: 'section', header: t('common.section') },
            { key: 'subject', header: t('common.subject') },
            { key: 'staff_name', header: t('common.person') },
            { key: 'pct_covered', header: t('coverage.pct'), render: (r) => (r.has_plan ? `${r.pct_covered ?? 0}%` : t('coverage.noPlan')) },
            {
              key: 'periods_ahead',
              header: t('coverage.aheadBehind'),
              render: (r) => (r.periods_ahead == null ? '' : r.periods_ahead >= 0 ? t('coverage.ahead', { n: r.periods_ahead }) : t('coverage.behind', { n: -r.periods_ahead })),
            },
            { key: 'projected_completion', header: t('coverage.projected'), render: (r) => (r.projected_completion ? <DateText value={r.projected_completion} /> : '') },
            { key: 'status', header: t('common.status'), render: (r) => (r.status ? <Badge tone={TONE[r.status]}>{t(`coverage.status.${r.status}`)}</Badge> : '') },
          ]}
        />
      </Card>
    </div>
  );
}
