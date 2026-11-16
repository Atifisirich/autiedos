'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '@/lib/app';
import { download, useApi } from '@/lib/api';
import { Badge, Button, Card, DateText, Input, LinkButton, PageHeader, StatusBadge, Table, Tabs } from '@/components/ui';

function monday(d = new Date()) {
  const x = new Date(d);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x.toISOString().slice(0, 10);
}

export default function LessonPlans() {
  const { t, can } = useApp();
  const router = useRouter();
  const [view, setView] = useState('mine');
  const [q, setQ] = useState('');
  const [week, setWeek] = useState(monday());
  const list = useApi<any[]>(view !== 'weekly' ? `/lesson-plans?view=${view}${q ? `&q=${encodeURIComponent(q)}` : ''}` : null);
  const weekly = useApi<any>(view === 'weekly' ? `/lesson-plans/weekly?week_start=${week}` : null);
  return (
    <div>
      <PageHeader title={t('nav.lessonPlans')} actions={<><LinkButton variant="secondary" href="/os/lesson-plans/annual">{t('plans.annual')}</LinkButton><LinkButton variant="secondary" href="/os/lesson-plans/library">{t('plans.library')}</LinkButton>{can('lesson_planner', 'create') && <LinkButton href="/os/lesson-plans/new">{t('plans.new')}</LinkButton>}</>} />
      <Tabs value={view} onChange={setView} tabs={[{ value: 'mine', label: t('plans.mine') }, { value: 'weekly', label: t('plans.weekly') }, { value: 'review', label: t('plans.review') }, { value: 'bank', label: t('plans.bank') }, ...(can('lesson_planner', 'view', 4) ? [{ value: 'all', label: t('common.all') }] : [])]} />
      {view === 'weekly' ? (
        <Card actions={<div className="flex gap-2"><Input type="date" aria-label={t('plans.weekOf')} value={week} onChange={(e) => setWeek(monday(new Date(e.target.value)))} className="w-44" /><Button variant="secondary" onClick={() => download(`/lesson-plans/weekly.docx?week_start=${week}`)}>{t('common.exportWord')}</Button></div>}>
          <Table rows={weekly.data?.periods} columns={[{ key: 'date', header: t('common.date'), render: (r) => <DateText value={r.date} /> }, { key: 'period_seq', header: t('timetable.period') }, { key: 'section', header: t('common.section') }, { key: 'subject', header: t('common.subject') }, { key: 'topic', header: t('plans.topic'), render: (r) => r.planned_topic ?? '—' }, { key: 'plan', header: t('plans.plan'), render: (r) => (r.plan_id ? <StatusBadge status={r.plan_status} /> : <Badge tone="red">{t('plans.missing')}</Badge>) }]} onRow={(r) => (r.plan_id ? router.push(`/os/lesson-plans/${r.plan_id}`) : router.push(`/os/lesson-plans/new?section=${r.section_id}&subject=${r.subject_id}&date=${r.date}`))} />
        </Card>
      ) : (
        <Card actions={<Input placeholder={t('common.search')} aria-label={t('common.search')} value={q} onChange={(e) => setQ(e.target.value)} className="w-56" />}>
          <Table rows={list.data} onRow={(r) => router.push(`/os/lesson-plans/${r.id}`)} columns={[{ key: 'plan_date', header: t('common.date'), render: (r) => <DateText value={r.plan_date} /> }, { key: 'subject_name', header: t('common.subject') }, { key: 'section_name', header: t('common.section') }, { key: 'topic_name', header: t('plans.topic') }, { key: 'teacher_name', header: t('common.person') }, { key: 'level', header: t('plans.level'), render: (r) => t(`planLevel.${r.level}`) }, { key: 'status', header: t('common.status'), render: (r) => <StatusBadge status={r.status} /> }, ...(view === 'bank' ? [{ key: 'rating', header: t('plans.rating'), render: (r: any) => (r.rating_count ? `${(r.rating_sum / r.rating_count).toFixed(1)} ★ (${r.usage_count})` : '—') }] : [])]} />
        </Card>
      )}
    </div>
  );
}
