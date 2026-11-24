'use client';
import { resultsByTerm, type ResultRow } from '@autoed/shared/erp-portal';
import { usePortal } from '@/lib/erp-portal/session';
import { Badge, Card, Empty } from './ui';

/** Published marks grouped by term and subject (parent academics page and the student results page). */
export function ResultsCard({ rows }: { rows: ResultRow[] }) {
  const { L } = usePortal();
  return (
    <Card title={L('academics.results')}>
      {rows.length === 0 ? <Empty title={L('academics.noResults')} /> : (
        <div className="space-y-5">
          {resultsByTerm(rows).map((t) => (
            <section key={t.term} aria-label={t.term || L('academics.results')}>
              {t.term && <h3 className="mb-2 text-base font-semibold text-slate-900">{t.term}</h3>}
              <ul className="space-y-3">
                {t.subjects.map((s) => (
                  <li key={s.name} className="rounded-xl border border-slate-200 p-3">
                    <div className="flex items-center justify-between gap-2"><span className="text-base font-semibold text-slate-900">{s.name || L('homework.general')}</span>{s.percent !== null && <Badge tone={s.percent >= 40 ? 'good' : 'bad'}>{s.percent}%</Badge>}</div>
                    <ul className="mt-1 divide-y divide-slate-100 text-base">
                      {s.rows.map((r) => (
                        <li key={r.assessment_id} className="flex justify-between gap-2 py-1.5"><span>{r.name}</span><span className="tabular-nums text-slate-800">{r.code ?? `${r.marks ?? '–'} / ${r.max_marks}`}{r.grade ? ` · ${r.grade}` : ''}</span></li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Card>
  );
}
