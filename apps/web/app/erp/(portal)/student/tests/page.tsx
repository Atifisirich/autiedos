'use client';
import { fmtDate, loadTests, testWindow, type Child } from '@autoed/shared/erp-portal';
import { usePortal } from '@/lib/erp-portal/session';
import { useLoad } from '@/lib/erp-portal/use-load';
import { Badge, Card, Empty, LinkBtn, PageHead } from '@/components/erp-portal/ui';
import { NeedChild, WithData } from '@/components/erp-portal/screen';

export default function Tests() {
  return <NeedChild>{(c) => <Inner child={c} />}</NeedChild>;
}

function Inner({ child }: { child: Child }) {
  const { sb, L, lang } = usePortal();
  const q = useLoad('tests', () => loadTests(sb!, child.id), [child.id], { childScoped: true });
  return (
    <>
      <PageHead title={L('tests.title')} />
      <WithData q={q}>
        {(d) => d.tests.length === 0 ? <Card><Empty title={L('tests.none')} /></Card> : (
          <ul className="space-y-3">
            {d.tests.map((t) => {
              const win = testWindow(t);
              const attempt = d.attempts[t.id];
              const submitted = Boolean(attempt?.submitted_at);
              return (
                <li key={t.id}>
                  <Card>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-base font-semibold text-slate-900">{t.title}</h2>
                      {t.is_diagnostic && <Badge tone="info">{L('tests.diagnostic')}</Badge>}
                    </div>
                    <p className="text-sm text-slate-700">{(t.subject_id && d.subjects[t.subject_id]) || ''}{t.duration_min ? ` · ${L('tests.minutes', { n: t.duration_min })}` : ''}</p>
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                      {submitted ? <Badge tone="good">{L('tests.done')} · {attempt?.score ?? 0} / {attempt?.max_score ?? 0}</Badge>
                        : <Badge tone={win === 'open' ? 'good' : 'none'}>{win === 'upcoming' ? L('tests.window.upcoming', { date: fmtDate(t.starts_at, lang) }) : L(`tests.window.${win}`)}</Badge>}
                      {!submitted && win === 'open' && <LinkBtn href={`/erp/student/tests/${t.id}`}>{L('tests.start')}</LinkBtn>}
                    </div>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </WithData>
    </>
  );
}
