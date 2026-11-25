'use client';
/**
 * One plan in plain language: what will be created / changed / removed, who is affected, what is not possible yet,
 * and the actions (try on sample data, publish, discard, undo). Text comes as i18n keys + values from the server.
 */
import { useState } from 'react';
import type { makeT } from '@autoed/shared';
import { post } from '@/lib/api';
import { Badge, Button, cx } from '@/components/ui';
import type { Changeset, DryRun, Line } from './types';

type T = ReturnType<typeof makeT>;

const STATUS_TONE: Record<Changeset['status'], 'gray' | 'amber' | 'green' | 'blue' | 'red'> = { draft: 'amber', validated: 'blue', published: 'green', reverted: 'gray', rejected: 'gray' };
const OP_TONE = { create: 'green', update: 'blue', delete: 'red' } as const;

export function errorText(t: T, e: unknown): string {
  const code = String((e as { code?: string })?.code ?? 'error').split(':')[0]!;
  const key = `error.${code.replace(/[^a-z0-9_]/gi, '_')}`;
  const msg = t(key);
  return msg === key ? t('error.generic') : msg;
}

export function PlanCard({ cs, t, readOnly, onChanged }: { cs: Changeset; t: T; readOnly: boolean; onChanged: (cs: Changeset) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dry, setDry] = useState<DryRun | null>(null);
  const line = (l: Line) => t(l.messageKey, l.vars);
  const p = cs.preview;

  async function act(name: 'dry-run' | 'publish' | 'discard' | 'revert') {
    setBusy(name);
    setError(null);
    setNotice(null);
    try {
      const r = await post<Record<string, unknown>>(`/designer/changesets/${cs.id}/${name}`);
      if (name === 'dry-run') setDry(r as unknown as DryRun);
      else {
        const status = String(r.status) as Changeset['status'];
        onChanged({ ...cs, status, version: (r.version as number | undefined) ?? cs.version });
        setDry(null);
        setNotice(status === 'published' ? t('designer.published', { version: Number(r.version) }) : status === 'reverted' ? t('designer.reverted') : t('designer.discarded'));
      }
    } catch (e) {
      setError(errorText(t, e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className="rounded-xl border border-slate-200 bg-white shadow-sm" data-testid="plan-card" data-status={cs.status}>
      <header className="flex flex-wrap items-start gap-2 border-b border-slate-100 px-4 py-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-slate-900">{t('designer.plan.title')}</h3>
          <p className="mt-0.5 text-sm text-slate-700">{p.summary}</p>
        </div>
        <Badge tone={STATUS_TONE[cs.status]}>{t(`designer.status.${cs.status}`)}</Badge>
        {cs.version != null && <Badge tone="purple">{t('designer.history.version', { n: cs.version })}</Badge>}
      </header>

      <div className="space-y-3 px-4 py-3">
        {p.ops.length === 0 && <p className="text-sm text-slate-500">{t('designer.plan.empty')}</p>}
        <ol className="space-y-2">
          {p.ops.map((o, i) => (
            <li key={`${o.block}:${o.key}:${i}`} className="rounded-lg border border-slate-100 bg-slate-50 p-3" data-testid="plan-op">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={OP_TONE[o.op]}>{t(`designer.opShort.${o.op}`)}</Badge>
                <span className="text-xs text-slate-500">{t(`designer.block.${o.block}.title`)}</span>
              </div>
              <p className="mt-1 text-sm font-medium text-slate-800">{line(o.title)}</p>
              {o.lines.length > 0 && (
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-slate-700">
                  {o.lines.map((l, j) => (
                    <li key={j}>{line(l)}</li>
                  ))}
                </ul>
              )}
              {o.reason && <p className="mt-1 text-xs italic text-slate-500">{o.reason}</p>}
            </li>
          ))}
        </ol>

        {p.totals.roles.length > 0 && <p className="text-sm text-slate-700">{t('designer.plan.affects', { people: p.totals.people, roles: p.totals.roles.join(', ') })}</p>}
        {p.totals.families > 0 && <p className="text-sm text-slate-700">{t('designer.plan.families', { n: p.totals.families })}</p>}
        {cs.credits > 0 && <p className="text-xs text-slate-500">{t('designer.plan.credits', { n: cs.credits })}</p>}

        {p.unsupported.length > 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" data-testid="plan-unsupported">
            <p className="font-medium">{t('designer.unsupported.title')}</p>
            <ul className="mt-1 list-disc pl-5">
              {p.unsupported.map((u, i) => (
                <li key={i}>
                  <span className="font-medium">{t(`shell.product.${u.product === 'core' ? 'os' : u.product}.short`)}</span> {u.note}
                </li>
              ))}
            </ul>
          </div>
        )}
        {p.questions.length > 0 && (
          <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
            <p className="font-medium">{t('designer.questions.title')}</p>
            <ul className="mt-1 list-disc pl-5">
              {p.questions.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ul>
          </div>
        )}
        {cs.issues.length > 0 && cs.issues.some((i) => i.code !== 'no_changes') && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            <p className="font-medium">{t('designer.issues.title')}</p>
            <ul className="mt-1 list-disc pl-5">
              {cs.issues.map((i, k) => (
                <li key={k}>
                  {t(`designer.issue.${i.code}`)} {i.detail ? <span className="text-xs opacity-75">({i.detail})</span> : null}
                </li>
              ))}
            </ul>
          </div>
        )}

        {dry && (
          <div className={cx('rounded-lg border p-3 text-sm', dry.ok ? 'border-slate-200 bg-white' : 'border-red-200 bg-red-50 text-red-800')} data-testid="dry-run">
            <p className="font-medium">{t('designer.dryRun.title')}</p>
            {!dry.ok && <p>{t('designer.dryRun.failed', { error: errorText(t, { code: dry.error }) })}</p>}
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {dry.ops.flatMap((o) => o.lines.map((l, j) => <li key={`${o.seq}-${j}`}>{line(l)}</li>))}
            </ul>
          </div>
        )}
        {notice && (
          <p role="status" className="rounded-md bg-green-50 p-2 text-sm text-green-800" data-testid="plan-notice">
            {notice}
          </p>
        )}
        {error && (
          <p role="alert" className="rounded-md bg-red-50 p-2 text-sm text-red-700">
            {error}
          </p>
        )}
      </div>

      {!readOnly && (
        <footer className="flex flex-wrap gap-2 border-t border-slate-100 px-4 py-3">
          {(cs.status === 'validated' || cs.status === 'draft') && p.ops.length > 0 && (
            <Button variant="secondary" size="sm" disabled={!!busy} onClick={() => void act('dry-run')}>
              {t('designer.action.dryRun')}
            </Button>
          )}
          {cs.status === 'validated' && (
            <Button size="sm" disabled={!!busy} onClick={() => void act('publish')}>
              {t('designer.action.publish')}
            </Button>
          )}
          {(cs.status === 'validated' || cs.status === 'draft') && (
            <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => void act('discard')}>
              {t('designer.action.discard')}
            </Button>
          )}
          {cs.status === 'published' && (
            <Button variant="danger" size="sm" disabled={!!busy} onClick={() => void act('revert')}>
              {t('designer.action.undo')}
            </Button>
          )}
        </footer>
      )}
    </article>
  );
}
