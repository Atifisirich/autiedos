'use client';
import { useState } from 'react';
import { childName, fmtDate, friendlyError, istToday, loadHomework, submitHomework, type Child, type Post } from '@autoed/shared/erp-portal';
import { usePortal } from '@/lib/erp-portal/session';
import { useLoad } from '@/lib/erp-portal/use-load';
import { Badge, Btn, Card, Empty, Notice, PageHead, Textarea } from './ui';
import { WithData } from './screen';

/** Homework, notes and circulars of a child's class, with submission; used by the parent and the student portal. */
export function HomeworkList({ child }: { child: Child }) {
  const { sb, org, L, lang } = usePortal();
  const today = istToday();
  const q = useLoad('homework', () => loadHomework(sb!, child), [child.id], { childScoped: true });
  const [open, setOpen] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(p: Post) {
    if (!org || !text.trim()) return;
    setBusy(true); setError(null);
    try {
      await submitHomework(sb!, org.id, p, child.id, text.trim(), today);
      setOpen(null); setText('');
      await q.reload();
    } catch (e) {
      setError(friendlyError(e, L('c.error')));
    } finally { setBusy(false); }
  }

  return (
    <>
      <PageHead title={L('homework.title')} sub={childName(child)} />
      <WithData q={q}>
        {(d) => d.posts.length === 0 ? <Card><Empty title={L('homework.none')} /></Card> : (
          <ul className="space-y-3">
            {d.posts.map((p) => {
              const sub = d.submissions[p.id];
              const overdue = p.due_date && p.due_date < today && !sub;
              return (
                <li key={p.id}>
                  <Card>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="info">{L(`homework.type.${p.type}`)}</Badge>
                      <h2 className="text-base font-semibold text-slate-900">{p.title}</h2>
                      {p.due_date && <span className={`text-sm ${overdue ? 'font-semibold text-red-800' : 'text-slate-700'}`}>{L('homework.due', { date: fmtDate(p.due_date, lang) })}</span>}
                    </div>
                    <div className="text-sm text-slate-700">{(p.subject_id && d.subjects[p.subject_id]) || L('homework.general')}{p.published_at ? ` · ${fmtDate(p.published_at, lang)}` : ''}</div>
                    {p.body && <p className="mt-2 whitespace-pre-wrap text-base text-slate-900">{p.body}</p>}
                    {sub && (
                      <div className="mt-3 rounded-xl bg-emerald-50 p-3 text-base">
                        <p className="font-medium text-emerald-950">{L('homework.submitted')}{sub.late ? ` (${L('homework.late')})` : ''} · {fmtDate(sub.submitted_at, lang)}</p>
                        {sub.marks !== null && <p>{L('homework.marks', { marks: `${sub.marks}${p.max_marks ? ` / ${p.max_marks}` : ''}` })}</p>}
                        {sub.feedback && <p><strong>{L('homework.feedback')}: </strong>{sub.feedback}</p>}
                      </div>
                    )}
                    {p.allow_submission && !sub && (
                      open === p.id ? (
                        <div className="mt-3 space-y-2">
                          <Textarea label={L('homework.yourAnswer')} value={text} onChange={(e) => setText(e.target.value)} />
                          {error && <Notice tone="bad">{error}</Notice>}
                          <div className="flex gap-2"><Btn disabled={busy || !text.trim()} onClick={() => void submit(p)}>{L('homework.submit')}</Btn><Btn variant="ghost" onClick={() => setOpen(null)}>{L('c.cancel')}</Btn></div>
                        </div>
                      ) : <div className="mt-3"><Btn variant="secondary" onClick={() => { setOpen(p.id); setText(''); setError(null); }}>{L('homework.submit')}</Btn></div>
                    )}
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </WithData>
    </>
  );
}
