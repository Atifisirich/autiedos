'use client';
/** My Day (PRD 5.1): one timeline of today's periods, duties, tasks, checklists, meetings and substitutions. */
import { useState } from 'react';
import Link from 'next/link';
import { useApp } from '@/lib/app';
import { post, useApi } from '@/lib/api';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, Modal, PageHeader, StatusBadge, cx, useAction } from '@/components/ui';
import { CheckInCard } from '@/components/check-in';

interface DayItem {
  kind: string;
  start: string | null;
  end: string | null;
  title: string;
  ref?: string;
  status?: string;
  meta?: Record<string, any>;
}

const KIND_STYLE: Record<string, string> = {
  period: 'border-l-blue-500',
  free: 'border-l-slate-300 border-dashed',
  substitution: 'border-l-purple-500',
  duty: 'border-l-amber-500',
  meeting: 'border-l-teal-500',
  checklist: 'border-l-green-500',
  task: 'border-l-slate-500',
};

function href(i: DayItem): string | null {
  switch (i.kind) {
    case 'task':
      return `/os/tasks/${i.ref}`;
    case 'checklist':
      return `/os/checklists/${i.ref}`;
    case 'meeting':
      return `/os/meetings/${i.ref}`;
    case 'substitution':
      return i.meta?.cover_plan_id ? `/os/lesson-plans/${i.meta.cover_plan_id}` : null;
    case 'period':
      return `/os/class-log?section_id=${i.meta?.section_id}&subject_id=${i.meta?.subject_id}&period_seq=${i.meta?.period_seq}`;
    default:
      return null;
  }
}

export default function MyDay() {
  const { t, me, on } = useApp();
  const [date, setDate] = useState<string>('');
  const day = useApi<{ date: string; holiday: boolean; on_leave: boolean; items: DayItem[]; attendance: any; pending_approvals: number; unread: number; simplified: boolean }>(`/my-day${date ? `?date=${date}` : ''}`);
  const [quick, setQuick] = useState(false);
  if (!day.data) return day.error ? <ErrorBox error={day.error} /> : <Loading />;
  const d = day.data;
  const simplified = d.simplified;
  const items = simplified ? d.items.filter((i) => i.kind === 'task' || i.kind === 'checklist') : d.items;
  return (
    <div>
      <PageHeader
        title={t('myDay.greeting', { name: me?.staff.full_name.split(' ')[0] ?? '' })}
        subtitle={d.holiday ? t('myDay.holiday') : d.on_leave ? t('myDay.onLeave') : t('myDay.subtitle')}
        actions={
          <>
            <Input type="date" value={date || d.date} onChange={(e) => setDate(e.target.value)} aria-label={t('common.date')} className="w-auto" />
            {on('tasks') && <Button onClick={() => setQuick(true)}>{t('myDay.quickAdd')}</Button>}
            {on('tasks') && (
              <Link href="/os/tasks/day-close" className="inline-flex min-h-[40px] items-center rounded-md border border-slate-300 bg-white px-4 text-sm">
                {t('myDay.closeDay')}
              </Link>
            )}
          </>
        }
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-2 lg:col-span-2">
          {!items.length && <Card>{t('myDay.empty')}</Card>}
          {items.map((i, k) => {
            const link = href(i);
            const body = (
              <div className={cx('flex items-start gap-3 rounded-lg border border-l-4 border-slate-200 bg-white p-3 shadow-sm', KIND_STYLE[i.kind])}>
                <div className="w-20 shrink-0 text-xs text-slate-500">
                  {i.start ?? t('myDay.anytime')}
                  {i.end && <div>{i.end}</div>}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={i.kind === 'substitution' ? 'purple' : i.kind === 'duty' ? 'amber' : 'gray'}>{t(`myDay.kind.${i.kind}`)}</Badge>
                    <span className={cx('font-medium', i.kind === 'free' && 'text-slate-400')}>{i.kind === 'free' ? t('myDay.freePeriod') : i.title}</span>
                    {i.status && <StatusBadge status={i.status} />}
                    {i.meta?.overdue && <Badge tone="red">{t('tasks.overdue')}</Badge>}
                    {i.kind === 'period' && i.meta?.logged && <Badge tone="green">{t('myDay.logged')}</Badge>}
                  </div>
                  {i.meta?.room && <div className="text-xs text-slate-500">{i.meta.room}</div>}
                </div>
              </div>
            );
            return link ? (
              <Link key={k} href={link} className="block">
                {body}
              </Link>
            ) : (
              <div key={k}>{body}</div>
            );
          })}
        </div>
        <div className="space-y-4">
          {on('staff_attendance') && !simplified && <CheckInCard attendance={d.attendance} onDone={day.reload} />}
          <Card title={t('myDay.atAGlance')}>
            <ul className="space-y-2 text-sm">
              <li>
                <Link href="/os/approvals" className="text-brand-700">
                  {t('myDay.pendingApprovals', { count: d.pending_approvals })}
                </Link>
              </li>
              <li>
                <Link href="/os/inbox" className="text-brand-700">
                  {t('myDay.unread', { count: d.unread })}
                </Link>
              </li>
            </ul>
          </Card>
        </div>
      </div>
      <QuickAdd open={quick} onClose={() => setQuick(false)} onDone={day.reload} />
    </div>
  );
}

/** "Quick add" in two taps: title, optional voice note, time spent. */
function QuickAdd({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const { t } = useApp();
  const [title, setTitle] = useState('');
  const [mins, setMins] = useState('');
  const a = useAction();
  return (
    <Modal open={open} onClose={onClose} title={t('myDay.quickAdd')}>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await a.run(() => post('/tasks/quick', { title, time_spent_minutes: mins ? Number(mins) : null, client_id: crypto.randomUUID() }));
          if (r) {
            setTitle('');
            setMins('');
            onClose();
            onDone();
          }
        }}
      >
        <Field label={t('tasks.whatDidYouDo')}>
          <Input autoFocus required value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label={t('tasks.timeSpent')}>
          <Input type="number" min={0} value={mins} onChange={(e) => setMins(e.target.value)} />
        </Field>
        <ErrorBox error={a.error} />
        <Button disabled={a.busy}>{t('common.save')}</Button>
      </form>
    </Modal>
  );
}
