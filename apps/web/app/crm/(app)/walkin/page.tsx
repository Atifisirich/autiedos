'use client';
import Link from 'next/link';
import { useState } from 'react';
import { CrmError, formObj, post, useCrm } from '@/lib/crm/api';
import { DuplicateNotice, useDuplicate } from '@/components/crm/shell';
import { ErrorBox, Loading } from '@/components/crm/ui';

type Done = { token: string; message: string; ownerName: string; householdId: string; enquiryId: string };

/** Front-office walk-in mode: big targets, mobile number first, duplicate shown before saving (CAP-02). */
export default function WalkInPage() {
  const { data, error } = useCrm<{ grades: string[]; branches: { id: string; name: string }[]; branchId: string | null }>('/walkin');
  const [mobile, setMobile] = useState('');
  const [n, setN] = useState(0);
  const [done, setDone] = useState<Done | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const dup = useDuplicate(mobile);
  if (error) return <ErrorBox message={error.status === 403 ? 'Your role cannot add walk-ins.' : error.message} />;
  if (!data) return <Loading />;
  if (done)
    return (
      <div className="mx-auto max-w-xl rounded-xl border border-green-300 bg-green-50 p-8 text-center" role="status">
        <p className="text-sm font-semibold text-green-900">Visitor token</p>
        <p className="my-2 text-6xl font-bold text-green-900">{done.token}</p>
        <p className="text-lg text-slate-900">{done.message}</p>
        <p className="mt-1 text-slate-700">
          Counsellor: <b>{done.ownerName}</b> has been notified with a task.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <button
            className="btn btn-primary btn-lg"
            onClick={() => {
              setDone(null);
              setMobile('');
              setN(n + 1);
            }}
          >
            Next visitor
          </button>
          <Link className="btn btn-lg" href={`/crm/households/${done.householdId}?e=${done.enquiryId}`}>
            Open record
          </Link>
        </div>
      </div>
    );
  return (
    <form
      key={n}
      className="mx-auto max-w-xl space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr('');
        try {
          const f = formObj(e.currentTarget);
          setDone(await post<Done>('/walkin', { ...f, consent: f.consent === 'on' }));
        } catch (x) {
          setErr(x instanceof CrmError ? ((x.data as { error?: string })?.error ?? x.message) : 'Could not save.');
        } finally {
          setBusy(false);
        }
      }}
    >
      <h1 className="text-2xl font-semibold text-slate-900">Walk-in desk</h1>
      <label className="block">
        <span className="mb-1 block text-base font-medium">Parent&apos;s mobile number</span>
        <input name="mobile" required autoFocus inputMode="numeric" value={mobile} onChange={(e) => setMobile(e.target.value)} className="input !min-h-[52px] !text-2xl tracking-wider" placeholder="98765 43210" autoComplete="off" />
      </label>
      <DuplicateNotice dup={dup} />
      <label className="block">
        <span className="mb-1 block text-base font-medium">Child&apos;s name</span>
        <input name="studentName" required className="input !min-h-[48px] !text-lg" />
      </label>
      {!dup && (
        <label className="block">
          <span className="mb-1 block text-base font-medium">Parent&apos;s name</span>
          <input name="guardianName" required className="input !min-h-[48px] !text-lg" />
        </label>
      )}
      <div className="grid grid-cols-2 gap-4">
        <label className="block">
          <span className="mb-1 block text-base font-medium">Grade</span>
          <select name="grade" required className="input !min-h-[48px] !text-lg">
            {data.grades.map((g) => (
              <option key={g}>{g}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-base font-medium">Branch</span>
          <select name="branchId" defaultValue={data.branchId ?? ''} className="input !min-h-[48px] !text-lg">
            {data.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="flex items-center gap-2 text-slate-800">
        <input type="checkbox" name="consent" defaultChecked className="h-5 w-5" /> Parent agrees to be contacted about admissions
      </label>
      {err && (
        <p role="alert" className="rounded-md bg-rose-50 px-3 py-2 text-rose-800">
          {err}
        </p>
      )}
      <button className="btn btn-primary btn-lg w-full" disabled={busy}>
        {busy ? 'Saving…' : dup ? 'Check in this family' : 'Save walk-in'}
      </button>
    </form>
  );
}
