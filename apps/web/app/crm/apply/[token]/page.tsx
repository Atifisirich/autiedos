'use client';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { CrmError, act, post, useCrm } from '@/lib/crm/api';
import { inr } from '@/lib/crm/fmt';
import { ApplicationForm, type AppSection } from '@/components/crm/forms';

type Page = {
  school: string; color: string; branch: string; student: string; grade: string; application_no: string | null; stage: string; sections: AppSection[]; application: { progress: number; status: string } | null; submitted: boolean;
  answers: Record<string, string>; documents: { id: string; type: string; status: string; reject_reason: string | null }[]; payments: { id: string; purpose: string; amount: number; status: string; receipt_no: string | null; url: string }[];
};

/** Parent's application link: prefilled, save and resume, progress, documents and fee status (APP-01, APP-02). No sign-in: the link is the key. */
export default function ApplyPage() {
  const { token } = useParams<{ token: string }>();
  const { data: p, error, reload } = useCrm<Page>(`/apply/${token}/page`);
  if (error)
    return (
      <Wrap color="#0f766e">
        <div className="card p-6 text-center">This link is not valid any more. Please ask the school for a new one.</div>
      </Wrap>
    );
  if (!p) return <Wrap color="#0f766e">Loading…</Wrap>;
  return (
    <Wrap color={p.color}>
      <div className="overflow-hidden rounded-xl bg-white shadow">
        <div className="px-6 py-5 text-white" style={{ background: p.color }}>
          <p className="text-sm opacity-90">
            {p.school} · {p.branch}
          </p>
          <h1 className="text-xl font-semibold">
            Application for {p.student}, {p.grade}
          </h1>
          {p.application_no && <p className="text-sm opacity-90">Application number {p.application_no}</p>}
        </div>
        <div className="p-6">
          {p.submitted ? (
            <p className="mb-4 rounded-md bg-green-50 px-3 py-2 text-green-900">
              Your application is submitted. Current status: <b>{p.stage}</b>. The school will contact you about the next step.
            </p>
          ) : (
            <p className="muted mb-4">We have filled in what we already know. {p.application ? `You are ${p.application.progress}% done; ` : ''}you can save and come back to this link at any time.</p>
          )}
          <ApplicationForm
            key={JSON.stringify(p.answers)}
            sections={p.sections}
            answers={p.answers}
            readOnly={p.submitted}
            staff={false}
            onSave={async (body) => {
              try {
                const r = await post<{ ok: boolean; error?: string }>(`/apply/${token}`, { ...body.answers, submit: body.submit, declaration: body.declaration });
                if (r.ok) reload();
                return r;
              } catch (e) {
                return { ok: false, error: e instanceof CrmError ? ((e.data as { error?: string })?.error ?? e.message) : 'Could not save.' };
              }
            }}
          />
        </div>
      </div>
      {p.documents.length > 0 && (
        <div className="rounded-xl bg-white p-6 shadow">
          <h2 className="font-semibold text-slate-900">Documents</h2>
          <ul className="mt-2 divide-y divide-slate-100">
            {p.documents.map((d) => (
              <Doc key={d.id} d={d} token={token} onDone={reload} />
            ))}
          </ul>
        </div>
      )}
      {p.payments.length > 0 && (
        <div className="rounded-xl bg-white p-6 shadow">
          <h2 className="font-semibold text-slate-900">Fees</h2>
          <ul className="mt-2 space-y-2">
            {p.payments.map((x) => (
              <li key={x.id} className="flex items-center justify-between gap-2">
                <span>
                  {x.purpose} · {inr(x.amount)}
                </span>
                {x.status === 'paid' ? (
                  <span className="text-green-900">✓ Paid · receipt {x.receipt_no}</span>
                ) : (
                  <a className="btn btn-primary btn-sm" href={x.url}>
                    Pay now
                  </a>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Wrap>
  );
}

function Wrap({ children }: { color: string; children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-slate-100 px-4 py-8">
      <div className="mx-auto max-w-2xl space-y-4">{children}</div>
    </main>
  );
}

function Doc({ d, token, onDone }: { d: Page['documents'][number]; token: string; onDone: () => void }) {
  const [file, setFile] = useState('');
  return (
    <li className="py-2.5">
      <div className="flex items-center justify-between">
        <span>{d.type}</span>
        <span className={d.status === 'verified' ? 'text-green-900' : d.status === 'rejected' ? 'text-rose-700' : 'text-slate-700'}>
          {d.status === 'verified' ? '✓ Verified' : d.status === 'uploaded' ? 'Received, being checked' : d.status === 'rejected' ? 'Please send again' : 'Not yet received'}
        </span>
      </div>
      {d.reject_reason && <p className="text-sm text-rose-700">{d.reject_reason}</p>}
      {['pending', 'rejected'].includes(d.status) && (
        <form
          className="mt-1 flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (file && (await act(`/apply/${token}/document`, { docId: d.id, fileName: file }, { quiet: true }))) onDone();
          }}
        >
          <input type="file" required accept="image/*,.pdf" capture="environment" aria-label={`File for ${d.type}`} onChange={(e) => setFile(e.target.files?.[0]?.name ?? '')} className="w-full text-sm" />
          <button className="btn btn-sm">Send</button>
        </form>
      )}
    </li>
  );
}
