'use client';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { act, formObj, useCrm } from '@/lib/crm/api';
import { age, fmtDate, fmtDateTime, inr, localInput, rel } from '@/lib/crm/fmt';
import { Badge, Empty, ErrorBox, Loading, Temp } from '@/components/crm/ui';
import { TaskDone, type StageOpt } from '@/components/crm/forms';
import { ActionBar } from '@/components/crm/action-bar';

const ICON: Record<string, string> = { call: '📞', whatsapp: '💬', sms: '✉', email: '📧', note: '📝', visit: '🏫', stage_change: '➜', field_change: '✎', payment: '₹', document: '📎', system: '⚙', form: '📄', touch: '◎', task: '✓' };
const TYPE_LABEL: Record<string, string> = { call: 'Call', whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email', note: 'Note', visit: 'Visit', stage_change: 'Stage', field_change: 'Edit', payment: 'Payment', document: 'Document', system: 'System', form: 'Application', touch: 'Source', task: 'Task' };

type Row = Record<string, any>;
type Data = {
  household: Row; guardians: Row[]; enquiries: Row[]; current: Row; activities: Row[]; tasks: Row[]; visits: Row[]; touches: Row[]; application: Row | null; documents: Row[]; payments: Row[];
  fields: { key: string; label: string; type: string; options: string[]; sensitive: boolean; hidden: boolean }[]; stages: (StageOpt & { required_fields: string[] })[]; templates: { id: string; name: string; channel: string; body: string }[];
  users: { id: string; name: string }[]; score: { score: number; parts: { key: string; label: string; count: number; points: number }[] };
  consent: Record<string, boolean | null>; settings: { grades: string[]; boards: string[]; reasons: string[]; fees: { registration: number; admission: number } };
  branches: { id: string; name: string }[]; taskTypes: Record<string, string>; can: Record<string, any>;
};

export default function HouseholdPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Household />
    </Suspense>
  );
}

function Household() {
  const { id } = useParams<{ id: string }>();
  const sp = useSearchParams();
  const e = sp.get('e') ?? '';
  const typeFilter = sp.get('t') ?? '';
  const { data: d, error, reload } = useCrm<Data>(`/households/${id}`, { e, t: typeFilter });
  const [version, setVersion] = useState(0);
  if (error) return <ErrorBox message={error.status === 404 ? 'This family is not available to you. It may belong to a colleague, or it was merged or removed.' : error.message} />;
  if (!d) return <Loading />;
  const cur = d.current;
  const g = d.guardians[0];
  const hh = d.household;
  const openTasks = d.tasks.filter((k) => k.status === 'open');
  const next = [...openTasks].sort((a, b) => +new Date(a.due_at) - +new Date(b.due_at))[0];
  const needsNext = !cur.is_closed && !cur.is_won && !cur.exempt_next_action && !openTasks.length;
  const can = d.can;
  const edit = can.edit;
  const stageOpts: StageOpt[] = d.stages;
  const defaultDue = localInput(new Date(Date.now() + 24 * 3600e3));
  const base = `/crm/households/${id}?e=${cur.id}`;
  const lastCall = d.activities.find((a) => a.type === 'call' && a.outcome === 'connected');
  const lastNote = d.activities.find((a) => a.type === 'note');
  const docsOk = d.documents.filter((x) => x.status === 'verified').length;
  const done = () => {
    setVersion((v) => v + 1);
    reload();
  };
  const F = ({ label, name, value, type = 'text', options }: { label: string; name: string; value: any; type?: string; options?: string[] }) => (
    <label className="block">
      <span className="label">{label}</span>
      {options ? (
        <select name={name} defaultValue={value ?? ''} disabled={!edit} className="input">
          <option value=""></option>
          {options.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      ) : (
        <input name={name} type={type} defaultValue={value ?? ''} readOnly={!edit} className="input" />
      )}
    </label>
  );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/crm/leads" className="muted text-xs hover:underline">
            ← Leads
          </Link>
          <h1 className="text-xl font-semibold text-slate-900">
            {g?.name ?? 'Household'} <span className="muted text-base font-normal">family</span>
          </h1>
          <p className="muted">
            {g?.relation} · +91 {g?.mobile}
            {g?.email ? ` · ${g.email}` : ''}
            {hh?.locality ? ` · ${hh.locality}` : ''}
            {hh?.sibling_in_school && (
              <span className="ml-2">
                <Badge tone="teal">Sibling in school</Badge>
              </span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {edit && <AddSibling id={id} d={d} onDone={done} />}
          {can.merge && (
            <Link href="/crm/admin/data" className="btn" title="Find and merge duplicate families">
              Merge duplicates
            </Link>
          )}
        </div>
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-slate-200" role="tablist" aria-label="Children in this household">
        {d.enquiries.map((x) => (
          <Link key={x.id} href={`/crm/households/${id}?e=${x.id}`} role="tab" aria-selected={x.id === cur.id} className={`tab ${x.id === cur.id ? 'tab-on' : ''}`}>
            {x.student} <span className="muted font-normal">· {x.grade} · {x.year}</span> <Badge tone={x.color}>{x.stage}</Badge>
          </Link>
        ))}
      </div>

      <div className="card flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
        <div>
          <div className="label !mb-0">Stage</div>
          <Badge tone={cur.color}>{cur.stage}</Badge>
          {cur.closure_reason && <span className="muted ml-1 text-xs">({cur.closure_reason})</span>}
        </div>
        <div>
          <div className="label !mb-0">Owner</div>
          {cur.owner}
        </div>
        <div>
          <div className="label !mb-0">Score</div>
          <details className="relative inline-block">
            <summary className="list-none">
              <b>{cur.score}</b> <Temp t={cur.temperature} /> <span className="link text-xs">why?</span>
            </summary>
            <div className="card absolute z-10 mt-1 w-64 p-3 shadow-lg">
              <p className="mb-1 text-xs font-semibold">What moved this score</p>
              {d.score.parts.length ? (
                d.score.parts.map((p) => (
                  <div key={p.key} className="flex justify-between text-xs">
                    <span>
                      {p.label} × {p.count}
                    </span>
                    <span className="font-semibold">+{p.points}</span>
                  </div>
                ))
              ) : (
                <p className="muted text-xs">No scoring activity yet.</p>
              )}
            </div>
          </details>
        </div>
        <div>
          <div className="label !mb-0">Next action</div>
          {next ? (
            <span className={new Date(next.due_at) < new Date() ? 'font-medium text-rose-700' : ''}>
              {next.title} · {rel(next.due_at)}
            </span>
          ) : (
            <span className={needsNext ? 'font-semibold text-rose-700' : 'muted'}>{needsNext ? 'None planned' : 'Not needed in this stage'}</span>
          )}
        </div>
        <div>
          <div className="label !mb-0">Age of enquiry</div>
          {age(cur.created_at)}
        </div>
        <div>
          <div className="label !mb-0">Branch · year</div>
          {cur.branch} · {cur.year}
        </div>
        {cur.application_no && (
          <div>
            <div className="label !mb-0">Application</div>
            <Link className="link" href={`/crm/applications/${cur.id}`}>
              {cur.application_no}
            </Link>
          </div>
        )}
        <div className="flex flex-wrap gap-1">
          {cur.reenquired && <Badge tone="amber">Re-enquired</Badge>}
          {(cur.tags as string[]).map((x) => (
            <Badge key={x}>{x}</Badge>
          ))}
        </div>
      </div>

      {needsNext && can.tasks && (
        <form
          className="flex flex-wrap items-end gap-3 rounded-lg border border-rose-300 bg-rose-50 px-4 py-3"
          onSubmit={async (ev) => {
            ev.preventDefault();
            if (await act(`/leads/${cur.id}/task`, formObj(ev.currentTarget))) done();
          }}
        >
          <p className="w-full font-semibold text-rose-900">This enquiry has no next action. Plan one now so it is not forgotten.</p>
          <label>
            <span className="label">Task</span>
            <input name="title" defaultValue="Follow-up call" required className="input w-56" />
          </label>
          <label>
            <span className="label">Due</span>
            <input type="datetime-local" name="dueAt" defaultValue={defaultDue} required className="input" />
          </label>
          <button className="btn btn-primary">Plan next action</button>
        </form>
      )}

      <div className="card border-teal-200 bg-teal-50 px-4 py-3">
        <p className="text-xs font-semibold text-teal-900">
          At a glance <span className="font-normal text-slate-700">(built from this record&apos;s data, not AI)</span>
        </p>
        <ul className="mt-1 space-y-0.5 text-slate-800">
          <li>
            <b>Who:</b> {g?.name}
            {g?.occupation ? `, ${String(g.occupation).toLowerCase()}` : ''}
            {hh?.locality ? `, from ${hh.locality}` : ''}; {d.enquiries.length > 1 ? `${d.enquiries.length} enquiries in this family` : 'one child enquiring'}. Looking at {cur.grade ?? 'a grade not yet set'} ({cur.board ?? 'board not set'}) at {cur.branch}.
          </li>
          <li>
            <b>What they care about:</b> {lastNote?.content ?? lastCall?.content ?? 'Nothing recorded yet. Ask about transport, fees and timings on the first call.'}
          </li>
          <li>
            <b>What to do next:</b> {next ? `${next.title}, ${rel(next.due_at)}.` : cur.is_won ? 'Admission is confirmed. Send onboarding details.' : cur.is_closed ? 'Closed. A new enquiry from this family will reopen it.' : 'Plan the next follow-up.'}
          </li>
        </ul>
      </div>

      <ActionBar
        key={cur.id}
        enquiryId={cur.id}
        mobile={g?.mobile ?? ''}
        stageId={cur.stage_id}
        stages={stageOpts}
        reasons={d.settings.reasons}
        templates={d.templates}
        users={d.users}
        defaultDue={defaultDue}
        initial={sp.get('panel') ?? undefined}
        hasApplication={!!d.application}
        fees={d.settings.fees}
        can={{ edit, message: can.message, tasks: can.tasks, reassign: can.reassign, application: can.application, pay: can.pay }}
        onDone={done}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <section className="card min-w-0" aria-label="Timeline">
          <div className="card-h">
            <h2>
              Timeline <span className="muted font-normal">all children, all channels</span>
            </h2>
          </div>
          <div className="flex flex-wrap gap-1.5 border-b border-slate-100 px-4 py-2">
            <Link href={base} className={`chip ${!typeFilter ? 'chip-on' : ''}`}>
              Everything
            </Link>
            {['call', 'whatsapp', 'sms', 'email', 'note', 'visit', 'stage_change', 'payment', 'document'].map((k) => (
              <Link key={k} href={`${base}&t=${k}`} className={`chip ${typeFilter === k ? 'chip-on' : ''}`}>
                {TYPE_LABEL[k]}
              </Link>
            ))}
          </div>
          {!d.activities.length && <Empty title="Nothing here yet">Calls, messages, visits, stage moves and edits appear here as they happen.</Empty>}
          <ol className="divide-y divide-slate-100">
            {d.activities.map((a) => {
              const failed = a.meta?.status === 'failed';
              const child = d.enquiries.length > 1 ? d.enquiries.find((x) => x.id === a.enquiry_id)?.student : null;
              return (
                <li key={a.id} className="flex gap-3 px-4 py-2.5">
                  <span aria-hidden className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100 text-sm">
                    {ICON[a.type] ?? '•'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
                      <span className="font-semibold text-slate-800">
                        {TYPE_LABEL[a.type] ?? a.type}
                        {a.meta?.direction === 'in' ? ' from parent' : a.meta?.direction === 'out' ? ' to parent' : ''}
                      </span>
                      {child && <span className="muted">{child}</span>}
                      <span className="muted">
                        {a.actor ?? (a.meta?.direction === 'in' ? g?.name : 'Automatic')} · {fmtDateTime(a.created_at)}
                      </span>
                    </div>
                    <p className={`mt-0.5 whitespace-pre-wrap break-words ${failed ? 'font-medium text-rose-700' : 'text-slate-900'}`}>{a.content}</p>
                    {failed && a.meta?.body && <p className="muted mt-0.5 text-xs">Message was: {a.meta.body}</p>}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>

        <aside className="min-w-0 space-y-4">
          <section className="card" aria-label="Tasks">
            <div className="card-h">
              <h2>Tasks</h2>
            </div>
            {!d.tasks.length && <Empty title="No tasks yet" />}
            <ul className="divide-y divide-slate-100">
              {d.tasks.slice(0, 8).map((k) => (
                <li key={k.id} className="flex items-center justify-between gap-2 px-4 py-2">
                  <div className="min-w-0">
                    <div className={k.status !== 'open' ? 'muted line-through' : 'font-medium'}>{k.title}</div>
                    <div className={`text-xs ${k.status === 'open' && new Date(k.due_at) < new Date() ? 'text-rose-700' : 'muted'}`}>
                      {d.taskTypes[k.type] ?? k.type} · {k.owner} · {k.status === 'open' ? rel(k.due_at) : k.status === 'done' ? `done: ${k.outcome ?? ''}` : 'cancelled'}
                    </div>
                  </div>
                  {k.status === 'open' && can.tasks && <TaskDone taskId={k.id} title={k.title} lastOpen={openTasks.length === 1 && !cur.exempt_next_action} stages={stageOpts} reasons={d.settings.reasons} defaultDue={defaultDue} onDone={done} />}
                </li>
              ))}
            </ul>
          </section>

          <section className="card" aria-label="Details">
            <div className="card-h">
              <h2>Details</h2>
            </div>
            <form
              key={`${cur.id}-${version}`}
              className="space-y-2 p-4"
              onSubmit={async (ev) => {
                ev.preventDefault();
                const r = await act(`/leads/${cur.id}/details`, formObj(ev.currentTarget));
                if (r) done();
              }}
            >
              <p className="text-xs font-semibold text-slate-700">Student</p>
              <F label="Name" name="s_name" value={cur.student} />
              <div className="grid grid-cols-2 gap-2">
                <F label="Grade applying for" name="e_grade" value={cur.grade} options={d.settings.grades} />
                <F label="Board" name="e_board" value={cur.board} options={d.settings.boards} />
                {can.sensitive ? (
                  <F label="Date of birth" name="s_dob" value={cur.dob} type="date" />
                ) : (
                  <label className="block">
                    <span className="label">Date of birth</span>
                    <input disabled value={cur.dob ? '••••••' : ''} className="input" title="Hidden for your role" aria-label="Date of birth (hidden for your role)" />
                  </label>
                )}
                <F label="Gender" name="s_gender" value={cur.gender ? cur.gender[0].toUpperCase() + cur.gender.slice(1) : ''} options={['Female', 'Male', 'Other']} />
              </div>
              <F label="Current school" name="s_current_school" value={cur.current_school} />
              {can.sensitive && <F label="Special needs note (restricted)" name="s_special_needs" value={cur.special_needs} />}
              <F label="Expected decision date" name="e_expected_decision" value={cur.expected_decision} type="date" />
              {d.fields.map((f) =>
                f.sensitive && !can.sensitive ? (
                  <label key={f.key} className="block">
                    <span className="label">{f.label}</span>
                    <input disabled value={cur.custom?.[f.key] ? '••••••' : ''} className="input" title="Hidden for your role" aria-label={`${f.label} (hidden for your role)`} />
                  </label>
                ) : (
                  <F key={f.key} label={f.label} name={'cf_' + f.key} value={cur.custom?.[f.key]} options={f.type === 'select' ? f.options : undefined} />
                ),
              )}
              <p className="pt-2 text-xs font-semibold text-slate-700">Parent and home</p>
              <F label="Parent name" name="g_name" value={g?.name} />
              <div className="grid grid-cols-2 gap-2">
                <F label="Relation" name="g_relation" value={g?.relation ? g.relation[0].toUpperCase() + g.relation.slice(1) : ''} options={['Father', 'Mother', 'Guardian', 'Other']} />
                <F label="Alternate mobile" name="g_alt_mobile" value={g?.alt_mobile} />
              </div>
              <F label="Email" name="g_email" value={g?.email} type="email" />
              <F label="Occupation" name="g_occupation" value={g?.occupation} />
              <F label="Address" name="h_address" value={hh?.address} />
              <div className="grid grid-cols-2 gap-2">
                <F label="Locality" name="h_locality" value={hh?.locality} />
                <F label="PIN code" name="h_pincode" value={hh?.pincode} />
              </div>
              <F label="How they heard about us" name="h_heard_about" value={hh?.heard_about} />
              <F label="Sibling already in school" name="h_sibling_in_school" value={hh?.sibling_in_school ? 'yes' : 'no'} options={['yes', 'no']} />
              {edit && <button className="btn btn-primary w-full">Save details</button>}
            </form>
          </section>

          <section className="card" aria-label="Visits">
            <div className="card-h">
              <h2>Visits</h2>
            </div>
            {!d.visits.length && <Empty title="No visits booked">Use Book visit in the action bar.</Empty>}
            <ul className="divide-y divide-slate-100">
              {d.visits.map((v) => (
                <VisitRow key={v.id} v={v} can={can.tasks} onDone={done} />
              ))}
            </ul>
          </section>

          <section className="card" aria-label="Application">
            <div className="card-h">
              <h2>Application</h2>
              {d.application && (
                <Link href={`/crm/applications/${cur.id}`} className="link text-xs">
                  Open
                </Link>
              )}
            </div>
            <div className="space-y-1 px-4 py-3">
              {!d.application ? (
                <p className="muted">Not started. Use Form / payment in the action bar.</p>
              ) : (
                <>
                  <p>{d.application.status === 'submitted' ? `Submitted ${fmtDate(d.application.submitted_at)}` : `In progress: ${d.application.progress}% of required answers`}</p>
                  <p className="muted text-xs">
                    Documents verified: {docsOk} of {d.documents.length}
                  </p>
                </>
              )}
              {d.payments.map((p) => (
                <p key={p.id} className="text-xs">
                  {p.purpose}: {inr(p.amount)} ·{' '}
                  <span className={p.status === 'paid' ? 'text-green-800' : p.status === 'failed' ? 'text-rose-700' : 'text-amber-800'}>{p.status === 'pending' && p.mode !== 'link' ? 'awaiting verification' : p.status}</span>
                  {p.receipt_no ? ` · ${p.receipt_no}` : ''}
                </p>
              ))}
            </div>
          </section>

          <section className="card" aria-label="Source touches">
            <div className="card-h">
              <h2>Source touches</h2>
            </div>
            <ul className="divide-y divide-slate-100">
              {d.touches.map((x, i) => (
                <li key={x.id} className="px-4 py-2">
                  <span className="font-medium">{x.source}</span> <span className="muted">({x.channel})</span>
                  {i === 0 && (
                    <span className="ml-1">
                      <Badge>First touch</Badge>
                    </span>
                  )}
                  {i > 0 && i === d.touches.length - 1 && (
                    <span className="ml-1">
                      <Badge>Latest</Badge>
                    </span>
                  )}
                  <div className="muted text-xs">
                    {x.campaign ? `Campaign: ${x.campaign} · ` : ''}
                    {fmtDateTime(x.created_at)}
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section className="card px-4 py-3 text-xs" aria-label="Consent">
            <p className="font-semibold text-slate-800">Consent</p>
            <p className="muted mt-1">
              {['whatsapp', 'sms', 'email', 'call'].map((c) => `${c}: ${d.consent[c] === false ? 'opted out' : d.consent[c] === true ? 'yes' : 'not recorded'}`).join(' · ')}
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}

function VisitRow({ v, can, onDone }: { v: Row; can: boolean; onDone: () => void }) {
  const [outcome, setOutcome] = useState('');
  const go = async (what: string) => {
    if (await act(`/visits/${v.id}`, { what, outcome })) onDone();
  };
  return (
    <li className="px-4 py-2">
      <div className="flex items-center justify-between">
        <span className="font-medium">{fmtDateTime(v.slot_at)}</span>
        <Badge tone={v.status === 'done' ? 'green' : v.status === 'scheduled' ? 'violet' : 'rose'}>{v.status === 'no_show' ? 'No-show' : v.status[0].toUpperCase() + v.status.slice(1)}</Badge>
      </div>
      <div className="muted text-xs">
        {String(v.type).replace('_', ' ')} · host {v.host ?? 'not set'}
        {v.outcome ? ` · ${v.outcome}` : ''}
      </div>
      {v.status === 'scheduled' && can && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <input value={outcome} onChange={(e) => setOutcome(e.target.value)} placeholder="Outcome (needed for Done)" aria-label="Visit outcome" className="input !w-full !py-1 text-xs" />
          {!v.checked_in_at && (
            <button className="btn btn-sm" onClick={() => go('check_in')}>
              Check in
            </button>
          )}
          <button className="btn btn-sm" onClick={() => go('done')}>
            Done
          </button>
          <button className="btn btn-sm" onClick={() => go('no_show')}>
            No-show
          </button>
          <button className="btn btn-sm" onClick={() => go('cancel')}>
            Cancel
          </button>
        </div>
      )}
    </li>
  );
}

function AddSibling({ id, d, onDone }: { id: string; d: Data; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="relative" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="btn list-none">+ Add sibling</summary>
      <form
        className="card absolute right-0 z-10 mt-1 w-80 space-y-2 p-3 shadow-lg"
        onSubmit={async (ev) => {
          ev.preventDefault();
          if (await act(`/households/${id}/sibling`, formObj(ev.currentTarget))) {
            setOpen(false);
            onDone();
          }
        }}
      >
        <p className="muted text-xs">Parent and address details are reused from this household.</p>
        <label className="block">
          <span className="label">Child&apos;s name</span>
          <input name="studentName" required className="input" />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label>
            <span className="label">Grade</span>
            <select name="grade" required className="input">
              {d.settings.grades.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="label">Date of birth</span>
            <input type="date" name="dob" className="input" />
          </label>
        </div>
        <label className="block">
          <span className="label">Branch</span>
          <select name="branchId" defaultValue={d.current.branch_id} className="input">
            {d.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <button className="btn btn-primary w-full">Add sibling</button>
      </form>
    </details>
  );
}
