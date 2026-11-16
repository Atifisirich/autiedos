'use client';
/** Tasks: list, board by status, calendar; My tasks, Assigned by me, Team, All. */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useApp } from '@/lib/app';
import { post, useApi } from '@/lib/api';
import { Badge, Button, Card, DateText, ErrorBox, Input, LinkButton, PageHeader, Select, StatusBadge, Table, Tabs, useAction } from '@/components/ui';
import { useLookups, opts } from '@/lib/lookups';

interface TaskRow {
  id: string;
  title: string;
  status: string;
  priority: string;
  due_at: string | null;
  owner_name: string | null;
  assigner_name: string | null;
  category_name: string | null;
  category_i18n: Record<string, string> | null;
  overdue: boolean;
  child_count: number;
  child_done: number;
  unplanned: boolean;
  is_group_parent: boolean;
}

const BOARD = ['requested', 'todo', 'in_progress', 'blocked', 'done', 'verified'];

export default function TasksPage() {
  const { t, label, can } = useApp();
  const sp = useSearchParams();
  const router = useRouter();
  const [view, setView] = useState(sp.get('view') ?? 'mine');
  const [layout, setLayout] = useState<'list' | 'board' | 'calendar' | 'team'>('list');
  const [status, setStatus] = useState(sp.get('status') ?? 'open');
  const [q, setQ] = useState('');
  const path = layout === 'team' ? null : `/tasks?view=${view}${status ? `&status=${status}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`;
  const list = useApi<TaskRow[]>(path);
  const team = useApi<any[]>(layout === 'team' ? '/tasks/team' : null);
  const [selected, setSelected] = useState<string[]>([]);
  const lk = useLookups();
  const bulk = useAction();
  const [bulkTo, setBulkTo] = useState('');

  const columns = [
    { key: 'sel', header: '', render: (r: TaskRow) => <input type="checkbox" aria-label={t('common.select')} checked={selected.includes(r.id)} onClick={(e) => e.stopPropagation()} onChange={(e) => setSelected((s) => (e.target.checked ? [...s, r.id] : s.filter((x) => x !== r.id)))} /> },
    {
      key: 'title',
      header: t('tasks.title'),
      render: (r: TaskRow) => (
        <div>
          <div className="font-medium">{r.title}</div>
          <div className="flex flex-wrap gap-1 pt-0.5">
            {r.category_name && <Badge>{label(r.category_i18n, r.category_name)}</Badge>}
            {r.unplanned && <Badge tone="purple">{t('tasks.unplanned')}</Badge>}
            {r.is_group_parent && <Badge tone="blue">{t('tasks.groupProgress', { done: r.child_done, total: r.child_count })}</Badge>}
          </div>
        </div>
      ),
    },
    { key: 'status', header: t('common.status'), render: (r: TaskRow) => <div className="flex gap-1"><StatusBadge status={r.status} />{r.overdue && <Badge tone="red">{t('tasks.overdue')}</Badge>}</div> },
    { key: 'priority', header: t('tasks.priority'), render: (r: TaskRow) => t(`priority.${r.priority}`) },
    { key: 'owner_name', header: view === 'assigned' ? t('tasks.owner') : t('tasks.assigner'), render: (r: TaskRow) => (view === 'assigned' || view === 'team' || view === 'all' ? r.owner_name : r.assigner_name) ?? '—' },
    { key: 'due_at', header: t('tasks.due'), render: (r: TaskRow) => <DateText value={r.due_at} withTime /> },
  ];

  const byDay = useMemo(() => {
    const m = new Map<string, TaskRow[]>();
    for (const r of list.data ?? []) {
      const d = r.due_at ? r.due_at.slice(0, 10) : '—';
      m.set(d, [...(m.get(d) ?? []), r]);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [list.data]);

  return (
    <div>
      <PageHeader
        title={t('nav.tasks')}
        actions={
          <>
            <LinkButton href="/os/tasks/week" variant="secondary">
              {t('tasks.planWeek')}
            </LinkButton>
            <LinkButton href="/os/tasks/new">{t('tasks.new')}</LinkButton>
          </>
        }
      />
      <Tabs
        value={layout === 'team' ? 'team' : view}
        onChange={(v) => {
          if (v === 'team') setLayout('team');
          else {
            if (layout === 'team') setLayout('list');
            setView(v);
          }
        }}
        tabs={[
          { value: 'mine', label: t('tasks.view.mine') },
          { value: 'assigned', label: t('tasks.view.assigned') },
          { value: 'team', label: t('tasks.view.team') },
          ...(can('tasks', 'view', 5) ? [{ value: 'all', label: t('tasks.view.all') }] : []),
        ]}
      />
      {layout === 'team' ? (
        <Card title={t('tasks.teamWorkload')}>
          <Table
            rows={team.data}
            onRow={(r) => {
              setView('all');
              setLayout('list');
              router.push(`/os/tasks?view=all&status=open`);
              void r;
            }}
            columns={[
              { key: 'full_name', header: t('common.person') },
              { key: 'position', header: t('common.position') },
              { key: 'open', header: t('tasks.open') },
              { key: 'overdue', header: t('tasks.overdue'), render: (r: any) => <span className={r.overdue > 0 ? 'font-semibold text-red-700' : ''}>{r.overdue}</span> },
              { key: 'on_time', header: t('tasks.onTimeRate'), render: (r: any) => (r.completed_30 ? `${Math.round((r.on_time_30 / r.completed_30) * 100)}%` : '—') },
              { key: 'unplanned', header: t('tasks.unplannedShare'), render: (r: any) => (r.total_30 ? `${Math.round((r.unplanned_30 / r.total_30) * 100)}%` : '—') },
            ]}
          />
        </Card>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Select
              aria-label={t('common.status')}
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="w-auto"
              options={[
                { value: 'open', label: t('tasks.filter.open') },
                { value: 'overdue', label: t('tasks.overdue') },
                { value: 'awaiting_verification', label: t('tasks.filter.awaitingVerification') },
                { value: '', label: t('common.all') },
              ]}
            />
            <Input placeholder={t('common.search')} value={q} onChange={(e) => setQ(e.target.value)} className="w-56" aria-label={t('common.search')} />
            <div className="flex-1" />
            {(['list', 'board', 'calendar'] as const).map((l) => (
              <Button key={l} size="sm" variant={layout === l ? 'primary' : 'secondary'} onClick={() => setLayout(l)}>
                {t(`tasks.layout.${l}`)}
              </Button>
            ))}
          </div>
          {selected.length > 0 && (
            <Card className="mb-3" title={t('tasks.bulk.title', { count: selected.length })}>
              <div className="flex flex-wrap items-center gap-2">
                <Select value={bulkTo} onChange={(e) => setBulkTo(e.target.value)} placeholder={t('tasks.bulk.chooseStaff')} options={opts(lk?.staff, (s) => s.full_name)} className="w-60" />
                <Button size="sm" disabled={!bulkTo || bulk.busy} onClick={async () => (await bulk.run(() => post('/tasks/bulk', { task_ids: selected, op: 'reassign', to_staff_id: bulkTo })), setSelected([]), list.reload())}>
                  {t('tasks.bulk.reassign')}
                </Button>
                <Button size="sm" variant="danger" disabled={bulk.busy} onClick={async () => (await bulk.run(() => post('/tasks/bulk', { task_ids: selected, op: 'cancel' })), setSelected([]), list.reload())}>
                  {t('tasks.bulk.cancel')}
                </Button>
              </div>
              <ErrorBox error={bulk.error} />
            </Card>
          )}
          <ErrorBox error={list.error} />
          {layout === 'list' && (
            <Card>
              <Table rows={list.data} columns={columns} onRow={(r) => router.push(`/os/tasks/${r.id}`)} />
            </Card>
          )}
          {layout === 'board' && (
            <div className="grid gap-3 overflow-x-auto md:grid-cols-3 xl:grid-cols-6">
              {BOARD.map((s) => (
                <div key={s} className="min-w-[200px] rounded-lg bg-slate-100 p-2">
                  <div className="mb-2 px-1 text-xs font-semibold uppercase text-slate-500">{t(`status.${s}`)}</div>
                  <div className="space-y-2">
                    {(list.data ?? [])
                      .filter((r) => r.status === s || (s === 'todo' && r.status === 'reopened'))
                      .map((r) => (
                        <Link key={r.id} href={`/os/tasks/${r.id}`} className="block rounded-md bg-white p-2 text-sm shadow-sm hover:ring-1 hover:ring-brand-500">
                          <div className="font-medium">{r.title}</div>
                          <div className="text-xs text-slate-500">
                            <DateText value={r.due_at} />
                          </div>
                        </Link>
                      ))}
                  </div>
                </div>
              ))}
            </div>
          )}
          {layout === 'calendar' && (
            <div className="space-y-3">
              {byDay.map(([d, rows]) => (
                <Card key={d} title={d === '—' ? t('tasks.noDueDate') : <DateText value={d} />}>
                  <ul className="space-y-1 text-sm">
                    {rows.map((r) => (
                      <li key={r.id} className="flex items-center gap-2">
                        <StatusBadge status={r.status} />
                        <Link href={`/os/tasks/${r.id}`} className="hover:underline">
                          {r.title}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </Card>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
