'use client';
/**
 * /go/<product>: hand-off to a product. Opens the product when this person has it, otherwise shows
 * "not part of your plan" (links from mail, the mobile app or bookmarks land here safely).
 */
import { use, useEffect } from 'react';
import { PRODUCT_HOME } from '@autoed/shared';
import { NotInPlan, hasProduct, usePlatformSession, useShellLang, type ProductKeyName } from '@/components/shell';

const isProduct = (p: string): p is ProductKeyName => p === 'os' || p === 'crm' || p === 'erp';

export default function GoToProduct({ params }: { params: Promise<{ product: string }> }) {
  const { product } = use(params);
  const { session } = usePlatformSession();
  const { t } = useShellLang(null, session?.lang ?? null);
  const ok = isProduct(product) && hasProduct(session, product);
  useEffect(() => {
    if (ok && isProduct(product)) window.location.replace(PRODUCT_HOME[product]);
  }, [ok, product]);
  if (!session || ok) {
    return (
      <div role="status" className="p-10 text-center text-sm text-slate-500">
        {t('common.loading')}
      </div>
    );
  }
  return <NotInPlan product={isProduct(product) ? product : 'os'} session={session} />;
}
