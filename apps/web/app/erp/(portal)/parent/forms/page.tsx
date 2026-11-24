'use client';
import { fmtDate, loadForms } from '@autoed/shared/erp-portal';
import { usePortal } from '@/lib/erp-portal/session';
import { useLoad } from '@/lib/erp-portal/use-load';
import { Badge, Card, Empty, PageHead, Row } from '@/components/erp-portal/ui';
import { WithData } from '@/components/erp-portal/screen';

export default function Forms() {
  const { sb, userId, L, lang } = usePortal();
  const q = useLoad('forms', () => loadForms(sb!, userId!), []);
  return (
    <>
      <PageHead title={L('forms.title')} />
      <WithData q={q}>
        {(d) => d.forms.length === 0 ? <Card><Empty title={L('forms.none')} /></Card> : (
          <Card flush>
            <ul className="divide-y divide-slate-100">
              {d.forms.map((f) => {
                const done = d.done.has(f.id);
                return (
                  <li key={f.id}>
                    <Row href={`/erp/parent/forms/${f.id}`}>
                      <span className="min-w-0"><span className="block text-base font-semibold text-slate-900">{f.title}</span>{f.closes_on && <span className="block text-sm text-slate-700">{L('forms.closes', { date: fmtDate(f.closes_on, lang, true) })}</span>}</span>
                      {done ? <Badge tone="good">{L('forms.done')}</Badge> : <span className="text-[var(--pt-primary)]" aria-hidden>›</span>}
                    </Row>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
      </WithData>
    </>
  );
}
