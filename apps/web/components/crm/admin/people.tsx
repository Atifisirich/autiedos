'use client';
import { useState } from 'react';
import { act, formObj } from '@/lib/crm/api';
import { fmtDate } from '@/lib/crm/fmt';
import { Badge, DOTS, Field } from '../ui';
import { AForm, CardSection, multi, useAdmin, type Row } from './common';

// ---------------------------------------------------------------- organisation, branches, years, seats
export function Org() {
  const { data: d, gate, reload } = useAdmin<Row>('/admin/org');
  if (gate) return gate;
  const s = d!.settings;
  return (
    <div className="space-y-4">
      <CardSection title="Organisation profile and defaults">
        <AForm path="/admin/org" onDone={reload} className="grid gap-3 p-4 md:grid-cols-3" map={(f) => ({ ...f, reopen: f.reopen === 'on', call_recording: f.call_recording === 'on', require_2fa_admins: f.require_2fa_admins === 'on' })}>
          <Field label="School / group name">
            <input name="name" defaultValue={d!.org.name} className="input" />
          </Field>
          <Field label="Legal name">
            <input name="legal_name" defaultValue={s.legal_name} className="input" />
          </Field>
          <Field label="GSTIN">
            <input name="gstin" defaultValue={s.gstin} className="input" />
          </Field>
          <Field label="Brand colour">
            <input name="color" type="color" defaultValue={s.brand_color ?? '#0f6e6e'} className="input h-9 p-1" />
          </Field>
          <Field label="First response target (minutes)" hint="Used for SLA timers and escalation">
            <input name="first_response_mins" type="number" min={1} defaultValue={s.first_response_mins ?? 30} className="input" />
          </Field>
          <Field label="Registration fee (₹)">
            <input name="fee_registration" type="number" defaultValue={s.fees?.registration} className="input" />
          </Field>
          <Field label="Admission fee (₹)">
            <input name="fee_admission" type="number" defaultValue={s.fees?.admission} className="input" />
          </Field>
          <Field label="Application number prefix">
            <input name="app_no_prefix" defaultValue={s.app_no_prefix} className="input" />
          </Field>
          <Field label="Receipt number prefix">
            <input name="receipt_prefix" defaultValue={s.receipt_prefix} className="input" />
          </Field>
          <Field label="Closure reasons (one per line)">
            <textarea name="closure_reasons" rows={6} defaultValue={(s.closure_reasons ?? []).join('\n')} className="input" />
          </Field>
          <Field label="Document checklist (one per line)">
            <textarea name="doc_types" rows={6} defaultValue={(s.doc_types ?? []).join('\n')} className="input" />
          </Field>
          <Field label="Privacy notice shown on forms">
            <textarea name="privacy_notice" rows={6} defaultValue={s.privacy_notice ?? 'We use these details only to respond to your admission enquiry. You can ask us to correct or delete them at any time.'} className="input" />
          </Field>
          <Field label="Quiet hours: no automated messages from (hour, 0-23)">
            <input name="quiet_from" type="number" min={0} max={23} defaultValue={s.quiet_hours?.from ?? 21} className="input" />
          </Field>
          <Field label="… until (hour, 0-23)" hint="Automated messages due in this window wait until it ends. India time.">
            <input name="quiet_to" type="number" min={0} max={23} defaultValue={s.quiet_hours?.to ?? 8} className="input" />
          </Field>
          <Field label="Most automated messages per family per day" hint="Messages sent by staff and campaigns do not count.">
            <input name="max_auto_per_day" type="number" min={1} defaultValue={s.max_auto_per_day ?? 4} className="input" />
          </Field>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="reopen" defaultChecked={s.reopen_on_reenquiry !== false} /> Re-open a closed enquiry when the family enquires again
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="call_recording" defaultChecked={!!s.call_recording} /> Record calls (with announcement) once telephony is connected
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="require_2fa_admins" defaultChecked={!!s.require_2fa_admins} /> Require two-factor sign-in for everyone who can change settings
          </label>
          <div className="md:col-span-3">
            <button className="btn btn-primary">Save organisation settings</button>
          </div>
        </AForm>
      </CardSection>

      <CardSection title="Branches">
        <div className="divide-y divide-slate-100">
          {[...d!.branches, null].map((b: Row | null) => (
            <AForm key={b?.id ?? 'new'} path="/admin/branches" onDone={reload} reset={!b} className="grid items-end gap-2 px-4 py-3 md:grid-cols-8">
              {b && <input type="hidden" name="id" value={b.id} />}
              <label className="md:col-span-2">
                <span className="label">{b ? 'Name' : 'Add a branch'}</span>
                <input name="name" defaultValue={b?.name} placeholder="Branch name" className="input" />
              </label>
              <label>
                <span className="label">City</span>
                <input name="city" defaultValue={b?.city ?? ''} className="input" />
              </label>
              <label className="md:col-span-2">
                <span className="label">Address</span>
                <input name="address" defaultValue={b?.address ?? ''} className="input" />
              </label>
              <label>
                <span className="label">Hours (open to close)</span>
                <span className="flex gap-1">
                  <input name="open_hour" type="number" min={0} max={23} defaultValue={b?.open_hour ?? 9} className="input" aria-label="Opening hour" />
                  <input name="close_hour" type="number" min={1} max={24} defaultValue={b?.close_hour ?? 18} className="input" aria-label="Closing hour" />
                </span>
              </label>
              <label>
                <span className="label">Visits per hour</span>
                <input name="visit_capacity" type="number" min={1} defaultValue={b?.visit_capacity ?? 3} className="input" />
              </label>
              <button className="btn">{b ? 'Save' : 'Add branch'}</button>
            </AForm>
          ))}
        </div>
      </CardSection>

      <CardSection title="Academic years">
        <table className="tbl">
          <caption className="sr-only">Academic years</caption>
          <tbody>
            {d!.years.map((y: Row) => (
              <tr key={y.id}>
                <td className="font-medium">{y.name}</td>
                <td>
                  {y.status !== 'closed' ? <Badge tone="green">Open for admissions</Badge> : <Badge>Closed</Badge>} {y.is_current && <Badge tone="teal">Default</Badge>}
                </td>
                <td className="text-right">
                  <span className="flex justify-end gap-1.5">
                    {!y.is_current && (
                      <button
                        className="btn btn-sm"
                        onClick={async () => {
                          if (await act(`/admin/years/${y.id}`, { what: 'default' }, { quiet: true })) reload();
                        }}
                      >
                        Make default
                      </button>
                    )}
                    {y.status !== 'closed' ? (
                      !y.is_current && (
                        <button
                          className="btn btn-sm"
                          onClick={async () => {
                            if (await act(`/admin/years/${y.id}`, { what: 'close' }, { quiet: true })) reload();
                          }}
                        >
                          Close admissions
                        </button>
                      )
                    ) : (
                      <button
                        className="btn btn-sm"
                        onClick={async () => {
                          if (await act(`/admin/years/${y.id}`, { what: 'open' }, { quiet: true })) reload();
                        }}
                      >
                        Reopen
                      </button>
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <AForm path="/admin/years" onDone={reload} className="flex flex-wrap items-end gap-3 border-t border-slate-200 bg-slate-50 p-4" map={(f) => ({ ...f, carry: f.carry === 'on', makeDefault: f.makeDefault === 'on' })}>
          <p className="w-full font-semibold">Rollover wizard</p>
          <label>
            <span className="label">Copy from</span>
            <select name="from" defaultValue={d!.years[d!.years.length - 1]?.id} className="input w-32">
              {d!.years.map((y: Row) => (
                <option key={y.id} value={y.id}>
                  {y.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="label">New academic year</span>
            <input name="name" defaultValue={d!.nextYearName} className="input w-32" />
          </label>
          <label className="flex items-center gap-2 pb-2">
            <input type="checkbox" name="carry" defaultChecked /> Carry forward open and &quot;not now&quot; families as prospects
          </label>
          <label className="flex items-center gap-2 pb-2">
            <input type="checkbox" name="makeDefault" /> Make it the default year
          </label>
          <button className="btn btn-primary">Create year</button>
          <p className="muted w-full text-xs">Copies programmes, seats and age rules. Stages, forms, fields and workflows are shared across years, so nothing is duplicated and history is never split.</p>
        </AForm>
      </CardSection>

      <CardSection title="Programmes and seats for the selected year" className="overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th>Branch</th>
              <th>Board</th>
              <th>Grade</th>
              <th>Seats</th>
              <th>Minimum age on cut-off</th>
              <th>Cut-off date</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {d!.programmes.map((p: Row) => (
              <tr key={p.programme_id}>
                <td>{p.branch}</td>
                <td>{p.board}</td>
                <td className="font-medium">{p.grade}</td>
                <td colSpan={2}>
                  <AForm path={`/admin/programmes/${p.programme_id}`} onDone={reload} className="flex items-center gap-2">
                    <input name="capacity" type="number" min={0} defaultValue={p.capacity} className="input !w-20 !py-1" aria-label={`Seats for ${p.grade} at ${p.branch}`} />
                    <input name="min_age_years" type="number" step="0.5" defaultValue={p.min_age_years ?? ''} className="input !w-20 !py-1" aria-label={`Minimum age for ${p.grade} at ${p.branch}`} />
                    <button className="btn btn-sm">Save</button>
                  </AForm>
                </td>
                <td>{fmtDate(p.age_cutoff)}</td>
                <td></td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardSection>
    </div>
  );
}

// ---------------------------------------------------------------- users
export function Users() {
  const { data: d, gate, reload } = useAdmin<Row>('/admin/users');
  if (gate) return gate;
  const UserForm = ({ u }: { u?: Row }) => (
    <AForm
      path="/admin/users"
      onDone={reload}
      reset={!u}
      map={(f) => ({ ...f, branchIds: multi(f, 'branchIds'), on_leave: f.on_leave === 'on' })}
      className="grid items-end gap-2 md:grid-cols-6"
    >
      {u && <input type="hidden" name="id" value={u.id} />}
      <label>
        <span className="label">Name</span>
        <input name="name" required defaultValue={u?.name} className="input" />
      </label>
      {!u && (
        <label>
          <span className="label">Work email</span>
          <input name="email" type="email" required className="input" />
        </label>
      )}
      <label>
        <span className="label">Role</span>
        <select name="roleKey" defaultValue={u?.role_key} className="input">
          {d!.roles.map((r: Row) => (
            <option key={r.key} value={r.key}>
              {r.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className="label">Branches (none = all)</span>
        <select name="branchIds" multiple defaultValue={u?.branch_ids ?? []} className="input h-16">
          {d!.branches.map((b: Row) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className="label">Reports to</span>
        <select name="reports_to" defaultValue={u?.reports_to ?? ''} className="input">
          <option value="">Nobody</option>
          {d!.users.filter((x: Row) => x.id !== u?.id && x.active).map((x: Row) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className="label">Leads per day</span>
        <input name="daily_capacity" type="number" min={0} defaultValue={u?.daily_capacity ?? 25} className="input" />
      </label>
      <label className="flex items-center gap-2 pb-2">
        <input type="checkbox" name="on_leave" defaultChecked={u?.on_leave} /> On leave (skip in routing)
      </label>
      <button className="btn btn-primary">{u ? 'Save' : 'Invite user'}</button>
    </AForm>
  );
  return (
    <div className="space-y-4">
      <CardSection title="Invite a user" actions={<span className="muted font-normal">{d!.licences} active licences in use</span>}>
        <div className="p-4">
          <UserForm />
          <p className="muted mt-2 text-xs">They receive an invitation at this email and sign in with a one-time code. One person belongs to one school.</p>
        </div>
      </CardSection>
      <CardSection title="Team">
        <div className="divide-y divide-slate-100">
          {d!.users.map((u: Row) => (
            <details key={u.id} className="px-4 py-2.5">
              <summary className="flex list-none flex-wrap items-center justify-between gap-2">
                <span>
                  <b>{u.name}</b>{' '}
                  <span className="muted">
                    · {u.email} · {u.role_name}
                  </span>{' '}
                  {!u.active && <Badge tone="rose">Paused</Badge>} {u.on_leave && <Badge tone="amber">On leave</Badge>}
                </span>
                <span className="muted text-xs">
                  {(u.branch_ids as string[]).length ? d!.branches.filter((b: Row) => u.branch_ids.includes(b.id)).map((b: Row) => b.name).join(', ') : 'All branches'} · edit ▾
                </span>
              </summary>
              <div className="mt-3 space-y-2 rounded-md bg-slate-50 p-3">
                <UserForm u={u} />
                {u.id !== d!.me && (
                  <div className="flex flex-wrap gap-2">
                    {u.active ? (
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={async () => {
                          if (window.confirm(`Pause ${u.name} and sign them out everywhere?`) && (await act(`/admin/users/${u.id}/action`, { what: 'pause' }))) reload();
                        }}
                      >
                        Pause and sign out
                      </button>
                    ) : (
                      <button
                        className="btn btn-sm"
                        onClick={async () => {
                          if (await act(`/admin/users/${u.id}/action`, { what: 'activate' })) reload();
                        }}
                      >
                        Reactivate
                      </button>
                    )}
                    <button
                      className="btn btn-sm"
                      onClick={async () => {
                        await act(`/admin/users/${u.id}/action`, { what: 'signout' });
                      }}
                    >
                      Sign out of all devices
                    </button>
                  </div>
                )}
              </div>
            </details>
          ))}
        </div>
      </CardSection>
    </div>
  );
}

// ---------------------------------------------------------------- roles
export function Roles() {
  const { data: d, gate, reload } = useAdmin<Row>('/admin/roles');
  const [clone, setClone] = useState('');
  if (gate) return gate;
  return (
    <div className="space-y-4">
      <AForm
        path="/admin/roles"
        onDone={reload}
        className="card overflow-x-auto"
        map={(f) => {
          const permissions: Record<string, Record<string, string>> = {};
          for (const r of d!.roles as Row[]) permissions[r.key] = Object.fromEntries((d!.caps as [string, string][]).map(([k]) => [k, f[`${r.key}:${k}`] ?? r.permissions[k] ?? '-']));
          return { permissions };
        }}
      >
        <div className="card-h">
          <h2>Permission matrix</h2>
          <button className="btn btn-primary btn-sm">Save permissions</button>
        </div>
        <p className="muted px-4 pt-3 text-xs">{d!.help}. Other values limit the role to its own area (for example Front Office: Check-in, Accounts: Collect). Sensitive fields: anything other than F, T or V shows masked values.</p>
        <table className="tbl mt-2">
          <caption className="sr-only">Permission matrix</caption>
          <thead>
            <tr>
              <th className="sticky left-0 bg-slate-50">Capability</th>
              {d!.roles.map((r: Row) => (
                <th key={r.id}>
                  {r.name}
                  <span className="muted block font-normal">
                    {r.users} user{r.users === 1 ? '' : 's'}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(d!.caps as [string, string][]).map(([k, label]) => (
              <tr key={k}>
                <td className="sticky left-0 bg-white font-medium">{label}</td>
                {d!.roles.map((r: Row) => (
                  <td key={r.id}>
                    <select name={`${r.key}:${k}`} defaultValue={r.permissions[k] ?? '-'} disabled={r.name === 'Group Admin'} aria-label={`${r.name}: ${label}`} className="input !w-28 !px-1.5 !py-1 text-xs">
                      {(d!.levels as string[]).map((l) => (
                        <option key={l}>{l}</option>
                      ))}
                    </select>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </AForm>
      <AForm path="/admin/roles/clone" onDone={reload} reset className="card flex flex-wrap items-end gap-3 p-4">
        <label>
          <span className="label">Create a role from</span>
          <select name="key" value={clone} onChange={(e) => setClone(e.target.value)} className="input w-56">
            {d!.roles.map((r: Row) => (
              <option key={r.key} value={r.key}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="label">New role name</span>
          <input name="name" required className="input w-56" placeholder="Seasonal counsellor" />
        </label>
        <button className="btn">Clone role</button>
      </AForm>
    </div>
  );
}

// ---------------------------------------------------------------- fields
export function Fields() {
  const { data: d, gate, reload } = useAdmin<Row>('/admin/fields');
  if (gate) return gate;
  const mapField = (f: Row) => ({ ...f, sensitive: f.sensitive === 'on', active: f.active === 'on' });
  return (
    <div className="space-y-4">
      <CardSection title="Add a field to Enquiry">
        <AForm path="/admin/fields" onDone={reload} reset map={mapField} className="flex flex-wrap items-end gap-3 p-4">
          <label>
            <span className="label">Label</span>
            <input name="label" required className="input w-56" placeholder="Transport required" />
          </label>
          <label>
            <span className="label">Type</span>
            <select name="type" className="input w-36">
              <option value="text">Text</option>
              <option value="select">Dropdown</option>
            </select>
          </label>
          <label>
            <span className="label">Dropdown values (comma separated)</span>
            <input name="options" className="input w-72" placeholder="Yes, No, Not sure" />
          </label>
          <label className="flex items-center gap-2 pb-2">
            <input type="checkbox" name="sensitive" /> Sensitive (masked for most roles)
          </label>
          <button className="btn btn-primary">Add field</button>
        </AForm>
      </CardSection>
      <CardSection title="Custom fields">
        <div className="divide-y divide-slate-100">
          {d!.fields.map((f: Row) => (
            <AForm key={f.id} path="/admin/fields" onDone={reload} map={mapField} className="flex flex-wrap items-end gap-3 px-4 py-3">
              <input type="hidden" name="id" value={f.id} />
              <input type="hidden" name="type" value={f.type === 'select' ? 'select' : 'text'} />
              <label>
                <span className="label">Label</span>
                <input name="label" defaultValue={f.label} className="input w-56" />
              </label>
              {f.type === 'select' && (
                <label>
                  <span className="label">Values</span>
                  <input name="options" defaultValue={(f.options as string[]).join(', ')} className="input w-72" />
                </label>
              )}
              <label className="flex items-center gap-2 pb-2">
                <input type="checkbox" name="sensitive" defaultChecked={f.sensitive} /> Sensitive
              </label>
              <label className="flex items-center gap-2 pb-2">
                <input type="checkbox" name="active" defaultChecked={f.active} /> Active
              </label>
              <span className="muted pb-2 text-xs">
                {f.type === 'select' ? 'Dropdown' : 'Text'} · filled on {f.used} record{f.used === 1 ? '' : 's'}
              </span>
              <button className="btn">Save</button>
            </AForm>
          ))}
          {!d!.fields.length && <p className="muted px-4 py-3">No custom fields yet.</p>}
        </div>
      </CardSection>
      <section className="card p-4" aria-label="Standard fields">
        <p className="font-semibold">Standard fields</p>
        <p className="muted mt-1 text-xs">These drive duplicate checks, routing and reports, so they cannot be deleted.</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {(d!.standard as string[]).map((s) => (
            <Badge key={s}>{s}</Badge>
          ))}
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- pipeline (PL-01, PL-04)
export function Pipeline() {
  const { data: d, gate, reload } = useAdmin<Row>('/admin/pipeline');
  if (gate) return gate;
  return (
    <div className="space-y-4">
      <p className="muted">One pipeline for every academic year. Order is set with the arrows, never with numbers in names. Probability feeds the admissions forecast.</p>
      {d!.phases.map((ph: Row) => (
        <CardSection key={ph.id} title={ph.name}>
          <div className="divide-y divide-slate-100">
            {d!.stages.filter((s: Row) => s.phase_id === ph.id).map((s: Row) => (
              <div key={s.id} className="flex flex-wrap items-end gap-2 px-4 py-2.5">
                <span className="flex gap-0.5 pb-0.5">
                  {['up', 'down'].map((dir) => (
                    <button
                      key={dir}
                      className="btn btn-sm"
                      aria-label={`Move ${s.name} ${dir}`}
                      onClick={async () => {
                        if (await act(`/admin/stages/${s.id}/move`, { dir }, { quiet: true })) reload();
                      }}
                    >
                      {dir === 'up' ? '↑' : '↓'}
                    </button>
                  ))}
                </span>
                <AForm path="/admin/stages" onDone={reload} map={(f) => ({ ...f, exempt: f.exempt === 'on' })} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="id" value={s.id} />
                  <label>
                    <span className="label">Stage</span>
                    <span className="flex items-center gap-1.5">
                      <span className={`h-2.5 w-2.5 rounded-full ${DOTS[s.color]}`} aria-hidden />
                      <input name="name" defaultValue={s.name} className="input w-48" />
                    </span>
                  </label>
                  <label>
                    <span className="label">Colour</span>
                    <select name="color" defaultValue={s.color} className="input w-24">
                      {(d!.colors as string[]).map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span className="label">Probability %</span>
                    <input name="probability" type="number" min={0} max={100} defaultValue={s.probability} className="input w-20" />
                  </label>
                  <label>
                    <span className="label">SLA hours</span>
                    <input name="sla_hours" type="number" min={0} defaultValue={s.sla_hours ?? ''} className="input w-20" />
                  </label>
                  <label className="flex items-center gap-1.5 pb-2 text-xs">
                    <input type="checkbox" name="exempt" defaultChecked={s.exempt_next_action} /> No next action needed
                  </label>
                  <button className="btn">Save</button>
                </AForm>
                <RetireStage s={s} stages={d!.stages} onDone={reload} />
              </div>
            ))}
            <AForm path="/admin/stages" onDone={reload} reset className="flex flex-wrap items-end gap-2 bg-slate-50 px-4 py-2.5">
              <input type="hidden" name="phaseId" value={ph.id} />
              <label>
                <span className="label">Add a stage to {ph.name}</span>
                <input name="name" required className="input w-48" placeholder="Stage name" />
              </label>
              <label>
                <span className="label">Probability %</span>
                <input name="probability" type="number" defaultValue={0} className="input w-20" />
              </label>
              <button className="btn">Add stage</button>
            </AForm>
          </div>
        </CardSection>
      ))}
      <CardSection title="Stage mapping for imports">
        <p className="muted px-4 pt-3 text-xs">When you import a sheet from another CRM, its stage names are matched to these stages. Names that are not recognised stay at the start of the pipeline and are listed after the import.</p>
        <table className="tbl mt-2">
          <caption className="sr-only">Stage mapping for imports</caption>
          <thead>
            <tr>
              <th>Stage in the other CRM</th>
              <th>Becomes</th>
            </tr>
          </thead>
          <tbody>
            {(d!.importMap as { from: string; to: string | null }[]).map((m) => (
              <tr key={m.from}>
                <td>{m.from}</td>
                <td>{m.to ?? <span className="muted">not recognised</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardSection>
    </div>
  );
}

function RetireStage({ s, stages, onDone }: { s: Row; stages: Row[]; onDone: () => void }) {
  const [target, setTarget] = useState('');
  return (
    <div className="ml-auto flex items-end gap-2">
      <span className="muted pb-2 text-xs">
        {s.records} record{s.records === 1 ? '' : 's'}
      </span>
      {s.records > 0 && (
        <select value={target} onChange={(e) => setTarget(e.target.value)} className="input w-44" aria-label={`Move records from ${s.name} to`}>
          <option value="">Move records to…</option>
          {stages.filter((x) => x.id !== s.id).map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      )}
      <button
        className="btn btn-danger"
        onClick={async () => {
          if (window.confirm(`Retire "${s.name}"? ${s.records ? `${s.records} records move to the stage you chose.` : ''} Past timelines keep the old name.`) && (await act(`/admin/stages/${s.id}/retire`, { targetId: target }))) onDone();
        }}
      >
        Retire
      </button>
    </div>
  );
}

export { formObj };
