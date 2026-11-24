'use client';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { CrmError, formObj, post, useCrm } from '@/lib/crm/api';

type Meta = { school: string; color: string; fields: string[]; grades: string[]; branches: { id: string; name: string }[]; notice: string };

/** Hosted enquiry form (CAP-03, FB-02): school branded, UTM and click ids captured, consent and privacy notice shown. No sign-in. */
export default function PublicForm() {
  return (
    <Suspense fallback={null}>
      <Form />
    </Suspense>
  );
}

function Form() {
  const { slug } = useParams<{ slug: string }>();
  const sp = Object.fromEntries(useSearchParams().entries());
  const { data, error } = useCrm<Meta>(`/forms/${slug}`, sp);
  const [loaded] = useState(() => Date.now());
  const [state, setState] = useState<{ ok: boolean; message?: string; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (error) return <Shell color="#0f766e" school="">This form is not available. Please contact the school.</Shell>;
  if (!data) return <Shell color="#0f766e" school="">Loading…</Shell>;
  const has = (k: string) => data.fields.includes(k);
  const utm = Object.fromEntries(Object.entries(sp).filter(([k, v]) => v && (k.startsWith('utm_') || ['gclid', 'fbclid'].includes(k))));
  return (
    <Shell color={data.color} school={data.school}>
      {state?.ok ? (
        <div className="px-6 py-12 text-center" role="status">
          <p className="text-3xl" aria-hidden>
            ✓
          </p>
          <p className="mt-2 text-lg font-medium text-slate-900">{state.message}</p>
        </div>
      ) : (
        <form
          className="space-y-4 px-6 py-6 text-base"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const f = formObj(e.currentTarget);
              setState(await post(`/forms/${slug}/submit`, { ...f, consent: f.consent === 'on', utm, loaded }));
            } catch (x) {
              setState({ ok: false, error: x instanceof CrmError ? ((x.data as { error?: string })?.error ?? x.message) : 'Could not send. Please try again.' });
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="hidden" aria-hidden>
            <label>
              Website
              <input name="website" tabIndex={-1} autoComplete="off" />
            </label>
          </div>
          <label className="block">
            <span className="label">Child&apos;s name</span>
            <input name="student_name" required className="input !min-h-[44px]" />
          </label>
          <label className="block">
            <span className="label">Your name</span>
            <input name="guardian_name" required autoComplete="name" className="input !min-h-[44px]" />
          </label>
          <label className="block">
            <span className="label">Mobile number</span>
            <input name="mobile" required inputMode="numeric" autoComplete="tel" pattern="[0-9+ ]{10,14}" className="input !min-h-[44px]" placeholder="10-digit mobile" />
          </label>
          {has('email') && (
            <label className="block">
              <span className="label">Email (optional)</span>
              <input name="email" type="email" autoComplete="email" className="input !min-h-[44px]" />
            </label>
          )}
          {has('grade') && (
            <label className="block">
              <span className="label">Grade you are looking for</span>
              <select name="grade" required className="input !min-h-[44px]" defaultValue="">
                <option value="" disabled>
                  Choose a grade
                </option>
                {data.grades.map((g) => (
                  <option key={g}>{g}</option>
                ))}
              </select>
            </label>
          )}
          {has('branch') && data.branches.length > 1 && (
            <label className="block">
              <span className="label">Campus</span>
              <select name="branch" required className="input !min-h-[44px]">
                {data.branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {has('branch') && data.branches.length === 1 && <input type="hidden" name="branch" value={data.branches[0]!.id} />}
          {data.branches.length === 1 && !has('branch') && <input type="hidden" name="branch" value={data.branches[0]!.id} />}
          {has('dob') && (
            <label className="block">
              <span className="label">Child&apos;s date of birth</span>
              <input name="dob" type="date" className="input !min-h-[44px]" />
            </label>
          )}
          {has('locality') && (
            <label className="block">
              <span className="label">Area you live in</span>
              <input name="locality" className="input !min-h-[44px]" />
            </label>
          )}
          {has('heard_about') && (
            <label className="block">
              <span className="label">How did you hear about us? (optional)</span>
              <input name="heard_about" className="input !min-h-[44px]" />
            </label>
          )}
          <label className="flex items-start gap-2 text-sm text-slate-700">
            <input type="checkbox" name="consent" required className="mt-1" />
            <span>I am the parent or guardian and I agree to be contacted about admission by call, WhatsApp, SMS or email. {data.notice}</span>
          </label>
          {state && !state.ok && (
            <p role="alert" className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800">
              {state.error}
            </p>
          )}
          <button className="w-full min-h-[48px] rounded-md px-4 py-3 font-semibold text-white disabled:opacity-60" style={{ background: data.color }} disabled={busy}>
            {busy ? 'Sending…' : 'Send enquiry'}
          </button>
        </form>
      )}
    </Shell>
  );
}

function Shell({ color, school, children }: { color: string; school: string; children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-slate-100 px-4 py-8">
      <div className="mx-auto max-w-lg overflow-hidden rounded-xl bg-white shadow">
        <div className="px-6 py-5 text-white" style={{ background: color }}>
          <p className="text-sm opacity-90">{school}</p>
          <h1 className="text-xl font-semibold">Admission enquiry</h1>
        </div>
        {children}
      </div>
    </main>
  );
}
