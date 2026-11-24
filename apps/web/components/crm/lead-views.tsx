'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { act, crm, flash, formObj } from '@/lib/crm/api';
import { fmtDate, rel } from '@/lib/crm/fmt';
import { Badge, DOTS, Modal, Temp } from './ui';

export type Lead = {
  id: string; household_id: string; student: string; guardian: string | null; mobile: string | null; grade: string | null; branch: string; stage: string; stage_id: string; color: string; phase: string;
  owner: string; score: number; temperature: string | null; source: string | null; created_at: string; next_due: string | null; next_title: string | null; overdue: boolean; reenquired: boolean; family: number; untouched: boolean; tags: string[]; custom: Record<string, string>;
};
export type Stage = { id: string; name: string; color: string; phase_name: string; required_fields: string[]; is_closed: boolean; phase_key?: string };
type Opt = { id: string; name: string };
export type LeadCaps = { bulk: boolean; reassign: boolean; edit: boolean; message: boolean; export: boolean; tasks: boolean };

const COLS: [string, string][] = [['guardian', 'Parent'], ['grade', 'Grade'], ['branch', 'Branch'], ['stage', 'Stage'], ['owner', 'Owner'], ['score', 'Score'], ['next', 'Next action'], ['source', 'Source'], ['created', 'Created']];

export function NextCell({ l }: { l: Lead }) {
  if (!l.next_due) return <span className="muted">None</span>;
  return (
    <span className={l.overdue ? 'font-medium text-rose-700' : ''} title={l.next_title ?? ''}>
      {l.overdue ? 'Overdue: ' : ''}
      {rel(l.next_due)}
    </span>
  );
}

export function LeadCard({ l }: { l: Lead }) {
  return (
    <Link href={`/crm/households/${l.household_id}?e=${l.id}`} className="card block p-3 hover:border-teal-600">
      <div className="flex items-start justify-between gap-2">
        <span className="font-semibold text-slate-900">{l.student}</span>
        <Badge tone={l.color}>{l.stage}</Badge>
      </div>
      <div className="muted">
        {l.grade} · {l.branch}
      </div>
      <div className="mt-2">
        {l.guardian} · {l.mobile}
      </div>
      <div className="mt-2 flex items-center justify-between text-xs">
        <span>
          <Temp t={l.temperature} /> <span className="muted ml-1">Score {l.score} · {l.owner}</span>
        </span>
        <span className={l.overdue ? 'font-medium text-rose-700' : 'muted'}>{l.next_due ? <NextCell l={l} /> : 'No next action'}</span>
      </div>
    </Link>
  );
}

export function LeadTable({ leads, total, query, stages, users, templates, reasons, can, fields, onChanged }: { leads: Lead[]; total: number; query: string; stages: Stage[]; users: Opt[]; templates: Opt[]; reasons: string[]; can: LeadCaps; fields: { key: string; label: string }[]; onChanged: () => void }) {
  // Custom fields are columns like any other (CF-01); they start hidden so the default table stays readable.
  const cols: [string, string][] = [...COLS, ...fields.map((f) => ['cf:' + f.key, f.label] as [string, string])];
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [all, setAll] = useState(false);
  const [hidden, setHidden] = useState<string[]>([]);
  const [action, setAction] = useState('');
  const [stageId, setStageId] = useState('');
  const [dense, setDense] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    try {
      setHidden(JSON.parse(localStorage.getItem('crm_cols') ?? '[]'));
      setDense(localStorage.getItem('crm_dense') === '1');
    } catch {
      /* first visit */
    }
  }, []);
  const toggleCol = (k: string) =>
    setHidden((h) => {
      const key = k.startsWith('cf:') ? '+' + k : k;
      const n = h.includes(key) ? h.filter((x) => x !== key) : [...h, key];
      try {
        localStorage.setItem('crm_cols', JSON.stringify(n));
      } catch {
        /* storage blocked */
      }
      return n;
    });
  const show = (k: string) => (k.startsWith('cf:') ? hidden.includes('+' + k) : !hidden.includes(k));
  const count = all ? total : sel.size;
  const pad = dense ? '!py-1' : '';
  const stage = stages.find((s) => s.id === stageId);
  async function apply(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!window.confirm(`Apply this to ${count} record${count === 1 ? '' : 's'}?`)) return;
    setBusy(true);
    const r = await act('/leads/bulk', { ...formObj(e.currentTarget), ids: [...sel], all, query });
    setBusy(false);
    if (r) {
      setSel(new Set());
      setAll(false);
      setAction('');
      onChanged();
    }
  }
  async function exportCsv() {
    const q = new URLSearchParams(all ? query : `year=all&ids=${[...sel].join(',')}`);
    const res = await fetch(`/api/crm/export?${q}`, { headers: {} });
    if (!res.ok) return flash('Could not export.', 'error');
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'leads.csv';
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="card overflow-hidden">
      {can.bulk && count > 0 && (
        <form onSubmit={apply} className="flex flex-wrap items-center gap-2 border-b border-teal-200 bg-teal-50 px-3 py-2" aria-label="Bulk actions">
          <span className="font-semibold text-teal-900" aria-live="polite">
            {count} selected
          </span>
          {!all && sel.size === leads.length && total > leads.length && (
            <button type="button" onClick={() => setAll(true)} className="link text-xs">
              Select all {total} matching this filter
            </button>
          )}
          <select name="action" required value={action} onChange={(e) => setAction(e.target.value)} className="input w-auto" aria-label="Action">
            <option value="">Choose an action…</option>
            {can.edit && <option value="stage">Change stage</option>}
            {can.reassign && <option value="reassign">Reassign</option>}
            {can.tasks && <option value="task">Add task</option>}
            {can.message && <option value="message">Send template</option>}
            <option value="tag">Add tag</option>
          </select>
          {action === 'stage' && (
            <select name="stageId" required className="input w-auto" aria-label="Stage" onChange={(e) => setStageId(e.target.value)}>
              <option value="">Stage…</option>
              {stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.phase_name}: {s.name}
                </option>
              ))}
            </select>
          )}
          {action === 'stage' && stage?.required_fields.includes('closure_reason') && (
            <select name="closure_reason" required className="input w-auto" aria-label="Closure reason">
              <option value="">Closure reason…</option>
              {reasons.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          )}
          {action === 'reassign' && (
            <>
              <select name="ownerId" required className="input w-auto" aria-label="Assign to">
                <option value="">Assign to…</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
              <input name="reason" placeholder="Reason" required className="input w-40" aria-label="Reason" />
            </>
          )}
          {action === 'task' && (
            <>
              <input name="title" placeholder="Task title" required className="input w-48" aria-label="Task title" />
              <input type="datetime-local" name="dueAt" required className="input w-auto" aria-label="Due" />
            </>
          )}
          {action === 'message' && (
            <select name="templateId" required className="input w-auto" aria-label="Template">
              <option value="">Template…</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          )}
          {action === 'tag' && <input name="tag" placeholder="Tag" required className="input w-40" aria-label="Tag" />}
          <button className="btn btn-primary" disabled={busy || !action}>
            Apply to {count}
          </button>
          {can.export && (
            <button type="button" className="btn" onClick={exportCsv}>
              Export CSV
            </button>
          )}
          <button
            type="button"
            className="btn"
            onClick={() => {
              setSel(new Set());
              setAll(false);
            }}
          >
            Clear
          </button>
        </form>
      )}
      <div className="flex items-center justify-end gap-3 border-b border-slate-100 px-3 py-1.5 text-xs">
        <details className="relative">
          <summary className="link list-none">Columns</summary>
          <div className="card absolute right-0 z-10 mt-1 w-44 p-2 shadow-lg">
            {cols.map(([k, label]) => (
              <label key={k} className="flex items-center gap-2 py-0.5">
                <input type="checkbox" checked={show(k)} onChange={() => toggleCol(k)} />
                {label}
              </label>
            ))}
          </div>
        </details>
        <button
          className="link"
          onClick={() =>
            setDense((d) => {
              try {
                localStorage.setItem('crm_dense', d ? '0' : '1');
              } catch {
                /* storage blocked */
              }
              return !d;
            })
          }
        >
          {dense ? 'Comfortable rows' : 'Compact rows'}
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="tbl">
          <caption className="sr-only">Leads</caption>
          <thead>
            <tr>
              {can.bulk && (
                <th className="w-8">
                  <input
                    type="checkbox"
                    aria-label="Select all on this page"
                    checked={leads.length > 0 && sel.size === leads.length}
                    onChange={(e) => {
                      setAll(false);
                      setSel(e.target.checked ? new Set(leads.map((l) => l.id)) : new Set());
                    }}
                  />
                </th>
              )}
              <th className="sticky left-0 bg-slate-50">Student</th>
              {cols.filter(([k]) => show(k)).map(([k, label]) => (
                <th key={k}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {leads.map((l) => (
              <tr key={l.id}>
                {can.bulk && (
                  <td className={pad}>
                    <input
                      type="checkbox"
                      aria-label={`Select ${l.student}`}
                      checked={all || sel.has(l.id)}
                      onChange={() => {
                        setAll(false);
                        setSel((s) => {
                          const n = new Set(s);
                          if (n.has(l.id)) n.delete(l.id);
                          else n.add(l.id);
                          return n;
                        });
                      }}
                    />
                  </td>
                )}
                <td className={`sticky left-0 bg-white ${pad}`}>
                  <Link href={`/crm/households/${l.household_id}?e=${l.id}`} className="link">
                    {l.student}
                  </Link>
                  {l.family > 1 && (
                    <span className="ml-1.5" title="More than one child in this household">
                      <Badge tone="teal">Family of {l.family}</Badge>
                    </span>
                  )}
                  {l.reenquired && (
                    <span className="ml-1.5">
                      <Badge tone="amber">Re-enquired</Badge>
                    </span>
                  )}
                </td>
                {show('guardian') && (
                  <td className={pad}>
                    {l.guardian}
                    <span className="muted block text-xs">{l.mobile}</span>
                  </td>
                )}
                {show('grade') && <td className={pad}>{l.grade}</td>}
                {show('branch') && <td className={pad}>{l.branch}</td>}
                {show('stage') && (
                  <td className={pad}>
                    <Badge tone={l.color}>{l.stage}</Badge>
                  </td>
                )}
                {show('owner') && <td className={pad}>{l.owner}</td>}
                {show('score') && (
                  <td className={pad}>
                    <span className="mr-1.5 tabular-nums">{l.score}</span>
                    <Temp t={l.temperature} />
                  </td>
                )}
                {show('next') && (
                  <td className={pad}>
                    <NextCell l={l} />
                  </td>
                )}
                {show('source') && <td className={pad}>{l.source}</td>}
                {show('created') && <td className={`${pad} whitespace-nowrap`}>{fmtDate(l.created_at)}</td>}
                {fields.filter((f) => show('cf:' + f.key)).map((f) => (
                  <td key={f.key} className={pad}>
                    {l.custom?.[f.key]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function Kanban({ leads, stages, reasons, canEdit, onMoved }: { leads: Lead[]; stages: Stage[]; reasons: string[]; canEdit: boolean; onMoved: () => void }) {
  const [items, setItems] = useState(leads);
  const [over, setOver] = useState<string | null>(null);
  const [ask, setAsk] = useState<{ lead: Lead; stage: Stage; missing: string[] } | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  useEffect(() => setItems(leads), [leads]);
  const byStage = useMemo(() => {
    const m: Record<string, Lead[]> = {};
    for (const l of items) (m[l.stage_id] ??= []).push(l);
    return m;
  }, [items]);

  async function drop(leadId: string, stage: Stage, extra: { closure_reason?: string } = {}) {
    const lead = items.find((l) => l.id === leadId);
    if (!lead || lead.stage_id === stage.id) return;
    setPending(true);
    try {
      const res = await crm<{ ok: boolean; missing?: string[]; error?: string }>('POST', `/leads/${leadId}/stage`, { stageId: stage.id, ...extra });
      if (res.ok) {
        setItems((xs) => xs.map((l) => (l.id === leadId ? { ...l, stage_id: stage.id, stage: stage.name, color: stage.color } : l)));
        setAsk(null);
        setError('');
        onMoved();
      } else if (res.missing) setAsk({ lead, stage, missing: res.missing });
      else setError(res.error ?? 'Could not move this record.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not move this record.');
    } finally {
      setPending(false);
    }
  }
  /** The same move for people who cannot drag: a select on the card. */
  const moveTo = (l: Lead, stageId: string) => {
    const st = stages.find((s) => s.id === stageId);
    if (st) void drop(l.id, st);
  };
  return (
    <>
      {error && (
        <p role="alert" className="mb-2 rounded-md bg-rose-50 px-3 py-2 text-rose-800">
          {error}
        </p>
      )}
      <div className={`flex gap-3 overflow-x-auto pb-3 ${pending ? 'opacity-70' : ''}`}>
        {stages.map((s) => (
          <section
            key={s.id}
            aria-label={s.name}
            onDragOver={(e) => {
              if (canEdit) {
                e.preventDefault();
                setOver(s.id);
              }
            }}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              void drop(e.dataTransfer.getData('text/plain'), s);
            }}
            className={`flex w-64 shrink-0 flex-col rounded-lg border bg-slate-100 ${over === s.id ? 'border-teal-600 bg-teal-50' : 'border-slate-200'}`}
          >
            <header className="flex items-center justify-between px-3 py-2">
              <h3 className="flex items-center gap-1.5 text-xs font-semibold text-slate-800">
                <span className={`h-2 w-2 rounded-full ${DOTS[s.color]}`} aria-hidden />
                {s.name}
              </h3>
              <span className="text-xs font-semibold text-slate-700">{byStage[s.id]?.length ?? 0}</span>
            </header>
            <div className="max-h-[65vh] min-h-16 space-y-2 overflow-y-auto px-2 pb-2">
              {(byStage[s.id] ?? []).map((l) => (
                <article key={l.id} draggable={canEdit} onDragStart={(e) => e.dataTransfer.setData('text/plain', l.id)} className={`card p-2.5 shadow-sm ${canEdit ? 'cursor-grab active:cursor-grabbing' : ''}`}>
                  <Link href={`/crm/households/${l.household_id}?e=${l.id}`} className="link">
                    {l.student}
                  </Link>
                  <div className="muted text-xs">
                    {l.grade} · {l.guardian}
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1">
                    <Temp t={l.temperature} />
                    <span className="text-xs text-slate-700">Score {l.score}</span>
                  </div>
                  <div className="mt-1.5 flex items-center justify-between text-xs">
                    <span className="muted">{l.owner}</span>
                    <NextCell l={l} />
                  </div>
                  {canEdit && (
                    <select aria-label={`Move ${l.student} to stage`} value="" onChange={(e) => moveTo(l, e.target.value)} className="input mt-2 !min-h-[28px] !py-0.5 text-xs">
                      <option value="">Move to…</option>
                      {stages.filter((x) => x.id !== l.stage_id).map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name}
                        </option>
                      ))}
                    </select>
                  )}
                </article>
              ))}
              {!byStage[s.id]?.length && <p className="muted px-1 py-3 text-center text-xs">{canEdit ? 'Drop a card here' : 'No records'}</p>}
            </div>
          </section>
        ))}
      </div>
      <Modal open={!!ask} onClose={() => setAsk(null)} title={ask ? `Move ${ask.lead.student} to ${ask.stage.name}` : 'Move'}>
        {ask && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = formObj(e.currentTarget);
              void drop(ask.lead.id, ask.stage, { closure_reason: f.closure_reason || undefined });
            }}
          >
            <div className="card-h">
              Move {ask.lead.student} to {ask.stage.name}
            </div>
            <div className="space-y-3 p-4">
              {ask.missing.includes('closure_reason') && (
                <label className="block">
                  <span className="label">Why is this enquiry closing?</span>
                  <select name="closure_reason" required className="input">
                    <option value="">Choose a reason</option>
                    {reasons.map((r) => (
                      <option key={r}>{r}</option>
                    ))}
                  </select>
                </label>
              )}
              {ask.missing.includes('visit') && (
                <p>
                  This stage needs a booked campus visit.{' '}
                  <Link className="link" href={`/crm/households/${ask.lead.household_id}?e=${ask.lead.id}&panel=visit`}>
                    Book the visit
                  </Link>{' '}
                  and the record moves here by itself.
                </p>
              )}
              {ask.missing.includes('expected_decision') && <p>This stage needs an expected decision date. Set it on the record first.</p>}
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-200 p-3">
              <button type="button" className="btn" onClick={() => setAsk(null)}>
                Cancel
              </button>
              {ask.missing.includes('closure_reason') && (
                <button className="btn btn-primary" disabled={pending}>
                  Move
                </button>
              )}
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}
