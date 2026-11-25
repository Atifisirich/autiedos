'use client';
/**
 * AI school designer page (DECISIONS 56-59). A chat-style thread: the person types what should happen (or picks an
 * example or a template), AutoEd answers with a plan in plain language, which can be tried on sample data, published
 * and undone. Tabs: design, templates, history (with undo), "explain my school".
 *
 * Who sees it: the school's management; and AutoEd staff, who first open a time-limited support session with a reason
 * (x-view-as header, kept for this tab only). Everyone else gets a polite refusal. The server enforces all of it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { LANGUAGES, LANGUAGE_NAMES, isLang, type Lang } from '@autoed/shared';
import { get, post, setApiContext, setViewAs } from '@/lib/api';
import { useShellLang } from '@/components/shell';
import { Badge, Button, Card, Field, Input, Select, Tabs, Textarea } from '@/components/ui';
import { PlanCard, errorText } from './plan-card';
import type { Changeset, HistoryRow, Line, TemplateView, Who } from './types';

const EXAMPLES = ['designer.example.absence', 'designer.example.checklist', 'designer.example.purchase', 'designer.example.fee', 'designer.example.enquiry'] as const;

type Turn = { kind: 'user'; text: string } | { kind: 'plan'; cs: Changeset };

export function DesignerApp() {
  const [who, setWho] = useState<Who | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { t, lang, setLang } = useShellLang(null, isLang(who?.lang) ? who.lang : null);
  const [tab, setTab] = useState('design');

  const loadWho = useCallback(async () => {
    try {
      setWho(await get<Who>('/designer/whoami'));
    } catch (e) {
      setLoadError((e as { code?: string }).code ?? 'error');
    }
  }, []);
  useEffect(() => {
    void loadWho();
  }, [loadWho]);
  useEffect(() => {
    setApiContext(who?.branch_id ?? null, lang);
  }, [who?.branch_id, lang]);

  const header = (
    <header className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-3 py-2 sm:px-6">
      <Link href="/" className="min-h-[36px] rounded-md px-2 py-1.5 text-sm text-slate-600 hover:bg-slate-100">
        {t('shell.switcher.allProducts')}
      </Link>
      <span aria-hidden className="text-slate-300">
        /
      </span>
      <span className="text-sm font-semibold text-slate-800">{t('designer.title')}</span>
      {who?.org && <span className="truncate text-xs text-slate-500">{who.org.name}</span>}
      <div className="flex-1" />
      <select aria-label={t('settings.language')} value={lang} onChange={(e) => setLang(e.target.value as Lang)} className="min-h-[36px] rounded-md border border-slate-300 bg-white px-2 text-sm">
        {LANGUAGES.map((l) => (
          <option key={l} value={l}>
            {LANGUAGE_NAMES[l]}
          </option>
        ))}
      </select>
    </header>
  );

  if (!who) {
    return (
      <>
        {header}
        <p role="status" className="p-10 text-center text-sm text-slate-500">
          {loadError ? errorText(t, { code: loadError }) : t('common.loading')}
        </p>
      </>
    );
  }
  if (who.kind === 'none') {
    return (
      <>
        {header}
        <main className="mx-auto max-w-lg p-8 text-center">
          <h1 className="text-xl font-semibold text-slate-800">{t('designer.title')}</h1>
          <p className="mt-2 text-sm text-slate-600" data-testid="designer-denied">
            {t('designer.denied')}
          </p>
        </main>
      </>
    );
  }
  if (who.kind === 'platform') {
    return (
      <>
        {header}
        <SupportSessionForm t={t} onOpened={() => void loadWho()} />
      </>
    );
  }
  const readOnly = !!who.read_only;
  return (
    <>
      {header}
      <main className="mx-auto w-full max-w-5xl p-3 sm:p-6">
        {who.kind === 'relationship_manager' && (
          <div role="status" className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-purple-200 bg-purple-50 p-2 text-sm text-purple-800">
            <span>{t('designer.rm.banner', { org: who.org?.name ?? '' })}</span>
            <Button
              size="sm"
              variant="secondary"
              onClick={async () => {
                await post('/designer/support-session/end').catch(() => undefined);
                setViewAs(null);
                setWho(null);
                void loadWho();
              }}
            >
              {t('designer.rm.end')}
            </Button>
          </div>
        )}
        {readOnly && <p className="mb-3 rounded-md bg-amber-50 p-2 text-sm text-amber-800">{t('designer.readOnly')}</p>}
        <h1 className="text-xl font-semibold text-slate-900">{t('designer.title')}</h1>
        <p className="mb-4 mt-1 text-sm text-slate-600">{t('designer.subtitle')}</p>
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'design', label: t('designer.tab.design') },
            { value: 'templates', label: t('designer.tab.templates') },
            { value: 'history', label: t('designer.tab.history') },
            { value: 'explain', label: t('designer.tab.explain') },
          ]}
        />
        {tab === 'design' && <DesignTab t={t} readOnly={readOnly} />}
        {tab === 'templates' && <TemplatesTab t={t} readOnly={readOnly} onPlanned={() => setTab('design')} />}
        {tab === 'history' && <HistoryTab t={t} readOnly={readOnly} />}
        {tab === 'explain' && <ExplainTab t={t} />}
      </main>
    </>
  );
}

type T = ReturnType<typeof useShellLang>['t'];

// ---------------------------------------------------------------- design: the conversation
let thread: Turn[] = [];
const listeners = new Set<() => void>();
function pushTurn(turn: Turn) {
  thread = [...thread, turn];
  listeners.forEach((l) => l());
}
function replacePlan(cs: Changeset) {
  thread = thread.map((x) => (x.kind === 'plan' && x.cs.id === cs.id ? { kind: 'plan', cs } : x));
  listeners.forEach((l) => l());
}

function useThread() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return thread;
}

function DesignTab({ t, readOnly }: { t: T; readOnly: boolean }) {
  const turns = useThread();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    end.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' });
  }, [turns.length, busy]);

  async function send(prompt: string) {
    const p = prompt.trim();
    if (p.length < 3 || busy) return;
    setBusy(true);
    setError(null);
    pushTurn({ kind: 'user', text: p });
    setText('');
    try {
      pushTurn({ kind: 'plan', cs: await post<Changeset>('/designer/plan', { prompt: p }) });
    } catch (e) {
      setError(errorText(t, e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-4">
      <div className="space-y-3" aria-live="polite">
        {turns.map((turn, i) =>
          turn.kind === 'user' ? (
            <div key={i} className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-brand-600 px-4 py-2 text-sm text-white" data-testid="user-turn">
                <span className="sr-only">{t('designer.you')}: </span>
                {turn.text}
              </div>
            </div>
          ) : (
            <div key={turn.cs.id} className="max-w-full sm:max-w-[92%]">
              <PlanCard cs={turn.cs} t={t} readOnly={readOnly} onChanged={replacePlan} />
            </div>
          ),
        )}
        {busy && (
          <p role="status" className="text-sm text-slate-500">
            {t('designer.working')}
          </p>
        )}
        <div ref={end} />
      </div>
      {error && (
        <p role="alert" className="rounded-md bg-red-50 p-2 text-sm text-red-700">
          {error}
        </p>
      )}
      {!readOnly && (
        <Card>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send(text);
            }}
            className="space-y-3"
          >
            <Field label={t('designer.prompt.label')} hint={t('designer.prompt.cost')}>
              <Textarea
                name="prompt"
                rows={3}
                value={text}
                maxLength={2000}
                placeholder={t('designer.prompt.placeholder')}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send(text);
                }}
              />
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" disabled={busy || text.trim().length < 3} data-testid="designer-send">
                {busy ? t('designer.working') : t('designer.prompt.send')}
              </Button>
            </div>
            <div>
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">{t('designer.examples.title')}</p>
              <div className="flex flex-wrap gap-2">
                {EXAMPLES.map((k) => (
                  <button key={k} type="button" onClick={() => setText(t(k))} className="min-h-[36px] rounded-full border border-slate-300 bg-white px-3 py-1 text-left text-xs text-slate-700 hover:border-brand-500 hover:text-brand-700">
                    {t(k)}
                  </button>
                ))}
              </div>
            </div>
          </form>
        </Card>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- templates
function TemplatesTab({ t, readOnly, onPlanned }: { t: T; readOnly: boolean; onPlanned: () => void }) {
  const [list, setList] = useState<TemplateView[] | null>(null);
  const [params, setParams] = useState<Record<string, Record<string, unknown>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    get<TemplateView[]>('/designer/templates').then(setList, (e) => setError(errorText(t, e)));
  }, [t]);
  const value = (tk: string, p: TemplateView['params'][number]) => params[tk]?.[p.key] ?? p.default;
  async function use(tpl: TemplateView) {
    setBusy(tpl.key);
    setError(null);
    try {
      const cs = await post<Changeset>(`/designer/templates/${tpl.key}/plan`, { params: params[tpl.key] ?? {} });
      pushTurn({ kind: 'user', text: t(`designer.template.${tpl.key}.title`) });
      pushTurn({ kind: 'plan', cs });
      onPlanned();
    } catch (e) {
      setError(errorText(t, e));
    } finally {
      setBusy(null);
    }
  }
  return (
    <section>
      {error && (
        <p role="alert" className="mb-3 rounded-md bg-red-50 p-2 text-sm text-red-700">
          {error}
        </p>
      )}
      <ul className="grid gap-3 md:grid-cols-2">
        {(list ?? []).map((tpl) => (
          <li key={tpl.key} className="flex flex-col rounded-xl border border-slate-200 bg-white p-4 shadow-sm" data-testid="template">
            <div className="flex items-start gap-2">
              <h3 className="flex-1 text-sm font-semibold text-slate-900">{t(`designer.template.${tpl.key}.title`)}</h3>
              <Badge tone="blue">{t(`shell.product.${tpl.product === 'core' ? 'os' : tpl.product}.short`)}</Badge>
            </div>
            <p className="mt-1 text-sm text-slate-600">{t(`designer.template.${tpl.key}.description`)}</p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {tpl.params.map((p) => (
                <Field key={p.key} label={t(p.labelKey)}>
                  {p.type === 'boolean' ? (
                    <Select
                      value={String(value(tpl.key, p))}
                      onChange={(e) => setParams({ ...params, [tpl.key]: { ...params[tpl.key], [p.key]: e.target.value === 'true' } })}
                      options={[
                        { value: 'true', label: t('common.yes') },
                        { value: 'false', label: t('common.no') },
                      ]}
                    />
                  ) : (
                    <Input
                      type={p.type === 'number' ? 'number' : p.type === 'time' ? 'time' : 'text'}
                      value={String(value(tpl.key, p) ?? '')}
                      onChange={(e) => setParams({ ...params, [tpl.key]: { ...params[tpl.key], [p.key]: p.type === 'number' ? Number(e.target.value) : e.target.value } })}
                    />
                  )}
                </Field>
              ))}
            </div>
            <div className="mt-3 flex-1" />
            {tpl.available ? (
              !readOnly && (
                <Button size="sm" className="self-start" disabled={!!busy} onClick={() => void use(tpl)}>
                  {t('designer.templates.use')}
                </Button>
              )
            ) : (
              <span className="text-xs text-slate-500">{t('designer.templates.unavailable')}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------- history
function HistoryTab({ t, readOnly }: { t: T; readOnly: boolean }) {
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Changeset | null>(null);
  const load = useCallback(() => get<HistoryRow[]>('/designer/changesets').then(setRows, (e) => setError(errorText(t, e))), [t]);
  useEffect(() => {
    void load();
  }, [load]);
  if (open)
    return (
      <section className="space-y-3">
        <Button variant="secondary" size="sm" onClick={() => (setOpen(null), void load())}>
          {t('common.back')}
        </Button>
        <PlanCard cs={open} t={t} readOnly={readOnly} onChanged={(cs) => (setOpen(cs), replacePlan(cs))} />
      </section>
    );
  return (
    <section>
      {error && (
        <p role="alert" className="mb-3 rounded-md bg-red-50 p-2 text-sm text-red-700">
          {error}
        </p>
      )}
      {rows && rows.length === 0 && <p className="text-sm text-slate-500">{t('designer.history.empty')}</p>}
      <ul className="space-y-2">
        {(rows ?? []).map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white p-3" data-testid="history-row" data-status={r.status}>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-slate-800">{r.summary ?? r.prompt}</p>
              <p className="text-xs text-slate-500">
                {new Date(r.created_at).toLocaleString()} · {t(`designer.author.${r.author_kind}`)}
              </p>
            </div>
            {r.version != null && <Badge tone="purple">{t('designer.history.version', { n: r.version })}</Badge>}
            <Badge tone={r.status === 'published' ? 'green' : r.status === 'draft' ? 'amber' : r.status === 'validated' ? 'blue' : 'gray'}>{t(`designer.status.${r.status}`)}</Badge>
            <Button size="sm" variant="secondary" onClick={async () => setOpen(await get<Changeset>(`/designer/changesets/${r.id}`))}>
              {t('designer.action.open')}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------- explain my school
function ExplainTab({ t }: { t: T }) {
  const [lines, setLines] = useState<Line[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    get<{ lines: Line[] }>('/designer/explain').then((r) => setLines(r.lines), (e) => setError(errorText(t, e)));
  }, [t]);
  return (
    <Card title={t('designer.explain.title')}>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {!lines && !error && <p className="text-sm text-slate-500">{t('common.loading')}</p>}
      <ul className="space-y-2" data-testid="explain">
        {(lines ?? []).map((l, i) => (
          <li key={i} className="text-sm text-slate-700">
            {t(l.messageKey, l.vars)}
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ---------------------------------------------------------------- AutoEd relationship managers
function SupportSessionForm({ t, onOpened }: { t: T; onOpened: () => void }) {
  const [clients, setClients] = useState<{ id: string; name: string }[]>([]);
  const [org, setOrg] = useState('');
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState(60);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    get<{ id: string; name: string }[]>('/designer/clients').then(setClients, (e) => setError(errorText(t, e)));
  }, [t]);
  return (
    <main className="mx-auto max-w-lg p-4 sm:p-8">
      <Card title={t('designer.rm.title')}>
        <p className="mb-3 text-sm text-slate-600">{t('designer.rm.body')}</p>
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              const s = await post<{ session_id: string }>('/designer/support-session', { org_id: org, reason, minutes });
              setViewAs(s.session_id);
              onOpened();
            } catch (err) {
              setError(errorText(t, err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label={t('designer.rm.client')}>
            <Select value={org} onChange={(e) => setOrg(e.target.value)} placeholder="" options={clients.map((c) => ({ value: c.id, label: c.name }))} />
          </Field>
          <Field label={t('designer.rm.reason')}>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          </Field>
          <Field label={t('designer.rm.minutes')}>
            <Input type="number" min={5} max={240} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} />
          </Field>
          {error && (
            <p role="alert" className="text-sm text-red-700">
              {error}
            </p>
          )}
          <Button type="submit" disabled={busy || !org || reason.trim().length < 10}>
            {t('designer.rm.start')}
          </Button>
        </form>
      </Card>
    </main>
  );
}
