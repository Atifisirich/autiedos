/**
 * Loads the preloaded curriculum maps as global rows (org_id null) and clones a map into a
 * school's own editable copy (PRD 6.1).
 */
import { CURRICULUM, chapterTopics } from '@autoed/shared';
import { insert, maybe, q, type Tx } from './db';

export async function loadGlobalCurriculum(c: Tx): Promise<{ boards: number; topics: number }> {
  let topics = 0;
  let boards = 0;
  for (const b of CURRICULUM) {
    const existing = await maybe<{ id: string }>(c, `select id from os.curriculum_boards where org_id is null and key = $1 and syllabus_year = $2`, [b.key, b.syllabusYear]);
    if (existing) continue;
    await c.query(`update os.curriculum_boards set is_latest = false where org_id is null and key = $1`, [b.key]);
    const board = await insert<{ id: string }>(c, 'os.curriculum_boards', { org_id: null, key: b.key, name: b.name, syllabus_year: b.syllabusYear, is_latest: true });
    boards++;
    for (const s of b.subjects) {
      const subj = await insert<{ id: string }>(c, 'os.curriculum_subjects', { org_id: null, board_id: board.id, stage: s.stage, grade_level: s.grade, name: s.name, content_language: s.language });
      let useq = 1;
      for (const u of s.units) {
        const unit = await insert<{ id: string }>(c, 'os.curriculum_units', { org_id: null, subject_id: subj.id, seq: useq++, name: u.name });
        let cseq = 1;
        for (const chp of u.chapters) {
          const chapter = await insert<{ id: string }>(c, 'os.curriculum_topics', { org_id: null, unit_id: unit.id, kind: 'chapter', seq: cseq, name: chp.name, weight: chp.weight ?? chp.periods, est_periods: chp.periods });
          const ts = chapterTopics(chp, s.language);
          let tseq = 1;
          for (const t of ts) {
            const per = Math.max(1, Math.round(chp.periods / ts.length));
            const topic = await insert<{ id: string }>(c, 'os.curriculum_topics', { org_id: null, unit_id: unit.id, parent_topic_id: chapter.id, kind: 'topic', seq: tseq, name: t.name, weight: 1, est_periods: per });
            topics++;
            let oseq = 1;
            for (const o of t.outcomes) {
              await insert(c, 'os.learning_outcomes', { org_id: null, topic_id: topic.id, code: `${b.key === 'CBSE' ? 'CB' : 'CA'}.${s.code}.${s.grade}.${useq - 1}.${cseq}.${tseq}.${oseq++}`, text: o, kind: b.key === 'CBSE' ? 'outcome' : 'objective' });
            }
            if (t.competency) await insert(c, 'os.learning_outcomes', { org_id: null, topic_id: topic.id, code: `${b.key === 'CBSE' ? 'CB' : 'CA'}.${s.code}.${s.grade}.${useq - 1}.${cseq}.${tseq}.C`, text: t.competency, kind: b.key === 'CBSE' ? 'competency' : 'assessment_objective' });
            tseq++;
          }
          cseq++;
        }
      }
    }
  }
  return { boards, topics };
}

/** Deep-copies a board (global or the school's) into the school's editable map. */
export async function cloneBoard(c: Tx, orgId: string, boardId: string): Promise<string> {
  const src = await maybe<{ key: string; name: string; syllabus_year: string }>(c, `select key, name, syllabus_year from os.curriculum_boards where id = $1`, [boardId]);
  if (!src) throw new Error('board not found');
  const board = await insert<{ id: string }>(c, 'os.curriculum_boards', { org_id: orgId, key: src.key, name: `${src.name} (school copy)`, syllabus_year: src.syllabus_year, cloned_from_id: boardId });
  const subjects = await q<{ id: string; stage: string; grade_level: number; name: string; content_language: string }>(c, `select * from os.curriculum_subjects where board_id = $1 and deleted_at is null`, [boardId]);
  for (const s of subjects) {
    const ns = await insert<{ id: string }>(c, 'os.curriculum_subjects', { org_id: orgId, board_id: board.id, stage: s.stage, grade_level: s.grade_level, name: s.name, content_language: s.content_language });
    const units = await q<{ id: string; seq: number; name: string }>(c, `select * from os.curriculum_units where subject_id = $1 and deleted_at is null order by seq`, [s.id]);
    for (const u of units) {
      const nu = await insert<{ id: string }>(c, 'os.curriculum_units', { org_id: orgId, subject_id: ns.id, seq: u.seq, name: u.name });
      const all = await q<{ id: string; parent_topic_id: string | null; kind: string; seq: number; name: string; weight: number; est_periods: number }>(
        c,
        `select * from os.curriculum_topics where unit_id = $1 and deleted_at is null order by parent_topic_id nulls first, seq`,
        [u.id],
      );
      const map = new Map<string, string>();
      for (const t of all) {
        const nt = await insert<{ id: string }>(c, 'os.curriculum_topics', { org_id: orgId, unit_id: nu.id, parent_topic_id: t.parent_topic_id ? map.get(t.parent_topic_id) ?? null : null, kind: t.kind, seq: t.seq, name: t.name, weight: t.weight, est_periods: t.est_periods });
        map.set(t.id, nt.id);
        await c.query(
          `insert into os.learning_outcomes (org_id, topic_id, code, text, kind, bloom) select $1, $2, code, text, kind, bloom from os.learning_outcomes where topic_id = $3 and deleted_at is null`,
          [orgId, nt.id, t.id],
        );
      }
    }
  }
  return board.id;
}
