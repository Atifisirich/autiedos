'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { act, formObj, useCrm } from '@/lib/crm/api';
import { qs } from '@/lib/crm/fmt';
import { Badge, Empty, ErrorBox, Loading, PageHeader } from '@/components/crm/ui';
import { Kanban, LeadCard, LeadTable, type Lead, type LeadCaps, type Stage } from '@/components/crm/lead-views';
import { useShell } from '@/components/crm/shell';

type Res = {
  data: Lead[]; total: number; page: number; size: number; counts: Record<string, number>;
  pipeline: { phases: { id: string; key: string; name: string }[]; stages: (Stage & { phase_id: string; phase_key: string; phase_name: string })[] };
  users: { id: string; name: string }[]; templates: { id: string; name: string; channel: string }[];
  views: { id: string; name: string; shared: boolean; query: string; user_id: string }[]; channels: { channel: string }[];
  fields: { key: string; label: string; type: string; options: string[]; hidden: boolean }[]; chips: [string, string][]; reasons: string[]; grades: string[]; can: LeadCaps & { bulk: boolean }; allYears: boolean;
};

export default function LeadsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Leads />
    </Suspense>
  );
}

function Leads() {
  const { shell } = useShell();
  const sp = Object.fromEntries(useSearchParams().entries()) as Record<string, string>;
  const view = sp.view ?? 'table';
  const { data: r, error, reload } = useCrm<Res>('/leads', sp);
  const [saveOpen, setSaveOpen] = useState(false);
  if (error) return <ErrorBox message={error.message} />;
  if (!r) return <Loading />;
  const { phases, stages } = r.pipeline;
  // The board shows working stages by default: prospects and closed records stay in the table.
  const boardPhases = sp.phase ? [sp.phase] : ['enquiry', 'visit', 'application', 'evaluation', 'offer'];
  const chips = (sp.chip ?? '').split(',').filter(Boolean);
  const toggleChip = (c: string) => (chips.includes(c) ? chips.filter((x) => x !== c) : [...chips, c]).join(',') || undefined;
  const phaseCount = (pid: string) => stages.filter((s) => s.phase_id === pid).reduce((n, s) => n + (r.counts[s.id] ?? 0), 0);
  const allCount = Object.values(r.counts).reduce((a, b) => a + b, 0);
  const current = phases.find((p) => p.key === sp.phase);
  const queryString = qs(sp, { view: undefined, page: undefined }).slice(1);
  const year = shell.years.find((y) => y.id === shell.yearId);
  const filtered = Object.keys(sp).some((k) => !['view', 'page', 'sort'].includes(k));
  const page = r.page;
  const href = (patch: Record<string, string | undefined>) => '/crm/leads' + qs(sp, patch);
  return (
    <>
      <PageHeader title="Leads" sub={`${r.total} record${r.total === 1 ? '' : 's'} · ${sp.year === 'all' ? 'all academic years' : year?.name}${shell.branchId ? ' · ' + shell.branches.find((b) => b.id === shell.branchId)?.name : ''}`}>
        {['F', 'T'].includes(shell.perms.leads ?? '') && (
          <Link href={href({ year: sp.year === 'all' ? undefined : 'all' })} className={`chip ${sp.year === 'all' ? 'chip-on' : ''}`}>
            All years
          </Link>
        )}
        <div className="flex rounded-md border border-slate-300 bg-white p-0.5" role="group" aria-label="Layout">
          {[['table', 'Table'], ['kanban', 'Kanban'], ['cards', 'Cards']].map(([k, label]) => (
            <Link key={k} href={href({ view: k === 'table' ? undefined : k, page: undefined })} aria-current={view === k ? 'true' : undefined} className={`rounded px-2.5 py-1.5 text-xs font-medium ${view === k ? 'bg-teal-700 text-white' : 'text-slate-700'}`}>
              {label}
            </Link>
          ))}
          <Link href="/crm/tasks?view=calendar" className="rounded px-2.5 py-1.5 text-xs font-medium text-slate-700">
            Calendar
          </Link>
        </div>
      </PageHeader>

      <div className="mb-3 flex gap-1 overflow-x-auto border-b border-slate-200" role="tablist" aria-label="Phases">
        <Link href={href({ phase: undefined, stage: undefined, page: undefined })} role="tab" aria-selected={!sp.phase && !sp.stage} className={`tab ${!sp.phase && !sp.stage ? 'tab-on' : ''}`}>
          All <span className="muted">{allCount}</span>
        </Link>
        {phases.map((p) => (
          <Link key={p.id} href={href({ phase: p.key, stage: undefined, page: undefined })} role="tab" aria-selected={sp.phase === p.key} className={`tab ${sp.phase === p.key ? 'tab-on' : ''}`}>
            {p.name} <span className="muted">{phaseCount(p.id)}</span>
          </Link>
        ))}
      </div>
      {current && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {stages.filter((s) => s.phase_id === current.id).map((s) => (
            <Link key={s.id} href={href({ stage: sp.stage === s.id ? undefined : s.id, page: undefined })} className={`chip ${sp.stage === s.id ? 'chip-on' : ''}`}>
              {s.name} · {r.counts[s.id] ?? 0}
            </Link>
          ))}
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {r.chips.map(([k, label]) => (
          <Link key={k} href={href({ chip: toggleChip(k), page: undefined })} aria-pressed={chips.includes(k)} className={`chip ${chips.includes(k) ? 'chip-on' : ''}`}>
            {label}
          </Link>
        ))}
        <span className="mx-1 h-4 w-px bg-slate-300" aria-hidden />
        {r.views.map((v) => (
          <span key={v.id} className="chip">
            <Link href={`/crm/leads?${v.query}`}>
              ★ {v.name}
              {v.shared ? ' (shared)' : ''}
            </Link>
            {v.user_id === shell.user.id && (
              <button
                aria-label={`Delete view ${v.name}`}
                className="text-slate-600 hover:text-rose-700"
                onClick={async () => {
                  if (await act(`/views/${v.id}/delete`, {}, { quiet: true })) reload();
                }}
              >
                ×
              </button>
            )}
          </span>
        ))}
      </div>

      <details className="card mb-3" open={!!(sp.q || sp.owner || sp.grade || sp.channel || sp.temp || sp.from || sp.to || sp.minscore || Object.keys(sp).some((k) => k.startsWith('cf_') && sp[k]))}>
        <summary className="px-4 py-2 text-xs font-semibold text-slate-700">Filters and saved views</summary>
        <div className="flex flex-wrap items-end gap-2 border-t border-slate-100 px-4 py-3">
          <form method="get" action="/crm/leads" className="flex flex-wrap items-end gap-2">
            {['view', 'phase', 'stage', 'chip', 'year'].map((k) => sp[k] && <input key={k} type="hidden" name={k} value={sp[k]} />)}
            <label>
              <span className="label">Search</span>
              <input name="q" defaultValue={sp.q} placeholder="Name, mobile, email" className="input w-44" />
            </label>
            <label>
              <span className="label">Owner</span>
              <select name="owner" defaultValue={sp.owner ?? ''} className="input w-36">
                <option value="">Anyone</option>
                {r.users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="label">Grade</span>
              <select name="grade" defaultValue={sp.grade ?? ''} className="input w-28">
                <option value="">Any</option>
                {r.grades.map((g) => (
                  <option key={g}>{g}</option>
                ))}
              </select>
            </label>
            <label>
              <span className="label">Channel</span>
              <select name="channel" defaultValue={sp.channel ?? ''} className="input w-32">
                <option value="">Any</option>
                {r.channels.map((c) => (
                  <option key={c.channel}>{c.channel}</option>
                ))}
              </select>
            </label>
            <label>
              <span className="label">Temperature</span>
              <select name="temp" defaultValue={sp.temp ?? ''} className="input w-24">
                <option value="">Any</option>
                <option>Hot</option>
                <option>Warm</option>
                <option>Cold</option>
              </select>
            </label>
            {r.fields.filter((f) => f.type === 'select' && !f.hidden).map((f) => (
              <label key={f.key}>
                <span className="label">{f.label}</span>
                <select name={`cf_${f.key}`} defaultValue={sp[`cf_${f.key}`] ?? ''} className="input w-32">
                  <option value="">Any</option>
                  {f.options.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              </label>
            ))}
            <label>
              <span className="label">Min score</span>
              <input name="minscore" type="number" min={0} max={100} defaultValue={sp.minscore} className="input w-20" />
            </label>
            <label>
              <span className="label">Created from</span>
              <input name="from" type="date" defaultValue={sp.from} className="input w-36" />
            </label>
            <label>
              <span className="label">to</span>
              <input name="to" type="date" defaultValue={sp.to} className="input w-36" />
            </label>
            <button className="btn btn-primary">Apply</button>
            {filtered && (
              <Link href={'/crm/leads' + qs({ view: sp.view })} className="btn">
                Clear all
              </Link>
            )}
          </form>
          {filtered && (
            <form
              className="ml-auto flex items-end gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                const f = formObj(e.currentTarget);
                if (await act('/views', { name: f.name, shared: f.shared === 'on', query: queryString })) {
                  setSaveOpen(false);
                  reload();
                }
              }}
            >
              <label>
                <span className="label">Save this as a view</span>
                <input name="name" required placeholder="View name" className="input w-40" />
              </label>
              {r.can.bulk && (
                <label className="flex items-center gap-1 pb-2 text-xs">
                  <input type="checkbox" name="shared" /> Share with team
                </label>
              )}
              <button className="btn" aria-expanded={saveOpen}>
                Save view
              </button>
            </form>
          )}
        </div>
      </details>

      {!r.data.length ? (
        <div className="card">
          <Empty title={filtered ? 'No leads match these filters' : 'No leads yet for this year'}>
            {filtered ? (
              <>
                Try removing a filter, or{' '}
                <Link className="link" href="/crm/leads">
                  see all leads
                </Link>
                .
              </>
            ) : (
              'Leads arrive from your website form, ads, WhatsApp and walk-ins. Press N to add the first one.'
            )}
          </Empty>
        </div>
      ) : view === 'kanban' ? (
        <Kanban leads={r.data} stages={stages.filter((s) => (sp.stage ? s.id === sp.stage : boardPhases.includes(s.phase_key)))} reasons={r.reasons} canEdit={r.can.edit} onMoved={reload} />
      ) : view === 'cards' ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {r.data.map((l) => (
            <LeadCard key={l.id} l={l} />
          ))}
        </div>
      ) : (
        <>
          {/* Phones get a compact list instead of the wide table. */}
          <ul className="card divide-y divide-slate-100 md:hidden">
            {r.data.map((l) => (
              <li key={l.id}>
                <Link href={`/crm/households/${l.household_id}?e=${l.id}`} className="block px-3 py-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-semibold text-slate-900">{l.student}</span>
                    <Badge tone={l.color}>{l.stage}</Badge>
                  </div>
                  <div className="muted text-xs">
                    {l.grade} · {l.guardian} · {l.mobile}
                  </div>
                  <div className="mt-1 flex items-center justify-between text-xs">
                    <span className="muted">{l.owner}</span>
                    <span className={l.overdue ? 'font-medium text-rose-700' : 'muted'}>{l.next_due ? <>{l.overdue ? 'Overdue: ' : 'Next: '}{new Date(l.next_due).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</> : 'No next action'}</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
          <div className="hidden md:block">
            <LeadTable leads={r.data} total={r.total} query={queryString} stages={stages} users={r.users} templates={r.templates} reasons={r.reasons} can={r.can} fields={r.fields.map((f) => ({ key: f.key, label: f.label }))} onChanged={reload} />
          </div>
        </>
      )}
      {view !== 'kanban' && r.total > r.size && (
        <div className="mt-3 flex items-center justify-between">
          <span className="muted">
            Showing {(page - 1) * r.size + 1}–{Math.min(page * r.size, r.total)} of {r.total}
          </span>
          <div className="flex gap-2">
            {page > 1 && (
              <Link className="btn" href={href({ page: String(page - 1) })}>
                Previous
              </Link>
            )}
            {page * r.size < r.total && (
              <Link className="btn" href={href({ page: String(page + 1) })}>
                Next
              </Link>
            )}
          </div>
        </div>
      )}
    </>
  );
}
