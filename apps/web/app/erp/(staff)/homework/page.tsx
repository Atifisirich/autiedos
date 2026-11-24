import Link from 'next/link';
import { requireCap, type Ctx } from '@/lib/erp/ctx';
import { core, erp } from '@/lib/erp/db';
import { Page, Card, Empty, Badge, Field, Tabs } from '@/components/erp/ui';
import { go, str, today, fdate, ftime } from '@/lib/erp/fmt';
import { workingDay, weekday } from '@/lib/erp/calendar';
import { sectionsFor } from '@/lib/erp/q';
import { options, look, lookup } from '@/lib/erp/lookup';

export const metadata = { title: 'Homework and diary' };
/** One "post to class" composer (HW-01) with optional coordinator approval (HW-02) and submissions (HW-03). */
async function post(fd: FormData) {
  'use server';
  const ctx = await requireCap('homework', 'write');
  const sections = fd.getAll('section_id').map(String).filter(Boolean);
  if (!sections.length) go('/erp/homework', 'Choose at least one section.', 'err');
  const needsApproval = ((ctx.org.settings ?? {}) as { homework_approval?: boolean }).homework_approval === true && ['class_teacher', 'subject_teacher'].includes(ctx.role);
  const link = str(fd, 'attachment_link');
  const mm = str(fd, 'max_marks');
  const rows = sections.map((sid) => ({ type: str(fd, 'type') ?? 'homework', section_id: sid, subject_id: str(fd, 'subject_id'), staff_id: ctx.staff?.id ?? null, title: str(fd, 'title'), body: [str(fd, 'body'), link ? `Link: ${link}` : null].filter(Boolean).join('\n') || null, due_date: str(fd, 'due_date'), allow_submission: fd.get('allow_submission') === 'on', max_marks: mm ? Number(mm) : null, status: needsApproval ? 'pending' : 'published', published_at: needsApproval ? null : new Date().toISOString() }));
  const { error } = await core(ctx.sb).from('class_posts').insert(rows);
  if (error) go('/erp/homework', error.message, 'err');
  if (!needsApproval) {
    // Parents see it in the app straight away, in one daily digest per child.
    const { data: studs } = await core(ctx.sb).from('students').select('household_id').in('section_id', sections).eq('status', 'active').is('deleted_at', null);
    const hh = [...new Set(((studs ?? []) as { household_id: string | null }[]).map((s) => s.household_id).filter((x): x is string => !!x))];
    const { data: gs } = hh.length ? await core(ctx.sb).from('guardians').select('user_id').in('household_id', hh).not('user_id', 'is', null) : { data: [] };
    const users = [...new Set(((gs ?? []) as { user_id: string }[]).map((g) => g.user_id))];
    if (users.length) await core(ctx.sb).from('notifications').insert(users.map((u) => ({ user_id: u, product_key: 'erp', event_key: 'homework', title: `New ${str(fd, 'type') ?? 'homework'}: ${str(fd, 'title')}`, body: str(fd, 'due_date') ? `Due ${str(fd, 'due_date')}` : null, link: '/erp/parent' })));
  }
  go('/erp/homework', needsApproval ? 'Sent to the coordinator for approval.' : `Posted to ${rows.length} section${rows.length > 1 ? 's' : ''}. Parents and students can see it now.`);
}
async function publish(fd: FormData) {
  'use server';
  const ctx = await requireCap('homework', 'write');
  const { error } = await core(ctx.sb).from('class_posts').update({ status: str(fd, 'status') ?? 'published', published_at: new Date().toISOString() }).eq('id', str(fd, 'id')!);
  go('/erp/homework', error ? error.message : 'Updated.', error ? 'err' : 'ok');
}
async function grade(fd: FormData) {
  'use server';
  const ctx = await requireCap('homework', 'write');
  const m = str(fd, 'marks');
  await erp(ctx.sb).from('post_submissions').update({ marks: m ? Number(m) : null, feedback: str(fd, 'feedback') }).eq('id', str(fd, 'id')!);
  go(`/erp/homework?open=${str(fd, 'post')}`, 'Saved.');
}

type P = { id: string; type: string; title: string; body: string | null; due_date: string | null; status: string; staff_id: string | null; section_id: string | null; subject_id: string | null; created_at: string; allow_submission: boolean };
export default async function Homework({ searchParams }: { searchParams: Promise<{ section?: string; tab?: string; open?: string }> }) {
  const sp = await searchParams;
  const ctx = await requireCap('homework');
  const tab = sp.tab ?? 'posts';
  const d = today();
  const mine = ['class_teacher', 'subject_teacher'].includes(ctx.role);
  let pq = core(ctx.sb).from('class_posts').select('id, type, title, body, due_date, status, staff_id, section_id, subject_id, created_at, allow_submission').is('deleted_at', null).order('created_at', { ascending: false }).limit(60);
  if (mine) pq = pq.eq('created_by', ctx.user.id);
  if (sp.section) pq = pq.eq('section_id', sp.section);
  const [sections, subjects, { data: posts }, { data: ta }] = await Promise.all([sectionsFor(ctx), options(ctx, 'subjects'), pq,
    mine && ctx.staff ? core(ctx.sb).from('teacher_allocations').select('section_id').eq('staff_id', ctx.staff.id).is('deleted_at', null) : Promise.resolve({ data: [] })]);
  const own = new Set(((ta ?? []) as { section_id: string }[]).map((t) => t.section_id));
  const secs = [...sections].sort((a, b) => Number(own.has(b.id)) - Number(own.has(a.id)));
  const can = ctx.can('homework', 'write');
  const Ps = (posts ?? []) as P[];
  const lk = await look(ctx, { staff: Ps.map((p) => p.staff_id), sections: Ps.map((p) => p.section_id), subjects: Ps.map((p) => p.subject_id) });
  const canPublish = ctx.canAction('class_posts', 'edit') && !mine;
  return (
    <Page title="Homework and diary" sub="One composer for homework, class notes, circulars to a class and resources.">
      <Tabs current={tab === 'posts' ? '/erp/homework' : `/erp/homework?tab=${tab}`} tabs={[{ href: '/erp/homework', label: 'Posts' }, { href: '/erp/homework?tab=compliance', label: 'Posting compliance' }]} />
      {tab === 'compliance' ? <Compliance ctx={ctx} d={d} /> : (
        <div className="grid gap-4 lg:grid-cols-3">
          {can && <Card title="Post to class"><form action={post} className="space-y-3 p-4">
            <Field label="Type"><select name="type" className="input">{['homework', 'classwork', 'note', 'circular', 'resource', 'diary'].map((t) => <option key={t}>{t}</option>)}</select></Field>
            <Field label="Sections" help="Your own classes are listed first. Hold Ctrl to pick several."><select name="section_id" multiple required size={Math.min(6, Math.max(3, secs.length))} className="input" defaultValue={sp.section ? [sp.section] : []}>{secs.map((s) => <option key={s.id} value={s.id}>{s.name}{own.has(s.id) ? ' · mine' : ''}</option>)}</select></Field>
            <Field label="Subject"><select name="subject_id" className="input"><option value="">—</option>{subjects.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select></Field>
            <Field label="Title"><input name="title" className="input" required /></Field>
            <Field label="Details"><textarea name="body" className="input" rows={4} /></Field>
            <Field label="Link to attachment (optional)"><input name="attachment_link" className="input" placeholder="https://…" /></Field>
            <div className="grid grid-cols-2 gap-2"><Field label="Due date"><input type="date" name="due_date" className="input" min={d} /></Field><Field label="Max marks"><input type="number" name="max_marks" className="input" /></Field></div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="allow_submission" className="h-4 w-4" /> Students submit online</label>
            <button className="btn w-full">Post</button></form></Card>}
          <div className={`space-y-3 ${can ? 'lg:col-span-2' : 'lg:col-span-3'}`}>
            {Ps.length === 0 ? <Card><Empty title="Nothing posted yet" hint="Posts appear in the parent and student apps as soon as they are published." /></Card> : Ps.map((p) => (
              <Card key={p.id}><div className="p-4"><div className="flex flex-wrap items-center gap-2 text-sm"><Badge tone="teal">{p.type}</Badge><span className="font-medium">{p.title}</span><Badge>{p.status}</Badge></div>
                <div className="mt-0.5 text-xs text-muted">{lk.sections.name(p.section_id)} · {p.subject_id ? lk.subjects.name(p.subject_id) : 'General'} · {lk.staff.name(p.staff_id) || 'staff'} · {ftime(p.created_at)}{p.due_date ? ` · due ${fdate(p.due_date)}` : ''}</div>
                {p.body && <p className="mt-2 whitespace-pre-wrap text-sm">{p.body}</p>}
                {p.status === 'pending' && canPublish && <form action={publish} className="mt-2 flex gap-2"><input type="hidden" name="id" value={p.id} /><button name="status" value="published" className="btn btn-sm">Approve and publish</button><button name="status" value="rejected" className="btn-ghost btn-sm">Reject</button></form>}
                {p.allow_submission && <Link className="link mt-2 inline-block text-sm" href={`/erp/homework?open=${p.id}`}>View submissions</Link>}
                {sp.open === p.id && <Submissions ctx={ctx} postId={p.id} can={can} />}</div></Card>))}
          </div>
        </div>)}
    </Page>
  );
}

async function Submissions({ ctx, postId, can }: { ctx: Ctx; postId: string; can: boolean }) {
  const { data } = await erp(ctx.sb).from('post_submissions').select('id, student_id, body, submitted_at, late, marks, feedback').eq('post_id', postId).is('deleted_at', null);
  const rows = (data ?? []) as { id: string; student_id: string; body: string | null; late: boolean; marks: number | null; feedback: string | null }[];
  const st = await lookup(ctx, 'students', rows.map((r) => r.student_id));
  return rows.length === 0 ? <p className="mt-2 text-sm text-muted">No submissions yet.</p> : <ul className="mt-2 divide-y divide-line border-t border-line text-sm">{rows.map((s) => <li key={s.id} className="py-2"><div className="font-medium">{st.name(s.student_id)} {s.late && <Badge tone="amber">late</Badge>}</div><p className="text-muted">{s.body}</p>
    {can && <form action={grade} className="mt-1 flex gap-2"><input type="hidden" name="id" value={s.id} /><input type="hidden" name="post" value={postId} /><input name="marks" type="number" defaultValue={s.marks ?? ''} placeholder="Marks" className="input !w-24 !py-1" aria-label="Marks" /><input name="feedback" defaultValue={s.feedback ?? ''} placeholder="Feedback" className="input !py-1" aria-label="Feedback" /><button className="btn-ghost btn-sm">Save</button></form>}</li>)}</ul>;
}

/** Posting compliance (HW-05): which teachers posted for which sections today. Replaces manual checking. */
async function Compliance({ ctx, d }: { ctx: Ctx; d: string }) {
  const wd = await workingDay(ctx, d);
  const [{ data: tt }, { data: todays }] = await Promise.all([
    core(ctx.sb).from('timetable_entries').select('section_id, staff_id, version:timetable_versions!inner(status)').eq('day', weekday(d)).eq('version.status', 'published').not('staff_id', 'is', null).is('deleted_at', null).limit(3000),
    core(ctx.sb).from('class_posts').select('section_id, staff_id').gte('created_at', d + 'T00:00:00+05:30').is('deleted_at', null),
  ]);
  const T = (tt ?? []) as { section_id: string; staff_id: string }[];
  const lk = await look(ctx, { sections: T.map((t) => t.section_id), staff: T.map((t) => t.staff_id) });
  const posted = new Set(((todays ?? []) as { section_id: string; staff_id: string }[]).map((p) => `${p.section_id}:${p.staff_id}`));
  const seen = new Map<string, { section: string; teacher: string; ok: boolean }>();
  for (const t of T) seen.set(`${t.section_id}:${t.staff_id}`, { section: lk.sections.name(t.section_id), teacher: lk.staff.name(t.staff_id), ok: posted.has(`${t.section_id}:${t.staff_id}`) });
  const rows = [...seen.values()].sort((a, b) => Number(a.ok) - Number(b.ok) || a.section.localeCompare(b.section));
  if (!wd.working) return <Card><Empty title="No posts are expected today" hint={`${wd.reason}. Holidays, weekends and exam days are never counted as misses.`} /></Card>;
  return <Card title={`${rows.filter((r) => r.ok).length} of ${rows.length} teacher-section pairs have posted today`}>{rows.length === 0 ? <Empty title="No timetable for today" hint="Posting expectations come from the timetable." /> : <table className="tbl"><thead><tr><th>Section</th><th>Teacher</th><th>Today</th></tr></thead><tbody>{rows.map((r, i) => <tr key={i}><td>{r.section}</td><td>{r.teacher}</td><td>{r.ok ? <Badge tone="green">posted</Badge> : <Badge tone="amber">not yet</Badge>}</td></tr>)}</tbody></table>}</Card>;
}
