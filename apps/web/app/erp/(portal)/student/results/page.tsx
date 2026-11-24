'use client';
import { childName, loadResults } from '@autoed/shared/erp-portal';
import { usePortal } from '@/lib/erp-portal/session';
import { useLoad } from '@/lib/erp-portal/use-load';
import { PageHead } from '@/components/erp-portal/ui';
import { ResultsCard } from '@/components/erp-portal/results';
import { NeedChild, WithData } from '@/components/erp-portal/screen';

export default function StudentResults() {
  return <NeedChild>{(child) => <Inner id={child.id} name={childName(child)} />}</NeedChild>;
}

function Inner({ id, name }: { id: string; name: string }) {
  const { sb, L } = usePortal();
  const q = useLoad('student-results', () => loadResults(sb!, id), [id], { childScoped: true });
  return (
    <>
      <PageHead title={L('student.results')} sub={name} />
      <WithData q={q}>{(rows) => <ResultsCard rows={rows} />}</WithData>
    </>
  );
}
