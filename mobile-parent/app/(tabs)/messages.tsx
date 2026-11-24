import { useState } from 'react';
import { View } from 'react-native';
import { fmtDate, fmtTime, friendlyError, loadCirculars, loadConversations, markCircular, replyConversation, startConversation } from '@autoed/shared/erp-portal';
import { supabase } from '../../src/supabase';
import { useSession } from '../../src/session';
import { useLoad } from '../../src/useLoad';
import { Banner, Btn, Card, Failed, Field, Loading, Screen, T } from '../../src/ui';

/** Circulars (with acknowledge) and two-way conversations with the school. */
export default function Messages() {
  const { child, L, lang, session, boot } = useSession();
  const uid = session!.user.id;
  const org = boot?.org?.id;
  const name = boot?.member.display_name ?? '';
  const q = useLoad('messages', async () => ({ circ: await loadCirculars(supabase, uid), conv: await loadConversations(supabase) }));
  const [open, setOpen] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [subject, setSubject] = useState('');
  const [composing, setComposing] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function act(fn: () => Promise<unknown>) {
    setErr(null);
    try { await fn(); setText(''); setSubject(''); setComposing(false); await q.reload(); } catch (e) { setErr(friendlyError(e, L('c.error'))); }
  }
  return (
    <Screen title={L('messages.title')} onRefresh={q.reload} savedAt={q.savedAt}>
      {err ? <Banner tone="bad" text={err} /> : null}
      {composing && child && org ? (
        <Card title={L('messages.new')}>
          <Field label={L('messages.subject')} value={subject} onChangeText={setSubject} />
          <Field label={L('messages.body')} value={text} onChangeText={setText} multiline />
          <Btn disabled={!subject.trim() || !text.trim()} title={L('messages.send')} onPress={() => void act(() => startConversation(supabase, org, { subject: subject.trim(), studentId: child.id, withRole: 'class_teacher', name, body: text.trim() }))} />
        </Card>
      ) : <Btn title={L('messages.new')} onPress={() => setComposing(true)} />}
      {!q.data ? (q.loading ? <Loading /> : <Failed retry={() => void q.reload()} />) : (
        <>
          <Card title={L('messages.conversations')}>
            {q.data.conv.length === 0 ? <T>{L('messages.none')}</T> : q.data.conv.map((c) => (
              <View key={c.id} style={{ gap: 4, marginBottom: 8 }}>
                <Btn kind="secondary" title={`${c.subject} · ${fmtDate(c.lastAt, lang)}`} onPress={() => setOpen(open === c.id ? null : c.id)} />
                {open === c.id && (
                  <View style={{ gap: 6 }}>
                    {c.messages.map((m) => <T key={m.id}><T bold>{m.sender === uid ? L('messages.you') : m.sender_name || L('messages.school')}</T> · {fmtTime(m.at, lang)}{'\n'}{m.body}</T>)}
                    {c.status === 'open' && org ? <><Field label={L('messages.reply')} value={text} onChangeText={setText} multiline /><Btn disabled={!text.trim()} title={L('messages.send')} onPress={() => void act(() => replyConversation(supabase, org, c.id, name, text.trim()))} /></> : null}
                  </View>
                )}
              </View>
            ))}
          </Card>
          <Card title={L('messages.circulars')}>
            {q.data.circ.length === 0 ? <T>{L('messages.none')}</T> : q.data.circ.map((c) => (
              <View key={c.id} style={{ gap: 4, marginBottom: 8 }}>
                <T bold>{c.title}{!c.read_at ? ` · ${L('messages.unread')}` : ''}</T>
                {c.body ? <T>{c.body}</T> : null}
                {c.requires_ack && !c.ack_at ? <Btn kind="secondary" title={L('messages.acknowledge')} onPress={() => void act(() => markCircular(supabase, c.id, true))} /> : !c.read_at ? <Btn kind="secondary" title={L('messages.markRead')} onPress={() => void act(() => markCircular(supabase, c.id, false))} /> : null}
              </View>
            ))}
          </Card>
        </>
      )}
    </Screen>
  );
}
