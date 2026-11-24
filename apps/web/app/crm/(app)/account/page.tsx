'use client';
import { act, useCrm } from '@/lib/crm/api';
import { rel } from '@/lib/crm/fmt';
import { Badge, ErrorBox, Loading, PageHeader } from '@/components/crm/ui';

type Res = { user: { name: string; email: string | null }; role: string; org: string; devices: { id: string; device_name: string | null; platform: string | null; created_at: string; last_seen_at: string | null; current: boolean }[] };

/** The person's own account. Passwords and two-factor sign-in belong to the platform's sign-in (Supabase Auth), not to this screen. */
export default function AccountPage() {
  const { data, error, reload } = useCrm<Res>('/account');
  if (error) return <ErrorBox message={error.message} />;
  if (!data) return <Loading />;
  return (
    <>
      <PageHeader title="My account" sub={`${data.user.name} · ${data.user.email ?? 'no email on file'} · ${data.role} · ${data.org}`} />
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card" aria-label="Signed-in devices">
          <div className="card-h">
            <h2>Signed-in devices</h2>
          </div>
          <ul className="divide-y divide-slate-100">
            {data.devices.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-2 px-4 py-2">
                <div>
                  <span className="font-medium">{d.device_name ?? (d.platform === 'web' ? 'Web browser' : (d.platform ?? 'Device'))}</span>
                  {d.current && (
                    <span className="ml-2">
                      <Badge tone="green">This device</Badge>
                    </span>
                  )}
                  <span className="muted block text-xs">
                    Signed in {rel(d.created_at)}
                    {d.last_seen_at ? ` · last seen ${rel(d.last_seen_at)}` : ''}
                  </span>
                </div>
                {!d.current && (
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={async () => {
                      if (await act(`/account/devices/${d.id}/revoke`, {}, { quiet: true })) reload();
                    }}
                  >
                    Sign out
                  </button>
                )}
              </li>
            ))}
          </ul>
          <p className="muted px-4 py-2 text-xs">Lost a phone? Sign it out here, or ask your admin to pause and reactivate your user: that signs out every device.</p>
        </section>
        <section className="card p-4" aria-label="Sign-in security">
          <h2 className="text-sm font-semibold text-slate-800">Sign-in security</h2>
          <p className="muted mt-2">You sign in with a one-time code sent to your phone or email, handled by the platform. Two-factor settings and a password (if your school uses one) are managed where you sign in, not in the CRM.</p>
        </section>
      </div>
    </>
  );
}
