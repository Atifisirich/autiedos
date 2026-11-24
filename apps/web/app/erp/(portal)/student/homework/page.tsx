'use client';
import { HomeworkList } from '@/components/erp-portal/homework-list';
import { NeedChild } from '@/components/erp-portal/screen';

export default function StudentHomework() {
  return <NeedChild>{(c) => <HomeworkList child={c} />}</NeedChild>;
}
