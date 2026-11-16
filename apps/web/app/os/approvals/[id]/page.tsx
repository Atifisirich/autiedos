'use client';
import { use, useState } from 'react';
import { useApp } from '@/lib/app';
import { post, useApi } from '@/lib/api';
import { useLookups, opts } from '@/lib/lookups';
import { Button, Card, DateText, ErrorBox, Field, Loading, PageHeader, Select, StatusBadge, Textarea, useAction } from '@/components/ui';

export default function ApprovalDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t } = useApp();
  const r = useApi<any>(`/approvals/${id}`);
  const lk = useLookups();
  const a = useAction();
  const [comment, setComment] = useState('');
  const [fwd, setFwd] = useState('');
  if (!r.data) return r.error ? <ErrorBox error={r.error} /> : <Loading />;
  const x = r.data;
  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    if (await a.run(() => post(`/approvals/${id}/action`, { action, comment: comment || null, ...extra }))) {
      setComment('');
      await r.reload();
    }
  };
  return (
    <div>
      <PageHeader title={x.title} subtitle={<span className="flex items-center gap-2"><StatusBadge status={x.status} />{x.applicant_name} · {x.type_name}</span>} />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title={t('approvals.details')}>
            <dl className="grid grid-cols-2 gap-2 text-sm">
              {Object.entries(x.data).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-slate-500">{(x.form_schema ?? []).find((f: any) => f.key === k)?.label ?? k}</dt>
                  <dd>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
                </div>
              ))}
            </dl>
          </Card>
          <Card title={t('approvals.chain')}>
            <ol className="space-y-1 text-sm">
              {x.chain.map((s: any, i: number) => (
                <li key={i} className={i + 1 === x.current_seq && x.status === 'pending' ? 'font-semibold text-brand-700' : ''}>
                  {i + 1}. {s.approvers.join(', ')} <span className="text-xs text-slate-500">({t('approvals.limitHours', { n: s.timeLimitHours })})</span>
                </li>
              ))}
            </ol>
          </Card>
          <Card title={t('tasks.history')}>
            <ol className="space-y-1 text-sm">
              {x.actions.map((h: any) => (
                <li key={h.id}>
                  <DateText value={h.created_at} withTime /> · {h.actor_name ?? t('common.system')} · {t(`approvalAction.${h.action}`)}
                  {h.forwarded_name && ` → ${h.forwarded_name}`}
                  {h.comment && <div className="pl-4 text-slate-600">“{h.comment}”</div>}
                </li>
              ))}
            </ol>
          </Card>
        </div>
        <Card title={t('tasks.actions')}>
          <div className="space-y-3">
            <Field label={t('approvals.comment')}><Textarea value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
            {x.can_act && (
              <div className="flex flex-wrap gap-2">
                <Button disabled={a.busy} onClick={() => act('approve')}>{t('approvalAction.approve')}</Button>
                <Button variant="danger" disabled={a.busy} onClick={() => act('reject')}>{t('approvalAction.reject')}</Button>
                <Button variant="secondary" disabled={a.busy} onClick={() => act('return')}>{t('approvalAction.return')}</Button>
              </div>
            )}
            {x.can_act && (
              <div className="flex gap-2">
                <Select value={fwd} onChange={(e) => setFwd(e.target.value)} placeholder={t('approvals.forwardTo')} options={opts(lk?.staff, (s) => s.full_name)} />
                <Button variant="secondary" disabled={!fwd || a.busy} onClick={() => act('forward', { forward_to: fwd })}>{t('approvalAction.forward')}</Button>
              </div>
            )}
            {x.is_applicant && x.status === 'returned' && <Button onClick={() => act('resubmit')}>{t('approvalAction.resubmit')}</Button>}
            {x.is_applicant && ['pending', 'returned'].includes(x.status) && <Button variant="secondary" onClick={() => act('cancel')}>{t('approvalAction.cancel')}</Button>}
            <ErrorBox error={a.error} />
          </div>
        </Card>
      </div>
    </div>
  );
}
