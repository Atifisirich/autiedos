'use client';
import { useEffect, useState } from 'react';
import { act, formObj } from '@/lib/crm/api';
import { Modal } from './ui';

export type StageOpt = { id: string; name: string; phase_name: string; is_closed: boolean; exempt_next_action: boolean };
export const TASK_OPTIONS: [string, string][] = [['call_back', 'Call back'], ['whatsapp_follow_up', 'WhatsApp follow-up'], ['document_chase', 'Document chase'], ['payment_chase', 'Payment chase'], ['interaction', 'Interaction'], ['custom', 'Other']];

/**
 * One-tap complete with outcome. When this is the enquiry's last open task the dialog also asks for the next action and
 * will not save without one (TSK-02, TSK-03): the server enforces it, the dialog only makes it easy.
 */
export function TaskDone({ taskId, title, lastOpen, stages, reasons, defaultDue, onDone }: { taskId: string; title: string; lastOpen: boolean; stages: StageOpt[]; reasons: string[]; defaultDue: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [next, setNext] = useState(lastOpen ? 'task' : 'none');
  const [stageId, setStageId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (open) {
      setError('');
      setNext(lastOpen ? 'task' : 'none');
    }
  }, [open, lastOpen]);
  const closing = stages.find((s) => s.id === stageId)?.is_closed;
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const f = formObj(e.currentTarget);
      const res = await fetch(`/api/crm/tasks/${taskId}/complete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(f) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) setError(data.error ?? 'Could not complete the task.');
      else {
        setOpen(false);
        onDone();
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="btn btn-sm" aria-label={`Mark done: ${title}`}>
        ✓ Done
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={`Complete: ${title}`}>
        <form onSubmit={submit}>
          <div className="card-h">Complete: {title}</div>
          <div className="space-y-3 p-4">
            <label className="block">
              <span className="label">Outcome</span>
              <input name="outcome" required autoFocus className="input" placeholder="What happened?" list={`outcomes-${taskId}`} />
              <datalist id={`outcomes-${taskId}`}>
                {['Spoke to parent, interested', 'Not answered', 'Asked to call later', 'Visit planned', 'Shared fee details', 'Not interested'].map((o) => (
                  <option key={o} value={o} />
                ))}
              </datalist>
            </label>
            <fieldset>
              <legend className="label">{lastOpen ? 'Next action (required: this is the last open task)' : 'Next action'}</legend>
              <div className="flex flex-wrap gap-3">
                <label className="flex items-center gap-1.5">
                  <input type="radio" name="next" value="task" checked={next === 'task'} onChange={() => setNext('task')} /> Schedule a task
                </label>
                <label className="flex items-center gap-1.5">
                  <input type="radio" name="next" value="stage" checked={next === 'stage'} onChange={() => setNext('stage')} /> Move stage / close
                </label>
                {!lastOpen && (
                  <label className="flex items-center gap-1.5">
                    <input type="radio" name="next" value="none" checked={next === 'none'} onChange={() => setNext('none')} /> Nothing more
                  </label>
                )}
              </div>
            </fieldset>
            {next === 'task' && (
              <div className="grid grid-cols-2 gap-3">
                <label className="col-span-2 block">
                  <span className="label">Task</span>
                  <input name="nextTitle" defaultValue="Follow-up call" required className="input" />
                </label>
                <label className="block">
                  <span className="label">Type</span>
                  <select name="nextType" className="input">
                    {TASK_OPTIONS.filter(([k]) => k !== 'interaction').map(([k, l]) => (
                      <option key={k} value={k}>
                        {l}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="label">Due</span>
                  <input type="datetime-local" name="nextDue" required defaultValue={defaultDue} className="input" />
                </label>
              </div>
            )}
            {next === 'stage' && (
              <>
                <label className="block">
                  <span className="label">Move to</span>
                  <select name="stageId" required value={stageId} onChange={(e) => setStageId(e.target.value)} className="input">
                    <option value="">Choose a stage</option>
                    {stages.filter((s) => !lastOpen || s.exempt_next_action).map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.phase_name}: {s.name}
                      </option>
                    ))}
                  </select>
                </label>
                {closing && (
                  <label className="block">
                    <span className="label">Closure reason</span>
                    <select name="closure_reason" required className="input">
                      <option value="">Choose a reason</option>
                      {reasons.map((r) => (
                        <option key={r}>{r}</option>
                      ))}
                    </select>
                  </label>
                )}
              </>
            )}
            {error && (
              <p role="alert" className="rounded-md bg-rose-50 px-3 py-2 text-rose-800">
                {error}
              </p>
            )}
          </div>
          <div className="flex justify-end gap-2 border-t border-slate-200 p-3">
            <button type="button" className="btn" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={busy}>
              {busy ? 'Saving…' : 'Complete task'}
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}

export type AppSection = { title: string; fields: { key: string; label: string; required?: boolean; type?: string; options?: string[] }[] };

/** The multi-section application. Used by staff in assisted mode and by parents on the public link (APP-01..03). */
export function ApplicationForm({ onSave, sections, answers, readOnly, staff, canOverrideAge }: { onSave: (body: Record<string, any>) => Promise<{ ok: boolean; error?: string }>; sections: AppSection[]; answers: Record<string, string>; readOnly: boolean; staff: boolean; canOverrideAge?: boolean }) {
  const [state, setState] = useState<{ ok: boolean; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const f = formObj(e.currentTarget);
    const { declaration, overrideAge, ...rest } = f;
    setBusy(true);
    try {
      setState(await onSave({ answers: rest, submit: submitter?.value === '1', declaration: declaration === 'on', overrideAge: overrideAge === 'on' }));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="space-y-5">
      {sections.map((s) => (
        <fieldset key={s.title} className="space-y-3">
          <legend className="text-sm font-semibold text-slate-900">{s.title}</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {s.fields.map((f) => (
              <label key={f.key} className="block">
                <span className="label">
                  {f.label}
                  {f.required && <span className="text-rose-700"> *</span>}
                </span>
                {f.options ? (
                  <select name={f.key} defaultValue={answers[f.key] ?? ''} disabled={readOnly} className="input">
                    <option value="">Choose</option>
                    {f.options.map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </select>
                ) : (
                  <input name={f.key} defaultValue={answers[f.key] ?? ''} readOnly={readOnly} className="input" />
                )}
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      {!readOnly && (
        <>
          <label className="flex items-start gap-2 rounded-md bg-slate-50 p-3 text-slate-800">
            <input type="checkbox" name="declaration" className="mt-0.5" />
            <span>{staff ? 'The parent has confirmed that the information above is true and has signed the declaration.' : "I confirm that the information above is true and I agree to the school's admission terms and privacy notice."}</span>
          </label>
          {canOverrideAge && (
            <label className="flex items-center gap-2 text-xs text-slate-700">
              <input type="checkbox" name="overrideAge" /> Override the age-eligibility rule for this child (logged)
            </label>
          )}
          {state && !state.ok && (
            <p role="alert" className="rounded-md bg-rose-50 px-3 py-2 text-rose-800">
              {state.error}
            </p>
          )}
          {state?.ok && (
            <p role="status" className="rounded-md bg-green-50 px-3 py-2 text-green-900">
              Saved.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button name="submit" value="0" className="btn" disabled={busy}>
              Save and continue later
            </button>
            <button name="submit" value="1" className="btn btn-primary" disabled={busy}>
              {busy ? 'Saving…' : 'Submit application'}
            </button>
          </div>
        </>
      )}
    </form>
  );
}

export { act };
