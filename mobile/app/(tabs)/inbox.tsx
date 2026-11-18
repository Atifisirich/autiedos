import { FlatList, RefreshControl, View } from 'react-native';
import { post } from '../../src/api';
import { useSession } from '../../src/session';
import { useLoad } from '../../src/useLoad';
import { Btn, Card, Loading, Pill, s, T } from '../../src/ui';

interface N { id: string; title: string; body: string | null; priority: string; read_at: string | null; created_at: string }

export default function Inbox() {
  const { t } = useSession();
  const list = useLoad<N[]>('/inbox');
  if (!list.data) return <Loading />;
  return (
    <View style={s.screen}>
      <Btn title={t('inbox.markAllRead')} kind="secondary" onPress={async () => { await post('/inbox/read', { ids: 'all' }).catch(() => undefined); void list.reload(); }} />
      <FlatList
        data={list.data}
        keyExtractor={(x) => x.id}
        refreshControl={<RefreshControl refreshing={list.loading} onRefresh={list.reload} />}
        ListEmptyComponent={<T sub style={{ padding: 16 }}>{t('inbox.empty')}</T>}
        renderItem={({ item }) => (
          <Card onPress={async () => { if (!item.read_at) { await post('/inbox/read', { ids: [item.id] }).catch(() => undefined); void list.reload(); } }}>
            {item.priority === 'urgent' && <Pill text={t('priority.urgent')} tone="red" />}
            <T bold={!item.read_at}>{item.title}</T>
            {item.body && <T sub>{item.body}</T>}
            <T sub style={{ fontSize: 12 }}>{item.created_at.slice(0, 16).replace('T', ' ')}</T>
          </Card>
        )}
      />
    </View>
  );
}
