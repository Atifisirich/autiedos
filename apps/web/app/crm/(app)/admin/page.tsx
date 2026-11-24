'use client';
import Link from 'next/link';
import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useCrm } from '@/lib/crm/api';
import { rel } from '@/lib/crm/fmt';
import { ErrorBox, Loading, PageHeader } from '@/components/crm/ui';

type Home = { sections: { key: string; label: string; description: string }[]; setup: { label: string; ok: boolean; section: string }[]; recent: { summary: string; user_name: string; created_at: string }[]; canSetup: boolean };

export default function AdminHome() {
  return (
    <Suspense fallback={<Loading />}>
      <Inner />
    </Suspense>
  );
}

function Inner() {
  const term = useSearchParams().get('q') ?? '';
  const { data, error } = useCrm<Home>('/admin/home');
  if (error) return <ErrorBox message={error.status === 403 ? 'Your role does not have access to the admin console. Ask your admin if you need it.' : error.message} />;
  if (!data) return <Loading />;
  const sections = data.sections.filter((s) => (s.label + s.description).toLowerCase().includes(term.toLowerCase()));
  return (
    <>
      <PageHeader title="Admin console" sub="Everything you can configure yourself, in one place">
        <form method="get" action="/crm/admin">
          <input name="q" defaultValue={term} placeholder="Search settings" className="input w-56" aria-label="Search settings" />
        </form>
      </PageHeader>
      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <div className="grid content-start gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {sections.map((s) => (
            <Link key={s.key} href={`/crm/admin/${s.key}`} className="card block p-4 hover:border-teal-600">
              <div className="font-semibold text-slate-900">{s.label}</div>
              <div className="muted mt-0.5 text-xs">{s.description}</div>
            </Link>
          ))}
          {!sections.length && <p className="muted">No setting matches “{term}”.</p>}
        </div>
        <aside className="space-y-4">
          {data.canSetup && (
            <section className="card" aria-label="Setup checklist">
              <div className="card-h">
                <h2>Setup checklist</h2>
              </div>
              <ul className="divide-y divide-slate-100">
                {data.setup.map((s) => (
                  <li key={s.label} className="flex items-center justify-between gap-2 px-4 py-2">
                    <span className={s.ok ? 'text-slate-600' : 'font-medium'}>
                      {s.ok ? '✓' : '○'} {s.label}
                    </span>
                    {!s.ok && (
                      <Link className="link text-xs" href={`/crm/admin/${s.section}`}>
                        Open
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section className="card" aria-label="Recent configuration changes">
            <div className="card-h">
              <h2>Recent configuration changes</h2>
            </div>
            <ul className="divide-y divide-slate-100">
              {data.recent.map((a, i) => (
                <li key={i} className="px-4 py-2 text-xs">
                  <span className="text-slate-900">{a.summary}</span>
                  <span className="muted block">
                    {a.user_name} · {rel(a.created_at)}
                  </span>
                </li>
              ))}
              {!data.recent.length && <li className="muted px-4 py-3 text-xs">No changes yet.</li>}
            </ul>
          </section>
        </aside>
      </div>
    </>
  );
}
