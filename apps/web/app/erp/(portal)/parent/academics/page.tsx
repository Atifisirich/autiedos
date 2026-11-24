'use client';
import Link from 'next/link';
import { childName, fmtDate, loadGrowth, loadReportCards, loadResults, type Child } from '@autoed/shared/erp-portal';
import { usePortal } from '@/lib/erp-portal/session';
import { useLoad } from '@/lib/erp-portal/use-load';
import { Card, Empty, PageHead, Row } from '@/components/erp-portal/ui';
import { ResultsCard } from '@/components/erp-portal/results';
import { NeedChild, WithData } from '@/components/erp-portal/screen';

export default function Academics() {
  return <NeedChild>{(c) => <Inner child={c} />}</NeedChild>;
}

function Inner({ child }: { child: Child }) {
  const { sb, L, lang } = usePortal();
  const q = useLoad('academics', async () => {
    const [cards, results, growth] = await Promise.all([loadReportCards(sb!, child.id), loadResults(sb!, child.id), loadGrowth(sb!, child.id)]);
    return { cards, results, growth };
  }, [child.id], { childScoped: true });
  return (
    <>
      <PageHead title={L('academics.title')} sub={childName(child)} />
      <WithData q={q}>
        {(d) => (
          <div className="space-y-4">
            <Card title={L('academics.reportCards')} flush>
              {d.cards.length === 0 ? <Empty title={L('academics.noCards')} /> : (
                <ul className="divide-y divide-slate-100">
                  {d.cards.map((c) => (
                    <li key={c.id}>
                      <Row href={`/erp/parent/academics/report/${c.id}`}>
                        <span><span className="block text-base font-semibold text-slate-900">{c.term}</span>{c.published_at && <span className="text-sm text-slate-700">{L('academics.published', { date: fmtDate(c.published_at, lang, true) })}</span>}</span>
                        <span className="text-[var(--pt-primary)]" aria-hidden>›</span>
                      </Row>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <ResultsCard rows={d.results} />

            {d.growth.length > 0 && (
              <Card title={L('academics.growth')} flush>
                <ul className="divide-y divide-slate-100">
                  {d.growth.map((g) => <li key={g.id} className="px-4 py-3"><div className="text-sm text-slate-700">{fmtDate(g.date, lang, true)}{g.title ? ` · ${g.title}` : ''}</div><p className="text-base text-slate-900">{g.note}</p></li>)}
                </ul>
              </Card>
            )}
            <p className="text-sm text-slate-700"><Link href="/erp/parent/attendance" className="underline">{L('nav.attendance')}</Link></p>
          </div>
        )}
      </WithData>
    </>
  );
}
