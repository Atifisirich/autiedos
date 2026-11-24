import { View } from 'react-native';
import { childName, fmtDate, loadHomework } from '@autoed/shared/erp-portal';
import { supabase } from '../../src/supabase';
import { useSession } from '../../src/session';
import { useLoad } from '../../src/useLoad';
import { Card, Failed, Loading, Screen, T } from '../../src/ui';

export default function Homework() {
  const { child, L, lang } = useSession();
  const q = useLoad('homework', () => loadHomework(supabase, child!), { child: true });
  if (!child) return <Screen title={L('homework.title')}><T>{L('home.noChildren')}</T></Screen>;
  return (
    <Screen title={L('homework.title')} sub={childName(child)} onRefresh={q.reload} savedAt={q.savedAt}>
      {!q.data ? (q.loading ? <Loading /> : <Failed retry={() => void q.reload()} />) : q.data.posts.length === 0 ? <T>{L('homework.none')}</T> : q.data.posts.map((p) => (
        <Card key={p.id} title={p.title}>
          <View><T small color="#475569">{L(`homework.type.${p.type}`)} · {(p.subject_id && q.data!.subjects[p.subject_id]) || L('homework.general')}{p.due_date ? ` · ${L('homework.due', { date: fmtDate(p.due_date, lang) })}` : ''}</T></View>
          {p.body ? <T>{p.body}</T> : null}
          {q.data!.submissions[p.id] ? <T bold color="#15803d">{L('homework.submitted')}</T> : null}
        </Card>
      ))}
    </Screen>
  );
}
