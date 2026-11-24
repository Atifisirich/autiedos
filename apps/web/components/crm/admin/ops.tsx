'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { act, flash, get } from '@/lib/crm/api';
import { fmtDateTime, inr, rel } from '@/lib/crm/fmt';
import { Badge, Bars, Empty, Field, Stat } from '../ui';
import { AForm, CardSection, useAdmin, type Row } from './common';

async function download(path: string, query: Record<string, string>) {
  const res = await fetch(`/api/crm${path}?${new URLSearchParams(query)}`);
  if (!res.ok) return flash((await res.json().catch(() => ({})))?.error ?? 'Could not download.', 'error');
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'download';
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------- integrations
export function Integrations() {
  const { data: d, gate, reload } = useAdmin<Row>('/admin/integrations');
  if (gate) return gate;
  const m = d!.meta;
  const wa = m.whatsapp;
  const live = wa.enabled && wa.phone_number_id && wa.tokenHint;
  return (
    <div className="space-y-4">
      <CardSection title="Meta: WhatsApp and lead ads" actions={live ? <Badge tone="green">WhatsApp live</Badge> : <Badge tone="amber">WhatsApp simulated</Badge>}>
        <div className="space-y-5 p-4">
          <ol className="list-decimal space-y-1 pl-5 text-slate-800">
            <li>
              In Meta Business Suite create (or open) your app with the <b>WhatsApp</b> product and add your school number.
            </li>
            <li>
              Create a <b>System User</b> with a permanent token that has <code>whatsapp_business_messaging</code>, <code>whatsapp_business_management</code> and, for lead ads, <code>leads_retrieval</code> and <code>pages_manage_metadata</code>.
            </li>
            <li>
              In the app&apos;s <b>Webhooks</b> settings paste the callback URL and verify token below, then subscribe to <code>messages</code>, <code>message_template_status_update</code> and, on the Page object, <code>leadgen</code>.
            </li>
            <li>Fill in the IDs and tokens here, tick Use for sending, Save, then Test. Then Sync templates and wait for Meta&apos;s approval.</li>
          </ol>
          <div className="grid gap-2 rounded-md bg-slate-50 p-3 text-xs md:grid-cols-[9rem_1fr]">
            <span className="font-semibold">Callback URL</span>
            <code className="select-all break-all">{m.callbackUrl}</code>
            <span className="font-semibold">Verify token</span>
            <span className="flex flex-wrap items-center gap-2">
              <code className="select-all break-all">{m.verify ?? 'Created when you first save'}</code>
              {m.verify && (
                <button
                  className="link"
                  onClick={async () => {
                    if (await act('/admin/meta/action', { what: 'rotate_verify' })) reload();
                  }}
                >
                  New token
                </button>
              )}
            </span>
          </div>
          <AForm path="/admin/meta" onDone={reload} map={(f) => ({ ...f, enabled: f.enabled === 'on' })} className="grid gap-3 md:grid-cols-2">
            <input type="hidden" name="section" value="whatsapp" />
            <p className="font-semibold md:col-span-2">WhatsApp Cloud API</p>
            <Field label="Phone number ID">
              <input name="phone_number_id" defaultValue={wa.phone_number_id} className="input" placeholder="From WhatsApp > API setup" />
            </Field>
            <Field label="WhatsApp Business Account ID">
              <input name="waba_id" defaultValue={wa.waba_id} className="input" />
            </Field>
            <Field label={`Permanent access token ${wa.tokenHint ? `(saved ${wa.tokenHint})` : ''}`} hint="Leave blank to keep the saved one.">
              <input name="wa_token" type="password" autoComplete="off" className="input" />
            </Field>
            <Field label={`App secret ${wa.appSecretHint ? `(saved ${wa.appSecretHint})` : ''}`} hint="Used to check that webhook calls really come from Meta.">
              <input name="app_secret" type="password" autoComplete="off" className="input" />
            </Field>
            <label className="flex items-center gap-2">
              <input type="checkbox" name="enabled" defaultChecked={!!wa.enabled} /> Use for sending (when off, WhatsApp stays simulated)
            </label>
            <div className="md:col-span-2">
              <button className="btn btn-primary">Save</button>
            </div>
          </AForm>
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn" onClick={async () => void (await act('/admin/meta/action', { what: 'test_wa' }))}>
              Test connection
            </button>
            <button className="btn" onClick={async () => void (await act('/admin/meta/action', { what: 'sync_templates' }))}>
              Sync templates with Meta
            </button>
            <span className="muted text-xs">Templates: {(m.templateStats as Row[]).map((x) => `${x.n} ${String(x.s).toLowerCase()}`).join(', ') || 'none'}</span>
          </div>
          <AForm path="/admin/meta" onDone={reload} className="grid gap-3 border-t border-slate-200 pt-4 md:grid-cols-2">
            <input type="hidden" name="section" value="leads" />
            <p className="font-semibold md:col-span-2">Facebook and Instagram lead ads</p>
            <Field label="Facebook Page ID">
              <input name="page_id" defaultValue={m.leads.page_id} className="input" />
            </Field>
            <Field label={`Page access token ${m.leads.pageHint ? `(saved ${m.leads.pageHint})` : ''}`} hint="Leave blank to keep the saved one.">
              <input name="page_token" type="password" autoComplete="off" className="input" />
            </Field>
            <div className="flex flex-wrap items-center gap-2 md:col-span-2">
              <button className="btn btn-primary">Save</button>
              <span className="muted text-xs">Leads received: {(m.leadStats as Row[]).map((x) => `${x.n} ${String(x.status).replace('_', ' ')}`).join(', ') || 'none yet'}</span>
            </div>
          </AForm>
          <button className="btn" onClick={async () => void (await act('/admin/meta/action', { what: 'test_leads' }))}>
            Test and subscribe the Page
          </button>
          <p className="muted text-xs">Form questions are matched by name: child or student name, phone, email, grade or class, campus or branch, city or area. Anything else is saved as a note on the enquiry.</p>
        </div>
      </CardSection>

      <CardSection title="Channels and connectors">
        <table className="tbl">
          <caption className="sr-only">Channels and connectors</caption>
          <tbody>
            {(d!.connectors as [string, string, string][]).map(([name, cat, status]) => (
              <tr key={name}>
                <td className="font-medium">{name}</td>
                <td className="muted">{cat}</td>
                <td>{status === 'live' ? <Badge tone="green">Live</Badge> : status === 'simulated' ? <Badge tone="amber">Simulated provider</Badge> : <Badge>Not connected</Badge>}</td>
                <td className="muted text-xs">{status === 'live' ? 'Working now.' : status === 'simulated' ? 'Messages and payments are recorded and charged to the wallet but do not leave the system until a provider account is connected.' : 'Needs a provider account. Leads from this source can arrive today through the REST API below.'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardSection>

      <CardSection title="API keys">
        <AForm path="/admin/api-keys" onDone={reload} reset keep className="flex flex-wrap items-end gap-3 p-4">
          <label>
            <span className="label">Key name</span>
            <input name="name" required className="input w-56" placeholder="Website, listing portal…" />
          </label>
          <label>
            <span className="label">Tag leads with source</span>
            <select name="source_id" className="input w-64">
              <option value="">Decided by each request</option>
              {d!.sources.map((s: Row) => (
                <option key={s.id} value={s.id}>
                  {s.channel}: {s.name}
                </option>
              ))}
            </select>
          </label>
          <button className="btn btn-primary">Create key</button>
        </AForm>
        <table className="tbl">
          <caption className="sr-only">API keys</caption>
          <tbody>
            {(d!.keys as Row[]).map((k) => (
              <tr key={k.id}>
                <td className="font-medium">{k.name}</td>
                <td>
                  <code>{k.prefix}…</code>
                </td>
                <td className="muted">{d!.sources.find((s: Row) => s.id === k.source_id)?.name ?? 'Any source'}</td>
                <td className="muted">{k.revoked_at ? 'revoked' : k.last_used_at ? `last used ${rel(k.last_used_at)}` : 'never used'}</td>
                <td className="text-right">
                  {!k.revoked_at && (
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={async () => {
                        if (window.confirm(`Revoke the key "${k.name}"? Anything using it stops working.`) && (await act(`/admin/api-keys/${k.id}/revoke`, {}, { quiet: true }))) reload();
                      }}
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <pre className="m-4 overflow-x-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">{`curl -X POST ${d!.apiBase}/enquiries \\
  -H "Authorization: Bearer aed_..." -H "Content-Type: application/json" \\
  -H "Idempotency-Key: form-submission-123" \\
  -d '{"student_name":"Aarav Rao","guardian_name":"Suresh Rao","mobile":"9876543210","grade":"Grade 1","branch":"${d!.branchName}","utm":{"source":"google"}}'

GET  ${d!.apiBase}/enquiries?limit=50&cursor=...     list enquiries
POST ${d!.apiBase}/messages/inbound                   {"mobile":"...","body":"..."}  parent message from your provider
POST ${d!.apiBase}/calls/missed                       {"mobile":"..."}  missed call from your telephony provider`}</pre>
      </CardSection>

      <CardSection title="Outbound webhooks">
        <AForm path="/admin/webhooks" onDone={reload} reset keep className="flex flex-wrap items-end gap-3 p-4">
          <label>
            <span className="label">Endpoint URL (https)</span>
            <input name="url" type="url" required className="input w-96 max-w-full" placeholder="https://example.com/hooks/autoed" />
          </label>
          <button className="btn">Add webhook</button>
        </AForm>
        <table className="tbl">
          <caption className="sr-only">Webhooks</caption>
          <tbody>
            {(d!.hooks as Row[]).map((h) => (
              <tr key={h.id}>
                <td className="font-medium">{h.url}</td>
                <td className="muted text-xs">{h.last_status != null ? `last delivery: ${h.last_status === 0 ? 'unreachable' : h.last_status}` : 'No deliveries yet'}</td>
                <td className="text-right">
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={async () => {
                      if (await act(`/admin/webhooks/${h.id}/delete`, {}, { quiet: true })) reload();
                    }}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted px-4 pb-4 text-xs">
          Sends <code>enquiry.created</code> with an <code>x-autoed-signature</code> header (HMAC-SHA256 of the body with your signing secret).
        </p>
      </CardSection>
    </div>
  );
}

// ---------------------------------------------------------------- wallet
export function Wallet() {
  const { data: d, gate } = useAdmin<Row>('/admin/wallet');
  if (gate) return gate;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Wallet balance" value={inr(d!.balance)} tone={d!.balance < 200 ? 'bad' : undefined} sub={d!.balance < 200 ? 'Low: messages stop at zero' : 'WhatsApp, SMS and email credits'} />
        <Stat label="Plan" value={d!.plan ?? '–'} sub={d!.status ? `Status: ${d!.status}` : undefined} />
        <Stat label="Active users" value={d!.users} />
        <Stat label="Branches" value={d!.branches} />
      </div>
      <CardSection title="Spend in the last 30 days, by channel (₹)">
        <div className="p-4">{d!.usage.length ? <Bars rows={(d!.usage as Row[]).map((u) => ({ label: u.category, value: Math.round(u.amount * 100) / 100, note: `· ${u.n} msgs` }))} /> : <p className="muted">No usage yet.</p>}</div>
      </CardSection>
      <CardSection
        title="Ledger"
        actions={
          <button
            className="btn btn-sm"
            onClick={async () => void (await act('/admin/wallet/recharge-request'))}
          >
            Request a recharge
          </button>
        }
      >
        <div className="overflow-x-auto">
          <table className="tbl">
            <caption className="sr-only">Wallet ledger</caption>
            <thead>
              <tr>
                <th>When</th>
                <th>Type</th>
                <th>Category</th>
                <th>Note</th>
                <th className="text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {(d!.ledger as Row[]).map((l) => (
                <tr key={l.id}>
                  <td>{fmtDateTime(l.created_at)}</td>
                  <td>{l.type === 'credit' ? <Badge tone="green">Credit</Badge> : <Badge>Debit</Badge>}</td>
                  <td>{l.category}</td>
                  <td className="muted">{l.note}</td>
                  <td className="text-right tabular-nums">
                    {l.type === 'credit' ? '+' : '−'}
                    {inr(l.amount)}
                    {Number(l.amount) < 1 ? ` (${Number(l.amount).toFixed(2)})` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardSection>
    </div>
  );
}

// ---------------------------------------------------------------- data: import, duplicates, data-subject requests
export function Data() {
  const { data: d, gate, reload } = useAdmin<Row>('/admin/data');
  const dups = useAdmin<Row>('/data/duplicates');
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  if (gate) return gate;
  return (
    <div className="space-y-4">
      <CardSection title="Import a spreadsheet (CSV)">
        <AForm
          path="/admin/import"
          onDone={() => {
            setCsv('');
            setFileName('');
            reload();
          }}
          map={(f) => ({ ...f, csv, fileName })}
          className="grid items-end gap-3 p-4 md:grid-cols-4"
        >
          <label className="md:col-span-2">
            <span className="label">File: needs &quot;Student name&quot; and &quot;Mobile&quot;; also reads Parent name, Email, Grade, Source, Stage and Sub stage (stages from ExtraaEdge and similar CRMs are mapped automatically)</span>
            <input
              type="file"
              accept=".csv,text/csv"
              required
              className="input"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                setFileName(f?.name ?? '');
                setCsv(f ? await f.text() : '');
              }}
            />
          </label>
          <label>
            <span className="label">Branch</span>
            <select name="branch_id" className="input">
              {d!.branches.map((b: Row) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="label">Bring in as</span>
            <select name="as" className="input">
              <option value="prospect">Prospect data (no messages sent)</option>
              <option value="enquiry">Live enquiries (workflows run)</option>
            </select>
          </label>
          <label>
            <span className="label">If the family already exists</span>
            <select name="strategy" className="input">
              <option value="review">Send to the review queue</option>
              <option value="skip">Skip the row</option>
              <option value="touch">Add as re-enquiry / sibling</option>
            </select>
          </label>
          <label>
            <span className="label">Tag (optional)</span>
            <input name="tag" className="input" placeholder="pre-school tie-up" />
          </label>
          <label>
            <span className="label">Consent basis for this list</span>
            <input name="consent_basis" required className="input" placeholder="Open house sign-up sheet, Nov" />
          </label>
          <button className="btn btn-primary" disabled={!csv}>
            Import
          </button>
        </AForm>
      </CardSection>

      {d!.review.length > 0 && (
        <CardSection
          title={`Duplicate review queue · ${d!.review.length}`}
          actions={
            <span className="flex gap-1.5">
              <button className="btn btn-sm btn-primary" onClick={async () => (await act('/admin/import/review', { what: 'merge' })) && reload()}>
                Merge all
              </button>
              <button className="btn btn-sm" onClick={async () => (await act('/admin/import/review', { what: 'discard' })) && reload()}>
                Discard all
              </button>
            </span>
          }
        >
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Imported row</th>
                  <th>Matches household</th>
                  <th>File</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {(d!.review as Row[]).map((r) => (
                  <tr key={r.id}>
                    <td>
                      {r.data.studentName} · {r.data.guardianName} · {r.data.mobile}
                    </td>
                    <td>
                      <Link className="link" href={`/crm/households/${r.match_household_id}`}>
                        {r.guardian}
                      </Link>{' '}
                      <span className="muted text-xs">children: {r.children}</span>
                    </td>
                    <td className="muted">{r.file_name}</td>
                    <td className="text-right">
                      <span className="flex justify-end gap-1.5">
                        <button className="btn btn-sm" onClick={async () => (await act('/admin/import/review', { what: 'merge', rowId: r.id })) && reload()}>
                          Merge (re-enquiry or sibling)
                        </button>
                        <button className="btn btn-sm" onClick={async () => (await act('/admin/import/review', { what: 'discard', rowId: r.id })) && reload()}>
                          Discard
                        </button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardSection>
      )}

      <CardSection title="Import history">
        {!d!.batches.length ? (
          <Empty title="No imports yet">Bring last year&apos;s sheet in as prospect data. Duplicates go to a review queue instead of an error list, and any import can be undone.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>File</th>
                  <th>When</th>
                  <th>By</th>
                  <th>Rows</th>
                  <th>Created</th>
                  <th>Duplicates</th>
                  <th>Problems</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {(d!.batches as Row[]).map((b) => (
                  <tr key={b.id}>
                    <td className="font-medium">{b.file_name}</td>
                    <td>{fmtDateTime(b.created_at)}</td>
                    <td>{b.by}</td>
                    <td>{b.total}</td>
                    <td>{b.created}</td>
                    <td>{b.duplicates}</td>
                    <td className={b.failed ? 'text-rose-700' : ''}>
                      {b.failed}
                      {b.failed > 0 && (
                        <button className="link ml-2 text-xs" onClick={() => download(`/admin/import/${b.id}/failed`, {})}>
                          Download rows
                        </button>
                      )}
                    </td>
                    <td className="text-right">
                      {b.status === 'undone' ? (
                        <Badge>Undone</Badge>
                      ) : (
                        b.created > 0 && (
                          <button
                            className="btn btn-sm btn-danger"
                            onClick={async () => {
                              if (window.confirm(`Undo the import of ${b.file_name}? The ${b.created} records it created are removed.`) && (await act(`/admin/import/${b.id}/undo`))) reload();
                            }}
                          >
                            Undo import
                          </button>
                        )
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {d!.failed.length > 0 && (
          <div className="border-t border-slate-200 p-4">
            <p className="mb-1 text-xs font-semibold text-slate-700">Rows with problems</p>
            <ul className="space-y-0.5 text-xs">
              {(d!.failed as Row[]).map((f) => (
                <li key={f.id}>
                  <span className="muted">{f.file_name}:</span> {f.data.studentName || '(no name)'} · {f.data.mobile || '(no mobile)'} <span className="text-rose-700">{f.error}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardSection>

      {d!.canMerge && (
        <CardSection title="Possible duplicate families">
          {dups.gate ? (
            <div className="p-4">{dups.gate}</div>
          ) : !dups.data!.pairs.length ? (
            <Empty title="No duplicate families found">Families that share a phone, an alternate number or an email, or have the same child and parent name, are listed here.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="tbl">
                <caption className="sr-only">Possible duplicate families</caption>
                <thead>
                  <tr>
                    <th>Family to keep</th>
                    <th>Looks like the same family</th>
                    <th>Why</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {(dups.data!.pairs as { a: Row; b: Row; why: string }[]).map((p) => (
                    <tr key={p.a.id + p.b.id}>
                      {[p.a, p.b].map((x) => (
                        <td key={x.id}>
                          <Link className="link" href={`/crm/households/${x.id}`}>
                            {x.guardian}
                          </Link>
                          <span className="muted block text-xs">
                            {x.mobile} · {x.children || 'no child'} · {x.enquiries} enquir{x.enquiries === 1 ? 'y' : 'ies'}
                          </span>
                        </td>
                      ))}
                      <td className="muted text-xs">{p.why}</td>
                      <td className="text-right">
                        <button
                          className="btn btn-sm"
                          onClick={async () => {
                            if (window.confirm(`Merge ${p.b.guardian}'s family into ${p.a.guardian}'s? Every record moves; the same child twice keeps one open enquiry.`) && (await act(`/households/${p.b.id}/merge`, { into: p.a.id }))) {
                              reload();
                              dups.reload();
                            }
                          }}
                        >
                          Merge into the first
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardSection>
      )}

      {d!.fullAdmin && (
        <CardSection title="Data-subject requests">
          <div className="grid gap-4 p-4 md:grid-cols-2">
            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                const mobile = new FormData(e.currentTarget).get('mobile');
                void download('/admin/dsr/access', { mobile: String(mobile) });
              }}
            >
              <p className="font-medium">Access request</p>
              <p className="muted text-xs">Download everything held about a family as a JSON file to share with the parent.</p>
              <input name="mobile" required placeholder="Parent mobile" aria-label="Parent mobile for the access request" className="input" />
              <button className="btn">Download their data</button>
            </form>
            <AForm path="/admin/dsr/erase" reset confirm="Erase this family's personal data? This cannot be undone." className="space-y-2">
              <p className="font-medium">Erasure request</p>
              <p className="muted text-xs">Anonymises names, contacts, messages and notes. Cannot be undone. Logged in the audit trail.</p>
              <div className="flex gap-2">
                <input name="mobile" required placeholder="Parent mobile" aria-label="Parent mobile for the erasure request" className="input" />
                <input name="confirm" required placeholder="Type ERASE" aria-label="Type ERASE to confirm" className="input" />
              </div>
              <button className="btn btn-danger">Erase personal data</button>
            </AForm>
          </div>
        </CardSection>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- audit
export function Audit() {
  const sp = useSearchParams();
  const action = sp.get('action') ?? '';
  const q = sp.get('q') ?? '';
  const { data: d, gate } = useAdmin<Row>('/admin/audit', { action, q });
  if (gate) return gate;
  return (
    <CardSection
      title={
        <>
          Audit log <span className="muted font-normal">append-only</span>
        </>
      }
      actions={
        <form className="flex flex-wrap gap-2" method="get" action="/crm/admin/audit">
          <input name="q" defaultValue={q} placeholder="Search who or what" aria-label="Search the audit log" className="input w-56" />
          <select name="action" defaultValue={action} aria-label="Action" className="input w-40">
            <option value="">All actions</option>
            {(d!.actions as string[]).map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
          <button className="btn">Filter</button>
        </form>
      }
    >
      {!d!.events.length ? (
        <Empty title="Nothing matches" />
      ) : (
        <div className="overflow-x-auto">
          <table className="tbl">
            <caption className="sr-only">Audit log</caption>
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Action</th>
                <th>What</th>
                <th>Change</th>
              </tr>
            </thead>
            <tbody>
              {(d!.events as Row[]).map((a) => (
                <tr key={a.id}>
                  <td className="whitespace-nowrap">{fmtDateTime(a.created_at)}</td>
                  <td>{a.user_name}</td>
                  <td>
                    <Badge tone={a.action === 'delete' || a.action === 'erase' ? 'rose' : a.action === 'export' || a.action === 'merge' ? 'amber' : 'slate'}>{a.action}</Badge>
                  </td>
                  <td>{a.summary}</td>
                  <td className="max-w-xs text-xs text-slate-700">
                    {a.before || a.after ? (
                      <details>
                        <summary>Before / after</summary>
                        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2">{JSON.stringify({ before: a.before, after: a.after }, null, 1)}</pre>
                      </details>
                    ) : (
                      ''
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </CardSection>
  );
}

// ---------------------------------------------------------------- help
export function Help() {
  const { data: d, gate, reload } = useAdmin<Row>('/admin/help');
  if (gate) return gate;
  return (
    <div className="space-y-4">
      <CardSection title="Raise a ticket or request a feature">
        <AForm path="/admin/tickets" onDone={reload} reset className="grid gap-3 p-4 md:grid-cols-4">
          <label>
            <span className="label">Type</span>
            <select name="kind" className="input">
              <option value="ticket">Something is not working</option>
              <option value="feature">Feature request</option>
            </select>
          </label>
          <label className="md:col-span-3">
            <span className="label">Subject</span>
            <input name="subject" required className="input" />
          </label>
          <label className="md:col-span-4">
            <span className="label">Details</span>
            <textarea name="body" rows={3} className="input" />
          </label>
          <div>
            <button className="btn btn-primary">Send to AutoED</button>
          </div>
        </AForm>
        <table className="tbl">
          <caption className="sr-only">Tickets</caption>
          <tbody>
            {(d!.tickets as Row[]).map((t) => (
              <tr key={t.id}>
                <td>
                  <Badge tone={t.kind === 'feature' ? 'violet' : 'sky'}>{t.kind === 'feature' ? 'Feature request' : 'Ticket'}</Badge>
                </td>
                <td>
                  <b>{t.subject}</b>
                  <span className="muted block text-xs">{t.body}</span>
                  {t.reply && <span className="mt-1 block rounded bg-teal-50 px-2 py-1 text-xs text-teal-900">AutoED: {t.reply}</span>}
                </td>
                <td className="muted">
                  {t.by} · {rel(t.created_at)}
                </td>
                <td>
                  <Badge tone={t.status === 'open' ? 'amber' : 'green'}>{t.status}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardSection>
      <CardSection title="AutoED support access">
        <p className="muted px-4 pt-3 text-xs">AutoED support can only look at your workspace through a time-limited &quot;view as&quot; session, which is read-only unless you agree otherwise. Every session is listed here and written to your audit log.</p>
        {!d!.support.length ? (
          <Empty title="No support sessions" />
        ) : (
          <table className="tbl mt-2">
            <caption className="sr-only">Support sessions</caption>
            <tbody>
              {(d!.support as Row[]).map((a) => {
                const live = !a.ended_at && new Date(a.expires_at) > new Date();
                return (
                  <tr key={a.id}>
                    <td>
                      <b>{a.reason}</b>
                      <span className="muted block text-xs">{a.read_only ? 'Read-only' : 'Can make changes'}</span>
                    </td>
                    <td>{live ? <Badge tone="green">Active, ends {rel(a.expires_at)}</Badge> : <Badge>Ended</Badge>}</td>
                    <td className="muted text-xs">{fmtDateTime(a.started_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </CardSection>
    </div>
  );
}

void get;
