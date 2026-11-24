'use client';
import { useAdmin } from '../_lib/admin';
import { AuditViewer } from '../_lib/audit-viewer';
import { PageTitle } from '../_lib/ui';

export default function AuditPage() {
  const { t } = useAdmin();
  return (
    <>
      <PageTitle title={t('console.audit.page')} subtitle={t('console.audit.subtitle')} />
      <AuditViewer />
    </>
  );
}
