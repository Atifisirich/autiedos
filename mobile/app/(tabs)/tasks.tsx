import { useState } from 'react';
import { FlatList, RefreshControl, TextInput, View } from 'react-native';
import { send } from '../../src/outbox';
import { useSession } from '../../src/session';
import { useLoad } from '../../src/useLoad';
import { Btn, Card, Loading, Pill, s, T, colors } from '../../src/ui';

interface Task { id: string; title: string; status: string; due_at: string | null; priority: string; proof_required: string; overdue?: boolean }

export default function Tasks() {
  const { t } = useSession();
  const list = useLoad<Task[]>('/tasks?view=mine&status=open');
  const [quick, setQuick] = useState('');
  const [note, setNote] = useState<string | null>(null);

  const act = async (id: string, action: 'start' | 'complete') => {
    try {
      const r = await send('POST', `/tasks/${id}/action`, { action, client_at: new Date().toISOString() });
      setNote(r === 'queued' ? t('status.queued') : null);
      void list.reload();
    } catch (e) {
      setNote(t(`error.${(e as { code?: string }).code ?? 'generic'}`));
    }
  };

  return (
    <View style={s.screen}>
      <View style={{ flexDirection: 'row', padding: 12, gap: 8 }}>
        <TextInput style={{ flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, minHeight: 48, backgroundColor: '#fff' }} placeholder={t('myDay.quickAdd')} value={quick} onChangeText={setQuick} accessibilityLabel={t('myDay.quickAdd')} />
        <Btn title={t('common.add')} disabled={quick.trim().length < 2} onPress={async () => { await send('POST', '/tasks', { title: quick.trim(), source: 'self' }).catch(() => undefined); setQuick(''); void list.reload(); }} />
      </View>
      {note && <T sub style={{ paddingHorizontal: 14 }}>{note}</T>}
      {!list.data ? <Loading /> : (
        <FlatList
          data={list.data}
          keyExtractor={(x) => x.id}
          refreshControl={<RefreshControl refreshing={list.loading} onRefresh={list.reload} />}
          ListEmptyComponent={<T sub style={{ padding: 16 }}>{t('common.nothingHere')}</T>}
          renderItem={({ item }) => (
            <Card>
              <T bold>{item.title}</T>
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                <Pill text={t(`status.${item.status}`)} />
                {item.priority === 'urgent' && <Pill text={t('priority.urgent')} tone="red" />}
                {item.due_at && <Pill text={item.due_at.slice(0, 10)} tone={item.overdue ? 'red' : 'gray'} />}
              </View>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {item.status === 'todo' && <Btn title={t('tasks.action.start')} kind="secondary" onPress={() => act(item.id, 'start')} />}
                {item.proof_required === 'none' || item.proof_required === 'note' ? <Btn title={t('tasks.action.complete')} onPress={() => act(item.id, 'complete')} /> : <T sub>{t('dayClose.needsProof')}</T>}
              </View>
            </Card>
          )}
        />
      )}
    </View>
  );
}
