'use client';
import { useAdmin, useAdminApi } from '../../../_lib/admin';
import { Badge, Notice } from '../../../_lib/ui';

/** Read-only "what can this user see": the database gate, the role's modules, the branches and the billing access. */
export function PreviewPanel({ orgId, userId }: { orgId: string; userId: string }) {
  const { t, errorText } = useAdmin();
  const p = useAdminApi<any>(`/clients/${orgId}/users/${userId}/preview`);
  if (p.loading && !p.data) return <p className="mt-3 text-sm text-slate-700">{t('console.loading')}</p>;
  if (p.error) return <Notice error={errorText(p.error)} />;
  const d = p.data;
  if (!d) return null;
  return (
    <section aria-label={t('console.preview.title')} className="mt-3 rounded-md border border-slate-300 bg-slate-50 p-3">
      <h4 className="font-medium text-slate-900">{t('console.preview.heading', { name: d.user.display_name })}</h4>
      <p className="mb-3 text-sm text-slate-700">
        {d.visible_products.length ? t('console.preview.visible', { products: d.visible_products.map((k: string) => t(`console.product.${k}`)).join(', ') }) : t('console.preview.nothing')}
      </p>
      <p className="mb-3 text-xs text-slate-600">{t('console.preview.note')}</p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {d.products.map((pr: any) => (
          <div key={pr.product_key} className="rounded-md border border-slate-200 bg-white p-3 text-sm">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <strong>{t(`console.product.${pr.product_key}`)}</strong>
              <Badge tone={pr.db_gate === 'on' ? 'green' : 'red'}>{pr.db_gate === 'on' ? t('console.preview.gateOn') : t('console.preview.gateOff')}</Badge>
            </div>
            <p className="text-xs text-slate-700">
              {t('console.users.role')}: {pr.role_key ?? t('console.none')} · {t('console.subs.billingAccess')}: {t(`console.access.${pr.billing_access}`)}
            </p>
            {pr.off_reasons.length > 0 && (
              <ul className="mt-1 list-disc pl-5 text-xs text-red-800">
                {pr.off_reasons.map((r: string) => (
                  <li key={r}>{t(`console.off.${r}`)}</li>
                ))}
              </ul>
            )}
            {pr.modules.length > 0 && (
              <>
                <p className="mt-2 text-xs font-semibold text-slate-700">{t('console.preview.modules')}</p>
                <ul className="text-xs">
                  {pr.modules.map((m: any) => (
                    <li key={m.module_key}>
                      {m.module_key} · {t(`console.scope.${m.view_scope}`)}
                    </li>
                  ))}
                </ul>
              </>
            )}
            <p className="mt-2 text-xs font-semibold text-slate-700">{t('console.preview.branches')}</p>
            <ul className="text-xs">
              {pr.branches.map((b: any) => (
                <li key={b.id}>
                  {b.name}: {b.on ? t('console.preview.branchOn') : t('console.preview.branchOff')}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      {d.user.kind !== 'staff' && <p className="mt-2 text-xs text-slate-700">{t('console.preview.portal', { count: d.learner_link_count })}</p>}
    </section>
  );
}
