'use client';
import { use, useEffect, useState } from 'react';
import { useApp } from '@/lib/app';
import { post, useApi } from '@/lib/api';
import { FileLink } from '@/components/files';
import { Badge, Button, Card, DateText, ErrorBox, Field, Input, Loading, PageHeader, Select, Table, useAction } from '@/components/ui';

export default function CircularDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t } = useApp();
  const c = useApi<any>(`/circulars/${id}`);
  const a = useAction();
  const [choice, setChoice] = useState('');
  const [comment, setComment] = useState('');
  useEffect(() => {
    if (c.data?.mine && !c.data.mine.read_at) post(`/circulars/${id}/respond`, { action: 'read' }).catch(() => undefined);
  }, [c.data, id]);
  if (!c.data) return c.error ? <ErrorBox error={c.error} /> : <Loading />;
  const x = c.data;
  return (
    <div>
      <PageHeader title={x.title} subtitle={<>{x.important && <Badge tone="red">{t('circulars.important')}</Badge>} {x.author_name} · <DateText value={x.sent_at ?? x.created_at} withTime /></>} />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <p className="whitespace-pre-wrap text-sm">{x.body}</p>
            {(x.attachments ?? []).length > 0 && <ul className="mt-3 list-disc pl-5 text-sm">{x.attachments.map((f: any) => <li key={f.path}><FileLink path={f.path} name={f.name} /></li>)}</ul>}
          </Card>
          {x.mine && x.response_mode === 'acknowledge' && !x.mine.acknowledged_at && <Button onClick={async () => (await a.run(() => post(`/circulars/${id}/respond`, { action: 'acknowledge' }))) && c.reload()}>{t('circulars.acknowledge')}</Button>}
          {x.mine && x.response_mode === 'reply' && !x.mine.reply && (
            <Card title={x.reply_form?.question}>
              <div className="flex flex-wrap items-end gap-2">
                <Field label={t('circulars.answer')}><Select value={choice} onChange={(e) => setChoice(e.target.value)} placeholder={t('common.choose')} options={(x.reply_form?.options ?? []).map((o: string) => ({ value: o, label: o }))} /></Field>
                <Field label={t('approvals.comment')}><Input value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
                <Button disabled={!choice} onClick={async () => (await a.run(() => post(`/circulars/${id}/respond`, { action: 'reply', reply: { choice, comment: comment || undefined } }))) && c.reload()}>{t('common.submit')}</Button>
              </div>
            </Card>
          )}
          {x.mine?.acknowledged_at && <p className="text-sm text-green-700">{t('circulars.youAcknowledged')}</p>}
          {x.mine?.reply && <p className="text-sm text-green-700">{t('circulars.youReplied', { choice: x.mine.reply.choice })}</p>}
          <ErrorBox error={a.error} />
        </div>
        {x.receipts.length > 0 && (
          <Card title={t('circulars.receipts', { read: x.receipts.filter((r: any) => r.read_at).length, total: x.receipts.length })}>
            <Table rows={x.receipts} rowKey={(r) => r.staff_id} columns={[{ key: 'full_name', header: t('common.person') }, { key: 'read_at', header: t('circulars.read'), render: (r) => (r.read_at ? <DateText value={r.read_at} withTime /> : '—') }, { key: 'ack', header: t('circulars.acknowledged'), render: (r) => (r.acknowledged_at ? '✓' : r.reply ? r.reply.choice : '—') }]} />
          </Card>
        )}
      </div>
    </div>
  );
}
