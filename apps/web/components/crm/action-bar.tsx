'use client';
import Link from 'next/link';
import { useState } from 'react';
import { act, formObj } from '@/lib/crm/api';
import type { StageOpt } from './forms';
import { TASK_OPTIONS } from './forms';

type Opt = { id: string; name: string };
export type ActionBarProps = {
  enquiryId: string; mobile: string; stageId: string; stages: StageOpt[]; reasons: string[]; templates: (Opt & { channel: string; body: string })[]; users: Opt[]; defaultDue: string; initial?: string; hasApplication: boolean;
  fees: { registration: number; admission: number }; can: { edit: boolean; message: boolean; tasks: boolean; reassign: boolean; application: boolean; pay: boolean }; onDone: () => void;
};

/** One action bar on every record. Panels open inline so the user never loses the page (UX 15.2). */
export function ActionBar(p: ActionBarProps) {
  const [panel, setPanel] = useState(p.initial ?? '');
  const [stageId, setStageId] = useState('');
  const [err, setErr] = useState('');
  const [tpl, setTpl] = useState('');
  const [channel, setChannel] = useState('whatsapp');
  const [busy, setBusy] = useState(false);
  const target = p.stages.find((s) => s.id === stageId);
  const close = () => setPanel('');
  const base = `/leads/${p.enquiryId}`;
  /** Sends a form to an action; closes the panel and refreshes the page when it worked. */
  const submit = (path: string, mapBody?: (f: Record<string, any>) => Record<string, any>) => async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    setBusy(true);
    const r = await act(`${base}${path}`, mapBody ? mapBody(formObj(form)) : formObj(form));
    setBusy(false);
    if (r) {
      close();
      p.onDone();
    }
  };
  const Btn = ({ id, children, show = true }: { id: string; children: React.ReactNode; show?: boolean }) =>
    show ? (
      <button type="button" onClick={() => setPanel(panel === id ? '' : id)} aria-expanded={panel === id} className={`btn ${panel === id ? 'btn-primary' : ''}`}>
        {children}
      </button>
    ) : null;
  const shown = p.templates.filter((t) => t.channel === channel);
  return (
    <div className="card" role="region" aria-label="Actions">
      <div className="flex flex-wrap gap-2 p-3">
        <Btn id="call" show={p.can.edit}>📞 Call</Btn>
        <Btn id="message" show={p.can.message}>💬 Message</Btn>
        <Btn id="note">📝 Note</Btn>
        <Btn id="task" show={p.can.tasks}>⏰ Task</Btn>
        <Btn id="visit" show={p.can.tasks}>🏫 Book visit</Btn>
        <Btn id="stage" show={p.can.edit}>➜ Change stage</Btn>
        <Btn id="apply" show={p.can.application || p.can.pay}>📄 Form / payment</Btn>
        <Btn id="reassign" show={p.can.reassign}>👤 Reassign</Btn>
      </div>
      {panel && (
        <div className="border-t border-slate-200 bg-slate-50 p-3">
          {panel === 'call' && (
            <form onSubmit={submit('/call')} className="grid gap-3 md:grid-cols-4">
              <div className="md:col-span-4">
                <a href={`tel:+91${p.mobile}`} className="btn btn-primary">
                  Call +91 {p.mobile}
                </a>{' '}
                <span className="muted ml-2">Then log what happened. A disposition is required after every call.</span>
              </div>
              <label>
                <span className="label">Outcome</span>
                <select name="outcome" required className="input">
                  <option value="connected">Connected</option>
                  <option value="not_answered">Not answered</option>
                  <option value="busy">Busy</option>
                  <option value="switched_off">Switched off</option>
                  <option value="wrong_number">Wrong number</option>
                </select>
              </label>
              <label className="md:col-span-3">
                <span className="label">Notes</span>
                <input name="notes" className="input" placeholder="What did the parent say?" />
              </label>
              <label className="md:col-span-2">
                <span className="label">Next follow-up (optional)</span>
                <input name="nextTitle" className="input" placeholder="Follow-up call" />
              </label>
              <label>
                <span className="label">Due</span>
                <input type="datetime-local" name="nextDue" className="input" />
              </label>
              <div className="flex items-end">
                <button className="btn btn-primary" disabled={busy}>
                  Log call
                </button>
              </div>
            </form>
          )}
          {panel === 'message' && (
            <form onSubmit={submit('/message', (f) => ({ ...f, note: f.note === 'on' }))} className="space-y-3">
              <div className="flex flex-wrap items-end gap-3">
                <label>
                  <span className="label">Channel</span>
                  <select
                    name="channel"
                    value={channel}
                    onChange={(e) => {
                      setChannel(e.target.value);
                      setTpl('');
                    }}
                    className="input w-36"
                  >
                    <option value="whatsapp">WhatsApp</option>
                    <option value="sms">SMS</option>
                    <option value="email">Email</option>
                  </select>
                </label>
                <label>
                  <span className="label">Template</span>
                  <select name="templateId" value={tpl} onChange={(e) => setTpl(e.target.value)} className="input w-64">
                    <option value="">Free text</option>
                    {shown.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="muted pb-2 text-xs">Cost estimate: {channel === 'whatsapp' ? '₹0.80' : channel === 'sms' ? '₹0.25' : '₹0.02'} from the wallet</span>
              </div>
              {tpl ? (
                <p className="rounded-md border border-slate-200 bg-white p-3 text-slate-700">
                  {p.templates.find((t) => t.id === tpl)?.body}
                  <span className="muted mt-1 block text-xs">Names and links are filled in for this family when sent.</span>
                </p>
              ) : (
                <>
                  <label className="block">
                    <span className="label">Message</span>
                    <textarea name="body" rows={3} required className="input" placeholder="Type your message" />
                  </label>
                  <label className="flex items-center gap-2 text-xs">
                    <input type="checkbox" name="note" /> Internal note (not sent to the parent)
                  </label>
                </>
              )}
              <button className="btn btn-primary" disabled={busy}>
                Send
              </button>
            </form>
          )}
          {panel === 'note' && (
            <form onSubmit={submit('/note')} className="space-y-3">
              <label className="block">
                <span className="label">Internal note</span>
                <textarea name="note" rows={3} required autoFocus className="input" placeholder="Type @firstname to notify a colleague, for example @meera please approve." />
              </label>
              <button className="btn btn-primary" disabled={busy}>
                Save note
              </button>
            </form>
          )}
          {panel === 'task' && (
            <form onSubmit={submit('/task')} className="grid gap-3 md:grid-cols-5">
              <label>
                <span className="label">Type</span>
                <select name="type" className="input">
                  {TASK_OPTIONS.map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <label className="md:col-span-2">
                <span className="label">Task</span>
                <input name="title" required defaultValue="Follow-up call" className="input" />
              </label>
              <label>
                <span className="label">Due</span>
                <input type="datetime-local" name="dueAt" required defaultValue={p.defaultDue} className="input" />
              </label>
              <label>
                <span className="label">Priority</span>
                <select name="priority" className="input">
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                </select>
              </label>
              <div>
                <button className="btn btn-primary" disabled={busy}>
                  Add task
                </button>
              </div>
            </form>
          )}
          {panel === 'visit' && (
            <form onSubmit={submit('/visit')} className="grid gap-3 md:grid-cols-4">
              <label>
                <span className="label">Type</span>
                <select name="type" className="input">
                  <option value="campus_tour">Campus tour</option>
                  <option value="counselling">Counselling</option>
                  <option value="interaction">Interaction</option>
                  <option value="assessment">Assessment</option>
                </select>
              </label>
              <label>
                <span className="label">Date and time</span>
                <input type="datetime-local" name="slotAt" required defaultValue={p.defaultDue} className="input" />
              </label>
              <label>
                <span className="label">Host</span>
                <select name="hostId" className="input">
                  <option value="">Record owner</option>
                  {p.users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex items-end">
                <button className="btn btn-primary" disabled={busy}>
                  Book visit
                </button>
              </div>
            </form>
          )}
          {panel === 'stage' && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const f = formObj(e.currentTarget);
                setBusy(true);
                const r = await act<{ ok: boolean; missing?: string[]; error?: string }>(`${base}/stage`, { stageId, closure_reason: f.closure_reason || undefined }, { quiet: true });
                setBusy(false);
                if (r?.ok) {
                  setErr('');
                  close();
                  p.onDone();
                } else if (r) setErr(r.missing?.includes('visit') ? 'This stage needs a booked visit. Use Book visit and the stage moves by itself.' : r.missing ? 'Choose a closure reason.' : (r.error ?? 'Could not move.'));
              }}
              className="flex flex-wrap items-end gap-3"
            >
              <label>
                <span className="label">Move to</span>
                <select required value={stageId} onChange={(e) => setStageId(e.target.value)} className="input w-64">
                  <option value="">Choose a stage</option>
                  {p.stages.filter((s) => s.id !== p.stageId).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.phase_name}: {s.name}
                    </option>
                  ))}
                </select>
              </label>
              {target?.is_closed && (
                <label>
                  <span className="label">Closure reason</span>
                  <select name="closure_reason" required className="input w-56">
                    <option value="">Choose a reason</option>
                    {p.reasons.map((r) => (
                      <option key={r}>{r}</option>
                    ))}
                  </select>
                </label>
              )}
              <button className="btn btn-primary" disabled={busy}>
                Move
              </button>
              {err && (
                <p role="alert" className="w-full text-rose-700">
                  {err}
                </p>
              )}
            </form>
          )}
          {panel === 'apply' && (
            <div className="grid gap-4 md:grid-cols-2">
              {p.can.application && (
                <div>
                  <p className="mb-2 font-medium">Application form</p>
                  {p.hasApplication ? (
                    <Link className="btn" href={`/crm/applications/${p.enquiryId}`}>
                      Open the application
                    </Link>
                  ) : (
                    <button
                      className="btn btn-primary"
                      onClick={async () => {
                        if (await act(`${base}/application/start`)) {
                          close();
                          p.onDone();
                        }
                      }}
                    >
                      Start application
                    </button>
                  )}
                  {p.can.message && (
                    <button
                      className="btn mt-2 block"
                      onClick={async () => {
                        const t = p.templates.find((x) => x.name === 'Application link' && x.channel === 'whatsapp');
                        if (!t) return;
                        if (await act(`${base}/message`, { templateId: t.id })) {
                          close();
                          p.onDone();
                        }
                      }}
                    >
                      Send the form link on WhatsApp
                    </button>
                  )}
                </div>
              )}
              {p.can.pay && (
                <form onSubmit={submit('/payment')} className="grid grid-cols-2 gap-2">
                  <p className="col-span-2 font-medium">Payment</p>
                  <label>
                    <span className="label">For</span>
                    <select name="purpose" className="input">
                      <option>Registration fee</option>
                      <option>Admission fee</option>
                    </select>
                  </label>
                  <label>
                    <span className="label">Amount (₹)</span>
                    <input name="amount" type="number" min={1} required defaultValue={p.fees.registration} className="input" />
                  </label>
                  <label>
                    <span className="label">How</span>
                    <select name="mode" className="input">
                      <option value="link">Send payment link</option>
                      <option value="cash">Cash</option>
                      <option value="cheque">Cheque</option>
                      <option value="bank_transfer">Bank transfer</option>
                      <option value="upi">UPI at desk</option>
                    </select>
                  </label>
                  <label>
                    <span className="label">Reference (optional)</span>
                    <input name="reference" className="input" placeholder="Cheque / UTR no." />
                  </label>
                  <div className="col-span-2">
                    <button className="btn btn-primary" disabled={busy}>
                      Continue
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}
          {panel === 'reassign' && (
            <form onSubmit={submit('/reassign')} className="flex flex-wrap items-end gap-3">
              <label>
                <span className="label">New owner</span>
                <select name="ownerId" required className="input w-56">
                  <option value="">Choose</option>
                  {p.users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span className="label">Reason</span>
                <input name="reason" required className="input w-64" placeholder="Why is this moving?" />
              </label>
              <button className="btn btn-primary" disabled={busy}>
                Reassign
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
