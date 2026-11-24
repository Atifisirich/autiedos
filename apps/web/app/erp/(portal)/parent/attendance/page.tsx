'use client';
import { useState } from 'react';
import { attendanceSummary, attendanceTone, childName, fmtDate, istToday, loadMarks, monthGrid, type Child } from '@autoed/shared/erp-portal';
import { usePortal } from '@/lib/erp-portal/session';
import { useLoad } from '@/lib/erp-portal/use-load';
import { Badge, Btn, Card, Empty, LinkBtn, PageHead, Stat, cx, type Tone } from '@/components/erp-portal/ui';
import { NeedChild, WithData } from '@/components/erp-portal/screen';

export default function Attendance() {
  return <NeedChild>{(c) => <Inner child={c} />}</NeedChild>;
}

const DAY_TONE: Record<string, string> = {
  good: 'bg-emerald-100 text-emerald-900', bad: 'bg-red-200 text-red-950', warn: 'bg-amber-100 text-amber-950', info: 'bg-sky-100 text-sky-950', none: 'bg-white text-slate-700',
};

function Inner({ child }: { child: Child }) {
  const { sb, L, lang } = usePortal();
  const today = istToday();
  const [ym, setYm] = useState(() => ({ y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)) }));
  const since = `${Number(today.slice(0, 4)) - 1}-${today.slice(5)}`;
  const q = useLoad('attendance', () => loadMarks(sb!, child.id, since), [child.id], { childScoped: true });
  const shift = (d: number) => setYm(({ y, m }) => { const n = m - 1 + d; return { y: y + Math.floor(n / 12), m: ((n % 12) + 12) % 12 + 1 }; });
  const weekdays = Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(lang === 'en' ? 'en-IN' : `${lang}-IN`, { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 10, 2 + i))));

  return (
    <>
      <PageHead title={L('attendance.title')} sub={childName(child)} right={<LinkBtn href="/erp/parent/requests" variant="secondary">{L('attendance.leave')}</LinkBtn>} />
      <WithData q={q}>
        {(marks) => {
          const sum = attendanceSummary(marks);
          const by = Object.fromEntries(marks.map((m) => [m.date, m.status]));
          const grid = monthGrid(ym.y, ym.m, by);
          const monthName = new Intl.DateTimeFormat(lang === 'en' ? 'en-IN' : `${lang}-IN`, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(ym.y, ym.m - 1, 1)));
          if (!marks.length) return <Card><Empty title={L('attendance.none')} /></Card>;
          return (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label={L('attendance.percent')} value={sum.percent === null ? '–' : `${sum.percent}%`} tone={sum.percent !== null && sum.percent < 75 ? 'bad' : 'good'} hint={L('attendance.days', { n: sum.total })} />
                <Stat label={L('att.present')} value={sum.present + sum.late + sum.on_duty} />
                <Stat label={L('att.absent')} value={sum.absent} tone={sum.absent ? 'bad' : 'none'} />
                <Stat label={L('att.on_leave')} value={sum.on_leave} />
              </div>
              <Card
                title={monthName}
                actions={<><Btn variant="secondary" onClick={() => shift(-1)} aria-label={L('attendance.prev')}>‹</Btn><Btn variant="secondary" onClick={() => shift(1)} aria-label={L('attendance.next')}>›</Btn></>}
              >
                <table className="w-full table-fixed border-separate border-spacing-1 text-center" aria-label={monthName}>
                  <thead><tr>{weekdays.map((w, i) => <th key={i} scope="col" className="text-sm font-medium text-slate-700">{w}</th>)}</tr></thead>
                  <tbody>
                    {grid.map((week, wi) => (
                      <tr key={wi}>
                        {week.map((c, ci) => c ? (
                          <td key={ci} className={cx('h-11 rounded-lg border border-slate-200 text-base font-medium', DAY_TONE[attendanceTone(c.status)])} title={c.status ? L(`att.${c.status}`) : undefined}>
                            <span aria-hidden>{c.day}</span>
                            <span className="sr-only">{fmtDate(c.date, lang)}{c.status ? `: ${L(`att.${c.status}`)}` : ''}</span>
                          </td>
                        ) : <td key={ci} />)}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <ul className="mt-3 flex flex-wrap gap-2 text-sm">
                  {(['present', 'late', 'absent', 'on_leave'] as const).map((s) => <li key={s}><Badge tone={attendanceTone(s) as Tone}>{L(`att.${s}`)}</Badge></li>)}
                </ul>
              </Card>
              <Card title={L('attendance.recent')} flush>
                <ul className="divide-y divide-slate-100">
                  {marks.slice(0, 10).map((m) => (
                    <li key={m.date} className="flex items-center justify-between px-4 py-3 text-base"><span>{fmtDate(m.date, lang, true)}</span><Badge tone={attendanceTone(m.status) as Tone}>{L(`att.${m.status}`)}</Badge></li>
                  ))}
                </ul>
              </Card>
            </div>
          );
        }}
      </WithData>
    </>
  );
}
