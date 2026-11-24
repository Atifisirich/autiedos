'use client';
import { use, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { answeredCount, clock, friendlyError, loadTestQuestions, loadTests, makeSwitchCounter, secondsLeft, submitTest, testWindow, type TestQuestion } from '@autoed/shared/erp-portal';
import { usePortal } from '@/lib/erp-portal/session';
import { Btn, Card, Notice, PageHead, Spinner, cx } from '@/components/erp-portal/ui';

type Phase = 'loading' | 'ready' | 'running' | 'done' | 'closed' | 'error';

/**
 * An online or diagnostic test. The questions come from erp.get_test_questions (no correct answers in them) and are not saved on
 * the device; the answers go to erp.submit_test, which scores them in the database. While the test runs, every time the student
 * leaves the page (another tab, another app, a locked screen) is counted and sent with the answers, so the teacher can see it.
 */
export default function TestRunner({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { sb, child, L } = usePortal();
  const [phase, setPhase] = useState<Phase>('loading');
  const [title, setTitle] = useState('');
  const [duration, setDuration] = useState(0);
  const [qs, setQs] = useState<TestQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [startedAt, setStartedAt] = useState(0);
  const [left, setLeft] = useState(0);
  const [switches, setSwitches] = useState(0);
  const [result, setResult] = useState<{ score: number; max: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [timeUp, setTimeUp] = useState(false);
  const counter = useRef(makeSwitchCounter());
  const submitting = useRef(false);

  useEffect(() => {
    if (!sb || !child) return;
    let alive = true;
    void (async () => {
      try {
        const d = await loadTests(sb, child.id);
        const t = d.tests.find((x) => x.id === id);
        if (!t || testWindow(t) !== 'open' || d.attempts[id]?.submitted_at) { if (alive) setPhase('closed'); return; }
        const questions = await loadTestQuestions(sb, id);
        if (!alive) return;
        setTitle(t.title); setDuration(t.duration_min ?? 0); setQs(questions); setPhase('ready');
      } catch (e) { if (alive) { setError(friendlyError(e, L('c.error'))); setPhase('error'); } }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a language switch must not reload (and re-shuffle) the questions
  }, [sb, child, id]);

  const finish = useCallback(async (auto: boolean) => {
    if (!sb || !child || submitting.current) return;
    submitting.current = true;
    try {
      setResult(await submitTest(sb, id, child.id, answers, counter.current.count));
      setTimeUp(auto); setPhase('done');
    } catch (e) { setError(friendlyError(e, L('c.error'))); submitting.current = false; }
  }, [sb, child, id, answers, L]);

  // timer
  useEffect(() => {
    if (phase !== 'running' || !duration) return;
    const t = setInterval(() => { const s = secondsLeft(startedAt, duration, Date.now()); setLeft(s); if (s <= 0) void finish(true); }, 1000);
    return () => clearInterval(t);
  }, [phase, duration, startedAt, finish]);

  // tab switches: counted once per time the page is hidden or the window loses focus, only while the test runs
  useEffect(() => {
    if (phase !== 'running') return;
    const c = counter.current;
    const hide = () => { c.hide(); setSwitches(c.count); };
    const show = () => c.show();
    const vis = () => (document.visibilityState === 'hidden' ? hide() : show());
    document.addEventListener('visibilitychange', vis);
    window.addEventListener('blur', hide);
    window.addEventListener('focus', show);
    return () => { document.removeEventListener('visibilitychange', vis); window.removeEventListener('blur', hide); window.removeEventListener('focus', show); };
  }, [phase]);

  const start = () => { setStartedAt(Date.now()); setLeft(duration * 60); setPhase('running'); };
  const unanswered = qs.length - answeredCount(qs, answers);
  const set = (qid: string, v: string) => setAnswers((a) => ({ ...a, [qid]: v }));

  if (phase === 'loading') return <Spinner label={L('c.loading')} />;
  return (
    <>
      <p className="mb-2"><Link href="/erp/student/tests" className="text-base text-[var(--pt-primary)] underline">‹ {L('nav.tests')}</Link></p>
      {phase === 'closed' && <Card><Notice>{L('tests.none')}</Notice></Card>}
      {phase === 'error' && <Card><Notice tone="bad">{error}</Notice></Card>}
      {phase === 'ready' && (
        <div className="space-y-4">
          <PageHead title={title} sub={duration ? L('tests.minutes', { n: duration }) : undefined} />
          <Card>
            <Notice tone="warn">{L('tests.rules')}</Notice>
            {qs.length === 0 ? <p className="mt-3 text-base">{L('tests.noQuestions')}</p> : <div className="mt-3"><Btn onClick={start}>{L('tests.start')}</Btn></div>}
          </Card>
        </div>
      )}
      {phase === 'running' && (
        <div className="space-y-4">
          <div className="sticky top-0 z-30 -mx-4 flex items-center justify-between gap-2 border-b border-slate-200 bg-white px-4 py-2">
            <div><div className="text-base font-semibold">{title}</div><div className="text-sm text-slate-700">{L('tests.answered', { n: answeredCount(qs, answers), total: qs.length })}</div></div>
            <div className="text-right">{duration > 0 && <div className={cx('text-xl font-bold tabular-nums', left < 60 && 'text-red-800')} role="timer" aria-live="off" data-testid="timer">{clock(left)}</div>}{switches > 0 && <div className="text-sm text-amber-900" data-testid="switches">{L('tests.switches', { n: switches })}</div>}</div>
          </div>
          <form onSubmit={(e) => { e.preventDefault(); if (unanswered > 0 && !window.confirm(L('tests.confirm', { n: unanswered }))) return; void finish(false); }} className="space-y-4">
            {qs.map((q, i) => (
              <Card key={q.id}>
                <fieldset>
                  <legend className="mb-2 text-base font-semibold text-slate-900">{i + 1}. {q.question} <span className="text-sm font-normal text-slate-700">({L('tests.marks', { n: q.marks })})</span></legend>
                  {q.options && q.options.length > 0 ? (
                    <div className="space-y-1">
                      {q.options.map((o) => (
                        <label key={o} className="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border-2 border-slate-200 px-3 text-base has-[:checked]:border-[var(--pt-primary)]">
                          <input type="radio" name={q.id} value={o} checked={answers[q.id] === o} onChange={() => set(q.id, o)} className="h-5 w-5 accent-[var(--pt-primary)]" />{o}
                        </label>
                      ))}
                    </div>
                  ) : <input aria-label={L('tests.typeAnswer')} placeholder={L('tests.typeAnswer')} value={answers[q.id] ?? ''} onChange={(e) => set(q.id, e.target.value)} className="min-h-12 w-full rounded-xl border-2 border-slate-300 px-3 text-base" />}
                </fieldset>
              </Card>
            ))}
            {error && <Notice tone="bad">{error}</Notice>}
            <Btn type="submit" className="w-full">{L('tests.submit')}</Btn>
          </form>
        </div>
      )}
      {phase === 'done' && result && (
        <Card title={L('tests.result')}>
          {timeUp && <Notice tone="warn">{L('tests.timeUp')}</Notice>}
          <p className="mt-2 text-2xl font-bold text-slate-900" data-testid="test-score">{L('tests.score', { score: result.score, max: result.max })}</p>
          <div className="mt-3"><Link href="/erp/student/tests" className="text-base text-[var(--pt-primary)] underline">{L('nav.tests')}</Link></div>
        </Card>
      )}
    </>
  );
}
