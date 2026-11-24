'use server';
import { getCtx } from '@/lib/erp/ctx';
import { core, erp } from '@/lib/erp/db';
import { go, str, errMsg } from '@/lib/erp/fmt';

import { erpAi } from '@/lib/erp/ai';

const num = (fd: FormData, k: string, d: number) => { const v = str(fd, k); return v === null || isNaN(Number(v)) ? d : Number(v); };

export async function createTest(fd: FormData) {
  const ctx = await getCtx();
  if (!ctx.can('exams', 'write')) go('/erp/exams?tab=tests', 'You do not have permission to create tests.', 'err');
  const subject = str(fd, 'subject_id');
  let q = core(ctx.sb).from('question_bank').select('id').eq('status', 'approved').is('deleted_at', null).limit(num(fd, 'count', 10));
  if (subject) q = q.eq('subject_id', subject);
  if (str(fd, 'bloom')) q = q.eq('bloom', str(fd, 'bloom')!);
  const { data: qs } = await q;
  if (!qs?.length) go('/erp/exams?tab=tests', 'No approved questions match. Add questions to the bank first.', 'err');
  const { error } = await erp(ctx.sb).from('online_tests').insert({ title: str(fd, 'title'), section_id: str(fd, 'section_id'), subject_id: subject, question_ids: (qs as { id: string }[]).map((x) => x.id), duration_min: num(fd, 'duration', 30), is_diagnostic: fd.get('diagnostic') === 'on', status: 'live', branch_id: ctx.branchId ?? ctx.orgUser.home_branch_id, randomise: true });
  go('/erp/exams?tab=tests', error ? error.message : 'Test published. Students see it in their app.', error ? 'err' : 'ok');
}

export async function closeTest(fd: FormData) {
  const ctx = await getCtx();
  await erp(ctx.sb).from('online_tests').update({ status: str(fd, 'status') }).eq('id', str(fd, 'id')!);
  go('/erp/exams?tab=tests', 'Updated.');
}

/** Seating plan and hall tickets for one date-sheet entry: students are mixed across sections and spread over rooms (EXM-01). */
export async function seat(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd, 'schedule')!;
  const per = num(fd, 'per_room', 30);
  const rooms = fd.getAll('room_id').map(String).filter(Boolean);
  if (!rooms.length) go(`/erp/exams?schedule=${id}`, 'Choose at least one room.', 'err');
  const { data: sch } = await core(ctx.sb).from('exam_schedules').select('programme_id, section_id').eq('id', id).single();
  let sq = core(ctx.sb).from('students').select('id, section_id, roll_no').eq('status', 'active').is('deleted_at', null).order('roll_no').limit(5000);
  const s = sch as { programme_id: string | null; section_id: string | null } | null;
  if (s?.section_id) sq = sq.eq('section_id', s.section_id); else if (s?.programme_id) sq = sq.eq('programme_id', s.programme_id);
  const { data: studs } = await sq;
  const list = (studs ?? []) as { id: string; section_id: string | null }[];
  if (!list.length) go('/erp/exams', 'No students in that class.', 'err');
  const bySec = new Map<string, typeof list>();
  for (const x of list) bySec.set(x.section_id ?? '', [...(bySec.get(x.section_id ?? '') ?? []), x]);
  const mixed: typeof list = [];
  const queues = [...bySec.values()];
  while (queues.some((qq) => qq.length)) for (const qq of queues) { const n = qq.shift(); if (n) mixed.push(n); }
  if (mixed.length > rooms.length * per) go(`/erp/exams?schedule=${id}`, `${mixed.length} students do not fit in ${rooms.length} room(s) of ${per}. Add rooms or seats.`, 'err');
  await core(ctx.sb).from('exam_seating').delete().eq('exam_schedule_id', id);
  const tag = id.slice(0, 4).toUpperCase();
  const rows = mixed.map((x, i) => ({ exam_schedule_id: id, student_id: x.id, room_id: rooms[Math.floor(i / per)], seat_no: String((i % per) + 1), hall_ticket_no: `HT-${tag}-${String(i + 1).padStart(3, '0')}` }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await core(ctx.sb).from('exam_seating').insert(rows.slice(i, i + 500));
    if (error) go(`/erp/exams?schedule=${id}`, error.message, 'err');
  }
  go(`/erp/exams?schedule=${id}`, `Seating generated for ${rows.length} students across ${Math.min(rooms.length, Math.ceil(rows.length / per))} rooms.`);
}

/** Draft questions from a curriculum topic. The AI hook is optional: without it the screen says so and nothing is invented. */
export async function aiQuestions(fd: FormData) {
  const ctx = await getCtx();
  const topic = str(fd, 'topic'), subject = str(fd, 'subject_id');
  if (!topic) go('/erp/exams?tab=bank', 'Type the topic and learning outcomes.', 'err');
  try {
    const out = await erpAi.json<{ question: string; options: string[]; answer: string; difficulty: string; bloom: string }[]>('You write school exam questions. Return a JSON array of 5 multiple-choice questions: [{"question","options":[4 strings],"answer":(exactly one of the options),"difficulty":"easy|medium|hard","bloom":"remember|understand|apply|analyse|evaluate|create"}].', `Topic and learning outcomes: ${topic}.`, { maxTokens: 1500 });
    if (!out?.length) go('/erp/exams?tab=bank', 'The AI helper is not switched on for this school, so no questions were drafted. Add questions by hand.', 'err');
    await core(ctx.sb).from('question_bank').insert(out!.map((x) => ({ subject_id: subject, content: { type: 'mcq', text: x.question, options: x.options, answer: x.answer }, difficulty: ['easy', 'medium', 'hard'].includes(x.difficulty) ? x.difficulty : null, bloom: x.bloom, marks: 1, source: 'ai', status: 'draft' })));
    go('/erp/exams?tab=bank', '5 questions drafted. They stay in draft until a teacher approves them.');
  } catch (e) {
    if (e && typeof e === 'object' && 'digest' in e) throw e; // redirect
    go('/erp/exams?tab=bank', errMsg(e), 'err');
  }
}
