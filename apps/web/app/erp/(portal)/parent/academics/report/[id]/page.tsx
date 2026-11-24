'use client';
import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { childName, fmtDate, openReportCard, readSnapshot, verifyUrl, type CardFull } from '@autoed/shared/erp-portal';
import { usePortal } from '@/lib/erp-portal/session';
import { useLoad } from '@/lib/erp-portal/use-load';
import { Badge, Btn, Card, Notice, PageHead } from '@/components/erp-portal/ui';
import { QrCode } from '@/components/erp-portal/visual';
import { WithData } from '@/components/erp-portal/screen';

/**
 * One published report card. It is opened through erp.open_report_card, which counts the view and writes it to the audit log
 * (a family view of a report card is a logged event). The QR code and link open the public check page of this school.
 */
export default function ReportCardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { sb, child, L, lang } = usePortal();
  const q = useLoad<CardFull>(`report:${id}`, () => openReportCard(sb!, id), [id]);
  const [origin, setOrigin] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => setOrigin(window.location.origin), []);

  return (
    <>
      <p className="mb-2 print:hidden"><Link href="/erp/parent/academics" className="text-base text-[var(--pt-primary)] underline">‹ {L('nav.academics')}</Link></p>
      <WithData q={q}>
        {(card) => {
          const snap = readSnapshot(card.snapshot);
          const link = card.verify_code && origin ? verifyUrl(origin, card.verify_code) : null;
          return (
            <article className="space-y-4">
              <PageHead title={`${card.term}`} sub={`${snap?.student.name || (child ? childName(child) : '')}${snap?.section ? ` · ${snap.section}` : ''}${card.published_at ? ` · ${L('academics.published', { date: fmtDate(card.published_at, lang, true) })}` : ''}`} />
              {snap ? (
                <Card flush>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[20rem] text-left text-base">
                      <thead className="bg-slate-50 text-sm text-slate-700"><tr><th scope="col" className="px-4 py-2">{L('academics.subject')}</th><th scope="col" className="px-4 py-2 text-right">%</th><th scope="col" className="px-4 py-2">{L('academics.grade')}</th></tr></thead>
                      <tbody className="divide-y divide-slate-100">
                        {snap.subjects.map((s) => (
                          <tr key={s.name}>
                            <th scope="row" className="px-4 py-3 font-medium text-slate-900">{s.name}{s.parts.length > 0 && <span className="block text-sm font-normal text-slate-700">{s.parts.map((p) => `${p.name} ${p.marks}/${p.max}`).join(' · ')}</span>}</th>
                            <td className="px-4 py-3 text-right tabular-nums">{s.absent ? L('academics.absent') : s.percent ?? '–'}</td>
                            <td className="px-4 py-3">{s.grade ?? '–'} {s.pass === false && <Badge tone="bad">{L('academics.fail')}</Badge>}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot className="bg-slate-50 font-semibold">
                        <tr><th scope="row" className="px-4 py-3">{L('academics.overall')}</th><td className="px-4 py-3 text-right tabular-nums">{snap.overall ?? '–'}</td><td className="px-4 py-3">{snap.overall_grade ?? ''}</td></tr>
                      </tfoot>
                    </table>
                  </div>
                  <div className="space-y-1 border-t border-slate-100 px-4 py-3 text-base">
                    {snap.rank !== null && snap.class_size !== null && <p>{L('academics.rank', { n: snap.rank, total: snap.class_size })}</p>}
                    {snap.attendance && <p>{L('academics.attendanceLine', { present: snap.attendance.present, total: snap.attendance.total, percent: snap.attendance.percent ?? '–' })}</p>}
                  </div>
                </Card>
              ) : <Notice>{L('academics.noSnapshot')}</Notice>}

              {(card.class_teacher_remark || card.principal_remark) && (
                <Card>
                  {card.class_teacher_remark && <p className="text-base"><strong>{L('academics.teacherRemark')}: </strong>{card.class_teacher_remark}</p>}
                  {card.principal_remark && <p className="mt-2 text-base"><strong>{L('academics.principalRemark')}: </strong>{card.principal_remark}</p>}
                </Card>
              )}

              {link && card.verify_code && (
                <Card title={L('academics.verify')}>
                  <div className="flex flex-wrap items-center gap-4">
                    <QrCode text={link} label={L('academics.verify')} />
                    <div className="min-w-0 flex-1 space-y-2">
                      <p className="text-base text-slate-800">{L('academics.verifyHint')}</p>
                      <a href={link} className="block break-all text-base text-[var(--pt-primary)] underline" data-testid="verify-link">{link}</a>
                      <div className="flex flex-wrap gap-2 print:hidden">
                        <Btn variant="secondary" onClick={() => { void navigator.clipboard?.writeText(link).then(() => setCopied(true)); }}>{copied ? L('academics.copied') : L('academics.copyLink')}</Btn>
                        <Btn variant="secondary" onClick={() => window.print()}>{L('academics.print')}</Btn>
                      </div>
                    </div>
                  </div>
                </Card>
              )}
            </article>
          );
        }}
      </WithData>
    </>
  );
}
