'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Suspense, type ReactNode } from 'react';
import { ErrorBox, Loading } from '@/components/crm/ui';
import { useShell } from '@/components/crm/shell';
import { Fields, Org, Pipeline, Roles, Users } from '@/components/crm/admin/people';
import { Forms, Routing, Sources, Templates, Workflows } from '@/components/crm/admin/config';
import { Audit, Data, Help, Integrations, Wallet } from '@/components/crm/admin/ops';

export default function AdminSection() {
  return (
    <Suspense fallback={<Loading />}>
      <Inner />
    </Suspense>
  );
}

function Inner() {
  const { section } = useParams<{ section: string }>();
  const { shell } = useShell();
  const meta = shell.adminCatalogue.find((s) => s.key === section);
  if (!meta) return <ErrorBox message="Your role cannot open this part of the admin console, or it does not exist." />;
  const body: Record<string, ReactNode> = {
    org: <Org />, users: <Users />, roles: <Roles />, fields: <Fields />, pipeline: <Pipeline />, sources: <Sources />, routing: <Routing />, templates: <Templates />, forms: <Forms />, workflows: <Workflows />,
    integrations: <Integrations />, wallet: <Wallet />, data: <Data />, audit: <Audit />, help: <Help />,
  };
  return (
    <div className="grid gap-5 lg:grid-cols-[13rem_1fr]">
      <nav aria-label="Admin sections" className="space-y-0.5">
        <Link href="/crm/admin" className="muted mb-2 block text-xs hover:underline">
          ← Admin console
        </Link>
        {shell.adminCatalogue.map((s) => (
          <Link key={s.key} href={`/crm/admin/${s.key}`} aria-current={s.key === section ? 'page' : undefined} className={`block rounded-md px-2.5 py-1.5 ${s.key === section ? 'bg-teal-50 font-semibold text-teal-900' : 'text-slate-700 hover:bg-slate-100'}`}>
            {s.label}
          </Link>
        ))}
      </nav>
      <div className="min-w-0">
        <h1 className="text-xl font-semibold text-slate-900">{meta.label}</h1>
        <p className="muted mb-4">{meta.description}</p>
        {body[section]}
      </div>
    </div>
  );
}
