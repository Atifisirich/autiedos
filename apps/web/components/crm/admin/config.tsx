'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { act, formObj, post } from '@/lib/crm/api';
import { fmtDateTime, inr } from '@/lib/crm/fmt';
import { Badge, Empty, Field } from '../ui';
import { AForm, CardSection, multi, useAdmin, type Row } from './common';

// ---------------------------------------------------------------- sources
export function Sources() {
  const { data: d, gate, reload } = useAdmin<Row>('/admin/sources');
  if (gate) return gate;
  const rows: (Row | null)[] = [null, ...d!.sources];
  return (
    <CardSection title="Channel › source" actions={<span className="muted font-normal">Spend feeds cost per lead and per admission in Reports</span>}>
      <div className="divide-y divide-slate-100">
        {rows.map((s) => (
          <AForm key={s?.id ?? 'new'} path="/admin/sources" onDone={reload} reset={!s} map={(f) => ({ ...f, active: f.active !== 'off' })} className={`flex flex-wrap items-end gap-3 px-4 py-2.5 ${s ? '' : 'bg-slate-50'}`}>
            {s && <input type="hidden" name="id" value={s.id} />}
            <label>
              <span className="label">{s ? 'Channel' : 'Add: channel'}</span>
              <input name="channel" defaultValue={s?.channel} required className="input w-40" list="crm-channels" />
            </label>
            <label>
              <span className="label">Source</span>
              <input name="name" defaultValue={s?.name} required className="input w-64" />
            </label>
            <label>
              <span className="label">Spend this season (₹)</span>
              <input name="cost" type="number" min={0} defaultValue={s?.cost ?? 0} className="input w-36" />
            </label>
            {s && (
              <label>
                <span className="label">Status</span>
                <select name="active" defaultValue={s.active ? 'on' : 'off'} className="input w-28">
                  <option value="on">Active</option>
                  <option value="off">Inactive</option>
                </select>
              </label>
            )}
            <button className="btn">{s ? 'Save' : 'Add source'}</button>
            {s && (
              <span className="muted pb-2 text-xs">
                {s.touches} touches{s.cost > 0 && s.touches ? ` · ${inr(s.cost / s.touches)} per lead` : ''}
              </span>
            )}
          </AForm>
        ))}
        <datalist id="crm-channels">
          {[...new Set((d!.sources as Row[]).map((r) => r.channel as string))].map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </div>
    </CardSection>
  );
}

// ---------------------------------------------------------------- routing and scoring
export function Routing() {
  const { data: d, gate, reload } = useAdmin<Row>('/admin/routing');
  const [sim, setSim] = useState('');
  if (gate) return gate;
  const RuleForm = ({ r }: { r?: Row }) => (
    <AForm path="/admin/rules" onDone={reload} reset={!r} map={(f) => ({ ...f, userIds: multi(f, 'userIds'), grades: multi(f, 'grades'), what: f.what ?? 'save' })} className="grid items-end gap-2 md:grid-cols-7">
      {r && <input type="hidden" name="id" value={r.id} />}
      <label>
        <span className="label">Order</span>
        <input name="position" type="number" defaultValue={r?.seq ?? d!.rules.length + 1} className="input" />
      </label>
      <label>
        <span className="label">Rule name</span>
        <input name="name" required defaultValue={r?.name} className="input" />
      </label>
      <label>
        <span className="label">If branch is</span>
        <select name="branch_id" defaultValue={r?.conditions?.branch_id ?? ''} className="input">
          <option value="">Any branch</option>
          {d!.branches.map((b: Row) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className="label">and channel is</span>
        <select name="channel" defaultValue={r?.conditions?.channel ?? ''} className="input">
          <option value="">Any channel</option>
          {(d!.channels as string[]).map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </label>
      <label>
        <span className="label">Distribute by</span>
        <select name="method" defaultValue={r?.method ?? 'round_robin'} className="input">
          <option value="round_robin">Round robin</option>
          <option value="least_load">Least open load</option>
        </select>
      </label>
      <label>
        <span className="label">To (hold Ctrl to pick several)</span>
        <select name="userIds" multiple defaultValue={r?.user_ids ?? []} className="input h-20">
          {d!.users.map((u: Row) => (
            <option key={u.id} value={u.id}>
              {u.name}
              {u.on_leave ? ' (on leave)' : ''}
            </option>
          ))}
        </select>
      </label>
      <div className="flex gap-1.5">
        <button name="what" value="save" className="btn btn-primary">
          {r ? 'Save' : 'Add rule'}
        </button>
        {r && (
          <button name="what" value="delete" className="btn btn-danger">
            Delete
          </button>
        )}
      </div>
    </AForm>
  );
  return (
    <div className="space-y-4">
      <CardSection title="Assignment rules, checked top to bottom">
        <p className="muted px-4 pt-3 text-xs">Before any rule: a family that already has a counsellor stays with them (sticky owner). People on leave or at their daily capacity are skipped. If no rule fits, the least-loaded available person in the branch gets the lead.</p>
        <div className="space-y-3 p-4">
          {d!.rules.map((r: Row) => (
            <div key={r.id} className="rounded-md border border-slate-200 p-3">
              <RuleForm r={r} />
            </div>
          ))}
          <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-3">
            <RuleForm />
          </div>
        </div>
      </CardSection>
      <CardSection title="Rule simulator">
        <AForm
          path="/assignment/simulate"
          className="flex flex-wrap items-end gap-3 p-4"
          onDone={(r) => setSim(r.text)}
        >
          <label>
            <span className="label">Branch</span>
            <select name="branchId" className="input w-48">
              {d!.branches.map((b: Row) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="label">Grade</span>
            <select name="grade" className="input w-32">
              <option value="">Any</option>
              {(d!.grades as string[]).map((g) => (
                <option key={g}>{g}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="label">Channel</span>
            <select name="channel" className="input w-36">
              <option value="">Any</option>
              {(d!.channels as string[]).map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <button className="btn">Test: who would get this lead?</button>
          {sim && (
            <p role="status" className="w-full rounded-md bg-teal-50 px-3 py-2 text-teal-900">
              {sim} Nothing was assigned.
            </p>
          )}
        </AForm>
      </CardSection>
      <CardSection title="Lead scoring">
        <AForm path="/admin/scoring" onDone={reload} map={(f) => ({ hot_at: f.hot_at, warm_at: f.warm_at, scoring: Object.fromEntries(Object.entries(f).filter(([k]) => k.startsWith('s_')).map(([k, v]) => [k.slice(2), Number(v)])) })} className="grid gap-3 p-4 md:grid-cols-4">
          {Object.entries(d!.labels as Record<string, string>).map(([k, label]) => (
            <Field key={k} label={label}>
              <input name={`s_${k}`} type="number" min={0} max={100} defaultValue={d!.scoring[k]} className="input" />
            </Field>
          ))}
          <Field label="Hot at score">
            <input name="hot_at" type="number" defaultValue={d!.hot_at} className="input" />
          </Field>
          <Field label="Warm at score">
            <input name="warm_at" type="number" defaultValue={d!.warm_at} className="input" />
          </Field>
          <div className="md:col-span-4">
            <button className="btn btn-primary">Save scoring</button>
            <span className="muted ml-3 text-xs">Each kind of activity counts at most three times. Score is capped at 100. Users see the breakdown on every record.</span>
          </div>
        </AForm>
      </CardSection>
    </div>
  );
}

// ---------------------------------------------------------------- templates
export function Templates() {
  const { data: d, gate, reload } = useAdmin<Row>('/admin/templates');
  if (gate) return gate;
  const TForm = ({ t }: { t?: Row }) => (
    <AForm path="/admin/templates" onDone={reload} reset={!t} className="grid gap-2 md:grid-cols-6">
      {t && <input type="hidden" name="id" value={t.id} />}
      <label className="md:col-span-2">
        <span className="label">Name</span>
        <input name="name" required defaultValue={t?.name} className="input" />
      </label>
      <label>
        <span className="label">Channel</span>
        <select name="channel" defaultValue={t?.channel ?? 'whatsapp'} className="input">
          <option value="whatsapp">WhatsApp</option>
          <option value="sms">SMS</option>
          <option value="email">Email</option>
        </select>
      </label>
      <label>
        <span className="label">Category</span>
        <select name="category" defaultValue={t?.category ?? 'utility'} className="input">
          <option value="utility">Utility</option>
          <option value="marketing">Marketing</option>
        </select>
      </label>
      <label>
        <span className="label">Language</span>
        <select name="language" defaultValue={t?.language ?? 'en'} className="input">
          <option value="en">English</option>
          <option value="hi">Hindi</option>
          <option value="te">Telugu</option>
        </select>
      </label>
      {t ? (
        <label>
          <span className="label">Status</span>
          <select name="status" defaultValue={t.status} className="input">
            <option value="approved">Approved</option>
            <option value="submitted">Pending approval</option>
            <option value="draft">Draft</option>
            <option value="paused">Paused</option>
          </select>
        </label>
      ) : (
        <span />
      )}
      <label className="md:col-span-5">
        <span className="label">Body</span>
        <textarea name="body" rows={2} required defaultValue={t?.body} className="input" />
      </label>
      <div className="flex items-end">
        <button className="btn">{t ? 'Save' : 'Add template'}</button>
      </div>
    </AForm>
  );
  return (
    <div className="space-y-4">
      <section className="card p-4" aria-label="New template">
        <p className="mb-2 font-semibold">New template</p>
        <TForm />
        <p className="muted mt-2 text-xs">Merge variables: {(d!.variables as string[]).map((v) => `{{${v}}}`).join(' ')}</p>
      </section>
      <CardSection title="Template library">
        <div className="divide-y divide-slate-100">
          {d!.templates.map((t: Row) => (
            <details key={t.id} className="px-4 py-2.5">
              <summary className="flex list-none items-center justify-between gap-2">
                <span>
                  <b>{t.name}</b>{' '}
                  <span className="muted">
                    · {t.channel} · {t.category} · {t.language}
                  </span>
                </span>
                <span className="flex gap-1">
                  {t.channel === 'whatsapp' && t.provider_status && (
                    <Badge tone={t.provider_status === 'APPROVED' ? 'green' : t.provider_status === 'REJECTED' ? 'rose' : 'amber'} title={t.provider_reason ?? undefined}>
                      Meta: {String(t.provider_status).toLowerCase()}
                    </Badge>
                  )}
                  <Badge tone={t.status === 'approved' ? 'green' : 'amber'}>{t.status}</Badge>
                </span>
              </summary>
              <div className="mt-3 rounded-md bg-slate-50 p-3">
                <TForm t={t} />
              </div>
            </details>
          ))}
        </div>
      </CardSection>
    </div>
  );
}

// ---------------------------------------------------------------- forms
export function Forms() {
  const { data: d, gate, reload } = useAdmin<Row>('/admin/forms');
  if (gate) return gate;
  const FForm = ({ f }: { f?: Row }) => (
    <AForm path="/admin/forms" onDone={reload} reset={!f} map={(x) => ({ ...x, fields: multi(x, 'fields'), active: x.active === 'on' || !f })} className="grid gap-2 md:grid-cols-4">
      {f && <input type="hidden" name="id" value={f.id} />}
      <label>
        <span className="label">Form name</span>
        <input name="name" required defaultValue={f?.name} className="input" />
      </label>
      <label>
        <span className="label">Fixed branch</span>
        <select name="branch_id" defaultValue={f?.branch_id ?? ''} className="input">
          <option value="">Parent chooses</option>
          {d!.branches.map((b: Row) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className="label">Tag leads with source</span>
        <select name="source_id" defaultValue={f?.source_id ?? ''} className="input">
          <option value="">Not set</option>
          {d!.sources.map((s: Row) => (
            <option key={s.id} value={s.id}>
              {s.channel}: {s.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className="label">Thank-you message</span>
        <input name="thank_you" defaultValue={f?.thank_you} className="input" />
      </label>
      <fieldset className="md:col-span-3">
        <legend className="label">Fields (student name, parent name and mobile are always asked)</legend>
        <div className="flex flex-wrap gap-3">
          {(d!.optional as [string, string][]).map(([k, l]) => (
            <label key={k} className="flex items-center gap-1.5">
              <input type="checkbox" name="fields" value={k} defaultChecked={f ? f.fields.includes(k) : ['email', 'grade', 'branch'].includes(k)} /> {l}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex items-end gap-3">
        {f && (
          <label className="flex items-center gap-1.5">
            <input type="checkbox" name="active" defaultChecked={f.active} /> Live
          </label>
        )}
        <button className="btn">{f ? 'Save' : 'Create form'}</button>
      </div>
    </AForm>
  );
  return (
    <div className="space-y-4">
      <section className="card p-4" aria-label="New enquiry form">
        <p className="mb-2 font-semibold">New enquiry form</p>
        <FForm />
      </section>
      {d!.forms.map((f: Row) => (
        <CardSection
          key={f.id}
          title={
            <>
              {f.name} <span className="muted font-normal">· {f.submissions} submissions</span>
            </>
          }
          actions={f.active ? <Badge tone="green">Live</Badge> : <Badge>Off</Badge>}
        >
          <div className="space-y-3 p-4">
            <FForm f={f} />
            <div className="rounded-md bg-slate-50 p-3 text-xs">
              <p>
                Hosted link:{' '}
                <Link className="link" href={f.url} target="_blank">
                  {f.url}
                </Link>{' '}
                <span className="muted">(add ?utm_source=…&amp;utm_campaign=… and they are captured on the lead)</span>
              </p>
              <p className="mt-1">
                Embed on your website: <code className="rounded bg-white px-1 py-0.5">{`<iframe src="https://YOUR-DOMAIN${f.url}" width="100%" height="640" style="border:0"></iframe>`}</code>
              </p>
            </div>
          </div>
        </CardSection>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- workflows (AUT-01..05)
function describe(s: Row): string {
  const t = (m: number) => (m >= 1440 ? `${Math.round(m / 1440)} day(s)` : m >= 60 ? `${Math.round(m / 60)} hour(s)` : `${m} min`);
  switch (s.type) {
    case 'send': return `Send “${s.template}” on ${s.channel}${s.fallback?.length ? `, falling back to ${s.fallback.join(' then ')}` : ''}`;
    case 'task': return `Create task “${s.title}” for the owner, due in ${t(s.dueMins)}`;
    case 'wait': return `Wait ${t(s.mins)} (stops if the parent replies or the stage changes)`;
    case 'notify': return `Notify the ${s.who === 'head' ? 'admission head' : 'owner'}: “${s.title}”`;
    case 'stage': return `Move to stage “${s.stage}” if still in New`;
    case 'tag': return `Add tag “${s.tag}”`;
    case 'reassign': return 'Reassign to the next available counsellor if still untouched';
    default: return String(s.type);
  }
}

export function Workflows() {
  const id = useSearchParams().get('id') ?? '';
  const { data: d, gate, reload } = useAdmin<Row>('/admin/workflows', { id });
  const [type, setType] = useState('send');
  if (gate) return gate;
  const cur = d!.current as Row | undefined;
  if (cur) {
    const steps = cur.steps as Row[];
    const condLabel = (field: string) => (d!.condFields as [string, string][]).find(([k]) => k === field)?.[1] ?? field.replace('custom.', '').replace(/_/g, ' ');
    return (
      <div className="space-y-4">
        <Link href="/crm/admin/workflows" className="muted text-xs hover:underline">
          ← All workflows
        </Link>
        <CardSection
          title={
            <>
              {cur.name} <span className="muted font-normal">· version {cur.version}</span>
            </>
          }
          actions={<Badge tone={cur.status === 'published' ? 'green' : 'amber'}>{cur.status}</Badge>}
        >
          <div className="p-4">
            <p className="muted">{cur.description}</p>
            <ol className="mt-4 space-y-0">
              <li className="rounded-md border border-teal-200 bg-teal-50 px-3 py-2">
                <span className="text-xs font-semibold text-teal-900">WHEN</span> {d!.triggers[cur.trigger] ?? cur.trigger}
                {(cur.conditions as Row[]).map((c, i) => (
                  <div key={i} className="mt-1 flex items-center gap-2 text-xs">
                    <span className="muted">
                      AND {condLabel(c.field)} {c.op === 'ne' ? 'is not' : 'is'} {Array.isArray(c.value) ? c.value.join(' or ') : c.value}
                    </span>
                    <button
                      className="link"
                      onClick={async () => {
                        if (await act(`/admin/workflows/${cur.id}/conditions`, { what: 'remove', index: i }, { quiet: true })) reload();
                      }}
                    >
                      remove
                    </button>
                  </div>
                ))}
                <AForm path={`/admin/workflows/${cur.id}/conditions`} onDone={reload} reset className="mt-2 flex flex-wrap items-end gap-2 text-xs">
                  <input type="hidden" name="what" value="add" />
                  <span className="font-semibold text-teal-900">Only if</span>
                  <select name="field" className="input !w-auto !py-1 text-xs" aria-label="Field">
                    {(d!.condFields as [string, string][]).map(([k, l]) => (
                      <option key={k} value={k}>
                        {l}
                      </option>
                    ))}
                  </select>
                  <select name="op" className="input !w-auto !py-1 text-xs" aria-label="Operator">
                    <option value="in">is one of</option>
                    <option value="ne">is not</option>
                  </select>
                  <input name="value" required placeholder="Value (commas for several)" aria-label="Value" className="input !w-56 !py-1 text-xs" />
                  <button className="btn btn-sm">Add condition</button>
                </AForm>
              </li>
              {steps.map((s, i) => (
                <li key={i}>
                  <div className="ml-6 h-4 w-px bg-slate-300" />
                  <div className={`flex items-center justify-between gap-2 rounded-md border px-3 py-2 ${s.type === 'wait' ? 'border-dashed border-slate-300 bg-slate-50' : 'border-slate-200 bg-white'}`}>
                    <span>
                      <span className="mr-2 text-xs font-semibold text-slate-600">{i + 1}</span>
                      {describe(s)}
                    </span>
                    <span className="flex gap-1">
                      <button
                        className="btn btn-sm"
                        aria-label="Move step up"
                        onClick={async () => {
                          if (await act(`/admin/workflows/${cur.id}/steps`, { what: 'up', index: i }, { quiet: true })) reload();
                        }}
                      >
                        ↑
                      </button>
                      <button
                        className="btn btn-sm"
                        aria-label="Remove step"
                        onClick={async () => {
                          if (await act(`/admin/workflows/${cur.id}/steps`, { what: 'remove', index: i }, { quiet: true })) reload();
                        }}
                      >
                        ×
                      </button>
                    </span>
                  </div>
                </li>
              ))}
            </ol>
            <AForm path={`/admin/workflows/${cur.id}/steps`} onDone={reload} reset className="mt-4 flex flex-wrap items-end gap-2 rounded-md border border-dashed border-slate-300 bg-slate-50 p-3">
              <input type="hidden" name="what" value="add" />
              <label>
                <span className="label">Add step</span>
                <select name="type" value={type} onChange={(e) => setType(e.target.value)} className="input w-40">
                  <option value="send">Send message</option>
                  <option value="task">Create task</option>
                  <option value="wait">Wait</option>
                  <option value="notify">Notify</option>
                  <option value="stage">Change stage</option>
                  <option value="tag">Add tag</option>
                  <option value="reassign">Reassign</option>
                </select>
              </label>
              {type === 'send' && (
                <>
                  <label>
                    <span className="label">Channel</span>
                    <select name="channel" className="input w-28">
                      <option value="whatsapp">WhatsApp</option>
                      <option value="sms">SMS</option>
                      <option value="email">Email</option>
                    </select>
                  </label>
                  <label>
                    <span className="label">Template</span>
                    <select name="template" className="input w-44">
                      {(d!.templates as string[]).map((t) => (
                        <option key={t}>{t}</option>
                      ))}
                    </select>
                  </label>
                </>
              )}
              {['task', 'notify', 'tag'].includes(type) && (
                <label>
                  <span className="label">{type === 'tag' ? 'Tag text' : 'Title'}</span>
                  <input name="title" className="input w-44" />
                </label>
              )}
              {['task', 'wait'].includes(type) && (
                <label>
                  <span className="label">{type === 'wait' ? 'Minutes to wait' : 'Due in (minutes)'}</span>
                  <input name="mins" type="number" min={1} defaultValue={60} className="input w-28" />
                </label>
              )}
              {type === 'notify' && (
                <label>
                  <span className="label">Notify</span>
                  <select name="who" className="input w-28">
                    <option value="owner">Owner</option>
                    <option value="head">Head</option>
                  </select>
                </label>
              )}
              {type === 'stage' && (
                <label>
                  <span className="label">Stage</span>
                  <select name="stage" className="input w-40">
                    {(d!.stages as string[]).map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </label>
              )}
              <button className="btn">Add step</button>
            </AForm>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                className="btn"
                onClick={async () => {
                  if (await act(`/admin/workflows/${cur.id}/test`)) reload();
                }}
              >
                Test run on a sample record
              </button>
              {d!.canPublish && (
                <button
                  className={`btn ${cur.status === 'published' ? 'btn-danger' : 'btn-primary'}`}
                  onClick={async () => {
                    if (await act(`/admin/workflows/${cur.id}/status`, { status: cur.status === 'published' ? 'paused' : 'published' })) reload();
                  }}
                >
                  {cur.status === 'published' ? 'Pause' : 'Publish'}
                </button>
              )}
              {cur.status !== 'published' && d!.canDelete && (
                <button
                  className="btn"
                  onClick={async () => {
                    if (window.confirm('Delete this workflow?') && (await act(`/admin/workflows/${cur.id}/delete`, {}, { quiet: true }))) window.location.href = '/crm/admin/workflows';
                  }}
                >
                  Delete
                </button>
              )}
            </div>
            <p className="muted mt-2 text-xs">Safeguards on every workflow: one run per record at a time, waiting steps cancel when the parent replies or the record leaves its stage, opted-out parents are never messaged.</p>
          </div>
        </CardSection>
        <CardSection title="Run log">
          {!d!.runs.length && <Empty title="No runs yet">Use Test run to see exactly what this workflow would do, without sending anything.</Empty>}
          <div className="divide-y divide-slate-100">
            {(d!.runs as Row[]).map((r, i) => (
              <details key={r.id} className="px-4 py-2.5" open={r.test && i === 0}>
                <summary className="flex list-none items-center justify-between">
                  <span>
                    {r.student ?? 'Record'} <span className="muted text-xs">· {fmtDateTime(r.created_at)}</span>
                  </span>
                  <Badge tone={r.status === 'error' ? 'rose' : r.status === 'running' ? 'amber' : r.status === 'cancelled' ? 'slate' : 'green'}>{r.test ? 'Test run' : r.status === 'running' ? 'Waiting' : r.status}</Badge>
                </summary>
                <ul className="mt-2 space-y-1 text-xs">
                  {(r.log as Row[]).map((l, j) => (
                    <li key={j} className={l.ok === false ? 'text-rose-700' : 'text-slate-800'}>
                      {l.step ? `Step ${l.step}: ` : ''}
                      {l.text}
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </div>
        </CardSection>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <CardSection title="Workflows" className="overflow-x-auto">
        <table className="tbl">
          <caption className="sr-only">Workflows</caption>
          <thead>
            <tr>
              <th>Workflow</th>
              <th>Runs when</th>
              <th>Steps</th>
              <th>Runs</th>
              <th>Waiting</th>
              <th>Errors</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {(d!.workflows as Row[]).map((w) => (
              <tr key={w.id}>
                <td>
                  <Link className="link" href={`/crm/admin/workflows?id=${w.id}`}>
                    {w.name}
                  </Link>
                  <span className="muted block max-w-md text-xs">{w.description}</span>
                </td>
                <td>{d!.triggers[w.trigger] ?? w.trigger}</td>
                <td>{(w.steps as Row[]).length}</td>
                <td>{w.runs}</td>
                <td>{w.waiting}</td>
                <td className={w.errors ? 'font-semibold text-rose-700' : ''}>{w.errors}</td>
                <td>
                  <Badge tone={w.status === 'published' ? 'green' : 'amber'}>{w.status}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardSection>
      <CardSection title="Build your own">
        <form
          className="flex flex-wrap items-end gap-3 p-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await post<{ id: string }>('/admin/workflows', formObj(e.currentTarget)).catch(() => null);
            if (r) window.location.href = `/crm/admin/workflows?id=${r.id}`;
          }}
        >
          <label>
            <span className="label">Name</span>
            <input name="name" required className="input w-56" />
          </label>
          <label>
            <span className="label">Trigger</span>
            <select name="trigger" className="input w-72">
              {Object.entries(d!.triggers as Record<string, string>).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <button className="btn btn-primary">Create draft</button>
        </form>
      </CardSection>
      {d!.recipes.length > 0 && (
        <CardSection title="Recipe library">
          <div className="divide-y divide-slate-100">
            {(d!.recipes as Row[]).map((r) => (
              <div key={r.key} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <span>
                  <b>{r.name}</b>
                  <span className="muted block text-xs">{r.description}</span>
                </span>
                <button
                  className="btn btn-sm"
                  onClick={async () => {
                    if (await act('/admin/workflows', { recipe: r.key })) reload();
                  }}
                >
                  Install
                </button>
              </div>
            ))}
          </div>
        </CardSection>
      )}
    </div>
  );
}
