'use client';
import { use, useState } from 'react';
import Link from 'next/link';
import { useApp } from '@/lib/app';
import { post, uploadFile, useApi } from '@/lib/api';
import { useLookups, opts } from '@/lib/lookups';
import { Badge, Button, Card, DateText, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, StatusBadge, Textarea, useAction } from '@/components/ui';

export default function TaskDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t } = useApp();
  const task = useApi<any>(`/tasks/${id}`);
  const lk = useLookups();
  const a = useAction();
  const [modal, setModal] = useState<null | 'complete' | 'block' | 'not_done' | 'reopen' | 'delegate' | 'extension' | 'due'>(null);
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [who, setWho] = useState('');
  const [due, setDue] = useState('');
  const [comment, setComment] = useState('');
  if (!task.data) return task.error ? <ErrorBox error={task.error} /> : <Loading />;
  const x = task.data;
  const roles: string[] = x.my_roles ?? [];
  const owner = roles.includes('owner');
  const boss = roles.includes('assigner') || roles.includes('above_assigner');
  const open = ['todo', 'in_progress', 'blocked', 'reopened'].includes(x.status);

  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    const r = await a.run(() => post(`/tasks/${id}/action`, { action, ...extra }));
    if (r) {
      setModal(null);
      setNote('');
      setReason('');
      setFile(null);
      await task.reload();
    }
  };

  return (
    <div>
      <PageHeader title={x.title} subtitle={<span className="flex flex-wrap items-center gap-2"><StatusBadge status={x.status} />{x.overdue && <Badge tone="red">{t('tasks.overdue')}</Badge>}<Badge>{t(`priority.${x.priority}`)}</Badge><Badge>{t(`source.${x.source}`)}</Badge></span>} />
      <ErrorBox error={a.error} />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title={t('tasks.details')}>
            {x.description && <p className="mb-3 whitespace-pre-line text-sm">{x.description}</p>}
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <dt className="text-slate-500">{t('tasks.owner')}</dt>
              <dd>{x.owner_name ?? '—'}</dd>
              <dt className="text-slate-500">{t('tasks.assigner')}</dt>
              <dd>{x.assigner_name ?? '—'}</dd>
              <dt className="text-slate-500">{t('tasks.due')}</dt>
              <dd>
                <DateText value={x.due_at} withTime />
              </dd>
              <dt className="text-slate-500">{t('tasks.proof')}</dt>
              <dd>
                {t(`proof.${x.proof_required}`)}
                {x.verification_required && ` · ${t('tasks.verificationRequired')}`}
              </dd>
              {x.linked_type && (
                <>
                  <dt className="text-slate-500">{t('tasks.linked')}</dt>
                  <dd>{t(`linked.${x.linked_type}`)}</dd>
                </>
              )}
            </dl>
          </Card>
          {x.children?.length > 0 && (
            <Card title={x.is_group_parent ? t('tasks.groupProgress', { done: x.child_done, total: x.child_count }) : t('tasks.subtasks')}>
              <ul className="space-y-1 text-sm">
                {x.children.map((c: any) => (
                  <li key={c.id} className="flex items-center gap-2">
                    <StatusBadge status={c.status} />
                    <Link href={`/os/tasks/${c.id}`} className="hover:underline">
                      {c.owner_name ? `${c.owner_name} · ` : ''}
                      {c.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Card title={t('tasks.comments')}>
            <ul className="mb-3 space-y-2 text-sm">
              {x.comments.map((c: any) => (
                <li key={c.id} className="rounded-md bg-slate-50 p-2">
                  <div className="text-xs text-slate-500">
                    {c.author_name} · <DateText value={c.created_at} withTime /> {c.kind !== 'comment' && <Badge>{t(`commentKind.${c.kind}`)}</Badge>}
                  </div>
                  <p className="whitespace-pre-line">{c.body}</p>
                  {!c.converted_task_id && (owner || boss) && (
                    <button className="text-xs text-brand-700" onClick={async () => (await a.run(() => post(`/task-comments/${c.id}/subtask`)), task.reload())}>
                      {t('tasks.toSubtask')}
                    </button>
                  )}
                </li>
              ))}
            </ul>
            <form
              className="flex gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                const mentions = (lk?.staff ?? []).filter((s) => comment.includes(`@${s.full_name}`)).map((s) => s.id);
                const r = await a.run(() => post(`/tasks/${id}/comments`, { body: comment, kind: 'comment', mentions }));
                if (r) { setComment(''); task.reload(); }
              }}
            >
              <Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t('tasks.commentPlaceholder')} aria-label={t('tasks.comments')} />
              <Button disabled={!comment.trim()}>{t('common.send')}</Button>
            </form>
          </Card>
          <Card title={t('tasks.history')}>
            <ol className="space-y-1 text-xs text-slate-600">
              {x.events.map((e: any) => (
                <li key={e.id}>
                  <DateText value={e.created_at} withTime /> · {e.actor_name ?? t('common.system')} · {t(`taskEvent.${e.event}`)}
                  {e.to_status && e.from_status !== e.to_status && ` → ${t(`status.${e.to_status}`)}`}
                </li>
              ))}
            </ol>
          </Card>
        </div>
        <div className="space-y-4">
          <Card title={t('tasks.actions')}>
            <div className="flex flex-col gap-2">
              {owner && x.status === 'requested' && (
                <>
                  <Button onClick={() => act('accept')}>{t('tasks.action.accept')}</Button>
                  <Button variant="secondary" onClick={() => setModal('not_done')}>{t('tasks.action.decline')}</Button>
                </>
              )}
              {owner && ['todo', 'reopened', 'blocked'].includes(x.status) && <Button onClick={() => act('start')}>{t('tasks.action.start')}</Button>}
              {owner && open && <Button onClick={() => setModal('complete')}>{t('tasks.action.complete')}</Button>}
              {owner && open && x.status !== 'blocked' && <Button variant="secondary" onClick={() => setModal('block')}>{t('tasks.action.block')}</Button>}
              {owner && open && <Button variant="secondary" onClick={() => setModal('not_done')}>{t('tasks.action.notDone')}</Button>}
              {owner && open && <Button variant="secondary" onClick={() => setModal('extension')}>{t('tasks.action.requestExtension')}</Button>}
              {owner && open && <Button variant="secondary" onClick={() => setModal('delegate')}>{t('tasks.action.delegate')}</Button>}
              {boss && x.status === 'done' && <Button onClick={() => act('verify')}>{t('tasks.action.verify')}</Button>}
              {boss && ['done', 'verified', 'not_done'].includes(x.status) && <Button variant="secondary" onClick={() => setModal('reopen')}>{t('tasks.action.reopen')}</Button>}
              {boss && open && <Button variant="secondary" onClick={() => setModal('due')}>{t('tasks.action.changeDue')}</Button>}
              {boss && !['verified', 'cancelled', 'not_done', 'declined'].includes(x.status) && (
                <Button variant="danger" onClick={() => act('cancel')}>
                  {t('tasks.action.cancel')}
                </Button>
              )}
            </div>
          </Card>
          {x.attachments.length > 0 && (
            <Card title={t('tasks.attachments')}>
              <ul className="space-y-1 text-sm">
                {x.attachments.map((f: any) => (
                  <li key={f.id}>
                    <button
                      className="text-brand-700 underline"
                      onClick={async () => {
                        const r = await post<{ url: string }>('/downloads', { path: f.storage_path });
                        window.open(r.url, '_blank');
                      }}
                    >
                      {t(`attachmentKind.${f.kind}`)} · {f.storage_path.split('/').pop()}
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>

      <Modal open={modal === 'complete'} onClose={() => setModal(null)} title={t('tasks.action.complete')}>
        <div className="space-y-3">
          {(x.proof_required === 'photo' || x.proof_required === 'file') && (
            <Field label={t('tasks.proofFile')}>
              <input type="file" accept={x.proof_required === 'photo' ? 'image/*' : undefined} capture={x.proof_required === 'photo' ? 'environment' : undefined} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </Field>
          )}
          <Field label={x.proof_required === 'note' ? t('tasks.noteRequired') : t('tasks.note')}>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <ErrorBox error={a.error} />
          <Button disabled={a.busy} onClick={async () => {
            const proof = file ? await uploadFile(file, 'task_proof') : null;
            await act('complete', { note: note || null, proof_path: proof });
          }}>{t('common.submit')}</Button>
        </div>
      </Modal>
      <Modal open={modal === 'block' || modal === 'not_done'} onClose={() => setModal(null)} title={modal === 'block' ? t('tasks.action.block') : x.status === 'requested' ? t('tasks.action.decline') : t('tasks.action.notDone')}>
        <div className="space-y-3">
          {modal === 'not_done' && x.status !== 'requested' ? (
            <Field label={t('tasks.reason')}>
              <Select value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('common.choose')} options={['no_time', 'not_possible', 'not_needed', 'other'].map((r) => ({ value: r, label: t(`notDone.${r}`) }))} />
            </Field>
          ) : (
            <Field label={t('tasks.reason')}>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
          )}
          <Field label={t('tasks.note')}>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <Button disabled={!reason || a.busy} onClick={() => act(modal === 'block' ? 'block' : x.status === 'requested' ? 'decline' : 'not_done', { reason, note })}>{t('common.submit')}</Button>
        </div>
      </Modal>
      <Modal open={modal === 'reopen'} onClose={() => setModal(null)} title={t('tasks.action.reopen')}>
        <Field label={t('tasks.commentRequired')}>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <Button className="mt-3" disabled={!note || a.busy} onClick={() => act('reopen', { note })}>{t('common.submit')}</Button>
      </Modal>
      <Modal open={modal === 'delegate'} onClose={() => setModal(null)} title={t('tasks.action.delegate')}>
        <Select value={who} onChange={(e) => setWho(e.target.value)} placeholder={t('common.choose')} options={opts(lk?.staff, (s) => s.full_name)} />
        <Field label={t('tasks.note')}>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <ErrorBox error={a.error} />
        <Button className="mt-3" disabled={!who || a.busy} onClick={() => act('delegate', { delegate_to: who, note })}>{t('common.submit')}</Button>
      </Modal>
      <Modal open={modal === 'extension' || modal === 'due'} onClose={() => setModal(null)} title={modal === 'due' ? t('tasks.action.changeDue') : t('tasks.action.requestExtension')}>
        <Field label={t('tasks.newDue')}>
          <Input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
        </Field>
        {modal === 'extension' && (
          <Field label={t('tasks.note')}>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        )}
        <Button className="mt-3" disabled={!due || a.busy} onClick={() => act(modal === 'due' ? 'change_due' : 'request_extension', { due_at: new Date(due).toISOString(), note })}>{t('common.submit')}</Button>
      </Modal>
    </div>
  );
}
