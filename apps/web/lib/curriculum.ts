'use client';
import { useEffect, useState } from 'react';
import { get } from './api';
import type { Lookups } from './lookups';

export interface TopicNode { id: string; name: string; est_periods: number; outcomes?: { code: string; text: string }[] }
export interface ChapterNode extends TopicNode { topics: TopicNode[] }

/** Finds the curriculum subject that matches a school subject for a section's class and wing board. */
export function useCurriculum(lk: Lookups | null, sectionId: string, subjectId: string) {
  const [chapters, setChapters] = useState<ChapterNode[] | null>(null);
  const [curriculumSubjectId, setCs] = useState<string | null>(null);
  useEffect(() => {
    setChapters(null);
    setCs(null);
    if (!lk || !sectionId || !subjectId) return;
    const section = lk.sections.find((s) => s.id === sectionId);
    const cls = lk.classes.find((c) => c.id === section?.class_id);
    const wing = lk.wings.find((w) => w.id === cls?.wing_id);
    const subject = lk.subjects.find((s) => s.id === subjectId);
    if (!cls || !subject) return;
    let cancelled = false;
    (async () => {
      const boards = await get<{ id: string; key: string; org_id: string | null; is_latest: boolean }[]>('/curriculum/boards');
      const ordered = [...boards].sort((a, b) => Number(!!b.org_id) - Number(!!a.org_id) || Number(b.is_latest) - Number(a.is_latest));
      for (const b of ordered.filter((x) => !wing || x.key === wing.board)) {
        const subjects = await get<{ id: string; grade_level: number; name: string }[]>(`/curriculum/boards/${b.id}`);
        const name = subject.name.toLowerCase();
        const match = subjects.find((s) => s.grade_level === cls.grade_level && (s.name.toLowerCase().includes(name) || name.includes(s.name.toLowerCase())));
        if (match) {
          const tree = await get<{ chapters: ChapterNode[] }[]>(`/curriculum/subjects/${match.id}`);
          if (!cancelled) (setCs(match.id), setChapters(tree.flatMap((u) => u.chapters)));
          return;
        }
      }
      if (!cancelled) setChapters([]);
    })().catch(() => !cancelled && setChapters([]));
    return () => {
      cancelled = true;
    };
  }, [lk, sectionId, subjectId]);
  return { chapters, curriculumSubjectId };
}
